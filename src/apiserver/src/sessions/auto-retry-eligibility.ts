import { Prisma, ProjectStatus } from '@prisma/client';

import { releaseWasFailureFilter, releaseWasFailureSql } from '../common/session-release';
import { sessionTurnStateSql, turnStateFilter } from './session-turn-state';

/**
 * The list pause, asked where a retry is RELEASED rather than where it was armed.
 *
 * `task.dispatch_hold` is a paused list projected onto the task row, and every other automatic
 * starter in the deployment reads it: all four candidate scans (tasks.service.ts
 * AUTO_RUN_READY_SQL, PROJECT_INDEPENDENT_READY_SQL, AUTO_RUN_RETRY_CANDIDATE_SQL,
 * SCHEDULED_DUE_SQL) and the manual Run door. This sweep did not, and the result was one pause
 * with two answers: a task that opts into auto-run has the reaper stand aside for the scheduler
 * (`armRetry` in reaper.service.ts) and the scan that would re-select it asks the column, so the
 * pause held; a task that does not opt in is retried HERE, and the pause did not. Nothing about
 * that difference is a policy — it is which mechanism happens to own the retry.
 *
 * Stated positively and read off the task's own column, which is the shape AUTO_RUN_READY_SQL's
 * comment insists on after deleting 112 paused-able lists released 55,513 tasks: a veto that
 * cannot be expressed reads as permission.
 *
 * Only the TASK'S WORK is held. A salvage conversation (`starts_task_work = false`) is somebody
 * asking about a run that already happened, and re-sending the words a quota killed answers that
 * person — pausing a campaign is not an instruction to stop answering them. It is the same line
 * §13.1 AG6 draws between a session doing a task's work and one held about it.
 *
 * Applied at the due read and again in the claim, and deliberately NOWHERE ELSE — not at either
 * place a retry is armed (the reaper's offline branch, ingestion's quota branch). A person pauses
 * a list when things are already going wrong, so at the moment those two arm, the hold usually
 * does not exist yet: a check there is a veto asked before the fact it is about, and an arm that
 * was never written cannot be reconsidered when the pause lifts. Asked here it is asked against
 * the world at the instant of the resume, once, for every arming path there is.
 */
export const NOT_DISPATCH_HELD: Prisma.SessionWhereInput = {
  OR: [
    { taskId: null },
    { startsTaskWork: false },
    { task: { dispatchHold: false } },
  ],
};

/**
 * The other standing veto on starting a task's work: its project was cancelled
 * (projectNotCancelledSql, which every automatic door applies). Asked where the hold is asked and
 * for the same reason — against the world at the instant of the resume, so a project cancelled
 * after the retry was armed is honoured, and one reopened before it comes due is not held.
 */
export const NOT_IN_CANCELLED_PROJECT: Prisma.SessionWhereInput = {
  OR: [
    { taskId: null },
    { startsTaskWork: false },
    { task: { projectId: null } },
    { task: { project: { status: { not: ProjectStatus.CANCELLED } } } },
  ],
};

/**
 * Whether the auto-retry sweep may fire (or give up) the retry armed on a session, minus the clock
 * (`retry_at <= now`) that each reader asks for itself. The sweep reads the Prisma form and the
 * managed runner's DUE_RETRY work reads the SQL form: an arm the sweep can never fire — a completed,
 * trashed, held or cancelled-project session — must not keep a runner awake or un-rollable, so the
 * two are written side by side and compared by managed-runners/managed-runner-dormant-retry.pg.spec.ts.
 */
export function autoRetryEligibleWhere(): Prisma.SessionWhereInput {
  return {
    deletedAt: null,
    completedAt: null,
    // A landing is never re-sent: its AWAITING_INPUT means only that the subject is open.
    sessionKind: 'CONVERSATION',
    OR: [
      // Parked (plan §2.1: A), no end asked.
      { ...turnStateFilter([null]), cancelRequestedAt: null },
      // Released by a failure (common/session-release.ts).
      releaseWasFailureFilter(),
    ],
    AND: [NOT_DISPATCH_HELD, NOT_IN_CANCELLED_PROJECT],
  };
}

/** `autoRetryEligibleWhere` as SQL on the session row named `alias` (a constant, never input). */
export function autoRetryEligibleSql(alias: string): Prisma.Sql {
  const s = Prisma.raw(alias);
  return Prisma.sql`(${s}."deleted_at" IS NULL AND ${s}."completed_at" IS NULL AND ${s}."kind" = 'CONVERSATION'
    AND ((${s}."finished_at" IS NULL AND ${sessionTurnStateSql(alias)} IS NULL AND ${s}."cancel_requested_at" IS NULL)
         OR ${releaseWasFailureSql(alias)})
    AND (${s}."task_id" IS NULL OR ${s}."starts_task_work" = false
         OR EXISTS (SELECT 1 FROM "task" t WHERE t."id" = ${s}."task_id" AND t."dispatch_hold" = false))
    AND (${s}."task_id" IS NULL OR ${s}."starts_task_work" = false
         OR EXISTS (SELECT 1 FROM "task" t LEFT JOIN "project" p ON p."id" = t."project_id"
                     WHERE t."id" = ${s}."task_id" AND (t."project_id" IS NULL OR p."status" <> 'CANCELLED'))))`;
}
