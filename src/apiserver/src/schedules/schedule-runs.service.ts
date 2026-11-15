/**
 * A schedule's runs (docs/scheduled-tasks-design.md §5–§7): firing due slots, starting runs, watching them, and
 * ending them by a report or a failure. ScheduleWorker drives the four passes; the run report, Run now and Stop
 * this run are the doors S4's tools and REST call.
 *
 * FIRING (§5)
 * ===========
 * One transaction per due schedule, under the per-account lock and the schedule row FOR UPDATE (the order
 * SchedulesService takes them in): the slots from `nextDueAt` up to now are read from the rule; the latest is the
 * one that runs — SCHEDULED when it is on time, CATCH_UP (with its own `plannedAt`) when it is late — and every
 * earlier one is written MISSED; a latest slot older than one period (24 hours for ONCE) is MISSED too. The new run
 * is QUEUED, and an older QUEUED run is SKIPPED, so at most one waits. `nextDueAt` moves to the first slot after now,
 * and a rule with none left ENDS the schedule (END_REACHED). The slot's unique index is the belt to the lock: two
 * workers, or one after a restart, write one run for a slot.
 *
 * STARTING (§6)
 * =============
 * A QUEUED run starts when nothing of its schedule is RUNNING or AWAITING_APPROVAL and its `notBeforeAt` (a retry's
 * wait) has passed. The start checks run first (schedule-start-check.ts); a failure HOLDS the run and the schedule,
 * which then fires nothing until it is resumed. A run that passes is marked RUNNING with the id of the session it is
 * about to open, in the same transaction, and the session is opened after it commits with that id, `runSource =
 * SCHEDULE` and `scheduleRunId` set; its first turn is the scheduled-run block and the prompt (schedule-run-block.ts).
 *
 * WATCHING AND ENDING (§6.4, §7)
 * ==============================
 * `schedule_run_report` ends a run, once, from the session serving it. Without one, what the session does decides:
 * an engine that ended or went idle is NO_REPORT; a run past its limit is interrupted, RUN_LIMIT; a card nobody
 * answered for two hours interrupts it, APPROVAL_TIMEOUT. Whether the run reached its engine is read from its first
 * turn's `delivered_at`: a run that never did (RUNNER_UNAVAILABLE, QUOTA, ENGINE_CRASHED_BEFORE_START) has its
 * session retired and is retried after 1, 5 and 15 minutes, then hourly, inside its catch-up window, and is MISSED
 * past it (§5.2: a slot not run, not a failure); one that did is never retried. A runner that is offline at the
 * start leaves the run waiting without an attempt. One run never has two live sessions (`start`, `fail`). `consecutiveFailures` counts
 * and nothing pauses. A NO_CHANGE run's session is completed; CHANGED and FAILED ones stay open.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { isUsageLimitErrorText } from '@orbit/shared';
import { Prisma, RunStatus, type Schedule, type ScheduleRun } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RUNNER_BEATS, runnerIsOnline } from '../runners/runner-presence';
import { openingTurnKey } from '../sessions/orbit-authored-turn';
import { scheduledRunTurn } from './schedule-run-block';
import { scheduleStartCheck, type StartPlan } from './schedule-start-check';
import { nextDueAt, parseRule, type ScheduleRule } from './schedule-time';
import {
  SCHEDULE_CLOCK,
  SCHEDULE_LOCK_NAMESPACE,
  assertRunSessionScope,
  runSessionScheduleId,
  type ScheduleActor,
} from './schedules.service';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A retry waits this long after each failed attempt that never reached its engine: at most three retries. */
export const SCHEDULE_RETRY_DELAYS_MINUTES = [1, 5, 15] as const;
/** A card nobody answers for this long fails its run (§6.4). */
export const SCHEDULE_APPROVAL_TIMEOUT_MS = 2 * HOUR;
/** A run whose first turn has not reached its engine this long after the start never will: RUNNER_UNAVAILABLE. */
export const SCHEDULE_UNDELIVERED_LIMIT_MS = 10 * MINUTE;
/** A slot fired within this of its time is SCHEDULED; later, it is a CATCH_UP. */
export const SCHEDULE_LATE_GRACE_MS = 10 * MINUTE;
/** Catch-up reaches back one period; a ONCE rule's is a day (§5.2). */
export const SCHEDULE_ONCE_CATCH_UP_MS = 24 * HOUR;
/**
 * Once a run that never reached its engine has used its three retries, it waits this long between attempts for as
 * long as its catch-up window lasts (§5.2: the runner, the dispatch or the quota is expected back), then is MISSED.
 */
export const SCHEDULE_RECOVERY_WAIT_MS = HOUR;
/** A run met an offline runner at its start: it looks again this soon, without spending an attempt. */
export const SCHEDULE_RUNNER_WAIT_MS = MINUTE;
/** A run, or a schedule, whose pass threw is left out of the passes for this long, so the rest go ahead. */
export const SCHEDULE_ERROR_COOLDOWN_MS = 5 * MINUTE;
/** Slots one firing reads at most: a year of daily slots, so an outage of any length ends in one pass. */
const MAX_SLOTS_PER_FIRING = 400;

/** §7.2's closed set. */
export type ScheduleFailureReason =
  | 'RUNNER_UNAVAILABLE'
  | 'QUOTA'
  | 'ENGINE_CRASHED_BEFORE_START'
  | 'REPORTED_FAILED'
  | 'NO_REPORT'
  | 'ENGINE_CRASHED'
  | 'APPROVAL_TIMEOUT'
  | 'RUN_LIMIT'
  | 'CANCELLED_BY_OWNER';

/** The reasons of a run that never reached its engine: the only ones retried. */
export const RETRIED_FAILURES: ReadonlySet<ScheduleFailureReason> = new Set([
  'RUNNER_UNAVAILABLE',
  'QUOTA',
  'ENGINE_CRASHED_BEFORE_START',
]);

export type ScheduleReportOutcome = 'NO_CHANGE' | 'CHANGED' | 'FAILED';

export interface ScheduleRunReport {
  outcome: ScheduleReportOutcome;
  key?: string | null;
  summary: string;
  links?: string[];
  /** Replaces the schedule's note; null clears it; omitted keeps it. */
  note?: string | null;
}

/** What the run's session is opened with. */
export interface OpenRunSession {
  ownerId: string;
  sessionId: string;
  scheduleRunId: string;
  workspaceId: string;
  title: string;
  prompt: string;
  permissionMode: string;
  /** CHECK_ONLY runs need no worktree (§6.2). */
  noWorktree: boolean;
  engine: string | null;
  provider: string | null;
}

/** The session doors a run needs, so the passes can be driven in a spec without a runner. */
export interface ScheduleRunSessionPort {
  open(input: OpenRunSession): Promise<void>;
  interrupt(ownerId: string, sessionId: string): Promise<void>;
  complete(ownerId: string, sessionId: string): Promise<void>;
  /** Retire the session: no auto-retry, ended; one already ended or never written counts as retired. */
  end(ownerId: string, sessionId: string): Promise<void>;
}

export const SCHEDULE_RUN_SESSIONS = Symbol('SCHEDULE_RUN_SESSIONS');

export type FireOutcome = 'FIRED' | 'MISSED' | 'SETTLED_ELSEWHERE';
/** How a failure was settled: retried, waiting, MISSED, CANCELLED (its schedule paused), SKIPPED or FAILED. */
export type FailOutcome = 'RETRY' | 'FAILED' | 'MISSED' | 'CANCELLED' | 'SKIPPED';
export type StartOutcome = 'STARTED' | 'HELD' | 'WAITING' | 'SETTLED_ELSEWHERE' | FailOutcome;
export type ReconcileOutcome =
  | 'UNCHANGED'
  | 'AWAITING_APPROVAL'
  | 'RUNNING'
  | 'SETTLED_ELSEWHERE'
  /** The run's session could not be retired yet: the run is left as it was for the next pass. */
  | 'DEFERRED'
  | FailOutcome;

/**
 * A session that may still run: not ended, not filed away, and not FAILED with an auto-retry that would bring it
 * back. Ended means a terminal status or an end requested (SessionsService.transitionEnd).
 */
const LIVE_SESSION: Prisma.SessionWhereInput = {
  deletedAt: null,
  completedAt: null,
  archivedAt: null,
  cancelRequestedAt: null,
  OR: [
    { status: { notIn: [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED] } },
    { status: RunStatus.FAILED, retryAt: { not: null } },
  ],
};

type Tx = Prisma.TransactionClient;

const IN_PROGRESS = ['RUNNING', 'AWAITING_APPROVAL'] as const;

function refusal(kind: 'BAD_REQUEST' | 'CONFLICT' | 'FORBIDDEN' | 'NOT_FOUND', code: string, message: string): Error {
  const body = { code, message };
  if (kind === 'BAD_REQUEST') return new BadRequestException(body);
  if (kind === 'CONFLICT') return new ConflictException(body);
  if (kind === 'FORBIDDEN') return new ForbiddenException(body);
  return new NotFoundException(body);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How long cards kept a session waiting: the union of each card's open interval, up to now. */
export function waitedOnCards(cards: Array<{ createdAt: Date; decidedAt: Date | null; status: string }>, now: Date): number {
  let waited = 0;
  let reach = -Infinity;
  for (const c of [...cards].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const from = Math.max(c.createdAt.getTime(), reach);
    const to = c.status === 'PENDING' ? now.getTime() : (c.decidedAt ?? c.createdAt).getTime();
    if (to > from) waited += to - from;
    reach = Math.max(reach, to);
  }
  return waited;
}

/** How far back a slot may still be caught up, or retried: one period of its rule. */
export function catchUpWindowMs(rule: ScheduleRule, timezone: string, slot: Date): number {
  if (rule.kind === 'ONCE') return SCHEDULE_ONCE_CATCH_UP_MS;
  const next = nextDueAt(rule, timezone, slot);
  return next ? next.getTime() - slot.getTime() : 7 * 24 * HOUR;
}

@Injectable()
export class ScheduleRunsService {
  private readonly logger = new Logger(ScheduleRunsService.name);
  private readonly clock: () => Date;
  /** Schedules and runs whose last pass threw, until when they are left out (SCHEDULE_ERROR_COOLDOWN_MS). */
  private readonly cooling = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SCHEDULE_RUN_SESSIONS) private readonly sessions: ScheduleRunSessionPort,
    @Optional() @Inject(SCHEDULE_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? (() => new Date());
  }

  // -------------------------------------------------------------------------------------------------------------
  // Firing (§5)
  // -------------------------------------------------------------------------------------------------------------

  /** Fire up to `batch` due schedules, the longest-due first. */
  async fireDue(batch = 25): Promise<Array<{ scheduleId: string; outcome: FireOutcome }>> {
    const due = await this.prisma.schedule.findMany({
      where: { state: 'ACTIVE', nextDueAt: { lte: this.clock() }, id: { notIn: this.cooled() } },
      orderBy: [{ nextDueAt: 'asc' }, { id: 'asc' }],
      take: batch,
      select: { id: true },
    });
    const outcomes: Array<{ scheduleId: string; outcome: FireOutcome }> = [];
    for (const { id } of due) {
      try {
        outcomes.push({ scheduleId: id, outcome: await this.fire(id) });
      } catch (error) {
        this.coolDown(id);
        this.logger.error(`schedule ${id} did not fire: ${messageOf(error)}`);
      }
    }
    return outcomes;
  }

  /** Fire one schedule's due slots, in one transaction. */
  async fire(scheduleId: string): Promise<FireOutcome> {
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const schedule = await this.lock(tx, scheduleId);
        const now = this.clock();
        if (!schedule || schedule.state !== 'ACTIVE' || !schedule.nextDueAt || schedule.nextDueAt > now) {
          return 'SETTLED_ELSEWHERE' as const;
        }
        const rule = parseRule(schedule.rule);
        const window = { startAt: schedule.startAt, endAt: schedule.endAt };
        const slots = [schedule.nextDueAt];
        for (let t = schedule.nextDueAt; slots.length < MAX_SLOTS_PER_FIRING; ) {
          const n = nextDueAt(rule, schedule.timezone, t, window);
          if (!n || n > now) break;
          slots.push(n);
          t = n;
        }
        const latest = slots[slots.length - 1];
        const caughtUp = now.getTime() - latest.getTime() <= catchUpWindowMs(rule, schedule.timezone, latest);
        const missed = caughtUp ? slots.slice(0, -1) : slots;
        for (const slot of missed) {
          await this.insertSlotRun(tx, schedule, slot, 'SCHEDULED', 'MISSED', now);
        }
        let outcome: FireOutcome = 'MISSED';
        if (caughtUp) {
          const trigger = now.getTime() - latest.getTime() <= SCHEDULE_LATE_GRACE_MS ? 'SCHEDULED' : 'CATCH_UP';
          const taken = await tx.scheduleRun.findFirst({
            where: { scheduleId, plannedAt: latest, trigger: { in: ['SCHEDULED', 'CATCH_UP'] } },
            select: { id: true },
          });
          if (taken) {
            outcome = 'SETTLED_ELSEWHERE';
          } else {
            await this.skipQueued(tx, scheduleId, now);
            const id = await this.insertSlotRun(tx, schedule, latest, trigger, 'QUEUED', null);
            outcome = id ? 'FIRED' : 'SETTLED_ELSEWHERE';
          }
        }
        const next = nextDueAt(rule, schedule.timezone, now, window);
        await tx.schedule.update({
          where: { id: scheduleId },
          data: next
            ? { nextDueAt: next }
            : { nextDueAt: null, state: 'ENDED', endedReason: 'END_REACHED', endedAt: now },
        });
        return outcome;
      },
      loggedRetry(this.logger, 'scheduleRuns.fire'),
    );
  }

  // -------------------------------------------------------------------------------------------------------------
  // Starting (§6)
  // -------------------------------------------------------------------------------------------------------------

  /** Start the QUEUED runs that may start now: nothing of theirs in progress, and their wait over. */
  async startDue(batch = 25, scheduleId?: string): Promise<Array<{ runId: string; outcome: StartOutcome }>> {
    const now = this.clock();
    const queued = await this.prisma.scheduleRun.findMany({
      where: {
        state: 'QUEUED',
        ...(scheduleId ? { scheduleId } : {}),
        OR: [{ notBeforeAt: null }, { notBeforeAt: { lte: now } }],
        schedule: { runs: { none: { state: { in: [...IN_PROGRESS] } } } },
      },
      orderBy: [{ plannedAt: 'asc' }, { id: 'asc' }],
      take: batch,
      select: { id: true },
    });
    const outcomes: Array<{ runId: string; outcome: StartOutcome }> = [];
    for (const { id } of queued) {
      try {
        outcomes.push({ runId: id, outcome: await this.start(id) });
      } catch (error) {
        this.logger.error(`schedule run ${id} did not start: ${messageOf(error)}`);
        await this.deferAfterError(id);
      }
    }
    return outcomes;
  }

  /**
   * Start one QUEUED run: the checks, then RUNNING and its session.
   *
   * One run never has two live sessions. A session an earlier attempt left alive (a process that died between
   * re-queueing a run and retiring its session, or a create that committed after its caller gave up) is found by
   * `scheduleRunId` under the schedule lock and retired before a new one is opened; one that cannot be retired
   * holds the start back. A create that fails after its INSERT committed keeps that session as the run's.
   */
  async start(runId: string, retiredStrays = false): Promise<StartOutcome> {
    const step = await withTransactionRetry(
      this.prisma,
      async (tx): Promise<{ outcome: StartOutcome; open?: OpenRunSession; strays?: Array<{ id: string; ownerId: string }> }> => {
        const head = await tx.scheduleRun.findUnique({ where: { id: runId }, select: { scheduleId: true } });
        if (!head) return { outcome: 'SETTLED_ELSEWHERE' };
        const schedule = await this.lock(tx, head.scheduleId);
        const run = await tx.scheduleRun.findUnique({ where: { id: runId } });
        const now = this.clock();
        if (!schedule || !run || run.state !== 'QUEUED') return { outcome: 'SETTLED_ELSEWHERE' };
        if (run.notBeforeAt && run.notBeforeAt > now) return { outcome: 'WAITING' };
        const busy = await tx.scheduleRun.count({ where: { scheduleId: schedule.id, state: { in: [...IN_PROGRESS] } } });
        if (busy > 0) return { outcome: 'WAITING' };
        if (
          (schedule.state === 'ENDED' && schedule.endedReason === 'DELETED')
          || (schedule.state === 'PAUSED' && run.trigger !== 'MANUAL')
        ) {
          // §8.4: pausing or deleting cancels the run waiting; a retry put back after the pause is that run too.
          await tx.scheduleRun.update({ where: { id: runId }, data: { state: 'CANCELLED', endedAt: now, notBeforeAt: null } });
          return { outcome: 'CANCELLED' };
        }
        if (schedule.state === 'HELD') {
          await this.holdRun(tx, run, schedule.heldReason ?? 'HELD', now);
          return { outcome: 'HELD' };
        }
        // Computed under the lock, so a session another replica opens for this run after this commits is never one.
        const strays = await tx.session.findMany({
          where: { scheduleRunId: runId, ...LIVE_SESSION },
          select: { id: true, ownerId: true },
        });
        if (strays.length > 0) return { outcome: 'WAITING', strays };
        const check = await scheduleStartCheck(tx, schedule);
        if (!check.ok) {
          await this.holdRun(tx, run, check.reason, now);
          if (schedule.state !== 'ENDED') {
            await tx.schedule.update({
              where: { id: schedule.id },
              data: { state: 'HELD', heldReason: check.reason, nextDueAt: null },
            });
          }
          return { outcome: 'HELD' };
        }
        const workspace = await tx.workspace.findUnique({
          where: { id: schedule.workspaceId },
          select: { runner: { select: { status: true, ...RUNNER_BEATS, managedRunner: { select: { id: true } } } } },
        });
        // §5.2: a runner that is not there is a slot missed, not a failure. The run waits, without spending an
        // attempt, and starts once the runner is back inside its catch-up window; past it, it is MISSED. A managed
        // runner asleep is not absent: opening the session wakes it (SessionsService.create).
        const runner = workspace?.runner;
        if (!runner?.managedRunner && !runnerIsOnline(runner, now.getTime())) {
          if (now.getTime() > this.deadline(schedule, run)) {
            await tx.scheduleRun.update({
              where: { id: runId },
              data: { state: 'MISSED', failureReason: 'RUNNER_UNAVAILABLE', endedAt: now, notBeforeAt: null },
            });
            return { outcome: 'MISSED' };
          }
          await tx.scheduleRun.update({
            where: { id: runId },
            data: { notBeforeAt: new Date(now.getTime() + SCHEDULE_RUNNER_WAIT_MS), failureReason: 'RUNNER_UNAVAILABLE' },
          });
          return { outcome: 'WAITING' };
        }
        const sessionId = randomUUID();
        const prompt = await this.firstTurn(tx, schedule, run, now);
        await tx.scheduleRun.update({
          where: { id: runId },
          data: { state: 'RUNNING', startedAt: now, sessionId, notBeforeAt: null },
        });
        return { outcome: 'STARTED', open: this.openInput(schedule, run, sessionId, prompt, check.plan) };
      },
      loggedRetry(this.logger, 'scheduleRuns.start'),
    );
    if (step.strays) {
      for (const stray of step.strays) {
        try {
          await this.sessions.end(stray.ownerId, stray.id);
        } catch (error) {
          this.logger.warn(`run ${runId} waits: its earlier session ${stray.id} could not be retired: ${messageOf(error)}`);
          return 'WAITING';
        }
      }
      return retiredStrays ? 'WAITING' : this.start(runId, true);
    }
    if (!step.open) return step.outcome;
    try {
      await this.sessions.open(step.open);
      return 'STARTED';
    } catch (error) {
      this.logger.warn(`run ${runId} could not open its session: ${messageOf(error)}`);
      // A create that threw after its INSERT committed (it wakes a managed runner afterwards) did open the
      // session: it is the run's, and the watch pass reads it like any other.
      const opened = await this.prisma.session.findUnique({ where: { id: step.open.sessionId }, select: { id: true } });
      if (opened) return 'STARTED';
      // Refused before anything was written: the request itself cannot be served, which a retry will not change.
      if (error instanceof HttpException && error.getStatus() < 500) {
        return this.holdRefused(runId, step.open.sessionId);
      }
      const failed = await this.fail(runId, 'RUNNER_UNAVAILABLE', { sessionId: step.open.sessionId });
      return failed === 'DEFERRED' ? 'WAITING' : failed;
    }
  }

  /** A create door refused the run's session: the run and its schedule are HELD (SESSION_REFUSED) for the owner. */
  private async holdRefused(runId: string, sessionId: string): Promise<StartOutcome> {
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const head = await tx.scheduleRun.findUnique({ where: { id: runId }, select: { scheduleId: true } });
        const schedule = head ? await this.lock(tx, head.scheduleId) : null;
        const run = await tx.scheduleRun.findUnique({ where: { id: runId } });
        if (!schedule || !run || run.state !== 'RUNNING' || run.sessionId !== sessionId) return 'SETTLED_ELSEWHERE' as const;
        const now = this.clock();
        await this.holdRun(tx, run, 'SESSION_REFUSED', now);
        if (schedule.state !== 'ENDED') {
          await tx.schedule.update({
            where: { id: schedule.id },
            data: { state: 'HELD', heldReason: 'SESSION_REFUSED', nextDueAt: null },
          });
        }
        return 'HELD' as const;
      },
      loggedRetry(this.logger, 'scheduleRuns.holdRefused'),
    );
  }

  // -------------------------------------------------------------------------------------------------------------
  // Watching (§6.4, §7.1, §7.2)
  // -------------------------------------------------------------------------------------------------------------

  /** Read every run in progress against its session, and end the ones whose session says they are over. */
  async reconcile(batch = 100): Promise<Array<{ runId: string; outcome: ReconcileOutcome }>> {
    const runs = await this.prisma.scheduleRun.findMany({
      where: { state: { in: [...IN_PROGRESS] }, id: { notIn: this.cooled() } },
      orderBy: { startedAt: 'asc' },
      take: batch,
      select: { id: true },
    });
    const outcomes: Array<{ runId: string; outcome: ReconcileOutcome }> = [];
    for (const { id } of runs) {
      try {
        outcomes.push({ runId: id, outcome: await this.reconcileRun(id) });
      } catch (error) {
        this.coolDown(id);
        this.logger.error(`schedule run ${id} was not reconciled: ${messageOf(error)}`);
      }
    }
    return outcomes;
  }

  async reconcileRun(runId: string): Promise<ReconcileOutcome> {
    const run = await this.prisma.scheduleRun.findUnique({
      where: { id: runId },
      include: { schedule: { select: { runLimitMinutes: true, ownerId: true } } },
    });
    if (!run || (run.state !== 'RUNNING' && run.state !== 'AWAITING_APPROVAL')) return 'SETTLED_ELSEWHERE';
    const now = this.clock();
    const startedAt = run.startedAt ?? now;
    const sessionId = run.sessionId;
    const session = sessionId
      ? await this.prisma.session.findUnique({
          where: { id: sessionId },
          select: { status: true, completedAt: true, archivedAt: true, deletedAt: true, cancelRequestedAt: true, error: true },
        })
      : null;
    if (!session || !sessionId) {
      // The start committed and its session never followed: the process that was to open it died between the two.
      if (now.getTime() - startedAt.getTime() >= SCHEDULE_UNDELIVERED_LIMIT_MS) {
        return this.fail(runId, 'ENGINE_CRASHED_BEFORE_START', { sessionId });
      }
      return 'UNCHANGED';
    }
    const opening = await this.prisma.conversationTurn.findFirst({
      where: { sessionId, clientTurnId: openingTurnKey(sessionId) },
      select: { deliveredAt: true, status: true },
    });
    const deliveredAt = opening?.deliveredAt ?? null;
    const delivered = deliveredAt !== null;

    if (session.status === RunStatus.FAILED) {
      if (delivered) return this.fail(runId, 'ENGINE_CRASHED', { sessionId });
      return this.fail(runId, isUsageLimitErrorText(session.error) ? 'QUOTA' : 'ENGINE_CRASHED_BEFORE_START', { sessionId });
    }
    const ended = session.deletedAt !== null || session.completedAt !== null || session.archivedAt !== null
      || session.cancelRequestedAt !== null
      || session.status === RunStatus.SUCCEEDED || session.status === RunStatus.CANCELLED;
    // Ended before its first turn reached the engine: the run never started (a retire that committed before its
    // re-queue did, among others), so it is retried like one that met no runner.
    if (ended) return this.fail(runId, delivered ? 'NO_REPORT' : 'RUNNER_UNAVAILABLE', { sessionId });

    if (!delivered) {
      if (now.getTime() - startedAt.getTime() >= SCHEDULE_UNDELIVERED_LIMIT_MS) {
        return this.fail(runId, 'RUNNER_UNAVAILABLE', { sessionId });
      }
      return 'UNCHANGED';
    }
    const cards = await this.prisma.approval.findMany({
      where: { sessionId, createdAt: { gte: deliveredAt } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, decidedAt: true, status: true },
    });
    // The limit is the engine's working time: time spent waiting on a person's card is not the run's to spend, or a
    // two-hour card could never time out under a run limit of at most two hours (§12).
    const working = now.getTime() - deliveredAt.getTime() - waitedOnCards(cards, now);
    if (working >= run.schedule.runLimitMinutes * MINUTE) {
      return this.fail(runId, 'RUN_LIMIT', { sessionId, interrupt: true });
    }
    const card = cards.find((c) => c.status === 'PENDING')
      ?? await this.prisma.approval.findFirst({
        where: { sessionId, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, decidedAt: true, status: true },
      });
    if (card) {
      if (now.getTime() - card.createdAt.getTime() >= SCHEDULE_APPROVAL_TIMEOUT_MS) {
        return this.fail(runId, 'APPROVAL_TIMEOUT', { sessionId, interrupt: true });
      }
      if (run.state === 'RUNNING') return this.moveInProgress(runId, 'RUNNING', 'AWAITING_APPROVAL');
      return 'UNCHANGED';
    }
    const idle = (session.status === RunStatus.AWAITING_INPUT || session.status === RunStatus.INTERRUPTED)
      && opening?.status === 'ANSWERED';
    if (idle) return this.fail(runId, 'NO_REPORT', { sessionId });
    if (run.state === 'AWAITING_APPROVAL') return this.moveInProgress(runId, 'AWAITING_APPROVAL', 'RUNNING');
    return 'UNCHANGED';
  }

  /** §7.4: a NO_CHANGE run's session is completed once its turn has settled. */
  async completeNoChangeSessions(batch = 25): Promise<string[]> {
    const sessions = await this.prisma.session.findMany({
      where: {
        runSource: 'SCHEDULE',
        completedAt: null,
        deletedAt: null,
        status: { notIn: [RunStatus.PENDING, RunStatus.RUNNING] },
        scheduleRun: { state: 'NO_CHANGE' },
      },
      take: batch,
      select: { id: true, ownerId: true, scheduleRun: { select: { sessionId: true } } },
    });
    const completed: string[] = [];
    for (const s of sessions) {
      if (s.scheduleRun?.sessionId !== s.id) continue;
      try {
        await this.sessions.complete(s.ownerId, s.id);
        completed.push(s.id);
      } catch (error) {
        this.logger.warn(`session ${s.id} of a NO_CHANGE run was not completed: ${messageOf(error)}`);
      }
    }
    return completed;
  }

  // -------------------------------------------------------------------------------------------------------------
  // The report (§7.1)
  // -------------------------------------------------------------------------------------------------------------

  /** `schedule_run_report`, from the session serving a run: once per run, and it ends the run. */
  async report(
    ownerId: string,
    sessionId: string,
    input: ScheduleRunReport,
  ): Promise<{ run: ScheduleRun; newFinding: boolean }> {
    const report = this.checkReport(input);
    const result = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const session = await tx.session.findFirst({
          where: { id: sessionId, ownerId },
          select: { scheduleRunId: true },
        });
        if (!session?.scheduleRunId) {
          throw refusal('FORBIDDEN', 'SCHEDULE_RUN_REPORT_NOT_A_RUN', 'Only a session serving a scheduled run can report it.');
        }
        const head = await tx.scheduleRun.findUnique({ where: { id: session.scheduleRunId }, select: { scheduleId: true } });
        const schedule = head ? await this.lock(tx, head.scheduleId) : null;
        const run = await tx.scheduleRun.findUnique({ where: { id: session.scheduleRunId } });
        if (!schedule || !run || run.sessionId !== sessionId) {
          throw refusal('FORBIDDEN', 'SCHEDULE_RUN_REPORT_NOT_A_RUN', 'This session no longer serves its run.');
        }
        if (run.state !== 'RUNNING' && run.state !== 'AWAITING_APPROVAL') {
          const reported = run.state === 'NO_CHANGE' || run.state === 'CHANGED' || run.failureReason === 'REPORTED_FAILED';
          throw refusal(
            'CONFLICT',
            reported ? 'SCHEDULE_RUN_ALREADY_REPORTED' : 'SCHEDULE_RUN_ENDED',
            reported ? 'This run has already been reported; a run reports once.' : `This run has already ended (${run.state}).`,
          );
        }
        const now = this.clock();
        const ended = await tx.scheduleRun.update({
          where: { id: run.id },
          data: {
            state: report.outcome,
            key: report.key,
            summary: report.summary,
            links: report.links as Prisma.InputJsonValue,
            failureReason: report.outcome === 'FAILED' ? 'REPORTED_FAILED' : null,
            endedAt: now,
          },
        });
        await tx.schedule.update({
          where: { id: schedule.id },
          data: {
            ...(report.note !== undefined ? { note: report.note } : {}),
            consecutiveFailures: report.outcome === 'FAILED' ? { increment: 1 } : 0,
          },
        });
        let newFinding = false;
        if (report.outcome === 'CHANGED' && report.key) {
          const known = await tx.scheduleFinding.findUnique({
            where: { scheduleId_key: { scheduleId: schedule.id, key: report.key } },
          });
          if (known) {
            const links = [...new Set([...((known.links as string[] | null) ?? []), ...report.links])];
            await tx.scheduleFinding.update({
              where: { id: known.id },
              data: { lastSeenRunId: run.id, links: links as Prisma.InputJsonValue },
            });
          } else {
            await tx.scheduleFinding.create({
              data: {
                scheduleId: schedule.id,
                key: report.key,
                summary: report.summary,
                firstRunId: run.id,
                lastSeenRunId: run.id,
                links: report.links as Prisma.InputJsonValue,
                createdAt: now,
              },
            });
            newFinding = true;
          }
        }
        return { run: ended, newFinding, scheduleId: schedule.id };
      },
      loggedRetry(this.logger, 'scheduleRuns.report'),
    );
    if (result.run.state === 'NO_CHANGE') await this.completeIfSettled(ownerId, sessionId);
    await this.startNext(result.scheduleId);
    return { run: result.run, newFinding: result.newFinding };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Direct controls (§8.4)
  // -------------------------------------------------------------------------------------------------------------

  /** Run now: a MANUAL run under the overlap rule. Allowed when PAUSED, refused when ENDED or HELD. */
  async runNow(actor: ScheduleActor, scheduleId: string): Promise<ScheduleRun> {
    const run = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const schedule = await this.lock(tx, scheduleId, actor.ownerId);
        if (!schedule) throw refusal('NOT_FOUND', 'SCHEDULE_NOT_FOUND', 'No such schedule.');
        assertRunSessionScope(await runSessionScheduleId(tx, actor), scheduleId, 'CONTROL');
        if (schedule.state === 'ENDED') throw refusal('CONFLICT', 'SCHEDULE_ENDED', 'The schedule has ended.');
        if (schedule.state === 'HELD') {
          throw refusal('CONFLICT', 'SCHEDULE_HELD', `The schedule is held (${schedule.heldReason}); resume it first.`);
        }
        const now = this.clock();
        await this.skipQueued(tx, scheduleId, now);
        return tx.scheduleRun.create({
          data: { scheduleId, scheduleRevision: schedule.revision, plannedAt: now, trigger: 'MANUAL', state: 'QUEUED' },
        });
      },
      loggedRetry(this.logger, 'scheduleRuns.runNow'),
    );
    await this.startNext(scheduleId);
    return run;
  }

  /** Stop this run: CANCELLED (CANCELLED_BY_OWNER) and its session interrupted. The schedule is unchanged. */
  async stopRun(actor: ScheduleActor, runId: string): Promise<ScheduleRun> {
    const result = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const head = await tx.scheduleRun.findUnique({ where: { id: runId }, select: { scheduleId: true } });
        const schedule = head ? await this.lock(tx, head.scheduleId, actor.ownerId) : null;
        const run = schedule ? await tx.scheduleRun.findUnique({ where: { id: runId } }) : null;
        if (!schedule || !run) throw refusal('NOT_FOUND', 'SCHEDULE_RUN_NOT_FOUND', 'No such run.');
        assertRunSessionScope(await runSessionScheduleId(tx, actor), schedule.id, 'CONTROL');
        if (run.state !== 'QUEUED' && run.state !== 'RUNNING' && run.state !== 'AWAITING_APPROVAL') {
          throw refusal('CONFLICT', 'SCHEDULE_RUN_NOT_ACTIVE', `This run has already ended (${run.state}).`);
        }
        const stopped = await tx.scheduleRun.update({
          where: { id: runId },
          data: { state: 'CANCELLED', failureReason: 'CANCELLED_BY_OWNER', endedAt: this.clock() },
        });
        return { stopped, interrupt: run.state !== 'QUEUED' ? run.sessionId : null, ownerId: schedule.ownerId };
      },
      loggedRetry(this.logger, 'scheduleRuns.stop'),
    );
    if (result.interrupt) await this.quietly(() => this.sessions.interrupt(result.ownerId, result.interrupt!), 'interrupt');
    await this.startNext(result.stopped.scheduleId);
    return result.stopped;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Ending without a report
  // -------------------------------------------------------------------------------------------------------------

  /**
   * End an in-progress run with a failure. A run that never reached its engine (RETRIED_FAILURES) has its session
   * retired FIRST — auto-retry cancelled and the session ended — and only then is the run put back, so a process
   * that dies between the two leaves an ended session and a run still RUNNING, which the next pass settles the same
   * way, never two live sessions. A session that cannot be retired leaves the run as it was (DEFERRED). Then the
   * session is interrupted when asked, and a queued run may start.
   */
  async fail(
    runId: string,
    reason: ScheduleFailureReason,
    opts: { sessionId: string | null; interrupt?: boolean },
  ): Promise<FailOutcome | 'SETTLED_ELSEWHERE' | 'DEFERRED'> {
    if (RETRIED_FAILURES.has(reason) && opts.sessionId) {
      const owner = await this.prisma.scheduleRun.findUnique({
        where: { id: runId },
        select: { schedule: { select: { ownerId: true } } },
      });
      if (owner) {
        try {
          await this.sessions.end(owner.schedule.ownerId, opts.sessionId);
        } catch (error) {
          this.logger.warn(`run ${runId} stays as it is: session ${opts.sessionId} could not be retired: ${messageOf(error)}`);
          return 'DEFERRED';
        }
      }
    }
    const result = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const head = await tx.scheduleRun.findUnique({ where: { id: runId }, select: { scheduleId: true } });
        const schedule = head ? await this.lock(tx, head.scheduleId) : null;
        const run = await tx.scheduleRun.findUnique({ where: { id: runId } });
        if (!schedule || !run || (run.state !== 'RUNNING' && run.state !== 'AWAITING_APPROVAL') || run.sessionId !== opts.sessionId) {
          return { outcome: 'SETTLED_ELSEWHERE' as const, ownerId: null, scheduleId: head?.scheduleId ?? null };
        }
        const outcome = await this.failLocked(tx, schedule, run, reason, this.clock());
        return { outcome, ownerId: schedule.ownerId, scheduleId: schedule.id };
      },
      loggedRetry(this.logger, 'scheduleRuns.fail'),
    );
    if (result.outcome !== 'SETTLED_ELSEWHERE' && result.ownerId && opts.sessionId && opts.interrupt) {
      const ownerId = result.ownerId;
      const sessionId = opts.sessionId;
      await this.quietly(() => this.sessions.interrupt(ownerId, sessionId), 'interrupt');
    }
    if (result.scheduleId) await this.startNext(result.scheduleId);
    return result.outcome;
  }

  /**
   * Settle a failed attempt (§5.2, §7.2). A run that started is FAILED, counted, never retried. One that never
   * reached its engine is a slot not yet run: retried after 1, 5 and 15 minutes, then once an hour, for as long as
   * its catch-up window lasts; past it, MISSED, which is not a failure. It is CANCELLED instead when its schedule is
   * paused (a MANUAL run aside), held or deleted, and SKIPPED when a newer run already waits in its place.
   */
  private async failLocked(
    tx: Tx,
    schedule: Schedule,
    run: ScheduleRun,
    reason: ScheduleFailureReason,
    now: Date,
  ): Promise<FailOutcome> {
    const end = (state: 'FAILED' | 'MISSED' | 'CANCELLED' | 'SKIPPED') =>
      tx.scheduleRun.update({
        where: { id: run.id },
        data: { state, failureReason: reason, endedAt: now, notBeforeAt: null },
      });
    if (!RETRIED_FAILURES.has(reason)) {
      await end('FAILED');
      // Counted, never acted on: a schedule is not paused by its failures (§7.2, owner decision).
      await tx.schedule.update({ where: { id: schedule.id }, data: { consecutiveFailures: { increment: 1 } } });
      return 'FAILED';
    }
    const stopped = schedule.state === 'HELD'
      || (schedule.state === 'ENDED' && schedule.endedReason === 'DELETED')
      || (schedule.state === 'PAUSED' && run.trigger !== 'MANUAL');
    if (stopped) {
      await end('CANCELLED');
      return 'CANCELLED';
    }
    const waiting = await tx.scheduleRun.count({ where: { scheduleId: schedule.id, state: 'QUEUED', id: { not: run.id } } });
    if (waiting > 0) {
      await end('SKIPPED');
      return 'SKIPPED';
    }
    const wait = run.attempt <= SCHEDULE_RETRY_DELAYS_MINUTES.length
      ? SCHEDULE_RETRY_DELAYS_MINUTES[run.attempt - 1] * MINUTE
      : SCHEDULE_RECOVERY_WAIT_MS;
    const retryAt = new Date(now.getTime() + wait);
    if (retryAt.getTime() > this.deadline(schedule, run)) {
      await end('MISSED');
      return 'MISSED';
    }
    await tx.scheduleRun.update({
      where: { id: run.id },
      data: { state: 'QUEUED', attempt: run.attempt + 1, notBeforeAt: retryAt, sessionId: null, startedAt: null, failureReason: reason },
    });
    return 'RETRY';
  }

  /** The last instant a run's slot may still start: its plannedAt plus one period of its rule (§5.2). */
  private deadline(schedule: Schedule, run: ScheduleRun): number {
    try {
      return run.plannedAt.getTime() + catchUpWindowMs(parseRule(schedule.rule), schedule.timezone, run.plannedAt);
    } catch {
      // A rule that no longer reads is what can make a start throw on every pass: a day, as for ONCE.
      return run.plannedAt.getTime() + SCHEDULE_ONCE_CATCH_UP_MS;
    }
  }

  /**
   * A QUEUED run whose start threw: moved out of the due set for a while, so the runs behind it go ahead, and MISSED
   * once its catch-up window has passed, so no run waits for ever.
   */
  private async deferAfterError(runId: string): Promise<void> {
    try {
      const run = await this.prisma.scheduleRun.findUnique({ where: { id: runId }, include: { schedule: true } });
      if (!run || run.state !== 'QUEUED') return;
      const now = this.clock();
      const missed = now.getTime() > this.deadline(run.schedule, run);
      await this.prisma.scheduleRun.updateMany({
        where: { id: runId, state: 'QUEUED' },
        data: missed
          ? { state: 'MISSED', endedAt: now, notBeforeAt: null }
          : { notBeforeAt: new Date(now.getTime() + SCHEDULE_ERROR_COOLDOWN_MS) },
      });
    } catch (error) {
      this.coolDown(runId);
      this.logger.error(`schedule run ${runId} could not be put aside: ${messageOf(error)}`);
    }
  }

  private cooled(): string[] {
    const now = this.clock().getTime();
    for (const [id, until] of this.cooling) if (until <= now) this.cooling.delete(id);
    return [...this.cooling.keys()];
  }

  private coolDown(id: string): void {
    this.cooling.set(id, this.clock().getTime() + SCHEDULE_ERROR_COOLDOWN_MS);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Inside
  // -------------------------------------------------------------------------------------------------------------

  /** The per-account lock, then the schedule row FOR UPDATE: SchedulesService's order. */
  private async lock(tx: Tx, scheduleId: string, ownerId?: string): Promise<Schedule | null> {
    const head = await tx.schedule.findUnique({ where: { id: scheduleId }, select: { ownerId: true } });
    if (!head || (ownerId && head.ownerId !== ownerId)) return null;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SCHEDULE_LOCK_NAMESPACE}::int, hashtext(${head.ownerId}))`;
    await tx.$queryRaw`SELECT "id" FROM "schedule" WHERE "id" = ${scheduleId}::uuid FOR UPDATE`;
    return tx.schedule.findUnique({ where: { id: scheduleId } });
  }

  /** One slot's run; null when the slot already has one (another worker, or this one before a restart). */
  private async insertSlotRun(
    tx: Tx,
    schedule: Schedule,
    plannedAt: Date,
    trigger: 'SCHEDULED' | 'CATCH_UP',
    state: 'QUEUED' | 'MISSED',
    endedAt: Date | null,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "schedule_run" ("id", "schedule_id", "schedule_revision", "planned_at", "trigger", "state", "ended_at")
      VALUES (${randomUUID()}::uuid, ${schedule.id}::uuid, ${schedule.revision}, ${plannedAt},
              ${trigger}::"schedule_run_trigger", ${state}::"schedule_run_state", ${endedAt})
      ON CONFLICT ("schedule_id", "planned_at") WHERE "trigger" IN ('SCHEDULED', 'CATCH_UP') DO NOTHING
      RETURNING "id"`;
    return rows[0]?.id ?? null;
  }

  /** The overlap rule: the run already waiting gives its place to the newer one. */
  private async skipQueued(tx: Tx, scheduleId: string, now: Date): Promise<void> {
    await tx.scheduleRun.updateMany({
      where: { scheduleId, state: 'QUEUED' },
      data: { state: 'SKIPPED', endedAt: now, notBeforeAt: null },
    });
  }

  private async holdRun(tx: Tx, run: ScheduleRun, reason: string, now: Date): Promise<void> {
    await tx.scheduleRun.update({
      where: { id: run.id },
      data: { state: 'HELD', heldReason: reason, endedAt: now, notBeforeAt: null },
    });
  }

  private async moveInProgress(
    runId: string,
    from: 'RUNNING' | 'AWAITING_APPROVAL',
    to: 'RUNNING' | 'AWAITING_APPROVAL',
  ): Promise<ReconcileOutcome> {
    const moved = await this.prisma.scheduleRun.updateMany({ where: { id: runId, state: from }, data: { state: to } });
    return moved.count === 1 ? to : 'SETTLED_ELSEWHERE';
  }

  /** The run's first turn: the scheduled-run block, then the prompt (§6.3). */
  private async firstTurn(tx: Tx, schedule: Schedule, run: ScheduleRun, now: Date): Promise<string> {
    const started = await tx.scheduleRun.count({
      where: { scheduleId: schedule.id, startedAt: { not: null }, id: { not: run.id } },
    });
    const previous = await tx.scheduleRun.findMany({
      where: { scheduleId: schedule.id, state: { in: ['NO_CHANGE', 'CHANGED', 'FAILED'] }, endedAt: { not: null } },
      orderBy: { endedAt: 'desc' },
      take: 1,
      select: { state: true, endedAt: true },
    });
    const findings = await tx.scheduleFinding.findMany({
      where: { scheduleId: schedule.id },
      orderBy: { createdAt: 'asc' },
      select: { key: true, firstRunId: true, createdAt: true },
    });
    const last = previous[0];
    return scheduledRunTurn({
      runNumber: started + 1,
      title: schedule.title,
      intent: schedule.intent,
      prompt: schedule.prompt,
      timezone: schedule.timezone,
      plannedAt: run.plannedAt,
      startedAt: now,
      lastRun: last ? { state: last.state as 'NO_CHANGE' | 'CHANGED' | 'FAILED', endedAt: last.endedAt! } : null,
      // The baselines first (what the creating agent saw), then in the order they were first reported.
      findings: [...findings.filter((f) => !f.firstRunId), ...findings.filter((f) => f.firstRunId)]
        .map((f) => ({ key: f.key, firstSeenAt: f.firstRunId ? f.createdAt : null })),
      note: schedule.note,
      accessLevel: schedule.accessLevel,
      runLimitMinutes: schedule.runLimitMinutes,
    });
  }

  private openInput(schedule: Schedule, run: ScheduleRun, sessionId: string, prompt: string, plan: StartPlan): OpenRunSession {
    return {
      ownerId: schedule.ownerId,
      sessionId,
      scheduleRunId: run.id,
      workspaceId: schedule.workspaceId,
      title: schedule.title,
      prompt,
      permissionMode: plan.mode,
      noWorktree: schedule.accessLevel === 'CHECK_ONLY',
      engine: plan.engine,
      provider: plan.provider,
    };
  }

  private async completeIfSettled(ownerId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId }, select: { status: true, completedAt: true } });
    if (!session || session.completedAt || session.status === RunStatus.RUNNING || session.status === RunStatus.PENDING) return;
    await this.quietly(() => this.sessions.complete(ownerId, sessionId), 'complete');
  }

  /** A run ended: the one queued behind it may start (§5). */
  private async startNext(scheduleId: string): Promise<void> {
    try {
      await this.startDue(1, scheduleId);
    } catch (error) {
      this.logger.warn(`the next run of schedule ${scheduleId} did not start yet: ${messageOf(error)}`);
    }
  }

  private async quietly(action: () => Promise<void>, what: string): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.logger.warn(`a run's session ${what} failed: ${messageOf(error)}`);
    }
  }

  private checkReport(input: ScheduleRunReport): Required<Omit<ScheduleRunReport, 'note'>> & { key: string | null; note?: string | null } {
    const outcome = input?.outcome;
    if (outcome !== 'NO_CHANGE' && outcome !== 'CHANGED' && outcome !== 'FAILED') {
      throw refusal('BAD_REQUEST', 'SCHEDULE_REPORT_OUTCOME_INVALID', 'outcome is NO_CHANGE, CHANGED or FAILED.');
    }
    const key = input.key == null || input.key === '' ? null : input.key;
    if (key !== null && (typeof key !== 'string' || key.length > 200)) {
      throw refusal('BAD_REQUEST', 'SCHEDULE_REPORT_KEY_INVALID', 'A key is a string of at most 200 characters.');
    }
    if (outcome === 'CHANGED' && key === null) {
      throw refusal('BAD_REQUEST', 'SCHEDULE_REPORT_KEY_REQUIRED', 'A CHANGED report names the key of what changed.');
    }
    if (typeof input.summary !== 'string' || input.summary.trim().length === 0 || input.summary.length > 4000) {
      throw refusal('BAD_REQUEST', 'SCHEDULE_REPORT_SUMMARY_INVALID', 'A summary is a non-empty string of at most 4000 characters.');
    }
    const links = input.links ?? [];
    if (!Array.isArray(links) || links.length > 20 || links.some((l) => typeof l !== 'string' || l.length > 2000)) {
      throw refusal('BAD_REQUEST', 'SCHEDULE_REPORT_LINKS_INVALID', 'links are at most 20 strings.');
    }
    if (input.note !== undefined && input.note !== null && (typeof input.note !== 'string' || input.note.length > 2000)) {
      throw refusal('BAD_REQUEST', 'SCHEDULE_REPORT_NOTE_INVALID', 'A note is a string of at most 2000 characters.');
    }
    return { outcome, key, summary: input.summary, links, ...(input.note !== undefined ? { note: input.note } : {}) };
  }
}
