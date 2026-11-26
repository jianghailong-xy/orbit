import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { Prisma, type GithubPullRequest } from '@prisma/client';
import {
  uuidToBase62,
  type IntegrationCheckResult,
  type IntegrationJobResultRequest,
  type MergeCommand,
  type PullRequestMergeMethod,
} from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { recordCommittedIntegrationJobEvent } from '../projects/project-integration-event';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { ProjectPromotionService } from '../projects/project-promotion.service';
import { settleTaskSegmentAfterReceipt } from '../projects/landing-session';
import { checkpointIdForCommit } from '../projects/task-checkpoint.service';
import { PushService } from '../push/push.service';
import { ControlPlaneLeader } from '../realtime/control-plane-leader';
import { RealtimeService } from '../realtime/realtime.service';
import { deliverIntegrationAftermath } from '../runner-api/integration-aftermath';
import { applyIntegrationJobResult, resultTransactionRetry } from '../runner-api/integration-job-relay';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { followWikiDocsAfterSessionMerge } from '../wiki/wiki-docs-follow';
import { GithubCallError, GithubClient, type GithubPullRequestCheck, type GithubPullRequestReading } from './github-api.client';
import { type GithubAppCredentials, GithubAppConfigService } from './github-app-config.service';
import { GithubInstallationGrants } from './github-installation-grants';
import { landingCommandFields, landingModeOf } from '../projects/pull-request-landing';
import { decidePullRequest, mergeMethodFor, mergeMethodRefused, mergeRefusedForMovedBase, type PullRequestSubject } from './pull-request-door';
import { githubCheckResult } from '../projects/pull-request-landing';
import { IntegrationJobRefused } from '../runner-api/integration-job-relay';
import { SessionsService } from '../sessions/sessions.service';
import {
  SESSION_FIX_ROUNDS,
  pullRequestFixMessage,
  pullRequestFixTurnId,
  pullRequestFixTurnPrefix,
} from '../sessions/pull-request-fix-turn';

/** A server token is used again until this long before it expires; it is never handed to a runner (§12). */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
/** How long a repository's name, read by its id, is used again. A rename is picked up by the next read after it. */
const REPOSITORY_NAME_TTL_MS = 10 * 60_000;

/** How often the re-read looks for pull requests to read (§4.7). */
export const REREAD_TICK_MS = 60_000;
/** The re-read's floor while webhook deliveries are arriving, and when none has arrived in the last hour (D3). */
export const REREAD_WITH_DELIVERIES_MS = 10 * 60_000;
export const REREAD_WITHOUT_DELIVERIES_MS = 60_000;
export const DELIVERIES_QUIET_AFTER_MS = 60 * 60_000;
/** The most pull requests one tick reads. */
export const REREAD_BATCH = 50;

/** How often one row's read may repeat back to back when a merge it made needs reading again. */
const READS_PER_ADVANCE = 3;

/** The most failed required checks one J-T16 records, each with its log. */
const FAILED_CHECKS_KEPT = 3;

/** What GitHub said that ends the attempt waiting on a pull request without landing it (§4.2). */
type PullRequestFailure =
  | { kind: 'CHECK_FAILED'; checks: IntegrationCheckResult[] }
  | { kind: 'TARGET_MOVED'; counted: boolean; condition: string | null }
  | { kind: 'CLOSED' }
  | { kind: 'HEAD_CHANGED' };

/**
 * The pull request door (docs/design/protected-branch-landing.md §4): everything Orbit does on GitHub for a landing
 * that waits on a pull request. After J-T14 (a job) or a session's `pull_request` merge result commits, it opens the
 * pull request as the App; then, on every webhook delivery about it and on the slow re-read, it reads the pull request
 * again in full and acts on GitHub's answer (§4.3): it waits, merges with `sha` = the head it pushed (§4.4), and once
 * GitHub says it merged, writes the landing — J-T15 for a job, through the result transaction every landing goes
 * through, or the session's merged state and receipt (§4.6).
 *
 * The token it uses is the server's own (§12): minted for one repository with pull requests, checks and statuses, held
 * in this process's memory and answered to no runner route.
 */
@Injectable()
export class PullRequestDoorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('PullRequestDoor');
  private readonly tokens = new Map<string, { token: string; expiresAt: Date }>();
  private readonly names = new Map<string, { at: number; fullName: string }>();
  /** The read in flight per row, and the rows asked again while it ran: one read at a time, none lost. */
  private readonly reading = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<unknown>;
  /** The clock the re-read's cadence reads; a spec sets its own. */
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: GithubAppConfigService,
    private readonly github: GithubClient,
    private readonly grants: GithubInstallationGrants,
    @Optional() private readonly promotions?: ProjectPromotionService,
    @Optional() private readonly mergeReceipts?: MergeReceiptService,
    @Optional() private readonly openItems?: ProjectOpenItemService,
    @Optional() private readonly push?: PushService,
    @Optional() private readonly realtime?: RealtimeService,
    /** Which process re-reads. `@Optional()` for a spec that calls `tick` itself. */
    @Optional() private readonly leader?: ControlPlaneLeader,
    /** A session's Merge whose check failed or whose target moved (§4.6): its fix turn and its merge again. */
    @Optional() private readonly sessions?: SessionsService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (this.leader && !this.leader.leads()) return;
      if (this.ticking) return;
      this.ticking = this.tick()
        .catch((error) => this.logger.error(`the re-read stopped and runs again in a minute: ${(error as Error)?.message}`))
        .finally(() => { this.ticking = undefined; });
    }, REREAD_TICK_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.ticking;
  }

  /**
   * §3 and §4.6 for a session's Merge: the mode each command lands by, for a runner that declared
   * `session-merge-pull-request/v1`. The landing branch is `orbit/land/<session id>`; a session whose pull request into
   * this target is open updates it. A merge recovery's operation keeps its own path, and so does every command handed
   * to a runner without the capability. A workspace whose owner chose Push as me lands as the owner (§3 rule 4) on a
   * runner that declared `push-as-me/v1`, while the owner's GitHub connection is live.
   */
  async withMergeLanding(commands: MergeCommand[], runnerDeclares: boolean, pushAsMeDeclared = false): Promise<MergeCommand[]> {
    if (!runnerDeclares || commands.length === 0) return commands;
    const ids = commands.map((command) => command.sessionId);
    const [sessions, open] = await Promise.all([
      this.prisma.session.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          ownerId: true,
          workspace: { select: { githubRepoId: true, githubInstallationId: true, landingMode: true } },
        },
      }),
      this.prisma.githubPullRequest.findMany({
        where: { sessionId: { in: ids }, state: { in: ['OPENING', 'OPEN'] } },
        select: { sessionId: true, headSha: true, baseRef: true },
      }),
    ]);
    const pushAsMeOwners = pushAsMeDeclared
      ? await this.liveConnections([...new Set(sessions
        .filter((session) => session.workspace?.landingMode === 'PUSH_AS_ME')
        .map((session) => session.ownerId))])
      : new Set<string>();
    return Promise.all(commands.map(async (command) => {
      if (command.recoveryAction) return command;
      const session = sessions.find((row) => row.id === command.sessionId) ?? null;
      const workspace = session?.workspace ?? null;
      const target = command.targetBranch ? `refs/heads/${command.targetBranch}` : '';
      const pr = open.find((row) => row.sessionId === command.sessionId && (target === '' || row.baseRef === target)) ?? null;
      const installationId = workspace?.githubInstallationId?.toString() ?? null;
      const granted = installationId ? await this.grants.pullRequestsGranted(installationId).catch(() => null) : null;
      const mode = landingModeOf({
        targetRef: target,
        githubRepoId: workspace?.githubRepoId ?? null,
        githubInstallationId: workspace?.githubInstallationId ?? null,
        runnerDeclares,
        permissionsGranted: granted,
        landingKey: command.sessionId,
        openPullRequest: pr ? { headSha: pr.headSha } : null,
        pushAsMe: workspace?.landingMode === 'PUSH_AS_ME' && !!session && pushAsMeOwners.has(session.ownerId),
      });
      return { ...command, ...landingCommandFields(mode, runnerDeclares) };
    }));
  }

  /** The owners among `ownerIds` whose GitHub connection is one GitHub still takes (§3 rule 4). */
  private async liveConnections(ownerIds: string[]): Promise<Set<string>> {
    if (ownerIds.length === 0) return new Set();
    const rows = await this.prisma.githubConnection.findMany({
      where: { ownerId: { in: ownerIds }, refreshExpiresAt: { gt: new Date() } },
      select: { ownerId: true },
    });
    return new Set(rows.map((row) => row.ownerId));
  }

  /** After the commit that left these pull requests waiting (J-T14, a session's `pull_request`): open and read them. */
  async advance(ids: readonly string[]): Promise<void> {
    for (const id of ids) await this.reread(id);
  }

  /**
   * One pull request read again from GitHub, and what that read decides. Never throws: a failure is logged, the row
   * stays as it was, and the next delivery or re-read asks again. Reads of one row never overlap; a row asked again
   * while a read of it runs is read once more after it.
   */
  reread(id: string): Promise<void> {
    const running = this.reading.get(id);
    if (running) {
      this.again.add(id);
      return running;
    }
    const run = (async () => {
      try {
        let reads = 0;
        do {
          this.again.delete(id);
          const more = await this.readOnce(id);
          if (more) this.again.add(id);
          reads += 1;
        } while (this.again.has(id) && reads < READS_PER_ADVANCE);
      } catch (error) {
        this.logger.warn(`pull request ${id} not read: ${describe(error)}`);
      } finally {
        this.again.delete(id);
        this.reading.delete(id);
      }
    })();
    this.reading.set(id, run);
    return run;
  }

  /**
   * §4.7's slow re-read: every open pull request not read for ten minutes while deliveries are arriving, or for a minute
   * when none has arrived in the last hour. Time decides when Orbit looks; GitHub's answer decides what changes (G3).
   */
  async tick(now: Date = this.now()): Promise<number> {
    const [last] = await this.prisma.$queryRaw<Array<{ at: Date | null }>>(Prisma.sql`
      SELECT max("received_at") AS "at" FROM "github_webhook_delivery"`);
    const quiet = !last?.at || now.getTime() - last.at.getTime() > DELIVERIES_QUIET_AFTER_MS;
    const before = new Date(now.getTime() - (quiet ? REREAD_WITHOUT_DELIVERIES_MS : REREAD_WITH_DELIVERIES_MS));
    const due = await this.prisma.githubPullRequest.findMany({
      where: { state: { in: ['OPENING', 'OPEN'] }, OR: [{ observedAt: null }, { observedAt: { lt: before } }] },
      select: { id: true },
      orderBy: [{ observedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: REREAD_BATCH,
    });
    for (const row of due) await this.reread(row.id);
    return due.length;
  }

  /** One read. Answers whether the row is worth reading again at once: a merge this read made. */
  private async readOnce(id: string): Promise<boolean> {
    let row = await this.prisma.githubPullRequest.findUnique({ where: { id } });
    if (!row || (row.state !== 'OPENING' && row.state !== 'OPEN')) return false;
    const app = await this.config.credentials();
    if (!app) {
      this.logger.warn(`pull request ${id} waits: GitHub is not set up on this Orbit`);
      return false;
    }
    const token = await this.token(app, row);
    const fullName = await this.repositoryName(token, row.githubRepoId.toString());
    if (row.state === 'OPENING') {
      const opened = await this.open(row, token, fullName);
      if (!opened) return false;
      row = opened;
    }
    const reading = await this.github.pullRequest(token, fullName, row.number as number);
    const verdict = decidePullRequest(row, reading);
    await this.prisma.githubPullRequest.updateMany({
      where: { id: row.id, state: 'OPEN' },
      data: {
        condition: verdict.condition,
        // What the clients read (§8): each check's name, whether it is required, how it stands and its link.
        checks: verdict.checks.map(({ name, required, state, url, conclusion }) => ({ name, required, state, url, conclusion })) as unknown as Prisma.InputJsonValue,
        observedAt: this.now(),
      },
    });
    const decision = verdict.decision;
    switch (decision.kind) {
      case 'MERGED':
        await this.landed(row, reading, token, fullName);
        return false;
      case 'MERGE':
        // Only a pull request somebody waits on is merged: a job in PULL_REQUEST, or a session's Merge. One whose
        // attempt was stopped (J-T18) stays open for the subject's next attempt.
        if (!(await this.waitedOn(row))) return false;
        return this.merge(row, reading, token, fullName);
      case 'CHECK_FAILED': {
        if (!(await this.waitedOn(row))) return false;
        const failed = await this.failedChecks(row, reading, decision.failed, token, fullName);
        await this.fail(row, reading, { kind: 'CHECK_FAILED', checks: failed });
        return false;
      }
      case 'TARGET_MOVED':
        if (!(await this.waitedOn(row))) return false;
        await this.fail(row, reading, { kind: 'TARGET_MOVED', counted: false, condition: verdict.condition });
        return false;
      case 'CLOSED':
        await this.fail(row, reading, { kind: 'CLOSED' });
        return false;
      case 'HEAD_CHANGED':
        if (!(await this.waitedOn(row))) return false;
        await this.fail(row, reading, { kind: 'HEAD_CHANGED' });
        return false;
      case 'WAIT':
        if (verdict.condition === 'REVIEW_REQUIRED') await this.announceReview(row, reading);
        return false;
    }
  }

  /**
   * J-T16's GitHub checks (§4.5 "The log"): each required check that failed, with the log of the GitHub Actions job
   * behind it (Actions: read), or what the check said about itself and its link for any other. A log GitHub does not
   * answer is a check recorded with what it said about itself.
   */
  private async failedChecks(
    row: GithubPullRequest, reading: GithubPullRequestReading, failed: GithubPullRequestCheck[], token: string, fullName: string,
  ): Promise<IntegrationCheckResult[]> {
    const results: IntegrationCheckResult[] = [];
    for (const check of failed.slice(0, FAILED_CHECKS_KEPT)) {
      const log = check.actionsJobId !== null
        ? await this.github.actionsJobLog(token, fullName, check.actionsJobId).catch((error) => {
          this.logger.warn(`log of check "${check.name}" on pull request #${row.number} not read: ${describe(error)}`);
          return null;
        })
        : null;
      results.push(githubCheckResult({
        name: check.name, url: check.url, conclusion: check.conclusion, log, summary: check.summary,
        pullRequest: { number: reading.number, url: reading.url }, headSha: reading.headSha,
      }));
    }
    return results;
  }

  /**
   * J-T16, J-T17, J-T19 and J-T20 (§4.2, §4.5): what GitHub said ends the attempt waiting on this pull request — a
   * job through the result transaction every landing ends in, a session's Merge through its own (§4.6). A pull
   * request nobody waits on any more is only marked closed when GitHub closed it.
   */
  private async fail(row: GithubPullRequest, reading: GithubPullRequestReading, failure: PullRequestFailure): Promise<void> {
    if (row.landingId) {
      const ended = await this.failJob(row, reading, failure);
      if (ended) return;
    } else if (row.sessionId) {
      const ended = await this.failSessionMerge(row, reading, failure);
      if (ended) return;
    }
    if (failure.kind === 'CLOSED') {
      await this.prisma.githubPullRequest.updateMany({
        where: { id: row.id, state: 'OPEN' },
        data: { state: 'CLOSED', closedBy: reading.closedBy, closedAt: this.now(), condition: null },
      });
    }
  }

  /** The job waiting on this pull request ends as GitHub's answer says, and its aftermath follows. False: none waits. */
  private async failJob(row: GithubPullRequest, reading: GithubPullRequestReading, failure: PullRequestFailure): Promise<boolean> {
    const job = await this.prisma.projectIntegrationJob.findFirst({
      where: { pullRequestId: row.id, state: 'PULL_REQUEST', ownerId: row.ownerId },
      select: {
        id: true, claimGeneration: true, sourceSha: true, targetShaBefore: true, upstreamSha: true, mainSyncSha: true,
        testedSha: true, testedTreeSha: true, aheadOfUpstream: true, checks: true,
      },
    });
    if (!job) return false;
    const pullRequest = { number: reading.number, url: reading.url };
    const ran = (Array.isArray(job.checks) ? job.checks : []) as unknown as IntegrationCheckResult[];
    const body: IntegrationJobResultRequest = {
      claimGeneration: job.claimGeneration.toString(),
      leaseOwner: '',
      state: failure.kind === 'CHECK_FAILED' ? 'CHECK_FAILED' : 'ERROR',
      phase: 'PUSH',
      sourceSha: job.sourceSha,
      targetShaBefore: job.targetShaBefore,
      upstreamSha: job.upstreamSha,
      mainSyncSha: job.mainSyncSha,
      testedSha: job.testedSha,
      testedTreeSha: job.testedTreeSha,
      aheadOfUpstream: job.aheadOfUpstream,
      checks: failure.kind === 'CHECK_FAILED' ? [...ran, ...failure.checks] : ran,
      ...jobFailureCode(row, reading, failure, pullRequest),
    };
    try {
      const applied = await applyIntegrationJobResult(
        this.prisma,
        { jobId: job.id, ownerId: row.ownerId, body },
        resultTransactionRetry(this.logger),
        undefined,
        {
          pullRequestId: row.id, number: reading.number, url: reading.url, mergeMethod: null, mergedBy: null,
          ...(failure.kind === 'TARGET_MOVED' ? { catchUp: { counted: failure.counted } } : {}),
          ...(failure.kind === 'CLOSED' ? { closedBy: reading.closedBy } : {}),
        },
      );
      await this.jobEvent(row.id, `pull-request:${failure.kind.toLowerCase()}:${row.headSha}`, pullRequestFailureFact(failure, reading), job.id);
      await deliverIntegrationAftermath({
        prisma: this.prisma,
        logger: this.logger,
        promotions: this.promotions,
        mergeReceipts: this.mergeReceipts,
        openItems: this.openItems,
        push: this.push,
      }, applied.after, applied.answer.openItemId);
    } catch (error) {
      // Another read ended it first (a webhook and the re-read at once): nothing more to do.
      if (error instanceof IntegrationJobRefused && error.refusal === 'STALE_CLAIM') return true;
      throw error;
    }
    this.announce(row);
    return true;
  }

  /**
   * §4.6 step 4 for a session's Merge waiting on this pull request, in one transaction under the session's lock: a
   * required check that failed records `error` naming it, and under D5 (the owner's ruling of 2026-11-23) hands the
   * check's log to the session as a platform turn whose end merges again into the same pull request, at most
   * {@link SESSION_FIX_ROUNDS} times; a moved target queues the merge again; closed and a head Orbit did not push record
   * `error` with the reason. False: the session no longer waits on it.
   */
  private async failSessionMerge(row: GithubPullRequest, reading: GithubPullRequestReading, failure: PullRequestFailure): Promise<boolean> {
    const sessionId = row.sessionId as string;
    const which = `pull request #${reading.number}`;
    const mergeError = failure.kind === 'CHECK_FAILED'
      ? `The required check "${failure.checks[0]?.command ?? 'a check'}" failed on ${which}: ${failure.checks[0]?.github?.url ?? reading.url}`
      : failure.kind === 'CLOSED'
        ? `${reading.closedBy ? `@${reading.closedBy}` : 'Somebody'} closed ${which} without merging it: ${reading.url}`
        : failure.kind === 'HEAD_CHANGED'
          ? `${which} holds ${reading.headSha.slice(0, 7)}, a commit Orbit did not push, so Orbit will not merge it: ${reading.url}`
          : null;
    const ended = await withTransactionRetry(this.prisma, async (tx) => {
      const [session] = await tx.$queryRaw<Array<{ mergeStatus: string | null; mergePullRequestId: string | null }>>(Prisma.sql`
        SELECT "merge_status" AS "mergeStatus", "merge_pull_request_id" AS "mergePullRequestId"
          FROM "session" WHERE "id" = ${sessionId}::uuid AND "owner_id" = ${row.ownerId}::uuid FOR UPDATE`);
      if (!session || session.mergeStatus !== 'pull_request' || session.mergePullRequestId !== row.id) return false;
      if (failure.kind === 'CLOSED') {
        await tx.githubPullRequest.updateMany({
          where: { id: row.id, state: 'OPEN' },
          data: { state: 'CLOSED', closedBy: reading.closedBy, closedAt: this.now(), condition: null },
        });
      }
      if (failure.kind === 'TARGET_MOVED') return true;
      await tx.session.update({ where: { id: sessionId }, data: { mergeStatus: 'error', mergeError } });
      return true;
    }, loggedRetry(this.logger, 'pullRequestDoor.failSessionMerge'));
    if (!ended) return false;
    if (failure.kind === 'TARGET_MOVED') {
      // The merge queued again, into the same landing branch (§4.6 step 4): it rebuilds on the new tip.
      await this.sessions?.mergeAgainForPullRequest(sessionId, row.id, branchOf(row.baseRef));
    } else if (failure.kind === 'CHECK_FAILED') {
      await this.sendSessionFix(row, reading, failure.checks);
    }
    this.announce(row);
    return true;
  }

  /**
   * D5 (§4.6): the failing check's log, handed to the session as one platform turn per head Orbit pushed, keyed
   * `pull-request-fix:v1:<pull request>:<head>`; its end merges again (`mergeAfterTurnAt`, written in the turn's own
   * transaction), so the session's next commit updates the same pull request. At most {@link SESSION_FIX_ROUNDS}.
   */
  private async sendSessionFix(row: GithubPullRequest, reading: GithubPullRequestReading, checks: IntegrationCheckResult[]): Promise<void> {
    if (!this.sessions || !row.headSha) return;
    const sessionId = row.sessionId as string;
    const rounds = await this.prisma.conversationTurn.count({
      where: { sessionId, clientTurnId: { startsWith: pullRequestFixTurnPrefix(row.id) } },
    });
    const key = pullRequestFixTurnId(row.id, row.headSha);
    const sent = await this.prisma.conversationTurn.count({ where: { sessionId, clientTurnId: key } });
    if (sent > 0 || rounds >= SESSION_FIX_ROUNDS) return;
    const session = await this.prisma.session.findUnique({ where: { id: sessionId }, select: { title: true } });
    const content = pullRequestFixMessage({
      title: session?.title ?? null,
      targetBranch: branchOf(row.baseRef),
      pullRequest: { number: reading.number, url: reading.url },
      headSha: row.headSha,
      checks,
      round: rounds + 1,
      rounds: SESSION_FIX_ROUNDS,
    });
    await this.sessions.createTurn(row.ownerId, sessionId, { clientTurnId: key, content, intent: 'NEXT_TURN' }, {
      participateSendTransaction: (tx) => oweMergeAfterFixTurn(tx, sessionId, branchOf(row.baseRef), this.now()),
    }).catch((error) => this.logger.warn(`the failing check of pull request #${reading.number} was not handed to its session: ${describe(error)}`));
  }

  /**
   * §4.5 "Review required" and §11.3: the first read that finds the pull request waiting for a review tells the owner,
   * once per pull request (`review_announced_at`, a compare-and-set), with the link.
   */
  private async announceReview(row: GithubPullRequest, reading: GithubPullRequestReading): Promise<void> {
    const claimed = await this.prisma.githubPullRequest.updateMany({
      where: { id: row.id, state: 'OPEN', reviewAnnouncedAt: null },
      data: { reviewAnnouncedAt: this.now() },
    });
    if (claimed.count !== 1) return;
    await this.jobEvent(row.id, `pull-request:review:${reading.number}`, {
      data: { step: 'WAITING_FOR_REVIEW', number: reading.number, url: reading.url },
      text: `Waiting for review on pull request #${reading.number}`,
    });
    await this.push?.notifyOwner(row.ownerId, {
      title: 'Waiting for review',
      message: `Pull request #${reading.number} is waiting for review`,
      priority: 'normal',
      url: reading.url,
    }).catch((error) => this.logger.warn(`review notice for pull request #${reading.number} not sent: ${describe(error)}`));
    this.announce(row);
  }

  /**
   * §4.1 step 5: open the pull request as the App — or take the one already open for this head, which a process that
   * died after opening it left — and record its number. A row somebody else moved meanwhile is left to them.
   */
  private async open(row: GithubPullRequest, token: string, fullName: string): Promise<GithubPullRequest | null> {
    const head = branchOf(row.headRef);
    const base = branchOf(row.baseRef);
    let pr = (await this.github.openPullRequests(token, fullName, head, base))[0];
    if (!pr) {
      const copy = await this.pullRequestCopy(row, base);
      try {
        pr = await this.github.createPullRequest(token, fullName, { head, base, title: copy.title, body: copy.body });
      } catch (error) {
        // 422: one is already open for this head (a create that raced this one); take it.
        if (!(error instanceof GithubCallError) || error.status !== 422) throw error;
        pr = (await this.github.openPullRequests(token, fullName, head, base))[0];
        if (!pr) throw error;
      }
    }
    const opened = await this.prisma.githubPullRequest.updateMany({
      where: { id: row.id, state: 'OPENING' },
      data: { state: 'OPEN', number: pr.number, url: pr.url },
    });
    if (opened.count !== 1) return null;
    await this.jobEvent(row.id, `pull-request:opened:${pr.number}`, {
      data: { step: 'OPENED', number: pr.number, url: pr.url },
      text: `Opened pull request #${pr.number}`,
    });
    this.announce(row);
    return this.prisma.githubPullRequest.findUnique({ where: { id: row.id } });
  }

  /**
   * §4.1 step 8 and §4.4: merge with `sha` = the commit Orbit pushed, by the method that gives what its direct push
   * would have, or the next the repository allows. Answers true when GitHub merged it, so the caller reads it again and
   * lands it from what GitHub then says.
   */
  private async merge(row: GithubPullRequest, reading: GithubPullRequestReading, token: string, fullName: string): Promise<boolean> {
    const subject = await this.subjectOf(row);
    const refused = new Set<PullRequestMergeMethod>();
    for (let method = mergeMethodFor(subject, reading.allowed, refused); method; method = mergeMethodFor(subject, reading.allowed, refused)) {
      try {
        await this.github.mergePullRequest(token, fullName, row.number as number, { sha: row.headSha as string, method });
        await this.prisma.githubPullRequest.updateMany({ where: { id: row.id, state: 'OPEN' }, data: { mergeMethod: method } });
        return true;
      } catch (error) {
        if (error instanceof GithubCallError && error.status === 405 && mergeMethodRefused(error.githubError)) {
          refused.add(method);
          continue;
        }
        if (error instanceof GithubCallError && error.status === 405 && mergeRefusedForMovedBase(error.githubError)) {
          // J-T17, counted (§4.5): GitHub refused the merge because the base moved since Orbit read it.
          await this.fail(row, reading, { kind: 'TARGET_MOVED', counted: true, condition: 'BEHIND' });
          return false;
        }
        if (error instanceof GithubCallError && (error.status === 405 || error.status === 409)) {
          // 405: GitHub will not merge it yet; 409: the head moved (J-T20, the failure path's). The next read decides.
          this.logger.log(`pull request #${row.number} of ${fullName} not merged yet: ${error.status} ${error.githubError ?? ''}`);
          return false;
        }
        throw error;
      }
    }
    this.logger.warn(`pull request #${row.number} of ${fullName}: the repository allows no merge method Orbit can use`);
    return false;
  }

  /**
   * GitHub says it merged (§4.4 "Checking the result"): the commit it made and that commit's tree are what lands. A
   * job's landing goes through the result transaction (J-T15), a session's Merge through its own (§4.6). The landing
   * branch is deleted after, unless GitHub already did (§4.8).
   */
  private async landed(row: GithubPullRequest, reading: GithubPullRequestReading, token: string, fullName: string): Promise<void> {
    if (!reading.mergeCommitSha || !reading.mergeCommitTreeSha) {
      this.logger.log(`pull request #${row.number} of ${fullName} merged; GitHub has not named its commit yet`);
      return;
    }
    const mergedBy = reading.mergedBy;
    const mergeMethod = row.mergeMethod ?? null;
    if (row.landingId) {
      await this.landJob(row, reading, mergedBy, mergeMethod);
    } else if (row.sessionId) {
      await this.landSessionMerge(row, reading, mergedBy, mergeMethod);
    }
    await this.github.deleteBranch(token, fullName, branchOf(row.headRef))
      .catch((error) => this.logger.warn(`landing branch of pull request #${row.number} not deleted: ${describe(error)}`));
  }

  /** J-T15: the job waiting on this pull request lands, through the result transaction, and its aftermath follows. */
  private async landJob(row: GithubPullRequest, reading: GithubPullRequestReading, mergedBy: string | null, mergeMethod: string | null): Promise<void> {
    const job = await this.prisma.projectIntegrationJob.findFirst({
      where: { pullRequestId: row.id, state: 'PULL_REQUEST', ownerId: row.ownerId },
      select: {
        id: true, claimGeneration: true, sourceSha: true, targetShaBefore: true, upstreamSha: true, mainSyncSha: true,
        testedSha: true, testedTreeSha: true, aheadOfUpstream: true, checks: true,
      },
    });
    if (!job) {
      // Nobody waits on it any more (a stop, a later generation): the pull request is merged all the same.
      await this.prisma.githubPullRequest.updateMany({
        where: { id: row.id, state: 'OPEN' },
        data: { state: 'MERGED', mergedSha: reading.mergeCommitSha, mergedBy, mergedAt: this.now(), observedAt: this.now() },
      });
      return;
    }
    const body: IntegrationJobResultRequest = {
      claimGeneration: job.claimGeneration.toString(),
      leaseOwner: '',
      state: 'LANDED',
      phase: 'VERIFY',
      sourceSha: job.sourceSha,
      targetShaBefore: job.targetShaBefore,
      upstreamSha: job.upstreamSha,
      mainSyncSha: job.mainSyncSha,
      testedSha: job.testedSha,
      testedTreeSha: job.testedTreeSha,
      landedSha: reading.mergeCommitSha,
      landedTreeSha: reading.mergeCommitTreeSha,
      aheadOfUpstream: job.aheadOfUpstream,
      checks: (Array.isArray(job.checks) ? job.checks : []) as unknown as IntegrationCheckResult[],
    };
    const applied = await applyIntegrationJobResult(
      this.prisma,
      { jobId: job.id, ownerId: row.ownerId, body },
      // The result transaction's own retry: J-T15 is one more door of it, under the same operation name.
      resultTransactionRetry(this.logger),
      undefined,
      { pullRequestId: row.id, number: row.number as number, url: row.url as string, mergeMethod, mergedBy },
    );
    await deliverIntegrationAftermath({
      prisma: this.prisma,
      logger: this.logger,
      promotions: this.promotions,
      mergeReceipts: this.mergeReceipts,
      openItems: this.openItems,
      push: this.push,
    }, applied.after, applied.answer.openItemId);
    this.announce(row);
  }

  /**
   * §4.6 step 4, merged: the session's Merge waiting on this pull request records `merged` and a MERGED receipt the
   * server writes from GitHub's answer, whose `target_sha_after` is GitHub's commit, in one transaction with the pull
   * request row. A session that has moved on (a new Merge in flight) keeps its operation; the row is merged either way.
   */
  private async landSessionMerge(row: GithubPullRequest, reading: GithubPullRequestReading, mergedBy: string | null, mergeMethod: string | null): Promise<void> {
    const mergedSha = reading.mergeCommitSha as string;
    const landed = new Map<string, { projectId: string | null; taskId: string | null; sourceSha: string; targetBranch: string; ownerItemIds: string[] }>();
    await withTransactionRetry(this.prisma, async (tx) => {
      landed.clear();
      const [session] = await tx.$queryRaw<Array<{
        id: string; ownerId: string; taskId: string | null; branch: string | null; mergeStatus: string | null;
        mergePullRequestId: string | null; mergeOperationId: string | null; mergeRequestedBy: string | null;
        mergeCheckpointId: string | null;
      }>>(Prisma.sql`
        SELECT "id", "owner_id" AS "ownerId", "task_id" AS "taskId", "branch", "merge_status" AS "mergeStatus",
               "merge_pull_request_id" AS "mergePullRequestId", "merge_operation_id" AS "mergeOperationId",
               "merge_requested_by" AS "mergeRequestedBy", "merge_checkpoint_id" AS "mergeCheckpointId"
          FROM "session"
         WHERE "id" = ${row.sessionId}::uuid AND "owner_id" = ${row.ownerId}::uuid
         FOR UPDATE`);
      const marked = await tx.githubPullRequest.updateMany({
        where: { id: row.id, state: 'OPEN' },
        data: { state: 'MERGED', mergedSha, mergedBy, mergeMethod, mergedAt: this.now(), observedAt: this.now(), condition: null },
      });
      if (marked.count !== 1 || !session || session.mergeStatus !== 'pull_request' || session.mergePullRequestId !== row.id) return;
      await tx.session.update({
        where: { id: session.id },
        data: {
          mergeStatus: 'merged',
          mergeError: null,
          mergedAt: this.now(),
          branchMerged: true,
          mergedSourceSha: row.sourceSha,
          baseSha: mergedSha,
          mergeRecovery: Prisma.DbNull,
          mergeRecoveryAction: null,
        },
      });
      const sourceSha = row.sourceSha;
      const sourceBranch = (session.branch ?? '').trim();
      const targetBranch = branchOf(row.baseRef);
      if (!sourceSha || sourceBranch === '') return;
      const task = session.taskId
        ? await tx.task.findUnique({ where: { id: session.taskId }, select: { projectId: true } })
        : null;
      const written = await MergeReceiptService.fromRunnerMergeResult(tx, {
        ownerId: session.ownerId,
        sessionId: session.id,
        taskId: session.taskId,
        projectId: task?.projectId ?? null,
        result: 'MERGED',
        sourceBranch,
        sourceSha,
        targetBranch,
        targetShaBefore: row.baseSha,
        targetShaAfter: mergedSha,
        rebaseBaseSha: row.baseSha,
        conflicts: [],
        message: null,
        operationId: session.mergeOperationId,
        requestedBy: session.mergeRequestedBy === 'USER' || session.mergeRequestedBy === 'AGENT' ? session.mergeRequestedBy : null,
        checkpointId: session.mergeCheckpointId
          ?? (await checkpointIdForCommit(tx, { ownerId: session.ownerId, taskId: session.taskId, commitSha: sourceSha })),
        pullRequest: { number: row.number as number, url: row.url as string, mergeMethod, mergedBy },
      });
      landed.set(session.id, {
        projectId: task?.projectId ?? null, taskId: session.taskId, sourceSha, targetBranch, ownerItemIds: written.ownerItemIds,
      });
    }, loggedRetry(this.logger, 'pullRequestDoor.landSessionMerge'));
    // The receipt writer's own post-commit edges, as the runner's merge result takes them.
    for (const [sessionId, merge] of landed) {
      if (merge.projectId) {
        await this.mergeReceipts?.deliverProjectFactsAfterCommit(merge.projectId, merge.taskId, { ownerItemIds: merge.ownerItemIds })
          .catch((error) => this.logger.warn(`landing facts not delivered: ${describe(error)}`));
        if (merge.taskId) {
          await settleTaskSegmentAfterReceipt(this.prisma, { projectId: merge.projectId, taskId: merge.taskId, result: 'MERGED' })
            .catch((error) => this.logger.warn(`landing settlement after a pull request merge failed: ${describe(error)}`));
        }
      }
      await followWikiDocsAfterSessionMerge(this.prisma, { sessionId, sourceSha: merge.sourceSha, targetBranch: merge.targetBranch });
      this.realtime?.publishSessionUpdated(sessionId);
    }
  }

  /** The server's token for this pull request's repository (§12), minted once and used until near its expiry. */
  private async token(app: GithubAppCredentials, row: Pick<GithubPullRequest, 'installationId' | 'githubRepoId'>): Promise<string> {
    const key = `${row.installationId}:${row.githubRepoId}`;
    const held = this.tokens.get(key);
    if (held && held.expiresAt.getTime() - TOKEN_REUSE_MARGIN_MS > this.now().getTime()) return held.token;
    const grant = await this.grants.grant(row.installationId.toString());
    const minted = await this.github.pullRequestToken({
      appId: app.appId, privateKey: app.privateKey,
      installationId: row.installationId.toString(), repoId: row.githubRepoId.toString(),
      // Asked for only where it was granted: GitHub refuses a token that asks for more than the installation gave.
      workflows: grant?.permissions.workflows === 'write',
    });
    this.tokens.set(key, minted);
    return minted.token;
  }

  /** The repository's name now, read by its id: a rename or a transfer keeps landing in the same repository. */
  private async repositoryName(token: string, repoId: string): Promise<string> {
    const held = this.names.get(repoId);
    if (held && this.now().getTime() - held.at < REPOSITORY_NAME_TTL_MS) return held.fullName;
    const repo = await this.github.repositoryById(token, repoId);
    this.names.set(repoId, { at: this.now().getTime(), fullName: repo.fullName });
    return repo.fullName;
  }

  /** Whether a landing waits on this pull request now: its job, or its session's Merge. */
  private async waitedOn(row: GithubPullRequest): Promise<boolean> {
    if (row.sessionId) {
      return (await this.prisma.session.count({
        where: { id: row.sessionId, mergeStatus: 'pull_request', mergePullRequestId: row.id },
      })) > 0;
    }
    return (await this.prisma.projectIntegrationJob.count({ where: { pullRequestId: row.id, state: 'PULL_REQUEST' } })) > 0;
  }

  /** What the pull request lands, for its merge method (§4.4). */
  private async subjectOf(row: GithubPullRequest): Promise<PullRequestSubject> {
    if (row.sessionId) return 'SESSION';
    const job = await this.prisma.projectIntegrationJob.findFirst({
      where: { pullRequestId: row.id },
      orderBy: { createdAt: 'desc' },
      select: { kind: true, promotionId: true },
    });
    if (job?.kind === 'LAND_PROMOTION' && job.promotionId) {
      const promotion = await this.prisma.projectPromotion.findUnique({ where: { id: job.promotionId }, select: { sourceKind: true } });
      if (promotion?.sourceKind === 'PROJECT_BRANCH') return 'PROJECT_BRANCH';
    }
    return 'TASK';
  }

  /**
   * §4.8's title and body: the task's title, `Merge project/<name> into main: <project title>`, or the session's
   * title; a body that links the landing, says what Orbit checked and says the branch is Orbit's. A fallback from
   * Push as me says so and quotes the refusal the landing records (§5.5).
   */
  private async pullRequestCopy(row: GithubPullRequest, base: string): Promise<{ title: string; body: string }> {
    const origin = (process.env.PUBLIC_ORIGIN?.trim() || 'http://localhost:2086').replace(/\/+$/, '');
    const refusal = pushAsMeRefusalCopy(row.refusal, base);
    const because = refusal ? `because Push as me could not push ${base} directly` : `because ${base} requires a pull request`;
    if (row.sessionId) {
      const session = await this.prisma.session.findUnique({ where: { id: row.sessionId }, select: { title: true } });
      const title = clipTitle(session?.title?.trim() || `Merge an Orbit session into ${base}`);
      return {
        title,
        body: [
          `Orbit opened this pull request to land a session's work on ${base}, ${because}.`,
          ...refusal ?? [],
          '',
          `Session: ${origin}/sessions/${uuidToBase62(row.sessionId)}`,
          '',
          "Orbit updates this branch. Make changes on the session's own branch instead.",
        ].join('\n'),
      };
    }
    const job = await this.prisma.projectIntegrationJob.findFirst({
      where: { pullRequestId: row.id },
      orderBy: { createdAt: 'desc' },
      select: {
        kind: true, taskId: true, sessionId: true, projectId: true, sourceRef: true, checks: true, landingId: true, promotionId: true,
      },
    });
    const projectBranch = job?.kind === 'LAND_PROMOTION' && job.sourceRef.startsWith('refs/heads/project/');
    // A promotion's job names no task; a task branch's promotion is still that task's work, named by its session.
    const taskId = job?.taskId ?? (!projectBranch && job?.sessionId
      ? (await this.prisma.session.findUnique({ where: { id: job.sessionId }, select: { taskId: true } }))?.taskId ?? null
      : null);
    const task = taskId ? await this.prisma.task.findFirst({ where: { id: taskId }, select: { title: true } }) : null;
    const project = job ? await this.prisma.project.findFirst({ where: { id: job.projectId }, select: { title: true } }) : null;
    const landing = row.landingId
      ? await this.prisma.projectLanding.findUnique({ where: { id: row.landingId }, select: { sessionId: true } })
      : null;
    const title = clipTitle(projectBranch && job
      ? `Merge ${branchOf(job.sourceRef)} into ${base}: ${project?.title ?? 'an Orbit project'}`
      : task?.title?.trim() || `Land Orbit work on ${base}`);
    // A promotion whose upstream had not moved since its check runs nothing again when it lands (M5): the tree on the
    // landing branch is the one the candidate's check passed on, and its checks are what ran.
    let ran = checksRun(job?.checks);
    if (ran.length === 0 && job?.promotionId) {
      const promotion = await this.prisma.projectPromotion.findUnique({ where: { id: job.promotionId }, select: { checks: true } });
      ran = checksRun(promotion?.checks);
    }
    return {
      title,
      body: [
        `Orbit opened this pull request to land ${task ? `"${task.title}"` : 'this work'} on ${base}, ${because}.`,
        ...refusal ?? [],
        '',
        ran.length > 0
          ? `Before the push Orbit ran ${ran.join(' and ')}, and ${ran.length === 1 ? 'it' : 'they'} passed.`
          : 'Orbit ran no checks of its own before the push.',
        ...(landing ? ['', `Landing: ${origin}/sessions/${uuidToBase62(landing.sessionId)}`] : []),
        '',
        "Orbit updates this branch. Make changes on the task's own branch instead.",
      ].join('\n'),
    };
  }

  /**
   * A line on the landing timeline of the job waiting on this pull request (§2.9 LS2), after the fact committed — or of
   * the job named, which a failure just ended.
   */
  private async jobEvent(pullRequestId: string, key: string, fact: { data: Record<string, unknown>; text: string }, jobId?: string): Promise<void> {
    const job = await this.prisma.projectIntegrationJob.findFirst({
      where: jobId ? { id: jobId, pullRequestId } : { pullRequestId, state: 'PULL_REQUEST' },
      select: { id: true, claimGeneration: true, round: true },
    });
    if (!job) return;
    await recordCommittedIntegrationJobEvent(this.prisma, {
      jobId: job.id, key, kind: 'PULL_REQUEST', claim: job.claimGeneration, round: job.round ?? null,
      actor: { type: 'PLATFORM' }, data: fact.data, text: fact.text,
    }).catch((error) => this.logger.warn(`timeline line for pull request ${pullRequestId} not written: ${describe(error)}`));
  }

  /** The owner's clients read the landing or the session again. */
  private announce(row: Pick<GithubPullRequest, 'sessionId'>): void {
    if (row.sessionId) this.realtime?.publishSessionUpdated(row.sessionId);
  }
}

/**
 * D5's merge after the fix turn (§4.6), written in the turn's own send transaction under the Session lock createTurn
 * holds: the turn and the merge it owes commit together, and `mergeAfterOwnTurn` takes it up when the turn ends.
 */
async function oweMergeAfterFixTurn(tx: Prisma.TransactionClient, sessionId: string, target: string, at: Date): Promise<void> {
  await tx.session.update({ where: { id: sessionId }, data: { mergeAfterTurnAt: at, mergeAfterTurnTarget: target } });
}

/** The error code and detail a job's J-T17, J-T19 or J-T20 is written with; a J-T16 has none. */
function jobFailureCode(
  row: GithubPullRequest, reading: GithubPullRequestReading, failure: PullRequestFailure, pullRequest: { number: number; url: string },
): Pick<IntegrationJobResultRequest, 'errorCode' | 'errorDetail'> {
  switch (failure.kind) {
    case 'CHECK_FAILED':
      return {};
    case 'TARGET_MOVED':
      return {
        errorCode: 'TARGET_MOVED',
        errorDetail: failure.counted
          ? { pullRequest, pullRequestMergeRefused: true, message: `GitHub refused to merge pull request #${pullRequest.number}: ${branchOf(row.baseRef)} moved since Orbit read it.` }
          : { pullRequest, pullRequestCatchUp: true, condition: failure.condition, message: `${branchOf(row.baseRef)} moved since pull request #${pullRequest.number} was built. Orbit is catching up.` },
      };
    case 'CLOSED':
      return {
        errorCode: 'PULL_REQUEST_CLOSED',
        errorDetail: {
          pullRequest, closedBy: reading.closedBy,
          message: `${reading.closedBy ? `@${reading.closedBy}` : 'Somebody'} closed pull request #${pullRequest.number} without merging it.`,
        },
      };
    case 'HEAD_CHANGED':
      return {
        errorCode: 'PULL_REQUEST_HEAD_CHANGED',
        errorDetail: {
          pullRequest, pushedSha: row.headSha, foundSha: reading.headSha,
          message: `Pull request #${pullRequest.number} holds ${reading.headSha.slice(0, 7)}, not the commit Orbit pushed (${(row.headSha ?? '').slice(0, 7)}). Orbit merges only what it checked.`,
        },
      };
  }
}

/** The landing timeline's line about what GitHub said (§2.9). */
function pullRequestFailureFact(failure: PullRequestFailure, reading: GithubPullRequestReading): { data: Record<string, unknown>; text: string } {
  const which = `pull request #${reading.number}`;
  switch (failure.kind) {
    case 'CHECK_FAILED':
      return {
        data: { step: 'CHECK_FAILED', number: reading.number, checks: failure.checks.map((check) => ({ name: check.command, url: check.github?.url ?? null })) },
        text: `Required check "${failure.checks[0]?.command ?? 'a check'}" failed on ${which}`,
      };
    case 'TARGET_MOVED':
      return {
        data: { step: 'TARGET_MOVED', number: reading.number, counted: failure.counted },
        text: failure.counted ? `GitHub refused to merge ${which}: the base moved` : `Catching up: the base moved under ${which}`,
      };
    case 'CLOSED':
      return { data: { step: 'CLOSED', number: reading.number, closedBy: reading.closedBy }, text: `${which} was closed on GitHub` };
    case 'HEAD_CHANGED':
      return { data: { step: 'HEAD_CHANGED', number: reading.number, headSha: reading.headSha }, text: `${which} holds a commit Orbit did not push` };
  }
}

const CHECK_WORDS: Record<string, string> = {
  TASK_ACCEPTANCE: "the task's acceptance command",
  MERGE_CHECK: 'the merge check',
  LANDING_CHECK: 'the landing check',
};

/** The checks a stored `checks` column says ran and passed, in a pull request body's words: skipped ones did not run. */
function checksRun(stored: unknown): string[] {
  const checks = (Array.isArray(stored) ? stored : []) as Array<{ name?: unknown; skipped?: unknown; exitCode?: unknown; expectedExitCode?: unknown }>;
  const names = checks
    .filter((check) => typeof check.name === 'string' && !check.skipped && check.exitCode === check.expectedExitCode)
    .map((check) => CHECK_WORDS[check.name as string] ?? String(check.name));
  return [...new Set(names)];
}

/** The start of the runner's refusal when Orbit, not GitHub, stopped the push as the owner (push_as_me.go). */
const ORBIT_REFUSED_PREFIX = 'Orbit could not use your GitHub account';

/**
 * §5.5 for the pull request's own body: why Push as me did not push the target, in the words the landing records.
 * Fenced, so a name GitHub quotes is not a mention. Null for any other pull request.
 */
function pushAsMeRefusalCopy(stored: unknown, base: string): string[] | null {
  const refusal = stored as { via?: unknown; message?: unknown } | null;
  if (refusal?.via !== 'PUSH_AS_ME' || typeof refusal.message !== 'string') return null;
  const lead = refusal.message.startsWith(ORBIT_REFUSED_PREFIX)
    ? `Orbit did not push ${base} with the owner's account:`
    : `GitHub refused the push to ${base} with the owner's account:`;
  return ['', lead, '', '```text', refusal.message.replaceAll('```', "'''"), '```'];
}

/** `refs/heads/main` → `main`. */
function branchOf(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** GitHub takes titles of 256 characters. */
function clipTitle(title: string): string {
  return title.length > 240 ? `${title.slice(0, 239)}…` : title;
}

/** An error, as a log line may say it: GitHub's status, never what GitHub quoted back. */
function describe(error: unknown): string {
  if (error instanceof GithubCallError) return `GitHub answered ${error.status}`;
  return (error as Error)?.message ?? String(error);
}
