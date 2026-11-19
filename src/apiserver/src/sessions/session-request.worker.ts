import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { expireSessionRequest } from './session-request';
import { SessionRequestService } from './session-request.service';
import { PushService } from '../push/push.service';
import { RealtimeService, approvalRequestEvent } from '../realtime/realtime.service';

/**
 * The clock of session requests (contract §4, §5): EXPIRED, and the hand-offs nothing else made.
 *
 * Each pass first closes run questions whose approvals settled (R11), then does these three things
 * in order, and finally rings terminal run-question/notify fallbacks once (R10/M6):
 *
 *   1. closes EXPIRED every request still OPEN past its `reply_by`, with the recipient as it stood
 *      (`expireSessionRequest`) — a compare-and-set, so an answer that lands first stands;
 *   2. hands back every outcome that is on no turn of its asker's and was never held
 *      (`SessionRequestService.handOff`): what step 1 just closed, what migration 0350's trigger closed
 *      when a recipient's run ended (no application code is there to hand it off), what an interrupt,
 *      a withdrawal or a drain closed inside its own transaction, and anything a crash or a failed
 *      hand-off cut off between an outcome committing and its hand-off — a `session_reply` among
 *      them, which answers its caller as soon as REPLIED commits (`handOffQuietly`);
 *   3. says every outcome that was held for a next turn that will not come
 *      (`SessionRequestService.tellStoppedAsker`): migration 0352's trigger marks them when the asker
 *      stops — the auto-retry it waited on was given up, or it ended — in the statement that stopped
 *      it, whichever code path wrote it, and this is where the mark is answered. Where it goes is
 *      decided by where the asker stands now (§8 criterion 21): ended → §4.3's comment on its task;
 *      merely idle → §4.2's reply turn.
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
    @Optional() private readonly push?: PushService,
    @Optional() private readonly realtime?: RealtimeService,
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

  /** One pass: close settled questions, expire, hand back MESSAGE outcomes, then ring fallbacks. */
  async drain(now: Date = new Date()): Promise<{
    expired: string[];
    handedOff: string[];
    commented: string[];
    handedBack: string[];
  }> {
    // R11 runs before expiry: an approval that already has an answer is never a fallback alert.
    await this.prisma.$executeRaw`
      UPDATE session_request r SET
        state = CASE WHEN a.decided_by_id IS NOT NULL THEN 'OWNER_ANSWERED' ELSE 'UNDELIVERED' END,
        close_reason = CASE WHEN a.decided_by_id IS NOT NULL THEN NULL ELSE 'QUESTION_ABANDONED' END,
        closed_at = ${now}
      FROM approval a
      WHERE r.id IN (
        SELECT q.id FROM session_request q JOIN approval p ON p.id = q.approval_id
        WHERE q.kind = 'RUN_QUESTION' AND q.state = 'OPEN' AND p.status <> 'PENDING'
        ORDER BY q.created_at, q.id LIMIT ${this.batch}
      ) AND r.kind = 'RUN_QUESTION' AND r.state = 'OPEN'
        AND a.id = r.approval_id AND a.status <> 'PENDING'
    `;
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
      where: { kind: 'MESSAGE', state: { not: 'OPEN' }, replyClientTurnId: null, replyHeldAt: null },
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
    const commented: string[] = [];
    const handedBack: string[] = [];
    const unsaid = await this.prisma.sessionRequest.findMany({
      where: { kind: 'MESSAGE', replyCommentDueAt: { not: null }, replyClientTurnId: null },
      orderBy: [{ replyCommentDueAt: 'asc' }, { id: 'asc' }],
      take: this.batch,
      select: { id: true },
    });
    for (const request of unsaid) {
      try {
        // Where it goes depends on where the asker stands now (§8 criterion 21): ended → §4.3's
        // comment on its task; merely idle → §4.2's reply turn, released from the hold the retry
        // left it under. Which of the two the mark was set for is not what decides it.
        const where = await this.requests.tellStoppedAsker(request.id);
        if (where === 'COMMENTED') commented.push(request.id);
        if (where === 'HANDED_BACK') handedBack.push(request.id);
      } catch (error) {
        this.log.error(`session request ${request.id} was not said on its asker's task: ${messageOf(error)}`);
      }
    }
    await this.ringFallbacks(now);
    return { expired, handedOff, commented, handedBack };
  }

  /** R10/M6: the existing pass claims each terminal fallback once across replicas. */
  private async ringFallbacks(now: Date): Promise<void> {
    if (!this.push || !this.realtime) return;
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; kind: string; owner_id: string; from_session_id: string;
      approval_id: string | null; request_preview: string; state: string;
    }>>`
      UPDATE session_request r SET owner_alerted_at = ${now}
      WHERE r.id IN (
        SELECT q.id FROM session_request q
        WHERE q.kind IN ('RUN_QUESTION', 'RUN_NOTIFY') AND q.owner_alerted_at IS NULL
          AND q.state IN ('NO_REPLY', 'RECIPIENT_ENDED', 'EXPIRED', 'UNDELIVERED')
          AND (q.kind = 'RUN_NOTIFY' OR EXISTS (
            SELECT 1 FROM approval a WHERE a.id = q.approval_id AND a.status = 'PENDING'
          ))
        ORDER BY q.closed_at, q.id LIMIT ${this.batch}
      ) AND r.owner_alerted_at IS NULL
        AND (r.kind = 'RUN_NOTIFY' OR EXISTS (
          SELECT 1 FROM approval a WHERE a.id = r.approval_id AND a.status = 'PENDING'
        ))
      RETURNING r.id, r.kind, r.owner_id, r.from_session_id, r.approval_id, r.request_preview, r.state
    `;
    for (const row of rows) {
      try {
        if (row.kind === 'RUN_QUESTION') {
          const reason = row.state === 'EXPIRED' ? 'TIMED_OUT'
            : row.state === 'RECIPIENT_ENDED' ? 'REVIEWER_ENDED' : 'REVIEWER_STOPPED';
          await this.prisma.approval.updateMany({
            where: { id: row.approval_id!, status: 'PENDING' }, data: { coordinatorFallback: reason },
          });
          const approval = await this.prisma.approval.findFirst({ where: { id: row.approval_id!, status: 'PENDING' } });
          if (!approval) continue;
          this.realtime.publish(row.from_session_id, approvalRequestEvent(approval, now.toISOString()));
          await this.push.notifyApprovalRequest(row.from_session_id, approval.id, approval.toolName, true);
        } else {
          await this.push.notifyAgentMessage({
            ownerId: row.owner_id, sessionId: row.from_session_id, fallbackTitle: 'Orbit',
            message: `Not reviewed by the coordinator · ${row.request_preview}`,
          }, true);
        }
      } catch (error) {
        this.log.error(`session request ${row.id} fallback alert failed: ${messageOf(error)}`);
      }
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
