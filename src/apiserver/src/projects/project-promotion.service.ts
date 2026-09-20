import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import {
  IntegrationCheckResult,
  integrationSerialKey,
  queuePromotionJob,
  shortBranchName,
} from './project-integration-job';
import {
  LIVE_PROMOTION_STATES,
  PROMOTION_COLUMNS,
  PROMOTION_NOT_READY,
  PROMOTION_OWNER_ONLY,
  ProjectPromotionView,
  PromotionRow,
  PromotionState,
  promotionConfirmRefusal,
  promotionDedupeKey,
  promotionItemTitle,
  promotionPrincipalRefusal,
  promotionView,
} from './project-promotion';

/**
 * Merging a project's finished work into its upstream (`docs/project-integration-line-contract.md`
 * §3): making the candidate, offering it to the owner, and doing what they decide.
 *
 * WHAT IS HERE AND WHAT IS NOT
 * ----------------------------
 * Three things, and they are three because each is a different kind of write. `considerCandidate` is
 * the PLATFORM noticing that a branch is ready to be offered — it runs off a committed landing and
 * asks nobody. `confirm` / `decline` / `cancel` are the OWNER's doors, and the only place in this
 * file where authority is checked. `applyJobResult` is the RUNNER's report coming back through the
 * integration queue, so it takes a transaction client rather than opening one: the promotion moving
 * to MERGED and the receipts that say so are one fact and commit together.
 *
 * WHY A SEPARATE CANDIDATE INSTEAD OF LANDING STRAIGHT ONTO MAIN
 * -------------------------------------------------------------
 * Because the owner said so, and because what they are confirming has to be a thing that can be
 * described: these tasks, this tree, these checks. A confirmation of "merge whatever is on the
 * branch now" would be a confirmation of something that could change between the press and the push.
 * So the candidate freezes a source SHA, the checks freeze the upstream they passed against, and
 * M-S3 refuses to land anything that is not what was confirmed — either by reproducing the same tree
 * or, when the upstream has moved, by checking again before it lands (M5).
 */
@Injectable()
export class ProjectPromotionService {
  private readonly logger = new Logger(ProjectPromotionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Offer the project branch's current tip to its owner, if there is anything to offer (M-F1).
   *
   * Called after a landing commits, and after a promotion of its own finishes (M-F4) — both are "the
   * queue just got shorter", which is the only fact that can make a candidate exist. It asks nobody
   * and answers nothing: a project with work still queued, with a promotion already in flight, or
   * whose tip is already covered simply has no candidate yet, and that is the ordinary case.
   *
   * Its own transaction, because it runs after the one that made it possible. Everything it decides
   * on is re-read inside, so two landings finishing together produce one candidate rather than two —
   * and the partial unique index over live rows is what settles it if they race anyway.
   */
  async considerCandidate(projectId: string): Promise<{ promotionId: string } | null> {
    return withTransactionRetry(this.prisma, async (tx) => this.candidateIn(tx, projectId),
      loggedRetry(this.logger, 'projectPromotion.considerCandidate'))
      .catch((error) => {
        // A candidate that could not be made is re-derived by the next landing: the rows it reads
        // are all committed, and nothing about them expires.
        this.logger.warn(`promotion candidate not considered: ${(error as Error)?.message ?? error}`);
        return null;
      });
  }

  private async candidateIn(
    tx: Prisma.TransactionClient,
    projectId: string,
  ): Promise<{ promotionId: string } | null> {
    const codebase = await tx.projectCodebase.findFirst({
      where: { projectId, slot: 'primary' },
      select: {
        id: true, ownerId: true, canonicalRepoUrl: true, integrationRef: true, upstreamRef: true,
      },
    });
    // A MAIN-line project has no branch of its own to promote: its candidate is a task branch, made
    // where the task finishes (M-F2), not here.
    if (!codebase || codebase.integrationRef === codebase.upstreamRef) return null;

    const serialKey = integrationSerialKey({
      kind: 'LAND_TASK',
      canonicalRepoUrl: codebase.canonicalRepoUrl,
      targetRef: codebase.integrationRef,
      projectId,
    });
    const queued = await tx.projectIntegrationJob.count({
      where: { serialKey, kind: 'LAND_TASK', state: { in: ['QUEUED', 'RUNNING'] } },
    });
    // The queue is not empty, so the tip is not what the owner would be confirming.
    if (queued > 0) return null;

    const landed = await tx.projectIntegrationJob.findFirst({
      where: { projectId, kind: 'LAND_TASK', state: 'LANDED', landedSha: { not: null } },
      orderBy: { finishedAt: 'desc' },
      select: { landedSha: true, sessionId: true, taskId: true },
    });
    if (!landed?.landedSha) return null;

    // A promotion already on its way owns the upstream until it ends; M-F4 looks again then.
    const inflight = await tx.projectPromotion.count({
      where: { projectId, state: { in: ['CONFIRMED', 'RECHECKING'] } },
    });
    if (inflight > 0) return null;

    // This tip has already been offered, merged or turned down. Re-offering it would be asking the
    // same question twice.
    const covered = await tx.projectPromotion.findFirst({
      where: {
        projectId,
        sourceSha: landed.landedSha,
        state: { in: [...LIVE_PROMOTION_STATES, 'MERGED', 'DECLINED'] },
      },
      select: { id: true },
    });
    if (covered) return null;

    const includedTaskIds = await this.tasksOnTheLine(tx, {
      projectId,
      ownerId: codebase.ownerId,
      integrationBranch: shortBranchName(codebase.integrationRef),
      upstreamBranch: shortBranchName(codebase.upstreamRef),
    });
    if (includedTaskIds.length === 0) return null;

    // M-T6: one live candidate per source. The older one is retired first, in this transaction, so
    // the index below never has two to choose between.
    await this.supersedeLiveCandidates(tx, projectId, codebase.integrationRef);

    const promotionId = randomUUID();
    const [created] = await tx.projectPromotion.createManyAndReturn({
      data: [{
        id: promotionId,
        projectId,
        ownerId: codebase.ownerId,
        codebaseId: codebase.id,
        sourceKind: 'PROJECT_BRANCH',
        taskId: landed.taskId,
        sessionId: landed.sessionId,
        sourceRef: codebase.integrationRef,
        sourceSha: landed.landedSha,
        upstreamRef: codebase.upstreamRef,
        includedTaskIds,
        state: 'CHECKING' satisfies PromotionState,
      }],
      skipDuplicates: true,
      select: { id: true },
    });
    if (!created) return null;

    const checkJobId = await queuePromotionJob(tx, {
      kind: 'CHECK_PROMOTION',
      promotion: {
        id: promotionId,
        projectId,
        ownerId: codebase.ownerId,
        codebaseId: codebase.id,
        sourceRef: codebase.integrationRef,
        sourceSha: landed.landedSha,
        upstreamRef: codebase.upstreamRef,
        sessionId: landed.sessionId,
      },
      canonicalRepoUrl: codebase.canonicalRepoUrl,
    });
    await tx.projectPromotion.update({
      where: { id: promotionId },
      data: { checkJobId },
    });
    return { promotionId };
  }

  /**
   * The project's tasks whose work is on the integration line and not yet on the upstream — what
   * this merge would carry.
   *
   * Read off the receipts rather than off the jobs, because that is what `project-criterion-landing`
   * reads to answer ON_INTEGRATION_LINE, and a card that named a different set than the landing lane
   * would be describing a different merge than the one that is about to happen.
   */
  private async tasksOnTheLine(
    tx: Prisma.TransactionClient,
    input: { projectId: string; ownerId: string; integrationBranch: string; upstreamBranch: string },
  ): Promise<string[]> {
    const tasks = await tx.task.findMany({
      where: {
        projectId: input.projectId,
        ownerId: input.ownerId,
        mergeReceipts: {
          some: {
            result: { in: ['MERGED', 'ALREADY_MERGED'] },
            targetBranch: input.integrationBranch,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        mergeReceipts: {
          where: { result: { in: ['MERGED', 'ALREADY_MERGED'] }, targetBranch: input.upstreamBranch },
          take: 1,
          select: { id: true },
        },
      },
    });
    return tasks.filter((task) => task.mergeReceipts.length === 0).map((task) => task.id);
  }

  /** M-T6: retire the candidate that was standing, its check job and its card. */
  private async supersedeLiveCandidates(
    tx: Prisma.TransactionClient,
    projectId: string,
    sourceRef: string,
  ): Promise<void> {
    const live = await tx.projectPromotion.findMany({
      where: { projectId, sourceRef, state: { in: [...LIVE_PROMOTION_STATES] } },
      select: { id: true, checkJobId: true, openItemId: true },
    });
    for (const row of live) {
      await tx.projectPromotion.update({
        where: { id: row.id },
        data: { state: 'SUPERSEDED' satisfies PromotionState, decidedAt: new Date() },
      });
      if (row.checkJobId) {
        await tx.projectIntegrationJob.updateMany({
          where: { id: row.checkJobId, state: { in: ['QUEUED', 'RUNNING'] } },
          data: { state: 'CANCELLED', finishedAt: new Date() },
        });
      }
      if (row.openItemId) {
        await tx.projectOpenItem.updateMany({
          where: { id: row.openItemId, state: 'OPEN' },
          data: {
            state: 'SUPERSEDED',
            resolution: 'PROMOTION_MOVED_ON',
            resolvedBy: 'PLATFORM',
            resolvedAt: new Date(),
          },
        });
      }
    }
  }

  // ── the owner's doors (M-F3) ──────────────────────────────────────────────────────────────────

  /**
   * The owner confirming this merge (M-T4).
   *
   * A compare-and-set on `state = 'READY'`, so two presses queue one landing: the second finds the
   * row already CONFIRMED and is answered 409 rather than adding a second `LAND_PROMOTION`. The
   * source SHA travels with the request when the caller knows it — a card rendered before a new
   * candidate superseded this one is confirming something that is no longer on offer, and that is a
   * refusal rather than a merge of whatever is on the branch now.
   */
  async confirm(
    principal: { userId: string; actingSessionId?: string | null },
    projectId: string,
    promotionId: string,
    expectedSourceSha?: string | null,
  ): Promise<ProjectPromotionView> {
    return this.decide(principal, projectId, promotionId,
      (tx, row) => applyConfirm(tx, row, principal.userId, expectedSourceSha ?? null));
  }

  /** The owner's "Not now" (M-T5, appendix A-Q6): the candidate ends and the branch is left alone. */
  async decline(
    principal: { userId: string; actingSessionId?: string | null },
    projectId: string,
    promotionId: string,
  ): Promise<ProjectPromotionView> {
    return this.decide(principal, projectId, promotionId,
      (tx, row) => applyDecline(tx, row, principal.userId));
  }

  /**
   * The owner stopping a confirmed merge before it is pushed (M-T10).
   *
   * The job is asked to stop rather than told it has: it may be mid-check on another machine, and
   * the one thing this must not do is claim a landing did not happen while a push is in flight. The
   * runner reads `cancelRequested` at each phase boundary, and a job already past PUSH reports its
   * landing regardless — which is why the promotion is only moved when its job has not finished.
   */
  async cancel(
    principal: { userId: string; actingSessionId?: string | null },
    projectId: string,
    promotionId: string,
  ): Promise<ProjectPromotionView> {
    return this.decide(principal, projectId, promotionId, applyCancel);
  }

  /**
   * The shape every owner door has: refuse anyone who is not the account owner before a row is read,
   * then do the decision under a retry, then answer with the row as it now stands.
   */
  private async decide(
    principal: { userId: string; actingSessionId?: string | null },
    projectId: string,
    promotionId: string,
    act: (tx: Prisma.TransactionClient, row: NonNullable<Awaited<ReturnType<typeof readPromotion>>>) => Promise<void>,
  ): Promise<ProjectPromotionView> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId },
      select: { ownerId: true },
    });
    if (!project) throw new NotFoundException('project not found');
    const refusal = promotionPrincipalRefusal(project.ownerId, principal);
    if (refusal) throw new ForbiddenException({ code: PROMOTION_OWNER_ONLY, message: refusal });

    await withTransactionRetry(this.prisma, async (tx) => {
      const row = await readPromotion(tx, projectId, promotionId);
      if (!row) throw new NotFoundException('promotion not found');
      await act(tx, row);
    }, loggedRetry(this.logger, 'projectPromotion.decide'));

    const after = await readPromotion(this.prisma, projectId, promotionId);
    if (!after) throw new NotFoundException('promotion not found');
    return promotionView(after);
  }

  /** The candidate this project's card is drawn from, or null when there is nothing on offer (§3.6). */
  async readCurrent(userId: string, projectId: string): Promise<ProjectPromotionView | null> {
    const row = await this.prisma.projectPromotion.findFirst({
      where: { projectId, ownerId: userId },
      orderBy: { createdAt: 'desc' },
      select: PROMOTION_COLUMNS,
    });
    return row ? promotionView(row) : null;
  }
}

/**
 * M-T4: the owner confirming this merge.
 *
 * A compare-and-set on `state = 'READY'`, so two presses queue one landing: the second finds the row
 * already CONFIRMED and is answered 409 rather than adding a second `LAND_PROMOTION`. The source SHA
 * travels with the request when the caller knows it — a card rendered before a new candidate
 * superseded this one is confirming something that is no longer on offer, and that is a refusal
 * rather than a merge of whatever is on the branch now.
 */
async function applyConfirm(
  tx: Prisma.TransactionClient,
  row: PromotionRow,
  userId: string,
  expectedSourceSha: string | null,
): Promise<void> {
  if (expectedSourceSha && expectedSourceSha !== row.sourceSha) {
    throw new ConflictException({
      code: PROMOTION_NOT_READY,
      message: 'this card was drawn from an older candidate; the branch has moved since',
    });
  }
  const refusal = promotionConfirmRefusal(row.state);
  if (refusal) throw new ConflictException({ code: PROMOTION_NOT_READY, message: refusal });

  const moved = await tx.projectPromotion.updateMany({
    where: { id: row.id, state: 'READY' },
    data: {
      state: 'CONFIRMED' satisfies PromotionState,
      confirmedByUserId: userId,
      confirmedAt: new Date(),
    },
  });
  if (moved.count === 0) {
    throw new ConflictException({
      code: PROMOTION_NOT_READY,
      message: 'this promotion moved on while the confirmation was being recorded',
    });
  }
  const codebase = await tx.projectCodebase.findUnique({
    where: { id: row.codebaseId },
    select: { canonicalRepoUrl: true },
  });
  if (!codebase) throw new NotFoundException('the project names no repository');
  const landJobId = await queuePromotionJob(tx, {
    kind: 'LAND_PROMOTION',
    promotion: row,
    canonicalRepoUrl: codebase.canonicalRepoUrl,
  });
  await tx.projectPromotion.update({ where: { id: row.id }, data: { landJobId } });
  await resolveApprovalItem(tx, row.openItemId, 'APPROVED', userId);
}

/** M-T5: "Not now". The candidate ends and the branch is left exactly where it is. */
async function applyDecline(
  tx: Prisma.TransactionClient,
  row: PromotionRow,
  userId: string,
): Promise<void> {
  if (row.state !== 'READY' && row.state !== 'BLOCKED') {
    throw new ConflictException({
      code: PROMOTION_NOT_READY,
      message: `a promotion that is ${row.state.toLowerCase()} cannot be declined`,
    });
  }
  const moved = await tx.projectPromotion.updateMany({
    where: { id: row.id, state: row.state },
    data: { state: 'DECLINED' satisfies PromotionState, decidedAt: new Date() },
  });
  if (moved.count === 0) {
    throw new ConflictException({ code: PROMOTION_NOT_READY, message: 'this promotion moved on' });
  }
  await resolveApprovalItem(tx, row.openItemId, 'DECLINED', userId);
}

/**
 * M-T10: calling back a confirmed merge before it is pushed.
 *
 * The job is ASKED to stop rather than told it has: it may be mid-check on another machine, and the
 * one thing this must not do is record that a landing did not happen while a push is in flight. The
 * runner reads `cancelRequested` at each phase boundary, and a job already at PUSH reports its
 * landing regardless — which is why a job that has got that far refuses the cancellation instead.
 */
async function applyCancel(tx: Prisma.TransactionClient, row: PromotionRow): Promise<void> {
  if (row.state !== 'CONFIRMED' && row.state !== 'RECHECKING') {
    throw new ConflictException({
      code: PROMOTION_NOT_READY,
      message: `a promotion that is ${row.state.toLowerCase()} is not being merged`,
    });
  }
  if (row.landJobId) {
    const asked = await tx.projectIntegrationJob.updateMany({
      where: { id: row.landJobId, state: { in: ['QUEUED', 'RUNNING'] }, phase: { not: 'PUSH' } },
      data: { cancelRequestedAt: new Date() },
    });
    if (asked.count === 0) {
      throw new ConflictException({
        code: PROMOTION_NOT_READY,
        message: 'this merge is already being pushed and cannot be called back',
      });
    }
  }
  await tx.projectPromotion.updateMany({
    where: { id: row.id, state: row.state },
    data: { state: 'CANCELLED' satisfies PromotionState, decidedAt: new Date() },
  });
}

/** One promotion of one project, by both ids, so a promotion of another project is not found. */
async function readPromotion(
  db: Pick<Prisma.TransactionClient, 'projectPromotion'>,
  projectId: string,
  promotionId: string,
) {
  return db.projectPromotion.findFirst({
    where: { id: promotionId, projectId },
    select: PROMOTION_COLUMNS,
  });
}

/** M-T4 / M-T5: the owner's card is answered by the decision, in the same transaction. */
async function resolveApprovalItem(
  tx: Prisma.TransactionClient,
  itemId: string | null,
  resolution: 'APPROVED' | 'DECLINED',
  userId: string,
): Promise<void> {
  if (!itemId) return;
  await tx.projectOpenItem.updateMany({
    where: { id: itemId, state: 'OPEN' },
    data: {
      state: 'RESOLVED',
      resolution,
      resolvedBy: 'USER',
      resolvedByUserId: userId,
      resolvedAt: new Date(),
    },
  });
}

/** What one finished promotion job did to the promotion it belongs to. */
export interface PromotionJobOutcome {
  promotionId: string;
  state: PromotionState;
  /** The receipts M9 wrote, so the job row can keep them beside its own. */
  receiptIds: string[];
  /** Whether the owner's approval card should be opened for this promotion. */
  openApproval: { title: string; taskIds: string[] } | null;
}

/**
 * Apply one finished promotion job to its promotion, inside the job-result transaction
 * (M-T2, M-T3, M-T8, M-T9).
 *
 * In the same transaction on purpose: a MERGED promotion and the receipts that say its tasks are on
 * the upstream are one fact. A reader that saw one without the other would see a project whose
 * criteria read ON_INTEGRATION_LINE while its promotion says it merged, which is the one
 * inconsistency the whole of §3 exists to make impossible.
 */
export async function applyPromotionJobResult(
  tx: Prisma.TransactionClient,
  input: {
    promotionId: string;
    jobId: string;
    jobKind: string;
    state: string;
    upstreamSha: string | null;
    /** The commit this job worked from. For a `TASK_BRANCH` candidate it is the one the runner
     *  resolved off the source ref, and this is the first place the platform ever knows it (0293). */
    sourceSha: string | null;
    testedSha: string | null;
    testedTreeSha: string | null;
    landedSha: string | null;
    targetShaBefore: string | null;
    aheadOfUpstream: number | null;
    filesChanged: number | null;
    checks: IntegrationCheckResult[];
    conflicts: string[];
  },
): Promise<PromotionJobOutcome | null> {
  const promotion = await tx.projectPromotion.findUnique({
    where: { id: input.promotionId },
    select: PROMOTION_COLUMNS,
  });
  if (!promotion) return null;
  // A candidate that was superseded, declined or cancelled while its job ran keeps the answer it
  // already has: the job's report is about work nobody is waiting for any more.
  if (!LIVE_PROMOTION_STATES.includes(promotion.state as PromotionState)) return null;

  const now = new Date();
  const checks = input.checks as unknown as Prisma.InputJsonValue;

  if (input.jobKind === 'CHECK_PROMOTION') {
    if (input.state === 'READY') {
      await tx.projectPromotion.update({
        where: { id: promotion.id },
        data: {
          state: 'READY' satisfies PromotionState,
          // The commit the owner is being asked about, for the candidates whose source the platform
          // could not resolve for itself (0293). An echo for every other job: the runner works from
          // the sha it was handed and reports the same one back.
          ...(input.sourceSha ? { sourceSha: input.sourceSha } : {}),
          upstreamShaChecked: input.upstreamSha,
          mergeTreeSha: input.testedTreeSha,
          commitsAhead: input.aheadOfUpstream,
          filesChanged: input.filesChanged,
          checks,
          conflicts: [],
        },
      });
      return {
        promotionId: promotion.id,
        state: 'READY',
        receiptIds: [],
        openApproval: {
          title: promotionItemTitle(promotion.upstreamRef, promotion.includedTaskIds.length),
          taskIds: promotion.includedTaskIds,
        },
      };
    }
    return blockPromotion(tx, promotion.id, checks, input.conflicts, now, input.sourceSha);
  }

  // LAND_PROMOTION.
  if (input.state === 'LANDED' || input.state === 'ALREADY_LANDED') {
    const mergedSha = input.state === 'LANDED' ? input.landedSha : (input.targetShaBefore ?? input.upstreamSha);
    if (!mergedSha) return null;
    const receiptIds = await writeUpstreamReceipts(tx, {
      promotion,
      jobId: input.jobId,
      state: input.state,
      mergedSha,
      targetShaBefore: input.targetShaBefore,
      testedSha: input.testedSha,
      testedTreeSha: input.testedTreeSha,
    });
    await tx.projectPromotion.update({
      where: { id: promotion.id },
      data: {
        state: 'MERGED' satisfies PromotionState,
        mergedSha,
        mergedAt: now,
        decidedAt: now,
        upstreamShaChecked: input.upstreamSha ?? promotion.upstreamShaChecked,
        mergeTreeSha: input.testedTreeSha ?? promotion.mergeTreeSha,
        // An unmoved upstream reproduces the tree that already passed and runs nothing again (M5),
        // so an empty report leaves the checks the owner confirmed standing rather than erasing them.
        ...(input.checks.length > 0 ? { checks } : {}),
        receiptIds,
      },
    });
    return { promotionId: promotion.id, state: 'MERGED', receiptIds, openApproval: null };
  }
  return blockPromotion(tx, promotion.id, checks, input.conflicts, now, input.sourceSha);
}

/** M-T3 / M-T9: the candidate stops and somebody has to look at it. */
async function blockPromotion(
  tx: Prisma.TransactionClient,
  promotionId: string,
  checks: Prisma.InputJsonValue,
  conflicts: string[],
  now: Date,
  sourceSha: string | null,
): Promise<PromotionJobOutcome> {
  await tx.projectPromotion.update({
    where: { id: promotionId },
    data: {
      state: 'BLOCKED' satisfies PromotionState,
      // The candidate a check refused still names the commit it refused, for the same reason the
      // one it accepted does: the coordinator has to be able to go and look at it.
      ...(sourceSha ? { sourceSha } : {}),
      checks,
      conflicts: conflicts.slice(0, 200),
      decidedAt: now,
    },
  });
  return { promotionId, state: 'BLOCKED', receiptIds: [], openApproval: null };
}

/**
 * M9: one receipt per task this merge carried, against the producing session of each.
 *
 * Per task rather than one for the promotion, because a receipt is what
 * `project-criterion-landing.ts` reads to answer "is this task's work on the upstream", and that is
 * a question about a task. The source SHA is where that task's work reached the branch this receipt
 * is about, so the receipt points at a commit a reader can go and look at rather than at the merge
 * commit that carried twelve of them.
 *
 * WHERE THAT COMMIT COMES FROM IS THE ONE THING THE TWO KINDS DISAGREE ON. A `PROJECT_BRANCH`
 * candidate carries tasks that each landed on the project branch earlier, so each receipt names its
 * own landing job's `landed_sha` — the commit a reader finds on the branch. A `TASK_BRANCH`
 * candidate IS one task's branch on a MAIN-line project, which has no integration line under it:
 * there is no earlier landing to point at, and the commit that arrived on the upstream is the one
 * the landing job tested (M9). Both are the same session's own work, which is why one helper writes
 * both.
 */
async function writeUpstreamReceipts(
  tx: Prisma.TransactionClient,
  input: {
    promotion: { id: string; ownerId: string; projectId: string; sourceKind: string; taskId: string | null; sessionId: string | null; includedTaskIds: string[]; sourceRef: string; upstreamRef: string; sourceSha: string | null };
    jobId: string;
    state: 'LANDED' | 'ALREADY_LANDED';
    mergedSha: string;
    targetShaBefore: string | null;
    /** What the landing job put on the upstream, and the commit it ran its checks on. */
    testedSha: string | null;
    testedTreeSha: string | null;
  },
): Promise<string[]> {
  const onItsOwnBranch = input.promotion.sourceKind === 'TASK_BRANCH';
  const landings = onItsOwnBranch ? [] : await tx.projectIntegrationJob.findMany({
    where: {
      projectId: input.promotion.projectId,
      kind: 'LAND_TASK',
      state: 'LANDED',
      taskId: { in: input.promotion.includedTaskIds },
    },
    orderBy: { finishedAt: 'asc' },
    select: { taskId: true, sessionId: true, landedSha: true },
  });
  const byTask = new Map(landings.map((row) => [row.taskId, row]));
  const receiptIds: string[] = [];
  for (const taskId of input.promotion.includedTaskIds) {
    const landing = byTask.get(taskId);
    const sessionId = landing?.sessionId ?? (onItsOwnBranch ? input.promotion.sessionId : null);
    // The job's tested commit, or — when there is none because the landing answered ALREADY_LANDED
    // — the candidate's own source, which is the commit that turned out to be on the upstream
    // already. Without the second half that answer would leave the task with no receipt and the
    // criterion reading unlanded while its work sits on main.
    const sourceSha = landing?.landedSha
      ?? (onItsOwnBranch ? input.testedSha ?? input.promotion.sourceSha : null);
    if (!sessionId || !sourceSha) continue;
    const written = await MergeReceiptService.fromIntegrationJob(tx, {
      ownerId: input.promotion.ownerId,
      sessionId,
      taskId,
      projectId: input.promotion.projectId,
      jobId: input.jobId,
      state: input.state,
      sourceBranch: shortBranchName(input.promotion.sourceRef),
      targetBranch: shortBranchName(input.promotion.upstreamRef),
      sourceSha,
      targetShaBefore: input.targetShaBefore,
      landedSha: input.mergedSha,
      rebaseBaseSha: input.targetShaBefore,
      testedTreeSha: input.testedTreeSha,
      landedTreeSha: input.testedTreeSha,
      mainSyncSha: null,
    });
    receiptIds.push(...written);
  }
  return receiptIds;
}

/**
 * M-T7: the landing job found the upstream had moved, so the merge and the checks are being redone
 * on the new tip.
 *
 * `recheckedAt` as well as the state, because the state is passed through in the seconds the checks
 * take and a reader asking "was this rechecked" — the acceptance script included — is asking about
 * something that already happened rather than something happening now.
 */
export async function markPromotionRechecking(
  prisma: Pick<PrismaService, 'projectPromotion'>,
  promotionId: string,
): Promise<void> {
  await prisma.projectPromotion.updateMany({
    where: { id: promotionId, state: 'CONFIRMED' },
    data: { state: 'RECHECKING' satisfies PromotionState, recheckedAt: new Date() },
  });
}
