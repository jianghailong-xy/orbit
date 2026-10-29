import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { IntegrationJobPhase, PromotionTask, UpstreamMovedCommitsEnriched } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { type MergeReceiptResult, resultLanded } from '../sessions/merge-receipt';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import {
  IntegrationCheckResult,
  LandingRetryRequest,
  LandingWorkSessionFacts,
  PROMOTION_AUTOMATIC_LAND,
  integrationSerialKey,
  pushBoundaryPassed,
  queuePromotionJob,
  queueTaskBranchCandidate,
  shortBranchName,
  workBranchEndedOn,
} from './project-integration-job';
import { type InFlightStop, stopInFlightJob } from './project-integration-line';
import { movedMainText } from './project-integration-event';
import { settleLandingAfterPromotionDecision } from './landing-session';
import { openItemOwed, resolveIntegrationItemsOnLanding, resolveLeaseExpiredItems } from './project-open-item';
import { sessionReportedWork } from './landing-source-branch';
import {
  AUTOMATIC_MERGE_ATTEMPTS,
  PROMOTION_LAND_ATTEMPTS,
  AutomaticConfirmationFacts,
  LIVE_PROMOTION_STATES,
  PROMOTION_COLUMNS,
  PROMOTION_NOT_READY,
  PROMOTION_OWNER_ONLY,
  ProjectPromotionView,
  PromotionBlockedReason,
  PromotionRow,
  PromotionSourceKind,
  PromotionState,
  automaticConfirmationRefusal,
  medianMs,
  promotionBlockedReasonFor,
  promotionConfirmRefusal,
  promotionDedupeKey,
  promotionItemTitle,
  promotionOnPass,
  promotionPrincipalRefusal,
  promotionView,
} from './project-promotion';

const logger = new Logger('ProjectPromotion');

/** How many finished checks the "typical" a re-check is measured against is taken from (§3.6). */
const CHECK_TYPICAL_SAMPLE = 5;

/** How many merges back a conversation is offered records for (§3.6's `merged`), newest first. */
const MERGED_RECORD_LIMIT = 20;

/**
 * The states whose round has a landing session the card opens (§2.9 LS1, §3.6): the check in
 * flight, the landing the owner confirmed, the re-check after main moved, and a merge already made
 * — the receipt's "Open landing ›". A candidate asking its owner, a blocked one and one that ended
 * are waiting on no landing to open.
 */
const LANDING_SESSION_STATES: ReadonlySet<string> = new Set([
  'CHECKING', 'CONFIRMED', 'RECHECKING', 'MERGED',
]);

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
 * against — and a runner that finds main has moved hands it back untouched. The candidate is then
 * checked again on the new main and judged by the same rule, and only a withdrawn authorization, or
 * `AUTOMATIC_MERGE_ATTEMPTS` landings that all found main moved, open the card the owner did not see
 * (M-T12). The owner's doors below are unchanged, and `cancel` answers an automatic merge exactly as
 * it answers a pressed one until it is pushed.
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
   * A QUEUED landing is ended on the spot and the merge with it. A RUNNING one is only asked to
   * stop — the runner reads `cancelRequested` when it next reports, or when the claim is taken over
   * — because the one thing this must not do is claim a landing did not happen while a push may be
   * in flight; its own result settles the merge (J-T12), and one that already pushed is the fact
   * (M-T8). A RUNNING landing that stopped reporting past its limit is ended here instead, so the
   * ask cannot leave it holding the serial slot for ever.
   */
  async cancel(
    principal: { userId: string; actingSessionId?: string | null },
    projectId: string,
    promotionId: string,
  ): Promise<ProjectPromotionView> {
    return this.decide(principal, projectId, promotionId,
      (tx, row) => applyCancel(tx, row, principal.userId));
  }

  /**
   * The two reads answer only the caller's own project: another account's — or none — is not found,
   * as every other read of a project answers it, rather than the empty answer that means "your
   * project has nothing on offer".
   */
  private async assertOwnProject(userId: string, projectId: string): Promise<void> {
    const own = await this.prisma.project.findFirst({ where: { id: projectId, ownerId: userId }, select: { id: true } });
    if (!own) throw new NotFoundException('project not found');
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

    // §2.9 LS3: a DECLINED or CANCELLED round is a settlement fact, committed above. Its subject
    // closes in its own transaction, after the fact; a confirmation settles nothing.
    await settleLandingAfterPromotionDecision(this.prisma, promotionId)
      .catch((error) => this.logger.warn(
        `landing settlement after promotion ${promotionId} moved failed: ${(error as Error)?.message ?? error}`));

    const after = await readPromotion(this.prisma, projectId, promotionId);
    if (!after) throw new NotFoundException('promotion not found');
    return this.view(after);
  }

  /** The candidate this project's card is drawn from, or null when there is nothing on offer (§3.6). */
  async readCurrent(userId: string, projectId: string): Promise<ProjectPromotionView | null> {
    await this.assertOwnProject(userId, projectId);
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
    await this.assertOwnProject(userId, projectId);
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
    const [titles, upstreamSyncedAt, landingSessions] = await Promise.all([
      this.titlesIn(rows.flatMap((row) => row.includedTaskIds), userId),
      this.lastUpstreamSync(projectId),
      // A merged row's receipt opens the landing its round made (§3.6's "Open landing ›").
      this.landingSessionsOf(rows),
    ]);
    return rows.map((row) => promotionView(row, {
      tasks: tasksOfTitles(row.includedTaskIds, titles),
      upstreamSyncedAt,
      landingSessionId: landingSessions.get(row.id) ?? null,
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
    const [tasks, upstreamSyncedAt, merge, onPass, landingSessionId] = await Promise.all([
      this.tasksOf(row),
      this.lastUpstreamSync(row.projectId),
      this.mergeExecution(row),
      // What the check in flight leads to, read only while one is: the checking card's last line.
      row.state === 'CHECKING'
        ? readAutomaticProjectFacts(this.prisma, row).then((facts) =>
          promotionOnPass({ sourceKind: row.sourceKind, ...facts }))
        : null,
      // The landing this round belongs to, on the states the card opens it from.
      this.landingSessionOf(row),
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
    return promotionView(row, {
      tasks, upstreamSyncedAt, recheck, onPass, landingSessionId,
      execution: merge.execution,
      cancelRequested: merge.cancelRequested,
      pushBoundaryPassed: merge.pushBoundaryPassed,
    });
  }

  /**
   * The landing session of one candidate's round (§2.9 LS1), null on a state that is not waiting
   * on a landing and when the round recorded none.
   */
  private async landingSessionOf(row: PromotionRow): Promise<string | null> {
    if (!LANDING_SESSION_STATES.has(row.state)) return null;
    const sessions = await this.landingSessionsOf([row]);
    return sessions.get(row.id) ?? null;
  }

  /**
   * The same answer for several candidates in one read — the merged history's receipts — and read
   * through each candidate's own jobs.
   *
   * Never through `project_landing.promotion_id`: that column names the FIRST candidate of a round,
   * and every later candidate that joined it (a supersession, a resubmission) would then read as
   * having no landing at all. A job of the candidate carries the landing it actually belongs to.
   */
  private async landingSessionsOf(rows: readonly PromotionRow[]): Promise<Map<string, string>> {
    if (rows.length === 0) return new Map();
    const jobs = await this.prisma.projectIntegrationJob.findMany({
      where: { promotionId: { in: rows.map((row) => row.id) }, landingId: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { promotionId: true, landingId: true },
    });
    // The newest attempt of each candidate names its round; a later one never moves it.
    const landingOf = new Map<string, string>();
    for (const job of jobs) {
      if (job.promotionId && job.landingId && !landingOf.has(job.promotionId)) {
        landingOf.set(job.promotionId, job.landingId);
      }
    }
    if (landingOf.size === 0) return new Map();
    const landings = await this.prisma.projectLanding.findMany({
      where: { id: { in: [...new Set(landingOf.values())] } },
      select: { id: true, sessionId: true },
    });
    const sessionOf = new Map(landings.map((landing) => [landing.id, landing.sessionId]));
    const sessions = new Map<string, string>();
    for (const [promotionId, landingId] of landingOf) {
      const sessionId = sessionOf.get(landingId);
      if (sessionId) sessions.set(promotionId, sessionId);
    }
    return sessions;
  }

  /**
   * The confirmed merge's own job — never another project job — and the two facts §3.3 M-T10 draws
   * "cancelling" from: it has been asked to stop and has not ended, and it is (not) past the push
   * boundary. Both are false when there is no live landing: a queued job has not been asked (a queue
   * stop ends the job and the candidate at once), and no push is in flight.
   */
  private async mergeExecution(row: PromotionRow): Promise<{
    execution: ProjectPromotionView['execution'];
    cancelRequested: boolean;
    pushBoundaryPassed: boolean;
  }> {
    if (!row.landJobId || (row.state !== 'CONFIRMED' && row.state !== 'RECHECKING')) {
      return { execution: null, cancelRequested: false, pushBoundaryPassed: false };
    }
    const job = await this.prisma.projectIntegrationJob.findFirst({
      where: {
        id: row.landJobId, projectId: row.projectId, promotionId: row.id,
        kind: 'LAND_PROMOTION', state: { in: ['QUEUED', 'RUNNING'] },
      },
      select: {
        state: true, phase: true, startedAt: true, createdAt: true, cancelRequestedAt: true,
        progressProtocol: true, pushReportedGeneration: true, claimGeneration: true,
      },
    });
    if (!job) return { execution: null, cancelRequested: false, pushBoundaryPassed: false };
    return {
      execution: {
        state: job.state as 'QUEUED' | 'RUNNING',
        phase: job.phase as IntegrationJobPhase | null,
        startedAt: job.state === 'RUNNING' ? job.startedAt ?? job.createdAt : job.createdAt,
      },
      cancelRequested: job.state === 'RUNNING' && job.cancelRequestedAt != null,
      pushBoundaryPassed: pushBoundaryPassed(job),
    };
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
    cause: 'DECISION',
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
  // After the card, which keeps the owner's answer: what the platform closes is the failures.
  await closePromotionItems(tx, row.projectId, row.id, 'RESOLVED');
}

/**
 * M-T10: calling back a confirmed merge before it is pushed.
 *
 * The job is the fact and the promotion follows it (J-T8):
 *
 *  - A QUEUED landing was never claimed, so nothing can have pushed: it is ended CANCELLED here and
 *    now, and the merge with it — there is nothing left to wait for.
 *  - A RUNNING landing still reporting is only ASKED to stop. The promotion stays CONFIRMED /
 *    RECHECKING and reads as cancelling; the runner's own result decides the rest (J-T12): CANCELLED
 *    ends the merge as CANCELLED, and a LANDED that got past the push anyway is the fact and becomes
 *    MERGED (M-T8). Writing CANCELLED here would be the platform claiming a landing did not happen
 *    while a push could be in flight.
 *  - A RUNNING landing already silent past its limit (§7.2 V6) is ended on the spot by the J-T9
 *    compare-and-set, with J12's code for its kind. `RUNNER_LOST` proves nothing was pushed, so the
 *    merge is CANCELLED; `PUSH_OUTCOME_UNKNOWN` cannot make that claim, so the candidate goes
 *    BLOCKED — the same ending an abandoned landing gets. Asking such a row to stop would leave it
 *    holding the main serial slot with nobody able to end it.
 *
 * The push boundary is read off the job row by J-T4's rule (`pushBoundaryPassed`): a v2 claim is
 * past it when `push_reported_generation` equals its `claim_generation` — the synchronous PUSH
 * report the progress route writes — and a legacy claim when `phase` is PUSH or VERIFY. Past it the
 * door still refuses with 409 PROMOTION_NOT_READY, because the result is the fact (M-T8). The card
 * draws the same two facts from `cancelRequested` / `pushBoundaryPassed` (§3.6).
 */
async function applyCancel(tx: Prisma.TransactionClient, row: PromotionRow, byUserId: string): Promise<void> {
  if (row.state !== 'CONFIRMED' && row.state !== 'RECHECKING') {
    throw new ConflictException({
      code: PROMOTION_NOT_READY,
      message: `a promotion that is ${row.state.toLowerCase()} is not being merged`,
    });
  }
  const now = new Date();
  let stopped: InFlightStop = { outcome: 'NONE', errorCode: null };
  if (row.landJobId) {
    const job = await tx.projectIntegrationJob.findFirst({
      where: { id: row.landJobId, projectId: row.projectId },
      select: {
        state: true, phase: true, progressProtocol: true, pushReportedGeneration: true, claimGeneration: true,
      },
    });
    if (job && pushBoundaryPassed(job)) {
      throw new ConflictException({
        code: PROMOTION_NOT_READY,
        message: 'this merge is already being pushed and cannot be called back',
      });
    }
    stopped = await stopInFlightJob(tx, {
      projectId: row.projectId,
      jobId: row.landJobId,
      now,
      cause: 'STOP',
      actor: { type: 'OWNER', userId: byUserId },
    });
  }

  if (stopped.outcome === 'STOP_REQUESTED') {
    // A live claim that is talking: it has been asked, and `cancelRequested` in its view says so.
    return;
  }
  if (stopped.outcome === 'ENDED' && stopped.errorCode === 'PUSH_OUTCOME_UNKNOWN') {
    // It may have pushed, so the merge cannot be recorded as cancelled. BLOCKED is what an
    // abandoned landing of an unknown push outcome leaves, and it is the one state that asks
    // somebody to look rather than asserting an outcome.
    await blockPromotion(tx, row.id, [], [], now, null, 'ERROR');
    return;
  }
  // CANCELLED (a queued job, ended here) or RUNNER_LOST (a silent one, which cannot have pushed):
  // the merge is called off. NONE means the job moved on under the press; the CAS below then loses
  // to whatever wrote it, and the result transaction owns the promotion.
  const moved = await tx.projectPromotion.updateMany({
    where: { id: row.id, state: row.state },
    data: { state: 'CANCELLED' satisfies PromotionState, decidedAt: now },
  });
  if (moved.count > 0) await closePromotionItems(tx, row.projectId, row.id, 'RESOLVED');
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

/**
 * §4.2: a candidate that leaves the live states takes the failures about it with it, in the same
 * transaction — `PROMOTION_MOVED_ON`, closed by the platform.
 *
 * The INTEGRATION_* items its check or its landing opened name it by `promotion_id`, and each is
 * waiting on THIS candidate being put right. Once it is superseded, declined, cancelled or merged,
 * nothing will put it right and nobody needs it to: left open, the item is escalated to the owner on
 * the clock, and M-T11 counts it against every later candidate of the project — so a candidate that
 * no longer exists keeps the Automatic setting from merging anything.
 *
 * By the item's `promotion_id`, not by `project_promotion.open_item_id`: that column names the
 * owner's approval card and nothing else, and the card is answered by its own close — the owner's
 * decision (`resolveApprovalItem`) or the supersession beside this call. The kinds here never include
 * the card, so whichever runs first, the owner's answer on it stands.
 *
 * SUPERSEDED when a newer candidate took this one's place, RESOLVED for every other way out.
 */
async function closePromotionItems(
  tx: Prisma.TransactionClient,
  projectId: string,
  promotionId: string,
  state: 'SUPERSEDED' | 'RESOLVED',
): Promise<void> {
  await tx.projectOpenItem.updateMany({
    where: { projectId, promotionId, state: 'OPEN', kind: { in: INTEGRATION_ITEM_KINDS } },
    data: {
      state,
      resolution: 'PROMOTION_MOVED_ON',
      resolvedBy: 'PLATFORM',
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
  /** The tasks a check's own receipt put on the upstream (§10.5 O-L6): J10 dispatches their dependents. */
  landedTaskIds?: string[];
  /** The `LANDED_WITHOUT_CONFIRMATION` that receipt opened (O-R3), pushed once after the commit (§7.6 V12). */
  ownerItemIds?: string[];
  /**
   * J-T13, the owner-confirmed half: this landing ended on a refused push and the candidate — still
   * the owner's confirmation — has the next generation queued. A failure with nobody to look at it:
   * the relay opens no INTEGRATION_ERROR item for it.
   */
  requeuedUnderConfirmation?: boolean;
  /**
   * A moved-main fact this transition produced, for the relay to write into the timeline AFTER the
   * job's own result lines: an automatic landing's recheck (M-T12) or the next generation under an
   * owner's confirmation (J-T13). The promotion decides it; the relay owns the job's claim and round
   * and the transaction that writes them, so the line is written there and lands after the answer it
   * follows on the board.
   */
  movedMain?: { kind: 'RECHECK_ON_MOVED_MAIN' | 'NEXT_GENERATION'; text: string; data: Record<string, unknown> };
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

/** The exception kinds that are an integration line's own problems (§4.2). M-T11 counts the ones
 *  about the project's merges into main: while one is open and still owed (`openItemOwed`), nothing
 *  the project carries into main is clean enough to go there by itself. One about a candidate that
 *  has moved on holds nothing back, whether or not anything has closed it yet. */
const INTEGRATION_ITEM_KINDS = ['INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR'];

/**
 * The facts of M-T11 that are about the project rather than about a check, as they stand at this
 * moment: the line, the Automatic setting, the pause, and the exceptions open on its merge into main.
 * Read by the decision (`automaticConfirmationRefusalIn`) and by the checking card (`onPass`), so
 * the card says what the decision will find.
 *
 * The exceptions counted are the ones a candidate's check or landing opened (`promotion_id` set). A
 * task that failed to land on the project branch opened one too, and it holds nothing back here: that
 * task's work is not on the branch, so it is in nothing a candidate carries (owner decision
 * 2026-10-15 — until then such an item kept every candidate of its project in front of the owner for
 * as long as the coordinator took to repair it).
 */
async function readAutomaticProjectFacts(
  db: Prisma.TransactionClient,
  promotion: Pick<PromotionRow, 'projectId' | 'codebaseId' | 'sourceRef' | 'upstreamRef'>,
): Promise<Pick<AutomaticConfirmationFacts, 'line' | 'coordinatorEnabled' | 'projectPaused' | 'openIntegrationItems'>> {
  const project = await db.project.findUnique({
    where: { id: promotion.projectId },
    select: { coordinatorEnabled: true, pausedAt: true },
  });
  const codebase = await db.projectCodebase.findUnique({
    where: { id: promotion.codebaseId },
    select: { integrationRef: true, upstreamRef: true },
  });
  const [counted] = await db.$queryRaw<Array<{ open: number }>>(Prisma.sql`
    SELECT count(*)::int AS "open"
      FROM "project_open_item" item
     WHERE item."project_id" = ${promotion.projectId}::uuid
       AND item."state" = 'OPEN'
       AND item."kind" IN (${Prisma.join(INTEGRATION_ITEM_KINDS)})
       AND item."promotion_id" IS NOT NULL
       AND ${openItemOwed('item')}`);
  // The line as the binding says now, and only if it is still the line this candidate was made on:
  // its source is the project's branch and its upstream is the project's upstream.
  const line = !codebase
    ? null
    : codebase.integrationRef === codebase.upstreamRef
      ? 'MAIN' as const
      : codebase.integrationRef === promotion.sourceRef && codebase.upstreamRef === promotion.upstreamRef
        ? 'PROJECT_BRANCH' as const
        : null;
  return {
    line,
    coordinatorEnabled: project?.coordinatorEnabled === true,
    projectPaused: project?.pausedAt != null,
    openIntegrationItems: counted!.open,
  };
}

/**
 * M-T11: why this candidate goes to the owner as a card — or null when the project's Automatic
 * setting confirms it instead. The rule itself is `automaticConfirmationRefusal`; this is the part
 * that reads what it weighs about the project, inside the caller's transaction, so the answer is
 * about this moment and no earlier one. Asked when the check comes back READY, again when the landing
 * that answer queued is about to be handed to a runner (`automaticLandingRefusal`), and once more
 * when that landing comes back without landing (`automaticLandingCameBack`).
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
  return automaticConfirmationRefusal({
    sourceKind: promotion.sourceKind,
    ...(await readAutomaticProjectFacts(tx, promotion)),
    conflicts: report.conflicts,
    checks: report.checks,
    upstreamShaChecked: report.upstreamSha,
    mergeTreeSha: report.testedTreeSha,
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
 * A project whose Automatic was switched off in between — or which was paused, or whose line was
 * moved to main, or which has had an integration exception opened since — no longer has the yes
 * this landing was queued under, and it is not pushed on the strength of one that was withdrawn.
 * The rule is the same one (`automaticConfirmationRefusal`), over the facts the check left on the
 * promotion and the project as it stands now: the check is not judged a second time, only what the
 * owner and the line can change. main moving since the check is still the runner's to see, at the
 * push.
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
 * M-T6: retire the candidates standing on one source, their check jobs, their cards and the failures
 * they had open (§4.2, `closePromotionItems`).
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
      // J-T8, one shared rule for every door that stops a generation: a QUEUED one is ended
      // CANCELLED here and now; a RUNNING one still reporting is asked to stop; one already silent
      // past its limit is ended as the ERROR it is, so it cannot hold `#check:<project>` for ever
      // (2026-10-09).
      await stopInFlightJob(tx, {
        projectId,
        jobId: row.checkJobId,
        now: new Date(),
        cause: 'SUPERSEDE',
        actor: { type: 'PLATFORM' },
      });
      // §4.6 X-E5: whatever state that left the check in, the candidate it checked has moved on, so
      // no owner is being asked to abandon the attempt any more.
      await resolveLeaseExpiredItems(tx, row.checkJobId);
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
    await closePromotionItems(tx, projectId, row.id, 'SUPERSEDED');
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

/** The receipt columns `retireCandidatesLandedByReceipt` reads: whose work, from which branch, into
 *  which branch, what happened, and when it was recorded. */
export interface RecordedMergeFacts {
  projectId: string | null;
  taskId: string | null;
  result: string;
  sourceBranch: string;
  targetBranch: string;
  createdAt: Date;
}

/** The states a candidate can be retired from by a merge made somewhere else: the ones still asking
 *  or blocked. A confirmed merge is the platform's own and ends on its own landing (M-T8). */
const RETIRABLE_BY_RECEIPT: ReadonlyArray<PromotionState> = ['CHECKING', 'READY', 'BLOCKED'];

/**
 * M-T13: a merge recorded onto the upstream ends the candidate that was offering the same branch,
 * in the transaction that records it.
 *
 * WHAT WAS WRONG (2026-10-09, project 34b78EQPNkVF8kM3ki7Ch)
 * ----------------------------------------------------------
 * A MAIN-line task went DONE and its branch became a `TASK_BRANCH` candidate (M-F2). The branch was
 * never pushed: its session committed in the runner's worktree, and the coordinator fast-forwarded
 * main to that commit by hand and recorded the merge receipt. The check ran after that, could not
 * fetch the branch (`SOURCE_BRANCH_MISSING`) and blocked the candidate. The coordinator closed the
 * exception it opened ("the work is already on main") and the project went DONE, but nothing ends a
 * blocked candidate except a newer one, a decline or a merge — so the project's sessions page kept
 * saying "Can't merge into main yet", with "Coordinator is resolving it" under it, about work that was
 * already on main. All five BLOCKED task-branch candidates in production had this shape (migration
 * 0411 retires them).
 *
 * THE RULE
 * --------
 * A receipt that says a task's branch landed on the upstream (`MERGED` or `ALREADY_MERGED`) answers
 * the question a candidate for that same branch was asking. The candidate goes `SUPERSEDED`, as when
 * a newer candidate takes its place (M-T6): a merge somewhere else took it. Its check job is stopped
 * as J-T8 asks (a queued one is cancelled, a running one is asked to stop) — except a running one
 * already silent past its limit, which is ended on the spot as `ERROR · RUNNER_LOST` (the J-T9
 * read and compare-and-set): asking a dead runner to stop would leave the job holding its serial
 * key with no one able to end it, and the project's checks would be blocked for good. The owner's
 * card and the exceptions about it are closed by the platform (`PROMOTION_MOVED_ON`, §4.2) — so a
 * check that reports afterwards finds the candidate gone and opens nothing (`applyPromotionJobResult`).
 *
 * WHAT IT LEAVES ALONE
 * --------------------
 *  - another branch of the same task: that one can still carry work main does not have;
 *  - a receipt onto anything but the candidate's upstream, and one that did not land;
 *  - a `PROJECT_BRANCH` candidate: one task's receipt says nothing about the whole branch;
 *  - a candidate the owner already confirmed: its landing job is in flight, and it answers
 *    `ALREADY_LANDED` itself if the work is there (M-T8);
 *  - a candidate made after the receipt was recorded. That is new work offered again, and only a
 *    receipt written after it can answer it — which is what keeps a replayed receipt from ending a
 *    question it never saw.
 *
 * Called by the receipt writers that record a merge somebody made outside a promotion — the agent's
 * and the user's door (`MergeReceiptService.record`, also for the replay of a receipt already
 * recorded) and the runner's own merge (`fromRunnerMergeResult`) — and by the receipt a task branch's
 * own check writes when it finds the work already on the upstream (§10.5 O-L6), which names that check
 * in `keepJobIds`: its answer is being written, and it is not asked to stop. The receipts a promotion
 * writes for its own landing (M9) are written beside a candidate that is already being merged. Answers
 * the ids it retired.
 */
export async function retireCandidatesLandedByReceipt(
  tx: Prisma.TransactionClient,
  receipt: RecordedMergeFacts,
  /** Checks this transaction is writing the answer of (§10.5 O-L6), which are not asked to stop. */
  keepJobIds: readonly string[] = [],
): Promise<string[]> {
  if (!receipt.projectId || !receipt.taskId) return [];
  if (!resultLanded(receipt.result as MergeReceiptResult)) return [];
  // A receipt names branches as a person does and a candidate names refs; either spelling is the
  // same branch.
  const spellings = (branch: string): string[] => {
    const short = shortBranchName(branch);
    return [short, `refs/heads/${short}`];
  };
  const answered = await tx.projectPromotion.findMany({
    where: {
      projectId: receipt.projectId,
      taskId: receipt.taskId,
      sourceKind: 'TASK_BRANCH' satisfies PromotionSourceKind,
      sourceRef: { in: spellings(receipt.sourceBranch) },
      upstreamRef: { in: spellings(receipt.targetBranch) },
      state: { in: [...RETIRABLE_BY_RECEIPT] },
      createdAt: { lte: receipt.createdAt },
    },
    select: { id: true, projectId: true, state: true, checkJobId: true, openItemId: true },
  });
  const now = new Date();
  const retired: string[] = [];
  for (const row of answered) {
    if (await retireCandidate(tx, row, now, keepJobIds)) retired.push(row.id);
  }
  return retired;
}

/**
 * M-T13's edge for one candidate a recorded merge answered: SUPERSEDED by a compare-and-set on the
 * state it was read in, its check stopped as J-T8 asks — unless it is one this transaction is writing
 * the answer of — and the owner's card and the failures about it closed `PROMOTION_MOVED_ON`. False
 * when a landing or an owner's press moved it first.
 */
async function retireCandidate(
  tx: Prisma.TransactionClient,
  row: { id: string; projectId: string; state: string; checkJobId: string | null; openItemId: string | null },
  now: Date,
  keepJobIds: readonly string[],
): Promise<boolean> {
  // A CAS on the state it was read in: a landing or an owner's press that moved it first wins.
  const moved = await tx.projectPromotion.updateMany({
    where: { id: row.id, state: row.state },
    data: { state: 'SUPERSEDED' satisfies PromotionState, decidedAt: now },
  });
  if (moved.count === 0) return false;
  if (row.checkJobId && !keepJobIds.includes(row.checkJobId)) {
    // J-T8's one rule, shared with the other doors that stop a generation: a QUEUED check is
    // ended CANCELLED here and now; a RUNNING one still reporting is asked to stop; one already
    // silent past its limit is ended as the ERROR it is — asking a dead runner to stop is how a
    // job holds its serial key forever, and `claimOne` never re-hands a cancel-requested row, so
    // nobody could ever end it and no later check of the project could be claimed (2026-10-09: a
    // candidate superseded this way kept `#check:<project>` and blocked the whole project).
    await stopInFlightJob(tx, {
      projectId: row.projectId,
      jobId: row.checkJobId,
      now,
      cause: 'M13',
      actor: { type: 'PLATFORM' },
    });
    // §4.6 X-E5: the check's candidate moved on, so its silence is nobody's to abandon.
    await resolveLeaseExpiredItems(tx, row.checkJobId);
  }
  // The owner's card, when the check had already put one in front of them: the merge it asked
  // about has been made, so there is nothing left to approve.
  if (row.openItemId) {
    await tx.projectOpenItem.updateMany({
      where: { id: row.openItemId, state: 'OPEN' },
      data: { state: 'RESOLVED', resolution: 'PROMOTION_MOVED_ON', resolvedBy: 'PLATFORM', resolvedAt: now },
    });
  }
  await closePromotionItems(tx, row.projectId, row.id, 'RESOLVED');
  return true;
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
    /** Somebody asked this claim to stop before this result arrived (J-T8). The promotion follows
     *  the result: a landing still wins (M-T8), an answer that proves nothing was pushed settles the
     *  cancellation, and one that cannot prove it blocks the candidate (§2.6 J12, M-T10). */
    cancelRequested: boolean;
    /** The step the job stopped at: the one its result names, else the one its row last recorded.
     *  A stopped landing's ERROR from VERIFY came after its push (§2.6 J12), so the merge may be on
     *  the upstream. Absent from a caller that has no job row to read it from. */
    phase?: string | null;
    /** The result's error code (J12), so J-T13's `TARGET_MOVED` can be told from every other
     *  failure a landing reports. */
    errorCode: string | null;
    /**
     * Whether the result carried `upstreamMovedCommits` — true only from a runner of this build
     * (J-T13). An older runner's `ERROR / TARGET_MOVED` keeps today's path (M-T9 blocks the
     * candidate): the deployment order is apiserver first, runner after, and a result missing the
     * field is read exactly as before it existed.
     */
    movedCommitsReported: boolean;
    /**
     * J-T13's list as the control plane enriched it, for the two facts the timeline records that
     * the job row alone cannot tell apart afterwards: main moving under an automatic landing
     * (`checkAgainOnMovedMain`) and under an owner-confirmed one (`landAgainAfterMovedUpstream`).
     * The relay computed it in this same transaction; absent for every result that moved nothing.
     */
    movedCommits?: UpstreamMovedCommitsEnriched | null;
    /** The sessions the relay locked up front for their merge recovery, when it did: a MERGED promotion's clear is
     *  limited to those (`MergeReceiptService.lockLandedRecoveries`). */
    recoveryHeld?: ReadonlySet<string>;
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

  // J-T12 / M-T10: the job was asked to stop. Only a LANDED result overrides that ask — the push
  // already happened, and the fact is the fact (M-T8). An answer that proves nothing was pushed
  // settles the cancellation: CANCELLED, not BLOCKED, because there is no failure for anybody to fix
  // — the owner (or the supersession that asked) has already taken the question away. An answer
  // that cannot prove it (§2.6 J12) blocks the candidate instead, exactly as `applyCancel` blocks a
  // timed-out landing it ends with PUSH_OUTCOME_UNKNOWN: the merge may be on the upstream, so it is
  // not written down as cancelled. Either way the stopped generation opens no failure item (J-T8):
  // the relay opens one only for a claim nobody asked to stop.
  if ((input.cancelRequested || input.state === 'CANCELLED')
      && input.state !== 'LANDED' && input.state !== 'ALREADY_LANDED') {
    if (stoppedLandingMayHavePushed(input)) {
      return blockPromotion(tx, promotion.id, checks, input.conflicts, now, input.sourceSha,
        promotionBlockedReasonFor(input.state));
    }
    await tx.projectPromotion.update({
      where: { id: promotion.id },
      data: { state: 'CANCELLED' satisfies PromotionState, decidedAt: now },
    });
    await closePromotionItems(tx, promotion.projectId, promotion.id, 'RESOLVED');
    return { promotionId: promotion.id, state: 'CANCELLED', receiptIds: [], openApproval: null };
  }

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
    // §10.5 O-L6: a task branch's check that found its commit on the upstream has observed the work
    // there. That is a landing to write down — not M-T3's BLOCKED — unless nothing can say it is the
    // work's (`recordCheckSawWorkOnUpstream`).
    if (input.state === 'ALREADY_LANDED' && promotion.sourceKind === 'TASK_BRANCH' && !input.cancelRequested) {
      const seen = await recordCheckSawWorkOnUpstream(tx, promotion, input);
      if (seen) return seen;
    }
    return blockPromotion(tx, promotion.id, checks, input.conflicts, now, input.sourceSha,
      promotionBlockedReasonFor(input.state));
  }

  // LAND_PROMOTION.
  if (input.state === 'READY' && promotion.confirmedAutomatically) {
    return automaticLandingCameBack(tx, promotion, input);
  }
  // J-T13, the owner-confirmed half (owner decision 2026-10-19, option B): the first push that was
  // refused TARGET_MOVED ends this landing only. The candidate keeps the owner's confirmation, and
  // the next generation is queued in this same transaction under that confirmation — the same frozen
  // source, re-checked and merged on the new main (M5). The third consecutive set of steals is a
  // main moving faster than a check keeps up with, and M-T9's block applies then.
  if (input.state === 'ERROR' && input.errorCode === 'TARGET_MOVED'
      && !promotion.confirmedAutomatically && input.movedCommitsReported) {
    return landAgainAfterMovedUpstream(tx, promotion, input);
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
      recoveryHeld: input.recoveryHeld,
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
    await closePromotionItems(tx, promotion.projectId, promotion.id, 'RESOLVED');
    return { promotionId: promotion.id, state: 'MERGED', receiptIds, openApproval: null };
  }
  return blockPromotion(tx, promotion.id, checks, input.conflicts, now, input.sourceSha,
    promotionBlockedReasonFor(input.state));
}

/**
 * §10.5 O-L6: a TASK_BRANCH candidate's check found the commit it worked from already on the upstream
 * (M-S2), which is itself an observation of the task's work there. Written in the check's result
 * transaction: O-R1's receipt through `MergeReceiptService` — whose M-T13 retires the candidate
 * SUPERSEDED with its items PROMOTION_MOVED_ON, and whose O-R3 opens LANDED_WITHOUT_CONFIRMATION when
 * owed — and the task's own integration items closed by the landing (J-T5).
 *
 * The receipt says what the check verified: the candidate's branch and the commit the runner worked
 * from — the delivered commit of a candidate named by it (O-L5), the tip a runner from before resolved
 * for one that was not — against the candidate's own session, the work session the branch was offered
 * from, with `{ integrationJobId, observed: true }` (O-R1). The check this transaction is answering is
 * not asked to stop by its own candidate's retirement.
 *
 * Null leaves the candidate to M-T3, as before, when no receipt can say the task's work is there: the
 * task is no longer DONE, the session is gone, the receipt door refuses (a checkpoint the landing gate
 * does not accept), or the branch carried no commit of its own while a session of the task reported
 * work — that work is somewhere this branch is not (O-L7, O-R2). A branch with nothing of its own and
 * no work reported anywhere gets its receipt marked `empty`, which raises nothing (O-R2).
 *
 * Locks in rank order before the first write (`common/lock-order.ts`): the session (30), the project
 * (40) and the task (50) its rows name; the receipt, the candidate and the items are rank 60. The
 * result transaction has written nothing before this.
 */
async function recordCheckSawWorkOnUpstream(
  tx: Prisma.TransactionClient,
  promotion: PromotionRow,
  input: { jobId: string; sourceSha: string | null; upstreamSha: string | null; targetShaBefore: string | null },
): Promise<PromotionJobOutcome | null> {
  const checked = input.sourceSha ?? promotion.sourceSha;
  if (!checked || !promotion.taskId || !promotion.sessionId) return null;
  const task = await tx.task.findFirst({
    where: { id: promotion.taskId, ownerId: promotion.ownerId },
    select: { status: true, deliveredSha: true, deliveredBaseSha: true },
  });
  if (task?.status !== TaskStatus.DONE) return null;
  const session = await tx.session.findFirst({
    where: { id: promotion.sessionId, ownerId: promotion.ownerId, taskId: promotion.taskId },
    select: { id: true, baseSha: true },
  });
  if (!session) return null;
  // O-L7: a branch's fork point is on every line it forked from, so "already there" says nothing
  // about a branch that never moved off it.
  const base = checked === task.deliveredSha ? task.deliveredBaseSha : session.baseSha;
  const empty = base !== null && checked === base;
  if (empty) {
    const work = await tx.session.findMany({
      where: {
        taskId: promotion.taskId, startsTaskWork: true, deletedAt: null,
        isolationStatus: 'worktree', branch: { not: null },
      },
      select: { changedFiles: true },
    });
    if (work.some(sessionReportedWork)) return null;
  }

  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "session" WHERE "id" = ${session.id}::uuid FOR NO KEY UPDATE`);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "project" WHERE "id" = ${promotion.projectId}::uuid FOR KEY SHARE`);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "task" WHERE "id" = ${promotion.taskId}::uuid FOR KEY SHARE`);
  let receiptId: string;
  let ownerItemIds: string[];
  try {
    const recorded = await MergeReceiptService.recordIn(tx, promotion.ownerId, session.id, {
      result: 'ALREADY_MERGED',
      sourceBranch: shortBranchName(promotion.sourceRef),
      sourceSha: checked,
      targetBranch: shortBranchName(promotion.upstreamRef),
      targetShaBefore: input.targetShaBefore ?? input.upstreamSha,
      targetShaAfter: null,
      detail: { integrationJobId: input.jobId, observed: true, ...(empty ? { empty: true } : {}) },
    }, 'RUNNER', { keepJobIds: [input.jobId] });
    receiptId = recorded.receipt.id;
    ownerItemIds = recorded.ownerItemIds;
  } catch (error) {
    // A door's refusal is raised before it writes anything, so the candidate goes on to M-T3.
    if (!(error instanceof HttpException)) throw error;
    logger.warn(`promotion check ${input.jobId} wrote no receipt for task ${promotion.taskId}: ${error.message}`);
    return null;
  }
  // M-T13 has retired it in that write — unless the receipt was already on record before the candidate
  // was made, which a replay answers nothing newer than. It asked the question this check answered.
  await retireCandidate(tx, promotion, new Date(), [input.jobId]);
  await resolveIntegrationItemsOnLanding(tx, promotion.taskId);
  return {
    promotionId: promotion.id,
    state: 'SUPERSEDED',
    receiptIds: [receiptId],
    landedTaskIds: [promotion.taskId],
    ownerItemIds,
    openApproval: null,
  };
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
    cause: 'AUTOMATIC',
  });
}

/**
 * M-T12: an automatic landing ended without landing — the heartbeat about to hand it out found the
 * authorization gone (`automaticLandingRefusal`), or a runner found main somewhere other than where
 * the check left it and landed nothing.
 *
 * Which of the two it was is read again here rather than off the report: the Automatic setting's yes
 * is asked once more (`automaticConfirmationRefusalIn`), over the facts the check left on the
 * candidate and the project as it stands now. Withdrawn — Automatic switched off, the project paused,
 * its line moved to main, an exception opened on its merge into main — and the candidate is the
 * owner's question (`handBackToOwner`). Still standing, and what stopped the landing was main moving:
 * nothing about the candidate is wrong, only the main its check ran against is gone, so it is checked
 * again on the new one and the rule decides that check as it decided the first (owner decision
 * 2026-10-15). Until then a moved main always opened the card: 100 of the 154 cards Automatic
 * projects' branches opened in the fortnight before that decision were this and nothing else.
 *
 * Bounded by `AUTOMATIC_MERGE_ATTEMPTS`, counted off the candidate's automatic landings that came back
 * READY — the one being applied is not terminal yet, so it is counted by hand.
 */
async function automaticLandingCameBack(
  tx: Prisma.TransactionClient,
  promotion: PromotionRow,
  input: { jobId: string; runnerId: string | null; movedCommits?: UpstreamMovedCommitsEnriched | null },
): Promise<PromotionJobOutcome> {
  const refusal = await automaticConfirmationRefusalIn(tx, promotion, {
    runnerHandsBackMovedUpstream: await runnerHandsBackMovedUpstream(tx, input.runnerId),
    conflicts: promotion.conflicts,
    checks: storedChecks(promotion),
    upstreamSha: promotion.upstreamShaChecked,
    testedTreeSha: promotion.mergeTreeSha,
  });
  if (refusal) return handBackToOwner(tx, promotion);
  const earlier = await tx.projectIntegrationJob.count({
    where: {
      promotionId: promotion.id,
      kind: 'LAND_PROMOTION',
      confirmedAutomatically: true,
      state: 'READY',
      id: { not: input.jobId },
    },
  });
  if (earlier + 1 >= AUTOMATIC_MERGE_ATTEMPTS) return handBackToOwner(tx, promotion);
  return checkAgainOnMovedMain(tx, promotion, {
    endedJobId: input.jobId,
    moved: input.movedCommits ?? null,
    attempt: earlier + 1,
  });
}

/**
 * The candidate checked again because main moved under its automatic landing (M-T12): back to
 * CHECKING under the next CHECK_PROMOTION generation, with nothing confirmed. Same source, same
 * tasks — only main has moved — and the new check's answer is decided the way the first one's was:
 * clean, and the Automatic setting confirms it (M-T11); not, and it is blocked for the coordinator
 * (M-T3) or put in front of the owner (M-T2).
 *
 * The landing job keeps saying it was the setting's and ended READY: that is the attempt's record,
 * and what `automaticLandingCameBack` counts.
 */
async function checkAgainOnMovedMain(
  tx: Prisma.TransactionClient,
  promotion: PromotionRow,
  input: {
    /** The landing that came back READY; its timeline records that main moved. */
    endedJobId: string;
    moved: UpstreamMovedCommitsEnriched | null;
    /** Which automatic attempt this recheck is, counted as `AUTOMATIC_MERGE_ATTEMPTS` counts it. */
    attempt: number;
  },
): Promise<PromotionJobOutcome> {
  const codebase = await tx.projectCodebase.findUnique({
    where: { id: promotion.codebaseId },
    select: { canonicalRepoUrl: true },
  });
  // Unreachable while the rule above reads a line off this same binding; the card if it ever is.
  if (!codebase) return handBackToOwner(tx, promotion);
  const checkJobId = await queuePromotionJob(tx, {
    kind: 'CHECK_PROMOTION',
    promotion,
    canonicalRepoUrl: codebase.canonicalRepoUrl,
    cause: 'RETRY',
  });
  await tx.projectPromotion.update({
    where: { id: promotion.id },
    data: {
      state: 'CHECKING' satisfies PromotionState,
      checkJobId,
      confirmedAutomatically: false,
      confirmedAt: null,
      landJobId: null,
    },
  });
  return {
    promotionId: promotion.id,
    state: 'CHECKING',
    receiptIds: [],
    openApproval: null,
    // §2.9 LS2's fourth fact the job row could not tell apart afterwards (M-T12): the automatic
    // landing found main moved and the candidate is checked again on the new main. The relay writes
    // it on the landing that came back, with that attempt's claim and round.
    movedMain: {
      kind: 'RECHECK_ON_MOVED_MAIN',
      text: movedMainText(input.moved, 'checking again on the new main'),
      data: {
        nextJobId: checkJobId,
        attempt: input.attempt,
        ...(input.moved ? { upstreamMovedCommits: input.moved } : {}),
      },
    },
  };
}

/**
 * J-T13, the owner-confirmed half (owner decision 2026-10-19, option B): the first push that lost a
 * race for the upstream ends THAT landing and nothing else.
 *
 * The candidate keeps the confirmation the owner gave — they are not asked to press again — and the
 * next generation of the landing is queued in this same transaction: the same frozen `source_sha`,
 * `confirmed_automatically = false`, `land_job_id` pointing at it. It finds the new main at its own
 * fetch, merges and checks again (M5), and lands if the push it makes survives the race this time.
 * A NEW claim generation resets the push boundary (§2.2 J-T4), so the owner's Cancel is available
 * again for the whole of the next attempt.
 *
 * `PROMOTION_LAND_ATTEMPTS` consecutive generations ending this way is a main moving faster than a
 * check keeps up with: the candidate goes BLOCKED (M-T9) and the INTEGRATION_ERROR item the relay
 * opens beside it carries this last landing's `upstreamMovedCommits`. Any other result — a landing,
 * a conflict, a red check — ends the count with it, and a candidate the coordinator later has
 * confirmed again counts from its new `confirmed_at`.
 */
async function landAgainAfterMovedUpstream(
  tx: Prisma.TransactionClient,
  promotion: PromotionRow,
  input: {
    jobId: string;
    checks: IntegrationCheckResult[];
    conflicts: string[];
    sourceSha: string | null;
    movedCommits?: UpstreamMovedCommitsEnriched | null;
  },
): Promise<PromotionJobOutcome> {
  const blocked = () => blockPromotion(tx, promotion.id, input.checks as unknown as Prisma.InputJsonValue,
    input.conflicts, new Date(), input.sourceSha, 'ERROR');
  // The generation being applied is not terminal yet — the relay writes it after this decision — so
  // it is counted by hand, exactly as `automaticLandingCameBack` counts its own.
  //
  // The boundary is the claim, not the row's `created_at`: the job is created in the transaction
  // that writes `confirmed_at`, and `created_at` is the database's transaction start — earlier than
  // the instant the app writes `confirmed_at` a few statements later — so a `created_at` boundary
  // would leave out the first landing of the confirmation. The claim happens after that transaction
  // commits, on both counts.
  const earlier = await tx.projectIntegrationJob.count({
    where: {
      promotionId: promotion.id,
      kind: 'LAND_PROMOTION',
      confirmedAutomatically: false,
      state: 'ERROR',
      errorCode: 'TARGET_MOVED',
      id: { not: input.jobId },
      ...(promotion.confirmedAt ? { claimedAt: { gte: promotion.confirmedAt } } : {}),
    },
  });
  if (earlier + 1 >= PROMOTION_LAND_ATTEMPTS) return blocked();
  const codebase = await tx.projectCodebase.findUnique({
    where: { id: promotion.codebaseId },
    select: { canonicalRepoUrl: true },
  });
  // Unreachable while a landing of this candidate was handed to a runner at all; the block is the
  // honest answer if the binding went away under it.
  if (!codebase) return blocked();
  const nextJobId = await queuePromotionJob(tx, {
    kind: 'LAND_PROMOTION',
    promotion,
    canonicalRepoUrl: codebase.canonicalRepoUrl,
    confirmedAutomatically: false,
    cause: 'RETRY',
  });
  // The candidate stays where it is — CONFIRMED, or RECHECKING when the last landing had already
  // reported the move (M-T7) — and only the landing it points at moves.
  await tx.projectPromotion.update({
    where: { id: promotion.id },
    data: { landJobId: nextJobId },
  });
  return {
    promotionId: promotion.id,
    state: promotion.state as PromotionState,
    receiptIds: [],
    openApproval: null,
    requeuedUnderConfirmation: true,
    // §2.9 LS2's fifth fact the job row could not tell apart afterwards (J-T13, owner decision
    // 2026-10-19): the owner-confirmed landing's push was refused because main moved, and the next
    // generation runs under the SAME confirmation. The relay writes it on the landing that was
    // refused, after that attempt's answer.
    movedMain: {
      kind: 'NEXT_GENERATION',
      text: movedMainText(input.movedCommits ?? null, 're-checking before merging'),
      data: {
        nextJobId,
        ...(input.movedCommits ? { upstreamMovedCommits: input.movedCommits } : {}),
      },
    },
  };
}

/**
 * The automatic landing's candidate goes back to being the owner's question (M-T12): the
 * authorization it was queued under is gone, or main kept moving under it for
 * `AUTOMATIC_MERGE_ATTEMPTS` landings. READY, with the card the owner was spared opened after all,
 * and with the check it already has: the owner's press is what decides whether it is checked again
 * on the new main and merged (M5), exactly as if the card had been theirs from the start.
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

/**
 * Whether a stopped claim's answer leaves its merge possibly pushed (§2.6 J12, M-T10). Only a
 * `LAND_PROMOTION` pushes, and only an ERROR can leave the question open: the job's own CANCELLED
 * (J-T12), a failed check, a conflict and every other answer end without a push. Of the ERRORs, the
 * platform's `PUSH_OUTCOME_UNKNOWN` (an abandoned claim, J-T10) says so outright and `RUNNER_LOST`
 * is the platform's proof that nothing was pushed; of the ones a runner reports, an error from
 * VERIFY — a legacy claim that read its stop only at the start, pushed, and then found the landed
 * tree wrong (`LANDED_TREE_MISMATCH`) — came after the push. An ERROR before the push, or a push the
 * upstream refused, proves the negative.
 */
function stoppedLandingMayHavePushed(answer: {
  jobKind: string;
  state: string;
  errorCode: string | null;
  phase?: string | null;
}): boolean {
  if (answer.jobKind !== 'LAND_PROMOTION' || answer.state !== 'ERROR') return false;
  if (answer.errorCode === 'PUSH_OUTCOME_UNKNOWN') return true;
  if (answer.errorCode === 'RUNNER_LOST') return false;
  return answer.phase === 'VERIFY' || answer.errorCode === 'LANDED_TREE_MISMATCH';
}

/** M-T3 / M-T9: the candidate stops and somebody has to look at it. */
async function blockPromotion(
  tx: Prisma.TransactionClient,
  promotionId: string,
  checks: Prisma.InputJsonValue,
  conflicts: string[],
  now: Date,
  sourceSha: string | null,
  /** What the job answered (0409). The card says it; `checks` and `conflicts` cannot, since both
   *  are empty when there was nothing to merge and when the job errored before any check ran. */
  reason: PromotionBlockedReason | null,
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
      blockedReason: reason,
      decidedAt: now,
    },
  });
  return { promotionId, state: 'BLOCKED', receiptIds: [], openApproval: null };
}

/**
 * §4.7 H1: a blocked candidate's check queued again because its project's coordinator asked for it,
 * with a reason, through `integration_retry` — inside that door's transaction, under the candidate's
 * row lock it already holds.
 *
 * The candidate goes back to CHECKING with the next CHECK_PROMOTION generation, which carries what it
 * reruns, why and who asked (the retry columns 0344 put on a job, admitted for a check by 0368).
 * Nothing about what is being checked changes: the same frozen source on the same upstream, so a check
 * that passes leaves the candidate READY for the owner's card, or confirmed by the Automatic setting's
 * own rule (M-T11), exactly as its first check would have. `decided_at` is cleared because the
 * candidate is asking again; a check that fails again blocks it at a new moment.
 *
 * The candidate's confirmation is cleared with the re-check, because the re-check asks the merge
 * question anew: a `confirmed_by_user_id` / `confirmed_at` recorded against an earlier check result
 * answered a different question (the tree a re-check runs on can differ — the upstream moves), and
 * left standing it would collide with `project_promotion_automatic_chk` the moment a clean result is
 * confirmed by the Automatic setting (`confirmed_automatically = true` forbids a named confirmer).
 * Whoever decides the fresh result decides it fresh: the Automatic setting, or the account owner on a
 * card the clean check opens as it always did. For a project without Automatic this changes nothing
 * about the door's reach — it only means the row no longer carries a confirmation the new check has
 * not earned, and the owner's earlier press is not treated as covering a merge nobody asked them
 * about again.
 *
 * Null when nothing can be queued: the candidate is no longer asking (not BLOCKED, and not CHECKING
 * for the timed-out re-check this door admits), or its repository is gone.
 */
export async function requeuePromotionCheck(
  tx: Prisma.TransactionClient,
  input: { promotionId: string; retry: LandingRetryRequest },
): Promise<{ jobId: string; generation: number; landingSessionId: string | null } | null> {
  const promotion = await tx.projectPromotion.findUnique({
    where: { id: input.promotionId },
    select: PROMOTION_COLUMNS,
  });
  // CHECKING is the timed-out re-check's state (J-T9): the door has already decided the authority,
  // and a candidate asking again is exactly what this queueing is for. Anything past asking
  // (READY and beyond) is refused upstream of here.
  if (!promotion || (promotion.state !== 'BLOCKED' && promotion.state !== 'CHECKING')) return null;
  const codebase = await tx.projectCodebase.findUnique({
    where: { id: promotion.codebaseId },
    select: { canonicalRepoUrl: true },
  });
  if (!codebase) return null;
  const jobId = await queuePromotionJob(tx, {
    kind: 'CHECK_PROMOTION',
    promotion,
    canonicalRepoUrl: codebase.canonicalRepoUrl,
    retry: input.retry,
    cause: 'RETRY',
  });
  await tx.projectPromotion.update({
    where: { id: promotion.id },
    // Asking again, so nothing blocks it any more: a check that fails again records its own reason.
    // The confirmation columns go back to NULL with it: the re-check asks the merge question anew,
    // and the Automatic setting or the owner decides the fresh result (see the comment above).
    data: {
      state: 'CHECKING' satisfies PromotionState,
      checkJobId: jobId,
      decidedAt: null,
      blockedReason: null,
      confirmedByUserId: null,
      confirmedAt: null,
      confirmedAutomatically: false,
    },
  });
  const queued = await tx.projectIntegrationJob.findUniqueOrThrow({
    where: { id: jobId },
    select: { generation: true, landingId: true },
  });
  // §2.9: the round (or, on a MAIN line, the task segment) this re-check belongs to, so the door's
  // answer can address the landing session. Its id is pre-generated on the subject row.
  const landing = queued.landingId
    ? await tx.projectLanding.findUnique({
        where: { id: queued.landingId },
        select: { sessionId: true },
      })
    : null;
  return {
    jobId,
    generation: queued.generation,
    landingSessionId: landing?.sessionId ?? null,
  };
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
    /** J12's repair: this receipt is for a landing whose push outcome nobody could read (see
     *  `MergeReceiptService.fromIntegrationJob`). */
    recoveredUnknownPush?: boolean;
    /** The sessions the result locked up front for their merge recovery, when it did: the clears are limited to
     *  those (`MergeReceiptService.lockLandedRecoveries`). */
    recoveryHeld?: ReadonlySet<string>;
  },
): Promise<string[]> {
  // Both ids a receipt is written against are history references (0423, 0424), and both are foreign
  // keys on the receipt: a task deleted, or a session purged from Trash, while its work waited for
  // this merge leaves its id on the landing and on the promotion. So each is looked up first, one
  // `IN` apiece, and a gone one is written as the NULL its key used to leave — no receipt for a
  // session that is gone, as when the landing's `session_id` read NULL, and a receipt naming no task
  // for a task that is gone, as SET NULL leaves one written a moment before the delete.
  const { onItsOwnBranch, byTask, sessionFor, liveSessions } = await upstreamReceiptWork(tx, input.promotion);
  const liveTasks = new Set(input.promotion.includedTaskIds.length === 0 ? [] : (await tx.task.findMany({
    where: { id: { in: input.promotion.includedTaskIds } },
    select: { id: true },
  })).map((row) => row.id));
  // The merge ends the merge recovery each of these sessions was holding: all of them at once, in id order,
  // before the receipts below take their own locks — so `fromIntegrationJob` finds nothing left to clear.
  await MergeReceiptService.clearLandedRecoveries(tx, [...liveSessions], input.recoveryHeld);
  const receiptIds: string[] = [];
  for (const taskId of input.promotion.includedTaskIds) {
    const landing = byTask.get(taskId);
    const sessionId = sessionFor(taskId);
    // The job's tested commit, or — when there is none because the landing answered ALREADY_LANDED
    // — the candidate's own source, which is the commit that turned out to be on the upstream
    // already. Without the second half that answer would leave the task with no receipt and the
    // criterion reading unlanded while its work sits on main.
    const sourceSha = landing?.landedSha
      ?? (onItsOwnBranch ? input.testedSha ?? input.promotion.sourceSha : null);
    if (!sessionId || !liveSessions.has(sessionId) || !sourceSha) continue;
    const written = await MergeReceiptService.fromIntegrationJob(tx, {
      ownerId: input.promotion.ownerId,
      sessionId,
      taskId: liveTasks.has(taskId) ? taskId : null,
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
      recoveredUnknownPush: input.recoveredUnknownPush,
      recoveryHeld: input.recoveryHeld,
    });
    receiptIds.push(...written);
  }
  return receiptIds;
}

/** The promotion columns that decide which session each of its tasks' M9 receipts is written against. */
type UpstreamReceiptPromotion = {
  id: string; projectId: string; sourceKind: string; sessionId: string | null; includedTaskIds: string[];
};

/**
 * Which session each task of a promotion gets its M9 receipt against, and which of those sessions are still there
 * (`liveSessions`) — read, not locked. Its own landing's session for a `PROJECT_BRANCH` candidate, the candidate's
 * session for a `TASK_BRANCH` one (see `writeUpstreamReceipts`).
 */
async function upstreamReceiptWork(tx: Prisma.TransactionClient, promotion: UpstreamReceiptPromotion) {
  const onItsOwnBranch = promotion.sourceKind === 'TASK_BRANCH';
  const landings = onItsOwnBranch ? [] : await tx.projectIntegrationJob.findMany({
    where: {
      projectId: promotion.projectId,
      kind: 'LAND_TASK',
      state: 'LANDED',
      taskId: { in: promotion.includedTaskIds },
    },
    orderBy: { finishedAt: 'asc' },
    select: { taskId: true, sessionId: true, landedSha: true },
  });
  const byTask = new Map(landings.map((row) => [row.taskId, row]));
  const sessionFor = (taskId: string) =>
    byTask.get(taskId)?.sessionId ?? (onItsOwnBranch ? promotion.sessionId : null);
  const sessionIds = [...new Set(promotion.includedTaskIds.flatMap((taskId) => sessionFor(taskId) ?? []))];
  const liveSessions = new Set(sessionIds.length === 0 ? [] : (await tx.session.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true },
  })).map((row) => row.id));
  return { onItsOwnBranch, byTask, sessionFor, liveSessions };
}

/**
 * The sessions and tasks this promotion's M9 receipts would name — read, not locked — for
 * `applyIntegrationJobResult`, which locks them ahead of the first receipt of a result that writes J12's receipts
 * beside its own or this promotion's: the sessions whose merge recovery they clear, and the tasks their foreign
 * keys take. None for a promotion that is gone.
 */
export async function upstreamReceiptSubjects(
  tx: Prisma.TransactionClient,
  promotionId: string,
): Promise<{ sessionIds: string[]; taskIds: string[] }> {
  const promotion = await tx.projectPromotion.findUnique({
    where: { id: promotionId },
    select: { id: true, projectId: true, sourceKind: true, sessionId: true, includedTaskIds: true },
  });
  if (!promotion) return { sessionIds: [], taskIds: [] };
  const { liveSessions } = await upstreamReceiptWork(tx, promotion);
  return { sessionIds: [...liveSessions], taskIds: promotion.includedTaskIds };
}

/**
 * J12's repair for a promotion: a LAND_PROMOTION whose push outcome nobody could read (ERROR ·
 * PUSH_OUTCOME_UNKNOWN) turned out to have landed — a later landing on the same serial key found its
 * tested commit on the upstream — so M9's receipts are written after all, against that job.
 *
 * The job row is not touched (J4): its terminal state and code are what was known at the time, and
 * the receipts' own `detail` names it (`integrationJobId`, plus `recoveredUnknownPush`). The
 * candidate is NOT moved to MERGED either: it may be BLOCKED (M-T10 / abandon cannot claim a merge
 * it could not prove) or CANCELLED, and a terminal candidate row is not this function's to rewrite.
 * The tasks' receipts are what makes §1.4 and §2.5 read their work as landed; the candidate's own
 * disposition is the coordinator's, and this is said in the task's evidence.
 */
export async function recoverPromotionPushReceipts(
  tx: Prisma.TransactionClient,
  input: {
    promotionId: string;
    /** The landing whose outcome was unknown — the job the receipts are written against. */
    jobId: string;
    testedSha: string;
    targetShaBefore: string | null;
    testedTreeSha: string | null;
    /** Whether that landing was the Automatic setting's (0301). */
    confirmedAutomatically: boolean;
    /** The sessions the result locked up front for their merge recovery (`writeUpstreamReceipts`). */
    recoveryHeld?: ReadonlySet<string>;
  },
): Promise<string[]> {
  const promotion = await tx.projectPromotion.findUnique({
    where: { id: input.promotionId },
    select: PROMOTION_COLUMNS,
  });
  if (!promotion) return [];
  return writeUpstreamReceipts(tx, {
    promotion: { ...promotion, confirmedAutomatically: input.confirmedAutomatically },
    jobId: input.jobId,
    state: 'LANDED',
    mergedSha: input.testedSha,
    targetShaBefore: input.targetShaBefore,
    testedSha: input.testedSha,
    testedTreeSha: input.testedTreeSha,
    recoveredUnknownPush: true,
    recoveryHeld: input.recoveryHeld,
  });
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
