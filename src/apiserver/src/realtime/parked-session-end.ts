import { Prisma, TaskStatus } from '@prisma/client';
import { RunStatus, SessionEndReason, SessionLifecycleState } from '@orbit/shared';
import { randomUUID } from 'crypto';

import { loggedRetry, withTransactionRetry, type RetryLogger } from '../common/transaction-retry';
import type { PrismaService } from '../prisma/prisma.service';
import { hasPendingWakeSource } from '../sessions/session-request';
import { turnStateFilter } from '../sessions/session-turn-state';
import type { RealtimeService } from './realtime.service';

/**
 * Ending a parked session because its task is over: the one write both of its callers make.
 *
 *   * The reaper (`ReaperService.endParked`) finds an idle session whose task is DONE or CANCELLED on
 *     its sweep, every REAP_INTERVAL_MS. That is the backstop.
 *   * The DONE (`endIdleWorkOfDoneTask`, §12.15 P-M1): the completion edge every DONE door runs once
 *     its transaction has committed asks for the end of the task's idle work sessions at once. A DONE
 *     over an open work session decides its landing, and releases its dependents, at that session's
 *     finish (O-L4 3); so the finish is requested by the DONE, not left to a sweep.
 *
 * The end is a request: `cancel_requested_at` and the end reason on the row, and an `end` turn the
 * runner drains. The runner's finalize writes `finished_at`, and that finish freezes the delivered
 * identity and dispatches the dependents (`settleDeliveredIdentityAfterFinish`).
 */

/**
 * The claim, in the caller's transaction: still parked, no end requested yet, and its task still in
 * the state the end is named for. A stale reader must never turn a cancelled task into task_done, and
 * Trash stays authoritative over Completed. Then the `end` turn, so a seq conflict rolls both back.
 * False when the row no longer matches; nothing is written then.
 */
export async function claimParkedSessionEnd(
  tx: Prisma.TransactionClient,
  sessionId: string,
  reason: SessionEndReason,
): Promise<boolean> {
  const taskStatus = reason === SessionEndReason.TASK_DONE ? TaskStatus.DONE : TaskStatus.CANCELLED;
  const now = new Date();
  const claimed = await tx.session.updateMany({
    where: {
      id: sessionId,
      // Parked: held, with no turn queued, in flight or abandoned.
      ...turnStateFilter([null]),
      cancelRequestedAt: null,
      task: { status: taskStatus },
      ...(reason === SessionEndReason.TASK_DONE ? { deletedAt: null } : {}),
    },
    data: {
      cancelRequestedAt: now,
      endReason: reason,
      ...(reason === SessionEndReason.TASK_DONE ? { completedAt: now, archivedAt: now } : {}),
    },
  });
  if (claimed.count === 0) return false;
  const last = await tx.conversationTurn.findFirst({
    where: { sessionId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  await tx.conversationTurn.create({
    data: {
      sessionId,
      seq: (last?.seq ?? 0) + 1,
      clientTurnId: randomUUID(),
      kind: 'end',
      status: 'PENDING',
    },
  });
  return true;
}

/**
 * R2 (§12.5 W6, W7): whether this idle work session of a DONE task is one its task's failed landing revived — an OPEN
 * item still in its hands — that something will still wake (`hasPendingWakeSource`: a background job it started, a
 * wakeup it set, a watch, an armed retry). W7 decides the landing at this session's finish, so ending it now would
 * freeze its branch before its fix is on it, and stop the job it is waiting on. The DONE's own request
 * (`endIdleWorkOfDoneTask`) leaves every session with a wake source alone already; the reaper asks this.
 */
export async function fixingLandingWithWakeSource(tx: Prisma.TransactionClient, sessionId: string): Promise<boolean> {
  const session = await tx.session.findUnique({
    where: { id: sessionId },
    select: { id: true, runningBgJobs: true, retryAt: true, task: { select: { projectId: true } } },
  });
  if (!session?.task?.projectId) return false;
  // By the project's OPEN items, as `project_open_item_project_state_idx` reads them.
  const fixing = await tx.projectOpenItem.findFirst({
    where: {
      projectId: session.task.projectId, state: 'OPEN', workSessionId: sessionId,
      workSessionOfferedAt: { not: null }, workSessionReturnedAt: null,
    },
    select: { id: true },
  });
  return fixing !== null && (await hasPendingWakeSource(tx, session));
}

/**
 * After the claim has committed: the clients see it filed, and the session's inbox is poked. The caller that
 * committed the claim marks its runner changed itself (`requestCancel`), which is what delivers the end to a link
 * heartbeat; link-heartbeat.ts names each such caller as a writer of `cancelSessionIds`.
 */
export function announceParkedSessionEnd(
  realtime: RealtimeService,
  ended: { sessionId: string; reason: SessionEndReason },
): void {
  if (ended.reason === SessionEndReason.TASK_DONE) {
    realtime.publishSessionLifecycleChanged(
      ended.sessionId,
      RunStatus.AWAITING_INPUT,
      ended.reason,
      SessionLifecycleState.COMPLETED,
    );
  }
  realtime.notifyInbox(ended.sessionId);
}

/**
 * §12.15 P-M1: the DONE requests the end of its task's idle work sessions. A session that still has
 * something to do — a queued or running turn, a request addressed to it that is still open, or a
 * wake source (`hasPendingWakeSource`: a running background job, an armed retry, a scheduled wakeup,
 * a watch, a request of its own) — is left to the reaper, as before. So is a session still in a turn
 * when the DONE is written; its park asks again (runner-api `turnComplete`).
 *
 * One transaction per session. The checks are plain reads ahead of the claim, and the claim is its
 * first lock (the session row, rank 30, as the reaper takes it): anything that gives a parked session
 * something to do — a message, a request, a resumed wakeup — queues a turn, so the row is no longer
 * parked, under that same lock, which the claim's own re-check reads. Best effort: a failure is
 * logged, and the reaper ends the session on its next sweep. Returns the ids it ended.
 */
export async function endIdleWorkOfDoneTask(
  prisma: PrismaService,
  realtime: RealtimeService,
  logger: RetryLogger,
  input: { ownerId: string; taskId: string },
): Promise<string[]> {
  const candidates = await prisma.session.findMany({
    where: {
      ownerId: input.ownerId,
      taskId: input.taskId,
      startsTaskWork: true,
      ...turnStateFilter([null]),
      cancelRequestedAt: null,
      deletedAt: null,
      task: { status: TaskStatus.DONE },
    },
    select: { id: true, assignedRunnerId: true },
  });
  const ended: string[] = [];
  for (const candidate of candidates) {
    try {
      const claimed = await withTransactionRetry(prisma, async (tx) => {
        const row = await tx.session.findUnique({
          where: { id: candidate.id },
          select: { id: true, runningBgJobs: true, retryAt: true, engineTurnActive: true },
        });
        if (!row || row.engineTurnActive) return false;
        const queued = await tx.conversationTurn.findFirst({
          where: { sessionId: candidate.id, status: { in: ['PENDING', 'IN_FLIGHT'] } },
          select: { id: true },
        });
        if (queued) return false;
        const asked = await tx.sessionRequest.findFirst({
          where: { toSessionId: candidate.id, state: 'OPEN' },
          select: { id: true },
        });
        if (asked || (await hasPendingWakeSource(tx, row))) return false;
        return claimParkedSessionEnd(tx, candidate.id, SessionEndReason.TASK_DONE);
      }, loggedRetry(logger, 'parkedSessionEnd.endIdleWorkOfDoneTask'));
      if (!claimed) continue;
      if (candidate.assignedRunnerId) realtime.requestCancel(candidate.assignedRunnerId, candidate.id);
      announceParkedSessionEnd(realtime, { sessionId: candidate.id, reason: SessionEndReason.TASK_DONE });
      ended.push(candidate.id);
    } catch (error) {
      logger.warn(`the end of session ${candidate.id} was not requested on its task's DONE; the reaper ends it: ${
        error instanceof Error ? error.message : error}`);
    }
  }
  return ended;
}
