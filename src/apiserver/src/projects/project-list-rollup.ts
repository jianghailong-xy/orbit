import { Prisma } from '@prisma/client';
import type { ProjectStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
 * Every task is classified once with `projectTaskWorkStateSql` and then counted per project. This
 * is the exact same expression panorama, task cards and topology read, including the task-start
 * predicate and canonical verification epoch. A faster local reinterpretation of OPEN is not an
 * acceptable optimization: that was how a verification subject became Ready on one surface while
 * the actual Run path correctly had no work to start.
 */
export async function readProjectListRollups(
  prisma: PrismaService,
  ownerId: string,
  status?: ProjectStatus,
): Promise<Map<string, ProjectListRollup>> {
  const narrowed = status
    ? Prisma.sql`AND proj."status" = ${status}::"project_status"`
    : Prisma.empty;
  // READY is the one lane that walks the dependency graph per row, and on the 109,875-task project
  // measured here that walk was 6.3s of this read's 7.3s — the drawer's project rows waited on it at
  // every launch. Narrowed the way the classifier offers, to rows whose every prerequisite is DONE
  // or retired, the walk runs on a couple of hundred rows and the read takes 0.6–1s, every bucket
  // of all 69 projects unchanged. It is a superset of READY, not a second spelling of it; see the
  // guard.
  const workState = Prisma.raw(projectTaskWorkStateSql('t', {
    readyCandidates: everyPrerequisiteDoneOrRetiredSql('t'),
  }));

  // Each classified task goes straight into its project's count, and nothing holds all of them at
  // once. This read used to be `WITH classified AS MATERIALIZED (...) ... GROUP BY`: a CTE read
  // once is still written to a tuplestore, and for the owner of a 110,247-task project that store
  // outgrew work_mem, so every call wrote a 4.4 MB temp file that nothing read back
  // (pg_stat_statements, 2026-09-29: 564 temp blocks written and 0 read per call, every 15s).
  // The two things the CTE also did are kept on purpose:
  //   - `OFFSET 0` stops the planner pulling the subquery up. Pulled up, each FILTER below gets its
  //     own copy of the whole CASE: 18 subplans became 126 when the CTE was simply inlined.
  //   - one plain aggregate per project, through LATERAL, and no GROUP BY. Grouped, the CASE's
  //     estimated cost (about 17M) dwarfs the few thousand a Sort adds, the planner calls sorting
  //     and hashing a tie and keeps the sorted plan for its order: a sort of every task, which
  //     spills too. A plain aggregate has no strategy to choose.
  // `taskCount > 0` leaves a project without tasks out of the rows, as the grouped join did; the
  // caller gives it `emptyProjectListRollup()`.
  const rows = await prisma.$queryRaw<RollupRow[]>(Prisma.sql`
    SELECT proj."id" AS "projectId",
           rollup."taskCount", rollup."running", rollup."ready", rollup."blocked",
           rollup."awaitingVerification", rollup."done", rollup."failed", rollup."cancelled",
           rollup."lastActivityAt"
      FROM "project" proj
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS "taskCount",
              (count(*) FILTER (WHERE "workState" = 'RUNNING'))::int AS "running",
              (count(*) FILTER (WHERE "workState" = 'READY'))::int AS "ready",
              (count(*) FILTER (WHERE "workState" = 'BLOCKED'))::int AS "blocked",
              (count(*) FILTER (WHERE "workState" = 'AWAITING_VERIFICATION'))::int
                AS "awaitingVerification",
              (count(*) FILTER (WHERE "workState" = 'DONE'))::int AS "done",
              (count(*) FILTER (WHERE "workState" = 'FAILED'))::int AS "failed",
              (count(*) FILTER (WHERE "workState" = 'CANCELLED'))::int AS "cancelled",
              max("updatedAt") AS "lastActivityAt"
         FROM (
           SELECT t."updated_at" AS "updatedAt",
                  (${workState})::text AS "workState"
             FROM "task" t
            WHERE t."owner_id" = ${ownerId}::uuid
              AND t."project_id" = proj."id"
           OFFSET 0
         ) classified
     ) rollup
     WHERE proj."owner_id" = ${ownerId}::uuid ${narrowed}
       AND rollup."taskCount" > 0`);

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
