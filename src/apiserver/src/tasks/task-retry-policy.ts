import { isReleased, releaseFinishedTheWork } from '../common/session-release';

// One retry policy, for the task sweep and everything that schedules off it
// (`TasksService.autoRunHoldOff`, `quotaGate` and the `rearmEndedAutoRuns` loop that drives them).
// Keeping the numbers here prevents a second retry ladder from growing that only happens to have
// the same values today. (It was once shared with project authorization too —
// `project-authorization.service.ts` imported `retryBackoffUntil` — and that half went with the
// coordinator loop in `6418a1e5`, 2026-08-23; the sweep is the only reader left.)
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
 *  - `UNREQUESTED`: released with none of those, and not for the work being finished: a crash, a
 *    failed turn, the reaper giving up on an offline runner (a failure), an engine that exited
 *    without being asked (whatever word the runner reported with it), a cancel with no reason.
 *    Retried under the backoff and the failure limit. `cancel_requested_at` is deliberately not
 *    read: the reaper and a failed turn set it too, so it says a teardown was wanted, not who
 *    wanted it.
 *  - `FINISHED`: released because the work finished (releaseFinishedTheWork: with no end reason, a
 *    landing settled), or still held, which the retry policy's candidates never are. Not a retry's to
 *    repeat.
 *
 * What became of the work is read off the release, its end reason and the session's kind (decision
 * D5, design §12.3 of docs/session-three-state-design.md), never off the terminal status value. Until
 * 2026-11-21 a runner-reported SUCCEEDED with no end requested read FINISHED here.
 */
export type AutoRunEnd = 'REQUESTED' | 'UNREQUESTED' | 'FINISHED';

export function autoRunEnd(run: {
  /** Only whether the run's row is still there: null once it was purged. */
  sessionStatus: string | null;
  finishedAt: Date | null;
  /** The session's kind; null, with every column of the row, once it was purged. */
  sessionKind: string | null;
  endReason: string | null;
  completedAt: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
}): AutoRunEnd {
  const sessionKind = run.sessionKind;
  if (run.sessionStatus == null || sessionKind == null) return 'REQUESTED';
  if (
    run.endReason != null || run.completedAt != null || run.archivedAt != null
    || run.deletedAt != null
  ) {
    return 'REQUESTED';
  }
  if (!isReleased(run) || releaseFinishedTheWork({ ...run, sessionKind })) return 'FINISHED';
  return 'UNREQUESTED';
}
