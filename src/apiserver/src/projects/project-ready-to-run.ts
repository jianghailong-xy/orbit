import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { manualRunnableTaskSql } from '../tasks/manual-runnable-task-sql';
import { BLOCKING_MAX_UNFINISHED_TASKS } from './project-panorama-blocking';

export type ProjectReadyToRunState = 'READY' | 'QUEUED' | 'RUNNING' | 'PAUSED';

export interface ProjectReadyToRunPausedList {
  id: string;
  title: string;
  /** Tasks in this list that would become manually runnable if the list were resumed now. */
  readyCount: number;
  /** The subset above configured to start automatically once released. */
  autoRunReadyCount: number;
}

/** One executable or executing task, ranked by activity and downstream impact. */
export interface ProjectReadyToRunItem {
  taskId: string;
  title: string;
  status: string;
  /** READY can be started; QUEUED/RUNNING are active; PAUSED first needs its list resumed. */
  runState: ProjectReadyToRunState;
  /** Present only for PAUSED rows, so the UI can offer a truthful resume-list action. */
  pausedList: ProjectReadyToRunPausedList | null;
  /** Null only when the project is too large to compute its transitive closure safely. */
  downstreamBlocked: number | null;
}

export interface ProjectReadyToRun {
  /** Every manually runnable task in the project, including rows beyond `items`. */
  readyCount: number;
  /** Work Sessions waiting for a runner slot. */
  queuedCount: number;
  /** Work Sessions actively held by a runner. */
  runningCount: number;
  /** Otherwise-runnable tasks currently held by a paused task list. */
  pausedCount: number;
  /** Active tasks first, then ready tasks, then candidates whose list can be resumed. */
  items: ProjectReadyToRunItem[];
  /** The ready list remains usable when impact ranking is skipped. */
  impactTruncated: { reason: 'TOO_MANY_UNFINISHED_TASKS'; maxTasks: number } | null;
}

interface ReadyTotals {
  readyCount: number;
  queuedCount: number;
  runningCount: number;
  pausedCount: number;
  impactTruncated: boolean;
}

type ReadyRow = ReadyTotals & {
  taskId: string | null;
  title: string | null;
  status: string | null;
  runState: ProjectReadyToRunState | null;
  /** Internal sort value; deliberately omitted from the public payload. */
  activeSince: Date | null;
  pausedListId: string | null;
  pausedListTitle: string | null;
  pausedListReadyCount: number | null;
  pausedListAutoRunReadyCount: number | null;
  downstreamBlocked: number | null;
};

/**
 * Tasks the user can start right now, the work they just started, and the next tasks that need
 * one explicit list-resume action first.
 *
 * Readiness uses the exact predicate behind the global Ready tab. The impact walk uses the same
 * unfinished subgraph as the blocking leaderboard, but starts from every runnable row and LEFT
 * joins its reach: a runnable leaf therefore appears with impact 0 instead of disappearing. This
 * distinction is what lets the card truthfully offer Run even when nothing has a dependent.
 *
 * A successful Run creates a PENDING or RUNNING work Session, which intentionally makes the task
 * fail the runnable predicate. Those occupied rows are selected separately and placed before the
 * remaining ready work, newest first. The row therefore changes state instead of disappearing
 * when the success invalidation refetches this endpoint. Only Sessions that actually start task
 * work count here — a task-linked read/salvage conversation must not take away a valid Run button.
 * A held row is included only when every other manual-run gate passes and its owning list is
 * genuinely paused. It never receives a Run state: the execute endpoint intentionally refuses a
 * held task, so the client can only offer the explicit, scope-labelled list resume action.
 *
 * Projects above the closure safety cap still get a ready list. Their impact values are null and
 * the stable title/id order takes over, so an expensive ranking never removes the Run controls.
 */
export async function readProjectReadyToRun(
  prisma: Pick<PrismaService, '$queryRaw'>,
  ownerId: string,
  projectId: string,
  limit: number,
): Promise<ProjectReadyToRun> {
  const rows = await prisma.$queryRaw<ReadyRow[]>(Prisma.sql`
    WITH RECURSIVE
      unfinished AS (
        SELECT t.id
          FROM task t
         WHERE t.project_id = ${projectId}::uuid
           AND t.owner_id = ${ownerId}::uuid
           AND t.status NOT IN ('DONE', 'CANCELLED')
      ),
      unfinished_size AS (
        SELECT count(*) > ${Prisma.raw(String(BLOCKING_MAX_UNFINISHED_TASKS))} AS truncated
          FROM unfinished
      ),
      edge AS (
        SELECT d.depends_on_task_id AS blocker, d.task_id AS blocked
          FROM task_dependency d
          JOIN unfinished blocker ON blocker.id = d.depends_on_task_id
          JOIN unfinished blocked ON blocked.id = d.task_id
         WHERE NOT (SELECT truncated FROM unfinished_size)
      ),
      reach(root, node) AS (
        SELECT blocker, blocked FROM edge
        UNION
        SELECT reach.root, edge.blocked
          FROM reach
          JOIN edge ON edge.blocker = reach.node
      ),
      ready AS (
        SELECT t.id, t.title, t.status::text AS status
          FROM task t
         WHERE t.project_id = ${projectId}::uuid
           AND t.owner_id = ${ownerId}::uuid
           AND ${Prisma.raw(manualRunnableTaskSql('t'))}
      ),
      paused AS (
        SELECT t.id,
               t.title,
               t.status::text AS status,
               l.id AS "pausedListId",
               l.title AS "pausedListTitle",
               count(*) OVER (PARTITION BY l.id)::int AS "pausedListReadyCount",
               (count(*) FILTER (WHERE t.auto_run_when_ready) OVER (PARTITION BY l.id))::int
                 AS "pausedListAutoRunReadyCount"
          FROM task t
          JOIN task_list l
            ON l.id = t.list_id
           AND l.owner_id = t.owner_id
           AND l.paused = true
         WHERE t.project_id = ${projectId}::uuid
           AND t.owner_id = ${ownerId}::uuid
           AND t.dispatch_hold = true
           AND ${Prisma.raw(manualRunnableTaskSql('t', { requireUnheld: false }))}
      ),
      active AS (
        SELECT DISTINCT ON (t.id)
               t.id,
               t.title,
               t.status::text AS status,
               CASE s.status
                 WHEN 'RUNNING'::run_status THEN 'RUNNING'
                 ELSE 'QUEUED'
               END::text AS "runState",
               coalesce(s.started_at, s.created_at) AS "activeSince"
          FROM task t
          JOIN session s ON s.task_id = t.id
         WHERE t.project_id = ${projectId}::uuid
           AND t.owner_id = ${ownerId}::uuid
           AND t.status <> 'DONE'::task_status
           AND s.owner_id = ${ownerId}::uuid
           AND s.deleted_at IS NULL
           AND s.starts_task_work = true
           AND s.status IN ('PENDING'::run_status, 'RUNNING'::run_status)
         ORDER BY t.id,
                  CASE s.status WHEN 'RUNNING'::run_status THEN 0 ELSE 1 END,
                  s.created_at DESC,
                  s.id DESC
      ),
      ready_size AS (
        SELECT count(*)::int AS count FROM ready
      ),
      paused_size AS (
        SELECT count(*)::int AS count FROM paused
      ),
      active_size AS (
        SELECT (count(*) FILTER (WHERE "runState" = 'QUEUED'))::int AS queued,
               (count(*) FILTER (WHERE "runState" = 'RUNNING'))::int AS running
          FROM active
      ),
      candidates AS (
        SELECT ready.id,
               ready.title,
               ready.status,
               'READY'::text AS "runState",
               NULL::timestamptz AS "activeSince",
               NULL::uuid AS "pausedListId",
               NULL::text AS "pausedListTitle",
               NULL::int AS "pausedListReadyCount",
               NULL::int AS "pausedListAutoRunReadyCount"
          FROM ready
        UNION ALL
        SELECT active.id,
               active.title,
               active.status,
               active."runState",
               active."activeSince",
               NULL::uuid AS "pausedListId",
               NULL::text AS "pausedListTitle",
               NULL::int AS "pausedListReadyCount",
               NULL::int AS "pausedListAutoRunReadyCount"
          FROM active
        UNION ALL
        SELECT paused.id,
               paused.title,
               paused.status,
               'PAUSED'::text AS "runState",
               NULL::timestamptz AS "activeSince",
               paused."pausedListId",
               paused."pausedListTitle",
               paused."pausedListReadyCount",
               paused."pausedListAutoRunReadyCount"
          FROM paused
      )
    SELECT ready_size.count AS "readyCount",
           active_size.queued AS "queuedCount",
           active_size.running AS "runningCount",
           paused_size.count AS "pausedCount",
           unfinished_size.truncated AS "impactTruncated",
           ranked."taskId",
           ranked.title,
           ranked.status,
           ranked."runState",
           ranked."activeSince",
           ranked."pausedListId",
           ranked."pausedListTitle",
           ranked."pausedListReadyCount",
           ranked."pausedListAutoRunReadyCount",
           CASE
             WHEN unfinished_size.truncated THEN NULL
             ELSE ranked."downstreamBlocked"
           END AS "downstreamBlocked"
      FROM ready_size
      CROSS JOIN active_size
      CROSS JOIN paused_size
      CROSS JOIN unfinished_size
      LEFT JOIN LATERAL (
        SELECT candidate.id AS "taskId",
               candidate.title,
               candidate.status,
               candidate."runState",
               candidate."activeSince",
               candidate."pausedListId",
               candidate."pausedListTitle",
               candidate."pausedListReadyCount",
               candidate."pausedListAutoRunReadyCount",
               count(DISTINCT reach.node)::int AS "downstreamBlocked"
          FROM candidates candidate
          LEFT JOIN reach ON reach.root = candidate.id
         GROUP BY candidate.id,
                  candidate.title,
                  candidate.status,
                  candidate."runState",
                  candidate."activeSince",
                  candidate."pausedListId",
                  candidate."pausedListTitle",
                  candidate."pausedListReadyCount",
                  candidate."pausedListAutoRunReadyCount"
         ORDER BY CASE
                    WHEN candidate."runState" IN ('RUNNING', 'QUEUED') THEN 0
                    WHEN candidate."runState" = 'READY' THEN 1
                    ELSE 2
                  END,
                  candidate."activeSince" DESC NULLS LAST,
                  "downstreamBlocked" DESC,
                  candidate.title ASC,
                  candidate.id ASC
         LIMIT ${limit}
      ) ranked ON true
     ORDER BY CASE
                WHEN ranked."runState" IN ('RUNNING', 'QUEUED') THEN 0
                WHEN ranked."runState" = 'READY' THEN 1
                ELSE 2
              END,
              ranked."activeSince" DESC NULLS LAST,
              ranked."downstreamBlocked" DESC NULLS LAST,
              ranked.title ASC,
              ranked."taskId" ASC`);

  const items: ProjectReadyToRunItem[] = [];
  for (const row of rows) {
    if (row.taskId === null || row.title === null || row.status === null || row.runState === null) {
      continue;
    }
    const {
      taskId,
      title,
      status,
      runState,
      downstreamBlocked,
      pausedListId,
      pausedListTitle,
      pausedListReadyCount,
      pausedListAutoRunReadyCount,
    } = row;
    const pausedList =
      runState === 'PAUSED' &&
      pausedListId !== null &&
      pausedListTitle !== null &&
      pausedListReadyCount !== null &&
      pausedListAutoRunReadyCount !== null
        ? {
            id: pausedListId,
            title: pausedListTitle,
            readyCount: pausedListReadyCount,
            autoRunReadyCount: pausedListAutoRunReadyCount,
          }
        : null;
    items.push({ taskId, title, status, runState, pausedList, downstreamBlocked });
  }

  const [first] = rows;
  return {
    readyCount: first?.readyCount ?? 0,
    queuedCount: first?.queuedCount ?? 0,
    runningCount: first?.runningCount ?? 0,
    pausedCount: first?.pausedCount ?? 0,
    items,
    impactTruncated: first?.impactTruncated
      ? { reason: 'TOO_MANY_UNFINISHED_TASKS', maxTasks: BLOCKING_MAX_UNFINISHED_TASKS }
      : null,
  };
}
