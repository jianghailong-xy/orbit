import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { PromotionTask } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import {
  IntegrationCheckResult,
  LandingWorkSessionFacts,
  PROMOTION_AUTOMATIC_LAND,
  integrationSerialKey,
  queuePromotionJob,
  queueTaskBranchCandidate,
  shortBranchName,
  workBranchEndedOn,
} from './project-integration-job';
import {
  LIVE_PROMOTION_STATES,
  PROMOTION_COLUMNS,
  PROMOTION_NOT_READY,
  PROMOTION_OWNER_ONLY,
  ProjectPromotionView,
  PromotionRow,
  PromotionState,
  automaticConfirmationRefusal,
  medianMs,
  promotionConfirmRefusal,
  promotionDedupeKey,
  promotionItemTitle,
  promotionPrincipalRefusal,
  promotionView,
} from './project-promotion';

/** How many finished checks the "typical" a re-check is measured against is taken from (§3.6). */
const CHECK_TYPICAL_SAMPLE = 5;

/** How many merges back a conversation is offered records for (§3.6's `merged`), newest first. */
const MERGED_RECORD_LIMIT = 20;

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
 *
 * THE ONE CONFIRMATION THAT IS NOT A PRESS
 * ----------------------------------------
 * A project that integrates on a branch of its own and has its Automatic setting on does not get the
 * card when its check comes back clean: `applyPromotionJobResult` confirms it in the same
 * transaction, marked `confirmedAutomatically` with no user named, and queues the landing (M-T11).
 * That landing is bound tighter than an owner's — to the tree that passed, on the main tip it passed
 * against — and a runner that finds main has moved hands it back untouched, at which point the card
 * the owner did not see is opened after all (M-T12). The owner's doors below are unchanged, and
 * `cancel` answers an automatic merge exactly as it answers a pressed one until it is pushed.
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
    await supersedeLiveCandidates(tx, projectId, codebase.integrationRef);

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
    return this.view(after);
  }

  /** The candidate this project's card is drawn from, or null when there is nothing on offer (§3.6). */
  async readCurrent(userId: string, projectId: string): Promise<ProjectPromotionView | null> {
    const row = await this.prisma.projectPromotion.findFirst({
      where: { projectId, ownerId: userId },
      orderBy: { createdAt: 'desc' },
      select: PROMOTION_COLUMNS,
    });
    return row ? this.view(row) : null;
  }

  /**
   * The merges this project has already made, newest first (§3.6) — the record each one leaves in
   * the conversation, drawn at the moment it happened.
   *
   * A READ OF ITS OWN RATHER THAN A WIDENING OF `current`, which is what a merge used to be read
   * from. That row is whichever candidate the branch is offering NOW: it moves on the moment the
   * next one exists, so a receipt drawn from it described a different merge every time the branch
   * was offered again — and until it moved, the same card sat at the bottom of the conversation
   * for the life of the project, under every later message. A row that reached MERGED is a record
   * of a moment: terminal, immutable (`project_promotion_terminal_guard`), and carrying its own
   * `merged_sha` and `merged_at`, so it can be read back years later as the merge it was.
   *
   * Bounded rather than paginated, because a record is drawn where it happened and a moment older
   * than the window a conversation has loaded is drawn nowhere (`decisionReceiptAnchor` returns
   * null for it, and the native clients' `ReceiptAnchor` with it). Terminal rows never move, so
   * twenty is the recent history of any conversation somebody is still reading.
   */
  async readMerged(userId: string, projectId: string): Promise<ProjectPromotionView[]> {
    const rows = await this.prisma.projectPromotion.findMany({
      where: {
        projectId,
        ownerId: userId,
        state: 'MERGED',
        // A MERGED row the terminal edge wrote both of these on. Nothing else reads this door, and
        // a receipt without a moment to be drawn at has nothing to anchor it.
        mergedSha: { not: null },
        mergedAt: { not: null },
      },
      orderBy: { mergedAt: 'desc' },
      take: MERGED_RECORD_LIMIT,
      select: PROMOTION_COLUMNS,
    });
    if (rows.length === 0) return [];
    // One read for every title the whole history names, and one for when the branch last took the
    // upstream in — rather than two per row: the same question asked of twenty rows is one query.
    const [titles, upstreamSyncedAt] = await Promise.all([
      this.titlesIn(rows.flatMap((row) => row.includedTaskIds), userId),
      this.lastUpstreamSync(projectId),
    ]);
    return rows.map((row) => promotionView(row, {
      tasks: tasksOfTitles(row.includedTaskIds, titles),
      upstreamSyncedAt,
      // A merged row is not re-checking anything: the re-check is a state a landing is IN, and this
      // one has come out the other side.
      recheck: null,
    }));
  }

  /**
   * The row as the card reads it (§3.6), with the three facts that are questions about other tables
   * answered here rather than in the row itself.
   *
   * One builder for both doors — the card being read, and the answer to a press on it — because the
   * answer IS what the client redraws from: two builders would be two chances to describe the same
   * merge differently, and the card the owner pressed has to be the card they get back.
   */
  private async view(row: PromotionRow): Promise<ProjectPromotionView> {
    const [tasks, upstreamSyncedAt] = await Promise.all([
      this.tasksOf(row),
      this.lastUpstreamSync(row.projectId),
    ]);
    // Only a re-check in flight is measured, which keeps the poll of a card nobody is acting on to
    // the two reads above.
    const recheck = row.state === 'RECHECKING' && row.recheckedAt
      ? {
        upstreamMovedBy: row.upstreamMovedBy,
        startedAt: row.recheckedAt,
        typicalMs: medianMs(await this.recentCheckDurations(row.projectId)),
      }
      : null;
    return promotionView(row, { tasks, upstreamSyncedAt, recheck });
  }

  /** What this merge would carry, in the order the row lists it, with the titles the card shows. */
  private async tasksOf(row: PromotionRow): Promise<PromotionTask[]> {
    if (row.includedTaskIds.length === 0) return [];
    return tasksOfTitles(row.includedTaskIds, await this.titlesIn(row.includedTaskIds, row.ownerId));
  }

  /** Task titles by id, for the ids the rows being read name — one query however many rows. */
  private async titlesIn(taskIds: readonly string[], ownerId: string): Promise<Map<string, string>> {
    if (taskIds.length === 0) return new Map();
    const rows = await this.prisma.task.findMany({
      where: { id: { in: [...new Set(taskIds)] }, ownerId },
      select: { id: true, title: true },
    });
    return new Map(rows.map((task) => [task.id, task.title]));
  }

  /**
   * When this project's branch last took the upstream in (§3.1 M1), or null when it never has.
   *
   * The row `project-integration-line.ts` reads for the project page's `synced with main <age>`: a
   * LANDING that had to absorb the upstream, which is the only thing that moves that clock. Read
   * here too because the two surfaces make the same claim about the same branch, and a second
   * derivation is how they come to disagree.
   */
  private async lastUpstreamSync(projectId: string): Promise<Date | null> {
    const synced = await this.prisma.projectIntegrationJob.findFirst({
      where: { projectId, state: 'LANDED', mainSyncSha: { not: null } },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });
    return synced?.finishedAt ?? null;
  }

  /**
   * How long this project's last few promotion checks took, newest first (§3.6's `typicalMs`).
   *
   * The whole CHECK_PROMOTION run and not only the commands it ran, because the run is what the
   * reader is waiting for — it fetches, merges and then checks, and the checks alone would report
   * less than the wait. Five of them: a project whose checks changed shape a month ago is described
   * better by what it has been doing lately than by everything it has ever done.
   */
  private async recentCheckDurations(projectId: string): Promise<number[]> {
    const runs = await this.prisma.projectIntegrationJob.findMany({
      where: {
        projectId,
        kind: 'CHECK_PROMOTION',
        startedAt: { not: null },
        finishedAt: { not: null },
      },
      orderBy: { finishedAt: 'desc' },
      take: CHECK_TYPICAL_SAMPLE,
      select: { startedAt: true, finishedAt: true },
    });
    return runs.flatMap((run) =>
      run.startedAt && run.finishedAt ? [run.finishedAt.getTime() - run.startedAt.getTime()] : []);
  }
}

/**
 * A row's task ids as the card lists them, from titles looked up once for every row being read.
 *
 * One derivation for the live candidate and for a merge already made, because they are one question
 * — which of the tasks this row names can still be given a name — and two of them is how the same
 * merge comes to be described two ways. A task the row names and the table no longer holds is left
 * out rather than titled with its own id: an id is not a name.
 */
function tasksOfTitles(
  taskIds: readonly string[],
  titles: ReadonlyMap<string, string>,
): PromotionTask[] {
  return taskIds.flatMap((taskId) => {
    const title = titles.get(taskId);
    return title === undefined ? [] : [{ taskId, title }];
  });
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
  /**
   * Whether the owner's approval card should be opened for this promotion, and the facts it is
   * about — read off the promotion rather than off the job that just finished, because a landing
   * handed back after main moved (M-T12) reports the tip it found, not the one the check passed on.
   */
  openApproval: {
    title: string;
    taskIds: string[];
    upstreamShaChecked: string | null;
    checks: IntegrationCheckResult[];
  } | null;
}

/** The exception kinds that are an integration line's own problems (§4.2): while one of this
 *  project's is open, nothing it would carry into main is clean enough to go there by itself. */
const INTEGRATION_ITEM_KINDS = ['INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR'];

/**
 * M-T11: why this candidate goes to the owner as a card — or null when the project's Automatic
 * setting confirms it instead. The rule itself is `automaticConfirmationRefusal`; this is the part
 * that reads what it weighs about the project, inside the caller's transaction, so the answer is
 * about this moment and no earlier one. Asked twice: when the check comes back READY, and again when
 * the landing that answer queued is about to be handed to a runner (`automaticLandingRefusal`).
 */
async function automaticConfirmationRefusalIn(
  tx: Prisma.TransactionClient,
  promotion: PromotionRow,
  report: {
    /** Whether the runner that will do the landing lands only onto the checked tip (M-T12). */
    runnerHandsBackMovedUpstream: boolean;
    conflicts: string[];
    checks: IntegrationCheckResult[];
    upstreamSha: string | null;
    testedTreeSha: string | null;
  },
): Promise<string | null> {
  const project = await tx.project.findUnique({
    where: { id: promotion.projectId },
    select: { coordinatorEnabled: true },
  });
  const codebase = await tx.projectCodebase.findUnique({
    where: { id: promotion.codebaseId },
    select: { integrationRef: true, upstreamRef: true },
  });
  const openIntegrationItems = await tx.projectOpenItem.count({
    where: { projectId: promotion.projectId, state: 'OPEN', kind: { in: INTEGRATION_ITEM_KINDS } },
  });
  // The line as the binding says now, and only if it is still the line this candidate was made on:
  // its source is the project's branch and its upstream is the project's upstream.
  const line = !codebase
    ? null
    : codebase.integrationRef === codebase.upstreamRef
      ? 'MAIN' as const
      : codebase.integrationRef === promotion.sourceRef && codebase.upstreamRef === promotion.upstreamRef
        ? 'PROJECT_BRANCH' as const
        : null;
  return automaticConfirmationRefusal({
    sourceKind: promotion.sourceKind,
    line,
    coordinatorEnabled: project?.coordinatorEnabled === true,
    conflicts: report.conflicts,
    checks: report.checks,
    upstreamShaChecked: report.upstreamSha,
    mergeTreeSha: report.testedTreeSha,
    openIntegrationItems,
    runnerHandsBackMovedUpstream: report.runnerHandsBackMovedUpstream,
  });
}

/**
 * Whether the runner that just ran a check has declared that it lands an automatic merge only onto
 * the checked tip (`PROMOTION_AUTOMATIC_LAND`). It is the one asked about because the landing is
 * claimed through the same session's workspace, so it is the machine that will be told to do it.
 */
async function runnerHandsBackMovedUpstream(
  tx: Prisma.TransactionClient,
  runnerId: string | null,
): Promise<boolean> {
  if (!runnerId) return false;
  const runner = await tx.runner.findUnique({ where: { id: runnerId }, select: { capabilities: true } });
  return runner?.capabilities.includes(PROMOTION_AUTOMATIC_LAND) === true;
}

/**
 * M-T11 read once more, at the last moment the platform decides anything about a landing the
 * Automatic setting confirmed: the heartbeat that is about to hand it to a runner. Null when it may
 * go out; otherwise why it goes back to the owner as a card instead (M-T12).
 *
 * The authorization is the owner's to take back, and a queue stands between the check and the push.
 * A project whose Automatic was switched off in between — or whose line was moved to main, or which
 * has had an integration exception opened since — no longer has the yes this landing was queued
 * under, and it is not pushed on the strength of one that was withdrawn. The rule is the same one
 * (`automaticConfirmationRefusal`), over the facts the check left on the promotion and the project as
 * it stands now: the check is not judged a second time, only what the owner and the line can change.
 * main moving since the check is still the runner's to see, at the push.
 */
export async function automaticLandingRefusal(
  tx: Prisma.TransactionClient,
  promotionId: string,
  runnerLandsAutomatically: boolean,
): Promise<string | null> {
  const promotion = await tx.projectPromotion.findUnique({
    where: { id: promotionId },
    select: PROMOTION_COLUMNS,
  });
  // Only a landing the setting confirmed, and that has not been made or ended, is the setting's to
  // take back. Anything else is answered where its result is applied, as it always was.
  if (!promotion || promotion.state !== 'CONFIRMED' || !promotion.confirmedAutomatically) return null;
  return automaticConfirmationRefusalIn(tx, promotion, {
    runnerHandsBackMovedUpstream: runnerLandsAutomatically,
    conflicts: promotion.conflicts,
    checks: storedChecks(promotion),
    upstreamSha: promotion.upstreamShaChecked,
    testedTreeSha: promotion.mergeTreeSha,
  });
}

/** The checks a promotion carries, as the check reported them. */
function storedChecks(promotion: PromotionRow): IntegrationCheckResult[] {
  return Array.isArray(promotion.checks) ? (promotion.checks as unknown as IntegrationCheckResult[]) : [];
}

/**
 * M-T6: retire the candidates standing on one source, their check jobs and their cards.
 *
 * `keepJobIds` names a job whose result is being applied right now: a terminal job row is written
 * once (`project_integration_job_terminal_guard`), so cancelling that one here would make the very
 * update that records what it answered fail — the whole result, and with it the retirement, would
 * roll back. Every other caller leaves it empty and takes the job out of the queue too.
 */
async function supersedeLiveCandidates(
  tx: Prisma.TransactionClient,
  projectId: string,
  sourceRef: string,
  keepJobIds: readonly string[] = [],
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
    if (row.checkJobId && !keepJobIds.includes(row.checkJobId)) {
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

/**
 * The candidate a task's work is owed after the one that was made for it turned out to be about a
 * branch the work did not end on (§3.4 M-F2, J-T1e one level up).
 *
 * WHAT THIS IS FOR
 * ----------------
 * `queueTaskBranchCandidate` freezes the NEWEST work session of the DONE that queued it, and that is
 * the right branch exactly while the task's work has stopped moving. The DONE is written while a
 * session can still be running, and then the branch the candidate names and the branch the work ends
 * on come apart — the 2026-09-23 shape of the landing incident, one level up: this deployment has
 * seen a DONE freeze a one-turn retry that had already FAILED, whose branch was the project branch's
 * tip and carried nothing, while the 151-turn session holding the work ended on another branch. A
 * landing answers that by filing the NEXT generation bound to the branch the work ended on
 * (`queueLandingBehindTheWork`); this is the same move for a candidate, and the state it writes is
 * the same one M-T6 uses when a second landing supersedes the candidate that was standing: the
 * retired row goes on saying what the platform had frozen and which branch it was about, and the
 * candidate the owner is finally asked about is the one that names the branch the work is on.
 *
 * The retired candidate's own check job is NOT cancelled: the result being applied right now is that
 * job's — the caller is inside that transaction — and a terminal row is written once.
 *
 * Answers null when there is nothing to file: the candidate is not a `TASK_BRANCH` one (a project
 * branch is not a branch any work session ends on), it has already ended, no finished session names
 * a branch, the project's binding is gone, or a live candidate for that branch already stands (M-T6's
 * index — one branch is one question, and that standing candidate is the one asking it).
 */
export async function refileCandidateBehindTheWork(
  tx: Prisma.TransactionClient,
  input: {
    promotionId: string;
    taskId: string;
    sessions: ReadonlyArray<LandingWorkSessionFacts>;
  },
): Promise<{ promotionId: string; jobId: string } | null> {
  const promotion = await tx.projectPromotion.findFirst({
    where: { id: input.promotionId },
    select: {
      id: true, projectId: true, ownerId: true, codebaseId: true, sourceKind: true,
      sourceRef: true, state: true, checkJobId: true,
    },
  });
  if (!promotion || promotion.sourceKind !== 'TASK_BRANCH') return null;
  if (!LIVE_PROMOTION_STATES.includes(promotion.state as PromotionState)) return null;
  const ended = workBranchEndedOn(input.sessions);
  if (ended === null) return null;
  const codebase = await tx.projectCodebase.findUnique({
    where: { id: promotion.codebaseId },
    select: { id: true, canonicalRepoUrl: true, integrationRef: true, upstreamRef: true },
  });
  if (!codebase) return null;
  const session = input.sessions.find((row) => row.sessionId === ended.sessionId)!;

  await supersedeLiveCandidates(
    tx, promotion.projectId, promotion.sourceRef,
    promotion.checkJobId ? [promotion.checkJobId] : [],
  );

  return queueTaskBranchCandidate(tx, {
    ownerId: promotion.ownerId,
    projectId: promotion.projectId,
    taskId: input.taskId,
    codebase,
    session: { id: session.sessionId, branch: ended.branch, runnerId: session.runnerId },
  });
}

/**
 * Apply one finished promotion job to its promotion, inside the job-result transaction
 * (M-T2, M-T3, M-T8, M-T9).
 *
 * In the same transaction on purpose: a MERGED promotion and the receipts that say its tasks are on
 * the upstream are one fact. A reader that saw one without the other would see a project whose
 * criteria read ON_INTEGRATION_LINE while its promotion says it merged, which is the one
 * inconsistency the whole of §3 exists to make impossible.
 *
 * THE EDGE THE CARD OPENS ON IS ALSO WHERE THE OWNER'S AUTOMATIC AUTHORIZATION IS READ (M-T11). A
 * check that comes back READY either opens the owner's card, as it always has, or — for a project
 * branch whose project has Automatic on, with the check clean — is confirmed here and its landing
 * queued, with no card and no user named. The same transaction decides it and writes it, so there
 * is no moment at which the candidate sits READY with nobody asked.
 */
export async function applyPromotionJobResult(
  tx: Prisma.TransactionClient,
  input: {
    promotionId: string;
    jobId: string;
    jobKind: string;
    /** The runner that did this job, which is the one a landing queued now will be claimed by. */
    runnerId: string | null;
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
      // M-T11 before M-T2: whether anybody is asked at all.
      const refusal = await automaticConfirmationRefusalIn(tx, promotion, {
        runnerHandsBackMovedUpstream: await runnerHandsBackMovedUpstream(tx, input.runnerId),
        conflicts: input.conflicts,
        checks: input.checks,
        upstreamSha: input.upstreamSha,
        testedTreeSha: input.testedTreeSha,
      });
      const automatic = refusal === null;
      await tx.projectPromotion.update({
        where: { id: promotion.id },
        data: {
          state: (automatic ? 'CONFIRMED' : 'READY') satisfies PromotionState,
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
          // Nobody pressed it, so nobody is named: the setting is what confirmed it.
          ...(automatic ? { confirmedAutomatically: true, confirmedAt: now } : {}),
        },
      });
      if (automatic) {
        const landJobId = await queueAutomaticLanding(tx, {
          ...promotion,
          sourceSha: input.sourceSha ?? promotion.sourceSha,
        });
        await tx.projectPromotion.update({ where: { id: promotion.id }, data: { landJobId } });
        return { promotionId: promotion.id, state: 'CONFIRMED', receiptIds: [], openApproval: null };
      }
      return {
        promotionId: promotion.id,
        state: 'READY',
        receiptIds: [],
        openApproval: {
          title: promotionItemTitle(promotion.upstreamRef, promotion.includedTaskIds.length),
          taskIds: promotion.includedTaskIds,
          upstreamShaChecked: input.upstreamSha,
          checks: input.checks,
        },
      };
    }
    return blockPromotion(tx, promotion.id, checks, input.conflicts, now, input.sourceSha);
  }

  // LAND_PROMOTION.
  if (input.state === 'READY' && promotion.confirmedAutomatically) {
    return handBackToOwner(tx, promotion);
  }
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

/**
 * M-T11: the landing the project's Automatic setting confirmed, queued in the transaction that
 * confirmed it. Marked on the job as well as on the promotion, because the job is what the runner is
 * handed and the mark is what binds it to the checked tip (M-T12).
 */
async function queueAutomaticLanding(tx: Prisma.TransactionClient, promotion: PromotionRow): Promise<string> {
  const codebase = await tx.projectCodebase.findUnique({
    where: { id: promotion.codebaseId },
    select: { canonicalRepoUrl: true },
  });
  if (!codebase) throw new NotFoundException('the project names no repository');
  return queuePromotionJob(tx, {
    kind: 'LAND_PROMOTION',
    promotion,
    canonicalRepoUrl: codebase.canonicalRepoUrl,
    confirmedAutomatically: true,
  });
}

/**
 * M-T12: an automatic landing ended without landing — the runner found main somewhere other than
 * where the check left it, or the heartbeat about to hand it out found the authorization gone
 * (`automaticLandingRefusal`). The Automatic setting authorized a clean landing under a yes that
 * still stands, and this is no longer one, so the candidate goes back to being a question — READY,
 * with the card the owner was spared opened after all, and with the check it already has: the
 * owner's press is what decides whether it is checked again on the new main and merged (M5),
 * exactly as if the card had been theirs from the start.
 *
 * The promotion stops saying it was confirmed automatically, because it is not confirmed at all now;
 * the job it sent out keeps saying so, which is where the attempt is recorded.
 */
async function handBackToOwner(
  tx: Prisma.TransactionClient,
  promotion: PromotionRow,
): Promise<PromotionJobOutcome> {
  await tx.projectPromotion.update({
    where: { id: promotion.id },
    data: {
      state: 'READY' satisfies PromotionState,
      confirmedAutomatically: false,
      confirmedAt: null,
      landJobId: null,
    },
  });
  return {
    promotionId: promotion.id,
    state: 'READY',
    receiptIds: [],
    openApproval: {
      title: promotionItemTitle(promotion.upstreamRef, promotion.includedTaskIds.length),
      taskIds: promotion.includedTaskIds,
      upstreamShaChecked: promotion.upstreamShaChecked,
      checks: storedChecks(promotion),
    },
  };
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
    promotion: { id: string; ownerId: string; projectId: string; sourceKind: string; taskId: string | null; sessionId: string | null; includedTaskIds: string[]; sourceRef: string; upstreamRef: string; sourceSha: string | null; confirmedAutomatically: boolean };
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
      // The ledger's own copy of who merged it: a receipt read years later has to be able to say
      // "nobody pressed this" without the promotion row beside it.
      confirmedAutomatically: input.promotion.confirmedAutomatically,
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
 * something that already happened rather than something happening now. `upstreamMovedBy` is how far
 * the upstream moved, counted by the runner because only the runner has the commits to count; null
 * when it could not, which the card says rather than printing a zero.
 */
export async function markPromotionRechecking(
  prisma: Pick<PrismaService, 'projectPromotion'>,
  promotionId: string,
  upstreamMovedBy: number | null,
): Promise<void> {
  await prisma.projectPromotion.updateMany({
    where: { id: promotionId, state: 'CONFIRMED' },
    data: {
      state: 'RECHECKING' satisfies PromotionState,
      recheckedAt: new Date(),
      upstreamMovedBy,
    },
  });
}
