import { projectNotCancelledSql } from './project-cancelled-dispatch';
import { dependenciesSatisfiedSql } from './task-dependencies';
import { taskNotObsoleteSql } from './task-supersession';

/**
 * The rows a person may start through `POST /tasks/:id/execute`.
 *
 * Kept as one shared SQL predicate because the Ready task tab and every project-scoped
 * "Ready to run" surface have to agree with the execute gate. A task is manually runnable when
 * it is not done, is not paused, is not filed under a cancelled project (`projectNotCancelledSql`),
 * has an enabled workspace backed by a runner, has no busy work
 * run or unresolved completion-ACK repair, has satisfied every prerequisite, is not an
 * completion-owned task (aggregate parent or independent-verification gate row), and has not been
 * retired by supersession.
 *
 * The gate row is read off `completion_policy`, not off `completion_criterion`. A VERIFICATION
 * criterion says an independent verdict settles this task, which is a statement about who finishes
 * it and not about whether it has work to do: a task can perfectly well run and still need another
 * session to check it. Only `VERIFICATION_PASSED` says nothing here is going to run.
 *
 * A diagnostic surface may set `requireUnheld` false to ask the useful narrower question "would
 * this be runnable if its task list were resumed?"; that surface must still check
 * `dispatch_hold = true` itself and must never pass the resulting row to Execute as runnable. It
 * does not lift the cancelled-project clause: resuming a list does not reopen a project.
 *
 * `alias` is supplied only by source code, never by a request. Returning a string is intentional:
 * the dependency and supersession predicates are themselves correlated SQL strings, and callers
 * splice the complete expression into a `Prisma.sql` statement with `Prisma.raw`.
 */
export function manualRunnableTaskSql(
  alias = 't',
  { requireUnheld = true }: { requireUnheld?: boolean } = {},
): string {
  return `${alias}.status <> 'DONE'::task_status
  ${requireUnheld ? `AND ${alias}.dispatch_hold = false` : ''}
  AND ${projectNotCancelledSql(alias)}
  AND EXISTS (
    SELECT 1 FROM workspace a
    WHERE a.id = ${alias}.assignee_id AND a.runner_id IS NOT NULL AND a.enabled = true
  )
  AND NOT EXISTS (
    SELECT 1 FROM session s
    WHERE s.task_id = ${alias}.id
      AND s.deleted_at IS NULL
      AND s.starts_task_work = true
      AND s.status IN ('PENDING'::run_status, 'RUNNING'::run_status)
  )
  AND ${dependenciesSatisfiedSql(alias)}
  AND NOT (
    ${alias}.completion_policy = 'VERIFICATION_PASSED'::task_completion_policy
    AND ${alias}.verifies_task_id IS NULL
  )
  AND (
    ${alias}.completion_policy = 'MANUAL'::task_completion_policy
    OR NOT EXISTS (
      SELECT 1 FROM task aggregate_child
       WHERE aggregate_child.parent_task_id = ${alias}.id
         AND aggregate_child.owner_id = ${alias}.owner_id
    )
  )
  AND ${taskNotObsoleteSql(alias)}`;
}
