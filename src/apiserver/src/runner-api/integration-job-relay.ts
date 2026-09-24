import { Injectable, Logger, Optional } from '@nestjs/common';
import { CreatorType, Prisma } from '@prisma/client';
import {
  IntegrationCheckResult,
  IntegrationCheckSpec,
  IntegrationJobCommand,
  IntegrationJobProgressRequest,
  IntegrationJobResultRequest,
  IntegrationJobResultResponse,
  IntegrationJobState,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_CHECK_TIMEOUT_SECONDS,
  INTEGRATION_CLAIM_STALE_MS,
  INTEGRATION_JOBS_PER_HEARTBEAT,
  INTEGRATION_JOB_CLAIM,
  INTEGRATION_JOB_PHASES,
  INTEGRATION_JOB_STATES,
  LandingWorkSessionFacts,
  MAX_CHECK_OUTPUT_TAIL,
  PROMOTION_AUTOMATIC_LAND,
  integrationDedupeKey,
  integrationItemTitle,
  isTerminalJobState,
  jobLanded,
  landingJudgedTooEarly,
  landingLeftWorkBehind,
  openItemKindForJobState,
  queueLandingBehindTheWork,
  shortBranchName,
} from '../projects/project-integration-job';
import {
  recordIntegrationFailure,
  recordPromotionApproval,
  resolveIntegrationItemsOnLanding,
} from '../projects/project-open-item';
import { sessionReportedWork } from '../projects/landing-source-branch';
import { promotionDedupeKey } from '../projects/project-promotion';
import {
  applyPromotionJobResult,
  automaticLandingRefusal,
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
  promotionSourceKind: string | null;
  upstreamShaChecked: string | null;
  mergeTreeSha: string | null;
  /** A landing the project's Automatic setting confirmed (M-T11), bound to the checked tip. */
  confirmedAutomatically: boolean;
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
  // M-T12: whether this process lands an automatic merge only onto the checked tip. One that has not
  // said so is never handed one — it would check a moved main again and merge it, which the
  // Automatic setting does not authorize.
  const landsAutomatically = heartbeat.capabilities?.includes(PROMOTION_AUTOMATIC_LAND) === true;
  for (let i = 0; i < INTEGRATION_JOBS_PER_HEARTBEAT; i += 1) {
    const row = await claimOne(prisma, heartbeat.runnerId, heartbeat.leaseOwner, taken, landsAutomatically)
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
    if (row.confirmedAutomatically && row.promotionId) {
      // M-T11 read again at the last moment the platform decides anything: the owner may have
      // taken the Automatic setting back since the check. A landing it no longer covers is ended
      // here as the owner's card (M-T12) instead of going out on a yes that was withdrawn — and one
      // whose authorization cannot be read at all is not sent either.
      const refusal = await automaticLandingRefusal(prisma, row.promotionId, landsAutomatically)
        .catch((error) => `the authorization could not be read: ${error?.message ?? error}`);
      if (refusal) {
        log.log(`automatic landing ${row.id} handed back to the owner: ${refusal}`);
        const after = await finishHandedBack(prisma, row.id, heartbeat.leaseOwner, row.claimGeneration);
        if (after && after.openItemIds.length > 0) {
          await openItems?.deliverForItems(after.openItemIds);
        }
        continue;
      }
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
      // that rather than from wherever the branch has got to since (§3.4 M-S1). A TASK_BRANCH
      // candidate's first check has none to name and resolves the ref itself (0293).
      ...(row.jobSourceSha ? { sourceSha: row.jobSourceSha } : {}),
      ...(row.promotionSourceKind
        ? { promotionSourceKind: row.promotionSourceKind as 'PROJECT_BRANCH' | 'TASK_BRANCH' }
        : {}),
      ...(row.upstreamShaChecked ? { upstreamShaChecked: row.upstreamShaChecked } : {}),
      ...(row.mergeTreeSha ? { mergeTreeSha: row.mergeTreeSha } : {}),
      ...(row.confirmedAutomatically ? { automatic: true } : {}),
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
  // Which checks a job runs is decided by WHAT IT IS PUTTING WHERE (§3.4 M-S3). A landing on the
  // project branch runs the task's own acceptance on the combined tree, and so does a `TASK_BRANCH`
  // promotion — it is one task's work arriving on the upstream, and the task's acceptance command is
  // the criterion the whole thing was judged by. A `PROJECT_BRANCH` promotion runs the project's
  // merge check and nothing else: every task it carries already passed its own acceptance on the
  // line, and the session the job names belongs to one of those tasks only so the queue can find a
  // checkout to work in — the job itself names no task, which is why `row.acceptanceCommand` here is
  // that session's task's and not the promotion's.
  const taskAcceptanceApplies = row.kind === 'LAND_TASK' || row.promotionSourceKind === 'TASK_BRANCH';
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
  landsAutomatically: boolean,
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
         -- J-T1a / §2.6: a landing is not judged while the task's own work can still move. The
         -- runner commits a worktree when it FINISHES the session (SR13), so a branch handed to the
         -- line during that session is a branch that carries nothing yet: the line can only answer
         -- ALREADY_LANDED about it, that answer is terminal by design, and the commit arrives
         -- afterwards with no route at all. The job stays QUEUED instead, and the first heartbeat
         -- after the session ends is handed it. landingWorkHasSettled is the same rule in
         -- TypeScript (projects/project-integration-job.ts), and the two are read together.
         --
         -- Deliberately only LAND_TASK: it is the kind whose subject is one task. A promotion's
         -- subject is a branch (its row names no task on purpose), and a candidate's own source is
         -- resolved and frozen by the check it exists to run (M-S1, 0293).
         AND (c."kind" <> 'LAND_TASK' OR c."task_id" IS NULL OR NOT EXISTS (
              SELECT 1 FROM "session" w
               WHERE w."task_id" = c."task_id"
                 AND w."starts_task_work" = true
                 AND w."deleted_at" IS NULL
                 AND w."finished_at" IS NULL))
         -- M-T12: a landing the Automatic setting confirmed goes only to a process that lands it
         -- onto the checked tip or not at all. Left queued otherwise, where the owner's Cancel
         -- still reaches it (M-T10), rather than handed to one that would re-check a moved main
         -- and merge it.
         AND (NOT c."confirmed_automatically" OR ${landsAutomatically}::boolean)
         -- M2: while the item about an unresolved absorb of the upstream is still open, no later
         -- landing on that same repository-and-ref is claimed. The conflict is not one task's — it
         -- is the branch's relationship with the upstream, so the NEXT landing would hit exactly the
         -- same paths and open exactly the same card, once per queued task. The item is the retry
         -- mechanism (J5): when the coordinator has dealt with it and the item closes, the queue
         -- moves again on its own.
         AND NOT EXISTS (
           SELECT 1 FROM "project_open_item" i
             JOIN "project_integration_job" f ON f."id" = i."integration_job_id"
            WHERE f."serial_key" = c."serial_key"
              AND f."phase" = 'MAIN_SYNC'
              AND i."kind" = 'INTEGRATION_CONFLICT'
              AND i."state" = 'OPEN')
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
      j."confirmed_automatically" AS "confirmedAutomatically",
      -- Scalar subqueries rather than another join: the FROM list of an UPDATE cannot join ON a
      -- column of the table being updated -- 42P01, invalid reference to FROM-clause entry for
      -- table j -- and a claim that raises is a claim this relay swallows as a warning, which reads
      -- as a queue nobody ever picks up rather than as an error.
      (SELECT p."source_kind" FROM "project_promotion" p
        WHERE p."id" = j."promotion_id") AS "promotionSourceKind",
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

/**
 * A claim of an automatic landing the owner's authorization no longer covers: ended as READY
 * without going to a runner — the very result a runner reports when it finds main moved — so the
 * promotion goes back to the owner as the card they were spared (M-T12). Answers with the aftermath,
 * because that card is owed its delivery and this caller is the only one that knows it opened.
 */
async function finishHandedBack(
  prisma: PrismaService,
  jobId: string,
  leaseOwner: string,
  claimGeneration: bigint,
): Promise<IntegrationResultAftermath | null> {
  const applied = await applyIntegrationJobResult(prisma, {
    jobId,
    body: { claimGeneration: claimGeneration.toString(), leaseOwner, state: 'READY', phase: 'FETCH' },
  }).catch((error) => {
    logger.warn(`could not hand an automatic landing back to the owner: ${error?.message ?? error}`);
    return null;
  });
  return applied?.after ?? null;
}

// ── progress and result ───────────────────────────────────────────────────────────────────────

/**
 * The work sessions of one task, as the two landing rules read them (§2.6 J-T1a).
 *
 * The same three columns `enqueueForDoneTask` freezes a session from, plus the two the finalize
 * writes about how it left the checkout — and every one of them is the runner's fact about its own
 * checkout, never something this process infers.
 */
async function readLandingWorkSessions(
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<LandingWorkSessionFacts[]> {
  const rows = await tx.session.findMany({
    where: { taskId, startsTaskWork: true, deletedAt: null },
    select: {
      id: true, branch: true, worktreeBranch: true, finishedAt: true, assignedRunnerId: true,
    },
  });
  return rows.map((row) => ({
    sessionId: row.id,
    branch: row.branch,
    worktreeBranch: row.worktreeBranch,
    finishedAt: row.finishedAt,
    runnerId: row.assignedRunnerId,
  }));
}

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
      // How far it moved is the runner's count, because the commits are in the runner's repository.
      // Absent when git could not count them, and then the card says less rather than zero.
      await markPromotionRechecking(prisma, job.promotionId, body.upstreamMoved.commits ?? null);
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
        claimLeaseOwner: true, claimGeneration: true, runnerId: true, claimedAt: true,
        session: { select: { baseSha: true } },
        task: { select: { title: true, assigneeId: true, creatorType: true, creatorId: true } },
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

    // §2.6 J-T1a: the task's own work, as the two rules below read it. A landing whose subject is one
    // task is judged against that task's sessions — which is the whole of "can this branch still
    // move", and the reason a job's own `session_id` is not enough here: the incident this rule was
    // written for had its work in a session the enqueue had not frozen.
    const work = job.kind === 'LAND_TASK' && job.taskId
      ? await readLandingWorkSessions(tx, job.taskId)
      : [];

    if (job.kind === 'LAND_TASK' && job.taskId
        && state === 'ALREADY_LANDED' && landingJudgedTooEarly(job.claimedAt, work)) {
      // Not written down as final, and NOT without a trace: the row goes back to the queue it came
      // from, clearing the claim, and the line will be handed it again — which, by the claim guard
      // above, is the first heartbeat after this task's work has stopped moving. Nothing follows
      // from this result (no receipt, no item resolution, nothing for the caller to deliver): it is
      // not an answer, it is the same question asked too early, and the runner is told so rather
      // than told an error, because nothing about its work was wrong.
      await tx.projectIntegrationJob.update({
        where: { id: job.id },
        data: {
          state: 'QUEUED',
          phase: null,
          claimLeaseOwner: null,
          claimedAt: null,
          heartbeatAt: null,
        },
      });
      return {
        answer: { accepted: true, state: 'QUEUED' as never, receiptIds: [], openItemId: null },
        after: null,
      };
    }

    // J-S3's answer about a branch with nothing of the task's own on it (0300). It is not a landing,
    // so the receipt below is not automatic: what a reader of a receipt asks is "is this task's work
    // on that target", and this answer says the branch it was handed holds none of it. It is written
    // only when the task has no work of its own ANYWHERE — where the honest answer is that there is
    // nothing of this task's to land, which is the fact §2.5 J9 releases dependents on.
    //
    // TWO SPELLINGS REACH HERE, and both are the same fact. A runner of 0300's vintage reports
    // NOTHING_TO_LAND outright. A runner older than that reports ALREADY_LANDED — which J-S3 reaches
    // by asking whether the source tip is contained in the base, and an EMPTY branch is contained in
    // everything: its tip is the commit it forked at. That spelling is recognised from the row rather
    // than from git, because the row holds both halves: a source tip equal to the session's own base
    // is a branch that never moved off the commit it started at. This is the branch the incident of
    // 2026-09-23 came through — the retry session that died on a 429, its branch tip being the
    // upstream commit it forked at — and an old runner talking to a new control plane must not be
    // able to write the positive answer about it.
    //
    // It is a LAND_TASK's answer and not a promotion's: a promotion merges a whole branch into an
    // upstream and its empty-source case has an owner-approved card of its own (§3.4), which this
    // does not decide.
    const wroteNothingOfItsOwn = job.kind === 'LAND_TASK'
      && (state === 'NOTHING_TO_LAND'
        || (state === 'ALREADY_LANDED'
          && body.sourceSha != null
          && job.session?.baseSha != null
          && body.sourceSha === job.session.baseSha));
    const effectiveState: IntegrationJobState = wroteNothingOfItsOwn ? 'NOTHING_TO_LAND' : state;
    const ownWork = wroteNothingOfItsOwn && job.taskId
      ? await workSessionsReportingWork(tx, job.taskId)
      : [];
    // The states a receipt is written for: a landing, whose receipt says the work is on the target,
    // and a no-commit answer where the task has no work of its own anywhere — where that is exactly
    // what the receipt has to say for the dependents waiting on it.
    //
    // Read off `effectiveState` and not off what the runner called it: an answer downgraded above is
    // NOT a landing, however it was spelled — and the incident's own row is exactly the downgraded
    // one, so a receipt written there is the false claim all of this exists to stop.
    const receiptState: 'LANDED' | 'ALREADY_LANDED' | 'NOTHING_TO_LAND' | null =
      jobLanded(effectiveState) ? effectiveState
        : wroteNothingOfItsOwn && ownWork.length === 0 ? 'NOTHING_TO_LAND'
          : null;
    const receiptIds = receiptState && job.sessionId && !job.promotionId
      ? await MergeReceiptService.fromIntegrationJob(tx, {
        ownerId: job.ownerId,
        sessionId: job.sessionId,
        taskId: job.taskId,
        projectId: job.projectId,
        jobId: job.id,
        state: receiptState,
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
    // The visible signal J-T5 owes a person when the line says it was handed a branch carrying
    // nothing: the job row is not somewhere anybody looks, and the answer is silent otherwise.
    if (wroteNothingOfItsOwn && job.taskId && job.task) {
      await tx.taskComment.create({
        data: {
          taskId: job.taskId,
          authorType: job.task.assigneeId ? CreatorType.AGENT : job.task.creatorType,
          authorId: job.task.assigneeId ?? job.task.creatorId,
          body: nothingToLandComment({
            branch: shortBranchName(job.sourceRef),
            targetBranch: shortBranchName(job.targetRef),
            branchesWithWork: ownWork,
          }),
        },
      });
    }

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
        runnerId: job.runnerId,
        state,
        upstreamSha: body.upstreamSha ?? null,
        // M-S1: what the job worked from. For a task-branch candidate the runner resolved it off the
        // source ref because nobody had resolved it yet (0293), and this is where the promotion
        // learns the commit the owner is being offered.
        sourceSha: body.sourceSha ?? null,
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
        // The state the row is WRITTEN with, which is the answer rather than the spelling an older
        // runner sent it in: a no-commit answer recorded as `ALREADY_LANDED` is the positive
        // conclusion this exists to stop writing, and a row that says so is what a promotion card
        // and a landing lane go on to read.
        state: effectiveState,
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

    // §2.6, the other half: the line answered about a branch this task's work did not end on, so the
    // commits are on a branch nothing has offered and nothing will — the row just written is terminal
    // and a terminal job is not queued again. The task is owed the NEXT generation bound to the
    // branch the work ended on, and it is written here, after that state (J3's one-inflight-landing
    // index only has room for it once this row has stopped being the live one) and in the same
    // transaction (a landing owed and not recorded is the bug this whole rule is about).
    if (job.kind === 'LAND_TASK' && job.taskId
        && state === 'ALREADY_LANDED' && landingLeftWorkBehind(job, work)) {
      await queueLandingBehindTheWork(tx, {
        ownerId: job.ownerId,
        projectId: job.projectId,
        taskId: job.taskId,
        sessions: work,
      });
    }

    // §2.6: a failed job is somebody's to look at, and the platform does not retry it by itself.
    let openItemId: string | null = null;
    if (promotion?.openApproval) {
      // M-T2: the one card in this whole line that is the owner's rather than the coordinator's.
      // Producing it IS the push event §3.3 names; sending the push is the client task's (criterion
      // 13), and nothing here reaches a device. Absent when the project's Automatic setting
      // confirmed the merge instead (M-T11) — and opened after all, off a landing job, when that
      // merge was handed back because main moved (M-T12).
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
          upstreamShaChecked: promotion.openApproval.upstreamShaChecked,
          taskIds: promotion.openApproval.taskIds,
          checks: promotion.openApproval.checks,
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
    const itemKind = openItemKindForJobState(effectiveState);
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
    if (jobLanded(effectiveState) && job.taskId) {
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
        // J10: the release the tasks downstream were waiting for is the receipt, so this is non-null
        // exactly when one was written above — a `NOTHING_TO_LAND` with the task's work on another
        // branch released nothing, and dispatching the dependents of work that did not move would be
        // the same false claim one layer out.
        landedTaskId: (jobLanded(effectiveState) || receiptIds.length > 0) && !job.promotionId
          ? job.taskId
          : null,
        openItemIds: openItemId ? [openItemId] : [],
        // M-F1 for a landing, M-F4 for a promotion that ended: both are the queue getting shorter.
        considerPromotionProjectId:
          job.kind === 'LAND_TASK' || job.kind === 'LAND_PROMOTION' ? job.projectId : null,
      },
    };
  }, onRetry);
}

/**
 * The branches of this task whose sessions reported work of their own — the branches a delivery is
 * on, read by the same predicate that chose which one the line should have been handed
 * (`landing-source-branch.ts`).
 *
 * This is what decides whether the line's `NOTHING_TO_LAND` is a fact about the TASK or about the
 * branch it happened to be handed. No session reporting work: the task has nothing of its own to
 * land, and the receipt the answer writes is the fact §2.5 J9 releases its dependents on. Some
 * session reporting work: the task's delivery is somewhere the line was not shown, and a receipt
 * naming this target would be the false claim the incident of 2026-09-23 was made of.
 */
async function workSessionsReportingWork(
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<string[]> {
  const sessions = await tx.session.findMany({
    where: {
      taskId,
      startsTaskWork: true,
      deletedAt: null,
      isolationStatus: 'worktree',
      branch: { not: null },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { branch: true, changedFiles: true },
  });
  return [...new Set(
    sessions.filter(sessionReportedWork).map((session) => session.branch as string),
  )];
}

/**
 * What the task is told when the line reports that the branch it was handed carried nothing of the
 * task's own — the visible signal J-T5 owes, since the job row is not somewhere a person looks.
 *
 * It says what the line observed and, when the task has work on another branch, names it: that is
 * the delivery that is not on the target, and the reason the receipt was withheld.
 */
function nothingToLandComment(input: {
  branch: string;
  targetBranch: string;
  branchesWithWork: string[];
}): string {
  const where = input.branchesWithWork.length > 0
    ? `本任务自己的工作在分支 \`${input.branchesWithWork.join('`、`')}\` 上，集成线拿到的是另一个分支；`
      + `这份交付目前不在 \`${input.targetBranch}\` 上，因此也没有写回执。`
    : '本任务没有任何会话报告过工作，因此确实没有东西可落。';
  return `**集成线：没有可落的提交（系统自动记录）**\n\n`
    + `集成线拿到本任务的分支 \`${input.branch}\`，它相对该会话的起点没有任何提交`
    + `（0 轮就结束、或没有提交的会话会留下这样的空分支）。落地作业没有写成「已落地」，也没有推送任何东西。\n\n`
    + where;
}

/** What a person is shown about a failure (§4.2's payload column). */function failurePayload(
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
