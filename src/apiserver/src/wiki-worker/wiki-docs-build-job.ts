import { HttpException, NotFoundException } from '@nestjs/common';
import { WIKI_DOCS_BUILD_JOB, WIKI_REPO_OPS, type WikiPlanBuildProgress, type WikiPlanBuildReport } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { wikiDocsBuildJobPrincipal, type WikiDocs } from '../wiki/wiki-docs';
import { gatherDocMaterial, type StoredSessionCondition } from '../wiki/wiki-docs-material';
import { ownerEnvLiterals } from '../wiki/wiki-dossier';
import { finishWikiPlanJob, progressWikiPlanBuildOfJob, type WikiPlanJobEnd } from '../wiki/wiki-plan-job';
import { WikiRefusalError, type WikiService } from '../wiki/wiki.service';
import {
  runWikiDocsBuild,
  WikiDocsCallFailed,
  WikiDocsWriteRefused,
  type WikiDocsBuildSummary,
  type WikiDocsStoredSection,
  type WikiDocsWriteAnswer,
  type WikiDocsWriteRequest,
} from './wiki-docs-build';
import { wikiDocCleanPath, type WikiDocRepo, type WikiDocShown, type WikiDocsPlanDoc } from './wiki-docs-writer';
import { cutRunes } from './wiki-import-extract';
import { WikiJobContentError, WikiJobInfraError, type WikiJobContext, type WikiJobRunner } from './wiki-job-executor';
import { writeWikiJobProgress } from './wiki-jobs';
import {
  readWikiRepoReadiness,
  readWikiRepoSnapshot,
  waitForWikiRepoOp,
  WikiRepoOpRefused,
  WikiRepoOpWaitTimedOut,
  type WikiRepoOps,
  type WikiRepoOpWait,
  type WikiRepoOpWake,
} from './wiki-repo-ops';

/**
 * The `docs_build` job (contracts/wiki.contract.json `docs.build.server`, `jobs.kindRuns.docs_build`; design §8,
 * P7): what a build job's session did with `orbit wiki docs build`, done by the wiki-worker with the System model.
 *
 * MADE BY THE OWNER'S CONFIRMATION. For an account the executor switch gives the server, the build a confirmed
 * version asks for is made as this job rather than as a task of the hidden list (wiki-plan-job.ts,
 * `makeWikiPlanJobOnServer`); its input names the plan job, and the plan job is how the plan page sees it — its
 * progress as each document is taken up, and how it ended (`plan.jobs.progress`, `plan.jobs.finish`), as a
 * session's run reported them.
 *
 * THE REPOSITORY AT ONE COMMIT, READ BY THE SPACE'S RUNNER. A snapshot of origin/main names the commit (the
 * runner's fetch, as the CLI's own fetch did) and lists every file with its size; the files a section's sources
 * name are read whole at that commit (`read`), as many to one operation as fit `repoOps.read.wholeFileChars`, and
 * the writer cuts its sections, symbols and contracts out of them exactly as the runner cut them out of
 * `git show`. A file longer than one read gives is read to there and says so: what lies past it is reported
 * missing rather than taken from a heading that only looks like the one named. The reads are waited for holding
 * the job's lease — they are many and short, and parking on each would replay the build each time.
 *
 * THE SERVER'S HALF IS READ IN PROCESS: the records of a section's session condition through
 * wiki-docs-material.ts, as the runner door's material route reads them; the writes through `WikiDocs.write`, the
 * route's own writer, as the server's principal (`wikiDocsBuildJobPrincipal`).
 *
 * EVERY CALL IS A BREAKPOINT. A call's unit is its section and the digest of its prompt (wiki-docs-build.ts), so a
 * job replayed after its worker died, or retried after the model was away, reuses each answer whose question did
 * not change, and a section already written is left as it is by its fingerprint.
 *
 * HOW IT ENDS. Every section it took up written or unchanged: the plan job succeeded with the version written,
 * and the job succeeded. A section left unwritten — the model's call failed, or the server refused the write —
 * ends both failed once every other section has been tried, as the command exited non-zero. A failure of the
 * platform (the space's runner away, a read or a request past its limit, the worker stopping) is not the
 * build's: the job is tried again and the plan job reads as running meanwhile.
 */

/** What the job needs besides its context. */
export interface WikiDocsBuildJobDeps {
  prisma: PrismaService;
  docs: WikiDocs;
  /** The one reader of a record's words, for the session condition's material. */
  wiki: Pick<WikiService, 'sourceText'>;
  repoOps: WikiRepoOps;
  /** The System model's name: what each write says the documents were written with ('' when none is set). */
  model: string;
  /** How a wait for a repository operation hears it land; without it the wait polls. */
  repoWake?: WikiRepoOpWake;
  /** The specs' handle on how long one repository operation is waited for. */
  repoWaitMs?: number;
}

/** What the job reports: the run's summary (the command's `--json`), and the plan job it built for. */
export interface WikiDocsBuildJobReport extends Partial<WikiDocsBuildSummary> {
  kind: 'docs_build';
  planJobId: string;
  /** The plan job's report, as `plan.jobs.finish` keeps it. */
  build?: WikiPlanBuildReport | null;
  /** A replay of a job whose build had already ended: nothing was done again. */
  replayed?: boolean;
}

/** The runner the worker's module registers for `docs_build`. */
export function wikiDocsBuildJobRunner(deps: WikiDocsBuildJobDeps): WikiJobRunner {
  return (context) => runWikiDocsBuildJob(context, deps) as unknown as Promise<Record<string, unknown>>;
}

/** Build the documents of the space's confirmed plan for the plan job the input names. */
export async function runWikiDocsBuildJob(context: WikiJobContext, deps: WikiDocsBuildJobDeps): Promise<WikiDocsBuildJobReport> {
  const { job } = context;
  const { prisma } = deps;
  const planJobId = readPlanJobId(job.input);
  const planJob = await prisma.wikiPlanJob.findFirst({
    where: { id: planJobId, ownerId: job.ownerId, spaceId: job.spaceId, kind: 'build' },
    select: { state: true, jobId: true, outcome: true, error: true, report: true },
  });
  if (!planJob || planJob.jobId !== job.id) {
    throw new WikiJobContentError(`no build of this space's plan is made by this job (plan job ${planJobId})`);
  }
  if (planJob.state === 'ended') {
    // A replay of a job that had said how its build went before its own end was settled: the end stands.
    const ended: WikiDocsBuildJobReport = { kind: 'docs_build', planJobId, replayed: true, build: (planJob.report as unknown as WikiPlanBuildReport | null) ?? null };
    if (planJob.outcome === 'succeeded') return ended;
    throw new WikiJobContentError(planJob.error ?? 'the build failed', ended as unknown as Record<string, unknown>);
  }
  const principal = wikiDocsBuildJobPrincipal(job.ownerId);
  const plan = await readConfirmedPlan(prisma, job.ownerId, job.spaceId);
  if (!plan) {
    const error = `space ${job.spaceId} has no plan its owner confirmed (WIKI_PLAN_UNCONFIRMED), so no document is written`;
    await finishPlanJob(deps, job.id, planJobId, { outcome: 'failed', version: null, errors: [], error, report: null, draft: null, attempt: null });
    throw new WikiJobContentError(error, { kind: 'docs_build', planJobId });
  }

  const readiness = await readWikiRepoReadiness(prisma, { ownerId: job.ownerId, spaceId: job.spaceId });
  if (readiness.look !== 'ready') {
    // The space's runner cannot be asked now: offline, too old to be given the work, or no checkout to read. The
    // health line says which; the job is tried again on the backoff.
    throw new WikiJobInfraError(`REPO_NOT_READY: the space's repository cannot be read now (${readiness.look})`);
  }
  await progress(prisma, context, { step: 'snapshot' });
  const repo = await snapshotRepo(context, deps);

  const state = await deps.docs.writerState(principal, job.spaceId);
  const stored = new Map<string, Map<string, WikiDocsStoredSection>>();
  for (const doc of state.docs) {
    stored.set(doc.slug, new Map(doc.sections.map((section) => [section.key, { materialSha256: section.materialSha256, stale: section.stale }])));
  }
  const literals = await ownerEnvLiterals(prisma, job.ownerId);
  const summary = await runWikiDocsBuild({
    repo,
    prepare: (paths) => repo.prepare(paths),
    material: async (doc, key) => {
      const gathered = await gatherDocMaterial(prisma, deps.wiki, {
        ownerId: job.ownerId, spaceId: job.spaceId, condition: plan.conditions.get(`${doc.slug}#${key}`) ?? null, literals,
      });
      return { records: gathered.records, unresolved: gathered.unresolved };
    },
    view: async (slug) => {
      try {
        return await deps.docs.writerDoc(principal, job.spaceId, slug);
      } catch (error) {
        if (error instanceof NotFoundException) return null;
        throw error;
      }
    },
    write: (slug, request) => write(deps, job.ownerId, job.spaceId, slug, request),
    ask: async (call) => {
      try {
        const row = await context.ask(call.step, call.unit, { system: call.system, prompt: call.prompt, maxTokens: WIKI_DOCS_BUILD_JOB.maxTokens });
        return { text: row.answer ?? '', inputTokens: row.inputTokens ?? 0, outputTokens: row.outputTokens ?? 0 };
      } catch (error) {
        // The call's own end (the request failed) fails its section; the platform's stops the build.
        if (error instanceof WikiJobContentError) throw new WikiDocsCallFailed(error.message);
        throw error;
      }
    },
    model: deps.model,
    log: (message) => context.log(message),
    signal: context.signal,
  }, {
    spaceId: job.spaceId,
    planVersion: plan.version,
    docs: plan.docs,
    stored,
    onDoc: async (done, total, doc) => {
      const at: WikiPlanBuildProgress = { docs: { done, total }, current: doc ? { slug: doc.slug, title: doc.title } : null };
      await progressWikiPlanBuildOfJob(prisma, planJobId, job.id, at);
      await progress(prisma, context, { step: 'documents', ...at });
    },
  });

  const build = buildReportOf(summary, deps.model);
  const report: WikiDocsBuildJobReport = { kind: 'docs_build', planJobId, ...summary, build };
  if (summary.failed > 0) {
    const error = `${summary.failed === 1 ? '1 section was' : `${summary.failed} sections were`} left unwritten`;
    await finishPlanJob(deps, job.id, planJobId, { outcome: 'failed', version: summary.planVersion, errors: [], error, report: build as unknown as Record<string, unknown>, draft: null, attempt: null });
    throw new WikiJobContentError(error, report as unknown as Record<string, unknown>);
  }
  await finishPlanJob(deps, job.id, planJobId, { outcome: 'succeeded', version: summary.planVersion, errors: [], error: null, report: build as unknown as Record<string, unknown>, draft: null, attempt: null });
  return report;
}

/** The job's input as its row holds it: the plan job it builds for. */
function readPlanJobId(input: Record<string, unknown>): string {
  const id = input?.planJobId;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) {
    throw new WikiJobContentError('the job names no plan job to build for (input.planJobId)');
  }
  return id;
}

/** The job's own progress (contract `jobs.progress`), under the claim's generation: a takeover's is not overwritten. */
async function progress(prisma: PrismaService, context: WikiJobContext, value: Record<string, unknown>): Promise<void> {
  await writeWikiJobProgress(prisma, { id: context.job.id, generation: context.job.leaseGeneration, progress: value });
}

/** The plan job's end, as `plan.jobs.finish` keeps it: by its wiki job, with no session. */
async function finishPlanJob(deps: WikiDocsBuildJobDeps, jobId: string, planJobId: string, end: WikiPlanJobEnd): Promise<void> {
  const error = end.error === null ? null : cutRunes(end.error, 2000);
  await finishWikiPlanJob(deps.prisma, planJobId, null, { ...end, error }, new Date(), 'build', jobId);
}

/** The build's report as the plan job keeps it (`WikiPlanBuildReport`), the runner's `finishWikiDocsBuildJob` word for word. */
export function buildReportOf(summary: WikiDocsBuildSummary, model: string): WikiPlanBuildReport {
  const written = summary.docs.filter((doc) => doc.sections.length > 0 && doc.sections.every((section) => section.outcome !== 'failed')).length;
  return {
    planVersion: summary.planVersion,
    repoSha: summary.repoSha,
    docs: { total: summary.docs.length, written },
    sections: { written: summary.written, unchanged: summary.unchanged, failed: summary.failed },
    tokens: { input: summary.usage.inputTokens, output: summary.usage.outputTokens, calls: summary.calls },
    seconds: Math.trunc(summary.seconds),
    model: model === '' ? null : model,
  };
}

// ── The confirmed plan ──────────────────────────────────────────────────────────────────────────

/**
 * The confirmed plan as the runner door's plan read gives it to the writer: documents and sections in the plan's
 * order, each section's sources as stored — so its fingerprint is the runner's — and its session condition as the
 * material route reads it.
 */
async function readConfirmedPlan(
  prisma: PrismaService,
  ownerId: string,
  spaceId: string,
): Promise<{ version: number; docs: WikiDocsPlanDoc[]; conditions: Map<string, StoredSessionCondition | null> } | null> {
  const plan = await prisma.wikiPlan.findFirst({
    where: { ownerId, spaceId, status: 'confirmed' },
    select: {
      version: true,
      docs: {
        orderBy: { position: 'asc' },
        select: {
          slug: true, title: true, question: true, audience: true,
          sections: { orderBy: { position: 'asc' }, select: { key: true, title: true, kind: true, covers: true, length: true, sources: true } },
        },
      },
    },
  });
  if (!plan) return null;
  const conditions = new Map<string, StoredSessionCondition | null>();
  const docs = plan.docs.map((doc): WikiDocsPlanDoc => ({
    slug: doc.slug,
    title: doc.title,
    question: doc.question,
    audience: doc.audience,
    sections: doc.sections.map((section) => {
      const stored = (section.sources ?? {}) as {
        docs?: Array<{ path: string; section?: string | null }> | null;
        code?: Array<{ path: string; symbols?: string[] | null }> | null;
        contracts?: Array<{ path: string }> | null;
        sessions?: StoredSessionCondition | null;
      };
      const key = section.key ?? '';
      conditions.set(`${doc.slug}#${key}`, stored.sessions ?? null);
      const sessions = stored.sessions ?? null;
      return {
        key,
        title: section.title,
        kind: section.kind,
        covers: section.covers,
        length: section.length,
        sources: {
          docs: stored.docs == null ? null : stored.docs.map((source) => ({ path: source.path, section: source.section ?? null })),
          code: stored.code == null ? null : stored.code.map((source) => ({ path: source.path, symbols: source.symbols ?? null })),
          contracts: stored.contracts == null ? null : stored.contracts.map((source) => ({ path: source.path })),
          sessions: sessions === null ? null : {
            projects: (sessions.projects ?? []).map((id) => ({ id })),
            since: sessions.since ?? null,
            until: sessions.until ?? null,
            keywords: sessions.keywords ?? null,
            anchorPaths: sessions.anchorPaths ?? null,
            entryKinds: sessions.entryKinds ?? null,
            topics: sessions.topics ?? null,
            evidence: sessions.evidence ?? '',
          },
        },
      };
    }),
  }));
  return { version: plan.version, docs, conditions };
}

// ── The write ───────────────────────────────────────────────────────────────────────────────────

/** One write through the route's own writer; a refusal is the section's, said as the runner said it. */
async function write(deps: WikiDocsBuildJobDeps, ownerId: string, spaceId: string, slug: string, request: WikiDocsWriteRequest): Promise<WikiDocsWriteAnswer> {
  try {
    const answer = await deps.docs.write(wikiDocsBuildJobPrincipal(ownerId), spaceId, slug, request);
    return { status: answer.status, sections: answer.sections, counts: answer.counts };
  } catch (error) {
    if (error instanceof WikiRefusalError) throw new WikiDocsWriteRefused(refusalText(spaceId, error));
    if (error instanceof HttpException) throw new WikiDocsWriteRefused(`the server refused the write (${error.getStatus()}): ${error.message}`);
    throw error;
  }
}

/** A refusal of a write in the runner's words (`submit`, `wikiDocsBuildCallError`). */
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

// ── The repository, through the space's runner ─────────────────────────────────────────────────

/** What a `read` cut short ends with: `wikiRepoOpAfterwardsMarker` in src/runner-go/wiki_repo_ops.go. */
const READ_CUT_MARKER = '\n…（后略）\n';

/**
 * The checkout at the snapshot's commit, as the writer reads it (`WikiDocRepo`): which files there are and how big
 * from the snapshot, and each file's text from a `read` at that commit, made before it is shown (`prepare`). A
 * directory shows as `git show <sha>:<dir>` shows a tree — the runner's writer read a directory that way — from the
 * snapshot's paths.
 */
export class WikiDocsSnapshotRepo implements WikiDocRepo {
  private readonly texts = new Map<string, WikiDocShown | null>();
  private readonly reading = new Map<string, Promise<void>>();
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    readonly sha: string,
    private readonly sizes: ReadonlyMap<string, number>,
    private readonly files: readonly string[],
    private readonly read: (batch: ReadonlyArray<{ path: string; size: number }>) => Promise<Map<string, WikiDocShown | null>>,
  ) {}

  show(raw: string): WikiDocShown | null {
    const path = wikiDocCleanPath(raw);
    if (path === '') return null;
    if (this.sizes.has(path)) {
      if (!this.texts.has(path)) throw new Error(`${path} was shown before it was read: the build reads a section's files first`);
      return this.texts.get(path) ?? null;
    }
    const dir = path.replace(/\/$/u, '');
    const children = new Set<string>();
    for (const file of this.files) {
      if (!file.startsWith(`${dir}/`)) continue;
      const rest = file.slice(dir.length + 1);
      const slash = rest.indexOf('/');
      children.add(slash < 0 ? rest : `${rest.slice(0, slash)}/`);
    }
    if (children.size === 0) return null;
    const listed = [...children].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return { text: `tree ${this.sha}:${path}\n\n${listed.map((child) => `${child}\n`).join('')}`, cut: false };
  }

  under(raw: string): string[] {
    const prefix = `${wikiDocCleanPath(raw).replace(/\/$/u, '')}/`;
    return this.files.filter((file) => file.startsWith(prefix));
  }

  /** Read the files among these paths not read yet: as many to one operation as fit one read, a few at a time. */
  async prepare(paths: readonly string[]): Promise<void> {
    const wanted = [...new Set(paths.map((path) => wikiDocCleanPath(path)))].filter((path) => this.sizes.has(path));
    const fresh = wanted.filter((path) => !this.texts.has(path) && !this.reading.has(path));
    let batch: Array<{ path: string; size: number }> = [];
    let bytes = 0;
    const flush = (): void => {
      if (batch.length === 0) return;
      const taken = batch;
      const done = this.slot(() => this.read(taken)).then((texts) => {
        for (const file of taken) this.texts.set(file.path, texts.get(file.path) ?? null);
      });
      for (const file of taken) this.reading.set(file.path, done);
      batch = [];
      bytes = 0;
    };
    for (const path of fresh) {
      const size = this.sizes.get(path) ?? 0;
      // Characters never outnumber bytes, so files whose sizes sum within one read's limit fit whole in one.
      if (batch.length > 0 && bytes + size > WIKI_REPO_OPS.wholeFileChars) flush();
      batch.push({ path, size });
      bytes += size;
    }
    flush();
    await Promise.all(wanted.map((path) => this.reading.get(path)).filter((done) => done !== undefined));
  }

  /** At most WIKI_DOCS_BUILD_JOB.readsInFlight reads at once: each is a fetch in the same checkout on the runner. */
  private async slot<T>(work: () => Promise<T>): Promise<T> {
    while (this.inFlight >= WIKI_DOCS_BUILD_JOB.readsInFlight) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.inFlight += 1;
    try {
      return await work();
    } finally {
      this.inFlight -= 1;
      this.waiting.shift()?.();
    }
  }
}

/**
 * The commit the build reads, and the reader at it: a snapshot of origin/main — skipped by the runner when the
 * space already holds that commit's — then the space's snapshot read back for its paths and sizes.
 */
async function snapshotRepo(context: WikiJobContext, deps: WikiDocsBuildJobDeps): Promise<WikiDocsSnapshotRepo> {
  const { job } = context;
  const held = await deps.prisma.wikiRepoSnapshot.findFirst({ where: { spaceId: job.spaceId, ownerId: job.ownerId }, select: { sha: true } });
  const settled = await operation(context, deps, 'snapshot', { skipSha: held?.sha ?? null }, 'the snapshot of origin/main');
  if (settled.state !== 'succeeded') {
    throw new WikiJobInfraError(`REPO_OP_FAILED: the snapshot of origin/main ${settled.state}: ${settled.error ?? ''}`);
  }
  const sha = String(settled.result?.sha ?? '');
  const snapshot = await readWikiRepoSnapshot(deps.prisma, { ownerId: job.ownerId, spaceId: job.spaceId });
  if (!snapshot || snapshot.sha !== sha) {
    throw new WikiJobInfraError(`REPO_OP_FAILED: the space holds no snapshot of ${sha.slice(0, 12)}, the commit the snapshot named`);
  }
  const index = JSON.parse(snapshot.index) as { files?: Array<{ path?: unknown; size?: unknown }> };
  const sizes = new Map<string, number>();
  for (const file of index.files ?? []) {
    if (typeof file.path === 'string') sizes.set(file.path, typeof file.size === 'number' ? file.size : 0);
  }
  const files = [...sizes.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  context.log(`the repository at ${sha.slice(0, 12)} (${files.length} files)`);
  return new WikiDocsSnapshotRepo(sha, sizes, files, (batch) => readFiles(context, deps, sha, batch));
}

/** Files read whole at the commit (`read`): asked again when the read failed, and given up as the platform's. */
async function readFiles(
  context: WikiJobContext,
  deps: WikiDocsBuildJobDeps,
  sha: string,
  batch: ReadonlyArray<{ path: string; size: number }>,
): Promise<Map<string, WikiDocShown | null>> {
  const items = batch.map((file) => (file.size > 0 ? { path: file.path, maxChars: Math.min(file.size, WIKI_REPO_OPS.wholeFileChars) } : { path: file.path }));
  const what = `${batch.length === 1 ? batch[0].path : `${batch.length} files`} at ${sha.slice(0, 12)}`;
  let last = '';
  for (let attempt = 1; attempt <= WIKI_DOCS_BUILD_JOB.readAttempts; attempt += 1) {
    const settled = await operation(context, deps, 'read', { sha, items }, `reading ${what}`);
    if (settled.state === 'succeeded') {
      const answered = ((settled.result?.read as { items?: unknown[] } | undefined)?.items ?? []) as Array<{ found?: boolean; text?: string; truncated?: boolean }>;
      const texts = new Map<string, WikiDocShown | null>();
      batch.forEach((file, i) => texts.set(file.path, wikiDocsShownOf(answered[i], file.size)));
      return texts;
    }
    last = settled.error ?? settled.state;
  }
  throw new WikiJobInfraError(`REPO_OP_FAILED: reading ${what} failed ${WIKI_DOCS_BUILD_JOB.readAttempts} times: ${last}`);
}

/** A file as one read item answered it: whole, or its first whole lines when the read stopped short of its end. */
export function wikiDocsShownOf(item: { found?: boolean; text?: string; truncated?: boolean } | undefined, size: number): WikiDocShown | null {
  // An empty file answers found false, as a missing one does; the snapshot says which it is.
  if (!item?.found) return size === 0 ? { text: '', cut: false } : null;
  let text = String(item.text ?? '');
  if (!item.truncated) return { text, cut: false };
  if (text.endsWith(READ_CUT_MARKER)) text = text.slice(0, -READ_CUT_MARKER.length);
  return { text: text.slice(0, text.lastIndexOf('\n') + 1), cut: true };
}

/** One repository operation of the job, waited for holding its lease; a wait that runs out is the platform's failure. */
async function operation(
  context: WikiJobContext,
  deps: WikiDocsBuildJobDeps,
  kind: 'snapshot' | 'read',
  input: Record<string, unknown>,
  what: string,
): Promise<WikiRepoOpWait> {
  const { job } = context;
  const timeoutMs = deps.repoWaitMs ?? WIKI_DOCS_BUILD_JOB.repoWaitSeconds * 1000;
  try {
    const { id } = await deps.repoOps.enqueueWikiRepoOp({ jobId: job.id, kind, input });
    return await waitForWikiRepoOp(deps.prisma, { id, ownerId: job.ownerId, timeoutMs, wake: deps.repoWake, signal: context.signal });
  } catch (error) {
    if (error instanceof WikiRepoOpWaitTimedOut) {
      throw new WikiJobInfraError(`REPO_OP_WAIT: ${what} did not settle within ${Math.round(timeoutMs / 1000)} s`);
    }
    if (error instanceof WikiRepoOpRefused) throw new WikiJobInfraError(`REPO_OP_REFUSED: ${what}: ${error.message}`);
    throw error;
  }
}
