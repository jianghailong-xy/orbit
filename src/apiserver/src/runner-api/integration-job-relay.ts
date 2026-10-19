import { HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import { CreatorType, Prisma } from '@prisma/client';
import {
  IntegrationCheckResult,
  IntegrationCheckSpec,
  IntegrationJobCommand,
  IntegrationJobCurrentCheck,
  IntegrationJobOutputCheck,
  IntegrationJobOutputRequest,
  IntegrationJobOutputResponse,
  IntegrationJobPhase,
  IntegrationJobProgressRequest,
  IntegrationJobProgressResponse,
  IntegrationJobReleaseRequest,
  IntegrationJobReleaseResponse,
  IntegrationJobResultRequest,
  IntegrationJobResultResponse,
  IntegrationJobState,
  IntegrationUnknownPush,
  UpstreamMovedCommits,
  UpstreamMovedCommitsEnriched,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  INTEGRATION_CLAIM_STALE_MS,
  INTEGRATION_JOBS_PER_HEARTBEAT,
  INTEGRATION_JOB_CLAIM,
  INTEGRATION_JOB_PHASES,
  INTEGRATION_JOB_STATES,
  INTEGRATION_JOB_STEPS,
  INTEGRATION_PROGRESS_V2,
  INTEGRATION_PROGRESS_V2_PROTOCOL,
  LandingWorkSessionFacts,
  MAX_CHECK_OUTPUT_TAIL,
  PROMOTION_AUTOMATIC_LAND,
  checkSawTheFinishedBranch,
  checksFor,
  enqueueForDoneTask,
  integrationDedupeKey,
  integrationItemTitle,
  isTerminalJobState,
  jobLanded,
  landingFailureClass,
  skippedMergeCheck,
  type SkippedMergeCheckRecord,
  landingJudgedTooEarly,
  landingLeftWorkBehind,
  openItemKindForJobState,
  pushBoundaryPassed,
  queueLandingBehindTheWork,
  shortBranchName,
  timedOutErrorCode,
  workBranchEndedOn,
} from '../projects/project-integration-job';
import {
  abandonPushOutcome,
  INTEGRATION_ABANDON_COORDINATOR_ONLY,
  INTEGRATION_ABANDON_LEASE_LIVE,
  INTEGRATION_ABANDON_NOT_RUNNING,
} from '../projects/project-integration-abandon';
import {
  ownerHoldOnHandledItems,
  recordIntegrationFailure,
  rearmItemFixedBy,
  recordPromotionApproval,
  resolveHandledItems,
  resolveIntegrationItemsOnLanding,
  supersedeHandledItems,
} from '../projects/project-open-item';
import { sessionReportedWork } from '../projects/landing-source-branch';
import { settleLandingAfterJobResult, ensureLandingSession } from '../projects/landing-session';
import { mainBranchOf } from '../projects/project-criterion-landing';
import { readInFlightJobs, readProjectCodebase } from '../projects/project-integration-line';
import {
  INTEGRATION_LOG_HEAD_BYTES,
  INTEGRATION_LOG_MAX_CHUNK_BYTES,
  INTEGRATION_LOG_TAIL_BYTES,
} from '../projects/project-integration-log';
import {
  LIVE_PROMOTION_STATES,
  PromotionState,
  promotionDedupeKey,
} from '../projects/project-promotion';
import {
  applyPromotionJobResult,
  automaticLandingRefusal,
  markPromotionRechecking,
  recoverPromotionPushReceipts,
  refileCandidateBehindTheWork,
} from '../projects/project-promotion.service';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import {
  abandonedText,
  appendIntegrationJobEvent,
  cancelledText,
  checkFinishedText,
  checkStartedText,
  claimedText,
  handedToText,
  pushRefusedText,
  recordCommittedIntegrationJobEvent,
  releasedText,
  requeuedText,
  resultText,
  roundText,
  stepText,
  takenOverText,
} from '../projects/project-integration-event';
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
    ownerId?: string,
  ): Promise<IntegrationJobProgressResponse> {
    return receiveIntegrationJobProgress(this.prisma, runnerId, jobId, body, ownerId);
  }

  /** §2.2 J-T4's output route, §2.9 LS2 — see `receiveIntegrationJobOutput`. */
  output(
    jobId: string,
    runnerId: string,
    body: IntegrationJobOutputRequest,
    ownerId?: string,
  ): Promise<IntegrationJobOutputResponse> {
    return receiveIntegrationJobOutput(this.prisma, { jobId, runnerId, ownerId, body });
  }

  /**
   * §2.2 J-T11 — see `releaseIntegrationJob`. A job somebody asked to stop is not handed back: a
   * QUEUED row with a stop request is never claimed again, so it ends CANCELLED instead, through the
   * result transaction every runner-reported end goes through (J-T12).
   */
  async release(
    jobId: string,
    runnerId: string,
    body: IntegrationJobReleaseRequest,
    ownerId?: string,
  ): Promise<{ answer: IntegrationJobReleaseResponse; after: IntegrationResultAftermath | null }> {
    const released = await releaseIntegrationJob(this.prisma, { jobId, runnerId, ownerId, body });
    if (released.released) {
      // The job goes back to QUEUED, but its subject WAS claimed: LS1's row is owed regardless.
      await ensureLandingSessionAfterClaim(this.prisma, jobId);
      return { answer: { released: true, state: 'QUEUED' }, after: null };
    }
    const applied = await this.applyResult(jobId, runnerId, {
      claimGeneration: body.claimGeneration,
      leaseOwner: body.leaseOwner,
      state: 'CANCELLED',
      ...(released.phase ? { phase: released.phase } : {}),
    }, ownerId);
    return { answer: { released: false, state: applied.answer.state }, after: applied.after };
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
    ownerId?: string,
  ): Promise<{ answer: IntegrationJobResultResponse; after: IntegrationResultAftermath | null }> {
    return applyIntegrationJobResult(
      this.prisma,
      { jobId, runnerId, ownerId, body },
      this.applyResultRetry(),
    );
  }

  /** §2.2 J-T10 — see `abandonIntegrationJob`. */
  abandon(
    input: Parameters<typeof abandonIntegrationJob>[1],
  ): Promise<{ abandoned: AbandonedIntegrationJob; after: IntegrationResultAftermath | null }> {
    return abandonIntegrationJob(this.prisma, input, this.applyResultRetry());
  }

  /**
   * The retry both doors of the result transaction run under. `abandonIntegrationJob` writes
   * through `applyIntegrationJobResult`, so the operation a retried conflict is attributed to is
   * the same one whether a runner reported the end or the platform decided it.
   */
  private applyResultRetry(): Parameters<typeof withTransactionRetry>[2] {
    return loggedRetry(this.logger, 'integrationJob.applyResult');
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
  /** The account the job belongs to: J12's unknown-push list is that account's own queue. */
  ownerId: string;
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
  /** This generation runs no merge check (0393): the account owner approved skipping it. */
  skipMergeCheck: boolean;
  /** A promotion job's frozen source, and the two facts M-S3 compares before it lands. */
  jobSourceSha: string | null;
  promotionId: string | null;
  promotionSourceKind: string | null;
  upstreamShaChecked: string | null;
  mergeTreeSha: string | null;
  /** A landing the project's Automatic setting confirmed (M-T11), bound to the checked tip. */
  confirmedAutomatically: boolean;
  /** The protocol this claim is made under (§2.2 J-T4): `'v2'` or null (legacy). */
  progressProtocol: string | null;
  /** The landing subject this attempt belongs to (§2.9 SQL): what the claim's session row is for. */
  landingId: string | null;
  /** The job's state in the statement that claimed it: RUNNING means this claim is a takeover. */
  previousState: string;
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
  // §2.2 J-T4: the protocol this process's claims are recorded under. A runner that declared
  // `integration-progress/v2` is handed `reportBeforePush` and reports inside every 30 seconds; any
  // other is a legacy claim and keeps the old shape.
  const progressProtocol = heartbeat.capabilities?.includes(INTEGRATION_PROGRESS_V2)
    ? INTEGRATION_PROGRESS_V2_PROTOCOL
    : null;
  // M-T12: whether this process lands an automatic merge only onto the checked tip. One that has not
  // said so is never handed one — it would check a moved main again and merge it, which the
  // Automatic setting does not authorize.
  const landsAutomatically = heartbeat.capabilities?.includes(PROMOTION_AUTOMATIC_LAND) === true;
  // Resolved once, on the first claim of a beat that has one: the claim's timeline line names the
  // runner, and a beat that is handed nothing must not pay for a read it will not use.
  let runnerName: string | null | undefined;
  for (let i = 0; i < INTEGRATION_JOBS_PER_HEARTBEAT; i += 1) {
    const row = await claimOne(prisma, heartbeat.runnerId, heartbeat.leaseOwner, taken, landsAutomatically,
      progressProtocol)
      .catch((error) => {
        // A lost race against another runner's claim surfaces as the partial unique index. It is
        // the index doing its job, not an incident: the next beat looks again.
        log.warn(`integration job claim failed: ${error?.message ?? error}`);
        return null;
      });
    if (!row) break;
    taken.push(row.serialKey);
    // §2.9 LS2: the claim and the takeover are the two facts written AFTER the claim statement
    // commits, in an independent transaction, backfilled from what that statement already decided.
    // A failure here costs the timeline one line (the reader derives the current claim from the job
    // row) and never the claim itself.
    if (runnerName === undefined) {
      runnerName = await prisma.runner
        .findFirst({ where: { id: heartbeat.runnerId }, select: { name: true } })
        .then((runner) => runner?.name ?? null)
        .catch(() => null);
    }
    await backfillClaimEvent(prisma, row, heartbeat, runnerName ?? null, log);
    // §2.9 LS1's compensation point: the claim is committed, so the subject's session row is owed
    // — at the latest before this command is handed out. Only a claimed subject can reach here; a
    // candidate superseded while QUEUED never does. A failure does not cost the runner its command
    // (the row is a record of the claim, not part of it) and the next progress/result compensates.
    await ensureLandingSessionAfterClaim(prisma, row.id);
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
    // J12's receipt repair: the earlier landings on this serial key whose push outcome nobody could
    // read, so this job's fetch can check whether they landed after all. Not a check's business —
    // a CHECK_PROMOTION never pushes.
    const unknownPushes = row.kind === 'CHECK_PROMOTION'
      ? []
      : await unresolvedUnknownPushes(prisma, row);
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
      ...(unknownPushes.length > 0 ? { unknownPushes } : {}),
      // §2.2 J-T4: only a v2 claim is asked to report PUSH synchronously and wait for the answer.
      ...(row.progressProtocol === INTEGRATION_PROGRESS_V2_PROTOCOL ? { reportBeforePush: true as const } : {}),
    });
  }
  return commands;
}

/**
 * The landings on one serial key whose push outcome nobody could read and that have no receipt yet
 * (J12): what the next landing is handed so its fetch can check them.
 *
 * Only rows carrying a `tested_sha` are listed. A legacy claim that died before its synchronous
 * PUSH report left nothing to check, and "cannot tell" is not an answer to give. A receipt is
 * recognised by the job id its detail names — the repair is written against the unknown job, which
 * the terminal guard keeps from ever being rewritten itself (J4) — so a repaired one is not offered
 * again.
 */
async function unresolvedUnknownPushes(
  prisma: PrismaService,
  row: { ownerId: string; serialKey: string },
): Promise<IntegrationUnknownPush[]> {
  return prisma.$queryRaw<IntegrationUnknownPush[]>(Prisma.sql`
    SELECT j."id" AS "jobId", j."tested_sha" AS "testedSha"
      FROM "project_integration_job" j
     WHERE j."owner_id" = ${row.ownerId}::uuid
       AND j."serial_key" = ${row.serialKey}
       AND j."state" = 'ERROR'
       AND j."error_code" = 'PUSH_OUTCOME_UNKNOWN'
       AND j."tested_sha" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "session_merge_receipt" r
          WHERE r."owner_id" = j."owner_id"
            AND r."detail"->>'integrationJobId' = j."id"::text)
     ORDER BY j."finished_at" ASC NULLS LAST, j."id"
     LIMIT 20`);
}

/**
 * Claim the oldest queued job this runner can work on, or take over one whose claimer stopped
 * heartbeating (J-T3).
 *
 * The two are one statement because they are one decision — "which row becomes this process's" —
 * and because splitting them opens a window in which the takeover and the claim each see the other's
 * slot as free.
 *
 * WHAT IT LOCKS IS THE JOB ROW, AND NOTHING ELSE (`FOR UPDATE OF c`). The candidate joins the job to
 * its source session and that session's workspace to decide WHAT may be claimed, but those rows are
 * read for their committed values and are not held: a job gate must not wait on a session lock, and
 * with SKIP LOCKED it would otherwise SKIP a claimable job merely because that session happened to
 * be written at that instant. The judgement those rows feed — J-T1e, "the task's work has stopped
 * moving" — does not become weaker: this is an optimisation that keeps the queue honest, and the
 * authority is the result gate (`landingJudgedTooEarly`), which re-reads the sessions against the
 * claim's own instant before any too-early answer is written down. A session written in between
 * therefore costs a claim that answers too early, not a wrong answer.
 *
 * A STOP REQUESTED ON A RUNNING JOB DOES NOT PREVENT THE TAKEOVER: the new claim's command carries
 * `cancelRequested`, and the runner reports CANCELLED before doing any work. Refusing it would leave
 * the row held by a dead runner with nobody able to end it (J-T3, J-T12). The QUEUED branch is the
 * only one that filters on `cancel_requested_at`, because J-T8 ends such rows in the transaction
 * that asks; any left are rows written before that rule, which the migration backfills.
 */
async function claimOne(
  prisma: PrismaService,
  runnerId: string,
  leaseOwner: string,
  alreadyTaken: string[],
  landsAutomatically: boolean,
  progressProtocol: string | null,
): Promise<ClaimedRow | null> {
  const staleBefore = new Date(Date.now() - INTEGRATION_CLAIM_STALE_MS);
  const rows = await prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
    WITH candidate AS (
      SELECT c."id", c."state"
        FROM "project_integration_job" c
        JOIN "session" s ON s."id" = c."session_id"
        JOIN "workspace" w ON w."id" = s."workspace_id"
       WHERE w."runner_id" = ${runnerId}::uuid
         AND NOT (c."serial_key" = ANY(${alreadyTaken}::text[]))
         -- J-T1a / §2.6 / §3.4: a job whose subject is work is not judged while that work can still
         -- move. The runner commits a worktree when it FINISHES the session (SR13), so a branch
         -- handed to the line during that session is a branch that carries nothing yet: a landing
         -- can only answer ALREADY_LANDED about it, that answer is terminal by design, and the
         -- commit arrives afterwards with no route at all. The job stays QUEUED instead, and the
         -- first heartbeat after the session ends is handed it. landingWorkHasSettled is the same
         -- rule in TypeScript (projects/project-integration-job.ts), and the two are read together.
         --
         -- TWO KINDS, AND WHY THE SECOND ONE HAD TO BE ADDED. A LAND_TASK names its task. A
         -- CHECK_PROMOTION does not — a candidate's subject is a branch, which is why its row names
         -- no task on purpose (0293) — so the task is the one the job's own session belongs to, and
         -- for a TASK_BRANCH candidate that session is the work session the DONE froze. That check
         -- is the thing that resolves the branch's tip and freezes it as the commit the owner is
         -- about to be asked to merge (M-S1), so judging it while the task can still commit hands
         -- the owner a tip the work then moves past: the same race, one level up, and the check is
         -- the only thing that ever looks at that branch again. A PROJECT_BRANCH candidate's source
         -- is named by the platform before its check runs, so this holds it for no reason — it is
         -- the same question about the same work, and the answer costs it one heartbeat. A
         -- LAND_PROMOTION is deliberately out: the owner confirmed a NAMED commit, and a named
         -- commit does not change while a session runs.
         AND (c."kind" NOT IN ('LAND_TASK', 'CHECK_PROMOTION') OR NOT EXISTS (
              SELECT 1 FROM "session" w
                JOIN "session" jw ON jw."id" = c."session_id"
               WHERE w."task_id" = COALESCE(c."task_id", jw."task_id")
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
         --
         -- Except the conflicted task's own later landings. Sending that task back is how a merge
         -- commit absorbing the upstream reaches its source branch (§3.1 M3), and held here, its
         -- next landing would wait on the item it is there to close. The claim cannot read git, so
         -- only the task is decided here; whether the source carries the absorb is J-S2's call on
         -- the runner. With both tips in it, the source lands by J-S4 MERGE and that landing closes
         -- the item. Without them, it meets the same conflict and opens another item, and every
         -- other task's landing waits as before.
         AND NOT EXISTS (
           SELECT 1 FROM "project_open_item" i
             JOIN "project_integration_job" f ON f."id" = i."integration_job_id"
            WHERE f."serial_key" = c."serial_key"
              AND f."phase" = 'MAIN_SYNC'
              AND i."kind" = 'INTEGRATION_CONFLICT'
              AND i."state" = 'OPEN'
              AND f."task_id" IS DISTINCT FROM c."task_id")
         AND (
           -- A queued job whose repository and target ref nobody holds. A QUEUED row somebody asked
           -- to stop is never claimed: J-T8 ends those in the transaction that asks, so one that is
           -- still here is a row written before that rule existed (the migration backfills it).
           (c."state" = 'QUEUED' AND c."cancel_requested_at" IS NULL AND NOT EXISTS (
              SELECT 1 FROM "project_integration_job" r
               WHERE r."serial_key" = c."serial_key" AND r."state" = 'RUNNING'))
           -- Or one this process may take over: claimed, and silent for longer than the lease.
           -- A stop requested while it ran does NOT keep it from being taken over (J-T3): the new
           -- process reads cancelRequested from the command and reports CANCELLED at once. To
           -- refuse the takeover would leave the row with nobody able to end it.
           OR (c."state" = 'RUNNING'
               AND (c."heartbeat_at" IS NULL OR c."heartbeat_at" < ${staleBefore})
               AND c."claim_lease_owner" IS DISTINCT FROM ${leaseOwner})
         )
       ORDER BY c."created_at", c."id"
       FOR UPDATE OF c SKIP LOCKED
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
           -- §2.2 J-T2 / J-T3: every claim records the protocol it is made under. The renewal
           -- fields describe the PREVIOUS claim, so they start empty; push_reported_generation
           -- does not — it is the push boundary's history (J-T4). The FETCH step starts now, which
           -- is the instant §7.2 V6 counts the landing's main clock from.
           "progress_protocol" = ${progressProtocol},
           "round" = NULL,
           "step" = NULL,
           "step_started_at" = now(),
           "output_moved_at" = NULL,
           "current_check" = NULL,
           -- J-T3: taking over a LEGACY claim whose push outcome was never recorded. That runner's
           -- PUSH report was best-effort, so the server cannot rule out that it pushed: the taken-
           -- over generation is written here, which is exactly what J12 reads to answer
           -- PUSH_OUTCOME_UNKNOWN rather than RUNNER_LOST. A v2 claim recorded its own PUSH
           -- synchronously or did not push at all, so it is never backfilled this way.
           "push_reported_generation" = CASE
             WHEN j."state" = 'RUNNING'
              AND (j."progress_protocol" IS DISTINCT FROM ${INTEGRATION_PROGRESS_V2_PROTOCOL})
              AND j."push_reported_generation" IS NULL
             THEN j."claim_generation"
             ELSE j."push_reported_generation" END,
           "updated_at" = now()
      FROM candidate, "project_codebase" cb, "session" s
      LEFT JOIN "workspace" w ON w."id" = s."workspace_id"
      LEFT JOIN "task" t ON t."id" = s."task_id"
     WHERE j."id" = candidate."id"
       AND cb."id" = j."codebase_id"
       AND s."id" = j."session_id"
    RETURNING
      j."id" AS "id",
      j."owner_id" AS "ownerId",
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
      -- §2.4 J-S5 / 0393: a generation whose merge check was approved away. It travels with the
      -- claim because the command this beat builds is where the check would have been handed over.
      j."skip_merge_check" AS "skipMergeCheck",
      j."progress_protocol" AS "progressProtocol",
      j."landing_id" AS "landingId",
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
        WHERE p."id" = j."promotion_id") AS "mergeTreeSha",
      -- What the row was before this statement: RUNNING means the candidate was a silent claim and
      -- this one takes it over (J-T3). Read from the CTE the UPDATE just consumed, so the claim
      -- event's claim/takeover distinction is the statement's own fact and not a second reading of
      -- a row another runner may already have moved.
      (SELECT c."state" FROM candidate c) AS "previousState"
  `);
  return rows[0] ?? null;
}

/**
 * Record the claim the statement just committed (§2.9 LS2): `Claimed by runner … · claim 1` for a
 * job taken off the queue, `Taken over by a new process … · claim 2` when the row was RUNNING (a
 * silent claim this process takes over, J-T3). The distinction is the claim statement's own —
 * `previousState` travels back with the row — never a second reading of a row another runner may
 * have moved by now.
 *
 * Its own transaction, after the claim committed: a failure is logged and costs the timeline one
 * line, and `readLandingTimeline` derives the current claim from the job row when the event is
 * missing, so the attempt does not read as unclaimed.
 */
async function backfillClaimEvent(
  prisma: PrismaService,
  row: ClaimedRow,
  heartbeat: IntegrationDispatchHeartbeat,
  runnerName: string | null,
  log: Logger,
): Promise<void> {
  const claim = Number(row.claimGeneration);
  const takeover = row.previousState === 'RUNNING';
  try {
    await recordCommittedIntegrationJobEvent(prisma, {
      jobId: row.id,
      key: `claim:${claim}`,
      kind: takeover ? 'TAKEN_OVER' : 'CLAIMED',
      claim,
      phase: 'FETCH',
      actor: { type: 'RUNNER' },
      data: {
        claimGeneration: claim,
        runnerId: heartbeat.runnerId,
        runnerName,
        previousState: row.previousState,
      },
      text: takeover ? takenOverText(claim, runnerName) : claimedText(claim, runnerName),
    });
  } catch (error) {
    log.warn(`claim event for job ${row.id} not recorded: ${(error as Error)?.message ?? String(error)}`);
  }
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
 * without going to a runner — the very result a runner reports when it finds main moved — and
 * decided where that result is applied (`automaticLandingCameBack`), which reads the authorization
 * again: gone, and the promotion goes back to the owner as the card they were spared (M-T12).
 * Answers with the aftermath, because that card is owed its delivery and this caller is the only one
 * that knows it opened.
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

/**
 * The work of the task a candidate's job belongs to, and which task that is (§3.4 J-T1e).
 *
 * One level up from `readLandingWorkSessions`: a promotion job names no task of its own — the session
 * it carries is how the queue finds a checkout to work in, which is why it names one at all — and for
 * a `TASK_BRANCH` candidate that session is the work session the DONE froze. The task is read off it
 * and the same rule then applies to that task's work. Null when the job names no session or that
 * session belongs to no task: there is no work to ask about, and a candidate nothing can be said
 * about is judged as it always was.
 */
async function readCandidateWork(
  tx: Prisma.TransactionClient,
  sessionId: string | null,
): Promise<{ taskId: string; sessions: LandingWorkSessionFacts[] } | null> {
  if (!sessionId) return null;
  const session = await tx.session.findUnique({
    where: { id: sessionId },
    select: { taskId: true },
  });
  if (!session?.taskId) return null;
  return { taskId: session.taskId, sessions: await readLandingWorkSessions(tx, session.taskId) };
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

/** Why the abandon door refused, in the shape the controllers turn into a status code (J-T10). */
export type IntegrationAbandonRefusal =
  | 'NOT_FOUND'
  | 'COORDINATOR_ONLY'
  | 'NOT_RUNNING'
  | 'LEASE_LIVE';

export const INTEGRATION_ABANDON_REFUSAL_STATUS: Record<IntegrationAbandonRefusal, number> = {
  NOT_FOUND: 404,
  COORDINATOR_ONLY: 403,
  NOT_RUNNING: 409,
  LEASE_LIVE: 409,
};

/** The `code` each refusal answers with, as §4.7's route table spells it. */
export const INTEGRATION_ABANDON_REFUSAL_CODE: Record<IntegrationAbandonRefusal, string> = {
  // No route table names this one; another account's job, or one of another project, is answered
  // as an id that names nothing, exactly as the retry and job-list doors answer it.
  NOT_FOUND: 'INTEGRATION_ABANDON_NOT_FOUND',
  COORDINATOR_ONLY: INTEGRATION_ABANDON_COORDINATOR_ONLY,
  NOT_RUNNING: INTEGRATION_ABANDON_NOT_RUNNING,
  LEASE_LIVE: INTEGRATION_ABANDON_LEASE_LIVE,
};

export class IntegrationAbandonRefused extends Error {
  constructor(readonly refusal: IntegrationAbandonRefusal, message?: string) {
    super(message ?? refusal);
  }
}

/**
 * The error a door sends: the refusal classes carry a code and a status, and everything else is
 * rethrown untouched. Used by the owner door and the coordinator's runner door alike, so one
 * refusal cannot read two ways.
 */
export function integrationAbandonHttpError(error: unknown): unknown {
  if (error instanceof IntegrationAbandonRefused) {
    return new HttpException(
      { code: INTEGRATION_ABANDON_REFUSAL_CODE[error.refusal], message: error.message },
      INTEGRATION_ABANDON_REFUSAL_STATUS[error.refusal],
    );
  }
  if (error instanceof IntegrationJobRefused) {
    return new HttpException(
      { code: error.refusal, message: error.message },
      INTEGRATION_RESULT_REFUSAL_STATUS[error.refusal],
    );
  }
  return error;
}

/**
 * The extra facts a PLATFORM-written terminal state carries (J-T10's abandon door).
 *
 * A result is reported by the runner that holds the claim, and its fence is
 * `(leaseOwner, claimGeneration)`. The platform ends a job nobody is reporting any more, so it has
 * no lease owner to fence on: the gate is re-decided inside the result transaction — the job is
 * RUNNING, its claim's lease has expired by §7.2 V6, and the coordinator (on the runner door) is
 * the project's current one — and the terminal write is a compare-and-set on the state,
 * `claim_generation`, and the `heartbeat_at` the timeout was judged from. `claim_generation` moves
 * on, so a report or result that arrives after this end is refused.
 */
export interface IntegrationJobPlatformEnd {
  /** Which channel pressed: the owner's user door or the project coordinator's runner door. */
  by: 'owner' | 'coordinator';
  /** The acting session the runner door names; checked against the project's coordinator pointer. */
  sessionId?: string;
  /** The coordinator's explanation, kept on `error_detail`; the owner's door carries none. */
  reason?: string;
}

/**
 * A heartbeat from the runner working on a job (J-T4): the phase it reached, the current check, and
 * the lease renewal that keeps another runner from taking it over.
 *
 * THE ANSWER IS THE STOP SIGNAL IN THE OTHER DIRECTION (§2.2 J-T4): every accepted report answers
 * `cancelRequested`, and a v2 runner that reads true kills the check's process group and reports
 * CANCELLED within 30 seconds. A fence that no longer matches is told apart, because each answer
 * means something different to the runner: 409 STALE_CLAIM (the claim was taken over, released or
 * abandoned), 409 ALREADY_FINAL (the job is written down and the claim can never report again) and
 * 404 (another account's job, or none). All three are stop signals, and none is retried as a
 * transient error.
 *
 * THE PUSH REPORT IS SYNCHRONOUS (§2.2 J-T4): a `phase = PUSH` report writes
 * `push_reported_generation = claim_generation` in the SAME statement that renews the lease, BEFORE
 * this function answers — that row fact is the push boundary every later reader uses, and a runner
 * only pushes after it reads `cancelRequested = false` from this answer.
 *
 * A RENEWAL MUST NOT INVALIDATE THE OPEN LIST'S VERSION: the statement updates the job row, and
 * `readOpenListVersion` fingerprints that table by the columns the list can show, excluding these
 * renewal-only ones (open-list-version.ts).
 */
export async function receiveIntegrationJobProgress(
  prisma: PrismaService,
  runnerId: string,
  jobId: string,
  body: IntegrationJobProgressRequest,
  /** The reporting runner's owner: another account's job is answered as one that does not exist. */
  ownerId?: string,
): Promise<IntegrationJobProgressResponse> {
  const report = progressReport(body);
  // §2.9 LS2: a step's start, a round's start and a check's start are facts the report carries, and
  // they are written in the SAME transaction as the renewal that accepts them — a pure renewal (the
  // pair unchanged) writes the row and no event, which is what "a plain heartbeat is not a timeline
  // line" means. The fence is the statement's, exactly as before: the row it names is read FOR
  // UPDATE first so the events can see what the pair WAS, and the update that follows can only
  // match the id it just locked.
  await withTransactionRetry(prisma, async (tx) => {
    const [before] = await tx.$queryRaw<Array<{
      phase: string | null; step: string | null; round: number | null; currentCheck: unknown;
      sourceRef: string; upstreamRef: string; targetRef: string;
    }>>(Prisma.sql`
      SELECT "phase", "step", "round", "current_check" AS "currentCheck",
             "source_ref" AS "sourceRef", "upstream_ref" AS "upstreamRef", "target_ref" AS "targetRef"
        FROM "project_integration_job"
       WHERE "id" = ${jobId}::uuid
         AND "runner_id" = ${runnerId}::uuid
         AND "state" = 'RUNNING'
         AND "claim_lease_owner" = ${report.leaseOwner}
         AND "claim_generation" = ${BigInt(report.claimGeneration)}
       -- FOR NO KEY UPDATE, not FOR UPDATE: this is a renewal, nothing here changes a key, and the
       -- FOR KEY SHARE that every log-chunk and event INSERT takes on the same row must not wait on
       -- a heartbeat (§2.9 LS2 — the progress gate is a job gate, and its writers must not queue
       -- behind each other's key-share locks).
       FOR NO KEY UPDATE`);
    if (!before) throw await progressRefusal(tx, { jobId, ownerId });
    await tx.$executeRaw(Prisma.sql`
      UPDATE "project_integration_job"
         SET "heartbeat_at" = now(),
             "phase" = ${report.phase},
             "step" = ${report.step},
             "round" = ${report.round},
             "current_check" = ${report.check ? JSON.stringify(report.check) : null}::jsonb,
             "output_moved_at" = CASE
               WHEN ${report.outputIdleMs}::int IS NULL THEN NULL
               ELSE now() - (${report.outputIdleMs}::int * interval '1 millisecond') END,
             -- §7.2 V6: the landing head's main timer counts from here, and a "step" in J-T4 /
             -- J-T9 is the (phase, sub-step) pair. Any change of that pair — including a sub-step
             -- going back to none, when the phase moves on — starts the clock again; a pure
             -- renewal (both unchanged) leaves it where it was.
             "step_started_at" = CASE
               WHEN "phase" IS DISTINCT FROM ${report.phase}::text
                 OR "step" IS DISTINCT FROM ${report.step}::text
                 THEN now()
               ELSE "step_started_at" END,
             -- §2.2 J-T4's push boundary, written in the statement that accepts the report.
             "push_reported_generation" = CASE
               WHEN ${report.phase}::text = 'PUSH' THEN "claim_generation"
               ELSE "push_reported_generation" END,
             -- J12: what the synchronous PUSH report says about the commit about to be pushed. It is
             -- safe to record only here — the report is sent before the push, and the claim still
             -- holds the row — and it is what lets the next landing on this serial key check an
             -- unknown outcome later. COALESCE: a report never overwrites a fact already written.
             "tested_sha" = COALESCE("tested_sha", ${report.testedSha}::char(40)),
             "tested_tree_sha" = COALESCE("tested_tree_sha", ${report.testedTreeSha}::char(40)),
             "source_sha" = COALESCE("source_sha", ${report.sourceSha}::char(40)),
             "target_sha_before" = COALESCE("target_sha_before", ${report.targetShaBefore}::char(40)),
             "updated_at" = now()
       WHERE "id" = ${jobId}::uuid`);
    await appendProgressEvents(tx, {
      jobId,
      runnerId,
      report,
      before,
    });
  }, loggedRetry(logger, 'integrationJob.progress'));
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
  // Read AFTER the write, so a stop written between the report and this answer is in it: the
  // runner acts on this answer before it pushes.
  const [job] = await prisma.$queryRaw<Array<{ cancelRequestedAt: Date | null }>>(Prisma.sql`
    SELECT "cancel_requested_at" AS "cancelRequestedAt"
      FROM "project_integration_job"
     WHERE "id" = ${jobId}::uuid`);
  // §2.9 LS1's compensation point: the report's write is committed, so a subject still without its
  // session row (a claim whose insert failed) is given one now.
  await ensureLandingSessionAfterClaim(prisma, jobId);
  return { accepted: true, cancelRequested: job?.cancelRequestedAt != null };
}

/** The optional half of a report, validated once, in the shape the row is written with. */
function progressReport(body: IntegrationJobProgressRequest): {
  claimGeneration: string;
  leaseOwner: string;
  phase: IntegrationJobPhase;
  step: string | null;
  round: number | null;
  check: IntegrationJobCurrentCheck | null;
  outputIdleMs: number | null;
  testedSha: string | null;
  testedTreeSha: string | null;
  sourceSha: string | null;
  targetShaBefore: string | null;
} {
  if (typeof body?.leaseOwner !== 'string' || body.leaseOwner === ''
      || typeof body?.claimGeneration !== 'string' || !/^\d{1,19}$/.test(body.claimGeneration)) {
    throw new IntegrationJobRefused(
      'INVALID_RESULT', 'a progress report names the claim it renews: claimGeneration and leaseOwner',
    );
  }
  if (!INTEGRATION_JOB_PHASES.includes(body.phase as never)) {
    throw new IntegrationJobRefused('INVALID_RESULT', `unknown phase ${body.phase}`);
  }
  const step = body.step ?? null;
  if (step != null && !INTEGRATION_JOB_STEPS.includes(step as never)) {
    throw new IntegrationJobRefused('INVALID_RESULT', `unknown step ${step}`);
  }
  const round = body.round ?? null;
  if (round != null && (!Number.isSafeInteger(round) || round < 1)) {
    throw new IntegrationJobRefused('INVALID_RESULT', `round must be an integer from 1, not ${round}`);
  }
  const check = body.check ?? null;
  let current: IntegrationJobCurrentCheck | null = null;
  if (check != null) {
    const name = check.name;
    if (name !== 'TASK_ACCEPTANCE' && name !== 'MERGE_CHECK') {
      throw new IntegrationJobRefused('INVALID_RESULT', `unknown check name ${name}`);
    }
    if (![check.index, check.count, check.budgetSeconds].every((n) => Number.isSafeInteger(n) && n >= 1)) {
      throw new IntegrationJobRefused(
        'INVALID_RESULT', 'a current check carries a positive integer index, count and budgetSeconds',
      );
    }
    const startedAt = new Date(check.startedAt);
    if (typeof check.startedAt !== 'string' || Number.isNaN(startedAt.getTime())) {
      throw new IntegrationJobRefused('INVALID_RESULT', `check.startedAt is not an instant: ${check.startedAt}`);
    }
    current = {
      name, index: check.index, count: check.count, budgetSeconds: check.budgetSeconds,
      startedAt: startedAt.toISOString(),
    };
  }
  const outputIdleMs = body.outputIdleMs ?? null;
  if (outputIdleMs != null && (!Number.isFinite(outputIdleMs) || outputIdleMs < 0)) {
    throw new IntegrationJobRefused('INVALID_RESULT', `outputIdleMs must be a non-negative number, not ${outputIdleMs}`);
  }
  // J12's push facts are the PUSH report's own, and nowhere else's — a later phase going by does
  // not describe a commit this job is about to push. Absent is "not measured".
  const onPush = body.phase === 'PUSH';
  return {
    claimGeneration: body.claimGeneration,
    leaseOwner: body.leaseOwner,
    phase: body.phase,
    step,
    round,
    check: current,
    outputIdleMs: outputIdleMs == null ? null : Math.round(outputIdleMs),
    testedSha: onPush ? reportSha(body.testedSha, 'testedSha') : null,
    testedTreeSha: onPush ? reportSha(body.testedTreeSha, 'testedTreeSha') : null,
    sourceSha: onPush ? reportSha(body.sourceSha, 'sourceSha') : null,
    targetShaBefore: onPush ? reportSha(body.targetShaBefore, 'targetShaBefore') : null,
  };
}

/** A commit a progress report names, or null when it names none. A malformed one is refused. */
function reportSha(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new IntegrationJobRefused('INVALID_RESULT', `${field} is not a full commit sha: ${String(value)}`);
  }
  return value;
}

/** The `current_check` a report replaces, read back in the shape it was stored with. */
function storedCurrentCheck(value: unknown): { name: string; index: number; startedAt: string } | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  return typeof row.name === 'string' && Number.isSafeInteger(row.index) && typeof row.startedAt === 'string'
    ? { name: row.name, index: row.index as number, startedAt: row.startedAt }
    : null;
}

/**
 * The facts a progress report carries, appended in the transaction that accepted it (§2.9 LS2).
 *
 * A PURE RENEWAL WRITES NOTHING: the pair (phase, step), the round and the check are compared with
 * what the row held before the statement, and only a change is a line. A check's start is the
 * runner's own `startedAt`, so the line sorts where the check really began even though it is
 * written when the first report naming it arrives.
 */
async function appendProgressEvents(
  tx: Prisma.TransactionClient,
  input: {
    jobId: string;
    runnerId: string;
    report: ReturnType<typeof progressReport>;
    before: {
      phase: string | null; step: string | null; round: number | null; currentCheck: unknown;
      sourceRef: string; upstreamRef: string; targetRef: string;
    };
  },
): Promise<void> {
  const claim = Number(input.report.claimGeneration);
  const round = input.report.round;
  if (round !== null && round !== input.before.round) {
    await appendIntegrationJobEvent(tx, {
      jobId: input.jobId,
      key: `round:${claim}:${round}`,
      kind: 'ROUND',
      claim,
      round,
      phase: input.report.phase,
      data: { round },
      text: roundText(round),
    });
  }
  if (input.report.phase !== input.before.phase || input.report.step !== input.before.step) {
    // The occurrence number is what keeps a step that starts twice inside one claim — a LAND_TASK's
    // re-fetch — from colliding with its own earlier line. It is computed under the row lock, and a
    // replayed report never reaches here (it changes nothing).
    const stepOrdinal = 1 + await tx.projectIntegrationJobEvent.count({
      where: { jobId: input.jobId, kind: 'STEP', claimGeneration: BigInt(claim) },
    });
    await appendIntegrationJobEvent(tx, {
      jobId: input.jobId,
      key: `step:${claim}:${round ?? 0}:${input.report.phase}:${input.report.step ?? 'none'}:${stepOrdinal}`,
      kind: 'STEP',
      claim,
      round,
      phase: input.report.phase,
      step: input.report.step,
      data: { phase: input.report.phase, step: input.report.step, round },
      text: stepText({
        phase: input.report.phase,
        step: input.report.step,
        sourceRef: input.before.sourceRef,
        upstreamRef: input.before.upstreamRef,
        targetRef: input.before.targetRef,
      }),
    });
  }
  const check = input.report.check;
  const prior = storedCurrentCheck(input.before.currentCheck);
  if (check && (prior?.name !== check.name || prior?.index !== check.index
      || prior?.startedAt !== check.startedAt)) {
    const runner = await tx.runner.findFirst({ where: { id: input.runnerId }, select: { name: true } });
    await appendIntegrationJobEvent(tx, {
      jobId: input.jobId,
      key: `check-start:${claim}:${round ?? 0}:${check.index}`,
      kind: 'CHECK_STARTED',
      claim,
      round,
      check: { name: check.name, index: check.index },
      phase: 'CHECK',
      data: {
        name: check.name,
        index: check.index,
        count: check.count,
        budgetSeconds: check.budgetSeconds,
        startedAt: check.startedAt,
      },
      text: checkStartedText(check, claim, runner?.name ?? null),
      at: new Date(check.startedAt),
    });
  }
}

/**
 * Why a progress report matched no row: the three answers §2.2 J-T4 gives a runner, each of which
 * makes it stop. A job of another account is answered as one that does not exist, exactly as the
 * release and result doors answer it; a terminal job is ALREADY_FINAL; anything else is a claim
 * that was taken over, released or abandoned (STALE_CLAIM).
 */
async function progressRefusal(
  prisma: Pick<PrismaService, 'projectIntegrationJob'>,
  input: { jobId: string; ownerId?: string },
): Promise<IntegrationJobRefused> {
  const job = await prisma.projectIntegrationJob.findFirst({
    where: { id: input.jobId, ...(input.ownerId != null ? { ownerId: input.ownerId } : {}) },
    select: { state: true },
  });
  if (!job) return new IntegrationJobRefused('NOT_FOUND');
  if (isTerminalJobState(job.state)) return new IntegrationJobRefused('ALREADY_FINAL');
  return new IntegrationJobRefused('STALE_CLAIM');
}

/**
 * One chunk of a running check's output (POST /runner/integration-jobs/:jobId/output, contract
 * §2.2 J-T4, §2.9 LS2), written to `project_integration_job_log` under the claim it names.
 *
 * THE FENCE IS THE PROGRESS REPORT'S. The job row is taken FOR UPDATE in the transaction, matched on
 * this runner, `RUNNING`, the exact (leaseOwner, claimGeneration), so a chunk from a claim that was
 * taken over, released or abandoned writes nothing and is told STALE_CLAIM; a terminal job is
 * ALREADY_FINAL; another account's job is 404. A takeover therefore cannot receive output from the
 * process it replaced, which is the same property a result has.
 *
 * THE CAP IS APPLIED IN THE SAME TRANSACTION, after the insert: the check's chunks are read in seq
 * order, the first bytes up to the head cap and the last bytes up to the tail cap are kept, and every
 * chunk between them is deleted with its byte count (and any bytes it already marked) added to the
 * first retained tail row's `truncatedBytes`. Holding the job row while it trims serialises two
 * chunks of one check, so two writers cannot each compute a cap the other then exceeds.
 *
 * NOTHING ELSE IS WRITTEN: no job row column, no run_event (this is not a transcript event), no
 * session. The route is a job gate and never waits on a session lock (§2.9 LS2).
 *
 * A chunk whose seq is already stored is the chunk already stored: the insert is ON CONFLICT DO
 * NOTHING and the answer is still accepted, so a runner that resends after a lost answer does not
 * create a second copy or a failure.
 */
export async function receiveIntegrationJobOutput(
  prisma: PrismaService,
  input: { jobId: string; runnerId: string; ownerId?: string; body: IntegrationJobOutputRequest },
): Promise<IntegrationJobOutputResponse> {
  const chunk = outputChunk(input.body);
  await withTransactionRetry(
    prisma,
    async (tx) => {
      const [job] = await tx.$queryRaw<Array<{ round: number }>>(Prisma.sql`
        SELECT COALESCE("round", 1)::int AS "round"
          FROM "project_integration_job"
         WHERE "id" = ${input.jobId}::uuid
           AND "runner_id" = ${input.runnerId}::uuid
           ${input.ownerId != null ? Prisma.sql`AND "owner_id" = ${input.ownerId}::uuid` : Prisma.empty}
           AND "state" = 'RUNNING'
           AND "claim_lease_owner" = ${chunk.leaseOwner}
           AND "claim_generation" = ${BigInt(chunk.claimGeneration)}
         FOR UPDATE`);
      if (!job) throw await progressRefusal(tx, input);
      // The claim is ours: the chunk row. A resent seq inserts nothing, which is the idempotency
      // the key names; either way the trim below runs against the committed set.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "project_integration_job_log"
               ("id", "job_id", "claim_generation", "round", "check_name", "check_index", "seq", "text")
        VALUES (gen_random_uuid(), ${input.jobId}::uuid, ${BigInt(chunk.claimGeneration)}, ${job.round},
                ${chunk.check.name}, ${chunk.check.index}, ${chunk.seq}, ${chunk.text})
        ON CONFLICT ("job_id", "claim_generation", "round", "check_name", "check_index", "seq")
        DO NOTHING`);
      await trimIntegrationJobLog(tx, {
        jobId: input.jobId,
        claimGeneration: chunk.claimGeneration,
        round: job.round,
        check: chunk.check,
      });
    },
    loggedRetry(logger, 'integrationJob.output'),
  );
  return { accepted: true };
}

/** What one upload's body must be, validated once, in the shape the row is written with. */
function outputChunk(body: IntegrationJobOutputRequest): {
  claimGeneration: string;
  leaseOwner: string;
  check: IntegrationJobOutputCheck;
  seq: number;
  text: string;
} {
  if (typeof body?.leaseOwner !== 'string' || body.leaseOwner === ''
      || typeof body?.claimGeneration !== 'string' || !/^\d{1,19}$/.test(body.claimGeneration)) {
    throw new IntegrationJobRefused(
      'INVALID_RESULT', 'an output chunk names the claim it belongs to: claimGeneration and leaseOwner',
    );
  }
  const name = body.check?.name;
  if (name !== 'TASK_ACCEPTANCE' && name !== 'MERGE_CHECK') {
    throw new IntegrationJobRefused('INVALID_RESULT', `unknown check name ${String(name)}`);
  }
  const index = body.check.index;
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new IntegrationJobRefused('INVALID_RESULT', `check.index must be an integer from 1, not ${String(index)}`);
  }
  if (!Number.isSafeInteger(body.seq) || body.seq < 0) {
    throw new IntegrationJobRefused('INVALID_RESULT', `seq must be a non-negative integer, not ${String(body.seq)}`);
  }
  if (typeof body.text !== 'string') {
    throw new IntegrationJobRefused('INVALID_RESULT', 'text is the chunk itself');
  }
  if (Buffer.byteLength(body.text, 'utf8') > INTEGRATION_LOG_MAX_CHUNK_BYTES) {
    throw new IntegrationJobRefused(
      'INVALID_RESULT',
      `one chunk carries at most ${INTEGRATION_LOG_MAX_CHUNK_BYTES} bytes`,
    );
  }
  return {
    claimGeneration: body.claimGeneration,
    leaseOwner: body.leaseOwner,
    check: { name, index },
    seq: body.seq,
    text: body.text,
  };
}

/**
 * Keep one check's output within its cap: the head and the tail stay, the middle goes, and the bytes
 * it held are recorded where a reader meets the gap.
 *
 * Chunks are the unit, not bytes, so a row that straddles the head (or tail) boundary is kept whole
 * and the retained total can exceed the cap by at most one chunk per side. The gap belongs on the
 * FIRST retained tail row, because that is where the head stops and the tail starts; a marker row
 * that itself later falls out of the tail takes its accumulated count with it into the new gap.
 */
async function trimIntegrationJobLog(
  tx: Prisma.TransactionClient,
  key: { jobId: string; claimGeneration: string; round: number; check: IntegrationJobOutputCheck },
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string; seq: number; bytes: number; truncatedBytes: number }>>(Prisma.sql`
    SELECT "id", "seq", octet_length("text")::int AS "bytes", "truncated_bytes" AS "truncatedBytes"
      FROM "project_integration_job_log"
     WHERE "job_id" = ${key.jobId}::uuid
       AND "claim_generation" = ${BigInt(key.claimGeneration)}
       AND "round" = ${key.round}
       AND "check_name" = ${key.check.name}
       AND "check_index" = ${key.check.index}
     ORDER BY "seq" ASC`);
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  if (total <= INTEGRATION_LOG_HEAD_BYTES + INTEGRATION_LOG_TAIL_BYTES) return;
  const head = new Set<string>();
  let headBytes = 0;
  for (const row of rows) {
    if (headBytes >= INTEGRATION_LOG_HEAD_BYTES) break;
    head.add(row.id);
    headBytes += row.bytes;
  }
  const tail = new Set<string>();
  let tailBytes = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (tailBytes >= INTEGRATION_LOG_TAIL_BYTES) break;
    tail.add(rows[i].id);
    tailBytes += rows[i].bytes;
  }
  // With both caps kept and the total above them, the tail always holds at least one row, so there is
  // always somewhere to record the gap.
  const marker = rows.find((row) => tail.has(row.id));
  const middle = rows.filter((row) => !head.has(row.id) && !tail.has(row.id));
  if (!marker || middle.length === 0) return;
  const gap = middle.reduce((sum, row) => sum + row.bytes + row.truncatedBytes, 0);
  await tx.projectIntegrationJobLog.deleteMany({ where: { id: { in: middle.map((row) => row.id) } } });
  await tx.projectIntegrationJobLog.update({
    where: { id: marker.id },
    data: { truncatedBytes: { increment: gap } },
  });
}

/** What a release came to when nothing was refused: back in the queue, or owed a CANCELLED end. */
export type IntegrationJobReleaseOutcome =
  | { released: true }
  | { released: false; phase: IntegrationJobPhase | null };

/**
 * A claimed job handed back by the process that holds it (J-T11): a runner that is stopping, for a
 * job it never started or one it stopped before its push. Nothing was pushed under the claim, so the
 * job goes back to QUEUED for the next heartbeat that asks for work — on a stopping runner, its next
 * process — instead of staying RUNNING until the lease runs out ten minutes after its last report.
 *
 * ONE TRANSACTION (§2.9 LS2): the row moves back to QUEUED and the timeline's `RELEASED` fact is
 * written with it. Release is a fact of the job gate like any other — only the claim and the
 * takeover are the contract's after-commit exceptions — so the hand-back never leaves a row that
 * moved without its line. The fence is the claim the request names: the row is read FOR NO KEY
 * UPDATE under it, and a stop already asked answers `released: false` for the caller to end (J-T12).
 * The claim generation moves on, so a late report under the claim given back is refused
 * STALE_CLAIM; the lease and the step are cleared, which frees the serial key (J1); the first
 * `started_at` stays.
 */
export async function releaseIntegrationJob(
  prisma: PrismaService,
  input: { jobId: string; runnerId: string; ownerId?: string; body: IntegrationJobReleaseRequest },
): Promise<IntegrationJobReleaseOutcome> {
  const body = input.body;
  if (typeof body?.leaseOwner !== 'string' || body.leaseOwner === ''
      || typeof body.claimGeneration !== 'string' || !/^\d{1,19}$/.test(body.claimGeneration)) {
    throw new IntegrationJobRefused('INVALID_RESULT', 'a release names the claim it gives back: claimGeneration and leaseOwner');
  }
  const claimGeneration = BigInt(body.claimGeneration);
  return withTransactionRetry(prisma, async (tx) => {
    const [held] = await tx.$queryRaw<Array<{
      state: string; runnerId: string | null; leaseOwner: string | null; claimGeneration: bigint;
      cancelRequestedAt: Date | null; phase: string | null; round: number | null;
    }>>(Prisma.sql`
      SELECT "state", "runner_id" AS "runnerId", "claim_lease_owner" AS "leaseOwner",
             "claim_generation" AS "claimGeneration", "cancel_requested_at" AS "cancelRequestedAt",
             "phase", "round"
        FROM "project_integration_job"
       WHERE "id" = ${input.jobId}::uuid
         ${input.ownerId != null ? Prisma.sql`AND "owner_id" = ${input.ownerId}::uuid` : Prisma.empty}
       FOR NO KEY UPDATE`);
    // Another account's job is answered as one that does not exist, exactly as the result route does.
    if (!held) throw new IntegrationJobRefused('NOT_FOUND');
    if (isTerminalJobState(held.state)) throw new IntegrationJobRefused('ALREADY_FINAL');
    if (held.state !== 'RUNNING' || held.runnerId !== input.runnerId
        || held.leaseOwner !== body.leaseOwner || held.claimGeneration !== claimGeneration) {
      throw new IntegrationJobRefused('STALE_CLAIM');
    }
    // A job somebody asked to stop is not handed back: a QUEUED row with a stop request is never
    // claimed, so the caller ends it through the result transaction (J-T12).
    if (held.cancelRequestedAt) {
      return {
        released: false,
        phase: INTEGRATION_JOB_PHASES.includes(held.phase as never) ? held.phase as IntegrationJobPhase : null,
      };
    }
    const runner = await tx.runner.findFirst({ where: { id: input.runnerId }, select: { name: true } });
    await tx.projectIntegrationJob.updateMany({
      where: { id: input.jobId, state: 'RUNNING', claimGeneration },
      data: {
        state: 'QUEUED',
        phase: null,
        claimGeneration: { increment: 1 },
        claimLeaseOwner: null,
        claimedAt: null,
        heartbeatAt: null,
      },
    });
    await appendIntegrationJobEvent(tx, {
      jobId: input.jobId,
      key: `released:${claimGeneration.toString()}`,
      kind: 'RELEASED',
      claim: claimGeneration,
      round: held.round ?? null,
      actor: { type: 'RUNNER' },
      data: { claimGeneration: claimGeneration.toString(), runnerId: input.runnerId, runnerName: runner?.name ?? null },
      text: releasedText(Number(claimGeneration), runner?.name ?? null),
    });
    return { released: true };
  }, loggedRetry(logger, 'integrationJob.release'));
}

/** What the caller must do after the transaction that applied a result committed. */
export interface IntegrationResultAftermath {
  projectId: string;
  landedTaskId: string | null;
  /**
   * The exception items this result opened — and, for a fix task's landing, the item it fixes,
   * re-keyed for its coordinator (§4.4 X-D4 5) — by id, for the door that delivered the result to
   * hand over. By item rather than by task because a promotion job names no task (§3.4): the caller
   * is the only thing holding that row's id, and no read finds it by a task it does not have.
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
  /**
   * `ownerId`, the reporting runner's owner: another account's job is answered as one that does not
   * exist. `projectId` is set only by the abandon door, which addresses a job under a project; the
   * result route names the job alone.
   */
  input: {
    jobId: string; projectId?: string; runnerId?: string; ownerId?: string;
    body: IntegrationJobResultRequest;
  },
  onRetry?: Parameters<typeof withTransactionRetry>[2],
  /** Set only by the abandon door (J-T10): the platform, not a runner, writes this terminal state. */
  platformEnd?: IntegrationJobPlatformEnd,
): Promise<{ answer: IntegrationJobResultResponse; after: IntegrationResultAftermath | null }> {
  let body = input.body;
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

  const applied = await withTransactionRetry(prisma, async (tx) => {
    // Found among the reporting runner's owner's jobs only, before anything about it is answered: a
    // runner of another account is told neither that the job exists, nor the state it ended in, nor
    // that it is still live — an id that names nothing is what it gets (T2 of the tenant isolation
    // census). A runner of the same owner meets the claim fence below, as J-T3 has it.
    const job = await tx.projectIntegrationJob.findFirst({
      where: {
        id: input.jobId,
        ...(input.projectId != null ? { projectId: input.projectId } : {}),
        ...(input.ownerId != null ? { ownerId: input.ownerId } : {}),
      },
      select: {
        id: true, projectId: true, ownerId: true, kind: true, state: true,
        taskId: true, sessionId: true, promotionId: true, targetRef: true, sourceRef: true,
        upstreamRef: true, round: true,
        // J12: the queue the job belongs to, which is the scope an unknown push is repaired on.
        serialKey: true,
        codebaseId: true, cancelRequestedAt: true,
        claimLeaseOwner: true, claimGeneration: true, runnerId: true, claimedAt: true,
        // The columns J-T10's gate and J12's answer are read from: the phase the job stopped at,
        // the protocol the current claim was made under, and whether that claim recorded a PUSH.
        phase: true, progressProtocol: true, pushReportedGeneration: true,
        generation: true, retryOfJobId: true, retryFailureClass: true, retryReason: true,
        retryRequestedBySessionId: true,
        retryRequestedByUserId: true,
        // 0393: what this generation ran instead of its merge check, so the failure it goes on to
        // open can say so — a red reported by a landing whose check never ran must not read as a
        // check that failed.
        skipMergeCheck: true, skipReason: true, skipApprovedByUserId: true, skipApprovalId: true,
      },
    });
    if (!job) throw new IntegrationJobRefused('NOT_FOUND');
    /**
     * J-T10's common gate, decided in THIS transaction and before anything is written: the caller
     * is the project's current coordinator (the runner door), the job is RUNNING, and its claim's
     * lease has expired by §7.2 V6's one definition (read through `readInFlightJobs`, which also
     * knows that a job waiting on this runner's local lock is not timed out). No retry door's item
     * ownership, Automatic switch or owner-blocker rule applies: an abandoned job is not a failure
     * anybody is deciding, it is a runner that will never report again.
     */
    let platformHeartbeatAt: Date | null | undefined;
    if (platformEnd) {
      const project = await tx.project.findFirst({
        where: { id: job.projectId, ownerId: job.ownerId },
        select: { coordinatorSessionId: true },
      });
      if (!project) throw new IntegrationAbandonRefused('NOT_FOUND');
      if (platformEnd.by === 'coordinator'
          && (!platformEnd.sessionId || project.coordinatorSessionId !== platformEnd.sessionId)) {
        throw new IntegrationAbandonRefused('COORDINATOR_ONLY',
          'only the conversation this project is coordinated from may abandon one of its jobs. '
          + 'A task\'s own run does not decide what happens to the work it finished, and another '
          + 'project\'s coordinator does not decide this one\'s.');
      }
      if (job.state !== 'RUNNING') {
        throw new IntegrationAbandonRefused('NOT_RUNNING',
          `this job is ${job.state}, not RUNNING: there is no claim to abandon. A queued job is `
          + 'stopped by the stop door, and a finished one has already been written down.');
      }
      const [silent] = await readInFlightJobs(tx, job.projectId, job.id);
      if (!silent || silent.state !== 'RUNNING') {
        throw new IntegrationAbandonRefused('NOT_RUNNING',
          'this job stopped being RUNNING while the abandon was being decided: there is no claim '
          + 'left to abandon. Read the job again.');
      }
      if (!silent.timedOut) {
        throw new IntegrationAbandonRefused('LEASE_LIVE',
          'this job\'s runner is still reporting: its lease has not expired, so the work is not '
          + 'lost and abandoning it would end a job somebody is working on. Wait for its result, or '
          + 'stop it if it must not go on.');
      }
      // The gate's own answer, and the answer J12 gives for this kind and claim. Anything that
      // may have pushed says so: only a CHECK_PROMOTION, or a landing whose current claim is v2
      // and recorded no PUSH, may claim nothing was pushed.
      const errorCode = timedOutErrorCode(job);
      const pushRecorded = pushBoundaryPassed(job);
      platformHeartbeatAt = silent.heartbeatAt;
      body = {
        ...body,
        claimGeneration: job.claimGeneration.toString(),
        leaseOwner: job.claimLeaseOwner ?? '',
        ...(job.phase ? { phase: job.phase as IntegrationJobPhase } : {}),
        errorCode,
        errorDetail: {
          abandoned: true,
          by: platformEnd.by,
          ...(platformEnd.sessionId ? { sessionId: platformEnd.sessionId } : {}),
          ...(platformEnd.reason ? { reason: platformEnd.reason } : {}),
          phase: job.phase,
          lastReportAt: (silent.heartbeatAt ?? job.claimedAt ?? new Date()).toISOString(),
          limitSeconds: silent.limitSeconds,
          runnerName: silent.runnerName,
          pushRecorded,
          pushOutcome: abandonPushOutcome(errorCode),
        },
      };
    }
    if (isTerminalJobState(job.state)) {
      if (platformEnd) {
        throw new IntegrationAbandonRefused('NOT_RUNNING', 'this job is already terminal');
      }
      // Not an error the runner has to do anything about: a result whose response was lost is
      // resent, and the second copy finds the job already written down.
      return {
        answer: { accepted: false, state: job.state as never, receiptIds: [], openItemId: null },
        after: null,
      };
    }
    if (!platformEnd && (
      job.claimLeaseOwner !== body.leaseOwner
      || job.claimGeneration !== BigInt(body.claimGeneration)
      || (input.runnerId != null && job.runnerId !== input.runnerId)
    )) {
      throw new IntegrationJobRefused('STALE_CLAIM');
    }

    // J-T8: a stop was asked of this claim. What that changes below — a result that came back
    // "too early", a branch the work did not end on, a failure nobody asked to hear about — is
    // read from here rather than inferred from the state.
    const cancelRequested = job.cancelRequestedAt !== null;
    // J-T8: a stopped LAND_TASK is serialized with the DONE transaction that may be queueing at the
    // same moment. That transaction takes the project binding (rank 55) and then counts this
    // generation as in flight; this one takes the SAME row, BEFORE it reads the marker or the task
    // and before any rank-60 write, and it takes it for every stopped LAND_TASK rather than only
    // when the marker is already visible. The two orders then have exactly two outcomes:
    //   * the DONE commits first — this read sees DONE and the marker, and queues the generation;
    //   * this transaction wins — the DONE waits for it, then counts this generation as terminal
    //     and queues its own generation with no loss.
    // A lock taken only on what a plain pre-read saw would close neither: the DONE transaction
    // never waits for a reader, so the result could commit after a DONE that found this generation
    // still in flight, and both would decide the other was queueing.
    //
    // An ABANDONED LAND_TASK is one of the stopped generations J-T8 names (revision 24): the
    // DONE that was deferred behind this generation is queued in the transaction that ends it,
    // even though abandoning never retries the abandoned generation itself.
    const stoppedLanding = job.kind === 'LAND_TASK' && job.taskId != null
      && (cancelRequested || platformEnd !== undefined);
    if (stoppedLanding) {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "project_codebase"
         WHERE "project_id" = ${job.projectId}::uuid AND "slot" = 'primary'
         FOR UPDATE`);
    }
    // A stopped LAND_TASK whose task was reopened and written DONE again is owed the next
    // generation, queued in THIS transaction once the row below stops being the live one (J-T8).
    // WHATEVER RESULT the stopped generation reports: today's runner reads `cancelRequested` once,
    // when it starts, so a stop asked mid-job is almost always followed by the real answer —
    // LANDED, ALREADY_LANDED, NOTHING_TO_LAND, CHECK_FAILED, CONFLICT, ERROR — and the commits of
    // the DONE that came after the reopen are on a branch no generation of that DONE was ever
    // queued for. The marker is what says that DONE is waiting, and it is consumed by the enqueue.
    const queuesReopenedDone = stoppedLanding
      && (await tx.taskReopenIntent.findFirst({
        where: { taskId: job.taskId! }, select: { taskId: true },
      })) !== null
      && (await tx.task.findFirst({
        where: { id: job.taskId! }, select: { status: true },
      }))?.status === 'DONE';
    /**
     * Queue the generation the DONE written after the reopen is owed, once this one is terminal —
     * whatever it ended as. The marker and the task's status are asked again here, after the
     * terminal write: the binding lock above orders this transaction against the DONE, and this
     * second read keeps a task somebody took away again in between from being queued. A task that
     * is still being reworked queues nothing, and its marker lives until a DONE comes.
     */
    const queueReopenedDone = async (): Promise<void> => {
      if (!queuesReopenedDone || job.taskId == null) return;
      const intent = await tx.taskReopenIntent.findFirst({
        where: { taskId: job.taskId }, select: { taskId: true },
      });
      if (!intent) return;
      const nowDone = await tx.task.findFirst({
        where: { id: job.taskId }, select: { status: true },
      });
      if (nowDone?.status !== 'DONE') return;
      await enqueueForDoneTask(tx, job.ownerId, job.taskId);
    };

    // The task this job is about, read BESIDE the job rather than below it: `task_id` is a history
    // reference with no foreign key (0423), so it may name a task that is no longer there — the
    // trace a deleted task leaves behind — and a job of a deleted task still has a result to record.
    // A read that may find nothing, where a relation could only ever be null for a promotion.
    const task = job.taskId
      ? await tx.task.findFirst({
        where: { id: job.taskId },
        select: { title: true, assigneeId: true, creatorType: true, creatorId: true },
      })
      : null;
    // The session it was queued from, read beside it for the same reason: `session_id` is a history
    // reference too (0424), and a session purged from Trash leaves its id behind. Not found is the
    // NULL the key used to write — which is all the receipt below may be written against, since its
    // `session_id` IS a foreign key — and the same goes for the task the receipt and an item name.
    const session = job.sessionId
      ? await tx.session.findFirst({ where: { id: job.sessionId }, select: { id: true, baseSha: true } })
      : null;
    const liveTaskId = task ? job.taskId : null;

    // §2.6 J-T1a: the task's own work, as the two rules below read it. A landing whose subject is one
    // task is judged against that task's sessions — which is the whole of "can this branch still
    // move", and the reason a job's own `session_id` is not enough here: the incident this rule was
    // written for had its work in a session the enqueue had not frozen.
    const work = job.kind === 'LAND_TASK' && job.taskId
      ? await readLandingWorkSessions(tx, job.taskId)
      : [];

    // J-S4's NOTHING_TO_LAND about a branch that DID carry commits of the task's own, every one of
    // which the target already had (`sourceFullyApplied`, 0410). It pushed nothing, like every
    // NOTHING_TO_LAND. Unlike the empty branch's, it says the task's work IS on the target: the
    // positive answer ALREADY_LANDED gives, measured on the commits' changes rather than on the tip.
    // So it is held to the same two rules: an answer taken before the work stopped moving is not
    // written down (J-T1e), and an answer about a branch the work did not end on lands nothing of it
    // (§2.6). When it speaks for the task's work, it is followed by what follows a landing.
    const fullyApplied = job.kind === 'LAND_TASK' && state === 'NOTHING_TO_LAND'
      && body.sourceFullyApplied === true;

    if (job.kind === 'LAND_TASK' && job.taskId
        && (state === 'ALREADY_LANDED' || fullyApplied) && landingJudgedTooEarly(job.claimedAt, work)) {
      // Not written down as final, and NOT without a trace: the row goes back to the queue it came
      // from, clearing the claim, and the line will be handed it again — which, by the claim guard
      // above, is the first heartbeat after this task's work has stopped moving. Nothing follows
      // from this result (no receipt, no item resolution, nothing for the caller to deliver): it is
      // not an answer, it is the same question asked too early, and the runner is told so rather
      // than told an error, because nothing about its work was wrong.
      //
      // A STOP WAS ASKED, though, and a QUEUED row is never left carrying one (J-T8, and the CHECK
      // the migration adds): the row ends CANCELLED here rather than becoming a row nothing would
      // ever claim. The answer it was asked for is not written down either — same reason as above.
      await tx.projectIntegrationJob.update({
        where: { id: job.id },
        data: cancelRequested
          ? { state: 'CANCELLED', phase: null, finishedAt: new Date() }
          : {
            state: 'QUEUED',
            phase: null,
            claimLeaseOwner: null,
            claimedAt: null,
            heartbeatAt: null,
          },
      });
      // §2.9 LS2: the requeue (or, stopped, the CANCELLED end) is a fact of this door's
      // transaction. The row goes back without an answer, and without this line the attempt would
      // show no reason for being asked again.
      await appendIntegrationJobEvent(tx, {
        jobId: job.id,
        key: cancelRequested ? 'cancelled' : `requeued:${Number(job.claimGeneration)}`,
        kind: cancelRequested ? 'CANCELLED' : 'REQUEUED',
        claim: Number(job.claimGeneration),
        round: job.round ?? null,
        phase: job.phase,
        actor: { type: 'PLATFORM' },
        ...(cancelRequested ? { reason: 'the answer was asked for while the work was still moving' } : {}),
        data: { cause: 'TASK_WORK_STILL_MOVING' },
        text: cancelRequested ? cancelledText() : requeuedText(),
      });
      // A stopped generation that answered too early still ends here, so the DONE written after
      // the reopen has room for its own generation (J-T8) — the same requeue every other terminal
      // result takes below.
      await queueReopenedDone();
      return {
        answer: {
          accepted: true,
          state: (cancelRequested ? 'CANCELLED' : 'QUEUED') as never,
          receiptIds: [],
          openItemId: null,
        },
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
          && session?.baseSha != null
          && body.sourceSha === session.baseSha));
    const effectiveState: IntegrationJobState = wroteNothingOfItsOwn ? 'NOTHING_TO_LAND' : state;
    const ownWork = wroteNothingOfItsOwn && job.taskId
      ? await workSessionsReportingWork(tx, job.taskId)
      : [];
    // A positive answer about a branch the task's work did not end on (§2.6): it says nothing about
    // that work, which is owed a landing of its own (queued below, once this job is written).
    const leftWorkBehind = job.kind === 'LAND_TASK' && (state === 'ALREADY_LANDED' || fullyApplied)
      && landingLeftWorkBehind(job, work);
    // A fully applied branch holds its own session's reported work, and that work is the work the
    // line measured on the target: only work reported on ANOTHER branch keeps its receipt back.
    const workElsewhere = ownWork.filter((branch) => branch !== shortBranchName(job.sourceRef));
    // The states a receipt is written for: a landing, whose receipt says the work is on the target,
    // and a no-commit answer where the task has no work of its own anywhere — where that is exactly
    // what the receipt has to say for the dependents waiting on it. A fully applied answer says the
    // first in the second's spelling: the work is on the target, and nothing moved, when the branch
    // it measured is where all of the task's work is and where it ended.
    //
    // Read off `effectiveState` and not off what the runner called it: an answer downgraded above is
    // NOT a landing, however it was spelled — and the incident's own row is exactly the downgraded
    // one, so a receipt written there is the false claim all of this exists to stop.
    const receiptState: 'LANDED' | 'ALREADY_LANDED' | 'NOTHING_TO_LAND' | null =
      jobLanded(effectiveState) ? effectiveState
        : fullyApplied ? (workElsewhere.length === 0 && !leftWorkBehind ? 'NOTHING_TO_LAND' : null)
          : wroteNothingOfItsOwn && ownWork.length === 0 ? 'NOTHING_TO_LAND'
            : null;
    // §3.4, J-T1e one level up: a candidate's subject is a BRANCH, so the task it is about is the one
    // its session belongs to — and the same two questions are asked of that task's work before the
    // check may freeze the tip it resolved as the commit the owner will be shown. A `TASK_BRANCH`
    // candidate's source is resolved by the check itself (M-S1, 0293), and the check is the only
    // thing that ever looks at that branch: freeze a tip while the work can still move and the owner
    // is asked to merge a commit the branch has already moved past, with nothing left to ask again.
    if (job.kind === 'CHECK_PROMOTION' && job.promotionId && state === 'READY') {
      const candidate = await readCandidateWork(tx, job.sessionId);
      if (candidate) {
        if (landingJudgedTooEarly(job.claimedAt, candidate.sessions)) {
          // The same refusal as the landing above, and for the same reason: this is not an answer, it
          // is the same question asked too early. The row goes back to the queue, where the claim
          // guard above holds it until the task's work has stopped moving; the check then resolves
          // the branch as it stands by then — carrying the commit this one could not have seen.
          // A stop asked of it ends it CANCELLED instead: a QUEUED row never keeps one (J-T8).
          await tx.projectIntegrationJob.update({
            where: { id: job.id },
            data: cancelRequested
              ? { state: 'CANCELLED', phase: null, finishedAt: new Date() }
              : {
                state: 'QUEUED',
                phase: null,
                claimLeaseOwner: null,
                claimedAt: null,
                heartbeatAt: null,
              },
          });
          // §2.9 LS2: the requeue (or the stopped end) is this door's fact, and the timeline owes
          // it the reason the check was asked again.
          await appendIntegrationJobEvent(tx, {
            jobId: job.id,
            key: cancelRequested ? 'cancelled' : `requeued:${Number(job.claimGeneration)}`,
            kind: cancelRequested ? 'CANCELLED' : 'REQUEUED',
            claim: Number(job.claimGeneration),
            round: job.round ?? null,
            phase: job.phase,
            actor: { type: 'PLATFORM' },
            ...(cancelRequested ? { reason: 'the check answered while the work was still moving' } : {}),
            data: { cause: 'CANDIDATE_WORK_STILL_MOVING' },
            text: cancelRequested ? cancelledText() : requeuedText(),
          });
          return {
            answer: {
              accepted: true,
              state: (cancelRequested ? 'CANCELLED' : 'QUEUED') as never,
              receiptIds: [],
              openItemId: null,
            },
            after: null,
          };
        }
        if (!checkSawTheFinishedBranch(job, candidate.sessions)) {
          // The check looked at a branch the task's work did not end on, so the tip it resolved is
          // not the work's — and no re-check of that branch would ever make it so. The candidate is
          // retired and the branch the work IS on gets the candidate it was owed, which is what
          // asking the owner about this work means. Written BEFORE the promotion is applied below,
          // and that order is the whole of how the freeze is refused: `applyPromotionJobResult` will
          // not move a promotion that has already ended. The job row still records what this check
          // answered, about the branch it was handed — the fact that retired the candidate.
          await refileCandidateBehindTheWork(tx, {
            promotionId: job.promotionId,
            taskId: candidate.taskId,
            sessions: candidate.sessions,
          });
        }
      }
    }

    const receiptIds = receiptState && session && !job.promotionId
      ? await MergeReceiptService.fromIntegrationJob(tx, {
        ownerId: job.ownerId,
        sessionId: session.id,
        taskId: liveTaskId,
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
    if (wroteNothingOfItsOwn && job.taskId && task) {
      await tx.taskComment.create({
        data: {
          taskId: job.taskId,
          authorType: task.assigneeId ? CreatorType.AGENT : task.creatorType,
          authorId: task.assigneeId ?? task.creatorId,
          body: fullyApplied
            ? fullyAppliedComment({
              branch: shortBranchName(job.sourceRef),
              targetBranch: shortBranchName(job.targetRef),
              branchesWithWork: workElsewhere,
              endedOn: leftWorkBehind ? workBranchEndedOn(work)?.branch ?? null : null,
            })
            : nothingToLandComment({
              branch: shortBranchName(job.sourceRef),
              targetBranch: shortBranchName(job.targetRef),
              branchesWithWork: ownWork,
            }),
        },
      });
    }

    const checks = clipChecks(body.checks ?? []);
    // J-T13's commits, with the control plane's own reading of each one: whether it arrived from
    // outside the landing queue, and which merge of this account's put it there. Written on the job
    // row — never in `errorDetail`, which is copied verbatim into an item's payload and its
    // delivery text.
    const upstreamMovedCommits = await enrichUpstreamMovedCommits(tx, {
      ownerId: job.ownerId,
      serialKey: job.serialKey,
      moved: body.upstreamMovedCommits ?? null,
    });
    // J12: an earlier landing on this queue whose push outcome nobody could read, now found on the
    // target. Its receipt is written against THAT job — the row is terminal and must not be
    // rewritten (J4) — and this job's result transaction is where it happens.
    const recoveredReceiptIds = await recoverUnknownPushReceipts(tx, {
      ownerId: job.ownerId,
      serialKey: job.serialKey,
      checks: Array.isArray(body.unknownPushes) ? body.unknownPushes : [],
    });
    // §4.7 H2 for a candidate: the coordinator's rerun of a blocked candidate's check passed, so the
    // items it was handling are HANDLED in its name — BEFORE the promotion is applied below, because
    // the Automatic setting's own rule counts every open integration item of the project (M-T11), and
    // an item this very check just answered must not be what keeps the candidate from it. An item the
    // owner holds by now is not touched, and is counted: the merge then waits on their card.
    if (job.kind === 'CHECK_PROMOTION' && job.promotionId && state === 'READY') {
      await resolveHandledItems(tx, job.id);
    }
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
        // J-T8: the result settles a cancellation that was asked of this claim — unless it landed.
        cancelRequested,
        // J12's code, so the promotion can tell a push that lost a race (J-T13) from a failure M-T9
        // blocks for, and whether the runner is one that reports the move at all: an older runner's
        // ERROR / TARGET_MOVED keeps today's path.
        errorCode: body.errorCode ?? null,
        movedCommitsReported: upstreamMovedCommits !== null,
        // The same enriched list, for the two facts the promotion's own transition records in this
        // transaction: an automatic landing that found main moved checks again (M-T12), and an
        // owner-confirmed one queues the next generation under the same confirmation (J-T13).
        movedCommits: upstreamMovedCommits,
      })
      : null;
    const promotionReceiptIds = promotion?.receiptIds ?? [];
    const terminalData = {
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
      // The runner's measurement and nothing else (0346): only a boolean it sent is written, so a
      // row an older runner answered keeps NULL — "not measured" — which §1.4 withholds on.
      sourceOnUpstream: typeof body.sourceOnUpstream === 'boolean' ? body.sourceOnUpstream : undefined,
      // The same for the other measurement a NOTHING_TO_LAND carries (0410).
      sourceFullyApplied: typeof body.sourceFullyApplied === 'boolean' ? body.sourceFullyApplied : undefined,
      checks: checks as unknown as Prisma.InputJsonValue,
      conflicts: (body.conflicts ?? []).slice(0, 200),
      errorCode: body.errorCode ?? undefined,
      errorDetail: (body.errorDetail ?? undefined) as Prisma.InputJsonValue | undefined,
      // J-T13's list, enriched above. NULL for every job that did not move the upstream.
      upstreamMovedCommits: (upstreamMovedCommits ?? undefined) as Prisma.InputJsonValue | undefined,
      receiptIds: [...receiptIds, ...promotionReceiptIds, ...recoveredReceiptIds],
      finishedAt: new Date(),
      heartbeatAt: new Date(),
    };
    if (platformEnd) {
      // J-T10's compare-and-set: still RUNNING under the claim this gate was judged on, at the very
      // heartbeat the lease expiry was read from. A report that arrived since moved the heartbeat
      // and a takeover moved the generation; either way the end is refused rather than written over
      // work that is talking again, and `claim_generation + 1` closes the door on late reports and
      // results (they are ALREADY_FINAL / rejected).
      const ended = await tx.projectIntegrationJob.updateMany({
        where: {
          id: job.id,
          state: 'RUNNING',
          claimGeneration: job.claimGeneration,
          ...(platformHeartbeatAt === null
            ? { heartbeatAt: null }
            : { heartbeatAt: platformHeartbeatAt }),
        },
        data: { ...terminalData, claimGeneration: { increment: 1 } },
      });
      if (ended.count !== 1) {
        throw new IntegrationAbandonRefused('LEASE_LIVE',
          'this job\'s runner reported again while the abandon was being decided, so its claim is '
          + 'not expired any more. Read the job again.');
      }
    } else {
      await tx.projectIntegrationJob.update({ where: { id: job.id }, data: terminalData });
    }

    // §2.6, the other half: the line answered about a branch this task's work did not end on, so the
    // commits are on a branch nothing has offered and nothing will — the row just written is terminal
    // and a terminal job is not queued again. The task is owed the NEXT generation bound to the
    // branch the work ended on, and it is written here, after that state (J3's one-inflight-landing
    // index only has room for it once this row has stopped being the live one) and in the same
    // transaction (a landing owed and not recorded is the bug this whole rule is about).
    //
    // EXCEPT WHEN SOMEBODY ASKED IT TO STOP (J-T8): a generation being cancelled does not queue the
    // next one. The stop is the answer — the task was reopened or taken away — and a landing queued
    // here would be work nobody asked for. (A reopened task written DONE again gets its generation
    // from the marker below, not from this rule.)
    if (leftWorkBehind && job.taskId && !cancelRequested) {
      await queueLandingBehindTheWork(tx, {
        ownerId: job.ownerId,
        projectId: job.projectId,
        taskId: job.taskId,
        sessions: work,
      });
    }

    // §2.2 J-T8: the generation was stopped, and the task was reopened and written DONE again while
    // it was still in flight — that DONE could not queue (J3's index still named this row), and its
    // marker was kept for this moment. The row above is now terminal, whatever it ended as (a
    // legacy runner never reads the stop, so LANDED / CHECK_FAILED / CONFLICT / ERROR are all
    // ordinary answers here), so the next generation has room. `enqueueForDoneTask` is the DONE's
    // own route (it consumes the marker), so the new generation is exactly the one that DONE would
    // have queued.
    await queueReopenedDone();

    // §2.6: a failed job is somebody's to look at, and the platform does not retry it by itself.
    let openItemId: string | null = null;
    /** The item or card this result handed to somebody, for the timeline's `HANDED_TO` fact. */
    let handedTo: { itemId: string; assignee: 'COORDINATOR' | 'OWNER'; itemKind: string } | null = null;
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
        handedTo = { itemId: openItemId, assignee: 'OWNER', itemKind: 'PROMOTION_APPROVAL' };
        await tx.projectPromotion.update({
          where: { id: promotion.promotionId },
          data: { openItemId },
        });
      }
    }
    const itemKind = openItemKindForJobState(effectiveState);
    // §4.2: a promotion job's failure belongs to its candidate, and a candidate that left the live
    // states while the job ran — superseded, declined, cancelled or merged — is waiting on nobody.
    // `applyPromotionJobResult` kept the answer it had for that reason, and the report is on the job
    // row written above; an item opened about it would be a todo nothing is left to close, escalated
    // to the owner and counted against the project's next candidate by M-T11.
    const candidateMovedOn = itemKind !== null && job.promotionId !== null
      && !LIVE_PROMOTION_STATES.includes((await tx.projectPromotion.findUnique({
        where: { id: job.promotionId },
        select: { state: true },
      }))?.state as PromotionState);
    // J-T8: a job somebody asked to stop does not open a card for the work it is stopping. A
    // failure it reports before it gets the stop is a fact about work nobody is waiting for any
    // more — the task was reopened or taken away, the candidate was superseded or retired — and an
    // item about it would be a todo with no door its owner would take. Revision 24 extends that to
    // a STOPPED generation that is then abandoned: stop and abandon both say it is not wanted.
    // Abandoning a generation that was NOT stopped is the other case and keeps the item (J-T10 and
    // §4's INTEGRATION_ERROR row): its work is not on the line, no result will ever say so, and the
    // item is the door through which the coordinator reaches `integration_retry`. The condition is
    // therefore `cancelRequested` alone, not the abandon path as such.
    //
    // J-T13: neither does a refused push that was re-queued as the next generation under the same
    // confirmation. Nobody is being asked to fix anything — the candidate is still the owner's, and
    // the new landing is already queued — so an item would be a todo whose only answer is "wait".
    // The third consecutive one is BLOCKED instead, and that result opens its item as any failure.
    if (itemKind && !candidateMovedOn && !cancelRequested && promotion?.requeuedUnderConfirmation !== true) {
      // A promotion's item is named after the merge it is about: into the project's main branch.
      const mainBranch = job.kind === 'LAND_TASK'
        ? null
        : mainBranchOf(await readProjectCodebase(tx, job.projectId));
      const opened = await recordIntegrationFailure(tx, {
        projectId: job.projectId,
        ownerId: job.ownerId,
        jobId: job.id,
        // The item's `task_id` is a foreign key; its `session_id` is history, like the job's (0278).
        taskId: liveTaskId,
        sessionId: job.sessionId,
        promotionId: job.promotionId,
        state: state as 'CONFLICT' | 'CHECK_FAILED' | 'ERROR',
        title: integrationItemTitle(state, job.kind, task?.title ?? 'a task', mainBranch),
        dedupeKey: integrationDedupeKey(state, job.id),
        // §4.7 H4: when this job is a rerun whose item the clock handed to the owner while it ran, the
        // failure it opens stays theirs — the coordinator's rerun does not carry the decision back.
        heldByOwner: await ownerHoldOnHandledItems(tx, job.id),
        payload: failurePayload(state, {
          kind: job.kind,
          phase: body.phase ?? null,
          targetRef: job.targetRef,
          targetSha: body.targetShaBefore ?? null,
          conflicts: body.conflicts ?? [],
          checks,
          errorCode: body.errorCode ?? null,
          errorDetail: body.errorDetail ?? null,
          // J-T13: at the payload's TOP level, a field of its own — the delivery text's generator
          // does not read it, so the replay it does stays byte-for-byte the same.
          upstreamMovedCommits,
          generation: job.generation,
          retry: job.retryOfJobId
            ? {
                retryOfJobId: job.retryOfJobId,
                failureClass: job.retryFailureClass,
                reason: job.retryReason,
                requestedBySessionId: job.retryRequestedBySessionId,
                requestedByUserId: job.retryRequestedByUserId,
              }
            : null,
          skippedCheck: skippedMergeCheck(job),
        }),
      });
      openItemId = opened?.itemId ?? openItemId;
      if (opened) {
        handedTo = { itemId: opened.itemId, assignee: opened.assignee, itemKind };
      }
      // §4.7 H3: a rerun that failed again supersedes the items it was handling with the one it just
      // opened, in this transaction — the old card ends RETRIED and points at the new failure, which
      // is in front of somebody; nothing about it is closed quietly.
      if (opened) await supersedeHandledItems(tx, job.id, opened.itemId);
    }
    // §2.2 J-T5: the task's landing answers what was open about landing it, in this same
    // transaction — beside the receipt that says the work is there, which is the fact the item was
    // waiting for. Read by TASK rather than by this job: what is still open is an older
    // generation's item, and this landing is what closes it. An answer about a branch the work did
    // NOT end on is not that landing: it says nothing about the work, and the item it would close can
    // be the only record that the work has not reached the line — the landing owed for it failed, and
    // a generation of the work is owed only one (§2.3 J-T1e, `landingBehindTheWorkKey`). A fully
    // applied answer that speaks for the work (its receipt state is set) is that landing too: the work
    // is on the target, and nothing was pushed because nothing was missing.
    if ((jobLanded(effectiveState) || (fullyApplied && receiptState !== null)) && job.taskId && !leftWorkBehind) {
      // §4.7 H2 first: the items the coordinator's rerun was handling are HANDLED in its name, and
      // only then does the landing answer whatever else is open about the task (LANDED, by the
      // platform) — including an item the clock gave the owner while the rerun ran.
      await resolveHandledItems(tx, job.id);
      await resolveIntegrationItemsOnLanding(tx, job.taskId);
    }
    // §4.4 X-D4 (5): this task was filed to fix an exception, and its landing is in — receipted, and
    // not the answer about a branch the work did not end on. Whether the work that exception is
    // about went in with it is the coordinator's to check, so the item goes back in front of it.
    const rearmedItemId = job.kind === 'LAND_TASK' && job.taskId && receiptState !== null && !leftWorkBehind
      ? await rearmItemFixedBy(tx, job.taskId)
      : null;

    // §2.9 LS2: the facts this result IS — each check's result, a refused push, the answer itself,
    // who it was handed to, an abandonment — recorded in the transaction that wrote the terminal
    // state, after every write above so the row they read is the one that stands. A replay writes
    // none of them twice: each key is the fact.
    await appendResultEvents(tx, {
      job,
      requestedState: state,
      effectiveState,
      body,
      checks,
      upstreamMovedCommits,
      platformEnd,
      handedTo,
      movedMain: promotion?.movedMain ?? null,
      finishedAt: terminalData.finishedAt,
    });

    return {
      answer: {
        accepted: true,
        state: state as never,
        receiptIds: [...receiptIds, ...promotionReceiptIds, ...recoveredReceiptIds],
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
        openItemIds: [openItemId, rearmedItemId].filter((id): id is string => id !== null),
        // M-F1 for a landing, M-F4 for a promotion that ended: both are the queue getting shorter.
        considerPromotionProjectId:
          job.kind === 'LAND_TASK' || job.kind === 'LAND_PROMOTION' ? job.projectId : null,
      },
    };
  }, onRetry);
  // §2.9 LS3: the landing / cancellation fact is committed, so the subjects it settles close in
  // their own transaction — never inside this one, and never from a claim. Idempotent: a resend
  // finds the job terminal, and this still runs and settles what is still open.
  await settleLandingAfterJobResult(prisma, input.jobId);
  // §2.9 LS1's last compensation point: the result is committed and its subjects settled, so a
  // subject that never got its row gets one now — terminal, exactly as `ensure` writes a settled
  // subject. It runs after settlement on purpose: the row then starts in the status the subject
  // ended in, instead of being inserted open and moved a statement later.
  await ensureLandingSessionAfterClaim(prisma, input.jobId);
  return applied;
}

/** The job columns the result's timeline facts are written from. */
interface ResultJobRow {
  id: string;
  ownerId: string;
  kind: string;
  targetRef: string;
  upstreamRef: string;
  sourceRef: string;
  claimGeneration: bigint;
  runnerId: string | null;
  round: number | null;
}

/**
 * The facts a result IS, appended in the transaction that wrote the terminal state (§2.9 LS2):
 * each check's start and result, a refused push with its moved commits, the answer, who it was
 * handed to, and — for J-T10 — the abandonment with who pressed it and why.
 *
 * A CHECK START THE RUNNER NEVER REPORTED is reconstructed from the result's own durations: a
 * legacy claim reports only at step boundaries, and the timeline still owes each check a start
 * line. The instant is the result's `finishedAt` less the durations of the checks that ran at or
 * after it, and the event says so (`derivedFromDuration`); a start a v2 report already recorded is
 * the row that stands, because the key is the check.
 */
async function appendResultEvents(
  tx: Prisma.TransactionClient,
  input: {
    job: ResultJobRow;
    /** The state the runner spelled; `effectiveState` is what the row was written with. */
    requestedState: string;
    effectiveState: string;
    body: IntegrationJobResultRequest;
    checks: IntegrationCheckResult[];
    upstreamMovedCommits: UpstreamMovedCommitsEnriched | null;
    platformEnd?: IntegrationJobPlatformEnd | undefined;
    handedTo: { itemId: string; assignee: 'COORDINATOR' | 'OWNER'; itemKind: string } | null;
    /** A moved-main fact the promotion's own transition produced, written after the answer. */
    movedMain?: { kind: 'RECHECK_ON_MOVED_MAIN' | 'NEXT_GENERATION'; text: string; data: Record<string, unknown> } | null;
    finishedAt: Date;
  },
): Promise<void> {
  const job = input.job;
  const claim = Number(job.claimGeneration);
  const round = job.round ?? null;
  const phase = input.body.phase ?? null;

  const runner = input.checks.length > 0 && job.runnerId
    ? await tx.runner.findFirst({ where: { id: job.runnerId }, select: { name: true } })
    : null;
  // The checks ran one after the other, so the one that finished last ended at `finishedAt` and
  // the one before it the later check's duration earlier; each started its own duration before
  // that. The instants are explicit so the section reads start → finish → the answer, whatever
  // order the rows are written in.
  let trailingMs = 0;
  const instants: Array<{ startedAt: Date; endedAt: Date }> = new Array(input.checks.length);
  for (let index = input.checks.length; index >= 1; index -= 1) {
    const durationMs = Math.max(0, input.checks[index - 1].durationMs);
    const endedAt = new Date(input.finishedAt.getTime() - trailingMs);
    instants[index - 1] = { startedAt: new Date(endedAt.getTime() - durationMs), endedAt };
    trailingMs += durationMs;
  }
  for (let index = 1; index <= input.checks.length; index += 1) {
    const check = input.checks[index - 1];
    const { startedAt, endedAt } = instants[index - 1];
    await appendIntegrationJobEvent(tx, {
      jobId: job.id,
      key: `check-start:${claim}:${round ?? 0}:${index}`,
      kind: 'CHECK_STARTED',
      claim,
      round,
      check: { name: check.name, index },
      phase: 'CHECK',
      data: {
        name: check.name,
        index,
        startedAt: startedAt.toISOString(),
        derivedFromDuration: true,
      },
      text: checkStartedText(check, claim, runner?.name ?? null),
      at: startedAt,
    });
    await appendIntegrationJobEvent(tx, {
      jobId: job.id,
      key: `check-done:${claim}:${round ?? 0}:${index}`,
      kind: 'CHECK_FINISHED',
      claim,
      round,
      check: { name: check.name, index },
      phase: 'CHECK',
      data: {
        name: check.name,
        index,
        exitCode: check.exitCode,
        expectedExitCode: check.expectedExitCode,
        timedOut: check.timedOut,
        durationMs: check.durationMs,
        finishedAt: endedAt.toISOString(),
      },
      text: checkFinishedText(check),
      at: endedAt,
    });
  }

  // J-T13 / M-T12: the push was refused because the upstream moved, with the control plane's own
  // reading of each commit (`outsideQueue`, and `landedBy` — ids for this account, only the reason
  // for another account's).
  if (input.upstreamMovedCommits) {
    await appendIntegrationJobEvent(tx, {
      jobId: job.id,
      key: 'push-refused',
      kind: 'PUSH_REFUSED',
      claim,
      round,
      phase,
      data: { upstreamMovedCommits: input.upstreamMovedCommits },
      text: pushRefusedText(input.upstreamMovedCommits),
    });
  }

  await appendIntegrationJobEvent(tx, {
    jobId: job.id,
    key: 'result',
    kind: 'RESULT',
    claim,
    round,
    phase,
    data: {
      state: input.effectiveState,
      requestedState: input.requestedState,
      errorCode: input.body.errorCode ?? null,
      sourceFullyApplied:
        typeof input.body.sourceFullyApplied === 'boolean' ? input.body.sourceFullyApplied : null,
      landedSha: input.body.landedSha ?? null,
      targetShaBefore: input.body.targetShaBefore ?? null,
      finishedAt: input.finishedAt.toISOString(),
      ...(input.platformEnd ? { abandoned: true } : {}),
    },
    text: resultText({
      state: input.requestedState,
      effectiveState: input.effectiveState,
      phase,
      targetRef: job.targetRef,
      upstreamRef: job.upstreamRef,
      landedSha: input.body.landedSha ?? null,
      targetShaBefore: input.body.targetShaBefore ?? null,
      sourceFullyApplied: input.body.sourceFullyApplied ?? null,
      errorCode: input.body.errorCode ?? null,
    }),
    at: input.finishedAt,
  });

  // A moved main the promotion answered inside this same transaction: checking again (M-T12) or
  // the next generation under an owner's confirmation (J-T13). It is written AFTER the answer it
  // follows, with this attempt's claim and round, so the section draws in the order the door acted.
  if (input.movedMain) {
    await appendIntegrationJobEvent(tx, {
      jobId: job.id,
      key: input.movedMain.kind === 'RECHECK_ON_MOVED_MAIN' ? 'recheck-on-moved-main' : 'next-generation',
      kind: input.movedMain.kind,
      claim,
      round,
      data: input.movedMain.data,
      text: input.movedMain.text,
      at: input.finishedAt,
    });
  }

  // Who it was handed to, in the transaction that opened the item (LS2): derived lines read the
  // item's own row, but "this attempt handed it to somebody" is the attempt's fact.
  if (input.handedTo) {
    await appendIntegrationJobEvent(tx, {
      jobId: job.id,
      key: `handed:${input.handedTo.itemId}`,
      kind: 'HANDED_TO',
      claim,
      round,
      phase,
      actor: { type: input.handedTo.assignee === 'OWNER' ? 'OWNER' : 'COORDINATOR' },
      data: { itemId: input.handedTo.itemId, assignee: input.handedTo.assignee, itemKind: input.handedTo.itemKind },
      text: handedToText({
        assignee: input.handedTo.assignee,
        itemKind: input.handedTo.itemKind,
        targetRef: job.upstreamRef,
      }),
    });
  }

  // J-T10: the platform ended a job nobody was reporting any more. Which door pressed it is the
  // fact the row cannot tell apart from a runner's own ERROR afterwards, so it is written here with
  // the reason the coordinator gave (the owner's door carries none).
  if (input.platformEnd) {
    const by = input.platformEnd.by === 'owner' ? 'OWNER' : 'COORDINATOR';
    await appendIntegrationJobEvent(tx, {
      jobId: job.id,
      key: 'abandoned',
      kind: 'ABANDONED',
      claim,
      round,
      phase,
      actor: {
        type: by,
        sessionId: input.platformEnd.sessionId ?? null,
        userId: by === 'OWNER' ? job.ownerId : null,
      },
      reason: input.platformEnd.reason ?? null,
      data: {
        by: input.platformEnd.by,
        ...(input.platformEnd.sessionId ? { sessionId: input.platformEnd.sessionId } : {}),
        errorCode: input.body.errorCode ?? null,
      },
      text: abandonedText(by, input.platformEnd.reason ?? null),
      at: input.finishedAt,
    });
  }
}

/**
 * Insert the LANDING session row of the subject a claimed job belongs to (contract §2.9 LS1).
 *
 * Called only after a claim is committed — dispatch, a progress report, a result — which is the
 * rule LS1 states: only a claimed subject opens a conversation, and never a clock. The subject is
 * read off the job row rather than passed in, so a caller cannot name a subject this attempt does
 * not belong to. A subject whose row already exists is a no-op (`ensure` answers `created: false`),
 * and a failure here is logged rather than thrown: the fact that warranted the row is committed
 * either way, and the next compensation point tries again.
 */
async function ensureLandingSessionAfterClaim(prisma: PrismaService, jobId: string): Promise<void> {
  try {
    const job = await prisma.projectIntegrationJob.findUnique({
      where: { id: jobId },
      select: { landingId: true },
    });
    if (!job?.landingId) return;
    await ensureLandingSession(prisma, job.landingId, jobId);
  } catch (error) {
    logger.warn(
      `landing session for job ${jobId} not ensured: ${(error as Error)?.message ?? String(error)}`,
    );
  }
}

/** What the abandon door answers once the job is ended. */
export interface AbandonedIntegrationJob {
  jobId: string;
  kind: string;
  state: 'ERROR';
  /** J12's answer for this kind and claim: the only sentence the record may say about the push. */
  errorCode: 'RUNNER_LOST' | 'PUSH_OUTCOME_UNKNOWN';
  openItemId: string | null;
}

/**
 * J-T10's abandon (contract §2.2, §4.7): end a RUNNING job whose runner has stopped reporting, as
 * `ERROR`, through the SAME result transaction every runner-reported end goes through.
 *
 * WHY IT SHARES THAT TRANSACTION. Everything a result implies has to be written with it or not at
 * all, and an abandoned job implies the same things: its promotion's `BLOCKED` state (an error the
 * candidate's owner has to look at) and the J-T8 deferred DONE an abandoned `LAND_TASK` was
 * holding. Writing them anywhere else would let a reader see a terminal job with a transition
 * still owed, or the reverse.
 *
 * THE FAILURE ITEM, AND THE ONE IT DOES NOT OPEN. An abandoned generation is an `ERROR` like any
 * other, so it opens the project's `INTEGRATION_ERROR` item (§4 X table names J-T10's codes as a
 * source): the work is not on the line, no runner will ever report on it, and that item is how the
 * coordinator reaches `integration_retry`. The exception (J-T8, revision 24) is the generation
 * that was ALREADY ASKED TO STOP (`cancel_requested_at` set): stop and abandon both say that
 * generation is not wanted, and a card asking somebody to fix work deliberately given up would
 * have no door its owner would take. A promotion is blocked either way.
 *
 * WHAT IT DOES NOT DO. It does not queue the next generation (J-T1b): abandonment is "only end,
 * never re-queue", for all three kinds. The one exception is J-T8's deferred DONE — the enqueue a
 * task's second DONE was already owed when this generation was still in flight, which
 * `applyIntegrationJobResult` performs when the marker and the task's DONE are still there.
 *
 * WHICH ERROR CODE. `timedOutErrorCode`, J12's one rule, read off the row inside the transaction:
 * `CHECK_PROMOTION` is always `RUNNER_LOST` (it never pushes); `LAND_TASK` / `LAND_PROMOTION` are
 * `RUNNER_LOST` only when the current claim is v2 and `push_reported_generation IS NULL`; every
 * other claim, legacy included, is `PUSH_OUTCOME_UNKNOWN` and may not claim nothing was pushed.
 */
export async function abandonIntegrationJob(
  prisma: PrismaService,
  input: {
    jobId: string;
    projectId: string;
    /** The tenant the caller acts in: another account's project or job answers as one that is not there. */
    ownerId: string;
    by: 'owner' | 'coordinator';
    /** The coordinator's acting session, checked against the project's current one. */
    sessionId?: string;
    /** The coordinator's explanation, kept on `error_detail`; the owner's door carries none. */
    reason?: string;
  },
  onRetry?: Parameters<typeof withTransactionRetry>[2],
): Promise<{ abandoned: AbandonedIntegrationJob; after: IntegrationResultAftermath | null }> {
  const applied = await applyIntegrationJobResult(prisma, {
    jobId: input.jobId,
    projectId: input.projectId,
    ownerId: input.ownerId,
    // The claim the fence names is decided inside the transaction; these are placeholders the
    // platform-end branch replaces with the row's own claim before anything reads them.
    body: { claimGeneration: '0', leaseOwner: '', state: 'ERROR' },
  }, onRetry, {
    by: input.by,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  });
  // The row is terminal and immutable now (J4), so this read is a fact, not a race.
  const row = await prisma.projectIntegrationJob.findUniqueOrThrow({
    where: { id: input.jobId },
    select: { kind: true, errorCode: true },
  });
  return {
    abandoned: {
      jobId: input.jobId,
      kind: row.kind,
      state: 'ERROR',
      errorCode: (row.errorCode ?? 'RUNNER_LOST') as AbandonedIntegrationJob['errorCode'],
      openItemId: applied.answer.openItemId,
    },
    after: applied.after,
  };
}

/**
 * J-T13's commits as the job row stores them: the runner's list, with the control plane's own
 * reading of each entry added.
 *
 * `outsideQueue` is true when no LANDED LAND_PROMOTION on this serial key names the commit as its
 * `landed_sha` — it arrived on the upstream by some other route (a session's own merge, a hand
 * push, another queue's work that this one did not record). `landedBy` names that landing when one
 * exists: this account gets its job and candidate ids, and another account gets only the fact —
 * never its ids, which are not this account's to read.
 *
 * A malformed list from a runner is stored as much of itself as can be read, or not at all: what a
 * job reports must not be able to fail the result that records it.
 */
async function enrichUpstreamMovedCommits(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; serialKey: string; moved: UpstreamMovedCommits | null },
): Promise<UpstreamMovedCommitsEnriched | null> {
  const moved = input.moved;
  if (!moved || typeof moved !== 'object' || !Array.isArray(moved.commits)) return null;
  const commits = moved.commits
    .filter((commit) => commit != null && typeof commit.sha === 'string' && SHA40.test(commit.sha))
    .slice(0, 20)
    .map((commit) => ({
      sha: commit.sha,
      subject: typeof commit.subject === 'string' ? [...commit.subject].slice(0, 200).join('') : '',
    }));
  const total = Number.isSafeInteger(moved.total) && moved.total >= 0 ? moved.total : commits.length;
  if (commits.length === 0 && total === 0) return null;
  const landings = commits.length === 0 ? [] : await tx.projectIntegrationJob.findMany({
    where: {
      serialKey: input.serialKey,
      kind: 'LAND_PROMOTION',
      state: 'LANDED',
      promotionId: { not: null },
      landedSha: { in: commits.map((commit) => commit.sha) },
    },
    orderBy: { finishedAt: 'asc' },
    select: { id: true, ownerId: true, promotionId: true, landedSha: true },
  });
  const bySha = new Map<string, (typeof landings)[number]>();
  for (const landing of landings) {
    if (landing.landedSha && !bySha.has(landing.landedSha)) bySha.set(landing.landedSha, landing);
  }
  return {
    total,
    commits: commits.map((commit) => {
      const landing = bySha.get(commit.sha);
      return {
        ...commit,
        outsideQueue: landing === undefined,
        ...(landing
          ? {
            landedBy: landing.ownerId === input.ownerId
              ? { jobId: landing.id, promotionId: landing.promotionId! }
              : { reason: 'ANOTHER_ACCOUNT' as const },
          }
          : {}),
      };
    }),
  };
}

/** A full commit sha, as the result route accepts one. */
const SHA40 = /^[0-9a-f]{40}$/;

/**
 * J12's receipt repair: for each earlier landing on this serial key whose push outcome nobody could
 * read and whose tested commit the runner found on the target, write the receipt that landing never
 * got to report — against ITS job, in this job's result transaction.
 *
 * The old ERROR row is not touched (J4): its state is the record of what was known then, and the
 * receipt's detail names it (`integrationJobId`), which is the association. A task's landing writes
 * the J8 receipt; a promotion's writes the M9 receipts for the tasks it carried. Nothing is written
 * when the facts a receipt needs are missing (a purged session, a task whose branch tip was never
 * recorded), and a result that names a job this queue never listed is ignored.
 */
async function recoverUnknownPushReceipts(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; serialKey: string; checks: { jobId?: unknown; landed?: unknown }[] },
): Promise<string[]> {
  const receiptIds: string[] = [];
  for (const check of input.checks) {
    if (check == null || check.landed !== true || typeof check.jobId !== 'string') continue;
    const unknown = await tx.projectIntegrationJob.findFirst({
      where: {
        id: check.jobId,
        ownerId: input.ownerId,
        serialKey: input.serialKey,
        state: 'ERROR',
        errorCode: 'PUSH_OUTCOME_UNKNOWN',
      },
      select: {
        id: true, kind: true, projectId: true, sessionId: true, taskId: true, promotionId: true,
        sourceRef: true, targetRef: true, targetShaBefore: true, testedSha: true,
        testedTreeSha: true, sourceSha: true, mainSyncSha: true, confirmedAutomatically: true,
      },
    });
    if (!unknown || !unknown.testedSha) continue;
    const already = await tx.sessionMergeReceipt.findFirst({
      where: {
        ownerId: input.ownerId,
        detail: { path: ['integrationJobId'], equals: unknown.id },
      },
      select: { id: true },
    });
    if (already) continue;
    if (unknown.kind === 'LAND_TASK') {
      const session = unknown.sessionId
        ? await tx.session.findFirst({ where: { id: unknown.sessionId }, select: { id: true } })
        : null;
      // The receipt's session is a foreign key; a purged one gets none, exactly as the ordinary
      // landing path writes one only for a session that is still there.
      if (!session || !unknown.sourceSha) continue;
      const task = unknown.taskId
        ? await tx.task.findFirst({ where: { id: unknown.taskId }, select: { id: true } })
        : null;
      receiptIds.push(...await MergeReceiptService.fromIntegrationJob(tx, {
        ownerId: input.ownerId,
        sessionId: session.id,
        taskId: task?.id ?? null,
        projectId: unknown.projectId,
        jobId: unknown.id,
        // The push happened: the target holds the tested commit, and that is what landed.
        state: 'LANDED',
        sourceBranch: shortBranchName(unknown.sourceRef),
        targetBranch: shortBranchName(unknown.targetRef),
        sourceSha: unknown.sourceSha,
        targetShaBefore: unknown.targetShaBefore,
        landedSha: unknown.testedSha,
        rebaseBaseSha: unknown.mainSyncSha ?? unknown.targetShaBefore,
        testedTreeSha: unknown.testedTreeSha,
        landedTreeSha: unknown.testedTreeSha,
        mainSyncSha: unknown.mainSyncSha,
        recoveredUnknownPush: true,
      }));
      continue;
    }
    if (unknown.kind === 'LAND_PROMOTION' && unknown.promotionId) {
      receiptIds.push(...await recoverPromotionPushReceipts(tx, {
        promotionId: unknown.promotionId,
        jobId: unknown.id,
        testedSha: unknown.testedSha,
        targetShaBefore: unknown.targetShaBefore,
        testedTreeSha: unknown.testedTreeSha,
        confirmedAutomatically: unknown.confirmedAutomatically,
      }));
    }
  }
  return receiptIds;
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
    ? `This task's own work is on \`${input.branchesWithWork.join('`, `')}\`, and the integration line was handed a different branch; `
      + `that delivery is not on \`${input.targetBranch}\` yet, so no receipt was written either.`
    : 'No session of this task ever reported work, so there really is nothing to land.';
  return `**Integration line: no commits to land (recorded by Orbit)**\n\n`
    + `The integration line was handed this task's branch \`${input.branch}\`, which has no commits since that session's starting point `
    + `(a session that ended after 0 turns, or one that never committed, leaves an empty branch like this). The landing job did not record it as landed, and pushed nothing.\n\n`
    + where;
}

/**
 * What the task is told when the line found every commit of the branch it was handed already on the
 * target (0410). This is the same visible signal, because nothing was pushed here either. The branch
 * DID carry the task's work, so the empty branch's words would be false. This says where the work is:
 * on the target, or, when the receipt was kept back, what kept it back.
 */
function fullyAppliedComment(input: {
  branch: string;
  targetBranch: string;
  branchesWithWork: string[];
  /** The branch the task's work ended on, when that is not the one the line was handed. */
  endedOn: string | null;
}): string {
  const where = input.endedOn !== null
    ? `This task's work last ended on branch \`${input.endedOn}\`, not on the one the integration line was handed; no receipt was written this time.`
    : input.branchesWithWork.length > 0
      ? `This task has other work on \`${input.branchesWithWork.join('`, `')}\`, which the integration line was not handed; `
        + `that part of the delivery is not on \`${input.targetBranch}\` yet, so no receipt was written.`
      : `This task's work is already on \`${input.targetBranch}\`.`;
  return `**Integration line: the branch's commits are already on the target (recorded by Orbit)**\n\n`
    + `The integration line was handed this task's branch \`${input.branch}\`, which carries this task's own commits, `
    + `but \`${input.targetBranch}\` already has every one of these changes (during the rebase each commit was skipped because its patch was already upstream). `
    + `The landing job did not record it as landed, and pushed nothing.\n\n`
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
    /** J-T13's commits, when a LAND_PROMOTION ended because the upstream moved under it. Its own
     *  top-level field, never inside `errorDetail` (which the delivery text quotes verbatim). */
    upstreamMovedCommits: UpstreamMovedCommitsEnriched | null;
    /** Which generation of the landing this was, and — when the coordinator asked for it through
     *  `integration_retry` — what it reran and why (migration 0344). */
    generation: number;
    retry: {
      retryOfJobId: string;
      failureClass: string | null;
      reason: string | null;
      requestedBySessionId: string | null;
      requestedByUserId: string | null;
    } | null;
    /**
     * The merge check this generation did NOT run, when the account owner approved skipping it
     * (§2.4 J-S5, 0393). A failure of such a generation is about the rest of its work, and the item
     * has to say so: without it, a tree that came back red on the TASK_ACCEPTANCE alone would read
     * as the very check the owner had just taken off it.
     */
    skippedCheck: SkippedMergeCheckRecord | null;
  },
): Record<string, unknown> {
  // What every failure says about itself beside its own facts: the class its next step turns on
  // (J-T1b), and, for a rerun, the generation it was and what it was asked to answer — so a second
  // red is read as a second red, not as a first one.
  const classified = {
    failureClass: landingFailureClass({ state, checks: detail.checks }),
    generation: detail.generation,
    ...(detail.retry ? { retry: detail.retry } : {}),
    ...(detail.skippedCheck ? { skippedCheck: detail.skippedCheck } : {}),
  };
  if (state === 'CONFLICT') {
    return {
      jobKind: detail.kind,
      phase: detail.phase,
      targetRef: detail.targetRef,
      targetSha: detail.targetSha,
      files: detail.conflicts.slice(0, 200),
      // Said explicitly because it is the first question a reader has: the branch did not move.
      nothingLanded: true,
      ...classified,
    };
  }
  if (state === 'CHECK_FAILED') {
    const failed = detail.checks.find((check) => check.exitCode !== check.expectedExitCode)
      ?? detail.checks[detail.checks.length - 1];
    return {
      jobKind: detail.kind,
      check: failed ?? null,
      branchUnchanged: true,
      ...classified,
    };
  }
  return {
    jobKind: detail.kind,
    errorCode: detail.errorCode,
    errorDetail: detail.errorDetail,
    ...(detail.upstreamMovedCommits ? { upstreamMovedCommits: detail.upstreamMovedCommits } : {}),
    ...classified,
  };
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
