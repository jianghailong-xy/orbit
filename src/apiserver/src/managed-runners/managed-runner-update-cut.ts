import { RUNNER_RESTART_INTERRUPT_REASON, RUNNER_UPDATE_INTERRUPT_REASON, RunEventType, type NormalizedRunEvent } from '@orbit/shared';
import type { ManagedRunner, Prisma } from '@prisma/client';

import { buildUpdateResumeContinuation } from '../runner-api/resume-continuation';
import { ownerUpdatePending } from './managed-runner-status';

/**
 * A turn the owner's Update Now cut on a busy Orbit Cloud runner (docs/managed-runner-update-now-design.md, "Busy
 * runner"). The manager asks the backend to stop the container (ManagedRunnerManager.stopForOwnerUpdate): Docker sends
 * SIGTERM, and the runner's ordinary stop cuts each turn still in flight once its drain runs out, marking the cut
 * `interrupt {reason: runner_restart}` — the only stop a runner image of any age knows, and the image is not changed for
 * this. The cut is the update's, as the owner was told when they confirmed it, so it is stored as the update's own
 * (`runner_update`, as a self-managed runner marks the cuts of its Update Now), with the runner's reason kept beside it
 * (`reportedReason`). Every reader of the cut then reads it as the update's: the next generation is handed the turn
 * back as the update's continuation, which opens with RUNNER_UPDATE_RESUME_NOTE (dequeueTurn, and the auto-retry after a
 * reap), and every client draws "interrupted — the runner updated".
 */

/** What of a runner's mapping says whether a stop of its runner was the owner's Update Now. */
export type UpdateNowWindow = Pick<ManagedRunner, 'updateRequestedAt' | 'updateCompletedAt' | 'updateInterruptTurns'>;

/**
 * Whether a cut the runner stamped `at` was the owner's Update Now's: the mapping recorded a request that may interrupt
 * its turns, the cut comes at or after it, and — once the next generation has ended the update — before that end, so
 * that a cut re-sent from the old process's spool after the next generation is READY still counts.
 */
export function cutByUpdateNow(window: UpdateNowWindow | null, at: Date): boolean {
  if (!window?.updateInterruptTurns || !window.updateRequestedAt) return false;
  if (at.getTime() < window.updateRequestedAt.getTime()) return false;
  return ownerUpdatePending(window) || at.getTime() <= window.updateCompletedAt!.getTime();
}

/**
 * The run events of one ingested batch of `runnerId`'s, each cut the owner's Update Now made marked as the update's in
 * place, before they are stored (RunnerApiController.ingestSteps). Reads the runner's mapping only when the batch holds a
 * cut a runner's own stop marked, by its unique runner key and with no lock; writes nothing. An event without a time the
 * runner stamped is read at `now`.
 */
export async function markUpdateNowCuts(
  tx: Pick<Prisma.TransactionClient, 'managedRunner'>,
  runnerId: string,
  events: NormalizedRunEvent[],
  now: Date,
): Promise<void> {
  const cuts = events.filter((event) => event.type === RunEventType.INTERRUPT && event.payload?.reason === RUNNER_RESTART_INTERRUPT_REASON);
  if (cuts.length === 0) return;
  const window = await tx.managedRunner.findUnique({
    where: { runnerId },
    select: { updateRequestedAt: true, updateCompletedAt: true, updateInterruptTurns: true },
  });
  for (const event of cuts) {
    const stamped = Date.parse(event.ts);
    if (!cutByUpdateNow(window, Number.isNaN(stamped) ? now : new Date(stamped))) continue;
    event.payload = { ...event.payload, reason: RUNNER_UPDATE_INTERRUPT_REASON, reportedReason: RUNNER_RESTART_INTERRUPT_REASON };
  }
}

/**
 * The key of the continuation the server queues for a turn its runner ended INTERRUPTED at the owner's Update Now's
 * stop (`queueUpdateNowContinuation`), one per turn: Orbit's own words (sessions/orbit-authored-turn.ts).
 */
export const UPDATE_NOW_CONTINUATION_TURN_PREFIX = 'update-now-continue:v1:';

/**
 * The design's fallback (docs/managed-runner-update-now-design.md, "Busy runner"): the server re-queues a turn the
 * owner's Update Now stopped when its runner did not keep it for the next generation. A runner of any age cuts a turn
 * on a stop by marking it `interrupt {reason: runner_restart}` and leaving it in flight — except the DeepSeek Harness
 * engine before 2026-11-23, which cancelled its turn at the SIGTERM and reported it INTERRUPTED like a person's Stop.
 * Production's dsh turn ended that way never continued. So a message turn reported INTERRUPTED by the runner of a
 * mapping whose owner's interrupting Update Now is in progress and has asked its instance to stop
 * (`stopRequestedAt`, ManagedRunnerManager.stopForOwnerUpdate), with no Stop of the session's own after it and no
 * runner cut of its own (which the reclaim hands back), is followed in the completion's transaction by one queued
 * message: the update's continuation, as the reclaim would have handed it back (dequeueTurn, D4). The completion then
 * keeps the session RUNNING for it, and the next generation is handed it. Idempotent by its key; returns whether it
 * queued one. Reads the mapping by its unique runner key and the turns of the session already locked.
 */
export async function queueUpdateNowContinuation(
  tx: Pick<Prisma.TransactionClient, 'managedRunner' | 'conversationTurn' | 'runEvent' | '$queryRaw'>,
  runnerId: string,
  sessionId: string,
  turn: { id: string; seq: number; kind: string; content: string | null },
  /** The runner reported the turn INTERRUPTED. */
  interrupted: boolean,
): Promise<boolean> {
  if (turn.kind !== 'message' || !interrupted) return false;
  const mapping = await tx.managedRunner.findUnique({
    where: { runnerId },
    select: { updateRequestedAt: true, updateCompletedAt: true, updateInterruptTurns: true, stopRequestedAt: true, currentImageSha: true },
  });
  if (!mapping?.updateInterruptTurns || !mapping.updateRequestedAt || !ownerUpdatePending(mapping)) return false;
  if (!mapping.stopRequestedAt || mapping.stopRequestedAt.getTime() < mapping.updateRequestedAt.getTime()) return false;
  // A person's (or an agent's) Stop of this turn is theirs, not the update's.
  const stopped = await tx.conversationTurn.findFirst({
    where: { sessionId, kind: 'interrupt', seq: { gt: turn.seq } },
    select: { id: true },
  });
  if (stopped) return false;
  // A runner that cut it as a stop keeps it for the next generation itself.
  const cut = await tx.runEvent.findFirst({
    where: {
      turnId: turn.id,
      type: RunEventType.INTERRUPT,
      OR: [RUNNER_RESTART_INTERRUPT_REASON, RUNNER_UPDATE_INTERRUPT_REASON].map((reason) => ({ payload: { path: ['reason'], equals: reason } })),
    },
    select: { id: true },
  });
  if (cut) return false;
  const clientTurnId = `${UPDATE_NOW_CONTINUATION_TURN_PREFIX}${turn.id}`;
  const queued = await tx.conversationTurn.findUnique({ where: { sessionId_clientTurnId: { sessionId, clientTurnId } }, select: { id: true } });
  if (queued) return false;
  const [last] = await tx.$queryRaw<Array<{ seq: number }>>`
    SELECT max("seq") AS "seq" FROM "conversation_turn" WHERE "session_id" = ${sessionId}::uuid
  `;
  const target = mapping.currentImageSha ? `managed-${mapping.currentImageSha.slice(0, 10)}` : null;
  await tx.conversationTurn.create({
    data: {
      sessionId,
      seq: Number(last?.seq ?? 0) + 1,
      clientTurnId,
      kind: 'message',
      content: buildUpdateResumeContinuation(turn.content, target),
      status: 'PENDING',
    },
  });
  return true;
}
