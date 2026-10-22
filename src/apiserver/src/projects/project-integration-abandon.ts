/**
 * The two doors that take work off the integration line without retrying it
 * (`docs/project-integration-line-contract.md` §2.2 J-T8 and J-T10, §4.7):
 *
 *  - **Abandon** ends a RUNNING job whose runner has stopped reporting, as `ERROR`, with J12's
 *    code for the kind of job and the claim it holds. It exists because a runner that crashed, was
 *    fenced, or belongs to a disabled account never comes back: only the same runner may take its
 *    claim over (§2.9 LS2), and such a runner is never woken, so the job holds its serial key for
 *    ever. It only ends — it never queues the next generation (§2.2 J-T10).
 *  - **Stop** is the owner asking a `LAND_TASK` to stop (§2.2 J-T8). A QUEUED row ends
 *    `CANCELLED` on the spot; a RUNNING row is asked, and its runner answers; one already silent
 *    past its limit ends `ERROR` with J12's code, because a request written onto it would never be
 *    collected. A row past the push boundary is refused: the merge may already have happened, and
 *    only a result can say so.
 *
 * This module is the part with no I/O: the refusal codes and the one length bound. The writes are
 * `runner-api/integration-job-relay.ts#abandonIntegrationJob` (through the result transaction) and
 * `projects/project-open-item.service.ts#stopTaskIntegrationAsOwner` (through
 * `project-integration-line.ts#stopInFlightJob`).
 */

/** The job is RUNNING, but its claim's lease has not expired: its runner is still working. 409. */
export const INTEGRATION_ABANDON_LEASE_LIVE = 'INTEGRATION_ABANDON_LEASE_LIVE';
/** The job is not RUNNING — queued, finished, or not this project's. 409. */
export const INTEGRATION_ABANDON_NOT_RUNNING = 'INTEGRATION_ABANDON_NOT_RUNNING';
/** Only the conversation the project is coordinated from may abandon through the runner door. 403. */
export const INTEGRATION_ABANDON_COORDINATOR_ONLY = 'INTEGRATION_ABANDON_COORDINATOR_ONLY';
/** The owner channel's door does not take an acting session: a session has its own door. 403. */
export const INTEGRATION_ABANDON_OWNER_CHANNEL_ONLY = 'INTEGRATION_ABANDON_OWNER_CHANNEL_ONLY';

/** The `LAND_TASK` has passed its push boundary, so the stop would claim a push may not have happened. 409. */
export const INTEGRATION_STOP_PUSHED = 'INTEGRATION_STOP_PUSHED';
/** This task has no queued or running `LAND_TASK` to stop. 409. */
export const INTEGRATION_STOP_NOT_APPLICABLE = 'INTEGRATION_STOP_NOT_APPLICABLE';
/** The stop door is the account owner's: a session has no way in (it reopens the task instead). 403. */
export const INTEGRATION_STOP_OWNER_CHANNEL_ONLY = 'INTEGRATION_STOP_OWNER_CHANNEL_ONLY';

/** Longest reason an abandon carries — the same bound the retry door puts on a rerun's. */
export const MAX_INTEGRATION_ABANDON_REASON = 2_000;

/**
 * Why an abandoned `LAND_TASK` / `LAND_PROMOTION` may have pushed, in the words the record and the
 * card use (§2.2 J12). `RUNNER_LOST` is the only answer that may say nothing was pushed; a
 * `CHECK_PROMOTION` never pushes at all, and `PUSH_OUTCOME_UNKNOWN` says what it is.
 */
export function abandonPushOutcome(errorCode: string): 'NOT_PUSHED' | 'UNKNOWN' {
  return errorCode === 'RUNNER_LOST' ? 'NOT_PUSHED' : 'UNKNOWN';
}
