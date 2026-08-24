import { dependenciesSatisfiedSql } from './task-dependencies';
import { taskNotObsoleteSql } from './task-supersession';

/**
 * The rows a person may start through `POST /tasks/:id/execute`.
 *
 * Kept as one shared SQL predicate because the Ready task tab and every project-scoped
 * "Ready to run" surface have to agree with the execute gate. A task is manually runnable when
 * it is not done, is not paused, has an enabled workspace backed by a runner, has no busy work
 * run, has satisfied every prerequisite, is not an aggregate-only parent, and has not been
 * retired by supersession.
 *
 * `alias` is supplied only by source code, never by a request. Returning a string is intentional:
 * the dependency and supersession predicates are themselves correlated SQL strings, and callers
 * splice the complete expression into a `Prisma.sql` statement with `Prisma.raw`.
 */
export function manualRunnableTaskSql(alias = 't'): string {
  return `${alias}.status <> 'DONE'::task_status
  AND ${alias}.dispatch_hold = false
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
