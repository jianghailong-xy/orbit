import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { manualRunnableTaskSql } from '../tasks/manual-runnable-task-sql';
import {
  latestLiveVerificationCheckIdSql,
  verificationCheckPassedSql,
  verificationSubjectPassedSql,
} from '../tasks/verification-dependency';

/** The exhaustive lifecycle lanes used by every project-level work surface. */
export const PROJECT_TASK_WORK_STATES = [
  'RUNNING',
  'READY',
  'BLOCKED',
  'AWAITING_VERIFICATION',
  'DONE',
  'FAILED',
  'CANCELLED',
] as const;

export type ProjectTaskWorkState = (typeof PROJECT_TASK_WORK_STATES)[number];

/** The current independent verifier's actionable state, only for VERIFICATION subjects. */
export type ProjectTaskVerificationState =
  | 'PENDING'
  | 'BLOCKED'
  | 'RUNNING'
  | 'PASSED'
  | 'FAILED'
  | 'MISSING';

export interface ProjectTaskWorkStateFields {
  workState: ProjectTaskWorkState;
  verificationState: ProjectTaskVerificationState | null;
}

interface ProjectTaskWorkStateRow extends ProjectTaskWorkStateFields {
  taskId: string;
}

/**
 * A gate row: one whose own work could never satisfy it, because it has none.
 *
 * `completion_policy` alone, and deliberately. A `VERIFICATION` criterion says an independent
 * verdict is what settles this task — it says nothing about whether the task has work to do, and a
 * row that has work is one somebody runs, reads progress on and expects to see in RUNNING or READY.
 * Only `VERIFICATION_PASSED` says that nothing here is ever dispatched, which is what makes
 * "waiting for its verifier" the whole truth about the row rather than half of it.
 */
export function verificationSubjectSql(alias = 't'): string {
  return `${alias}."completion_policy" = 'VERIFICATION_PASSED'::"task_completion_policy"
    AND ${alias}."verifies_task_id" IS NULL`;
}

/** A live task-work claim, in the exact spelling the execute/session gates use. */
export function liveTaskWorkSql(alias = 't'): string {
  return `EXISTS (
    SELECT 1 FROM "session" work_session
     WHERE work_session."task_id" = ${alias}."id"
       AND work_session."deleted_at" IS NULL
       AND work_session."starts_task_work" = true
       AND work_session."status" IN ('PENDING'::"run_status", 'RUNNING'::"run_status")
  )`;
}

/**
 * The one classification expression behind panorama, project-list rollups, task cards and graph.
 *
 * READY is not shorthand for OPEN. It is the exact shared manual execute predicate, constrained to
 * an OPEN lifecycle row. A verification GATE ROW is judged before its stored DONE value, so corrupt
 * or stale status cannot make a missing/failed verifier look complete. FAILED and CANCELLED remain
 * explicit terminal lanes; consequently the bucket sum always reconciles with taskCount.
 *
 * AWAITING_VERIFICATION is that gate row's lane and only its lane. A task that declares
 * VERIFICATION and does its own work (`MANUAL`) reaches this expression like any other work row:
 * RUNNING while a Session holds it, READY while the shared execute predicate would start it. It has
 * possibly never been run, and reporting a wait on a check nobody has been asked for yet would put
 * it in the one lane no surface offers a next step from.
 */
export function projectTaskWorkStateSql(alias = 't'): string {
  const verificationSubject = verificationSubjectSql(alias);
  const verificationPassed = verificationSubjectPassedSql(alias);
  return `CASE
    WHEN ${alias}."status" = 'CANCELLED'::"task_status" THEN 'CANCELLED'
    WHEN ${alias}."status" = 'FAILED'::"task_status" THEN 'FAILED'
    WHEN (${verificationSubject}) AND NOT (${verificationPassed}) THEN 'AWAITING_VERIFICATION'
    WHEN ${alias}."status" = 'DONE'::"task_status" THEN 'DONE'
    WHEN ${alias}."status" IN ('OPEN'::"task_status", 'IN_PROGRESS'::"task_status")
         AND (${alias}."status" = 'IN_PROGRESS'::"task_status" OR ${liveTaskWorkSql(alias)})
      THEN 'RUNNING'
    WHEN ${alias}."status" = 'OPEN'::"task_status"
         AND (${manualRunnableTaskSql(alias)}) THEN 'READY'
    ELSE 'BLOCKED'
  END`;
}

/**
 * The canonical verifier detail used beside AWAITING_VERIFICATION.
 *
 * The lateral row uses the same newest-live selector and exact PASS predicate as dependency
 * release. FAIL/INCONCLUSIVE are terminal negative conclusions; a live run wins over static Run
 * eligibility; an OPEN check that cannot pass the shared execute predicate is BLOCKED.
 */
function projectTaskVerificationStateSql(subject = 't', check = 'current_verifier'): string {
  return `CASE
    WHEN NOT (${verificationSubjectSql(subject)}) THEN NULL
    WHEN ${check}."id" IS NULL THEN 'MISSING'
    WHEN ${check}."passed" THEN 'PASSED'
    WHEN ${check}."verdict" IN ('FAIL', 'INCONCLUSIVE') THEN 'FAILED'
    WHEN ${check}."running" THEN 'RUNNING'
    WHEN ${check}."status" = 'OPEN' AND NOT ${check}."runnable" THEN 'BLOCKED'
    ELSE 'PENDING'
  END`;
}

/**
 * Read the canonical state for a bounded set of project tasks. An omitted id list reads all tasks
 * and is used only by graph endpoints that already enforce their own project-size ceiling.
 */
export async function readProjectTaskWorkStates(
  prisma: PrismaService,
  ownerId: string,
  projectId: string,
  taskIds?: readonly string[],
): Promise<Map<string, ProjectTaskWorkStateFields>> {
  if (taskIds?.length === 0) return new Map();
  const narrowed = taskIds
    ? Prisma.sql`AND t."id" IN (${Prisma.join(taskIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
  return readTaskWorkStates(prisma, Prisma.sql`t."owner_id" = ${ownerId}::uuid
       AND t."project_id" = ${projectId}::uuid
       ${narrowed}`);
}

/**
 * The same fields for one task, found by id rather than through a project: the task detail reads a
 * subject's verifier wherever the subject is filed, and the verifier selector's scope predicate
 * already pairs a project-less check with a project-less subject. Null for an id the owner lacks.
 */
export async function readTaskWorkState(
  prisma: PrismaService,
  ownerId: string,
  taskId: string,
): Promise<ProjectTaskWorkStateFields | null> {
  const states = await readTaskWorkStates(
    prisma,
    Prisma.sql`t."owner_id" = ${ownerId}::uuid AND t."id" = ${taskId}::uuid`,
  );
  return states.get(taskId) ?? null;
}

/**
 * The check that currently settles a task, as a row rather than as a lane.
 *
 * The task detail shows the check under the subject it checks, and it must be the SAME check the
 * lanes and the release rule read — so this asks `latestLiveVerificationCheckIdSql`, which is that
 * one definition, rather than ordering rows here. Null for a task nothing checks, which is the
 * ordinary case: only rows somebody filed a check for have one.
 */
export async function readCurrentVerifier(
  prisma: PrismaService,
  ownerId: string,
  taskId: string,
): Promise<TaskVerifierRow | null> {
  const rows = await prisma.$queryRaw<TaskVerifierRow[]>(Prisma.sql`
    SELECT check_task."id" AS "id",
           check_task."title" AS "title",
           check_task."status"::text AS "status",
           check_task."verdict"::text AS "verdict"
      FROM "task" t
      JOIN "task" check_task
        ON check_task."id" = (${Prisma.raw(latestLiveVerificationCheckIdSql('t'))})
     WHERE t."owner_id" = ${ownerId}::uuid AND t."id" = ${taskId}::uuid`);
  return rows[0] ?? null;
}

/** One check, as the surface that names it needs it: what it is called, and where it stands. */
export interface TaskVerifierRow {
  id: string;
  title: string;
  /** `task_status` of the check row. */
  status: string;
  /** §13.2: its conclusion, null while it has not written one. */
  verdict: string | null;
}

/** One query shape for every reader above, so a project page and a task detail cannot disagree. */
async function readTaskWorkStates(
  prisma: PrismaService,
  where: Prisma.Sql,
): Promise<Map<string, ProjectTaskWorkStateFields>> {
  const state = Prisma.raw(projectTaskWorkStateSql('t'));
  const verificationState = Prisma.raw(projectTaskVerificationStateSql());
  const latestVerifier = Prisma.raw(latestLiveVerificationCheckIdSql('t'));
  const verifierPassed = Prisma.raw(verificationCheckPassedSql('verifier_task', 't'));
  const verifierRunning = Prisma.raw(liveTaskWorkSql('verifier_task'));
  const verifierRunnable = Prisma.raw(manualRunnableTaskSql('verifier_task'));

  const rows = await prisma.$queryRaw<ProjectTaskWorkStateRow[]>(Prisma.sql`
    SELECT t."id" AS "taskId",
           (${state})::text AS "workState",
           (${verificationState})::text AS "verificationState"
      FROM "task" t
      LEFT JOIN LATERAL (
        SELECT verifier_task."id",
               verifier_task."status"::text AS "status",
               verifier_task."verdict"::text AS "verdict",
               (${verifierPassed}) AS "passed",
               (${verifierRunning}) AS "running",
               (${verifierRunnable}) AS "runnable"
          FROM "task" verifier_task
         WHERE verifier_task."id" = (${latestVerifier})
      ) current_verifier ON true
     WHERE ${where}`);

  return new Map(rows.map((row) => [row.taskId, {
    workState: row.workState,
    verificationState: row.verificationState,
  }]));
}
