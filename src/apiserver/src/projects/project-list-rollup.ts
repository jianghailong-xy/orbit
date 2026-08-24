import { Prisma } from '@prisma/client';
import type { ProjectStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ProjectPanoramaBuckets } from './project-panorama';

/**
 * What one row of the project index needs in order to be COMPARABLE to the row above it.
 *
 * `_count.tasks` is not: it counts DONE and CANCELLED alongside everything else, so a finished
 * project's 16 and a stalled project's 16 are the same number about two unrelated situations, and
 * across the deployment that number ranges from 8 to 23,442. The buckets are the same five numbers
 * the project page leads with, and `lastActivityAt` is what orders them by attention.
 */
export interface ProjectListRollup {
  buckets: ProjectPanoramaBuckets;
  /**
   * The most recent `task.updated_at` in the project, or null when it has no tasks yet.
   *
   * NOT `Project.updatedAt`: that column only moves when the project ROW is written through
   * Prisma, which happens in exactly two places (`ProjectsService.update` and the coordinator
   * identity write), and neither of them is a task running. A project whose tasks have been
   * dispatched, run and completed all week reports the day somebody last renamed it — which is
   * the one reading a "last activity" column must never give.
   *
   * `ProjectRuntime.leaseHeartbeatAt` was the other candidate and is rejected for the opposite
   * failure: it ticks every time the control loop renews its lease, whether or not the loop
   * concluded anything, so an idle project with a live coordinator would outrank a project that
   * actually moved. It also reads null for every project that has never been coordinated, which
   * is most of them. `max(task.updated_at)` moves when — and only when — a task was filed,
   * dispatched, re-statused or aggregated, which is the event the column claims to report.
   *
   * Null rather than a stand-in for an empty project: nothing has happened there, and
   * `project.createdAt` substituted here would be activity nobody performed.
   */
  lastActivityAt: Date | null;
}

/** What a project with no tasks reports: five zeroes and no activity, never a missing field. */
export function emptyProjectListRollup(): ProjectListRollup {
  return {
    buckets: { running: 0, ready: 0, blocked: 0, done: 0, cancelled: 0 },
    lastActivityAt: null,
  };
}

interface RollupRow {
  projectId: string;
  running: number;
  ready: number;
  blocked: number;
  done: number;
  cancelled: number;
  lastActivityAt: Date | null;
}

/**
 * Every project of one owner, bucketed, in ONE round trip.
 *
 * Deliberately not `readProjectPanorama` in a loop, and deliberately not its recursive CTE either.
 * The buckets depend on `unmetCount` alone, and `unmetCount` is an ordinary
 * `task_dependency JOIN task` grouped by dependent — the recursion in
 * `projectTaskDependencyFactsSql` exists to compute `topoLevel`/`maxDepth`, which describe the
 * SHAPE of one project's graph and are not on this page. Dropping it is what lets the whole index
 * be one grouped aggregate: measured at 252ms over 18 projects, one of them 23,442 tasks.
 *
 * The bucket rules are `readProjectPanorama`'s, word for word, because a task that is `blocked` in
 * the list and `ready` on the project page is worse than either number alone:
 *
 *   - `running`  = IN_PROGRESS
 *   - `ready`    = OPEN with no unmet prerequisite
 *   - `blocked`  = OPEN with at least one
 *   - FAILED is in no bucket: neither work in flight nor work settled.
 *
 * "Unmet" carries the same scope too — a prerequisite is unmet while its status is OPEN or
 * IN_PROGRESS, wherever it is filed. A prerequisite in ANOTHER project still holds its dependent
 * up, and a CANCELLED or FAILED one no longer does, so its dependent reads `ready`.
 *
 * Projects with no tasks produce no group here; `emptyProjectListRollup` supplies their row.
 */
export async function readProjectListRollups(
  prisma: PrismaService,
  ownerId: string,
  status?: ProjectStatus,
): Promise<Map<string, ProjectListRollup>> {
  // The same narrowing the index itself applies, so this aggregates the page rather than the
  // account: `?status=DONE` must not pay for the OPEN projects it is not going to return.
  const narrowed = status
    ? Prisma.sql`AND proj."status" = ${status}::project_status`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<RollupRow[]>(Prisma.sql`
    WITH scoped AS (
      SELECT t.id, t.project_id, t.status::text AS status, t.updated_at
        FROM task t
        JOIN project proj ON proj.id = t.project_id AND proj.owner_id = ${ownerId}::uuid
       WHERE t.owner_id = ${ownerId}::uuid ${narrowed}
    ),
    prerequisite AS (
      SELECT d.task_id, pre.status::text AS status
        FROM task_dependency d
        JOIN scoped dependent ON dependent.id = d.task_id
        JOIN task pre ON pre.id = d.depends_on_task_id
    ),
    tally AS (
      SELECT task_id, count(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS')) AS unmet_count
        FROM prerequisite
       GROUP BY task_id
    )
    SELECT s.project_id AS "projectId",
           (count(*) FILTER (WHERE s.status = 'IN_PROGRESS'))::int AS "running",
           (count(*) FILTER (WHERE s.status = 'OPEN'
                               AND coalesce(tally.unmet_count, 0) = 0))::int AS "ready",
           (count(*) FILTER (WHERE s.status = 'OPEN'
                               AND coalesce(tally.unmet_count, 0) > 0))::int AS "blocked",
           (count(*) FILTER (WHERE s.status = 'DONE'))::int AS "done",
           (count(*) FILTER (WHERE s.status = 'CANCELLED'))::int AS "cancelled",
           max(s.updated_at) AS "lastActivityAt"
      FROM scoped s
      -- At most one tally row per task (it is grouped by dependent), so this cannot fan a task
      -- out into two counted rows. LEFT because a task with no prerequisites is ready, not
      -- absent.
      LEFT JOIN tally ON tally.task_id = s.id
     GROUP BY s.project_id`);

  return new Map(
    rows.map((row) => [
      row.projectId,
      {
        buckets: {
          running: row.running,
          ready: row.ready,
          blocked: row.blocked,
          done: row.done,
          cancelled: row.cancelled,
        },
        lastActivityAt: row.lastActivityAt,
      },
    ]),
  );
}
