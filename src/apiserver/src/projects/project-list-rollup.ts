import { Prisma } from '@prisma/client';
import type { ProjectStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
 * Every task is classified once with `projectTaskWorkStateSql` and then grouped by project. This
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
  const workState = Prisma.raw(projectTaskWorkStateSql('t'));

  const rows = await prisma.$queryRaw<RollupRow[]>(Prisma.sql`
    WITH classified AS MATERIALIZED (
      SELECT t."project_id" AS "projectId",
             t."updated_at" AS "updatedAt",
             (${workState})::text AS "workState"
        FROM "project" proj
        JOIN "task" t ON t."owner_id" = ${ownerId}::uuid
                     AND t."project_id" = proj."id"
       WHERE proj."owner_id" = ${ownerId}::uuid ${narrowed}
    )
    SELECT "projectId",
           count(*)::int AS "taskCount",
           (count(*) FILTER (WHERE "workState" = 'RUNNING'))::int AS "running",
           (count(*) FILTER (WHERE "workState" = 'READY'))::int AS "ready",
           (count(*) FILTER (WHERE "workState" = 'BLOCKED'))::int AS "blocked",
           (count(*) FILTER (WHERE "workState" = 'AWAITING_VERIFICATION'))::int
             AS "awaitingVerification",
           (count(*) FILTER (WHERE "workState" = 'DONE'))::int AS "done",
           (count(*) FILTER (WHERE "workState" = 'FAILED'))::int AS "failed",
           (count(*) FILTER (WHERE "workState" = 'CANCELLED'))::int AS "cancelled",
           max("updatedAt") AS "lastActivityAt"
      FROM classified
     GROUP BY "projectId"`);

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
