import { Prisma } from '@prisma/client';
import type { ProjectStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ProjectPanoramaBuckets } from './project-panorama';

/**
 * What one row of the project index needs in order to be COMPARABLE to the row above it.
 *
 * `_count.tasks` is not: it counts DONE and CANCELLED alongside everything else, so a finished
 * project's 16 and a stalled project's 16 are the same number about two unrelated situations, and
 * across the deployment that number ranges from single digits to more than 100,000. The buckets
 * are the same five numbers the project page leads with; they choose a lifecycle lane, and
 * `lastActivityAt` orders peers inside it. Durable human blockers are aggregated separately by
 * project-list-attention.
 */
export interface ProjectListRollup {
  /** The whole project population, including FAILED tasks that sit in no display bucket. */
  taskCount: number;
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
    taskCount: 0,
    buckets: { running: 0, ready: 0, blocked: 0, done: 0, cancelled: 0 },
    lastActivityAt: null,
  };
}

interface RollupRow {
  projectId: string;
  taskCount: number;
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
 * The buckets depend on whether a task has ANY unmet prerequisite, not on graph depth. `base`
 * counts task statuses once per project; `live` counts dispatched OPEN tasks; `blocked_task`
 * deduplicates dependents with at least one unmet edge. The final arithmetic joins only one row
 * per project instead of materialising every scoped task and joining an 80k-row per-task tally
 * back onto it. Together with the covering index from migration 0178, the production-size plan
 * fell from 1.94s to 0.74s over 111k tasks and 83k edges while returning identical rows.
 *
 * The bucket rules are `readProjectPanorama`'s, word for word, because a task that is `blocked` in
 * the list and `ready` on the project page is worse than either number alone:
 *
 *   - `running`  = IN_PROGRESS, or OPEN with a live session on it
 *   - `ready`    = OPEN, no live session, no unmet prerequisite
 *   - `blocked`  = OPEN, no live session, at least one unmet prerequisite
 *   - FAILED is in no bucket: neither work in flight nor work settled.
 *
 * The live-session half is not decoration: dispatch opens a Session and leaves `Task.status` at
 * OPEN for the whole run, so a rollup that read the status column alone reported `running: 0` for
 * a project with an agent working in it — and the index put it under "Stalled: nothing running".
 * A dispatched task is not `ready` either, because `ready` is what the page offers the reader to
 * START, and this one has already started.
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
    WITH active AS MATERIALIZED (
      SELECT DISTINCT sess.task_id
        FROM session sess
       WHERE sess.owner_id = ${ownerId}::uuid
         AND sess.status IN ('PENDING', 'RUNNING')
         AND sess.task_id IS NOT NULL
    ),
    base AS MATERIALIZED (
      SELECT t.project_id AS "projectId",
             count(*)::int AS "taskCount",
             (count(*) FILTER (WHERE t.status = 'IN_PROGRESS'))::int AS in_progress,
             (count(*) FILTER (WHERE t.status = 'OPEN'))::int AS open_total,
             (count(*) FILTER (WHERE t.status = 'DONE'))::int AS done,
             (count(*) FILTER (WHERE t.status = 'CANCELLED'))::int AS cancelled,
             max(t.updated_at) AS "lastActivityAt"
        FROM project proj
        JOIN task t ON t.owner_id = ${ownerId}::uuid
                   AND t.project_id = proj.id
       WHERE proj.owner_id = ${ownerId}::uuid ${narrowed}
       GROUP BY t.project_id
    ),
    live AS MATERIALIZED (
      SELECT t.project_id AS "projectId", count(*)::int AS live_open
        FROM active a
        JOIN task t ON t.id = a.task_id
                   AND t.owner_id = ${ownerId}::uuid
                   AND t.status = 'OPEN'
        JOIN project proj ON proj.id = t.project_id
                         AND proj.owner_id = ${ownerId}::uuid
       WHERE true ${narrowed}
       GROUP BY t.project_id
    ),
    blocked_task AS MATERIALIZED (
      SELECT dependent.project_id AS "projectId", dependent.id
        FROM project proj
        JOIN task dependent ON dependent.owner_id = ${ownerId}::uuid
                           AND dependent.project_id = proj.id
                           AND dependent.status = 'OPEN'
        JOIN task_dependency d ON d.task_id = dependent.id
        -- A prerequisite in another project still blocks this task. Do not narrow pre by project:
        -- project filing is organisation, while dependency execution is owner-wide.
        JOIN task pre ON pre.id = d.depends_on_task_id
                     AND pre.status IN ('OPEN', 'IN_PROGRESS')
        -- A task already held by a live session is running even if a dependency was added later.
        LEFT JOIN active a ON a.task_id = dependent.id
       WHERE proj.owner_id = ${ownerId}::uuid ${narrowed}
         AND a.task_id IS NULL
       GROUP BY dependent.project_id, dependent.id
    ),
    blocked AS MATERIALIZED (
      SELECT "projectId", count(*)::int AS blocked
        FROM blocked_task
       GROUP BY "projectId"
    )
    SELECT base."projectId",
           base."taskCount",
           (base.in_progress + coalesce(live.live_open, 0))::int AS "running",
           (base.open_total - coalesce(live.live_open, 0)
                            - coalesce(blocked.blocked, 0))::int AS "ready",
           coalesce(blocked.blocked, 0)::int AS "blocked",
           base.done::int AS "done",
           base.cancelled::int AS "cancelled",
           base."lastActivityAt"
      FROM base
      LEFT JOIN live USING ("projectId")
      LEFT JOIN blocked USING ("projectId")`);

  return new Map(
    rows.map((row) => [
      row.projectId,
      {
        taskCount: row.taskCount,
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
