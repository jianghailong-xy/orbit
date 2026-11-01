import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { PushService, type WakeupMissedReason } from '../push/push.service';
import { RUNNER_BEATS, runnerIsOnline } from '../runners/runner-presence';
import { RETRY_CLAIM_WINDOW_MS } from '../sessions/session-request';
import { SessionNotSendable, SessionsService } from '../sessions/sessions.service';
import { BACKGROUND_WAKE_TURN_PREFIX, sessionHasEnded, undeliveredWakeTurn } from './background-job-wake';
import {
  claimLoopAlert,
  clearLoopAlert,
  dropScheduledWakeup,
  lastLoopRun,
  loopSilenceLimitMs,
  loopTickNumber,
  markScheduledWakeupDelivered,
  ScheduledWakeupSettled,
  settleLoopTick,
  TICK_SESSION,
  tickStanding,
  turnCarriesLoopTick,
  type LoopTickSettlement,
  type TickSession,
} from './scheduled-wakeup';

/**
 * Delivers the wakeups sessions asked the control plane to hold (scheduled-wakeup.ts) once they are due.
 *
 * A pure clock: nothing a runner or an engine does is needed for a wakeup to come due, which is why it
 * is held here and not in the engine that asked. Each pass reads the waiting wakeups that are due and
 * files each as a turn through `createTurn`, exactly as a background job's wake is filed: onto the
 * session's wake turn nobody has been handed yet if there is one, else as a new `bg-wake:` turn. The
 * wakeup is settled (DELIVERED) inside that turn's transaction, as a compare-and-set, so a wakeup is
 * filed at most once however many passes or replicas reach it; a session that ended before its wakeup
 * came due is not woken (DROPPED). A FAILED session whose auto-retry is armed is on its way back, and its
 * wakeup waits for it (HELD) instead of being dropped.
 *
 * A wakeup that fails for any other reason stays waiting and is tried again on the next pass.
 *
 * A LOOP'S TICK (docs/long-running-loop-contract.md §1) is filed the same way, and settling it writes the
 * loop's next tick in the same transaction (settleLoopTick), so nothing that happens to one tick ends the
 * loop. What a due tick finds decides what it does:
 *
 *   - a live session: the tick is filed as a turn, or onto the wake turn already queued — a missed tick
 *     when that turn already carries this loop's previous one;
 *   - a FAILED session whose auto-retry is armed: the tick is missed, and the recovery is the retry's;
 *   - a FAILED session with no retry armed: the tick revives it (`sessions.resume` with the tick's
 *     `bg-wake:` key and no words), and a refused revive — runner offline, task replaced — is a missed
 *     tick. A loop that has revived the session three times in a row, each revive ending FAILED again,
 *     stops reviving it and only counts its ticks missed, until a tick finds the session healthy again.
 *     Only a revive that went through counts toward the three: a tick skipped for an armed retry or
 *     refused its revive spends none of them, so an outage of any length leaves the loop able to revive
 *     the session once its runner is back;
 *   - an ended session (Completed, Trash, SUCCEEDED, CANCELLED, or being ended): the loop ends, SESSION_ENDED.
 *
 * Anything else leaves the tick waiting for the next pass, until it is an interval late: then it is
 * counted missed and the next tick written, so no one tick can hold its loop up.
 *
 * A due tick is also when the loop is checked for silence (contract §4, signalIfSilent): none of its ticks
 * has reached the engine for max(2 × every, 15 minutes), and its session is not busy with a turn that is
 * still running. Its owner is then told once (PushService.notifyLoopMissed), and again only for a silence
 * after the loop's next run. So is the owner of a one-shot wakeup dropped because its session had FAILED.
 */

/** How often a pass looks for due wakeups. A wakeup is at least a minute away when it is asked for. */
export const SCHEDULED_WAKEUP_POLL_INTERVAL_MS = 5_000;
/** Due wakeups delivered per pass. */
export const SCHEDULED_WAKEUP_BATCH = 25;
/** Revives in a row — each ending with the session FAILED again — after which a loop only counts its ticks missed. */
export const WAKEUP_LOOP_REVIVE_LIMIT = 3;

export const SCHEDULED_WAKEUP_WORKER_OPTIONS = Symbol('SCHEDULED_WAKEUP_WORKER_OPTIONS');

export interface ScheduledWakeupWorkerOptions {
  pollIntervalMs?: number;
  batch?: number;
}

/**
 * What one delivery came to.
 *   DELIVERED          filed as a turn of its session, or onto the wake turn already queued.
 *   DROPPED            a one-shot wakeup whose session had ended.
 *   HELD               a one-shot wakeup waiting for its FAILED session's armed auto-retry.
 *   SETTLED_ELSEWHERE  replaced, cancelled or delivered before this pass reached it.
 *   REVIVED            a tick that revived its FAILED session to be delivered.
 *   MISSED             a tick counted missed; its loop's next tick is waiting.
 *   LOOP_ENDED         a tick whose session had ended, and its loop with it.
 *   RETRY              a tick left waiting for the next pass.
 */
export type ScheduledWakeupOutcome =
  | 'DELIVERED'
  | 'DROPPED'
  | 'HELD'
  | 'SETTLED_ELSEWHERE'
  | 'REVIVED'
  | 'MISSED'
  | 'LOOP_ENDED'
  | 'RETRY';

/** A FAILED session the auto-retry sweep is to bring back: armed, or claimed a moment ago, and still open. */
function recoveringByRetry(now: Date): Prisma.SessionWhereInput {
  return {
    status: RunStatus.FAILED,
    deletedAt: null,
    completedAt: null,
    archivedAt: null,
    OR: [{ retryAt: { not: null } }, { retryClaimedAt: { gt: new Date(now.getTime() - RETRY_CLAIM_WINDOW_MS) } }],
  };
}

/** What a silent loop's alert reads of its session: its title, and whether its runner is there. */
const SILENT_SESSION = {
  title: true,
  status: true,
  assignedRunner: { select: { status: true, ...RUNNER_BEATS } },
} as const satisfies Prisma.SessionSelect;

/** A due tick, as the worker reads it. */
interface DueTick {
  id: string;
  sessionId: string;
  loopId: string;
  dueAt: Date;
  everySeconds: number;
  reviveStreak: number;
  session: TickSession;
}

@Injectable()
export class ScheduledWakeupWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ScheduledWakeup');
  private readonly pollIntervalMs: number;
  private readonly batch: number;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  /** The pass in flight. A replica never runs two. */
  private pass?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    @Optional() @Inject(SCHEDULED_WAKEUP_WORKER_OPTIONS) options: ScheduledWakeupWorkerOptions = {},
    @Optional() private readonly push?: PushService,
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? SCHEDULED_WAKEUP_POLL_INTERVAL_MS;
    this.batch = options.batch ?? SCHEDULED_WAKEUP_BATCH;
  }

  onModuleInit(): void {
    this.running = true;
    // At once: the first pass is what finds everything that came due while no replica was running.
    this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.pass;
  }

  private tick(): void {
    if (!this.running || this.pass) return;
    this.pass = this.drain()
      .then(
        () => undefined,
        (error) => this.log.error(`scheduled wakeup pass failed: ${messageOf(error)}`),
      )
      .finally(() => {
        this.pass = undefined;
        if (!this.running) return;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.tick();
        }, this.pollIntervalMs);
        this.timer.unref(); // never what keeps a process alive
      });
  }

  /** Deliver up to one batch of due wakeups and ticks, the longest-due first. */
  async drain(): Promise<ScheduledWakeupOutcome[]> {
    const now = new Date();
    const due = await this.prisma.sessionScheduledWakeup.findMany({
      where: {
        state: 'PENDING',
        dueAt: { lte: now },
        // A one-shot wakeup held for its session's auto-retry is left out of the page: it would otherwise
        // take a place in every batch for as long as the retry is armed.
        NOT: { loopId: null, session: { is: recoveringByRetry(now) } },
      },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: this.batch,
      select: { id: true, sessionId: true, loopId: true, session: { select: { ownerId: true } } },
    });
    const outcomes: ScheduledWakeupOutcome[] = [];
    for (const wakeup of due) {
      try {
        outcomes.push(
          wakeup.loopId
            ? await this.deliverTick(wakeup.id)
            : await this.deliver(wakeup.id, wakeup.sessionId, wakeup.session.ownerId),
        );
      } catch (error) {
        this.log.error(`scheduled wakeup ${wakeup.id} of session ${wakeup.sessionId} was not delivered: ${messageOf(error)}`);
      }
    }
    return outcomes;
  }

  /** File one due wakeup as a turn of its session, or settle it as dropped when the session has ended. */
  async deliver(wakeupId: string, sessionId: string, ownerId: string): Promise<ScheduledWakeupOutcome> {
    const clientTurnId = `${BACKGROUND_WAKE_TURN_PREFIX}wakeup:${wakeupId}`;
    try {
      await this.sessions.createTurn(
        ownerId,
        sessionId,
        { clientTurnId, content: '', intent: 'NEXT_TURN' },
        {
          coalesce: async (tx, session) => {
            if (sessionHasEnded(session)) throw new SessionNotSendable('the session has ended');
            const queued = await undeliveredWakeTurn(tx, sessionId);
            await markScheduledWakeupDelivered(tx, wakeupId, queued?.clientTurnId ?? clientTurnId);
            return queued;
          },
        },
      );
      return 'DELIVERED';
    } catch (error) {
      if (error instanceof ScheduledWakeupSettled) return 'SETTLED_ELSEWHERE';
      // Ended (SessionNotSendable), or no longer there to wake (NotFoundException) — unless it FAILED with
      // its auto-retry armed: that session is coming back, and the wakeup waits for it.
      if (error instanceof SessionNotSendable || error instanceof NotFoundException) {
        if (error instanceof SessionNotSendable && (await this.recoveringByRetry(sessionId))) return 'HELD';
        if (!(await dropScheduledWakeup(this.prisma, wakeupId))) return 'SETTLED_ELSEWHERE';
        await this.signalDropped(wakeupId, sessionId, ownerId);
        return 'DROPPED';
      }
      throw error;
    }
  }

  /**
   * A one-shot wakeup dropped because its session had FAILED is a wait nobody will be woken from, so its
   * owner is told (contract §4) — once, because only the drop's compare-and-set gets here. One dropped
   * because its session ended or is gone is not: that end was somebody's doing. Never throws: the wakeup is
   * dropped either way.
   */
  private async signalDropped(wakeupId: string, sessionId: string, ownerId: string): Promise<void> {
    try {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { ...TICK_SESSION, title: true },
      });
      if (!session) return;
      const standing = tickStanding(session, new Date());
      if (standing !== 'FAILED' && standing !== 'FAILED_RECOVERING') return;
      void this.push?.notifyLoopMissed({
        ownerId,
        sessionId,
        title: session.title,
        missed: { wakeupId },
        reason: 'SESSION_FAILED',
      });
    } catch (error) {
      this.log.error(`the owner of session ${sessionId} was not told its wakeup ${wakeupId} was dropped: ${messageOf(error)}`);
    }
  }

  private async recoveringByRetry(sessionId: string): Promise<boolean> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ...recoveringByRetry(new Date()) },
      select: { id: true },
    });
    return session != null;
  }

  /**
   * Deliver one due tick of a loop, by what its session is now. Whatever happens to it, the loop has its
   * next tick waiting afterwards, or has ended for a reason it records: a tick that cannot be filed and is
   * an interval late is counted missed rather than left to hold the loop up.
   */
  async deliverTick(tickId: string): Promise<ScheduledWakeupOutcome> {
    const now = new Date();
    const row = await this.prisma.sessionScheduledWakeup.findUnique({
      where: { id: tickId },
      select: {
        id: true,
        sessionId: true,
        loopId: true,
        state: true,
        dueAt: true,
        loop: { select: { state: true, everySeconds: true, reviveStreak: true } },
        session: { select: TICK_SESSION },
      },
    });
    if (!row || row.state !== 'PENDING' || !row.loopId || !row.loop || row.loop.state !== 'ACTIVE') {
      return 'SETTLED_ELSEWHERE';
    }
    if (row.dueAt.getTime() > now.getTime()) return 'RETRY';
    const tick: DueTick = {
      id: row.id,
      sessionId: row.sessionId,
      loopId: row.loopId,
      dueAt: row.dueAt,
      everySeconds: row.loop.everySeconds,
      reviveStreak: row.loop.reviveStreak,
      session: row.session,
    };
    // Read before the tick is filed, so the alert says what the tick found. A loop ending with its session
    // here is not silent: it is over.
    if (tickStanding(tick.session, now) !== 'ENDED') await this.signalIfSilent(tick, now);
    const late = now.getTime() - tick.dueAt.getTime() > tick.everySeconds * 1_000;
    let outcome: ScheduledWakeupOutcome;
    try {
      outcome = await this.fileTick(tick, now);
    } catch (error) {
      if (!late) throw error;
      this.log.error(
        `tick ${tick.id} of wakeup loop ${tick.loopId} could not be filed and is an interval late, so it is counted missed: ${messageOf(error)}`,
      );
      return this.missTick(tick, 'keep');
    }
    return outcome === 'RETRY' && late ? this.missTick(tick, 'keep') : outcome;
  }

  /**
   * The dead-man signal (docs/long-running-loop-contract.md §4), read at every due tick. The loop is silent
   * when none of its ticks has reached the engine — its turn handed out, `conversation_turn.delivered_at` —
   * for loopSilenceLimitMs, counted from its last run, or from its start when it has none.
   *
   * A silent loop whose session is busy is waiting, not failing: a turn of it is IN_FLIGHT on a runner that
   * is still there. Live is read off the session and its runner, not the turn's `lease_deadline_at`, which
   * is set once when the turn is handed out and never renewed, so a long turn outlives it (pool-pause.ts).
   *
   * Any other silent loop tells its owner, once: the compare-and-set on `alerted_at` (claimLoopAlert) lets
   * one caller through per silence, and a run after the alert both clears it and lets the next silence be
   * told. The alert says how many due times have not run since the last run, this one included, and why:
   * the runner is offline, the session FAILED, or the turn is queued. Never throws: the signal is about the
   * loop, and must not be what holds a tick of it up.
   */
  private async signalIfSilent(tick: DueTick, now: Date): Promise<void> {
    try {
      const loop = await this.prisma.sessionWakeupLoop.findUnique({
        where: { id: tick.loopId },
        select: { everySeconds: true, firstDueAt: true, createdAt: true, alertedAt: true },
      });
      if (!loop) return;
      const lastRun = await lastLoopRun(this.prisma, tick.loopId);
      if (lastRun && loop.alertedAt && loop.alertedAt.getTime() < lastRun.deliveredAt.getTime()) {
        await clearLoopAlert(this.prisma, tick.loopId, lastRun.deliveredAt);
      }
      const silentSince = lastRun?.deliveredAt ?? loop.createdAt;
      if (now.getTime() - silentSince.getTime() < loopSilenceLimitMs(loop.everySeconds)) return;
      const session = await this.prisma.session.findUnique({ where: { id: tick.sessionId }, select: SILENT_SESSION });
      if (!session) return;
      const runnerOnline = runnerIsOnline(session.assignedRunner, now.getTime());
      if (runnerOnline && session.status === RunStatus.RUNNING && (await this.turnRunning(tick.sessionId))) return;
      if (!(await claimLoopAlert(this.prisma, tick.loopId, silentSince, now))) return;
      const standing = tickStanding(tick.session, now);
      const reason: WakeupMissedReason = !runnerOnline
        ? 'RUNNER_OFFLINE'
        : standing === 'FAILED' || standing === 'FAILED_RECOVERING' ? 'SESSION_FAILED' : 'TURN_QUEUED';
      const ticks = loopTickNumber(loop, tick.dueAt) - (lastRun ? loopTickNumber(loop, lastRun.dueAt) : 0);
      this.log.warn(`wakeup loop ${tick.loopId} of session ${tick.sessionId} has not run for ${ticks} ticks (${reason}); its owner is told`);
      void this.push?.notifyLoopMissed({
        ownerId: tick.session.ownerId,
        sessionId: tick.sessionId,
        title: session.title,
        missed: { loopId: tick.loopId, ticks, alertedAt: now },
        reason,
      });
    } catch (error) {
      this.log.error(`wakeup loop ${tick.loopId} could not be checked for silence at tick ${tick.id}: ${messageOf(error)}`);
    }
  }

  /** Whether the session has a turn handed to its engine and not yet answered. */
  private async turnRunning(sessionId: string): Promise<boolean> {
    const turn = await this.prisma.conversationTurn.findFirst({
      where: { sessionId, kind: { in: ['message', 'shell'] }, status: 'IN_FLIGHT' },
      select: { id: true },
    });
    return turn != null;
  }

  private async fileTick(tick: DueTick, now: Date): Promise<ScheduledWakeupOutcome> {
    switch (tickStanding(tick.session, now)) {
      case 'ENDED':
        return this.endLoopAtTick(tick);
      case 'FAILED_RECOVERING':
        // The auto-retry brings the session back; this tick is missed, and the next one comes due as usual.
        return this.missTick(tick, 'keep');
      case 'FAILED':
        // Three revives in a row each ended FAILED: the loop holds, rather than revive the session into the
        // same failure on every tick, until something else brings it back healthy.
        if (tick.reviveStreak >= WAKEUP_LOOP_REVIVE_LIMIT) return this.missTick(tick, 'keep');
        return this.reviveForTick(tick);
      case 'LIVE':
        return this.fileTickTurn(tick);
    }
  }

  /** The tick as a turn of its live session, or onto the wake turn already queued there. */
  private async fileTickTurn(tick: DueTick): Promise<ScheduledWakeupOutcome> {
    const clientTurnId = `${BACKGROUND_WAKE_TURN_PREFIX}wakeup:${tick.id}`;
    try {
      await this.sessions.createTurn(
        tick.session.ownerId,
        tick.sessionId,
        { clientTurnId, content: '', intent: 'NEXT_TURN' },
        {
          coalesce: async (tx, session) => {
            if (sessionHasEnded(session)) throw new SessionNotSendable('the session has ended');
            const queued = await undeliveredWakeTurn(tx, tick.sessionId);
            const onto = queued?.clientTurnId ?? clientTurnId;
            const absorbed = queued != null && (await turnCarriesLoopTick(tx, tick.sessionId, onto, tick.loopId));
            await settleLoopTick(tx, this.settlement(tick, { delivered: { clientTurnId: onto, absorbed }, streak: 'reset' }));
            return queued;
          },
        },
      );
      return 'DELIVERED';
    } catch (error) {
      if (error instanceof ScheduledWakeupSettled) return 'SETTLED_ELSEWHERE';
      // The session moved under the read this was decided from — it ended, failed or is gone. The next
      // pass decides again from what it is then.
      if (error instanceof SessionNotSendable || error instanceof NotFoundException) return 'RETRY';
      throw error;
    }
  }

  /**
   * Revive the FAILED session to deliver the tick: `sessions.resume` with the tick's `bg-wake:` key and no
   * words, the tick settled onto the revive's turn inside the revive's own transaction, so the block is
   * written in when the runner claims it. Only that counts toward the loop's revive streak. A refusal is a
   * missed tick and counts toward nothing.
   */
  private async reviveForTick(tick: DueTick): Promise<ScheduledWakeupOutcome> {
    const clientTurnId = `${BACKGROUND_WAKE_TURN_PREFIX}wakeup:${tick.id}`;
    try {
      await this.sessions.resume(tick.session.ownerId, tick.sessionId, { clientTurnId, content: '' }, {
        onTurnWritten: async (tx, turn) => {
          // Read again under the lock the resume holds. A session that is no longer FAILED with no retry
          // armed — brought back, armed or ended since the pass read it, which resume would deliver to or
          // revive all the same — is not this tick's to revive: nothing of it is kept, and the next pass
          // decides again from what the session is then.
          const current = await tx.session.findUniqueOrThrow({ where: { id: tick.sessionId }, select: TICK_SESSION });
          if (tickStanding(current, new Date()) !== 'FAILED') throw new TickSessionMoved();
          await settleLoopTick(tx, this.settlement(tick, {
            delivered: { clientTurnId: turn.clientTurnId, absorbed: false },
            streak: 'increment',
          }));
        },
      });
      return 'REVIVED';
    } catch (error) {
      if (error instanceof ScheduledWakeupSettled) return 'SETTLED_ELSEWHERE';
      if (error instanceof TickSessionMoved) return 'RETRY';
      if (!(error instanceof HttpException)) throw error;
      // Refused: the runner is offline, the task's run was replaced, the session cannot be resumed. Unless
      // it is no longer FAILED — somebody else brought it back meanwhile — which the next pass files.
      const current = await this.prisma.session.findUnique({ where: { id: tick.sessionId }, select: { status: true } });
      if (current && current.status !== RunStatus.FAILED) return 'RETRY';
      this.log.warn(`tick ${tick.id} of wakeup loop ${tick.loopId} could not revive session ${tick.sessionId}, so it is counted missed: ${messageOf(error)}`);
      return this.missTick(tick, 'keep');
    }
  }

  /** Count the tick missed and write the loop's next one. */
  private async missTick(tick: DueTick, streak: LoopTickSettlement['streak']): Promise<ScheduledWakeupOutcome> {
    try {
      await withTransactionRetry(
        this.prisma,
        (tx) => settleLoopTick(tx, this.settlement(tick, { streak })),
        loggedRetry(this.log, 'scheduledWakeup.missTick'),
      );
      return 'MISSED';
    } catch (error) {
      if (error instanceof ScheduledWakeupSettled) return 'SETTLED_ELSEWHERE';
      throw error;
    }
  }

  /** The tick's session has ended: so has the loop (SESSION_ENDED). */
  private async endLoopAtTick(tick: DueTick): Promise<ScheduledWakeupOutcome> {
    try {
      await withTransactionRetry(
        this.prisma,
        (tx) => settleLoopTick(tx, this.settlement(tick, { end: 'SESSION_ENDED', streak: 'keep' })),
        loggedRetry(this.log, 'scheduledWakeup.endLoopAtTick'),
      );
      return 'LOOP_ENDED';
    } catch (error) {
      if (error instanceof ScheduledWakeupSettled) return 'SETTLED_ELSEWHERE';
      throw error;
    }
  }

  private settlement(
    tick: DueTick,
    how: Pick<LoopTickSettlement, 'delivered' | 'end' | 'streak'>,
  ): LoopTickSettlement {
    return { tickId: tick.id, loopId: tick.loopId, sessionId: tick.sessionId, dueAt: tick.dueAt, now: new Date(), ...how };
  }
}

/** The session a revive was for is no longer FAILED with no retry armed, read under the revive's own lock. */
class TickSessionMoved extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
