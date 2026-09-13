import { Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionNotSendable, SessionsService } from '../sessions/sessions.service';
import { BACKGROUND_WAKE_TURN_PREFIX, sessionHasEnded, undeliveredWakeTurn } from './background-job-wake';
import { dropScheduledWakeup, markScheduledWakeupDelivered, ScheduledWakeupSettled } from './scheduled-wakeup';

/**
 * Delivers the wakeups sessions asked the control plane to hold (scheduled-wakeup.ts) once they are due.
 *
 * A pure clock: nothing a runner or an engine does is needed for a wakeup to come due, which is why it
 * is held here and not in the engine that asked. Each pass reads the waiting wakeups that are due and
 * files each as a turn through `createTurn`, exactly as a background job's wake is filed: onto the
 * session's wake turn nobody has been handed yet if there is one, else as a new `bg-wake:` turn. The
 * wakeup is settled (DELIVERED) inside that turn's transaction, as a compare-and-set, so a wakeup is
 * filed at most once however many passes or replicas reach it; a session that ended before its wakeup
 * came due is not woken (DROPPED).
 *
 * A wakeup that fails for any other reason stays waiting and is tried again on the next pass.
 */

/** How often a pass looks for due wakeups. A wakeup is at least a minute away when it is asked for. */
export const SCHEDULED_WAKEUP_POLL_INTERVAL_MS = 5_000;
/** Due wakeups delivered per pass. */
export const SCHEDULED_WAKEUP_BATCH = 25;

export const SCHEDULED_WAKEUP_WORKER_OPTIONS = Symbol('SCHEDULED_WAKEUP_WORKER_OPTIONS');

export interface ScheduledWakeupWorkerOptions {
  pollIntervalMs?: number;
  batch?: number;
}

/** What one delivery came to. `SETTLED_ELSEWHERE`: replaced, cancelled or delivered before this pass reached it. */
export type ScheduledWakeupOutcome = 'DELIVERED' | 'DROPPED' | 'SETTLED_ELSEWHERE';

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

  /** Deliver up to one batch of due wakeups, the longest-due first. */
  async drain(): Promise<ScheduledWakeupOutcome[]> {
    const due = await this.prisma.sessionScheduledWakeup.findMany({
      where: { state: 'PENDING', dueAt: { lte: new Date() } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: this.batch,
      select: { id: true, sessionId: true, session: { select: { ownerId: true } } },
    });
    const outcomes: ScheduledWakeupOutcome[] = [];
    for (const wakeup of due) {
      try {
        outcomes.push(await this.deliver(wakeup.id, wakeup.sessionId, wakeup.session.ownerId));
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
      // Ended (SessionNotSendable), or no longer there to wake (NotFoundException).
      if (error instanceof SessionNotSendable || error instanceof NotFoundException) {
        return (await dropScheduledWakeup(this.prisma, wakeupId)) ? 'DROPPED' : 'SETTLED_ELSEWHERE';
      }
      throw error;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
