import type { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { orderedIds } from '../common/lock-order';
import type { PushService } from '../push/push.service';
import { BACKGROUND_WAKE_TURN_PREFIX } from './background-job-wake';
import { TICK_SESSION, tickStanding } from './scheduled-wakeup';

/** What took a queued `bg-wake:` turn off its session's queue before any runner took it. */
export type UnrunWakeTurn =
  /** The owner withdrew this one queued turn (`SessionsService.cancelQueuedTurn`). */
  | { turnId: string }
  /** The owner interrupted the session, and the interrupt deleted everything queued behind the
   *  turn it stops — however many wake turns that is (`SessionsService.interrupt`). */
  | { interrupted: true }
  /** CURRENT_WORK wake steers that same Stop overtook after a runner had taken them, before the
   *  engine read them, written off by the completion that learned it (runnerApi.turnComplete). */
  | { steerTurnIds: readonly string[] }
  /** The session's run ended, and every turn still queued is answered without being run: the reaper
   *  finalizing a stalled run (`ReaperService.forceFinalize`), a failed turn that fails its session and
   *  the runner's finalize (runnerApi.turnComplete and finalize), an end its owner asked for
   *  (`SessionsService.transitionEnd`). */
  | { drained: true };

/** A one-shot wakeup a drain dropped because its session had FAILED with no retry armed. Its owner is
 *  told after the commit (`signalDrainedWakeups`). */
export interface DrainedWakeupDrop {
  ownerId: string;
  sessionId: string;
  title: string | null;
  wakeupId: string;
}

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
 * Two doors delete such a turn from a session that lives on, and four more answer it unrun as its
 * session's run ends. A withdrawal takes the one turn its owner named; an interrupt means stop, so it
 * deletes every follow-up queued behind the turn it aborts, wake turns among them; a drain answers
 * every turn still queued when the run ends, so that nothing can be leased after it (the reaper's
 * finalize, a turn that fails its session, the runner's finalize, an end the owner asked for). Which
 * turns are unrun is the only difference among them here, never what being unrun leaves behind —
 * except what a drain settles a wakeup to (below).
 *
 * Deleting or answering the turn alone leaves its whole payload behind, and neither table is harmless
 * there:
 *
 *   * A DELIVERED wakeup would point at a turn that no longer exists, or that was answered without
 *     ever being handed to an engine. The worker only ever scans `state = 'PENDING'`, so it is never
 *     filed again, and `appendScheduledWakeupContext` reads it only at that turn's claim, which never
 *     comes. The wakeup the agent asked for would simply be gone, with nothing anywhere saying it was
 *     dropped — and a loop's tick would go on counting as a run it never was.
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
 * A DRAIN is the case where nobody called the wakeup off: the run it was to wake ended under it — its
 * runner died, its turn failed, it finished, its owner ended it — while its turn was still queued. So
 * it is settled the way the worker settles a wakeup that comes due on a session standing as this one
 * now stands (scheduled-wakeup.ts `tickStanding`, read off the row the caller has just written), and
 * not as called off:
 *
 *   * A loop's tick is DROPPED: its due time passed without a run (docs/long-running-loop-contract.md
 *     §1.2). The loop goes on with the tick it has waiting.
 *   * A one-shot wakeup on a session FAILED with its auto-retry armed goes back to waiting: the session
 *     is on its way back, and the worker holds a waiting wakeup of such a session until it is live
 *     again (HELD, contract §1.6), then files it. The objection above to PENDING does not hold here:
 *     the worker's next pass does not re-file it while the retry is armed, and once the session is back
 *     the delivery it gets is the one the drain took away. It waits as a copy of itself — its reason,
 *     prompt, delay, due time and the time it was asked for — and the row filed onto the drained turn
 *     is SUPERSEDED by that copy. The row itself cannot wait again: the worker files a wakeup under the
 *     turn key `bg-wake:wakeup:<its id>`, which the drained turn holds for good (one turn per key and
 *     session), so createTurn would answer every later filing with that answered turn, as a replay, and
 *     the wakeup would stay PENDING with every pass "delivering" it and none doing so. Unless the
 *     session has asked for a newer one since, already waiting: a newer request replaces a waiting one,
 *     so the drained ones are SUPERSEDED by it and no copy is made. Of several one-shot wakeups the same
 *     drain finds, only the newest is copied, for the same reason.
 *   * A one-shot wakeup on a session FAILED with no retry armed is DROPPED, and its owner is told after
 *     the commit (`signalDrainedWakeups`), as the worker tells a wakeup it drops with a FAILED session
 *     (contract §4).
 *   * A one-shot wakeup on a session that ended, or is ending, is DROPPED and nobody is told: that end
 *     was somebody's doing, as for the worker's own drop. A drain leaves no session live.
 *
 * WHAT A LOOP COUNTS
 * ==================
 * However the turn went, a tick filed onto it did not become a run of its own, so its loop stops
 * counting it as one (`uncountUnrunTicks`): `ticks_fired` and `ticks_missed` say what ran (§1.2), and
 * session_get reads them (§3). The `<scheduled-wakeup>` block of the loop's next run already counts it
 * missed, since it reads only DELIVERED ticks for the last run.
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
 * that transaction already holds, and before the delete or the answer — the read has to see them while
 * they are still PENDING, which is also why it reaches only turns that statement really takes: an
 * interrupt retires a CURRENT_WORK steer's target in place instead, and such a target is the IN_FLIGHT
 * turn the steer was to be written into, never a queued wake; a drain answers the turns already handed
 * to the engine too, and those ran, so their wakeups stay DELIVERED. A request refused after this point
 * rolls it back along with everything else.
 *
 * A wake steer a runner had already taken is the one reached afterwards and by name: it was no longer
 * queued when the Stop came, and it is settled once the completion that writes it off undelivered
 * knows the engine never read it. It is the same wake, so it is settled the same way.
 *
 * Returns the one-shot wakeups a drain dropped with a FAILED session, for the caller to tell their
 * owners once its transaction has committed; nothing for any other door.
 */
export async function settleUnrunWakeTurns(
  tx: Prisma.TransactionClient,
  sessionId: string,
  unrun: UnrunWakeTurn,
): Promise<DrainedWakeupDrop[]> {
  const queued = await tx.conversationTurn.findMany({
    where: {
      sessionId,
      ...('turnId' in unrun ? { id: unrun.turnId } : {}),
      ...('steerTurnIds' in unrun ? { id: { in: [...unrun.steerTurnIds] } } : { status: 'PENDING' }),
      clientTurnId: { startsWith: BACKGROUND_WAKE_TURN_PREFIX },
    },
    select: { clientTurnId: true },
  });
  if (queued.length === 0) return [];
  const clientTurnId = { in: queued.map((turn) => turn.clientTurnId) };
  await tx.backgroundJobWake.deleteMany({ where: { sessionId, clientTurnId } });
  const filed = await tx.sessionScheduledWakeup.findMany({
    where: { sessionId, clientTurnId, state: 'DELIVERED' },
    select: {
      id: true, loopId: true, clientTurnId: true, createdAt: true, delaySeconds: true, reason: true, prompt: true, dueAt: true,
    },
  });
  if (filed.length === 0) return [];
  await uncountUnrunTicks(tx, filed);
  const settledAt = new Date();
  if (!('drained' in unrun)) {
    await tx.sessionScheduledWakeup.updateMany({
      where: { sessionId, clientTurnId, state: 'DELIVERED' },
      data: { state: 'CANCELLED', settledAt },
    });
    return [];
  }
  const ticks = filed.filter((wakeup) => wakeup.loopId != null).map((wakeup) => wakeup.id);
  if (ticks.length > 0) {
    await tx.sessionScheduledWakeup.updateMany({
      where: { id: { in: ticks }, state: 'DELIVERED' },
      data: { state: 'DROPPED', settledAt },
    });
  }
  const once = filed.filter((wakeup) => wakeup.loopId == null);
  if (once.length === 0) return [];
  const session = await tx.session.findUniqueOrThrow({
    where: { id: sessionId },
    select: { ...TICK_SESSION, title: true },
  });
  const standing = tickStanding(session, settledAt);
  if (standing === 'FAILED_RECOVERING') {
    // Every one-shot wakeup on the drained turns is replaced: by the newer one the session already has
    // waiting, or else by a copy of the newest of them, waiting as it did before it was filed.
    await tx.sessionScheduledWakeup.updateMany({
      where: { id: { in: once.map((wakeup) => wakeup.id) }, state: 'DELIVERED' },
      data: { state: 'SUPERSEDED', settledAt },
    });
    const waiting = await tx.sessionScheduledWakeup.findFirst({
      where: { sessionId, loopId: null, state: 'PENDING' },
      select: { id: true },
    });
    if (!waiting) {
      // The newest request: when more than one was filed onto the drained turns, the one a later
      // request replaces the others with.
      const [newest] = [...once].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
      await tx.sessionScheduledWakeup.create({
        data: {
          sessionId,
          delaySeconds: newest.delaySeconds,
          reason: newest.reason,
          prompt: newest.prompt,
          dueAt: newest.dueAt,
          createdAt: newest.createdAt,
        },
      });
    }
    return [];
  }
  await tx.sessionScheduledWakeup.updateMany({
    where: { id: { in: once.map((wakeup) => wakeup.id) }, state: 'DELIVERED' },
    data: { state: 'DROPPED', settledAt },
  });
  if (standing !== 'FAILED') return [];
  return once.map((wakeup) => ({ ownerId: session.ownerId, sessionId, title: session.title, wakeupId: wakeup.id }));
}

/**
 * Take the ticks filed onto turns that never ran out of their loops' runs. A loop counted one tick
 * fired for each turn its ticks were filed onto — the first to reach it; every later tick that joined
 * it was counted missed then (`settleLoopTick`'s `absorbed`) — so each such turn moves one tick of its
 * loop from `ticks_fired` to `ticks_missed`, however many of the loop's ticks it carries. Every loop
 * row before any tick row is written, sorted by id: the order every writer of a loop and its ticks takes
 * them in (`settleLoopTick`, `endWakeupLoop`), under the session row its caller holds.
 */
async function uncountUnrunTicks(
  tx: Prisma.TransactionClient,
  filed: ReadonlyArray<{ loopId: string | null; clientTurnId: string | null }>,
): Promise<void> {
  const turnsOfLoop = new Map<string, Set<string | null>>();
  for (const wakeup of filed) {
    if (!wakeup.loopId) continue;
    turnsOfLoop.set(wakeup.loopId, (turnsOfLoop.get(wakeup.loopId) ?? new Set()).add(wakeup.clientTurnId));
  }
  for (const loopId of orderedIds([...turnsOfLoop.keys()])) {
    const runs = turnsOfLoop.get(loopId)!.size;
    await tx.sessionWakeupLoop.updateMany({
      where: { id: loopId },
      data: { ticksFired: { decrement: runs }, ticksMissed: { increment: runs } },
    });
  }
}

/**
 * Tell the owners of the one-shot wakeups a drain dropped with their FAILED session (contract §4) —
 * after the drain's transaction has committed, once per wakeup, because only the commit that dropped
 * it returns it. Never throws: the wakeup is dropped either way, so a failure is only logged.
 */
export function signalDrainedWakeups(
  push: Pick<PushService, 'notifyLoopMissed'> | undefined,
  log: Pick<Logger, 'error'>,
  dropped: readonly DrainedWakeupDrop[],
): void {
  for (const wakeup of dropped) {
    const failed = (error: unknown) =>
      log.error(
        `the owner of session ${wakeup.sessionId} was not told its wakeup ${wakeup.wakeupId} was dropped: `
          + (error instanceof Error ? error.message : String(error)),
      );
    try {
      push
        ?.notifyLoopMissed({
          ownerId: wakeup.ownerId,
          sessionId: wakeup.sessionId,
          title: wakeup.title,
          missed: { wakeupId: wakeup.wakeupId },
          reason: 'SESSION_FAILED',
        })
        .catch(failed);
    } catch (error) {
      failed(error);
    }
  }
}
