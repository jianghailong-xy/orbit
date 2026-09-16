import type { Prisma } from '@prisma/client';

import { BACKGROUND_WAKE_TURN_PREFIX } from './background-job-wake';

/** What took a queued `bg-wake:` turn off its session's queue before any runner took it. */
export type UnrunWakeTurn =
  /** The owner withdrew this one queued turn (`SessionsService.cancelQueuedTurn`). */
  | { turnId: string }
  /** The owner interrupted the session, and the interrupt deleted everything queued behind the
   *  turn it stops — however many wake turns that is (`SessionsService.interrupt`). */
  | { interrupted: true };

/**
 * A control-plane wake turn taken off its session's queue before any runner took it — the `bg-wake:`
 * half of what `watches/watch-wake-drain.ts` does for a Watch's wake.
 *
 * A `bg-wake:` turn carries nobody's words. What it delivers is kept beside it and written in only
 * at the claim: the background jobs that asked to wake the session (`background_job_wake`, read by
 * `appendBackgroundWakeContext`) and the wakeups it asked the control plane to hold, which are
 * already settled DELIVERED against this turn's `client_turn_id` (`session_scheduled_wakeup`, read
 * by `appendScheduledWakeupContext`). One turn can hold both: a wakeup that comes due while a job's
 * wake turn is still queued joins that turn rather than opening its own.
 *
 * Two doors delete such a turn from a session that lives on. A withdrawal takes the one turn its owner
 * named; an interrupt means stop, so it deletes every follow-up queued behind the turn it aborts, wake
 * turns among them. That is the only difference between them here — which turns are unrun, never what
 * being unrun leaves behind — so both are settled by this one read.
 *
 * Deleting the turn alone leaves its whole payload behind, and neither table is harmless there:
 *
 *   * A DELIVERED wakeup would point at a turn that no longer exists. The worker only ever scans
 *     `state = 'PENDING'`, so it is never filed again, and `appendScheduledWakeupContext` reads by
 *     `clientTurnId` + DELIVERED, so it is never delivered either. The wakeup the agent asked for
 *     would simply be gone, with nothing anywhere saying it was dropped.
 *   * A job's wake row would outlive the turn under a key the next wake reuses. `background_job_wake`
 *     is unique on `(session_id, client_turn_id, job_id)` and a job's wake turn is keyed by the job:
 *     `bg-wake:<jobId>:exit` is the same string the next one computes, so `fileBackgroundJobWake`
 *     would find the row left behind, update it, and deliver a wake the owner had taken back, or
 *     stopped, alongside the new one.
 *
 * WHAT EACH IS SETTLED TO
 * =======================
 * The wakeup is CANCELLED, the terminal state a `schedule_wakeup({stop: true})` writes — the wakeup
 * was called off before it woke anybody, and the only difference is who called it off. Returning it
 * to PENDING would not be waiting for the next time it comes due, because there is no next time: a
 * wakeup is one absolute moment, its `due_at` is already past (that is why it was delivered), so the
 * next pass five seconds later would re-file the identical turn and the stop would undo itself. It
 * would also collide with `session_scheduled_wakeup_one_pending_key` the moment the session has since
 * asked for another. `client_turn_id` is deliberately left on the row: an agent's own stop only ever
 * reaches a PENDING row, which has no turn yet, so CANCELLED WITH a `client_turn_id` says precisely —
 * and says only — that this wakeup had been filed onto a turn somebody then took off the queue.
 *
 * An interrupt lands in that same CANCELLED for the same reason, and not because the withdrawal got
 * there first. The other two states one might reach for say something untrue of it: SUPERSEDED is a
 * later `schedule_wakeup` replacing the waiting one, and nothing replaced this; DROPPED is what the
 * worker writes for a session that had already ended, and an interrupted session has not ended — it
 * is stopped, and still there. What CANCELLED says — called off before it woke anybody — is exactly
 * what an interrupt did to it: the wake turn was deleted precisely so that it would not fire after
 * the turn being aborted, and a wakeup kept queued, or queued again, would start the session its
 * owner just stopped (the same sentence `watch-wake-drain.ts` settles a Watch's wake with).
 *
 * That the session lives on is the one thing an interrupt does not share with a withdrawal, and it
 * is what makes CANCELLED cost nothing: the agent is still there to ask for another wakeup, which is
 * what the `<scheduled-wakeup>` block tells it to do, so nothing here has to hold this one for it.
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
 * Called from inside the transaction that takes the turns off the queue, under the Session row lock
 * that transaction already holds, and before the delete — the read has to see them while they are
 * still PENDING, which is also why it reaches only turns that delete really takes: an interrupt
 * retires a CURRENT_WORK steer's target in place instead, and such a target is the IN_FLIGHT turn
 * the steer was to be written into, never a queued wake. A request refused after this point rolls
 * it back along with everything else.
 */
export async function settleUnrunWakeTurns(
  tx: Prisma.TransactionClient,
  sessionId: string,
  unrun: UnrunWakeTurn,
): Promise<void> {
  const queued = await tx.conversationTurn.findMany({
    where: {
      sessionId,
      ...('turnId' in unrun ? { id: unrun.turnId } : {}),
      status: 'PENDING',
      clientTurnId: { startsWith: BACKGROUND_WAKE_TURN_PREFIX },
    },
    select: { clientTurnId: true },
  });
  if (queued.length === 0) return;
  const clientTurnId = { in: queued.map((turn) => turn.clientTurnId) };
  await tx.backgroundJobWake.deleteMany({ where: { sessionId, clientTurnId } });
  await tx.sessionScheduledWakeup.updateMany({
    where: { sessionId, clientTurnId, state: 'DELIVERED' },
    data: { state: 'CANCELLED', settledAt: new Date() },
  });
}
