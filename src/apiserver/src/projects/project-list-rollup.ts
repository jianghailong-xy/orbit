import { Prisma } from '@prisma/client';
import type { ProjectStatus } from '@prisma/client';
import type { ProjectSidebarTaskCounts } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { sessionCarriesTaskSql } from '../sessions/task-work-carrier';
import { everyPrerequisiteDoneOrRetiredSql } from '../tasks/task-dependencies';
import type { ProjectPanoramaBuckets } from './project-panorama';
import { projectTaskWorkStateSql } from './project-task-work-state';

/** One project-index row's exhaustive task lanes and most recent task activity. */
export interface ProjectListRollup {
  /** The whole project population; the bucket sum is exactly this number. */
  taskCount: number;
  buckets: ProjectPanoramaBuckets;
  /** The most recent task write, or null when this project has never contained a task. */
  lastActivityAt: Date | null;
}

/** A project with no tasks still returns the complete stable wire shape. */
export function emptyProjectListRollup(): ProjectListRollup {
  return {
    taskCount: 0,
    buckets: {
      running: 0,
      ready: 0,
      blocked: 0,
      awaitingVerification: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    },
    lastActivityAt: null,
  };
}

/** One rail row: task progress, work in flight, and the newest task write that orders the row. */
export interface ProjectSidebarRollup {
  taskCounts: ProjectSidebarTaskCounts;
  /**
   * The one lane the rail draws, under the same name the index reports it by. A rail that read
   * `running` off the row while the page read `buckets.running` would be a second spelling of one
   * fact, and the two would part company the first time either moved.
   */
  buckets: { running: number };
  /** The same instant the index reports, or null when the project has never contained a task. */
  lastActivityAt: Date | null;
}

interface RollupRow {
  projectId: string;
  taskCount: number;
  running: number;
  ready: number;
  blocked: number;
  awaitingVerification: number;
  done: number;
  failed: number;
  cancelled: number;
  lastActivityAt: Date | null;
}

/**
 * Every project of one owner, bucketed in one round trip.
 *
 * Every lane is the one `projectTaskWorkStateSql` assigns — the exact expression panorama, task
 * cards and topology read, task-start predicate and canonical verification epoch included. A faster
 * local reinterpretation of OPEN is not an acceptable optimization: that was how a verification
 * subject became Ready on one surface while the actual Run path correctly had no work to start.
 *
 * What is narrowed is which rows the expression has to be ASKED about, and the expression itself
 * says which: read arm by arm, most tasks' lane follows from their stored status alone.
 *
 *   CANCELLED   -> CANCELLED, FAILED -> FAILED   (the first two arms, before anything else)
 *   DONE        -> DONE       unless it is a verification gate row (`verificationSubjectSql`)
 *   IN_PROGRESS -> RUNNING    unless it is a gate row
 *   OPEN        -> BLOCKED    unless it is a gate row, a work session carries it, or it passes the
 *                             READY guard (`everyPrerequisiteDoneOrRetiredSql`) — READY is
 *                             unreachable otherwise, the guard being implied by the execute
 *                             predicate's `dependenciesSatisfied`
 *
 * So the read counts each status into its default lane off `project_task_status_count` — the
 * trigger-maintained tally (0282), at most five rows per project — and runs the CASE on the rows
 * that can leave it: every task `project_rollup_candidate` names (0441: a superset of the OPEN rows
 * past the guard and the live gate rows, appended by triggers on every write that can make a task
 * one), plus every task a work session carries, read from `session` here because a session moves
 * far more often than a task does. A candidate is subtracted from its status's default lane and
 * counted in whatever lane the CASE gives it, so a stale candidate lands where it belongs and
 * changes nothing; only a MISSING one could, which is why that table is a superset and only ever
 * appended to between rebuilds. The bucket sum is still the project's task count, term for term.
 *
 * Before this, the CASE ran on every task of the page, and on production's 112,026-task owner that
 * was 400–480 ms on 2026-10-19 and 820–1,178 ms on 2026-10-25 under load, ~85% of it the READY
 * guard's hashed anti-join over every dependency edge. On 2026-10-25 it would have run on 259 rows.
 *
 * The tally counts a project's tasks whoever owns them, where the CASE side reads only this owner's.
 * The two agree for every row the services write — `TasksService.assertOwnedProject` refuses to file
 * a task under a project its owner does not own, and production holds none — and the rail's
 * `taskCounts` already reads the same tally.
 *
 * `lastActivityAt` is the backward probe of `task_project_activity_idx` the rail uses, one row per
 * project, over this owner's tasks as before.
 */
export async function readProjectListRollups(
  prisma: PrismaService,
  ownerId: string,
  status?: ProjectStatus,
): Promise<Map<string, ProjectListRollup>> {
  const narrowed = status
    ? Prisma.sql`AND proj."status" = ${status}::"project_status"`
    : Prisma.empty;
  // The guard stays in the READY arm exactly as it was: on a candidate set it is a probe per row,
  // and it is still the narrowing the classifier documents, so the expression is the one every
  // other surface reads.
  const workState = Prisma.raw(projectTaskWorkStateSql('t', {
    readyCandidates: everyPrerequisiteDoneOrRetiredSql('t'),
  }));
  // Spliced, never spelled again: the classifier's own answer to which sessions hold work. Across
  // every owner, as the CASE's own carrier test is; the task filter below scopes it.
  const carried = Prisma.raw(sessionCarriesTaskSql('work_session'));

  // `classified` is MATERIALIZED so each candidate is classified once, not once per project, and it
  // is a few hundred rows, so it neither spills nor sorts anything that matters. `taskCount > 0`
  // leaves a project without tasks out of the rows; the caller gives it `emptyProjectListRollup()`.
  const rows = await prisma.$queryRaw<RollupRow[]>(Prisma.sql`
    WITH candidate AS MATERIALIZED (
      SELECT c."task_id" AS "id"
        FROM "project_rollup_candidate" c
       WHERE c."owner_id" = ${ownerId}::uuid
      UNION
      SELECT work_session."task_id"
        FROM "session" work_session
       WHERE work_session."task_id" IS NOT NULL
         AND ${carried}
    ),
    classified AS MATERIALIZED (
      SELECT t."project_id" AS "projectId",
             t."status"::text AS "status",
             (${workState})::text AS "workState"
        FROM "task" t
       WHERE t."id" IN (SELECT "id" FROM candidate)
         AND t."owner_id" = ${ownerId}::uuid
         AND t."project_id" IS NOT NULL
    ),
    lanes AS (
      SELECT "projectId",
             count(*) FILTER (WHERE "workState" = 'RUNNING') AS "running",
             count(*) FILTER (WHERE "workState" = 'READY') AS "ready",
             count(*) FILTER (WHERE "workState" = 'BLOCKED') AS "blocked",
             count(*) FILTER (WHERE "workState" = 'AWAITING_VERIFICATION') AS "awaitingVerification",
             count(*) FILTER (WHERE "workState" = 'DONE') AS "done",
             count(*) FILTER (WHERE "workState" = 'FAILED') AS "failed",
             count(*) FILTER (WHERE "workState" = 'CANCELLED') AS "cancelled",
             count(*) FILTER (WHERE "status" = 'OPEN') AS "openRows",
             count(*) FILTER (WHERE "status" = 'IN_PROGRESS') AS "inProgressRows",
             count(*) FILTER (WHERE "status" = 'DONE') AS "doneRows",
             count(*) FILTER (WHERE "status" = 'FAILED') AS "failedRows",
             count(*) FILTER (WHERE "status" = 'CANCELLED') AS "cancelledRows"
        FROM classified
       GROUP BY "projectId"
    )
    SELECT proj."id" AS "projectId",
           tally."total" AS "taskCount",
           (coalesce(lanes."running", 0) + tally."inProgress" - coalesce(lanes."inProgressRows", 0))::int
             AS "running",
           coalesce(lanes."ready", 0)::int AS "ready",
           (coalesce(lanes."blocked", 0) + tally."open" - coalesce(lanes."openRows", 0))::int AS "blocked",
           coalesce(lanes."awaitingVerification", 0)::int AS "awaitingVerification",
           (coalesce(lanes."done", 0) + tally."done" - coalesce(lanes."doneRows", 0))::int AS "done",
           (coalesce(lanes."failed", 0) + tally."failed" - coalesce(lanes."failedRows", 0))::int AS "failed",
           (coalesce(lanes."cancelled", 0) + tally."cancelled" - coalesce(lanes."cancelledRows", 0))::int
             AS "cancelled",
           activity."lastActivityAt"
      FROM "project" proj
     CROSS JOIN LATERAL (
       SELECT coalesce(sum(c."count"), 0)::int AS "total",
              coalesce(sum(c."count") FILTER (WHERE c."status" = 'OPEN'), 0)::int AS "open",
              coalesce(sum(c."count") FILTER (WHERE c."status" = 'IN_PROGRESS'), 0)::int AS "inProgress",
              coalesce(sum(c."count") FILTER (WHERE c."status" = 'DONE'), 0)::int AS "done",
              coalesce(sum(c."count") FILTER (WHERE c."status" = 'FAILED'), 0)::int AS "failed",
              coalesce(sum(c."count") FILTER (WHERE c."status" = 'CANCELLED'), 0)::int AS "cancelled"
         FROM "project_task_status_count" c
        WHERE c."project_id" = proj."id"
     ) tally
      LEFT JOIN lanes ON lanes."projectId" = proj."id"
     CROSS JOIN LATERAL (
       SELECT max(t."updated_at") AS "lastActivityAt"
         FROM "task" t
        WHERE t."owner_id" = ${ownerId}::uuid
          AND t."project_id" = proj."id"
     ) activity
     WHERE proj."owner_id" = ${ownerId}::uuid ${narrowed}
       AND tally."total" > 0`);

  return new Map(rows.map((row) => [
    row.projectId,
    {
      taskCount: row.taskCount,
      buckets: {
        running: row.running,
        ready: row.ready,
        blocked: row.blocked,
        awaitingVerification: row.awaitingVerification,
        done: row.done,
        failed: row.failed,
        cancelled: row.cancelled,
      },
      lastActivityAt: row.lastActivityAt,
    },
  ]));
}

interface SidebarRollupRow {
  projectId: string;
  running: number;
  done: number;
  failed: number;
  total: number;
  lastActivityAt: Date | null;
}

/**
 * The rail's work in flight, stored status counts and newest task write for one owner's OPEN
 * projects.
 *
 * `GET /projects/sidebar` serves what the web sidebar's Projects group draws, and that group is
 * polled every 15 seconds by every open tab, so this read may not cost what the index costs. The
 * index answers it by classifying every task of every project into seven lanes; the rail draws one
 * of those lanes, and this reads that one.
 *
 * The expression is the SAME `projectTaskWorkStateSql`, un-narrowed — a rail dot lit by a second
 * reading of IN_PROGRESS while the index calls the same project Ready is the drift the shared
 * expression exists to prevent. What is narrowed is the POPULATION it runs on, and the classifier
 * itself says which rows those are: RUNNING is reachable only for a task that is IN_PROGRESS or
 * that a work session still carries, so the candidates are picked by that disjunction first and the
 * CASE runs on the handful it returns. The set is a SUPERSET of RUNNING, so every RUNNING row is
 * in it; and a row it leaves out can only be classified BLOCKED, READY, DONE, FAILED, CANCELLED or
 * AWAITING_VERIFICATION — never RUNNING, so leaving it out changes no count.
 *
 * "Carries" is `sessionCarriesTaskSql`, spliced rather than spelled again, and this read is why
 * that module says nobody should spell it: the first draft of this query listed PENDING and RUNNING
 * sessions, which was true until 2026-10-02 made a session parked at AWAITING_INPUT with a wake
 * source carry its task too. The rail then reported one running task for a project the index called
 * three, and only a comparison against the index's own answer showed it.
 *
 * The CASE cannot simply be dropped for the candidate set either, and a verification GATE ROW left
 * IN_PROGRESS is why: a gate is judged before its stored status, so one with no passing check
 * classifies AWAITING_VERIFICATION and is not work in flight however its row reads.
 *
 * `lastActivityAt` is `max(updated_at)` over the project's tasks — the index's own value, not a
 * stand-in like `Project.updatedAt`, which does not move when work does. `task_project_activity_idx`
 * (0361) orders `updated_at` right after the project, so PostgreSQL answers this `max()` with one
 * backward probe per project instead of reading every task of every open project, which was 87% of
 * this read's buffers. That path exists only while the LATERAL is a lone `max()` over one table: an
 * aggregate added beside it puts the whole walk back, silently, and
 * `project-sidebar-activity-plan.pg.spec.ts` is what notices.
 * Progress counts come from the trigger-maintained `project_task_status_count`, at most one row
 * per status per project. They stay separate from the activity aggregate so its index probe is
 * preserved, and a project with no tasks still reports zero counts and null activity.
 */
export async function readProjectSidebarRollups(
  prisma: PrismaService,
  ownerId: string,
): Promise<Map<string, ProjectSidebarRollup>> {
  // No `readyCandidates`: that option narrows the READY arm, which this count never reads, and
  // the plain expression is the one every other surface reads.
  const workState = Prisma.raw(projectTaskWorkStateSql('t'));
  // Spliced, never spelled again: this is the classifier's own answer to which sessions hold work.
  const carried = Prisma.raw(sessionCarriesTaskSql('work_session'));

  const rows = await prisma.$queryRaw<SidebarRollupRow[]>(Prisma.sql`
    SELECT proj."id" AS "projectId",
           (SELECT count(*)::int
              FROM "task" t
             WHERE t."owner_id" = ${ownerId}::uuid
               AND t."project_id" = proj."id"
               AND t."id" IN (
                 SELECT candidate."id"
                   FROM "task" candidate
                  WHERE candidate."owner_id" = ${ownerId}::uuid
                    AND candidate."project_id" = proj."id"
                    AND candidate."status" = 'IN_PROGRESS'::"task_status"
                 UNION ALL
                 SELECT work_session."task_id"
                   FROM "session" work_session
                  WHERE work_session."owner_id" = ${ownerId}::uuid
                    AND work_session."task_id" IS NOT NULL
                    AND ${carried}
               )
               AND (${workState}) = 'RUNNING') AS "running",
           tally."done", tally."failed", tally."total",
           activity."lastActivityAt"
      FROM "project" proj
     CROSS JOIN LATERAL (
       SELECT coalesce(sum(c."count") FILTER (WHERE c."status" = 'DONE'), 0)::int AS "done",
              coalesce(sum(c."count") FILTER (WHERE c."status" = 'FAILED'), 0)::int AS "failed",
              coalesce(sum(c."count") FILTER (WHERE c."status" <> 'CANCELLED'), 0)::int AS "total"
         FROM "project_task_status_count" c
        WHERE c."project_id" = proj."id"
     ) tally
     CROSS JOIN LATERAL (
       SELECT max(t."updated_at") AS "lastActivityAt"
         FROM "task" t
        WHERE t."owner_id" = ${ownerId}::uuid
          AND t."project_id" = proj."id"
     ) activity
     WHERE proj."owner_id" = ${ownerId}::uuid
       AND proj."status" = 'OPEN'::"project_status"`);

  return new Map(rows.map((row) => [
    row.projectId,
    {
      taskCounts: { done: row.done, failed: row.failed, total: row.total },
      buckets: { running: row.running },
      lastActivityAt: row.lastActivityAt,
    },
  ]));
}
