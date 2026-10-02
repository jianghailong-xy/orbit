import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { expireSessionRequest } from './session-request';
import { SessionRequestService } from './session-request.service';

/**
 * The clock of session requests (contract §4, §5): EXPIRED, and the hand-offs nothing else made.
 *
 * Each pass does two things, in this order:
 *
 *   1. closes EXPIRED every request still OPEN past its `reply_by`, with the recipient as it stood
 *      (`expireSessionRequest`) — a compare-and-set, so an answer that lands first stands;
 *   2. hands back every outcome that is on no turn of its asker's and was never held
 *      (`SessionRequestService.handOff`): what step 1 just closed, what migration 0347's trigger closed
 *      when a recipient's run ended (no application code is there to hand it off), what an interrupt
 *      or a withdrawal closed inside SessionsService, and anything a crash cut off between an outcome
 *      committing and its hand-off.
 *
 * Shaped like the scheduled-wakeup worker (runner-api/scheduled-wakeup.worker.ts): one loop per replica,
 * never two passes at once, and nothing but compare-and-sets underneath, so replicas racing for the
 * same row cost a wasted read and never a second outcome or a second reply.
 *
 * Elapsed time starting agent work is allowed here for the reason the scheduled wakeup has it: the
 * deadline is the asker's own (`replyWithinSeconds`), and what it wakes is the asker, to be told.
 */

/** How often a pass looks. A deadline is at least a minute away when it is set. */
export const SESSION_REQUEST_POLL_INTERVAL_MS = 5_000;
/** Rows of each kind one pass takes. */
export const SESSION_REQUEST_BATCH = 25;

export const SESSION_REQUEST_WORKER_OPTIONS = Symbol('SESSION_REQUEST_WORKER_OPTIONS');

export interface SessionRequestWorkerOptions {
  pollIntervalMs?: number;
  batch?: number;
}

@Injectable()
export class SessionRequestWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SessionRequestWorker');
  private readonly pollIntervalMs: number;
  private readonly batch: number;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  /** The pass in flight. A replica never runs two. */
  private pass?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly requests: SessionRequestService,
    @Optional() @Inject(SESSION_REQUEST_WORKER_OPTIONS) options: SessionRequestWorkerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? SESSION_REQUEST_POLL_INTERVAL_MS;
    this.batch = options.batch ?? SESSION_REQUEST_BATCH;
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
        (error) => this.log.error(`session request pass failed: ${messageOf(error)}`),
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

  /** One pass: expire what is due, then hand back what is owed. Answers what each step came to. */
  async drain(now: Date = new Date()): Promise<{ expired: string[]; handedOff: string[] }> {
    const expired: string[] = [];
    const due = await this.prisma.sessionRequest.findMany({
      where: { state: 'OPEN', replyBy: { lte: now } },
      orderBy: [{ replyBy: 'asc' }, { id: 'asc' }],
      take: this.batch,
      select: { id: true },
    });
    for (const request of due) {
      try {
        if (await expireSessionRequest(this.prisma, request.id, now)) expired.push(request.id);
      } catch (error) {
        this.log.error(`session request ${request.id} was not expired: ${messageOf(error)}`);
      }
    }
    const handedOff: string[] = [];
    // What fails here is a fault, not a state of the world: `handOff` holds every outcome whose asker
    // refuses a turn for a reason of its own, so a row is left owed only by an error the next pass may
    // not meet.
    const owed = await this.prisma.sessionRequest.findMany({
      where: { state: { not: 'OPEN' }, replyClientTurnId: null, replyHeldAt: null },
      orderBy: [{ closedAt: 'asc' }, { id: 'asc' }],
      take: this.batch,
      select: { id: true },
    });
    for (const request of owed) {
      try {
        const where = await this.requests.handOff(request.id);
        if (where !== 'ALREADY') handedOff.push(request.id);
      } catch (error) {
        this.log.error(`session request ${request.id} was not handed back: ${messageOf(error)}`);
      }
    }
    return { expired, handedOff };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
