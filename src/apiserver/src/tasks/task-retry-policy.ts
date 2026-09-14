import { RunStatus } from '@prisma/client';

// One retry policy, shared by the legacy task sweep and Project authorization. Keeping the
// numbers here prevents the Coordinator from growing a second retry ladder that only happens to
// have the same values today.
export const AUTO_RUN_RETRY_BACKOFF_MS = [
  2 * 60_000,
  8 * 60_000,
  30 * 60_000,
  120 * 60_000,
] as const;

export const MAX_AUTO_RUN_FAILURES = AUTO_RUN_RETRY_BACKOFF_MS.length + 1;

export const QUOTA_BLIND_RETRY_BACKOFF_MS = 15 * 60_000;

export function retryBackoffUntil(
  failureCount: number,
  lastFailureAt: Date | null,
): Date | null {
  if (failureCount <= 0 || !lastFailureAt || failureCount >= MAX_AUTO_RUN_FAILURES) return null;
  return new Date(
    lastFailureAt.getTime()
      + AUTO_RUN_RETRY_BACKOFF_MS[Math.min(failureCount - 1, AUTO_RUN_RETRY_BACKOFF_MS.length - 1)],
  );
}

/**
 * What the end of an auto-run task's run says about the sweep starting that work again, read off
 * the run's own row (TasksService.rearmEndedAutoRuns).
 *
 *  - `REQUESTED`: somebody asked for this end, or filed the run away. Not retried; the task waits
 *    for whoever stopped it. `end_reason` is written only on the way to a requested end:
 *    `SessionsService.cancel` (the task list's Stop, `cancelled`), `end` (`ended`), `complete`
 *    (`completed`) and `remove` (`deleted`), reached by a person or by an agent holding the owner's
 *    orchestration grant, and the reaper's teardown after the task itself ended (`task_done`,
 *    `task_cancelled`). The runner's /finalize and the reaper's own finalize never write it, and a
 *    revive clears it. A run filed into Completed or Trash after it had already ended keeps a null
 *    reason and says the same through its filing timestamps. A run whose row is gone was purged
 *    from Trash, the one path that deletes a Session.
 *  - `UNREQUESTED`: FAILED or CANCELLED with none of those: a crash, a failed turn, the reaper
 *    giving up on an offline runner, a cancel the runner reported without being asked. Retried
 *    under the backoff and the failure limit. `cancel_requested_at` is deliberately not read: the
 *    reaper and a failed turn set it too, so it says a teardown was wanted, not who wanted it.
 *  - `FINISHED`: SUCCEEDED without being asked to end. Not a failure, so not a retry's to repeat.
 */
export type AutoRunEnd = 'REQUESTED' | 'UNREQUESTED' | 'FINISHED';

export function autoRunEnd(run: {
  sessionStatus: string | null;
  endReason: string | null;
  completedAt: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
}): AutoRunEnd {
  if (run.sessionStatus == null) return 'REQUESTED';
  if (
    run.endReason != null || run.completedAt != null || run.archivedAt != null
    || run.deletedAt != null
  ) {
    return 'REQUESTED';
  }
  return run.sessionStatus === RunStatus.FAILED || run.sessionStatus === RunStatus.CANCELLED
    ? 'UNREQUESTED'
    : 'FINISHED';
}
