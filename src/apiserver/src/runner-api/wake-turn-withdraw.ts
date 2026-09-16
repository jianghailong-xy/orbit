import type { Prisma } from '@prisma/client';

import { BACKGROUND_WAKE_TURN_PREFIX } from './background-job-wake';

/**
 * A control-plane wake turn withdrawn from its session's queue before any runner took it — the
 * `bg-wake:` half of what `watches/watch-wake-drain.ts` does for a Watch's wake.
 *
 * A `bg-wake:` turn carries nobody's words. What it delivers is kept beside it and written in only
 * at the claim: the background jobs that asked to wake the session (`background_job_wake`, read by
 * `appendBackgroundWakeContext`) and the wakeups it asked the control plane to hold, which are
 * already settled DELIVERED against this turn's `client_turn_id` (`session_scheduled_wakeup`, read
 * by `appendScheduledWakeupContext`). One turn can hold both: a wakeup that comes due while a job's
 * wake turn is still queued joins that turn rather than opening its own.
 *
 * So deleting the turn alone leaves its whole payload behind, and neither table is harmless there:
 *
 *   * A DELIVERED wakeup would point at a turn that no longer exists. The worker only ever scans
 *     `state = 'PENDING'`, so it is never filed again, and `appendScheduledWakeupContext` reads by
 *     `clientTurnId` + DELIVERED, so it is never delivered either. The wakeup the agent asked for
 *     would simply be gone, with nothing anywhere saying it was dropped.
 *   * A job's wake row would outlive the turn under a key the next wake reuses. `background_job_wake`
 *     is unique on `(session_id, client_turn_id, job_id)` and a job's wake turn is keyed by the job:
 *     `bg-wake:<jobId>:exit` is the same string the next one computes, so `fileBackgroundJobWake`
 *     would find the withdrawn row, update it, and deliver a wake the owner had explicitly taken
 *     back alongside the new one.
 *
 * WHAT EACH IS SETTLED TO
 * =======================
 * The wakeup is CANCELLED, the terminal state a `schedule_wakeup({stop: true})` writes — the wakeup
 * was called off before it woke anybody, and the only difference is who called it off. Returning it
 * to PENDING would not be waiting for the next time it comes due, because there is no next time: a
 * wakeup is one absolute moment, its `due_at` is already past (that is why it was delivered), so the
 * next pass five seconds later would re-file the identical turn and the withdrawal would undo itself.
 * It would also collide with `session_scheduled_wakeup_one_pending_key` the moment the session has
 * since asked for another. `client_turn_id` is deliberately left on the row: an agent's own stop only
 * ever reaches a PENDING row, which has no turn yet, so CANCELLED WITH a `client_turn_id` says
 * precisely — and says only — that this wakeup had been filed onto a turn somebody then withdrew.
 *
 * The job's wakes are deleted with the turn rather than answered in place, which is the one way this
 * departs from the Watch half, because the two rows are not the same kind of thing. A `watch_delivery`
 * is the WATCH's own record of whether its wake reached the observer, and the watch is read through
 * it, so it has to be answered (DEAD_LETTER) instead of erased. A `background_job_wake` row is only
 * this turn's payload — nothing else in the system reads it — and the job itself stands where it
 * always did, in the runner's job store that `bg_output` and `bg_list` read. Keeping it would mean a
 * state column, a filter in the append and another in the file, three pieces of machinery to preserve
 * something no one reads and whose only effect is the resurrection above.
 *
 * Called from inside the transaction that takes the turn off the queue, under the Session row lock
 * that transaction already holds, and before the delete — the read has to see the turn while it is
 * still PENDING. A withdrawal refused after this point rolls it back along with everything else.
 */
export async function settleWithdrawnWakeTurn(
  tx: Prisma.TransactionClient,
  sessionId: string,
  turnId: string,
): Promise<void> {
  const turn = await tx.conversationTurn.findFirst({
    where: {
      id: turnId,
      sessionId,
      status: 'PENDING',
      clientTurnId: { startsWith: BACKGROUND_WAKE_TURN_PREFIX },
    },
    select: { clientTurnId: true },
  });
  if (!turn) return;
  const { clientTurnId } = turn;
  await tx.backgroundJobWake.deleteMany({ where: { sessionId, clientTurnId } });
  await tx.sessionScheduledWakeup.updateMany({
    where: { sessionId, clientTurnId, state: 'DELIVERED' },
    data: { state: 'CANCELLED', settledAt: new Date() },
  });
}
