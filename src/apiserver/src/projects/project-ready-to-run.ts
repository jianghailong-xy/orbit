import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { manualRunnableTaskSql } from '../tasks/manual-runnable-task-sql';
import { BLOCKING_MAX_UNFINISHED_TASKS } from './project-panorama-blocking';

/** One executable task, ranked by how much unfinished work it releases. */
export interface ProjectReadyToRunItem {
  taskId: string;
  title: string;
  status: string;
  /** Null only when the project is too large to compute its transitive closure safely. */
  downstreamBlocked: number | null;
}

export interface ProjectReadyToRun {
  /** Every manually runnable task in the project, including rows beyond `items`. */
  readyCount: number;
  /** Highest downstream impact first; zero-impact runnable leaves remain eligible and are shown. */
  items: ProjectReadyToRunItem[];
  /** The ready list remains usable when impact ranking is skipped. */
  impactTruncated: { reason: 'TOO_MANY_UNFINISHED_TASKS'; maxTasks: number } | null;
}

interface ReadyTotals {
  readyCount: number;
  impactTruncated: boolean;
}

type ReadyRow =
  | (ReadyTotals & ProjectReadyToRunItem)
  | (ReadyTotals & {
      taskId: null;
      title: null;
      status: null;
      downstreamBlocked: null;
    });

/**
 * Tasks the user can start right now, ordered by the work each one transitively unblocks.
 *
 * Readiness uses the exact predicate behind the global Ready tab. The impact walk uses the same
 * unfinished subgraph as the blocking leaderboard, but starts from every runnable row and LEFT
 * joins its reach: a runnable leaf therefore appears with impact 0 instead of disappearing. This
 * distinction is what lets the card truthfully say "Ready to run" even when nothing has a
 * dependent.
 *
 * Projects above the closure safety cap still get a ready list. Their impact values are null and
 * the stable title/id order takes over, so an expensive ranking never removes the Run controls.
 */
export async function readProjectReadyToRun(
  prisma: PrismaService,
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
      ready_size AS (
        SELECT count(*)::int AS count FROM ready
      )
    SELECT ready_size.count AS "readyCount",
           unfinished_size.truncated AS "impactTruncated",
           ranked."taskId",
           ranked.title,
           ranked.status,
           CASE
             WHEN unfinished_size.truncated THEN NULL
             ELSE ranked."downstreamBlocked"
           END AS "downstreamBlocked"
      FROM ready_size
      CROSS JOIN unfinished_size
      LEFT JOIN LATERAL (
        SELECT candidate.id AS "taskId",
               candidate.title,
               candidate.status,
               count(DISTINCT reach.node)::int AS "downstreamBlocked"
          FROM ready candidate
          LEFT JOIN reach ON reach.root = candidate.id
         GROUP BY candidate.id, candidate.title, candidate.status
         ORDER BY "downstreamBlocked" DESC, candidate.title ASC, candidate.id ASC
         LIMIT ${limit}
      ) ranked ON true
     ORDER BY ranked."downstreamBlocked" DESC NULLS LAST, ranked.title ASC, ranked."taskId" ASC`);

  const items: ProjectReadyToRunItem[] = [];
  for (const row of rows) {
    if (row.taskId === null) continue;
    const { taskId, title, status, downstreamBlocked } = row;
    items.push({ taskId, title, status, downstreamBlocked });
  }

  const [first] = rows;
  return {
    readyCount: first?.readyCount ?? 0,
    items,
    impactTruncated: first?.impactTruncated
      ? { reason: 'TOO_MANY_UNFINISHED_TASKS', maxTasks: BLOCKING_MAX_UNFINISHED_TASKS }
      : null,
  };
}
