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

/**
 * The apiserver's switch for offering the new runner protocol (SESSION_RELEASE_V1): `ORBIT_SESSION_RELEASE_V1=on`. Off
 * unless set. While it is on, every heartbeat answer says `sessionReleaseV1: true`, and a runner declares the protocol
 * only on the strength of that word (runner-go session_release.go). The server serves a runner that declares it either
 * way, switch or no switch: the switch decides only whether runners are told to.
 *
 * Why a switch and not the release itself: a replica cannot know what the other replicas run. During a hand-over from a
 * server without SESSION_RELEASE_V1, that older replica's reaper would release a held failed turn as a stop, and its
 * finalize would read the hold as CANCELLED, losing the failure and its retry. So it is the operator who says the fleet
 * is safe. Turn it on only once every replica runs a release that serves the protocol, and turn it off before rolling
 * back past one (docs/session-three-state-plan.md step 6.2).
 */
export const SESSION_RELEASE_SWITCH = 'ORBIT_SESSION_RELEASE_V1';

export function sessionReleaseOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SESSION_RELEASE_SWITCH]?.trim().toLowerCase() === 'on';
}

/**
 * Whether a runner report declares SESSION_RELEASE_V1: in X-Orbit-Runner-Capabilities over HTTPS, or in the body's
 * `releaseProtocol`, which is how a runner on the runner link declares it per request (the link forwards only the
 * capabilities its Hello declared, and carries no request header of its own).
 */
export function declaresSessionRelease(
  declaredInHeader: boolean,
  body: { releaseProtocol?: unknown } | null | undefined,
  token: string,
): boolean {
  return declaredInHeader || body?.releaseProtocol === token;
}
