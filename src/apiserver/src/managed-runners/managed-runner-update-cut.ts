import { RUNNER_RESTART_INTERRUPT_REASON, RUNNER_UPDATE_INTERRUPT_REASON, RunEventType, type NormalizedRunEvent } from '@orbit/shared';
import type { ManagedRunner, Prisma } from '@prisma/client';

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
