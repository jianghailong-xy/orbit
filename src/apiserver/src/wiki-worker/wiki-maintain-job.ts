import { createHash } from 'node:crypto';
import { HttpException, NotFoundException } from '@nestjs/common';
import {
  WIKI_ANCHOR_RULES,
  WIKI_MAINTAIN_JOB,
  WIKI_MAINTENANCE_JOB,
  WIKI_REPO_OPS,
  WIKI_REVIEW_RULES,
  wikiMaintenanceRunSessions,
  type WikiDossier,
  type WikiRepoOpKind,
  type WikiReviewMode,
} from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { listWikiAnchorsForJob } from '../wiki/wiki-anchors';
import { gatherDocMaterial, storedSessionCondition, type StoredSessionCondition } from '../wiki/wiki-docs-material';
import { wikiDocsAffected } from '../wiki/wiki-docs-affected';
import type { WikiDocs } from '../wiki/wiki-docs';
import { ownerEnvLiterals } from '../wiki/wiki-dossier';
import { encodeCursorToken, type WikiMaintenance } from '../wiki/wiki-maintenance';
import { finishWikiMaintenanceJob } from '../wiki/wiki-maintenance-run';
import { stripNul } from '../runner-api/strip-nul';
import type { WikiPlans } from '../wiki/wiki-plan';
import { WikiRefusalError, type WikiPrincipal, type WikiService } from '../wiki/wiki.service';
import { isWikiJobCancellation, WikiJobContentError, WikiJobInfraError, type WikiJobContext, type WikiJobRunner } from './wiki-job-executor';
import {
  buildWikiMaintainOps,
  mergeWikiMaintainBuilt,
  wikiMaintainBatchSize,
  wikiMaintainBreakerHold,
  wikiMaintainLines,
  wikiMaintainOffTopic,
  wikiMaintainOutcomeAt,
  wikiMaintainParallel,
  wikiMaintainPrompt,
  wikiMaintainRemaining,
  wikiMaintainRetrySuffix,
  wikiMaintainTopicOrder,
  wikiMaintainTopicsOf,
  WIKI_MAINTAIN_SYSTEM_PROMPT,
  type WikiMaintainBatch,
  type WikiMaintainOp,
  type WikiMaintainRepoGate,
  type WikiMaintainTopic,
} from './wiki-maintain';
import {
  assembleWikiMaintainProposal,
  parseWikiMaintainProposal,
  wikiMaintainPlanOf,
  wikiMaintainProposalPaths,
  wikiMaintainProposalPrompt,
  wikiMaintainProposalRedo,
  WIKI_MAINTAIN_PROPOSAL,
  type WikiMaintainPlanRead,
  type WikiMaintainProposalItem,
  type WikiNewDesignDoc,
  type WikiUnplacedEntry,
} from './wiki-maintain-plan';
import { cutRunes, parseWikiImportAnswer, WikiImportRepo, wikiImportIsObject } from './wiki-import-extract';
import { type WikiPlanSnapshotIndex } from './wiki-plan-repo';
import { type WikiAnchorCheckInput, type WikiRepoFileRead } from '@orbit/shared';
import {
  readWikiRepoFiles,
  readWikiRepoReadiness,
  readWikiRepoSnapshot,
  waitForWikiRepoOp,
  wikiRepoStepsCanRun,
  WikiRepoOpRefused,
  WikiRepoOpWaitCancelled,
  WikiRepoOpWaitTimedOut,
  type WikiRepoOps,
  type WikiRepoOpWait,
  type WikiRepoOpWake,
  wikiRepoFileText,
} from './wiki-repo-ops';
import {
  WikiDocsCallFailed,
  WikiDocsWriteRefused,
  runWikiDocsBuild,
  type WikiDocsStoredSection,
  type WikiDocsWriteAnswer,
  type WikiDocsWriteRequest,
} from './wiki-docs-build';
import { WikiDocsSnapshotRepo } from './wiki-docs-build-job';
import { wikiDocCleanPath, wikiDocRepoPieces, type WikiDocShown, type WikiDocPiece, type WikiDocsPlanDoc } from './wiki-docs-writer';
import { verifyWikiOps } from './wiki-verify-job';

/**
 * The `maintain` job (contracts/wiki.contract.json `jobs.kindRuns.maintain`, `maintenance.job.server`;
 * design §5 and §8, P8): a space's Wiki maintenance run, done by the wiki-worker with the deployment's
 * System model in place of a maintenance session's provider, and with the space's runner only for the
 * repository operations it cannot do itself.
 *
 * WHAT IT IS, IN THE RUNNER'S OWN ORDER (`src/runner-go/wiki_maintain.go`, which does this until P10). It
 * reads where the run starts and the space's snapshot of origin/main (one `wiki_repo_op`), reads the
 * dossiers since the cursor up to the position the run expects, asks the model about each one — one request
 * per dossier through the queue, four in flight at most — checks every entry against its dossier and the
 * snapshot, asks once more with the reasons the first answer was refused, proposes the ones that hold up by
 * topic in batches of thirty with a dry run first and the run's circuit breaker holding back what does not
 * fit, moves the cursor past the sessions whose ops it recorded, verifies its own ops twice and then adopts
 * what ended sessions left waiting, re-checks the anchors through the runner, and writes again only the
 * sections of the confirmed plan's documents that its facts and origin/main touched. It writes its report
 * with the token spend, ends the run, and asks the one entry the owner's decision of 2026-10-08 names for
 * the articles a successful run owes (`queueWikiArticlesAfterRun`).
 *
 * A SPACE THAT IS BEHIND WRITES NO DOCUMENT: a run made while the space was catching up skips the documents
 * and the plan proposal whole, as the runner's does.
 *
 * HOW IT FAILS (§5.5). A failure of the platform — the runner away, a read or a request past its limit, the
 * worker stopping — is thrown as infra: the job is tried again on the backoff and NOTHING is counted against
 * the space's streak. A failure of the work — the model's answers, the server's refusals — ends the run
 * through the finish route, which counts it, so three in a row tell the owner, and the job fails as content.
 * Every call is a breakpoint: the pair `(step, unit)` is a request's identity, so a replayed job reuses the
 * answers it already has.
 *
 * WHAT IT DOES NOT DO. It asks no provider: the System model's address and key live in this process, and
 * nothing about a space's pinned provider is read. It makes no task and starts no session.
 */

/** What the job needs besides its context. */
export interface WikiMaintainJobDeps {
  prisma: PrismaService;
  wiki: WikiService;
  maintenance: WikiMaintenance;
  docs: WikiDocs;
  plans: WikiPlans;
  repoOps: WikiRepoOps;
  /** The System model's name, as the report and each write record it. */
  model: string;
  /** The System model's address, for the one reading the run needs of it: whether its endpoint is this machine's. */
  modelBaseUrl: string | null;
  /** How a wait for a repository operation hears it land; without it the wait polls. */
  repoWake?: WikiRepoOpWake;
  /** The specs' handle on how long one repository operation is waited for. */
  repoWaitMs?: number;
}

/** The principal the run writes as: the space's maintenance, with no session and no user (the docs job's own). */
export function wikiMaintainJobPrincipal(ownerId: string, jobId: string): WikiPrincipal {
  return { origin: 'maintenance', ownerId, userId: null, sessionId: null, jobId, toolCallId: null, authorKind: 'system' };
}

/** The runner the worker's module registers for `maintain`. */
export function wikiMaintainJobRunner(deps: WikiMaintainJobDeps): WikiJobRunner {
  return (context) => runWikiMaintainJob(context, deps) as unknown as Promise<Record<string, unknown>>;
}

// ── What a run reports (contract `maintenance.job.report`) ──────────────────────────────────────

export interface WikiMaintainReport {
  stoppedAt?: string;
  sessions: number;
  dossiers: number;
  unchanged: number;
  offTopic: number;
  entries: { extracted: number; kept: number; dropped: number; foreign: number; principles: number };
  ops: {
    proposed: number;
    recorded: number;
    refused: number;
    selfCheckDropped: number;
    heldBack: number;
    heldBackByBreaker: number;
    applied: number;
    waiting: number;
  };
  verification?: {
    verified: number;
    failed: number;
    waitingForNextRun: number;
    adopted?: { ops: number; verified: number; failed: number };
  };
  anchors?: { entries: number; changed: number; missing: number };
  docs?: WikiMaintainDocsReport;
  tokens: { input: number; output: number; calls: number };
  seconds: number;
  cursorAdvanced?: boolean;
}

/** What the documents step reports (contract `maintenance.job.docs.report`). */
export interface WikiMaintainDocsReport {
  planVersion: number | null;
  skipped?: string;
  repoSha?: string;
  affected: { byEntries: number; byRepo: number; stale: number; unwritten: number; total: number };
  withdrawn: { paths: number; sentences: number };
  sections: { written: number; unchanged: number; failed: number };
  unplaced: { designDocs: number; entries: number };
  proposal: {
    outcome: string;
    id?: string;
    doc?: string;
    newDoc?: boolean;
    facts?: number;
    rounds?: number;
    error?: string;
    reason?: string;
  } | null;
  tokens: { input: number; output: number; calls: number };
  seconds: number;
  error?: string;
}

/** The run's context: what the runner's context route answers, read from the space and the run row. */
interface WikiMaintainContext {
  title: string;
  repo: { urlNorm: string; rootCommitSha: string };
  reviewMode: WikiReviewMode;
  activeEntries: number;
  breaker: { minActiveEntries: number; maxChangedPercent: number };
  workspaceId: string | null;
  topics: WikiMaintainTopic[];
  expect: string;
  runSessions: number;
  catchUp: string | null;
}

/** One page the run read, as the server's tokens name it: where it starts and where it ends. */
interface WikiMaintainPageRead {
  from: string;
  cursor: string;
}

/** The repository at one commit, as this run reads it. */
interface WikiMaintainSnapshot {
  sha: string;
  index: WikiPlanSnapshotIndex & { readme?: string; commits?: string[] | null };
  files: string[];
  sizes: Map<string, number>;
  about: string;
  anchors: WikiImportRepo;
}

/** Why a run ends before it succeeded: the step, and what went wrong there. */
class WikiMaintainStop extends Error {
  constructor(readonly step: string, readonly cause: Error, readonly kind: 'infra' | 'content') {
    super(`${step}: ${cause.message}`);
    this.name = 'WikiMaintainStop';
  }
}

/** Run one `maintain` job: its run row, the whole pipeline, and what its end leaves. */
export async function runWikiMaintainJob(context: WikiJobContext, deps: WikiMaintainJobDeps): Promise<Record<string, unknown>> {
  const runId = readRunId(context.job.input);
  return new WikiMaintainRun(context, deps, runId).execute();
}

/** The job's input as its row holds it: the run it executes (`maintenance.job.server`). */
function readRunId(input: Record<string, unknown>): string {
  const id = typeof input?.runId === 'string' ? input.runId : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) {
    throw new WikiJobContentError('the job names no maintenance run to execute (input.runId)');
  }
  return id;
}

/**
 * One run's state: where it reports, what it read, and what it has spent. The pipeline is the runner's
 * (`wikiMaintainRun` in Go), step for step; what changes is who asks the model and where the repository is.
 */
class WikiMaintainRun {
  private readonly report: WikiMaintainReport = {
    sessions: 0,
    dossiers: 0,
    unchanged: 0,
    offTopic: 0,
    entries: { extracted: 0, kept: 0, dropped: 0, foreign: 0, principles: 0 },
    ops: { proposed: 0, recorded: 0, refused: 0, selfCheckDropped: 0, heldBack: 0, heldBackByBreaker: 0, applied: 0, waiting: 0 },
    tokens: { input: 0, output: 0, calls: 0 },
    seconds: 0,
  };
  private readonly refused: string[] = [];
  private readonly started = Date.now();
  private context!: WikiMaintainContext;
  private plan: WikiMaintainPlanRead | null = null;
  private snapshot: WikiMaintainSnapshot | null = null;
  private cursor = '';
  private readonly pages: WikiMaintainPageRead[] = [];
  private readonly pageOf = new Map<string, number>();
  private breakerRead: { remaining: number | null } | null = null;
  private advanced = false;
  private position = '';
  /** Whether the space's runner reads whole files; a bounded one is asked with the old limits. */
  private wholeFile = false;

  constructor(
    private readonly jobContext: WikiJobContext,
    private readonly deps: WikiMaintainJobDeps,
    private readonly runId: string,
  ) {}

  /** The whole run: whatever ends it, the server hears how it ended — unless it is the platform's failure. */
  async execute(): Promise<Record<string, unknown>> {
    const { prisma } = this.deps;
    const { job } = this.jobContext;
    const row = await prisma.wikiMaintenanceRun.findFirst({
      where: { id: this.runId, ownerId: job.ownerId, spaceId: job.spaceId, jobId: job.id },
      select: { id: true, startedAt: true, due: true, catchUp: true, expectAt: true, expectKind: true, expectRef: true },
    });
    if (!row) throw new WikiJobContentError(`no maintenance run of this space is made by this job (run ${this.runId})`);
    // The run started: the first start is kept, the latest attempt is written, and what the attempt before
    // said of its end is cleared — the row says how its latest attempt ended.
    await prisma.wikiMaintenanceRun.updateMany({
      where: { id: row.id },
      data: {
        startedAt: row.startedAt ?? new Date(),
        lastStartedAt: new Date(),
        attempts: { increment: 1 },
        outcome: null,
        endedAt: null,
        error: null,
        failureKind: null,
        opsRefused: null,
        // Whether the run's endpoint is this machine's or a private one, which the day's counting reads
        // (`maintenance.job.catchUp.dailyLimit`): the System model's address, known only here.
        localEndpoint: this.deps.modelBaseUrl !== null && wikiMaintainEndpointIsLocal(this.deps.modelBaseUrl),
      },
    });

    let stop: WikiMaintainStop | null;
    try {
      await this.readContext(row.expectAt, row.expectKind, row.expectRef, row.catchUp);
      stop = await this.steps();
    } catch (error) {
      // The worker is stopping: the job is not the run's to end here. Its lease is let out to now by the
      // executor and the next process starts the run again, and nothing is counted against the space.
      if (isWikiJobCancellation(error, this.jobContext.signal)) throw error;
      stop = asStop(error);
    }
    this.report.seconds = Math.trunc((Date.now() - this.started) / 1000);
    if (stop !== null) this.report.stoppedAt = stop.step;

    if (stop !== null && stop.kind === 'infra') {
      // The platform's failure (§5.5): the job is tried again on the backoff, and nothing is counted
      // against the space's streak. The run row stays open, and the next attempt starts it again.
      this.jobContext.log(`stopped at ${stop.step} (infra): ${stop.cause.message}`);
      throw new WikiJobInfraError(stop.message);
    }
    // The run's report and error can quote what the model wrote: without any U+0000 (contract `jobs.serverWrites`).
    const answer = await finishWikiMaintenanceJob(this.deps.prisma, this.deps.maintenance, job.ownerId, job.spaceId, job.id, {
      to: stop === null ? this.cursor : null,
      outcome: stop === null ? 'succeeded' : 'failed',
      error: stop === null ? null : stripNul(cutRunes(stop.message, 2000)),
      failureKind: stop === null ? null : stop.kind,
      report: stripNul(this.report as unknown as Record<string, unknown>),
    });
    if (stop === null) {
      this.jobContext.log(`every step succeeded: the cursor is at ${answer.state.position ?? '(unmoved)'}`);
      return {
        kind: 'maintain',
        runId: this.runId,
        outcome: 'succeeded',
        advanced: answer.advanced || this.advanced,
        cursor: answer.state.position ?? this.position,
        refused: this.refused,
        report: this.report,
      };
    }
    this.jobContext.log(`stopped at ${stop.step} (${stop.kind}): ${stop.cause.message}`);
    throw new WikiJobContentError(stop.message, {
      kind: 'maintain',
      runId: this.runId,
      outcome: 'failed',
      failureKind: stop.kind,
      cursorAdvanced: this.report.cursorAdvanced === true,
      report: this.report,
    } as unknown as Record<string, unknown>);
  }

  /**
   * The pipeline in order (`wikiMaintainRun.steps`), answering where it stopped, or null.
   *
   * The repository step is this pipeline's `checkout` and more: a snapshot of origin/main through the
   * space's runner names the commit, lists every file with its size, and carries the reachable commits the
   * checks below read, and a file a check reads is read whole at that commit — where the runner fetched a
   * checkout and read it.
   */
  private async steps(): Promise<WikiMaintainStop | null> {
    let step = 'repo';
    try {
      await this.readSnapshot();
      step = 'dossiers';
      const dossiers = await this.dossiers();
      let ops: WikiMaintainOp[] = [];
      if (dossiers.length > 0) {
        step = 'extract';
        ops = await this.extractAll(dossiers);
      }
      step = 'self-check';
      let batches = await this.selfCheck(ops);
      step = 'breaker';
      batches = this.breaker(batches);
      step = 'propose';
      await this.propose(batches);
      step = 'advance';
      await this.advance();
      step = 'verify';
      await this.verify();
      step = 'anchors';
      await this.anchors();
      step = 'docs';
      await this.docs();
      return null;
    } catch (error) {
      if (isWikiJobCancellation(error, this.jobContext.signal)) throw error;
      return asStop(error, step);
    }
  }

  // ── The context and the snapshot ──────────────────────────────────────────────────────────────

  /** Where the run starts: the space, its mode and numbers, its topics, and the position its task expects. */
  private async readContext(expectAt: Date | null, expectKind: string | null, expectRef: string | null, catchUp: string | null): Promise<void> {
    const { prisma } = this.deps;
    const { job } = this.jobContext;
    const space = await prisma.wikiSpace.findFirst({
      where: { id: job.spaceId, ownerId: job.ownerId },
      select: { id: true, title: true, repoUrlNorm: true, rootCommitSha: true, settings: true },
    });
    if (!space) throw new WikiJobContentError('the space this run maintains is gone');
    const settings = space.settings as Record<string, unknown> | null;
    const maintenance = (settings?.maintenance ?? {}) as { workspaceId?: string | null };
    const reviewMode = ((settings?.reviewMode as WikiReviewMode | undefined) ?? 'tiered');
    const activeEntries = await prisma.wikiEntry.count({ where: { ownerId: job.ownerId, spaceId: job.spaceId, status: 'active' } });
    const pendingInSpace = reviewMode === 'manual'
      ? await prisma.wikiChangesetOp.count({ where: { ownerId: job.ownerId, decision: 'pending', spotCheck: false, changeset: { spaceId: job.spaceId } } })
      : 0;
    const topics = await prisma.wikiTopic.findMany({
      where: { ownerId: job.ownerId, spaceId: job.spaceId },
      orderBy: { createdAt: 'asc' },
      select: { slug: true, title: true, description: true },
    });
    this.context = {
      title: space.title,
      repo: { urlNorm: space.repoUrlNorm ?? '', rootCommitSha: space.rootCommitSha ?? '' },
      reviewMode,
      activeEntries,
      breaker: { minActiveEntries: WIKI_REVIEW_RULES.breakerMinActiveEntries, maxChangedPercent: WIKI_REVIEW_RULES.breakerMaxChangedPercent },
      workspaceId: maintenance.workspaceId ?? null,
      topics: wikiMaintainTopicsOf(topics),
      expect: expectAt && expectKind && expectRef
        ? (encodeCursorToken(space.id, { at: expectAt, kind: expectKind as never, ref: expectRef }) ?? '')
        : '',
      // The run's own size, as the session's context route answers it: the position a task expects covers it,
      // and a run of a job no task expects anything of reads this many sessions.
      runSessions: wikiMaintenanceRunSessions({ mode: reviewMode, activeEntries, pendingInSpace }),
      catchUp,
    };
  }

  /**
   * The space's repository, at one commit, read through the space's runner: a snapshot operation, then the
   * space's snapshot row back for its index. A runner that cannot be asked is the platform's failure.
   */
  private async readSnapshot(): Promise<void> {
    const { prisma } = this.deps;
    const { job } = this.jobContext;
    const readiness = await readWikiRepoReadiness(prisma, { ownerId: job.ownerId, spaceId: job.spaceId });
    // A machine with only `wiki-repo-op/v1` can be handed operations — it answers the old bounded window
    // (`runner_upgrade` says to upgrade it, and `wholeFile` says which read this run gets) — while one with no
    // repository capability at all cannot, and waiting on it would wait out the whole limit to learn that.
    if (!wikiRepoStepsCanRun(readiness)) {
      throw new WikiJobInfraError(`REPO_NOT_READY: the space's repository cannot be read now (${readiness.look})`);
    }
    // Whether this machine reads whole files (repoOps.cache, 0406): a bounded one is asked with the old limits.
    this.wholeFile = readiness.runner?.wholeFile === true;
    const held = await prisma.wikiRepoSnapshot.findFirst({ where: { spaceId: job.spaceId, ownerId: job.ownerId }, select: { sha: true } });
    const settled = await this.operation('snapshot', { skipSha: held?.sha ?? null }, 'the snapshot of origin/main');
    if (settled.state !== 'succeeded') {
      throw new WikiJobInfraError(`REPO_OP_FAILED: the snapshot of origin/main ${settled.state}: ${settled.error ?? ''}`);
    }
    const sha = String(settled.result?.sha ?? '');
    const snapshot = await readWikiRepoSnapshot(prisma, { ownerId: job.ownerId, spaceId: job.spaceId });
    if (!snapshot || snapshot.sha !== sha) {
      throw new WikiJobInfraError(`REPO_OP_FAILED: the space holds no snapshot of ${sha.slice(0, 12)}, the commit the snapshot named`);
    }
    const raw = JSON.parse(snapshot.index) as WikiPlanSnapshotIndex & { readme?: string; commits?: string[] | null };
    const files = (raw.files ?? []).map((file) => file.path);
    const sizes = new Map((raw.files ?? []).map((file) => [file.path, Number(file.size) || 0]));
    this.snapshot = {
      sha: snapshot.sha,
      index: raw,
      files,
      sizes,
      about: typeof raw.readme === 'string' ? cutRunes(raw.readme, WIKI_MAINTAIN_JOB.aboutMaxChars) : '',
      anchors: new WikiImportRepo({ files, commits: raw.commits ?? [] }, '', repositoryName(this.context.repo.urlNorm)),
    };
    this.jobContext.log(`the repository at ${snapshot.sha.slice(0, 12)} (${files.length} files)`);
  }

  /** One repository operation of the run, waited for holding the job's lease. */
  private async operation(kind: WikiRepoOpKind, input: Record<string, unknown>, what: string): Promise<WikiRepoOpWait> {
    const timeoutMs = this.deps.repoWaitMs ?? WIKI_MAINTAIN_JOB.repoWaitSeconds * 1000;
    const { job } = this.jobContext;
    // A stopping worker asks the runner for nothing more (design §5.4).
    if (this.jobContext.signal.aborted) throw new WikiRepoOpWaitCancelled(null);
    try {
      const { id } = await this.deps.repoOps.enqueueWikiRepoOp({ jobId: job.id, kind, input });
      return await waitForWikiRepoOp(this.deps.prisma, { id, ownerId: job.ownerId, timeoutMs, wake: this.deps.repoWake, signal: this.jobContext.signal });
    } catch (error) {
      if (error instanceof WikiRepoOpWaitTimedOut) {
        throw new WikiJobInfraError(`REPO_OP_WAIT: ${what} did not settle within ${Math.round(timeoutMs / 1000)} s`);
      }
      if (error instanceof WikiRepoOpRefused) throw new WikiJobInfraError(`REPO_OP_REFUSED: ${what}: ${error.message}`);
      throw error;
    }
  }

  // ── The dossiers ──────────────────────────────────────────────────────────────────────────────

  /**
   * The pages from the cursor up to the position the run expects — or, for a run no task expects anything of,
   * as many sessions as the run may cover — and the dossiers not processed yet.
   */
  private async dossiers(): Promise<WikiDossier[]> {
    const out: WikiDossier[] = [];
    let after = '';
    let sessions = 0;
    for (let pages = 0; ; pages += 1) {
      let limit: number = WIKI_MAINTAIN_JOB.pageSessions;
      if (this.context.expect === '') {
        const left = this.context.runSessions - sessions;
        if (left <= 0) break;
        if (left < limit) limit = left;
      }
      const page = await this.dossiersUntil(after, this.context.expect, limit);
      this.cursor = page.cursor;
      this.pages.push({ from: page.from || after, cursor: page.cursor });
      for (const batch of page.batches ?? []) sessions += batch.sessions;
      for (const dossier of page.dossiers) {
        sessions += 1;
        this.pageOf.set(dossier.sessionId, this.pages.length - 1);
        if (dossier.unchanged) {
          this.report.unchanged += 1;
          continue;
        }
        out.push(dossier);
      }
      if (!page.more || (page.cursor === after && pages > 0)) break;
      after = page.cursor;
    }
    this.report.sessions = sessions;
    this.report.dossiers = out.length;
    this.jobContext.log(`read ${sessions} session(s) after the space's cursor: ${out.length} dossier(s) to extract from, `
      + `${this.report.unchanged} already processed`);
    return out;
  }

  /** One page of the space's dossiers, through the server's own reader (the runner door's is the same one). */
  private async dossiersUntil(after: string, until: string, limit: number): Promise<Awaited<ReturnType<WikiMaintenance['dossierPage']>>> {
    const { job } = this.jobContext;
    try {
      return await this.deps.maintenance.dossierPage(job.ownerId, job.spaceId, {
        after: after === '' ? null : after,
        until: until === '' ? null : until,
        limit,
      });
    } catch (error) {
      if (error instanceof WikiRefusalError || error instanceof NotFoundException) {
        throw new WikiJobContentError(`the dossiers could not be read: ${error.message}`);
      }
      throw error;
    }
  }

  // ── Extraction ────────────────────────────────────────────────────────────────────────────────

  /** Ask the model about every dossier, a few at a time, and stop the run at the first failure. */
  private async extractAll(dossiers: readonly WikiDossier[]): Promise<WikiMaintainOp[]> {
    const results = new Array<WikiMaintainOp[]>(dossiers.length).fill([]);
    const failures = new Array<Error | null>(dossiers.length).fill(null);
    const failure = await wikiMaintainParallel(dossiers.length, WIKI_MAINTENANCE_JOB.extractConcurrency, async (i) => {
      try {
        results[i] = await this.extract(dossiers[i]);
      } catch (error) {
        failures[i] = error as Error;
        throw error;
      }
    });
    if (failure !== null) throw failure;
    const ops: WikiMaintainOp[] = [];
    const seen = new Set<string>();
    results.forEach((list, i) => {
      const failed = failures[i];
      if (failed) throw new WikiJobContentError(`the model gave no usable answer for session ${dossiers[i].sessionId}: ${failed.message}`);
      for (const op of list) {
        const key = op.title.toLowerCase();
        if (seen.has(key)) {
          this.report.entries.dropped += 1;
          continue;
        }
        seen.add(key);
        ops.push(op);
      }
    });
    this.report.entries.kept = ops.length;
    this.jobContext.log(`extracted ${ops.length} entr(ies) from ${dossiers.length} dossier(s) (${this.report.offTopic} off topic, `
      + `${this.report.entries.dropped} dropped by the checks, ${this.report.entries.foreign} anchored outside the repository)`);
    return ops;
  }

  /** One dossier: the model's answer, checked, and — when some of it did not hold up — asked for once more. */
  private async extract(dossier: WikiDossier): Promise<WikiMaintainOp[]> {
    const lines = wikiMaintainLines(dossier);
    const prompt = wikiMaintainPrompt(this.context, this.snapshot?.about ?? '', dossier.text);
    const answer = await this.ask(WIKI_MAINTAIN_JOB.steps.extract, dossier.sessionId, WIKI_MAINTAIN_SYSTEM_PROMPT, prompt, WIKI_MAINTAIN_JOB.extractMaxTokens);
    if (wikiMaintainOffTopic(answer.text)) {
      this.report.offTopic += 1;
      this.jobContext.log(`  ${JSON.stringify(cutRunes(dossier.title, 60))}: not about this repository — nothing taken from it`);
      return [];
    }
    const parsedEntries = parseWikiImportAnswer(answer.text);
    const repo: WikiMaintainRepoGate | null = this.snapshot?.anchors ?? null;
    const built = buildWikiMaintainOps(parsedEntries ?? [], dossier, lines, repo, this.context.topics);
    const problems = parsedEntries === null ? ['the answer was not a JSON array of entries'] : built.problems;
    if (parsedEntries === null || built.problems.length > 0) {
      const retry = wikiMaintainRetrySuffix(answer.text, parsedEntries !== null, built);
      try {
        const again = await this.ask(
          WIKI_MAINTAIN_JOB.steps.extract,
          `${dossier.sessionId}#retry`,
          WIKI_MAINTAIN_SYSTEM_PROMPT,
          prompt + retry,
          WIKI_MAINTAIN_JOB.extractMaxTokens,
        );
        const second = parseWikiImportAnswer(again.text);
        if (second !== null) mergeWikiMaintainBuilt(built, buildWikiMaintainOps(second, dossier, lines, repo, this.context.topics));
      } catch (error) {
        if (!(error instanceof WikiJobContentError)) throw error;
      }
    }
    if (built.dropped > 0 || parsedEntries === null) {
      this.jobContext.log(`  ${JSON.stringify(cutRunes(dossier.title, 60))}: ${built.dropped} entr(ies) dropped — ${problems.slice(0, 3).join('; ')}`);
    }
    this.report.entries.extracted += built.extracted;
    this.report.entries.dropped += built.dropped;
    this.report.entries.foreign += built.foreign;
    this.report.entries.principles += built.principles;
    return built.ops.slice(0, WIKI_MAINTENANCE_JOB.entriesPerSessionMax);
  }

  /** One model call through the queue, counted into the run's report. */
  private async ask(step: string, unit: string, system: string, prompt: string, maxTokens: number): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const settled = await this.jobContext.ask(step, unit, { system, prompt, maxTokens });
    const inputTokens = settled.inputTokens ?? 0;
    const outputTokens = settled.outputTokens ?? 0;
    this.report.tokens.input += inputTokens;
    this.report.tokens.output += outputTokens;
    this.report.tokens.calls += 1;
    return { text: settled.answer ?? '', inputTokens, outputTokens };
  }

  // ── The self-check, the breaker and the proposals ──────────────────────────────────────────────

  /**
   * Group the ops by topic into batches and propose each with a dry run: a quote the server does not find is
   * taken off its source and the op checked again, an op still refused is dropped, and one the review queue
   * holds back is left out. One the breaker refuses stays, for the breaker step to hold to what every batch
   * would change together.
   */
  private async selfCheck(ops: readonly WikiMaintainOp[]): Promise<WikiMaintainBatch[]> {
    const size = wikiMaintainBatchSize(this.context.reviewMode);
    const batches: WikiMaintainBatch[] = [];
    for (const topic of wikiMaintainTopicOrder(ops)) {
      const list = ops.filter((op) => op.topic === topic);
      for (let start = 0; start < list.length; start += size) {
        const batch = await this.dryRun(topic, list.slice(start, start + size));
        if (batch.ops.length > 0) batches.push(batch);
      }
    }
    return batches;
  }

  /** Check one batch, twice at most: the second time with the quotes the server did not find taken off. */
  private async dryRun(topic: string, ops: WikiMaintainOp[]): Promise<WikiMaintainBatch> {
    let list = ops;
    for (let round = 0; ; round += 1) {
      const answer = await this.send(topic, list, true);
      this.noteBreaker(answer.breaker);
      const batch: WikiMaintainBatch = { topic, ops: [], changes: [] };
      let stripped = false;
      list.forEach((op, i) => {
        const outcome = wikiMaintainOutcomeAt(answer.ops, i);
        const { status, code, message } = outcome;
        if (status === 'refused' && code === 'WIKI_QUOTA' && message.startsWith('circuit breaker')) {
          batch.ops.push(op);
          batch.changes.push(true);
          return;
        }
        if (status === 'refused' && code === 'WIKI_QUOTE_NOT_FOUND' && round === 0) {
          stripQuotes(op.body);
          stripped = true;
          batch.ops.push(op);
          batch.changes.push(false);
          return;
        }
        if (status === 'refused' && (code === 'WIKI_QUOTA' || code === 'WIKI_REVIEW_QUEUE_FULL')) {
          this.report.ops.heldBack += 1;
          return;
        }
        if (status === 'refused' || status === 'conflict' || status === '') {
          this.report.ops.selfCheckDropped += 1;
          this.jobContext.log(`  dropped by the self-check: ${JSON.stringify(op.title)} (${message || status || 'no answer'})`);
          return;
        }
        batch.ops.push(op);
        batch.changes.push(status === 'applied' || outcome.waitsFor === 'verification');
      });
      if (!stripped || round > 0) return batch;
      list = batch.ops;
    }
  }

  /** Keep what a dry run said of the run's circuit breaker: the least room is the one to hold to. */
  private noteBreaker(reading: { remaining: number | null } | null): void {
    if (!reading) return;
    const held = this.breakerRead;
    if (held === null || (reading.remaining !== null && (held.remaining === null || reading.remaining < held.remaining))) {
      this.breakerRead = reading;
    }
  }

  /**
   * Hold back, before anything is written, what the run may not change: the pages are kept in the order read
   * while what their ops would change fits, and from the first page that does not fit every op is held back
   * and the cursor stops where that page starts.
   */
  private breaker(batches: WikiMaintainBatch[]): WikiMaintainBatch[] {
    const { remaining, bounded } = wikiMaintainRemaining(this.breakerRead, this.context);
    if (!bounded) return batches;
    const held = wikiMaintainBreakerHold(batches, this.pageOf, Math.max(this.pages.length, 1), remaining);
    if (held.stop === null) return batches;
    this.report.ops.heldBackByBreaker += held.heldBack;
    this.cursor = this.pages[held.stop].from;
    this.jobContext.log(`the breaker held back ${held.heldBack} op(s) from page ${held.stop + 1} on, past the ${remaining} entr(ies) the run may `
      + 'still change: the cursor stops where that page starts, and the next run reads its dossiers again');
    return held.batches;
  }

  /** Record each batch as the space's maintenance run; an op refused now, after its dry run, fails the run. */
  private async propose(batches: readonly WikiMaintainBatch[]): Promise<void> {
    for (const batch of batches) {
      const answer = await this.send(batch.topic, batch.ops, false);
      this.report.ops.proposed += batch.ops.length;
      batch.ops.forEach((op, i) => {
        const outcome = wikiMaintainOutcomeAt(answer.ops, i);
        switch (outcome.status) {
          case 'applied':
            this.report.ops.recorded += 1;
            this.report.ops.applied += 1;
            return;
          case 'pending':
            this.report.ops.recorded += 1;
            this.report.ops.waiting += 1;
            return;
          default:
            this.report.ops.refused += 1;
            this.refused.push(`${JSON.stringify(op.title)}: ${`${outcome.code} ${outcome.message}`.trim() || outcome.status}`);
        }
      });
    }
    this.jobContext.log(`proposed ${this.report.ops.proposed} op(s): ${this.report.ops.applied} applied, ${this.report.ops.waiting} waiting, `
      + `${this.report.ops.refused} refused (${this.report.ops.selfCheckDropped} dropped by the self-check, `
      + `${this.report.ops.heldBack} held back by the review queue, ${this.report.ops.heldBackByBreaker} held back by the breaker)`);
    if (this.report.ops.refused > 0) {
      throw new WikiJobContentError(`the server refused ${this.report.ops.refused} op(s) the dry run had passed: ${this.refused.join('; ')}`);
    }
  }

  /** One batch, dry run or not, as the space's maintenance run. */
  private async send(topic: string, ops: readonly WikiMaintainOp[], dryRun: boolean): Promise<{ ops: unknown[]; breaker: { remaining: number | null } | null }> {
    const { job } = this.jobContext;
    const list = ops.map((op) => op.body);
    const sessions = new Set(ops.map((op) => op.session));
    const about = topic !== '' ? topic : 'no topic';
    const rationale = cutRunes(`Wiki maintenance run: ${ops.length} entr(ies) on ${about}, extracted by `
      + `${this.deps.model !== '' ? this.deps.model : 'the System model'} from ${sessions.size} session(s) since the space's cursor.`, 2000);
    const body: Record<string, unknown> = { ops: list, rationale };
    if (dryRun) body.dryRun = true;
    else body.idempotencyKey = `wiki-maintain-${sha256Hex(`${this.runId}\u0000${JSON.stringify(list)}`).slice(0, 32)}`;
    // What the model wrote goes to the shared writer without any U+0000 (contract `jobs.serverWrites`): Postgres keeps
    // none, and a model may copy one out of the code it was shown — the runner gate drops it from a report the same way.
    const answer = await this.deps.wiki.submitChangeset(wikiMaintainJobPrincipal(job.ownerId, job.id), job.spaceId, stripNul(body));
    if (!Array.isArray(answer.ops)) {
      // A request refused whole: the answer carries no op outcomes, and the run stops on it as the runner's.
      const code = typeof answer.code === 'string' ? answer.code : 'WIKI_SCHEMA';
      const message = typeof answer.message === 'string' ? answer.message : 'the server refused the proposal';
      throw new WikiJobContentError(`the server refused the proposal (${code}): ${message}`);
    }
    return {
      ops: answer.ops as unknown[],
      breaker: (answer.breaker as { remaining: number | null } | undefined) ?? null,
    };
  }

  /**
   * Move the cursor past the sessions whose ops were recorded, as soon as every batch is recorded
   * (criterion 3 revision 4): to the last page the run read or, when the breaker held ops back, to where
   * their page starts. Nothing of how the run ends is said here — a step after it that fails still fails the
   * run, and the cursor stays where this put it.
   */
  private async advance(): Promise<void> {
    if (this.cursor === '') return;
    const { job } = this.jobContext;
    try {
      const answer = await this.deps.maintenance.advanceRecorded(job.ownerId, job.spaceId, this.cursor);
      this.advanced = answer.advanced;
      this.position = answer.state.position ?? '';
      this.report.cursorAdvanced = true;
      this.jobContext.log(answer.advanced
        ? `the ops are recorded: the cursor moved past their sessions, to ${answer.state.position ?? this.cursor}`
        : 'the ops are recorded: the cursor already stood past their sessions');
    } catch (error) {
      if (error instanceof WikiRefusalError || error instanceof HttpException) {
        throw new WikiJobContentError(`the cursor could not be moved: ${error.message}`);
      }
      throw error;
    }
  }

  // ── Verification and anchors ──────────────────────────────────────────────────────────────────

  /** Verify the run's own ops in an automatic space, then adopt what ended sessions left waiting. */
  private async verify(): Promise<void> {
    if (this.context.reviewMode !== 'automatic') return;
    if (this.report.ops.recorded > 0) await this.verifyOwn();
    await this.adopt();
  }

  /** Verify the ops this run proposed, in two passes at most; what still has no verdict fails nothing. */
  private async verifyOwn(): Promise<void> {
    const result = { verified: 0, failed: 0, waitingForNextRun: 0 };
    this.report.verification = result;
    let refused: Map<string, string> | null = null;
    for (let pass = 0; pass < 2; pass += 1) {
      const summary = await verifyWikiOps(this.jobContext, this.deps.wiki, this.deps.model, {
        sessionId: null,
        jobId: this.jobContext.job.id,
        refused,
      });
      this.report.tokens.calls += summary.looked;
      this.report.tokens.input += summary.usage.inputTokens;
      this.report.tokens.output += summary.usage.outputTokens;
      result.verified += summary.verified;
      result.failed = summary.failed;
      if (summary.failed === 0 || summary.stopped !== null) break;
      refused = new Map();
      for (const failure of summary.failures) {
        if (failure.refused !== '') refused.set(failure.opId, failure.refused);
      }
    }
    if (result.failed > 0) {
      result.waitingForNextRun += result.failed;
      this.jobContext.log(`${result.failed} op(s) of the run's own got no verdict: not live, and the next run adopts ${result.failed === 1 ? 'it' : 'them'}`);
    }
  }

  /**
   * Verify what ended sessions left waiting for their verification in the space — at most `rules.adoptOpsMax`
   * of them, oldest first, after the run's own. One left without a verdict waits for the next run.
   */
  private async adopt(): Promise<void> {
    const { job } = this.jobContext;
    const summary = await verifyWikiOps(this.jobContext, this.deps.wiki, this.deps.model, {
      sessionId: null,
      jobId: job.id,
      adopt: true,
      max: WIKI_MAINTENANCE_JOB.adoptOpsMax,
    });
    this.report.tokens.calls += summary.looked;
    this.report.tokens.input += summary.usage.inputTokens;
    this.report.tokens.output += summary.usage.outputTokens;
    this.report.verification ??= { verified: 0, failed: 0, waitingForNextRun: 0 };
    this.report.verification.adopted = { ops: summary.looked, verified: summary.verified, failed: summary.failed };
    this.report.verification.waitingForNextRun += summary.failed;
    this.jobContext.log(`adopted ${summary.looked} op(s) ended sessions left waiting for their verification: ${summary.verified} verified, `
      + `${summary.failed} without a verdict, which wait for the next run`);
  }

  /**
   * Re-check the space's anchors (`anchorRules.verify`): a page of the entries that carry one — the most the
   * anchors list names, `listEntriesMax` — the page's checks as one `wiki_repo_op` the space's runner
   * executes, and each entry's result written back through the server's own writer in reports of at most
   * `reportEntriesMax` entries.
   *
   * WHY A PAGE IS THE FULL `listEntriesMax` (2026-10-10, the canary's 30-minute rounds). An operation costs
   * about what its wait costs however few anchors it carries: the runner claims it at its next heartbeat (30 s,
   * so ~15 s on average), fetches origin/main (~4 s), and answers. The checks themselves are cheap — measured
   * on this repository, a path anchor's `cat-file -e` is ~1.4 ms, a commit anchor's `merge-base --is-ancestor`
   * ~1.7 ms, a symbol anchor's `grep` ~35 ms, and a production space carries path and commit anchors and no
   * symbols. At the list's default page of 50 entries, the canary's 7,600-7,700 anchors (some 4,400 entries,
   * ~1.7 anchors an entry) went out as ~88 operations, one at a time, and took about 30 minutes. A page of
   * `listEntriesMax` (200) entries puts the same anchors in ~22 operations: ~250-350 anchors and 20-40 KB of
   * JSON each, a few hundred milliseconds of git, and ~20 s an operation end to end — ~8 minutes a round. Even
   * a page whose every entry carries `limits.listMaxItems` (20) anchors — 4,000 anchors, ~500-800 KB, still far
   * inside `repoOps.operationBytes` — is a few seconds of git, well inside the 300 s the run waits for one
   * operation (`maintenance.job.server.rules.repoWaitSeconds`). Operations are sent one at a time, and stay
   * that way while the runner's own fetch lock is one release away (97b8de07f, runner 0.1.228).
   *
   * The page's anchors reach the runner as ONE flat list, so the index the runner echoes is the
   * anchor's place in THAT list — renumbered here as the list is built — and the checks come back
   * through `slots` to (entry, the anchor's place in its entry). Recording them under the per-entry
   * index instead mapped a page's entries onto each other: every entry took the last entry's verdict
   * for its index, a symbol without a baseline adopted a page-mate's region as its own, and a type
   * that no longer matched was refused and failed the run. Every check the report carries also names
   * its anchor (type, path, symbol, sha), and `recordAnchorChecks` writes it only on that anchor.
   */
  private async anchors(): Promise<void> {
    const { job } = this.jobContext;
    let after: string | null = null;
    let entries = 0;
    let changed = 0;
    let missing = 0;
    let refused = 0;
    let failed = 0;
    for (;;) {
      const page = await listWikiAnchorsForJob(this.deps.prisma, { ownerId: job.ownerId, spaceId: job.spaceId, after, limit: WIKI_ANCHOR_RULES.listEntriesMax });
      if (page.entries.length === 0) break;
      after = page.next;
      const wanted = page.entries.filter((entry) => entry.anchors.length > 0);
      if (wanted.length > 0) {
        // One flat list for the operation: the runner echoes each check's place in this list, so
        // `slots` — not the per-entry index the checks are recorded under — is what maps a check home.
        const slots: Array<{ entry: number; anchor: number }> = [];
        const flat = wanted.flatMap((entry, entryAt) =>
          entry.anchors.map((anchor) => {
            slots.push({ entry: entryAt, anchor: anchor.index });
            return { ...anchor, index: slots.length - 1 };
          }),
        );
        const settled = await this.operation('anchors', { sha: this.snapshot?.sha ?? '', anchors: flat }, 'the anchor checks');
        if (settled.state !== 'succeeded') {
          throw new WikiJobInfraError(`REPO_OP_FAILED: the anchor checks ${settled.state}: ${settled.error ?? ''}`);
        }
        const answer = (settled.result?.anchors ?? {}) as { sha?: string; anchors?: unknown[] };
        const byEntry = wanted.map(() => new Map<number, WikiAnchorCheckInput>());
        let unanswered = 0;
        for (const reported of Array.isArray(answer.anchors) ? answer.anchors : []) {
          // The runner's answer is one check per anchor it was handed, echoing the index and the
          // type. A row that names no anchor this page asked about cannot be laid back at all; a row
          // whose echo or state does not hold up leaves its own slot unfilled, and the shortfall
          // below counts it. Either way the run fails rather than guess which anchor a verdict
          // belongs to.
          if (!wikiImportIsObject(reported) || typeof reported.index !== 'number' || !Number.isInteger(reported.index)
            || reported.index < 0 || reported.index >= slots.length) {
            unanswered += 1;
            continue;
          }
          const slot = slots[reported.index]!;
          const asked = flat[reported.index]!;
          const state = reported.state === 'verified' || reported.state === 'changed' || reported.state === 'missing' ? reported.state : null;
          if (!state || reported.type !== asked.type) continue;
          byEntry[slot.entry]!.set(slot.anchor, {
            index: slot.anchor,
            type: asked.type,
            state,
            ...(asked.type === 'symbol' && state !== 'missing' && typeof reported.regionSha256 === 'string' ? { regionSha256: reported.regionSha256 } : {}),
            ...(asked.type === 'path' || asked.type === 'symbol' ? { path: asked.path } : {}),
            ...(asked.type === 'symbol' ? { symbol: asked.symbol } : {}),
            ...(asked.type === 'commit' ? { sha: asked.sha } : {}),
          });
        }
        unanswered += flat.length - byEntry.reduce((total, checks) => total + checks.size, 0);
        if (unanswered > 0) {
          throw new WikiJobContentError(`the anchor checks answered ${unanswered} of the ${flat.length} anchor(s) asked for: the run refuses to guess whose the rest were`);
        }
        // The page is written back in reports of at most `reportEntriesMax` entries, the most
        // `recordAnchorChecks` takes (`anchorReportShape`) — what one page of the list's default size
        // used to be. Each entry is recorded on its own, so what is written and what is counted below
        // do not depend on where the page's reports fall.
        const ref = String(answer.sha ?? this.snapshot?.sha ?? '');
        const reported = wanted.map((entry, entryAt) => ({
          entryId: entry.entryId,
          revision: entry.revision,
          checks: entry.anchors.flatMap((anchor) => {
            const check = byEntry[entryAt]!.get(anchor.index);
            return check ? [check] : [];
          }),
        }));
        for (let from = 0; from < reported.length; from += WIKI_ANCHOR_RULES.reportEntriesMax) {
          const written = await this.deps.wiki.recordAnchorChecks(
            { ownerId: job.ownerId, sessionId: null, jobId: job.id },
            job.spaceId,
            { ref, entries: reported.slice(from, from + WIKI_ANCHOR_RULES.reportEntriesMax) },
          );
          for (const outcome of written.outcomes) {
            if (outcome.status !== 'recorded') {
              if (outcome.status === 'refused') refused += 1;
              else failed += 1;
              continue;
            }
            entries += 1;
            if (outcome.anchorState === 'changed') changed += 1;
            if (outcome.anchorState === 'missing') missing += 1;
          }
        }
      }
      if (after === null) break;
    }
    this.report.anchors = { entries, changed, missing };
    if (failed > 0 || refused > 0) {
      throw new WikiJobContentError(`git could not check ${failed} anchor(s), and the server refused ${refused} entr(ies)`);
    }
    this.jobContext.log(`re-checked the anchors of ${entries} entr(ies): ${changed} changed, ${missing} missing`);
  }

  // ── The documents ─────────────────────────────────────────────────────────────────────────────

  /** The documents step: never fails the run; what it could not do it reports, and the next run takes it up. */
  private async docs(): Promise<void> {
    const report: WikiMaintainDocsReport = {
      planVersion: null,
      affected: { byEntries: 0, byRepo: 0, stale: 0, unwritten: 0, total: 0 },
      withdrawn: { paths: 0, sentences: 0 },
      sections: { written: 0, unchanged: 0, failed: 0 },
      unplaced: { designDocs: 0, entries: 0 },
      proposal: null,
      tokens: { input: 0, output: 0, calls: 0 },
      seconds: 0,
    };
    this.report.docs = report;
    if (this.context.catchUp !== null) {
      report.skipped = 'catching_up';
      this.jobContext.log('the space is catching up: its oldest fact not taken in is more than a day old, so no document was written and '
        + 'no change to the plan proposed — the first run after it has caught up writes what changed meanwhile');
      return;
    }
    const started = Date.now();
    const before = { ...this.report.tokens };
    try {
      await this.writeDocs(report);
    } catch (error) {
      // The worker stopping is not the documents' failure to report: the run is the next process's to finish.
      if (isWikiJobCancellation(error, this.jobContext.signal)) throw error;
      report.error = cutRunes((error as Error).message, 600);
      this.jobContext.log(`documents: ${(error as Error).message} — the run goes on; the next run takes them up again`);
    }
    report.tokens = {
      input: this.report.tokens.input - before.input,
      output: this.report.tokens.output - before.output,
      calls: this.report.tokens.calls - before.calls,
    };
    report.seconds = Math.trunc((Date.now() - started) / 1000);
  }

  /** What the run writes again, and the one change to the plan it may propose. */
  private async writeDocs(report: WikiMaintainDocsReport): Promise<void> {
    const { prisma } = this.deps;
    const { job } = this.jobContext;
    const affected = await wikiDocsAffected(prisma, job.ownerId, job.spaceId);
    if (!affected.plan) {
      report.skipped = 'no_confirmed_plan';
      this.jobContext.log('no confirmed plan: the space\'s owner has not confirmed a plan, so no document was written — the entries were');
      return;
    }
    report.planVersion = affected.plan.version;
    const planVersion = await this.deps.plans.version(job.ownerId, job.spaceId, affected.plan.version);
    this.plan = wikiMaintainPlanOf(planVersion);
    const head = this.snapshot?.sha ?? '';
    report.repoSha = head;
    const state = await this.deps.docs.writerState(this.jobPrincipal(), job.spaceId);
    const stored = new Map<string, Map<string, WikiDocsStoredSection>>();
    for (const doc of state.docs) {
      stored.set(doc.slug, new Map(doc.sections.map((section) => [section.key, { materialSha256: section.materialSha256, stale: section.stale }])));
    }

    const take = new Map<string, Set<string>>();
    const add = (doc: string, key: string): boolean => {
      const keys = take.get(doc) ?? new Set<string>();
      if (keys.has(key)) return false;
      keys.add(key);
      take.set(doc, keys);
      return true;
    };
    // The server's half: the entries, and what a withdrawn sentence left stale.
    for (const section of affected.sections) {
      add(section.doc, section.key);
      if (section.stale) report.affected.stale += 1;
      else report.affected.byEntries += 1;
    }
    // The repository's half, here: what changed on origin/main under a written section's feet.
    const { changed, gone } = await this.repoAffected(planVersion, state, head);
    for (const ref of changed) add(ref.doc, ref.key);
    report.affected.byRepo = changed.length;
    if (gone.length > 0) {
      try {
        const answer = await this.deps.docs.withdrawPaths(this.jobPrincipal(), job.spaceId, { repoSha: head, paths: gone });
        report.withdrawn.paths = gone.length;
        report.withdrawn.sentences = answer.withdrawn;
        for (const section of answer.sections) {
          if (add(section.doc, section.key)) report.affected.stale += 1;
        }
        this.jobContext.log(`withdrew ${answer.withdrawn} sentence(s) citing ${gone.length} file(s) gone from origin/main`);
      } catch (error) {
        throw new Error(`the withdrawal could not be recorded: ${(error as Error).message}`);
      }
    }
    // A build waiting or running writes what was never written; with none, the run does.
    if (affected.build === null) {
      for (const doc of this.plan.docs) {
        for (const section of doc.sections) {
          if (stored.get(doc.slug)?.has(section.key)) continue;
          if (add(doc.slug, section.key)) report.affected.unwritten += 1;
        }
      }
    }
    for (const keys of take.values()) report.affected.total += keys.size;
    this.jobContext.log(`documents of plan version ${report.planVersion} at origin/main ${head.slice(0, 12)}: `
      + `${report.affected.total} section(s) to write again — ${report.affected.byEntries} by the entries, ${report.affected.byRepo} by the `
      + `repository, ${report.affected.stale} stale, ${report.affected.unwritten} never written`);

    let writeError: Error | null = null;
    if (report.affected.total > 0) {
      const summary = await this.writeSections(planVersion, state, stored, take);
      report.sections = { written: summary.written, unchanged: summary.unchanged, failed: summary.failed };
      if (summary.failed > 0) writeError = new Error(`${summary.failed} section(s) were left unwritten`);
    }
    // What has no place: one proposal at most.
    const cited = new Set<string>();
    for (const doc of this.plan.docs) {
      for (const section of doc.sections) {
        for (const source of section.sources.docs) cited.add(wikiDocCleanPath(source.path));
      }
    }
    for (const path of affected.proposed.paths) cited.add(wikiDocCleanPath(path));
    const designs = await this.newDesignDocs(affected.plan.repoSha ?? '', head, cited);
    report.unplaced = { designDocs: designs.length, entries: affected.unplaced.length + affected.unplacedMore };
    if (designs.length > 0 || affected.unplaced.length > 0) {
      report.proposal = await this.proposePlanChange(designs, affected.unplaced, head);
    }
    if (writeError) throw writeError;
  }

  /** Write the sections the run took up, through the documents' own writer, and say what it did. */
  private async writeSections(
    planVersion: Awaited<ReturnType<PlansVersion>>,
    state: Awaited<ReturnType<WikiDocs['writerState']>>,
    stored: Map<string, Map<string, WikiDocsStoredSection>>,
    only: Map<string, Set<string>>,
  ): Promise<{ written: number; unchanged: number; failed: number }> {
    const { prisma } = this.deps;
    const { job } = this.jobContext;
    const head = this.snapshot!.sha;
    const literals = await ownerEnvLiterals(prisma, job.ownerId);
    const planDocs: WikiDocsPlanDoc[] = planVersion.docs.map((doc) => ({
      slug: doc.slug,
      title: doc.title,
      question: doc.question,
      audience: doc.audience,
      sections: doc.sections.map((section) => ({
        key: section.key,
        title: section.title,
        kind: section.kind,
        covers: section.covers,
        length: section.length,
        sources: {
          docs: (section.sources?.docs ?? []).map((source) => ({ path: source.path, section: source.section ?? null })),
          code: (section.sources?.code ?? []).map((source) => ({ path: source.path, symbols: source.symbols ?? null })),
          contracts: (section.sources?.contracts ?? []).map((source) => ({ path: source.path })),
          sessions: section.sources?.sessions == null ? null : {
            projects: (section.sources.sessions.projects ?? []).map((project) => ({ id: project.id })),
            since: section.sources.sessions.since ?? null,
            until: section.sources.sessions.until ?? null,
            keywords: section.sources.sessions.keywords ?? null,
            anchorPaths: section.sources.sessions.anchorPaths ?? null,
            entryKinds: section.sources.sessions.entryKinds ?? null,
            topics: section.sources.sessions.topics ?? null,
            evidence: section.sources.sessions.evidence ?? '',
          },
        },
      })),
    }));
    // The read names each project { id, title }: the material takes them as ids (`storedSessionCondition`).
    const conditions = new Map<string, StoredSessionCondition | null>();
    for (const doc of planVersion.docs) {
      for (const section of doc.sections) conditions.set(`${doc.slug}#${section.key}`, storedSessionCondition(section.sources?.sessions));
    }
    const repo = this.snapshotRepo(head, this.snapshot!.files, this.snapshot!.sizes);
    const summary = await runWikiDocsBuild({
      repo,
      prepare: (paths) => repo.prepare(paths),
      material: async (doc, key) => {
        const gathered = await gatherDocMaterial(prisma, this.deps.wiki, {
          ownerId: job.ownerId, spaceId: job.spaceId, condition: conditions.get(`${doc.slug}#${key}`) ?? null, literals,
        });
        return { records: gathered.records, unresolved: gathered.unresolved };
      },
      view: async (slug) => {
        try {
          return await this.deps.docs.writerDoc(this.jobPrincipal(), job.spaceId, slug);
        } catch (error) {
          if (error instanceof NotFoundException) return null;
          throw error;
        }
      },
      write: (slug, request) => this.writeDocument(slug, request),
      ask: async (call) => {
        try {
          const settled = await this.ask(call.step, call.unit, call.system, call.prompt, WIKI_MAINTAIN_JOB.extractMaxTokens);
          return { text: settled.text, inputTokens: settled.inputTokens, outputTokens: settled.outputTokens };
        } catch (error) {
          if (error instanceof WikiJobContentError) throw new WikiDocsCallFailed(error.message);
          throw error;
        }
      },
      model: this.deps.model,
      log: (message) => this.jobContext.log(message),
      signal: this.jobContext.signal,
    }, {
      spaceId: job.spaceId,
      planVersion: planVersion.version,
      docs: planDocs,
      stored,
      only,
    });
    this.report.tokens.calls += summary.calls;
    this.report.tokens.input += summary.usage.inputTokens;
    this.report.tokens.output += summary.usage.outputTokens;
    void state;
    return { written: summary.written, unchanged: summary.unchanged, failed: summary.failed };
  }

  /** The snapshot at one commit, as the documents' writer reads it (`WikiDocsSnapshotRepo`). */
  private snapshotRepo(sha: string, files: readonly string[], sizes: ReadonlyMap<string, number>): WikiDocsSnapshotRepo {
    const ordered = [...files].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const map = new Map(sizes);
    return new WikiDocsSnapshotRepo(sha, map, ordered, (paths) => this.readFiles(sha, paths, map));
  }

  /**
   * Files read whole at a commit, through the space's runner, asked again when the read failed — cache first,
   * as the documents' build reads (`readWikiRepoFiles`, repoOps.cache): what the space holds is served as it
   * is, and only the rest becomes one `read` operation, packed by the snapshot's sizes. The worker stopping is
   * no failed read: it is thrown as it is.
   */
  private async readFiles(sha: string, paths: readonly string[], sizes: ReadonlyMap<string, number>): Promise<Map<string, WikiRepoFileRead | null>> {
    const what = `${paths.length === 1 ? paths[0] : `${paths.length} files`} at ${sha.slice(0, 12)}`;
    let last = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await readWikiRepoFiles({
          prisma: this.deps.prisma,
          repoOps: this.deps.repoOps,
          jobId: this.jobContext.job.id,
          ownerId: this.jobContext.job.ownerId,
          spaceId: this.jobContext.job.spaceId,
          sha,
          paths,
          wholeFile: this.wholeFile,
          sizeOf: (path) => sizes.get(path) ?? 0,
          waitMs: this.deps.repoWaitMs ?? WIKI_MAINTAIN_JOB.repoWaitSeconds * 1000,
          wake: this.deps.repoWake,
          signal: this.jobContext.signal,
        });
      } catch (error) {
        // Not asked again and not reworded: the executor hands the job back, nothing counted (design §5.4).
        if (isWikiJobCancellation(error, this.jobContext.signal)) throw error;
        last = (error as Error)?.message ?? String(error);
      }
    }
    throw new WikiJobInfraError(`REPO_OP_FAILED: reading ${what} failed 3 times: ${last}`);
  }

  /** One document's write through the route's own writer; a refusal is the section's, said as the runner said it. */
  private async writeDocument(slug: string, request: WikiDocsWriteRequest): Promise<WikiDocsWriteAnswer> {
    const { job } = this.jobContext;
    try {
      // What the model wrote goes to the shared writer without any U+0000 (contract `jobs.serverWrites`): Postgres keeps
      // none, and a model may copy one out of the code it was shown — the runner gate drops it from a report the same way.
      const answer = await this.deps.docs.write(this.jobPrincipal(), job.spaceId, slug, stripNul(request) as unknown as Record<string, unknown>);
      return { status: answer.status, sections: answer.sections, counts: answer.counts };
    } catch (error) {
      if (error instanceof WikiRefusalError) throw new WikiDocsWriteRefused(refusalText(job.spaceId, error));
      if (error instanceof HttpException) throw new WikiDocsWriteRefused(`the server refused the write (${error.getStatus()}): ${error.message}`);
      throw error;
    }
  }

  /**
   * The written sections whose repository material changed on origin/main since the commit each was generated
   * at, and the files they cite that are gone. Sections are taken by the commit they were written at: one
   * `diff` a commit, its names matched against the paths those sections name; for a section a path of which
   * changed, its pieces are read at both commits and compared.
   */
  private async repoAffected(
    planVersion: Awaited<ReturnType<PlansVersion>>,
    state: Awaited<ReturnType<WikiDocs['writerState']>>,
    head: string,
  ): Promise<{ changed: Array<{ doc: string; key: string }>; gone: Array<{ path: string; change: string; to?: string }> }> {
    const shaOf = new Map<string, Map<string, string>>();
    for (const doc of state.docs) {
      shaOf.set(doc.slug, new Map(doc.sections.map((section) => [section.key, section.repoSha])));
    }
    const bySha = new Map<string, Array<{ doc: string; key: string; section: WikiDocsPlanDoc['sections'][number]; paths: string[] }>>();
    for (const doc of planVersion.docs) {
      for (const section of doc.sections) {
        const sha = shaOf.get(doc.slug)?.get(section.key);
        const paths = sectionPaths(section);
        if (sha === undefined || sha === head || paths.length === 0) continue;
        const list = bySha.get(sha) ?? [];
        list.push({ doc: doc.slug, key: section.key, section, paths });
        bySha.set(sha, list);
      }
    }
    const changed: Array<{ doc: string; key: string }> = [];
    const goneSeen = new Set<string>();
    const gone: Array<{ path: string; change: string; to?: string }> = [];
    for (const sha of [...bySha.keys()].sort()) {
      const sections = bySha.get(sha)!;
      if (!(this.snapshot?.index.commits ?? []).some((commit) => commit.toLowerCase() === sha.toLowerCase())) {
        this.jobContext.log(`the snapshot does not have commit ${sha.slice(0, 12)} some sections were written at: `
          + `${sections.length} section(s) are taken as changed`);
        for (const pending of sections) changed.push({ doc: pending.doc, key: pending.key });
        continue;
      }
      const diff = await this.diffOf(sha, head);
      if (diff.files.length === 0) continue;
      const tree = baseTreeOf(this.snapshot!.files, this.snapshot!.sizes, diff.files);
      const base = this.snapshotRepo(sha, tree.files, tree.sizes);
      const headRepo = this.snapshotRepo(head, this.snapshot!.files, this.snapshot!.sizes);
      for (const pending of sections) {
        let touched = false;
        for (const file of diff.files) {
          if (!pathNamed(file.path, pending.paths)) continue;
          touched = true;
          if ((file.status.startsWith('D') || file.status.startsWith('R')) && !goneSeen.has(file.path)) {
            goneSeen.add(file.path);
            gone.push(file.status.startsWith('R') ? { path: file.path, change: 'renamed', to: file.from ?? '' } : { path: file.path, change: 'deleted' });
          }
        }
        if (!touched) continue;
        await base.prepare(pending.paths);
        await headRepo.prepare(pending.paths);
        const before = wikiDocRepoPieces(base, pending.section as never);
        const after = wikiDocRepoPieces(headRepo, pending.section as never);
        if (!samePieces(before.pieces, after.pieces)) changed.push({ doc: pending.doc, key: pending.key });
      }
    }
    gone.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { changed, gone };
  }

  /** `git diff --name-status -M` between two commits, as the space's runner answers it. */
  private async diffOf(from: string, to: string): Promise<{ files: Array<{ status: string; path: string; from: string | null }>; docs: string[] }> {
    const settled = await this.operation('diff', { from, to }, `the diff ${from.slice(0, 12)}..${to.slice(0, 12)}`);
    if (settled.state !== 'succeeded') {
      throw new WikiJobInfraError(`REPO_OP_FAILED: the diff ${from.slice(0, 12)}..${to.slice(0, 12)} ${settled.state}: ${settled.error ?? ''}`);
    }
    const answer = (settled.result?.diff ?? {}) as { files?: Array<{ status?: string; path?: string; from?: string }>; docs?: string[] };
    return {
      files: (answer.files ?? []).map((file) => ({ status: String(file.status ?? ''), path: String(file.path ?? ''), from: file.from ?? null })),
      docs: answer.docs ?? [],
    };
  }

  /**
   * Every Markdown file under docs/ — outside `docs/mocks` and `docs/evidence` — that origin/main added, or
   * renamed into place, since the commit the plan's references were checked at, that no section cites and no
   * proposal names; each with its title, headings and opening.
   */
  private async newDesignDocs(base: string, head: string, cited: ReadonlySet<string>): Promise<WikiNewDesignDoc[]> {
    if (base === '' || base === head) return [];
    const known = (this.snapshot?.index.commits ?? []).some((commit) => commit.toLowerCase() === base.toLowerCase());
    if (!known) {
      this.jobContext.log(`the snapshot does not have commit ${base.slice(0, 12)} the plan's references were checked at: `
        + 'no design document is taken as new');
      return [];
    }
    const diff = await this.diffOf(base, head);
    const renames = new Map(diff.files.filter((file) => file.status.startsWith('R')).map((file) => [file.path, file.from ?? '']));
    const docs: WikiNewDesignDoc[] = [];
    for (const path of diff.docs) {
      if (!path.toLowerCase().endsWith('.md') || cited.has(path)) continue;
      if (WIKI_MAINTAIN_JOB.docsExcluded.some((dir) => path.startsWith(dir))) continue;
      const content = await this.readWholeFile(head, path);
      if (content === null) continue;
      const outline = wikiDesignOutline(content);
      // The commit that added it is the runner's `git log -1`; the repository operations answer a range's
      // names and not which commit landed one, so the head stands for it, as the runner's fallback does.
      docs.push({ path, renamedFrom: renames.get(path) ?? '', commit: head, title: outline.title, headings: outline.headings, opening: outline.opening });
    }
    docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (docs.length > 0) {
      this.jobContext.log(`new design documents no section of the plan cites: ${docs.map((doc) => doc.path).join(', ')}`);
    }
    return docs;
  }

  /** One file's whole text at a commit, through the space's runner; null when it is not there. */
  private async readWholeFile(sha: string, path: string): Promise<string | null> {
    const texts = await this.readFiles(sha, [path], this.snapshot?.sizes ?? new Map());
    const file = texts.get(path) ?? null;
    if (file === null) return null;
    const text = wikiRepoFileText(file);
    return text === '' && file.state !== 'found' && file.state !== 'cut' ? null : text;
  }

  /** The run's one plan proposal: the model says where the knowledge belongs, the run checks it, the gate decides. */
  private async proposePlanChange(designs: readonly WikiNewDesignDoc[], entries: readonly WikiUnplacedEntry[], head: string): Promise<NonNullable<WikiMaintainDocsReport['proposal']>> {
    const out: NonNullable<WikiMaintainDocsReport['proposal']> = { outcome: 'failed' };
    if (this.plan === null) {
      out.error = 'no confirmed plan';
      return out;
    }
    const items: WikiMaintainProposalItem[] = [];
    for (const design of designs) {
      if (items.length === WIKI_MAINTAIN_PROPOSAL.itemsMax) break;
      items.push({ id: `K${items.length + 1}`, design });
    }
    for (const entry of entries) {
      if (items.length === WIKI_MAINTAIN_PROPOSAL.itemsMax) break;
      items.push({ id: `K${items.length + 1}`, entry });
    }
    // The answer's references are checked in the files at the snapshot's commit, as the runner checks them in its
    // checkout (`wikiDocRepo`), not against the snapshot's index.
    const repo = this.snapshotRepo(head, this.snapshot!.files, this.snapshot!.sizes);
    const prompt = wikiMaintainProposalPrompt(this.plan, items);
    let problems: string[] = [];
    for (let round = 1; round <= WIKI_MAINTAIN_PROPOSAL.roundsMax; round += 1) {
      out.rounds = round;
      let text: string;
      try {
        text = (await this.ask(WIKI_MAINTAIN_JOB.steps.planProposal, `proposal-${round}`, PLAN_SYSTEM_PROMPT,
          problems.length > 0 ? prompt + wikiMaintainProposalRedo(problems) : prompt, WIKI_MAINTAIN_JOB.planMaxTokens)).text;
      } catch (error) {
        if (isWikiJobCancellation(error, this.jobContext.signal)) throw error;
        out.error = cutRunes((error as Error).message, 400);
        return out;
      }
      const answer = parseWikiMaintainProposal(text);
      try {
        await repo.prepare(wikiMaintainProposalPaths(answer));
      } catch (error) {
        if (isWikiJobCancellation(error, this.jobContext.signal)) throw error;
        out.error = cutRunes((error as Error).message, 400);
        return out;
      }
      const { request, problems: check } = assembleWikiMaintainProposal(this.plan, answer, items, repo);
      if (check.length > 0) {
        problems = check;
        this.jobContext.log(`  proposal round ${round}: ${check.length} problem(s) found here: ${cutRunes(check.join('; '), 300)}`);
        continue;
      }
      try {
        const stored = await this.deps.plans.proposeServer(
          { ownerId: this.jobContext.job.ownerId, spaceId: this.jobContext.job.spaceId, wikiJobId: this.jobContext.job.id },
          stripNul(request) as unknown as Record<string, unknown>,
        );
        out.outcome = 'proposed';
        out.id = stored.id;
        out.doc = request.change.doc.slug;
        out.newDoc = answer.newDoc;
        out.facts = request.facts.length;
        out.reason = cutRunes(request.reason, 400);
        this.jobContext.log(`proposed a change to the plan (${stored.id}): ${answer.newDoc ? 'a new document' : 'document'} «${request.change.doc.slug}», from ${request.facts.length} fact(s) — ${cutRunes(request.reason, 200)}`);
        return out;
      } catch (error) {
        const gate = planGateErrors(error);
        if (gate !== null) {
          problems = gate;
          this.jobContext.log(`  proposal round ${round}: the server's gate found ${gate.length} error(s)`);
          continue;
        }
        out.error = cutRunes((error as Error).message, 400);
        return out;
      }
    }
    out.error = cutRunes(`the proposal did not pass in ${WIKI_MAINTAIN_PROPOSAL.roundsMax} rounds: ${problems.join('; ')}`, 600);
    this.jobContext.log(`no proposal: ${out.error}`);
    return out;
  }

  private jobPrincipal(): WikiPrincipal {
    const { job } = this.jobContext;
    return wikiMaintainJobPrincipal(job.ownerId, job.id);
  }
}

/** The plan version's type, as the job reads it. */
type PlansVersion = WikiPlans['version'];

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** The plan job's own system prompt, for the one plan change a maintenance run may propose (contract `plan.jobs`). */
const PLAN_SYSTEM_PROMPT = '你是这个仓库的文档主编。你根据材料规划产品与技术文档。只使用材料里出现的文件路径、'
  + '章节标题、符号、项目名，不编造。用中文写，代码名、路径、命令保留原文。只输出要求的内容。';

/** Take the quotes off an add's sources, and the places they were quoted from. */
function stripQuotes(body: Record<string, unknown>): void {
  const sources = Array.isArray(body.sources) ? body.sources : [];
  for (const item of sources) {
    if (!wikiImportIsObject(item)) continue;
    delete item.quote;
    delete item.locator;
  }
}

/** The paths a plan section's sources name: files, and directories. */
function sectionPaths(section: { sources?: { docs?: Array<{ path: string }> | null; code?: Array<{ path: string }> | null; contracts?: Array<{ path: string }> | null } }): string[] {
  const out: string[] = [];
  for (const source of section.sources?.docs ?? []) out.push(wikiDocCleanPath(source.path));
  for (const source of section.sources?.code ?? []) out.push(wikiDocCleanPath(source.path));
  for (const source of section.sources?.contracts ?? []) out.push(wikiDocCleanPath(source.path));
  return out;
}

/** Whether a changed path is one the section names: the file itself, or a file under a directory it names. */
function pathNamed(changed: string, named: readonly string[]): boolean {
  for (const path of named) {
    if (path === '') continue;
    if (changed === path || changed.startsWith(`${path.replace(/\/+$/u, '')}/`)) return true;
  }
  return false;
}

/**
 * The base commit's file list, as the diff names it: the head's, less what the range added or renamed into
 * place, plus what it deleted or renamed away. The files whose sizes the head does not carry are marked with
 * one byte, which is what lets a read of them answer at all (their content is still whatever git holds).
 */
function baseTreeOf(
  headFiles: readonly string[],
  headSizes: ReadonlyMap<string, number>,
  files: ReadonlyArray<{ status: string; path: string; from: string | null }>,
): { files: string[]; sizes: Map<string, number> } {
  const gone = new Set<string>();
  const back = new Set<string>();
  for (const file of files) {
    if (file.status.startsWith('D')) gone.add(file.path);
    else if (file.status.startsWith('R')) {
      gone.add(file.path);
      if (file.from) back.add(file.from);
    } else if (file.status.startsWith('A') || file.status.startsWith('C')) gone.add(file.path);
  }
  const sizes = new Map<string, number>();
  const list: string[] = [];
  for (const path of headFiles) {
    if (gone.has(path)) continue;
    list.push(path);
    sizes.set(path, headSizes.get(path) ?? 0);
  }
  for (const path of back) {
    if (sizes.has(path)) continue;
    list.push(path);
    sizes.set(path, 1);
  }
  return { files: list, sizes };
}

/** Whether two readings of a section's repository material say the same thing. */
function samePieces(a: readonly WikiDocPiece[], b: readonly WikiDocPiece[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((piece, i) => piece.kind === b[i].kind && piece.path === b[i].path && piece.section === b[i].section
    && piece.symbol === b[i].symbol && piece.text === b[i].text);
}

/** A design document's title (its first heading), its headings to level 3 outside code fences, and its first paragraph that says something. */
export function wikiDesignOutline(content: string): { title: string; headings: string[]; opening: string } {
  let title = '';
  let opening = '';
  const headings: string[] = [];
  let fence = false;
  let paragraph: string[] = [];
  const flush = (): void => {
    const text = paragraph.join(' ').split(/\s+/u).filter((part) => part !== '').join(' ');
    paragraph = [];
    if (opening === '' && [...text].length >= 20 && !text.startsWith('|')) opening = cutRunes(text, 400);
  };
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/u.test(line)) {
      fence = !fence;
      flush();
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,3})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) {
      flush();
      if (title === '') title = heading[2].trim();
      else if (headings.length < 30) headings.push(`${'#'.repeat(heading[1].length)} ${heading[2].trim()}`);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return { title, headings, opening };
}

/** The refusal of a document write, in the runner's words. */
function refusalText(spaceId: string, error: WikiRefusalError): string {
  const { code, message } = error.refusal;
  const errors = (error.refusal as { errors?: Array<{ path: string; message: string }> }).errors ?? [];
  switch (code) {
    case 'WIKI_DOC_INVALID':
      return `the server refused the write (${code}): ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`;
    case 'WIKI_PLAN_STALE':
      return `the plan changed while the documents were written (${code}): nothing more was written, and the next run writes them from the plan in force`;
    case 'WIKI_PLAN_UNCONFIRMED':
      return `space ${spaceId} has no plan its owner confirmed (${code}), so no document is written`;
    default:
      return `${code}: ${message}`;
  }
}

/** The plan gate's errors, when that is why the proposal was refused; null for anything else. */
function planGateErrors(error: unknown): string[] | null {
  if (!(error instanceof WikiRefusalError) || error.refusal.code !== 'WIKI_PLAN_GATE') return null;
  const errors = (error.refusal as { errors?: Array<{ path: string; message: string }> }).errors ?? [];
  return errors.map((one) => `${one.path}: ${one.message}`);
}

/** The repository's name, as a path is read inside a directory named for it (the runner's own reading). */
function repositoryName(urlNorm: string): string {
  const trimmed = urlNorm.replace(/\/+$/u, '');
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return base.endsWith('.git') ? base.slice(0, -4) : base;
}

/** Whether a model endpoint is this machine's or a private network's (contract `maintenance.job.catchUp.localEndpoint`). */
export function wikiMaintainEndpointIsLocal(baseUrl: string): boolean {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (host === 'host.docker.internal') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  return host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan');
}

/** One error as a stop: a WikiJobInfraError is the platform's, everything else the run's. */
function asStop(error: unknown, step = 'context'): WikiMaintainStop {
  if (error instanceof WikiMaintainStop) return error;
  if (error instanceof WikiJobInfraError) return new WikiMaintainStop(step, error, 'infra');
  if (error instanceof WikiJobContentError) return new WikiMaintainStop(step, error, 'content');
  const wrapped = error instanceof Error ? error : new Error(String(error));
  return new WikiMaintainStop(step, wrapped, 'content');
}

/** sha256 in lowercase hex. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
