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

/** A subject whose own row can never satisfy its independent-verification criterion. */
export function verificationSubjectSql(alias = 't'): string {
  return `${alias}."completion_criterion" = 'VERIFICATION'::"task_completion_criterion"
    AND ${alias}."completion_policy" = 'VERIFICATION_PASSED'::"task_completion_policy"
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
 * an OPEN lifecycle row. A VERIFICATION subject is judged before its stored DONE value, so corrupt
 * or stale status cannot make a missing/failed verifier look complete. FAILED and CANCELLED remain
 * explicit terminal lanes; consequently the bucket sum always reconciles with taskCount.
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
 * eligibility; an OPEN check that cannot pass the shared execute predicate is BLOCKED. An OPEN
 * judgment request committed just before its deterministic verifier task is PENDING, not missing.
 */
function projectTaskVerificationStateSql(subject = 't', check = 'current_verifier'): string {
  return `CASE
    WHEN NOT (${verificationSubjectSql(subject)}) THEN NULL
    WHEN ${check}."id" IS NULL AND EXISTS (
      SELECT 1 FROM "task_judgment_request" pending_verification_request
       WHERE pending_verification_request."task_id" = ${subject}."id"
         AND pending_verification_request."kind" = 'VERIFICATION'
         AND pending_verification_request."recipient_type" = 'VERIFIER_TASK'
         AND pending_verification_request."status" = 'OPEN'
    ) THEN 'PENDING'
    WHEN ${check}."id" IS NULL THEN 'MISSING'
    WHEN ${check}."passed" THEN 'PASSED'
    WHEN (
      (${check}."requestStatus" = 'DECIDED'
       AND ${check}."requestDecision" IN ('FAIL', 'INCONCLUSIVE'))
      OR (${check}."requestStatus" IS NULL
          AND ${check}."verdict" IN ('FAIL', 'INCONCLUSIVE'))
    ) THEN 'FAILED'
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
               verifier_request."status"::text AS "requestStatus",
               verifier_request."decision"::text AS "requestDecision",
               (${verifierPassed}) AS "passed",
               (${verifierRunning}) AS "running",
               (${verifierRunnable}) AS "runnable"
          FROM "task" verifier_task
          LEFT JOIN "task_judgment_request" verifier_request
            ON verifier_request."id" = verifier_task."id"
           AND verifier_request."task_id" = t."id"
           AND verifier_request."kind" = 'VERIFICATION'
           AND verifier_request."recipient_type" = 'VERIFIER_TASK'
           AND verifier_request."recipient_id" = verifier_task."id"::text
         WHERE verifier_task."id" = (${latestVerifier})
      ) current_verifier ON true
     WHERE t."owner_id" = ${ownerId}::uuid
       AND t."project_id" = ${projectId}::uuid
       ${narrowed}`);

  return new Map(rows.map((row) => [row.taskId, {
    workState: row.workState,
    verificationState: row.verificationState,
  }]));
}
