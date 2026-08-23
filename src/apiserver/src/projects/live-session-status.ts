/**
 * The Session statuses that count as "this task is occupied".
 *
 * `AWAITING_INPUT` and `INTERRUPTED` are live on purpose — both are resumable, and treating a
 * conversation somebody paused as free is how a task ends up with a second Session on it. The
 * partial unique index `session_task_execution_claim_idx` covers the same set.
 */
export const PROJECT_LIVE_SESSION_STATUSES: readonly string[] = [
  'PENDING',
  'RUNNING',
  'AWAITING_INPUT',
  'INTERRUPTED',
];

export function isLiveSessionStatus(status: string): boolean {
  return PROJECT_LIVE_SESSION_STATUSES.includes(status);
}

/**
 * The same statuses as a SQL literal list, so a raw gate cannot quietly hold a fifth opinion.
 *
 * Interpolated as a literal rather than parameterised because it is a fixed list this file owns,
 * and because a gate is then greppable for the exact string.
 */
export const PROJECT_LIVE_SESSION_STATUS_SQL: string = PROJECT_LIVE_SESSION_STATUSES
  .map((status) => `'${status}'`)
  .join(', ');
