import { Prisma } from '@prisma/client';
import type { TaskIntegrationView } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { isCodeTaskSql, lineStartedSql, taskLandingSql } from './project-criterion-landing';

/**
 * Where each task on a page sits between "done" and "on main"
 * (`docs/project-integration-line-contract.md` §2.7, §7.3 V10).
 *
 * Three facts per task, and the order they are read in IS the answer:
 *
 *  1. **A receipt.** If one exists, the work is THERE — on main, or on the project's own branch —
 *     and nothing a job says afterwards changes that. Read first for that reason: a job row that
 *     was superseded, cancelled or re-queued after the landing must not un-land it.
 *  2. **An open exception item.** A conflict, a failed check or an integration error that somebody
 *     still owes an answer for. Read before the job's own state because it carries the thing the
 *     job does not: WHO has it, which is the difference between "being worked on" and "waiting for
 *     you".
 *  3. **The newest job.** Queued, running, or stopped at a terminal state nobody filed an item for.
 *
 * `NOT_APPLICABLE` covers everything else and is the ordinary answer: a codeless task, a task in a
 * project that has not started integrating, and every task of every project that has no line.
 *
 * One query for the whole page, never one per row. The page already pays one pass over the graph
 * for the dependency facts; this is the second, and it is bounded by the page rather than by the
 * project.
 */

/** The item kinds that mean "this task's integration stopped and somebody owes an answer" (§4.2). */
const INTEGRATION_ITEM_KINDS = ['INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR'];

interface TaskIntegrationRow {
  taskId: string;
  landing: string;
  isCode: boolean;
  lineStarted: boolean;
  jobId: string | null;
  jobState: string | null;
  jobStartedAt: Date | null;
  jobCreatedAt: Date | null;
  jobFinishedAt: Date | null;
  itemId: string | null;
  itemKind: string | null;
  itemAssignee: string | null;
  itemCreatedAt: Date | null;
  landedAt: Date | null;
}

const NOT_APPLICABLE: TaskIntegrationView<Date> = {
  state: 'NOT_APPLICABLE',
  since: null,
  handler: null,
  openItemId: null,
  jobId: null,
  checksRunningForMs: null,
};

/** The item kind an exception was filed under, as the task-row state it puts the task in. */
function stateForItem(kind: string): TaskIntegrationView['state'] | null {
  switch (kind) {
    case 'INTEGRATION_CONFLICT': return 'CONFLICT';
    case 'INTEGRATION_CHECK_FAILED': return 'CHECK_FAILED';
    case 'INTEGRATION_ERROR': return 'ERROR';
    default: return null;
  }
}

/**
 * A job's own state, for a task with no receipt and no open item.
 *
 * `READY` is a promotion that passed its check and is waiting for the account owner to confirm the
 * merge into main (§3.3), which is the one state where the person who has to act is the owner and
 * nobody filed an item to say so. The terminal states that DID file an item are handled above this;
 * reaching one here means the item was resolved without the work landing, and the honest answer is
 * that this task is between attempts — `NOT_APPLICABLE`, not a failure nobody owns.
 */
function stateForJob(state: string): TaskIntegrationView['state'] | null {
  switch (state) {
    case 'QUEUED': return 'QUEUED';
    case 'RUNNING': return 'RUNNING';
    case 'READY': return 'AWAITING_OWNER';
    default: return null;
  }
}

/** One row folded into the view, in the precedence the module comment states. */
export function taskIntegrationOf(row: TaskIntegrationRow, now: Date): TaskIntegrationView<Date> {
  if (row.landing === 'ON_UPSTREAM') {
    return { ...NOT_APPLICABLE, state: 'ON_UPSTREAM', since: row.landedAt, jobId: row.jobId };
  }
  if (row.landing === 'ON_INTEGRATION_LINE') {
    return { ...NOT_APPLICABLE, state: 'ON_INTEGRATION_LINE', since: row.landedAt, jobId: row.jobId };
  }
  // Nothing to land, or nowhere to land it: both are "this row has no integration", and neither is
  // a state the platform is going to move out of on its own.
  if (!row.isCode || !row.lineStarted) return NOT_APPLICABLE;

  const itemState = row.itemKind ? stateForItem(row.itemKind) : null;
  if (itemState) {
    return {
      state: itemState,
      since: row.itemCreatedAt,
      handler: row.itemAssignee === 'OWNER' ? 'OWNER' : 'COORDINATOR',
      openItemId: row.itemId,
      jobId: row.jobId,
      checksRunningForMs: null,
    };
  }

  const jobState = row.jobState ? stateForJob(row.jobState) : null;
  if (!jobState) {
    // Done code work on a started line with no job yet: the enqueue is the next thing that happens
    // to it (§2.3 J-T1d backfills the ones that predate the line). Queued is what it IS about to
    // be, and the lane it belongs in either way — the alternative, filing it under "Landed", would
    // claim a receipt nobody wrote.
    return { ...NOT_APPLICABLE, state: 'QUEUED' };
  }
  const startedAt = row.jobStartedAt ?? row.jobCreatedAt;
  return {
    state: jobState,
    since: jobState === 'QUEUED' ? row.jobCreatedAt : startedAt,
    // A job the platform is still working on is nobody's to act on. The handler appears when it
    // stops, which is when an item is filed.
    handler: jobState === 'AWAITING_OWNER' ? 'OWNER' : null,
    openItemId: null,
    jobId: row.jobId,
    checksRunningForMs:
      jobState === 'RUNNING' && startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : null,
  };
}

export async function readTaskIntegrationViews(
  prisma: PrismaService,
  ownerId: string,
  projectId: string,
  taskIds: readonly string[],
): Promise<Map<string, TaskIntegrationView<Date>>> {
  if (taskIds.length === 0) return new Map();
  const landing = Prisma.raw(taskLandingSql('t'));
  const isCode = Prisma.raw(isCodeTaskSql('t'));
  const lineStarted = Prisma.raw(lineStartedSql('t'));
  const ids = Prisma.join(taskIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await prisma.$queryRaw<TaskIntegrationRow[]>(Prisma.sql`
    WITH scoped AS (
      SELECT t."id" AS "taskId",
             (${landing})::text AS "landing",
             (${isCode}) AS "isCode",
             (${lineStarted}) AS "lineStarted"
        FROM "task" t
       WHERE t."id" IN (${ids})
         AND t."owner_id" = ${ownerId}::uuid
         AND t."project_id" = ${projectId}::uuid
    ),
    -- The newest ATTEMPT, by generation: a second generation exists because somebody asked for one
    -- or the task branch moved (§2.1), and an older one says nothing about where the work is now.
    newest_job AS (
      SELECT DISTINCT ON (j."task_id")
             j."task_id", j."id", j."state", j."created_at", j."started_at", j."finished_at"
        FROM "project_integration_job" j
       WHERE j."task_id" IN (${ids})
         AND j."owner_id" = ${ownerId}::uuid
         AND j."kind" = 'LAND_TASK'
       ORDER BY j."task_id", j."generation" DESC, j."created_at" DESC, j."id" DESC
    ),
    -- The newest OPEN exception of the three integration kinds. Newest rather than oldest: a task
    -- whose second attempt conflicted is described by that conflict, not by the one before it.
    open_item AS (
      SELECT DISTINCT ON (i."task_id") i."task_id", i."id", i."kind", i."assignee", i."created_at"
        FROM "project_open_item" i
       WHERE i."task_id" IN (${ids})
         AND i."owner_id" = ${ownerId}::uuid
         AND i."state" = 'OPEN'
         AND i."kind" IN (${Prisma.join(INTEGRATION_ITEM_KINDS)})
       ORDER BY i."task_id", i."created_at" DESC, i."id" DESC
    ),
    -- When the work arrived, for the row that says how long it has been there.
    landed_at AS (
      SELECT r."task_id", max(r."created_at") AS "at"
        FROM "session_merge_receipt" r
       WHERE r."task_id" IN (${ids})
         AND r."result" IN ('MERGED', 'ALREADY_MERGED')
       GROUP BY r."task_id"
    )
    SELECT scoped."taskId", scoped."landing", scoped."isCode", scoped."lineStarted",
           newest_job."id" AS "jobId", newest_job."state" AS "jobState",
           newest_job."started_at" AS "jobStartedAt", newest_job."created_at" AS "jobCreatedAt",
           newest_job."finished_at" AS "jobFinishedAt",
           open_item."id" AS "itemId", open_item."kind" AS "itemKind",
           open_item."assignee" AS "itemAssignee", open_item."created_at" AS "itemCreatedAt",
           landed_at."at" AS "landedAt"
      FROM scoped
      LEFT JOIN newest_job ON newest_job."task_id" = scoped."taskId"
      LEFT JOIN open_item ON open_item."task_id" = scoped."taskId"
      LEFT JOIN landed_at ON landed_at."task_id" = scoped."taskId"`);

  const now = new Date();
  return new Map(rows.map((row) => [row.taskId, taskIntegrationOf(row, now)]));
}
