/**
 * What a release report of the new runner protocol is (SESSION_RELEASE_V1, docs/session-three-state-plan.md step 6.1,
 * design §3 and §12): the runner says only that its run is over; the server reads which kind of release it is from the
 * facts it holds on the locked session row. No cause is stored (decision D9): the reading decides the status the
 * release writes beside `finished_at`, and whether the turn it cuts off records an outcome.
 *
 *   FAILED_TURN     a failed turn this hold reported: `cancel_requested_at` set (the teardown signal that turn report
 *                   wrote), no end reason, and the last turn outcome FAILED. A revive clears the cancel, so the copy a
 *                   revived session keeps from the run before (design §12.2 R1) never reads as one.
 *   END_ASKED       an end somebody asked for: an end reason is recorded, or a cancel without a failed turn. It
 *                   settles as the old protocol's finalize settles a cancel (gracefulEndStatus, else CANCELLED);
 *                   `cutOffTurnOutcome` is ignored, because an end somebody asked for is a stop, not a failure (W7).
 *   FAILED_CUT_OFF  no end asked, and the runner says the run failed with no turn it could report (`cutOffTurnOutcome`):
 *                   the old finalize's FAILED with no end asked (design §12.1 W6).
 *   STOPPED         no end asked and no failure: CANCELLED, and the turn it cuts off ends CANCELLED (option A).
 */
export type ReleaseReading = 'FAILED_TURN' | 'END_ASKED' | 'FAILED_CUT_OFF' | 'STOPPED';

/** The columns readRelease reads. */
export interface ReleaseReportFacts {
  cancelRequestedAt: Date | null;
  endReason: string | null;
  lastTurnOutcome: string | null;
}

export function readRelease(current: ReleaseReportFacts, cutOffTurnOutcome: 'FAILED' | undefined): ReleaseReading {
  if (current.cancelRequestedAt && current.endReason == null && current.lastTurnOutcome === 'FAILED') return 'FAILED_TURN';
  if (current.endReason != null || current.cancelRequestedAt) return 'END_ASKED';
  return cutOffTurnOutcome === 'FAILED' ? 'FAILED_CUT_OFF' : 'STOPPED';
}
