import { HELD_SESSION_STATUSES } from '../common/session-release';

/**
 * The Session statuses that count as "this task is occupied".
 *
 * `AWAITING_INPUT` and `INTERRUPTED` are live on purpose — both are resumable, and treating a
 * conversation somebody paused as free is how a task ends up with a second Session on it. The
 * partial unique index `session_task_execution_claim_idx` covers the same set, and 1416's
 * `session_task_execution_claim_idx_finished_at` the same rows, by `finished_at IS NULL`
 * (session_release_fact_chk).
 */
export const PROJECT_LIVE_SESSION_STATUSES: readonly string[] = HELD_SESSION_STATUSES;

export function isLiveSessionStatus(status: string): boolean {
  return PROJECT_LIVE_SESSION_STATUSES.includes(status);
}
