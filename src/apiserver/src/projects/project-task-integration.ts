import { Prisma } from '@prisma/client';
import type {
  IntegrationJobPhase,
  IntegrationJobState,
  LandTaskBlockingReason,
  LandTaskBlockingReasonCode,
  LandTaskIntegrationView,
  ProjectLandTask,
  TaskIntegrationView,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SESSION_RUNNER_OFFLINE_AFTER_MS } from '../sessions/session-state';
import { isCodeTaskSql, lineStartedSql, taskLandingSql } from './project-criterion-landing';
import { INTEGRATION_JOB_CLAIM } from './project-integration-job';

/**
 * Where each task on a page sits between "done" and "on main"
 * (`docs/project-integration-line-contract.md` §2.7, §7.3 V10).
 *
 * Three facts per task, and the order they are read in IS the answer:
 *
 *  1. **A receipt.** If one exists, the work is THERE — on main, or on the project's own branch —
 *     and nothing a job says afterwards changes that. Read first for that reason: a job row that
 *     was superseded, cancelled or re-queued after the landing must not un-land it.
 *  2. **An open exception item, unless its retry is in flight.** A conflict, a failed check or an
 *     integration error that somebody still owes an answer for. Read before the job's state because
 *     it names WHO has it, which distinguishes "being worked on" from "waiting for you".
 *  3. **The newest job.** Queued, running, or stopped at a terminal state nobody filed an item for.
 *
 * `NOT_APPLICABLE` covers everything else and is the ordinary answer: a codeless task, a task in a
 * project that has not started integrating, and every task of every project that has no line.
 *
 * Beside that answer, every view carries `landTask`: the newest LAND_TASK generation as its own row
 * says it (§2.7a) — state, phase, generation, the four instants, the target ref, the queue wait and
 * why it waits or where it stopped. The task's page, the project's task rows and the project's
 * integration view all read it from here, so the three cannot describe one landing differently.
 * It never feeds the precedence above: a newer queued generation does not un-land a receipt.
 *
 * One query for the whole page, never one per row. The page already pays one pass over the graph
 * for the dependency facts; this is the second, and it is bounded by the page rather than by the
 * project.
 */

/** The item kinds that mean "this task's integration stopped and somebody owes an answer" (§4.2). */
const INTEGRATION_ITEM_KINDS = ['INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR'];

/** Why the runner a queued landing needs is not claiming it, as the read below decides it. */
type RunnerWait = 'NO_RUNNER' | 'OFFLINE' | 'DRAINING' | 'OUTDATED';

interface TaskIntegrationRow {
  taskId: string;
  taskStatus: string;
  landing: string;
  isCode: boolean;
  lineStarted: boolean;
  jobId: string | null;
  jobState: string | null;
  jobPhase: string | null;
  jobGeneration: number | null;
  jobTargetRef: string | null;
  jobStartedAt: Date | null;
  jobClaimedAt: Date | null;
  jobHeartbeatAt: Date | null;
  jobCreatedAt: Date | null;
  jobFinishedAt: Date | null;
  jobErrorCode: string | null;
  jobConflictCount: number | null;
  /** The first check that did not pass, for a CHECK_FAILED attempt. */
  jobFailedCheck: { name?: unknown; exitCode?: unknown; expectedExitCode?: unknown; timedOut?: unknown } | null;
  /** For a QUEUED attempt only: the first claim condition (§2.3 J-T2) that holds it back. */
  queueBlockCode: LandTaskBlockingReasonCode | null;
  runnerWait: RunnerWait | null;
  runnerName: string | null;
  blockingJobId: string | null;
  blockingJobKind: string | null;
  blockingTaskTitle: string | null;
  blockingOpenItemId: string | null;
  itemId: string | null;
  itemKind: string | null;
  itemAssignee: string | null;
  itemCreatedAt: Date | null;
  itemHandlingJobId: string | null;
  landedAt: Date | null;
}

const NOT_APPLICABLE: TaskIntegrationView<Date> = {
  state: 'NOT_APPLICABLE',
  since: null,
  handler: null,
  openItemId: null,
  jobId: null,
  checksRunningForMs: null,
  landTask: null,
};

const CHECK_NAMES: Record<string, string> = {
  TASK_ACCEPTANCE: 'the task’s acceptance command',
  MERGE_CHECK: 'the merge check',
};

const RUNNING_ELSEWHERE: Record<string, string> = {
  LAND_TASK: 'another landing',
  CHECK_PROMOTION: 'a check of the merge into main',
  LAND_PROMOTION: 'the merge into main',
};

/** The sentence a page prints for a reason, built from the facts the row read. */
function reasonSummary(code: LandTaskBlockingReasonCode, row: TaskIntegrationRow): string {
  const runner = row.runnerName ? `runner ${row.runnerName}` : 'the runner';
  switch (code) {
    case 'CANCELLING':
      return 'Not started: a cancel was asked for, so the queue will not run it';
    case 'WAITING_TASK_WORK':
      return 'Waiting to land: the task’s work session is still running, and its branch can still move';
    case 'WAITING_MAIN_SYNC':
      return row.blockingTaskTitle
        ? `Waiting for the project line to sync: the landing of “${row.blockingTaskTitle}” could not merge upstream into this branch, and its conflict is still open`
        : 'Waiting for the project line to sync: an earlier landing could not merge upstream into this branch, and its conflict is still open';
    case 'WAITING_SERIAL_SLOT': {
      const what = row.blockingTaskTitle
        ? `the landing of “${row.blockingTaskTitle}”`
        : RUNNING_ELSEWHERE[row.blockingJobKind ?? ''] ?? 'another integration job';
      return `Waiting to land: ${what} is running on this branch first`;
    }
    case 'WAITING_RUNNER':
      switch (row.runnerWait) {
        case 'NO_RUNNER': return 'Waiting for a runner: the work’s workspace has no runner to land it';
        case 'DRAINING': return `Waiting for ${runner}: it is draining and takes no new jobs`;
        case 'OUTDATED': return `Waiting for ${runner}: its version does not take integration jobs`;
        default: return `Waiting for ${runner}: it is offline`;
      }
    case 'WAITING_DISPATCH':
      return `Waiting to land: next for ${runner}, which claims it on its next heartbeat`;
    case 'CONFLICT': {
      const files = row.jobConflictCount
        ? ` (${row.jobConflictCount} conflicting file${row.jobConflictCount === 1 ? '' : 's'})`
        : '';
      return row.jobPhase === 'MAIN_SYNC'
        ? `Stopped at a conflict: upstream could not be merged into the target branch${files}`
        : `Stopped at a conflict: the task’s branch could not be combined with the target branch${files}`;
    }
    case 'CHECK_FAILED': {
      const check = row.jobFailedCheck;
      if (!check) return 'Checks failed on the combined tree';
      const name = CHECK_NAMES[String(check.name)] ?? 'a check';
      if (check.timedOut === true) return `Checks failed on the combined tree: ${name} timed out`;
      return typeof check.exitCode === 'number' && typeof check.expectedExitCode === 'number'
        ? `Checks failed on the combined tree: ${name} exited ${check.exitCode} (expected ${check.expectedExitCode})`
        : `Checks failed on the combined tree: ${name} did not pass`;
    }
    case 'ERROR':
      return `Landing failed${row.jobPhase ? ` at ${row.jobPhase}` : ''}${row.jobErrorCode ? `: ${row.jobErrorCode}` : ''}`;
  }
}

/** The newest attempt, as its own row says it; null for a task that has no LAND_TASK. */
function landTaskOf(row: TaskIntegrationRow, now: Date): LandTaskIntegrationView<Date> | null {
  if (!row.jobId || !row.jobState || !row.jobCreatedAt || row.jobGeneration === null || !row.jobTargetRef) {
    return null;
  }
  const stopped = row.jobState === 'CONFLICT' || row.jobState === 'CHECK_FAILED' || row.jobState === 'ERROR';
  const code: LandTaskBlockingReasonCode | null = row.jobState === 'QUEUED'
    ? row.queueBlockCode ?? 'WAITING_DISPATCH'
    : stopped ? row.jobState as LandTaskBlockingReasonCode : null;
  let blockingReason: LandTaskBlockingReason | null = null;
  if (code) {
    blockingReason = { code, summary: reasonSummary(code, row) };
    if ((code === 'WAITING_MAIN_SYNC' || code === 'WAITING_SERIAL_SLOT') && row.blockingJobId) {
      blockingReason.jobId = row.blockingJobId;
    }
    if (code === 'WAITING_MAIN_SYNC' && row.blockingOpenItemId) {
      blockingReason.openItemId = row.blockingOpenItemId;
    }
  }
  // The queue wait ends at the claim the attempt is (or was last) running under. A landing claimed
  // before its task's work settled goes back to QUEUED with its claim cleared and its first start
  // kept, so a queued attempt counts from the enqueue, never from that interrupted start.
  const waitEnd = row.jobState === 'QUEUED' ? now : row.jobClaimedAt ?? row.jobFinishedAt ?? now;
  return {
    jobId: row.jobId,
    state: row.jobState as IntegrationJobState,
    phase: row.jobPhase as IntegrationJobPhase | null,
    generation: String(row.jobGeneration),
    queuedAt: row.jobCreatedAt,
    startedAt: row.jobStartedAt,
    heartbeatAt: row.jobHeartbeatAt,
    finishedAt: row.jobFinishedAt,
    targetRef: row.jobTargetRef,
    waitMs: Math.max(0, waitEnd.getTime() - row.jobCreatedAt.getTime()),
    blockingReason,
  };
}

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
  const none = { ...NOT_APPLICABLE, landTask: landTaskOf(row, now) };
  if (row.landing === 'ON_UPSTREAM') {
    return { ...none, state: 'ON_UPSTREAM', since: row.landedAt, jobId: row.jobId };
  }
  if (row.landing === 'ON_INTEGRATION_LINE') {
    return { ...none, state: 'ON_INTEGRATION_LINE', since: row.landedAt, jobId: row.jobId };
  }
  // Nothing to land, or nowhere to land it: both are "this row has no integration", and neither is
  // a state the platform is going to move out of on its own.
  if (!row.isCode || !row.lineStarted) return none;

  const itemState = row.itemKind ? stateForItem(row.itemKind) : null;
  // A retry leaves the old failure OPEN until it succeeds or fails again. Its explicit handling
  // link is the evidence that the new queued/running job is answering that failure; an unrelated
  // job must not hide an outstanding exception.
  const retryInFlight = row.itemHandlingJobId !== null && row.itemHandlingJobId === row.jobId
    && (row.jobState === 'QUEUED' || row.jobState === 'RUNNING');
  if (itemState && !retryInFlight) {
    return {
      ...none,
      state: itemState,
      since: row.itemCreatedAt,
      handler: row.itemAssignee === 'OWNER' ? 'OWNER' : 'COORDINATOR',
      openItemId: row.itemId,
      jobId: row.jobId,
    };
  }

  const jobState = row.jobState ? stateForJob(row.jobState) : null;
  if (!jobState) {
    if (row.taskStatus !== 'DONE') return none;
    // Done code work on a started line with no job yet: the enqueue is the next thing that happens
    // to it (§2.3 J-T1d backfills the ones that predate the line). Queued is what it IS about to
    // be, and the lane it belongs in either way — the alternative, filing it under "Landed", would
    // claim a receipt nobody wrote.
    return { ...none, state: 'QUEUED' };
  }
  const startedAt = row.jobStartedAt ?? row.jobCreatedAt;
  return {
    ...none,
    state: jobState,
    since: jobState === 'QUEUED' ? row.jobCreatedAt : startedAt,
    // A job the platform is still working on is nobody's to act on. The handler appears when it
    // stops, which is when an item is filed.
    handler: jobState === 'AWAITING_OWNER' ? 'OWNER' : null,
    jobId: row.jobId,
    checksRunningForMs:
      jobState === 'RUNNING' && row.jobPhase === 'CHECK' && startedAt
        ? Math.max(0, now.getTime() - startedAt.getTime()) : null,
  };
}

export async function readTaskIntegrationViews(
  prisma: Pick<PrismaService, '$queryRaw'>,
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
      SELECT t."id" AS "taskId", t."status"::text AS "taskStatus",
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
    -- This project's own line only: a task filed elsewhere before keeps that line's jobs there.
    newest_job AS (
      SELECT DISTINCT ON (j."task_id")
             j."task_id", j."id", j."state", j."phase", j."generation", j."target_ref",
             j."serial_key", j."session_id", j."cancel_requested_at", j."error_code",
             cardinality(j."conflicts") AS "conflict_count", j."checks",
             j."created_at", j."started_at", j."claimed_at", j."heartbeat_at", j."finished_at"
        FROM "project_integration_job" j
       WHERE j."task_id" IN (${ids})
         AND j."owner_id" = ${ownerId}::uuid
         AND j."project_id" = ${projectId}::uuid
         AND j."kind" = 'LAND_TASK'
       ORDER BY j."task_id", j."generation" DESC, j."created_at" DESC, j."id" DESC
    ),
    -- The newest OPEN exception of the three integration kinds. Newest rather than oldest: a task
    -- whose second attempt conflicted is described by that conflict, not by the one before it.
    open_item AS (
      SELECT DISTINCT ON (i."task_id") i."task_id", i."id", i."kind", i."assignee", i."created_at",
             i."handling_job_id"
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
    SELECT scoped."taskId", scoped."taskStatus", scoped."landing", scoped."isCode", scoped."lineStarted",
           newest_job."id" AS "jobId", newest_job."state" AS "jobState",
           newest_job."phase" AS "jobPhase", newest_job."generation" AS "jobGeneration",
           newest_job."target_ref" AS "jobTargetRef",
           newest_job."started_at" AS "jobStartedAt", newest_job."claimed_at" AS "jobClaimedAt",
           newest_job."heartbeat_at" AS "jobHeartbeatAt", newest_job."created_at" AS "jobCreatedAt",
           newest_job."finished_at" AS "jobFinishedAt",
           newest_job."error_code" AS "jobErrorCode", newest_job."conflict_count" AS "jobConflictCount",
           failed_check."check" AS "jobFailedCheck",
           -- The claim's own conditions (integration-job-relay.ts claimOne), in its order, for the
           -- one state they decide: why a QUEUED attempt has not been claimed yet.
           CASE WHEN newest_job."state" = 'QUEUED' THEN
             CASE
               WHEN newest_job."cancel_requested_at" IS NOT NULL THEN 'CANCELLING'
               WHEN EXISTS (
                 SELECT 1 FROM "session" work
                  WHERE work."task_id" = scoped."taskId"
                    AND work."starts_task_work" = true
                    AND work."deleted_at" IS NULL AND work."finished_at" IS NULL
               ) THEN 'WAITING_TASK_WORK'
               WHEN sync_block."jobId" IS NOT NULL THEN 'WAITING_MAIN_SYNC'
               WHEN runner_wait."wait" IS NOT NULL THEN 'WAITING_RUNNER'
               WHEN running_block."jobId" IS NOT NULL THEN 'WAITING_SERIAL_SLOT'
               ELSE 'WAITING_DISPATCH'
             END
           END AS "queueBlockCode",
           runner_wait."wait" AS "runnerWait", runner_wait."name" AS "runnerName",
           -- What holds it is named only when it is this owner's: a serial key is a repository and a
           -- ref, and another account's project may land on the same one.
           CASE WHEN sync_block."jobId" IS NOT NULL THEN
                  CASE WHEN sync_block."ownerId" = ${ownerId}::uuid THEN sync_block."jobId" END
                WHEN running_block."ownerId" = ${ownerId}::uuid THEN running_block."jobId"
           END AS "blockingJobId",
           CASE WHEN sync_block."jobId" IS NULL AND running_block."ownerId" = ${ownerId}::uuid
                THEN running_block."kind" END AS "blockingJobKind",
           CASE WHEN sync_block."jobId" IS NOT NULL THEN
                  CASE WHEN sync_block."ownerId" = ${ownerId}::uuid THEN sync_block."taskTitle" END
                WHEN running_block."ownerId" = ${ownerId}::uuid THEN running_block."taskTitle"
           END AS "blockingTaskTitle",
           CASE WHEN sync_block."ownerId" = ${ownerId}::uuid THEN sync_block."openItemId" END AS "blockingOpenItemId",
           open_item."id" AS "itemId", open_item."kind" AS "itemKind",
           open_item."assignee" AS "itemAssignee", open_item."created_at" AS "itemCreatedAt",
           open_item."handling_job_id" AS "itemHandlingJobId",
           landed_at."at" AS "landedAt"
      FROM scoped
      LEFT JOIN newest_job ON newest_job."task_id" = scoped."taskId"
      LEFT JOIN open_item ON open_item."task_id" = scoped."taskId"
      LEFT JOIN landed_at ON landed_at."task_id" = scoped."taskId"
      LEFT JOIN LATERAL (
        SELECT c AS "check"
          FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(newest_job."checks") = 'array' THEN newest_job."checks" ELSE '[]'::jsonb END
               ) c
         WHERE newest_job."state" = 'CHECK_FAILED'
           AND (c->>'timedOut' = 'true' OR c->'exitCode' IS DISTINCT FROM c->'expectedExitCode')
         LIMIT 1
      ) failed_check ON true
      -- The claim hands a job only to the runner of the work session's workspace, and only on a
      -- heartbeat from a process holding a lease, not draining, declaring integration jobs (J-T2).
      -- Silent for longer than the session queue allows is offline here too (session-state.ts).
      -- One row for every queued attempt, so a session or workspace that is gone reads NO_RUNNER.
      LEFT JOIN LATERAL (
        SELECT CASE
                 WHEN runner."id" IS NULL THEN 'NO_RUNNER'
                 WHEN runner."status" = 'OFFLINE' OR runner."last_heartbeat_at" IS NULL
                   OR runner."last_heartbeat_at"
                      < now() - (${SESSION_RUNNER_OFFLINE_AFTER_MS} * interval '1 millisecond')
                   THEN 'OFFLINE'
                 WHEN runner."status" = 'DRAINING' OR runner."heartbeat_draining" = true THEN 'DRAINING'
                 WHEN runner."heartbeat_lease_owner" IS NULL
                   OR NOT (${INTEGRATION_JOB_CLAIM} = ANY(runner."capabilities")) THEN 'OUTDATED'
               END AS "wait",
               runner."name" AS "name"
          FROM (SELECT 1) queued
          LEFT JOIN "session" source_session ON source_session."id" = newest_job."session_id"
          LEFT JOIN "workspace" source_workspace ON source_workspace."id" = source_session."workspace_id"
          LEFT JOIN "runner" runner ON runner."id" = source_workspace."runner_id"
         WHERE newest_job."state" = 'QUEUED'
      ) runner_wait ON true
      -- M2: an OPEN item about another task's failed absorb of upstream into the same target holds
      -- every later landing on it; the conflicted task's own later generations are exempt (§3.1 M3).
      -- Read through the item rather than the failed job, so closing it is what lets the queue move.
      LEFT JOIN LATERAL (
        SELECT f."id" AS "jobId", i."id" AS "openItemId", i."owner_id" AS "ownerId",
               ft."title" AS "taskTitle"
          FROM "project_open_item" i
          JOIN "project_integration_job" f ON f."id" = i."integration_job_id"
          LEFT JOIN "task" ft ON ft."id" = f."task_id"
         WHERE newest_job."state" = 'QUEUED'
           AND f."serial_key" = newest_job."serial_key" AND f."phase" = 'MAIN_SYNC'
           AND i."kind" = 'INTEGRATION_CONFLICT' AND i."state" = 'OPEN'
           AND f."task_id" IS DISTINCT FROM newest_job."task_id"
         ORDER BY i."created_at", i."id" LIMIT 1
      ) sync_block ON true
      -- J1: one RUNNING job per repository and target ref.
      LEFT JOIN LATERAL (
        SELECT r."id" AS "jobId", r."owner_id" AS "ownerId", r."kind" AS "kind", rt."title" AS "taskTitle"
          FROM "project_integration_job" r
          LEFT JOIN "task" rt ON rt."id" = r."task_id"
         WHERE newest_job."state" = 'QUEUED'
           AND r."serial_key" = newest_job."serial_key" AND r."state" = 'RUNNING'
         LIMIT 1
      ) running_block ON true`);

  const now = new Date();
  return new Map(rows.map((row) => [row.taskId, taskIntegrationOf(row, now)]));
}

const ACTIVE = new Set(['RUNNING', 'QUEUED']);
const STOPPED = new Set(['CONFLICT', 'CHECK_FAILED', 'ERROR']);

/** Running, then the queue, then the stops, then the last landing (§2.7a). */
function currentOrder(job: LandTaskIntegrationView<Date>): number {
  if (job.state === 'RUNNING') return 0;
  if (job.state === 'QUEUED') return 1;
  return STOPPED.has(job.state) ? 2 : 3;
}

/**
 * The project's current LAND_TASKs, for its integration view (§2.7a): what the queue is doing now,
 * what stopped and still stands, and what landed last — so the page says what is happening to done
 * work before anything fails, not only after an exception card exists.
 *
 * Each task's newest generation, read through `readTaskIntegrationViews` like the task's own page:
 *  - queued or running, whatever the task's receipts say (a newer generation is news);
 *  - stopped at a conflict, a failed check or an error, while the task is still DONE (a reopened
 *    task's next DONE queues a new generation) and no receipt has landed its work since;
 *  - and the one LANDED or ALREADY_LANDED most recently, so a quiet line still says what it did last.
 * Bounded by the queue and by the stops, never by the project's history.
 */
export async function readProjectLandTaskViews(
  prisma: Pick<PrismaService, '$queryRaw'>,
  projectId: string,
): Promise<ProjectLandTask<Date>[]> {
  // A job's (project, owner) is the project's own (its composite foreign key), so the owner the
  // task read is scoped to comes from the jobs rather than from a caller that may not have it.
  const candidates = await prisma.$queryRaw<Array<{ taskId: string; taskTitle: string; ownerId: string }>>(Prisma.sql`
    WITH newest AS (
      SELECT DISTINCT ON (j."task_id")
             j."task_id", j."owner_id", j."id", j."state", j."finished_at"
        FROM "project_integration_job" j
       WHERE j."project_id" = ${projectId}::uuid
         AND j."kind" = 'LAND_TASK'
         AND j."task_id" IS NOT NULL
       ORDER BY j."task_id", j."generation" DESC, j."created_at" DESC, j."id" DESC
    ),
    last_landed AS (
      SELECT n."id" FROM newest n
       WHERE n."state" IN ('LANDED', 'ALREADY_LANDED')
       ORDER BY n."finished_at" DESC NULLS LAST, n."id" DESC
       LIMIT 1
    )
    SELECT n."task_id" AS "taskId", t."title" AS "taskTitle", n."owner_id" AS "ownerId"
      FROM newest n
      JOIN "task" t ON t."id" = n."task_id" AND t."owner_id" = n."owner_id"
     WHERE n."state" IN ('QUEUED', 'RUNNING')
        OR (n."state" IN ('CONFLICT', 'CHECK_FAILED', 'ERROR') AND t."status" = 'DONE')
        OR n."id" IN (SELECT "id" FROM last_landed)`);
  if (candidates.length === 0) return [];
  const views = await readTaskIntegrationViews(
    prisma, candidates[0].ownerId, projectId, candidates.map((row) => row.taskId),
  );
  const current: Array<ProjectLandTask<Date> & { job: LandTaskIntegrationView<Date> }> = [];
  for (const { taskId, taskTitle } of candidates) {
    const integration = views.get(taskId);
    const job = integration?.landTask;
    if (!integration || !job) continue;
    if (STOPPED.has(job.state)) {
      // A receipt written after the stop means the work landed another way (a hand merge, a later
      // ALREADY_MERGED): the stop is history then. One written before it is about older commits.
      const landed = integration.state === 'ON_INTEGRATION_LINE' || integration.state === 'ON_UPSTREAM';
      if (landed && integration.since && job.finishedAt && integration.since >= job.finishedAt) continue;
    }
    current.push({ taskId, taskTitle, integration, job });
  }
  current.sort((a, b) => currentOrder(a.job) - currentOrder(b.job)
    || (ACTIVE.has(a.job.state)
      // The queue in the order the claim takes it; the stops newest first.
      ? a.job.queuedAt.getTime() - b.job.queuedAt.getTime()
      : (b.job.finishedAt?.getTime() ?? 0) - (a.job.finishedAt?.getTime() ?? 0))
    || a.job.jobId.localeCompare(b.job.jobId));
  return current.map(({ taskId, taskTitle, integration }) => ({ taskId, taskTitle, integration }));
}
