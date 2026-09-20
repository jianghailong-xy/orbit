import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  IntegrationCheckResult,
  IntegrationCheckSpec,
  IntegrationJobCommand,
  IntegrationJobProgressRequest,
  IntegrationJobResultRequest,
  IntegrationJobResultResponse,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_CHECK_TIMEOUT_SECONDS,
  INTEGRATION_CLAIM_STALE_MS,
  INTEGRATION_JOBS_PER_HEARTBEAT,
  INTEGRATION_JOB_CLAIM,
  INTEGRATION_JOB_PHASES,
  INTEGRATION_JOB_STATES,
  MAX_CHECK_OUTPUT_TAIL,
  integrationDedupeKey,
  integrationItemTitle,
  isTerminalJobState,
  jobLanded,
  openItemKindForJobState,
  shortBranchName,
} from '../projects/project-integration-job';
import {
  recordIntegrationFailure,
  recordPromotionApproval,
  resolveIntegrationItemsOnLanding,
} from '../projects/project-open-item';
import { promotionDedupeKey } from '../projects/project-promotion';
import {
  applyPromotionJobResult,
  markPromotionRechecking,
} from '../projects/project-promotion.service';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';

/**
 * The heartbeat's half of the integration queue: what a runner is handed, and what it reports back
 * (`docs/project-integration-line-contract.md` §2.2, §2.3).
 *
 * A service rather than three module functions so its one retry can be labelled the way every other
 * retry in the tree is: through `loggedRetry`, taking this class's own logger and a written-out
 * operation name. That is what the conflict metrics and the runbook aggregate on, and what the two
 * surveys in `db-write-inventory.spec.ts` and `db-conflict-metrics.spec.ts` look for. It holds no
 * state beyond the Prisma client; the git work is `src/runner-go/integrate.go` and the rules are
 * `projects/project-integration-job.ts`.
 */
@Injectable()
export class IntegrationJobRelay {
  private readonly logger = new Logger(IntegrationJobRelay.name);

  constructor(
    private readonly prisma: PrismaService,
    /**
     * Where an exception item this class opens is handed to whoever it belongs to (contract §4.4
     * X-D4 (1)). Every OTHER failure here is opened inside a result the runner POSTED, and the
     * controller that answers that request delivers it afterwards — but a claim with nowhere to run
     * is ended by the dispatch itself, in a heartbeat that asked for work rather than reporting any,
     * and an item nobody is told about is exactly what §4 exists to rule out.
     *
     * `@Optional()` like the rest of this door's collaborators: a spec that constructs the relay to
     * exercise the queue passes none, and an undelivered item is still re-derived from its own row
     * by the coordinator's next turn (X-D4 (3)).
     */
    @Optional() private readonly openItems?: ProjectOpenItemService,
  ) {}

  /** §2.3 J-T2, J-T3 — see `dispatchIntegrationJobs`. */
  dispatch(heartbeat: IntegrationDispatchHeartbeat): Promise<IntegrationJobCommand[]> {
    return dispatchIntegrationJobs(this.prisma, heartbeat, this.logger, this.openItems);
  }

  /** §2.2 J-T4 — see `receiveIntegrationJobProgress`. */
  progress(
    runnerId: string,
    jobId: string,
    body: IntegrationJobProgressRequest,
  ): Promise<{ accepted: true }> {
    return receiveIntegrationJobProgress(this.prisma, runnerId, jobId, body);
  }

  /**
   * §2.2 J-T5 to J-T7 — see `applyIntegrationJobResult`, whose transaction this labels.
   *
   * The retry is the ordinary one: everything the decision rests on is re-read inside the closure,
   * so a serialisation conflict is re-decided against the committed world rather than replayed.
   */
  applyResult(
    jobId: string,
    runnerId: string,
    body: IntegrationJobResultRequest,
  ): Promise<{ answer: IntegrationJobResultResponse; after: IntegrationResultAftermath | null }> {
    return applyIntegrationJobResult(
      this.prisma,
      { jobId, runnerId, body },
      loggedRetry(this.logger, 'integrationJob.applyResult'),
    );
  }
}

const logger = new Logger('IntegrationJobRelay');

/** What the heartbeat knows about the process asking for work. */
export interface IntegrationDispatchHeartbeat {
  runnerId: string;
  /** Null for a legacy heartbeat with no process identity: it is handed nothing. */
  leaseOwner: string | null;
  draining: boolean;
  capabilities: string[] | undefined;
}

/** The row the claim returns, joined with what the runner needs to act on it. */
interface ClaimedRow {
  id: string;
  kind: string;
  claimGeneration: bigint;
  targetRef: string;
  upstreamRef: string;
  sourceRef: string;
  serialKey: string;
  workDir: string | null;
  remoteName: string;
  refAuthority: string;
  sessionBaseSha: string | null;
  acceptanceCommand: string | null;
  acceptanceExpectedExitCode: number | null;
  acceptanceTimeoutSeconds: number | null;
  mergeCheckCommand: string | null;
  mergeCheckTimeoutSeconds: number | null;
  cancelRequestedAt: Date | null;
  /** A promotion job's frozen source, and the two facts M-S3 compares before it lands. */
  jobSourceSha: string | null;
  promotionId: string | null;
  upstreamShaChecked: string | null;
  mergeTreeSha: string | null;
}

/**
 * The jobs this heartbeat's process has just claimed (§2.3 J-T2, J-T3).
 *
 * A claim IS the serialisation: the row moves to RUNNING inside one statement, and the partial unique
 * index over RUNNING rows means the second claimer of a repository-and-target-ref loses at the
 * database rather than by agreement between two runners. Two per beat at most, with distinct serial
 * keys, because a runner that took three would be holding the third's slot while it worked on the
 * first.
 *
 * A process with no lease owner, a draining one, or one that has not declared `integration-job/v1`
 * is handed nothing — never an error, because those are all ordinary states of a runner and none of
 * them is a failure of the job.
 */
export async function dispatchIntegrationJobs(
  prisma: PrismaService,
  heartbeat: IntegrationDispatchHeartbeat,
  log: Logger = logger,
  openItems?: Pick<ProjectOpenItemService, 'deliverForItems'>,
): Promise<IntegrationJobCommand[]> {
  if (!heartbeat.leaseOwner || heartbeat.draining) return [];
  if (!heartbeat.capabilities?.includes(INTEGRATION_JOB_CLAIM)) return [];

  const commands: IntegrationJobCommand[] = [];
  const taken: string[] = [];
  for (let i = 0; i < INTEGRATION_JOBS_PER_HEARTBEAT; i += 1) {
    const row = await claimOne(prisma, heartbeat.runnerId, heartbeat.leaseOwner, taken)
      .catch((error) => {
        // A lost race against another runner's claim surfaces as the partial unique index. It is
        // the index doing its job, not an incident: the next beat looks again.
        log.warn(`integration job claim failed: ${error?.message ?? error}`);
        return null;
      });
    if (!row) break;
    taken.push(row.serialKey);
    if (!row.workDir) {
      // Nothing to work in. Ended here rather than handed over, so it opens an item instead of
      // being redelivered every 30 seconds to a runner that cannot act on it — and the item is
      // handed on from here too, because this beat is the only door that knows it was opened.
      const after = await finishUnworkable(prisma, row.id, heartbeat.leaseOwner, row.claimGeneration);
      if (after && after.openItemIds.length > 0) {
        await openItems?.deliverForItems(after.openItemIds);
      }
      continue;
    }
    commands.push({
      jobId: row.id,
      kind: row.kind as IntegrationJobCommand['kind'],
      claimGeneration: row.claimGeneration.toString(),
      leaseOwner: heartbeat.leaseOwner,
      workDir: row.workDir,
      remoteName: row.remoteName,
      refAuthority: row.refAuthority as 'REMOTE' | 'RUNNER_LOCAL',
      targetRef: row.targetRef,
      upstreamRef: row.upstreamRef,
      sourceRef: row.sourceRef,
      ...(row.sessionBaseSha ? { sessionBaseSha: row.sessionBaseSha } : {}),
      // A promotion names the exact commit the owner is being asked about, so the runner works from
      // that rather than from wherever the branch has got to since (§3.4 M-S1).
      ...(row.jobSourceSha ? { sourceSha: row.jobSourceSha } : {}),
      ...(row.upstreamShaChecked ? { upstreamShaChecked: row.upstreamShaChecked } : {}),
      ...(row.mergeTreeSha ? { mergeTreeSha: row.mergeTreeSha } : {}),
      checks: checksFor(row),
      cancelRequested: row.cancelRequestedAt != null,
    });
  }
  return commands;
}

/**
 * The commands to run on the combined tree (§2.4 J-S5), in the order a person would run them: the
 * task's own acceptance first, because a task that cannot pass its own criterion on the merged tree
 * is the narrower failure and the one whose owner is obvious.
 *
 * A task with no acceptance command contributes none. That is not a gap: an EVIDENCE_JUDGMENT or
 * OWNER_CONFIRMED task was settled by somebody looking at it, and there is no command to re-run.
 */
function checksFor(row: ClaimedRow): IntegrationCheckSpec[] {
  const checks: IntegrationCheckSpec[] = [];
  // A PROJECT_BRANCH promotion runs the project's merge check and nothing else (§3.4 M-S3): every
  // task it carries already passed its own acceptance on the line, and the session the job names
  // belongs to one of those tasks only so the queue can find a checkout to work in — the job itself
  // names no task, which is why `row.acceptanceCommand` here is that session's task's and not the
  // promotion's.
  const taskAcceptanceApplies = row.kind === 'LAND_TASK';
  if (taskAcceptanceApplies && row.acceptanceCommand && row.acceptanceExpectedExitCode != null) {
    checks.push({
      name: 'TASK_ACCEPTANCE',
      command: row.acceptanceCommand,
      expectedExitCode: row.acceptanceExpectedExitCode,
      timeoutSeconds: row.acceptanceTimeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS,
    });
  }
  if (row.mergeCheckCommand) {
    checks.push({
      name: 'MERGE_CHECK',
      command: row.mergeCheckCommand,
      expectedExitCode: 0,
      timeoutSeconds: row.mergeCheckTimeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS,
    });
  }
  return checks;
}

/**
 * Claim the oldest queued job this runner can work on, or take over one whose claimer stopped
 * heartbeating (J-T3).
 *
 * The two are one statement because they are one decision — "which row becomes this process's" —
 * and because splitting them opens a window in which the takeover and the claim each see the other's
 * slot as free. `FOR UPDATE SKIP LOCKED` over the candidate, so two apiserver processes beating at
 * the same moment do not queue behind each other.
 */
async function claimOne(
  prisma: PrismaService,
  runnerId: string,
  leaseOwner: string,
  alreadyTaken: string[],
): Promise<ClaimedRow | null> {
  const staleBefore = new Date(Date.now() - INTEGRATION_CLAIM_STALE_MS);
  const rows = await prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
    WITH candidate AS (
      SELECT c."id"
        FROM "project_integration_job" c
        JOIN "session" s ON s."id" = c."session_id"
        JOIN "workspace" w ON w."id" = s."workspace_id"
       WHERE w."runner_id" = ${runnerId}::uuid
         AND c."cancel_requested_at" IS NULL
         AND NOT (c."serial_key" = ANY(${alreadyTaken}::text[]))
         AND (
           -- A queued job whose repository and target ref nobody holds.
           (c."state" = 'QUEUED' AND NOT EXISTS (
              SELECT 1 FROM "project_integration_job" r
               WHERE r."serial_key" = c."serial_key" AND r."state" = 'RUNNING'))
           -- Or one this process may take over: claimed, and silent for longer than the lease.
           OR (c."state" = 'RUNNING'
               AND (c."heartbeat_at" IS NULL OR c."heartbeat_at" < ${staleBefore})
               AND c."claim_lease_owner" IS DISTINCT FROM ${leaseOwner})
         )
       ORDER BY c."created_at", c."id"
       FOR UPDATE SKIP LOCKED
       LIMIT 1
    )
    UPDATE "project_integration_job" j
       SET "state" = 'RUNNING',
           "claim_generation" = j."claim_generation" + 1,
           "claim_lease_owner" = ${leaseOwner},
           "runner_id" = ${runnerId}::uuid,
           "claimed_at" = now(),
           "heartbeat_at" = now(),
           "started_at" = COALESCE(j."started_at", now()),
           "phase" = 'FETCH',
           "updated_at" = now()
      FROM candidate, "project_codebase" cb, "session" s
      LEFT JOIN "workspace" w ON w."id" = s."workspace_id"
      LEFT JOIN "task" t ON t."id" = s."task_id"
     WHERE j."id" = candidate."id"
       AND cb."id" = j."codebase_id"
       AND s."id" = j."session_id"
    RETURNING
      j."id" AS "id",
      j."kind" AS "kind",
      j."claim_generation" AS "claimGeneration",
      j."target_ref" AS "targetRef",
      j."upstream_ref" AS "upstreamRef",
      j."source_ref" AS "sourceRef",
      j."serial_key" AS "serialKey",
      w."work_dir" AS "workDir",
      cb."remote_name" AS "remoteName",
      cb."ref_authority" AS "refAuthority",
      s."base_sha" AS "sessionBaseSha",
      t."acceptance_command" AS "acceptanceCommand",
      t."acceptance_expected_exit_code" AS "acceptanceExpectedExitCode",
      t."acceptance_timeout_seconds" AS "acceptanceTimeoutSeconds",
      cb."merge_check_command" AS "mergeCheckCommand",
      cb."merge_check_timeout_seconds" AS "mergeCheckTimeoutSeconds",
      j."cancel_requested_at" AS "cancelRequestedAt",
      j."source_sha" AS "jobSourceSha",
      j."promotion_id" AS "promotionId",
      -- Scalar subqueries rather than another join: the FROM list of an UPDATE cannot join ON a
      -- column of the table being updated -- 42P01, invalid reference to FROM-clause entry for
      -- table j -- and a claim that raises is a claim this relay swallows as a warning, which reads
      -- as a queue nobody ever picks up rather than as an error.
      (SELECT p."upstream_sha_checked" FROM "project_promotion" p
        WHERE p."id" = j."promotion_id") AS "upstreamShaChecked",
      (SELECT p."merge_tree_sha" FROM "project_promotion" p
        WHERE p."id" = j."promotion_id") AS "mergeTreeSha"
  `);
  return rows[0] ?? null;
}

/**
 * A claim of a job with nowhere to run it: ended as an ERROR so somebody sees it once.
 *
 * Answers with the same aftermath the result route answers with, because the item it just opened is
 * owed the same delivery — and this caller is the only one that will ever know it happened.
 */
async function finishUnworkable(
  prisma: PrismaService,
  jobId: string,
  leaseOwner: string,
  claimGeneration: bigint,
): Promise<IntegrationResultAftermath | null> {
  const applied = await applyIntegrationJobResult(prisma, {
    jobId,
    body: {
      claimGeneration: claimGeneration.toString(),
      leaseOwner,
      state: 'ERROR',
      errorCode: 'INTEGRATION_REPOSITORY_UNKNOWN',
      errorDetail: { reason: 'the source session names no working directory on this runner' },
    },
  }).catch((error) => {
    logger.warn(`could not end an unworkable job: ${error?.message ?? error}`);
    return null;
  });
  return applied?.after ?? null;
}

// ── progress and result ───────────────────────────────────────────────────────────────────────

/** Why a report was refused, in the shape the controller turns into a status code. */
export type IntegrationResultRefusal = 'STALE_CLAIM' | 'NOT_FOUND' | 'ALREADY_FINAL' | 'INVALID_RESULT';

export const INTEGRATION_RESULT_REFUSAL_STATUS: Record<IntegrationResultRefusal, number> = {
  STALE_CLAIM: 409,
  NOT_FOUND: 404,
  ALREADY_FINAL: 409,
  INVALID_RESULT: 400,
};

export class IntegrationJobRefused extends Error {
  constructor(readonly refusal: IntegrationResultRefusal, message?: string) {
    super(message ?? refusal);
  }
}

/**
 * A heartbeat from the runner working on a job (J-T4): the phase it reached, and the lease renewal
 * that keeps another runner from taking it over.
 */
export async function receiveIntegrationJobProgress(
  prisma: PrismaService,
  runnerId: string,
  jobId: string,
  body: IntegrationJobProgressRequest,
): Promise<{ accepted: true }> {
  if (!INTEGRATION_JOB_PHASES.includes(body?.phase as never)) {
    throw new IntegrationJobRefused('INVALID_RESULT', `unknown phase ${body?.phase}`);
  }
  const moved = await prisma.projectIntegrationJob.updateMany({
    where: {
      id: jobId,
      runnerId,
      state: 'RUNNING',
      claimLeaseOwner: body.leaseOwner,
      claimGeneration: BigInt(body.claimGeneration),
    },
    data: { phase: body.phase, heartbeatAt: new Date() },
  });
  if (moved.count === 0) throw new IntegrationJobRefused('STALE_CLAIM');
  // M-T7: the upstream moved after the owner confirmed, so the job is redoing the merge and the
  // checks on the new tip. A progress report rather than a question — the owner confirmed these
  // tasks and these checks, and the checks passing again is the same answer (M5).
  if (body.upstreamMoved) {
    const job = await prisma.projectIntegrationJob.findUnique({
      where: { id: jobId },
      select: { promotionId: true, kind: true },
    });
    if (job?.promotionId && job.kind === 'LAND_PROMOTION') {
      await markPromotionRechecking(prisma, job.promotionId);
    }
  }
  return { accepted: true };
}

/** What the caller must do after the transaction that applied a result committed. */
export interface IntegrationResultAftermath {
  projectId: string;
  landedTaskId: string | null;
  /**
   * The exception items this result opened, by id, for the door that delivered the result to hand
   * over. By item rather than by task because a promotion job names no task (§3.4): the caller is
   * the only thing holding that row's id, and no read finds it by a task it does not have.
   */
  openItemIds: string[];
  /**
   * The project whose next promotion candidate is now worth looking for (§3.4 M-F1, M-F4), or null.
   *
   * After the commit rather than inside it, because the condition it tests is "the queue is empty",
   * and a queue is only empty of rows that committed. Re-derivable: the next landing asks again, and
   * nothing about the rows it reads expires.
   */
  considerPromotionProjectId: string | null;
}

/**
 * Apply one finished job (J-T5, J-T6, J-T7).
 *
 * Everything that follows from the job's terminal state is written in the SAME transaction as that
 * state: the receipt for a landing, the exception item for a failure. A reader of the row therefore
 * never sees a landed job with no receipt or a conflicted one with nobody assigned, whatever the
 * process does next — and the two post-commit edges (delivering the item, dispatching what the
 * landing released) are re-derivable from the committed rows if this process dies before them.
 */
export async function applyIntegrationJobResult(
  prisma: PrismaService,
  input: { jobId: string; runnerId?: string; body: IntegrationJobResultRequest },
  onRetry?: Parameters<typeof withTransactionRetry>[2],
): Promise<{ answer: IntegrationJobResultResponse; after: IntegrationResultAftermath | null }> {
  const body = input.body;
  const state = body?.state;
  if (!INTEGRATION_JOB_STATES.includes(state as never) || !isTerminalJobState(state)) {
    throw new IntegrationJobRefused('INVALID_RESULT', `${state} is not a result`);
  }
  // J2, said before the database says it, so the runner gets the reason rather than a constraint.
  if (state === 'LANDED' && (!body.landedTreeSha || body.landedTreeSha !== body.testedTreeSha)) {
    throw new IntegrationJobRefused(
      'INVALID_RESULT',
      'a LANDED result must name a landed tree equal to the tested one',
    );
  }

  return withTransactionRetry(prisma, async (tx) => {
    const job = await tx.projectIntegrationJob.findUnique({
      where: { id: input.jobId },
      select: {
        id: true, projectId: true, ownerId: true, kind: true, state: true,
        taskId: true, sessionId: true, promotionId: true, targetRef: true, sourceRef: true,
        claimLeaseOwner: true, claimGeneration: true, runnerId: true,
        task: { select: { title: true } },
      },
    });
    if (!job) throw new IntegrationJobRefused('NOT_FOUND');
    if (isTerminalJobState(job.state)) {
      // Not an error the runner has to do anything about: a result whose response was lost is
      // resent, and the second copy finds the job already written down.
      return {
        answer: { accepted: false, state: job.state as never, receiptIds: [], openItemId: null },
        after: null,
      };
    }
    if (
      job.claimLeaseOwner !== body.leaseOwner
      || job.claimGeneration !== BigInt(body.claimGeneration)
      || (input.runnerId != null && job.runnerId !== input.runnerId)
    ) {
      throw new IntegrationJobRefused('STALE_CLAIM');
    }

    const receiptIds = jobLanded(state) && job.sessionId && !job.promotionId
      ? await MergeReceiptService.fromIntegrationJob(tx, {
        ownerId: job.ownerId,
        sessionId: job.sessionId,
        taskId: job.taskId,
        projectId: job.projectId,
        jobId: job.id,
        state,
        sourceBranch: shortBranchName(job.sourceRef),
        targetBranch: shortBranchName(job.targetRef),
        sourceSha: body.sourceSha ?? null,
        targetShaBefore: body.targetShaBefore ?? null,
        landedSha: body.landedSha ?? null,
        rebaseBaseSha: body.mainSyncSha ?? body.targetShaBefore ?? null,
        testedTreeSha: body.testedTreeSha ?? null,
        landedTreeSha: body.landedTreeSha ?? null,
        mainSyncSha: body.mainSyncSha ?? null,
      })
      : [];

    const checks = clipChecks(body.checks ?? []);
    // §3: a promotion job's result is the promotion's, and moves it in the same transaction — a
    // MERGED promotion and the receipts saying its tasks are on the upstream are one fact (M9).
    // BEFORE the job's own update, not after: `project_integration_job_terminal_guard` refuses a
    // second write to a row that has reached a terminal state, so everything this result implies has
    // to be known by the time that one statement runs.
    const promotion = job.promotionId
      ? await applyPromotionJobResult(tx, {
        promotionId: job.promotionId,
        jobId: job.id,
        jobKind: job.kind,
        state,
        upstreamSha: body.upstreamSha ?? null,
        testedSha: body.testedSha ?? null,
        testedTreeSha: body.testedTreeSha ?? null,
        landedSha: body.landedSha ?? null,
        targetShaBefore: body.targetShaBefore ?? null,
        aheadOfUpstream: body.aheadOfUpstream ?? null,
        filesChanged: body.filesChanged ?? null,
        checks,
        conflicts: body.conflicts ?? [],
      })
      : null;
    const promotionReceiptIds = promotion?.receiptIds ?? [];
    await tx.projectIntegrationJob.update({
      where: { id: job.id },
      data: {
        state,
        phase: INTEGRATION_JOB_PHASES.includes(body.phase as never) ? body.phase : undefined,
        sourceSha: body.sourceSha ?? undefined,
        targetShaBefore: body.targetShaBefore ?? undefined,
        upstreamSha: body.upstreamSha ?? undefined,
        mainSyncSha: body.mainSyncSha ?? undefined,
        testedSha: body.testedSha ?? undefined,
        testedTreeSha: body.testedTreeSha ?? undefined,
        landedSha: body.landedSha ?? undefined,
        landedTreeSha: body.landedTreeSha ?? undefined,
        aheadOfUpstream: body.aheadOfUpstream ?? undefined,
        checks: checks as unknown as Prisma.InputJsonValue,
        conflicts: (body.conflicts ?? []).slice(0, 200),
        errorCode: body.errorCode ?? undefined,
        errorDetail: (body.errorDetail ?? undefined) as Prisma.InputJsonValue | undefined,
        receiptIds: [...receiptIds, ...promotionReceiptIds],
        finishedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });

    // §2.6: a failed job is somebody's to look at, and the platform does not retry it by itself.
    let openItemId: string | null = null;
    if (promotion?.openApproval) {
      // M-T2: the one card in this whole line that is the owner's rather than the coordinator's.
      // Producing it IS the push event §3.3 names; sending the push is the client task's (criterion
      // 13), and nothing here reaches a device.
      const opened = await recordPromotionApproval(tx, {
        projectId: job.projectId,
        ownerId: job.ownerId,
        promotionId: promotion.promotionId,
        jobId: job.id,
        taskId: job.taskId,
        sessionId: job.sessionId,
        title: promotion.openApproval.title,
        dedupeKey: promotionDedupeKey(promotion.promotionId),
        payload: {
          promotionId: promotion.promotionId,
          sourceRef: job.sourceRef,
          upstreamRef: job.targetRef,
          upstreamShaChecked: body.upstreamSha ?? null,
          taskIds: promotion.openApproval.taskIds,
          checks,
          landsAs: 'MERGE_COMMIT',
        },
      });
      openItemId = opened;
      if (openItemId) {
        await tx.projectPromotion.update({
          where: { id: promotion.promotionId },
          data: { openItemId },
        });
      }
    }
    const itemKind = openItemKindForJobState(state);
    if (itemKind) {
      const opened = await recordIntegrationFailure(tx, {
        projectId: job.projectId,
        ownerId: job.ownerId,
        jobId: job.id,
        taskId: job.taskId,
        sessionId: job.sessionId,
        promotionId: job.promotionId,
        state: state as 'CONFLICT' | 'CHECK_FAILED' | 'ERROR',
        title: integrationItemTitle(state, job.kind, job.task?.title ?? 'a task'),
        dedupeKey: integrationDedupeKey(state, job.id),
        payload: failurePayload(state, {
          kind: job.kind,
          phase: body.phase ?? null,
          targetRef: job.targetRef,
          targetSha: body.targetShaBefore ?? null,
          conflicts: body.conflicts ?? [],
          checks,
          errorCode: body.errorCode ?? null,
          errorDetail: body.errorDetail ?? null,
        }),
      });
      openItemId = opened?.itemId ?? openItemId;
    }
    // §2.2 J-T5: the task's landing answers what was open about landing it, in this same
    // transaction — beside the receipt that says the work is there, which is the fact the item was
    // waiting for. Read by TASK rather than by this job: what is still open is an older
    // generation's item, and this landing is what closes it.
    if (jobLanded(state) && job.taskId) {
      await resolveIntegrationItemsOnLanding(tx, job.taskId);
    }

    return {
      answer: {
        accepted: true,
        state: state as never,
        receiptIds: [...receiptIds, ...promotionReceiptIds],
        openItemId,
      },
      after: {
        projectId: job.projectId,
        landedTaskId: jobLanded(state) && !job.promotionId ? job.taskId : null,
        openItemIds: openItemId ? [openItemId] : [],
        // M-F1 for a landing, M-F4 for a promotion that ended: both are the queue getting shorter.
        considerPromotionProjectId:
          job.kind === 'LAND_TASK' || job.kind === 'LAND_PROMOTION' ? job.projectId : null,
      },
    };
  }, onRetry);
}

/** What a person is shown about a failure (§4.2's payload column). */
function failurePayload(
  state: string,
  detail: {
    kind: string;
    phase: string | null;
    targetRef: string;
    targetSha: string | null;
    conflicts: string[];
    checks: IntegrationCheckResult[];
    errorCode: string | null;
    errorDetail: Record<string, unknown> | null;
  },
): Record<string, unknown> {
  if (state === 'CONFLICT') {
    return {
      jobKind: detail.kind,
      phase: detail.phase,
      targetRef: detail.targetRef,
      targetSha: detail.targetSha,
      files: detail.conflicts.slice(0, 200),
      // Said explicitly because it is the first question a reader has: the branch did not move.
      nothingLanded: true,
    };
  }
  if (state === 'CHECK_FAILED') {
    const failed = detail.checks.find((check) => check.exitCode !== check.expectedExitCode)
      ?? detail.checks[detail.checks.length - 1];
    return {
      jobKind: detail.kind,
      check: failed ?? null,
      branchUnchanged: true,
    };
  }
  return { jobKind: detail.kind, errorCode: detail.errorCode, errorDetail: detail.errorDetail };
}

/** The runner clips its own output, and this clips it again: a row is not a log file. */
function clipChecks(checks: IntegrationCheckResult[]): IntegrationCheckResult[] {
  return checks.slice(0, 8).map((check) => ({
    ...check,
    outputTail: typeof check.outputTail === 'string'
      // eslint-disable-next-line no-control-regex
      ? check.outputTail.replace(/ /g, '').slice(-MAX_CHECK_OUTPUT_TAIL)
      : '',
  }));
}
