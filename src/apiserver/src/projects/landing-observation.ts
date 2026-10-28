import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import type { PrismaService } from '../prisma/prisma.service';
import { runnerOfflineSql } from '../runners/runner-presence';
import {
  LANDED_RESULTS,
  branchName,
  canonicalRepoUrlSql,
  isCodeTaskSql,
  taskLandingSql,
} from './project-criterion-landing';
import { appendIntegrationJobEvent, enqueuedText } from './project-integration-event';
import {
  INTEGRATION_JOB_CLAIM,
  INTEGRATION_OBSERVE_CLAIM,
  endTimedOutLanding,
  integrationIdempotencyKey,
  integrationItemTitle,
  integrationSerialKey,
} from './project-integration-job';
import { readInFlightJobs } from './project-integration-line';
import {
  landedWithoutConfirmationKey,
  recordIntegrationFailure,
  recordLandedWithoutConfirmation,
} from './project-open-item';

/**
 * Landing observation (`docs/project-integration-line-contract.md` §10.6): the read-only job that
 * looks at whether the commits finished tasks were delivered as are on the integration line, and the
 * rules around it that are not the claim or the result — the queue (O-J1, O-T1–O-T5), what a failed
 * observation owes (O-J4), and when a landing receipt owes the owner a word (O-R3).
 *
 * The claim is the integration queue's own door (`runner-api/integration-job-relay.ts`, J-T2) and the
 * result's per-task writes are `landing-observation-result.ts`; both read the SQL spelled here.
 */

const logger = new Logger('LandingObservation');

/**
 * Which committed fact queued an observation (§10.6), as the enqueue's timeline line records it:
 * O-T1 a frozen delivered identity in an AGENT_PUSH project, O-T2 a work session's turn, O-T3 a
 * receipt, O-T4 the owner choosing AGENT_PUSH, O-T5 the explicit door, an observation that failed
 * while tasks still wait (O-J4), and the one-time pass at deploy (§10.9).
 */
export type ObservationTrigger =
  | 'IDENTITY_FROZEN'
  | 'TURN_COMPLETE'
  | 'RECEIPT'
  | 'DELIVERY_MODE'
  | 'OBSERVE_DOOR'
  | 'FAILED_OBSERVATION'
  | 'DEPLOY';

/** How many failed observations of a project in a row open its INTEGRATION_ERROR (§10.6 O-J4). */
export const OBSERVATION_FAILURE_LIMIT = 3;

/** The one INTEGRATION_ERROR a project's failing observations open (§10.6 O-J4). */
export function observationErrorDedupeKey(projectId: string): string {
  return `IE:observe:${projectId}`;
}

/**
 * The tasks waiting to be observed (§10.6), as SQL over a TASK alias: in a project, DONE, code work
 * of this line (`isCodeTask`, O-L7's repository condition included), with a frozen delivered identity
 * (O-L4), and not known to be on the line yet (§1.4 `NOT_KNOWN`). A PLATFORM project's tasks are among
 * them too: its observation only recognises work that reached the line outside its own pipeline.
 */
export function landingPendingObservationSql(alias: string): string {
  return `(
      ${alias}."status" = 'DONE'
      AND ${alias}."delivered_at" IS NOT NULL
      AND ${alias}."delivered_sha" IS NOT NULL
      AND ${isCodeTaskSql(alias)}
      AND (${taskLandingSql(alias)}) = 'NOT_KNOWN'
    )`;
}

/** One task an observation is handed (§10.6 O-J2): its frozen identity. */
export interface ObservationTask {
  taskId: string;
  deliveredSha: string;
  baseSha: string | null;
}

/** The project's tasks waiting to be observed, oldest first — what a claim writes into its command. */
export function readPendingObservations(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  projectId: string,
): Promise<ObservationTask[]> {
  return db.$queryRaw<ObservationTask[]>(Prisma.sql`
    SELECT t."id" AS "taskId", t."delivered_sha" AS "deliveredSha", t."delivered_base_sha" AS "baseSha"
      FROM "task" t
     WHERE t."project_id" = ${projectId}::uuid
       AND ${Prisma.raw(landingPendingObservationSql('t'))}
     ORDER BY t."created_at", t."id"`);
}

/** Whether any task of the project waits to be observed. */
export async function hasPendingObservation(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  projectId: string,
): Promise<boolean> {
  const [row] = await db.$queryRaw<Array<{ pending: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "task" t
       WHERE t."project_id" = ${projectId}::uuid
         AND ${Prisma.raw(landingPendingObservationSql('t'))}
    ) AS "pending"`);
  return row?.pending === true;
}

/** What an enqueue did: wrote a QUEUED row, or folded into the one already queued (§10.4). */
export interface ObservationQueued {
  jobId: string;
  queued: boolean;
}

/**
 * Queue one OBSERVE_LANDING for the project, or fold into the one already queued (§10.4, §10.6 O-J1),
 * in the caller's transaction.
 *
 * Under the binding's row lock (rank 55): the generation is the project's newest plus one, read under
 * it, so two triggers never take the same idempotency key. The insert is `ON CONFLICT DO NOTHING` —
 * the partial unique index admits one QUEUED observation per project — and a trigger that meets the
 * queued row holds it FOR NO KEY UPDATE until it commits: which tasks an observation looks at is read
 * when it is claimed, and the claim skips a locked row, so the fact this trigger is about is committed
 * by the time the row is handed out. A row claimed between the insert and that lock is no longer the
 * queued one, and the trigger queues the next generation instead.
 *
 * And §2.2 J-T9 for observations: a RUNNING observation of this project already silent past its limit
 * (§7.2 V6) is ended here as ERROR · RUNNER_LOST — it holds the project's `#observe:` serial key, and
 * no result will ever come for it — and counted as a failure (O-J4). The enqueue is the observation's
 * retry door, as `integration_retry` is a landing's.
 *
 * Null when the project has no binding: there is no line to look at.
 */
export async function queueLandingObservation(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; projectId: string; trigger: ObservationTrigger },
): Promise<ObservationQueued | null> {
  const [binding] = await tx.$queryRaw<Array<{
    id: string; canonicalRepoUrl: string; integrationRef: string; upstreamRef: string;
  }>>(Prisma.sql`
    SELECT "id", "canonical_repo_url" AS "canonicalRepoUrl",
           "integration_ref" AS "integrationRef", "upstream_ref" AS "upstreamRef"
      FROM "project_codebase"
     WHERE "project_id" = ${input.projectId}::uuid
       AND "owner_id" = ${input.ownerId}::uuid
       AND "slot" = 'primary'
       FOR UPDATE`);
  if (!binding) return null;
  await endTimedOutObservations(tx, { ownerId: input.ownerId, projectId: input.projectId });

  const serialKey = integrationSerialKey({
    kind: 'OBSERVE_LANDING',
    canonicalRepoUrl: binding.canonicalRepoUrl,
    targetRef: binding.integrationRef,
    projectId: input.projectId,
  });
  // Three tries is the race above twice over: a queued row claimed between the insert and the lock
  // leaves no queued row, and the next insert then has nothing to conflict with.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [previous] = await tx.$queryRaw<Array<{ generation: number | null }>>(Prisma.sql`
      SELECT max("generation") AS "generation" FROM "project_integration_job"
       WHERE "project_id" = ${input.projectId}::uuid AND "kind" = 'OBSERVE_LANDING'`);
    const generation = Number(previous?.generation ?? 0) + 1;
    const [created] = await tx.projectIntegrationJob.createManyAndReturn({
      data: [{
        id: randomUUID(),
        projectId: input.projectId,
        ownerId: input.ownerId,
        codebaseId: binding.id,
        kind: 'OBSERVE_LANDING',
        generation,
        // §10.4: no task, session, promotion or landing — an observation is about the project's line,
        // and its tasks are the ones waiting when it is claimed. Both refs name the line.
        serialKey,
        targetRef: binding.integrationRef,
        upstreamRef: binding.upstreamRef,
        sourceRef: binding.integrationRef,
        idempotencyKey: integrationIdempotencyKey({
          kind: 'OBSERVE_LANDING', subjectId: input.projectId, generation,
        }),
      }],
      skipDuplicates: true,
      select: { id: true },
    });
    if (created) {
      // §2.9 LS2: the enqueue is a fact of the transaction that queued it, with what queued it.
      await appendIntegrationJobEvent(tx, {
        jobId: created.id,
        key: 'enqueued',
        kind: 'ENQUEUED',
        claim: 0,
        data: {
          kind: 'OBSERVE_LANDING',
          generation,
          targetRef: binding.integrationRef,
          sourceRef: binding.integrationRef,
          trigger: input.trigger,
        },
        text: enqueuedText({
          kind: 'OBSERVE_LANDING', sourceRef: binding.integrationRef, targetRef: binding.integrationRef,
        }),
      });
      return { jobId: created.id, queued: true };
    }
    const [held] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "project_integration_job"
       WHERE "serial_key" = ${serialKey} AND "kind" = 'OBSERVE_LANDING' AND "state" = 'QUEUED'
       FOR NO KEY UPDATE`);
    if (held) return { jobId: held.id, queued: false };
  }
  return null;
}

/**
 * O-T1, O-T2, O-T3 and O-T4 (§10.6): queue an observation only when the project has a task waiting
 * to be observed — with nothing waiting, there is nothing an observation could see.
 */
export async function queueLandingObservationIfPending(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; projectId: string; trigger: ObservationTrigger },
): Promise<ObservationQueued | null> {
  if (!(await hasPendingObservation(tx, input.projectId))) return null;
  return queueLandingObservation(tx, input);
}

/**
 * O-T2 and O-T3 (§10.6): a fact committed — a work session's turn, a receipt — and the line may have
 * moved, so the project's waiting tasks are looked at again. After that fact's own commit, in a
 * transaction of its own; asked first without a lock, so a project with nothing waiting costs one
 * read. Logged and never raised: the fact is committed either way, and the next trigger asks again.
 */
export async function queueLandingObservationAfterCommit(
  prisma: PrismaService,
  input: { projectId: string; trigger: ObservationTrigger },
): Promise<ObservationQueued | null> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { ownerId: true },
    });
    if (!project || !(await hasPendingObservation(prisma, input.projectId))) return null;
    return await withTransactionRetry(
      prisma,
      (tx) => queueLandingObservationIfPending(tx, { ownerId: project.ownerId, ...input }),
      loggedRetry(logger, 'landingObservation.enqueue'),
    );
  } catch (error) {
    logger.warn(`observation of project ${input.projectId} not queued after ${input.trigger}: `
      + `${(error as Error)?.message ?? error}`);
    return null;
  }
}

/**
 * §2.2 J-T9 for this project's observation: a RUNNING one silent past its limit (§7.2 V6, read by
 * `readInFlightJobs` like every other timeout) is ended ERROR · RUNNER_LOST by the compare-and-set
 * every timed-out job is ended by, and counted toward O-J4.
 */
async function endTimedOutObservations(
  tx: Prisma.TransactionClient,
  project: { ownerId: string; projectId: string },
): Promise<void> {
  const silent = (await readInFlightJobs(tx, project.projectId))
    .filter((job) => job.kind === 'OBSERVE_LANDING' && job.state === 'RUNNING' && job.timedOut);
  for (const job of silent) {
    const ended = await endTimedOutLanding(tx, job, 'RETRY');
    if (ended !== null) {
      await observationFailed(tx, { jobId: job.jobId, ownerId: project.ownerId, projectId: project.projectId });
    }
  }
}

/** What O-J4 found once an observation failed. */
export interface ObservationFailure {
  /** Failed observations of the project since its last OBSERVED, this one included. */
  failures: number;
  /** The `IE:observe:<projectId>` item this failure opened, when it was the limit's. */
  itemId: string | null;
  /** Who that item is in front of. */
  assignee: 'COORDINATOR' | 'OWNER' | null;
}

/**
 * O-J4 (§10.6), once an observation ended ERROR — a runner's FETCH_FAILED or BASE_REF_NOT_FOUND, or
 * J-T9's RUNNER_LOST: no integration item about the job itself (an observation is not a landing that
 * failed), and on the third failure in a row since the project's last OBSERVED, one INTEGRATION_ERROR,
 * `IE:observe:<projectId>`, the coordinator's like every integration item. The next OBSERVED resolves
 * it (`resolveObservationErrorItems`).
 *
 * Whether to queue again is the caller's: the result transaction does while tasks wait and the limit
 * has not been reached, which keeps the waiting with a producer (O5) — an observation in flight, then
 * the item in front of somebody — without turning a repository that cannot be fetched into a loop.
 */
export async function observationFailed(
  tx: Prisma.TransactionClient,
  job: { jobId: string; ownerId: string; projectId: string },
): Promise<ObservationFailure> {
  const [row] = await tx.$queryRaw<Array<{ failures: number }>>(Prisma.sql`
    SELECT count(*)::int AS "failures"
      FROM "project_integration_job" failed
     WHERE failed."project_id" = ${job.projectId}::uuid
       AND failed."kind" = 'OBSERVE_LANDING'
       AND failed."state" = 'ERROR'
       AND failed."generation" > COALESCE((
             SELECT max(seen."generation") FROM "project_integration_job" seen
              WHERE seen."project_id" = failed."project_id"
                AND seen."kind" = 'OBSERVE_LANDING'
                AND seen."state" = 'OBSERVED'), 0)`);
  const failures = row?.failures ?? 0;
  if (failures < OBSERVATION_FAILURE_LIMIT) return { failures, itemId: null, assignee: null };

  const failed = await tx.projectIntegrationJob.findUnique({
    where: { id: job.jobId },
    select: { phase: true, errorCode: true, errorDetail: true, targetRef: true, generation: true },
  });
  if (!failed) return { failures, itemId: null, assignee: null };
  const opened = await recordIntegrationFailure(tx, {
    projectId: job.projectId,
    ownerId: job.ownerId,
    jobId: job.jobId,
    taskId: null,
    sessionId: null,
    promotionId: null,
    state: 'ERROR',
    title: integrationItemTitle('ERROR', 'OBSERVE_LANDING', '', branchName(failed.targetRef)),
    dedupeKey: observationErrorDedupeKey(job.projectId),
    payload: {
      // `jobKind` is what files the item in its own door cell (`open-item-doors.ts`).
      jobKind: 'OBSERVE_LANDING',
      phase: failed.phase,
      targetRef: failed.targetRef,
      errorCode: failed.errorCode,
      errorDetail: failed.errorDetail,
      failureClass: 'ERROR',
      failures,
      generation: failed.generation,
    },
  });
  return { failures, itemId: opened?.itemId ?? null, assignee: opened?.assignee ?? null };
}

/** O-J4's ending: the project's observation answered, so the item about its failures is moot. */
export async function resolveObservationErrorItems(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<number> {
  const resolved = await tx.projectOpenItem.updateMany({
    where: { projectId, dedupeKey: observationErrorDedupeKey(projectId), state: 'OPEN' },
    data: {
      state: 'RESOLVED',
      resolution: 'JOB_MOVED_ON',
      resolvedAt: new Date(),
      resolvedBy: 'PLATFORM',
    },
  });
  return resolved.count;
}

// ── who claims an observation (§10.6 「领取」) ────────────────────────────────────────────────────

/**
 * Whether the runner aliased `alias` would take an observation now: online, not draining, holding a
 * heartbeat lease, and declaring both `integration-job/v1` and `integration-observe/v1` — the
 * conditions the claim itself reads off its own heartbeat.
 */
function observingRunnerAvailableSql(alias: string): Prisma.Sql {
  const runner = Prisma.raw(alias);
  return Prisma.sql`(${runner}."id" IS NOT NULL
      AND NOT ${runnerOfflineSql(alias)}
      AND ${runner}."status" <> 'DRAINING'
      AND ${runner}."heartbeat_draining" IS NOT TRUE
      AND ${runner}."heartbeat_lease_owner" IS NOT NULL
      AND ${INTEGRATION_JOB_CLAIM} = ANY(${runner}."capabilities")
      AND ${INTEGRATION_OBSERVE_CLAIM} = ANY(${runner}."capabilities"))`;
}

/**
 * The project's waiting tasks' source sessions, as a LATERAL over an OBSERVE_LANDING job aliased
 * `jobAlias`: the runners and workspaces they ran on (`delivered_session_id`, O-L4), and whether one of
 * those runners would take an observation now. Only that runner has the tasks' commits, which is what
 * `fullyApplied` needs, so it is preferred while it is there (§10.6).
 */
export function observationSourcesSql(jobAlias: string): Prisma.Sql {
  const job = Prisma.raw(jobAlias);
  return Prisma.sql`(
      SELECT array_agg(DISTINCT source_workspace."runner_id")
               FILTER (WHERE source_workspace."runner_id" IS NOT NULL) AS "runnerIds",
             array_agg(DISTINCT source_workspace."id")
               FILTER (WHERE source_workspace."id" IS NOT NULL) AS "workspaceIds",
             COALESCE(bool_or(${observingRunnerAvailableSql('source_runner')}), false) AS "runnerAvailable"
        FROM "task" pending_task
        LEFT JOIN "session" source_session ON source_session."id" = pending_task."delivered_session_id"
        LEFT JOIN "workspace" source_workspace ON source_workspace."id" = source_session."workspace_id"
        LEFT JOIN "runner" source_runner ON source_runner."id" = source_workspace."runner_id"
       WHERE pending_task."project_id" = ${job}."project_id"
         AND ${Prisma.raw(landingPendingObservationSql('pending_task'))}
    )`;
}

/**
 * The checkout an observation is run in on runner `runnerId`, as a LATERAL over the job (`jobAlias`),
 * its binding (`codebaseAlias`) and its sources (`sourcesAlias`, `observationSourcesSql`): one of the
 * job owner's workspaces on that runner, with a working directory, whose repository is the binding's
 * through SR36 — or a source session's own workspace that names no repository, since the work in it
 * is this line's (O-L7). A source workspace first, because it holds the tasks' commits. No row is a
 * runner that cannot reach the repository, and it is not handed the job.
 */
export function observationWorkspaceSql(
  runnerId: string,
  jobAlias: string,
  codebaseAlias: string,
  sourcesAlias: string,
): Prisma.Sql {
  const job = Prisma.raw(jobAlias);
  const sources = Prisma.raw(sourcesAlias);
  const sourceWorkspace = Prisma.sql`w."id" = ANY(COALESCE(${sources}."workspaceIds", '{}'::uuid[]))`;
  return Prisma.sql`(
      SELECT w."work_dir" AS "workDir"
        FROM "workspace" w
       WHERE w."runner_id" = ${runnerId}::uuid
         AND w."owner_id" = ${job}."owner_id"
         AND w."deleted_at" IS NULL
         AND w."work_dir" IS NOT NULL
         AND (${Prisma.raw(canonicalRepoUrlSql('w."repo_url"'))}
                = ${Prisma.raw(canonicalRepoUrlSql(`${codebaseAlias}."canonical_repo_url"`))}
              OR (w."repo_url" IS NULL AND ${sourceWorkspace}))
       ORDER BY (${sourceWorkspace}) DESC, w."created_at", w."id"
       LIMIT 1
    )`;
}

// ── O-R3: work that reached main without the owner's confirmation ───────────────────────────────────

/** The receipt `detail` keys O-R3 reads. */
interface ReceiptDetail {
  source?: unknown;
  requestedBy?: unknown;
  integrationJobId?: unknown;
  empty?: unknown;
}

/**
 * O-R3 (§10.6): open `LANDED_WITHOUT_CONFIRMATION` for one receipt just recorded, when it is owed —
 * in the transaction that recorded it, beside M-T13's retirement. Every condition is the receipt's or
 * its project's, so each door that records a landing asks the same question here:
 *
 *  - the project is a `PLATFORM` project on a `MAIN` line (on `AGENT_PUSH` the push is the owner's
 *    standing authorization, O-L2; a project branch is not main);
 *  - the receipt is a landing on the upstream, and the first that puts this task there — reaching main
 *    happens once, and a later receipt of work already there is not that event;
 *  - it is not an M9 receipt (a confirmed promotion's own landing), and not the owner's own act: a
 *    receipt the owner recorded, or a Merge whose request carried the owner's credential
 *    (`detail.requestedBy = 'USER'`). A Merge receipt that names no requester is an operation queued
 *    before the door recorded one, and is not judged;
 *  - it is not an empty branch's receipt (O-R2): nothing of the task's own reached main.
 *
 * Idempotent per receipt: an item about it, in any state, is never opened twice. Answers the item's
 * id, or null.
 */
export async function openLandedWithoutConfirmationIfOwed(
  tx: Prisma.TransactionClient,
  receiptId: string,
): Promise<string | null> {
  const receipt = await tx.sessionMergeReceipt.findUnique({
    where: { id: receiptId },
    select: {
      id: true, taskId: true, projectId: true, result: true, targetBranch: true, recordedBy: true, detail: true,
    },
  });
  if (!receipt?.taskId || !receipt.projectId || !LANDED_RESULTS.includes(receipt.result)) return null;
  if (receipt.recordedBy === 'USER') return null;
  const detail: ReceiptDetail = receipt.detail && typeof receipt.detail === 'object' && !Array.isArray(receipt.detail)
    ? receipt.detail as ReceiptDetail
    : {};
  if (detail.empty === true) return null;
  if (detail.source === 'merge-result' && detail.requestedBy !== 'AGENT') return null;
  if (typeof detail.integrationJobId === 'string') {
    const job = await tx.projectIntegrationJob.findUnique({
      where: { id: detail.integrationJobId },
      select: { kind: true },
    });
    if (job?.kind === 'LAND_PROMOTION') return null;
  }
  const line = await tx.projectCodebase.findFirst({
    where: { projectId: receipt.projectId, slot: 'primary' },
    select: { deliveryMode: true, integrationRef: true, upstreamRef: true },
  });
  if (!line || line.deliveryMode !== 'PLATFORM' || line.integrationRef !== line.upstreamRef) return null;
  if (receipt.targetBranch !== branchName(line.upstreamRef)) return null;
  const earlier = await tx.sessionMergeReceipt.count({
    where: {
      taskId: receipt.taskId,
      id: { not: receipt.id },
      result: { in: [...LANDED_RESULTS] },
      targetBranch: receipt.targetBranch,
    },
  });
  if (earlier > 0) return null;
  const raised = await tx.projectOpenItem.count({
    where: {
      projectId: receipt.projectId,
      dedupeKey: landedWithoutConfirmationKey(receipt.taskId, receipt.id),
    },
  });
  if (raised > 0) return null;
  const opened = await recordLandedWithoutConfirmation(tx, { taskId: receipt.taskId, receiptId: receipt.id });
  return opened?.itemId ?? null;
}
