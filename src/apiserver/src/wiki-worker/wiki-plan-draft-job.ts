import { createHash } from 'node:crypto';
import {
  WIKI_PLAN_JOB_RULES,
  WIKI_PLAN_RULES,
  WIKI_PLAN_SERVER_JOB,
  WIKI_REPO_OPS,
  type WikiPlanGateError,
  type WikiPlanJobReport,
  type WikiPlanMaterials,
} from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { WikiPlans } from '../wiki/wiki-plan';
import { progressWikiPlanJobOfJob, saveWikiPlanJobMaterials, wikiPlanMaterials } from '../wiki/wiki-plan-job';
import { WikiRefusalError } from '../wiki/wiki.service';
import { cutRunes } from './wiki-import-extract';
import { WikiJobContentError, WikiJobInfraError, type WikiJobContext, type WikiJobRunner } from './wiki-job-executor';
import { writeWikiJobProgress } from './wiki-jobs';
import { wikiModelRequestSha256 } from './wiki-model-queue';
import {
  goCompare,
  parseWikiPlanCatalogue,
  parseWikiPlanDetails,
  parseWikiPlanDocBody,
  wikiPlanDocInput,
  type WikiPlanCat,
  type WikiPlanCatalogue,
  type WikiPlanDocRead,
  type WikiPlanDraft,
  type WikiPlanHeader,
  type WikiPlanMove,
  type WikiPlanSources,
  type WikiPlanUnit,
} from './wiki-plan-format';
import {
  wikiPlanAssemble,
  wikiPlanCatalogueLevel,
  wikiPlanCountError,
  wikiPlanDocIndex,
  wikiPlanNumber,
  type WikiPlanAssembled,
} from './wiki-plan-gate';
import { wikiPlanSessionsText } from './wiki-plan-materials';
import {
  WIKI_PLAN_SYSTEM_PROMPT,
  wikiPlanCatalogueRedoPrompt,
  wikiPlanCatalogueText,
  wikiPlanDetailMaterials,
  wikiPlanDetailPrompt,
  wikiPlanDocMaterials,
  wikiPlanErrorLines,
  wikiPlanFullMaterials,
  wikiPlanOutlinePrompt,
  wikiPlanRedoDocPrompt,
  wikiPlanRevisionCataloguePrompt,
  wikiPlanRewritePrompt,
  wikiPlanRulesPrompt,
  wikiPlanSkeletonPrompt,
  type WikiPlanRunState,
  type WikiPlanVersionRead,
} from './wiki-plan-prompts';
import { shortWikiHash, WikiPlanRepo, WIKI_PLAN_MATERIAL_CAPS, type WikiPlanSnapshotIndex } from './wiki-plan-repo';
import {
  readWikiRepoOp,
  readWikiRepoReadiness,
  readWikiRepoSnapshot,
  waitForWikiRepoOp,
  WikiRepoOpRefused,
  WikiRepoOpWaitTimedOut,
  type WikiRepoOps,
  type WikiRepoOpWake,
  type WikiRepoSnapshotRead,
} from './wiki-repo-ops';

/**
 * A plan job on the server (contracts/wiki.contract.json `plan.jobs.server` and `jobs.kindRuns.plan_draft` /
 * `plan_revise`, design §8, P6): what `orbit wiki plan draft` and `orbit wiki plan revise` do in a maintenance
 * session, done by the wiki-worker with the System model — ported from `src/runner-go/wiki_plan_draft.go`.
 *
 * THE MODEL DRAFTS, THE GATE DECIDES — as on the runner. The model writes the plan in four small steps — the
 * catalogue's skeleton, each category's documents in detail, each document's outline with where every section's
 * material comes from, and a draft of the rules — or, for a revision, the new catalogue with what each document is
 * made from, and the documents that merge or are new. Everything it says is held to this job's own gate
 * (wiki-plan-gate.ts), which checks every file, docs section and symbol on the space's snapshot of origin/main,
 * then to the plan's gate on the server (`WikiPlans.submitServerDraft`). What either finds goes back to the model,
 * unit by unit, three rounds at most; only a draft both let through is stored.
 *
 * EVERY CALL IS A BREAKPOINT, AND A REPLAY ASKS THE SAME QUESTIONS. Each call is a queue request (step `plan_*`, unit
 * `a<round>/<unit>@<sha12 of the call>`), so a job replayed after its worker died, or retried after the model was
 * away, meets every request it already made and waits for the ones in flight — where the runner kept its answers
 * in a work directory. A replay asks the same questions because the job's materials are read once, at its first
 * run, and kept on the plan job (`wiki_plan_job.materials`): the snapshot's sha, what Orbit said of the space, and
 * the texts the snapshot does not carry. Only a snapshot that moved under the job — another job of the space took a
 * newer one — makes it start over, as the runner starts over when the sha it drafted from left origin/main.
 *
 * THE PLAN JOB SAYS WHERE IT IS. Its round goes on the plan job (`attempt`), which is what the plan page shows, and
 * it ends there with its version or its last errors (`WikiPlans.finishServerJob`), exactly as a session's run ends
 * it through the runner door. A failure of the platform — a request past its wait limit, the space's runner away,
 * the worker stopping — is not the draft's: the wiki_job is tried again and the plan job stays running.
 */

/** What the job needs besides its context: the plan's service, the repository's operations, and the model's name. */
export interface WikiPlanDraftJobDeps {
  prisma: PrismaService;
  plans: WikiPlans;
  repoOps: WikiRepoOps;
  /** The System model's name: what the report and the version say the draft was written with. */
  model: string | null;
  repoWake?: WikiRepoOpWake;
  /** The specs' handles on the waits and the clustering's slices. */
  snapshotWaitMs?: number;
  readWaitMs?: number;
  sliceMs?: number;
  concurrency?: number;
}

/** The kind's runner, as the worker module puts it in the executor's map (plan_draft and plan_revise alike). */
export function wikiPlanDraftJobRunner(deps: WikiPlanDraftJobDeps): WikiJobRunner {
  return async (context) => new WikiPlanDraftRun(context, deps).run();
}

/** What a server-run plan job keeps of its first run, so that a replay drafts from the same (`wiki_plan_job.materials`). */
export interface WikiPlanFrame {
  /** The snapshot's commit the job drafts from. */
  sha: string;
  /** YYYY-MM-DD: the day the materials were read, which every prompt's head names. */
  date: string;
  materials: WikiPlanMaterials;
  /** What the job read at the sha that the snapshot does not carry: the overview's documents and schema.prisma. */
  texts: Record<string, string>;
}

/** The job's report on its wiki_job row (contract `jobs.kindRuns.plan_draft`): the plan job's, and which it is. */
export interface WikiPlanServerJobReport extends Record<string, unknown> {
  kind: 'plan_draft' | 'plan_revise';
  planJobId: string;
  outcome: 'succeeded' | 'failed';
  version: number | null;
  error: string | null;
  plan: WikiPlanJobReport;
}

/** A unit's call that failed for good: the unit is left without what it would have written, and the gate names it. */
class WikiPlanUnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikiPlanUnitError';
  }
}

/** The draft's own end (§5.5 content): the plan job ends failed with it, and the wiki_job with it. */
class WikiPlanStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikiPlanStop';
  }
}

/** A uuid made from a name: an operation's id that a replay of the same job finds again. */
export function wikiPlanOpId(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A unit's name as the runner names its file (`wikiPlanFileName`): what a request's unit is called after. */
export function wikiPlanFileName(unit: string): string {
  const name = unit.replace(/[^A-Za-z0-9._-]+/gu, '_');
  return name === '' ? 'unit' : name;
}

/**
 * The key a server-run job stores its draft under (contract `plan.idempotency`): the plan job, the wiki_job that
 * runs it and the draft, digested. The same draft submitted again by a replay is answered with the version its
 * first submission stored; a later round's draft is another key.
 */
export function wikiPlanServerDraftKey(planJobId: string, wikiJobId: string, request: Record<string, unknown>): string {
  const { idempotencyKey: _key, ...draft } = request;
  const sum = createHash('sha256').update(`${planJobId}\x00server:${wikiJobId}\x00${JSON.stringify(draft)}`).digest('hex');
  return `wiki-plan-${sum.slice(0, 40)}`;
}

const NEEDS_FORMAT = '\n\n（注意：严格按上面的输出格式输出，不要别的内容。）';

/** The plan job a run is for, as it reads it. */
interface PlanJobRow {
  id: string;
  kind: string;
  state: string;
  outcome: string | null;
  version: number | null;
  instructions: string | null;
  jobId: string | null;
  startedAt: Date | null;
  materials: unknown;
}

class WikiPlanDraftRun implements WikiPlanRunState {
  spaceTitle = '';
  date = '';
  repo!: WikiPlanRepo;
  materials!: WikiPlanMaterials;
  sessionsText = '';
  target: { min: number; max: number } = { min: WIKI_PLAN_RULES.docsMin, max: WIKI_PLAN_RULES.docsMax };
  instructions = '';
  base: WikiPlanVersionRead | null = null;
  baseIds = new Map<string, string>();
  baseDocs = new Map<string, WikiPlanDocRead>();
  cats: WikiPlanCat[] = [];
  units: WikiPlanUnit[] = [];
  moves: WikiPlanMove[] = [];

  private readonly kind: 'draft' | 'revise';
  private readonly planJobId: string;
  private rules = '';
  private lastErrors: WikiPlanGateError[] = [];
  private lastDraft: WikiPlanDraft | null = null;
  private readonly report: WikiPlanJobReport;
  private snapshot: WikiPlanSnapshotIndex | null = null;
  private startedAt = new Date();

  constructor(private readonly context: WikiJobContext, private readonly deps: WikiPlanDraftJobDeps) {
    this.kind = context.job.kind === WIKI_PLAN_SERVER_JOB.kinds.revise ? 'revise' : 'draft';
    const planJobId = context.job.input.planJobId;
    if (typeof planJobId !== 'string' || planJobId === '') {
      throw new WikiJobContentError(`the ${context.job.kind} job's input names no plan job: { planJobId } is what this build reads`);
    }
    this.planJobId = planJobId;
    this.report = {
      categories: 0, docs: 0, sections: 0, target: this.target, attempts: [], repo: null,
      tokens: { input: 0, output: 0, calls: 0 }, seconds: 0, model: deps.model,
    };
  }

  private say(message: string): void {
    this.context.log(`plan ${this.kind}: ${message}`);
  }

  /** The whole run. Once the plan job is read, whatever ends the draft, the plan job hears how. */
  async run(): Promise<WikiPlanServerJobReport> {
    const { job } = this.context;
    const planJob = await this.deps.prisma.wikiPlanJob.findFirst({
      where: { id: this.planJobId, ownerId: job.ownerId, spaceId: job.spaceId },
      select: { id: true, kind: true, state: true, outcome: true, version: true, instructions: true, jobId: true, startedAt: true, materials: true },
    }) as PlanJobRow | null;
    if (!planJob || planJob.jobId !== job.id) {
      throw new WikiJobContentError(`the plan job ${this.planJobId} this ${job.kind} job was made for is not this space's, or not this job's`);
    }
    if (planJob.state === 'ended') {
      // A replay of a job whose run had already said how it ended — its own settle was what got lost.
      return this.endedReport(planJob);
    }
    if (planJob.state !== 'made') throw new WikiJobContentError(`the plan job ${this.planJobId} is ${planJob.state}, not running`);
    await progressWikiPlanJobOfJob(this.deps.prisma, { planJobId: planJob.id, wikiJobId: job.id, attempt: null });
    this.startedAt = planJob.startedAt ?? new Date();
    let version = 0;
    try {
      version = await this.steps(planJob);
    } catch (error) {
      if (!(error instanceof WikiPlanStop)) throw error;
      const report = await this.close();
      const finish: Record<string, unknown> = { outcome: 'failed', error: cutRunes(error.message, WIKI_PLAN_JOB_RULES.errorMaxChars), report };
      if (report.attempts.length > 0) finish.attempt = report.attempts.length;
      if (this.lastErrors.length > 0) finish.errors = this.lastErrors.slice(0, WIKI_PLAN_RULES.errorsMax);
      if (this.lastDraft && Buffer.byteLength(JSON.stringify(this.lastDraft), 'utf8') <= WIKI_PLAN_JOB_RULES.draftMaxBytes) finish.draft = this.lastDraft;
      await this.deps.plans.finishServerJob({ ownerId: job.ownerId, spaceId: job.spaceId, planJobId: planJob.id, wikiJobId: job.id }, finish);
      throw new WikiJobContentError(`plan ${this.kind}: ${error.message}`, this.wikiJobReport('failed', null, error.message, report));
    }
    const report = await this.close();
    await this.deps.plans.finishServerJob(
      { ownerId: job.ownerId, spaceId: job.spaceId, planJobId: planJob.id, wikiJobId: job.id },
      { outcome: 'succeeded', version, report, attempt: report.attempts.length },
    );
    return this.wikiJobReport('succeeded', version, null, report);
  }

  private wikiJobReport(outcome: 'succeeded' | 'failed', version: number | null, error: string | null, plan: WikiPlanJobReport): WikiPlanServerJobReport {
    return {
      kind: this.kind === 'revise' ? 'plan_revise' : 'plan_draft',
      planJobId: this.planJobId,
      outcome,
      version,
      error: error === null ? null : cutRunes(error, WIKI_PLAN_JOB_RULES.errorMaxChars),
      plan,
    };
  }

  private async endedReport(planJob: PlanJobRow): Promise<WikiPlanServerJobReport> {
    const row = await this.deps.prisma.wikiPlanJob.findFirst({ where: { id: planJob.id }, select: { report: true, error: true } });
    const outcome = planJob.outcome === 'succeeded' ? 'succeeded' : 'failed';
    if (outcome === 'failed') {
      throw new WikiJobContentError(`plan ${this.kind}: ${row?.error ?? 'the plan job ended failed'}`);
    }
    return this.wikiJobReport(outcome, planJob.version, null, (row?.report as unknown as WikiPlanJobReport | null) ?? this.report);
  }

  /** The report as the run ends it (contract `plan.jobs.report`), its tokens the job's every request's. */
  private async close(): Promise<WikiPlanJobReport> {
    const [spent] = await this.deps.prisma.$queryRaw<Array<{ calls: number; input: number; output: number }>>`
      SELECT count(*)::int AS "calls", coalesce(sum("input_tokens"), 0)::int AS "input", coalesce(sum("output_tokens"), 0)::int AS "output"
        FROM "wiki_model_request" WHERE "job_id" = ${this.context.job.id}::uuid`;
    this.report.tokens = { input: spent?.input ?? 0, output: spent?.output ?? 0, calls: spent?.calls ?? 0 };
    this.report.seconds = Math.max(0, Math.round((Date.now() - this.startedAt.getTime()) / 1000));
    this.report.model = this.deps.model;
    this.report.target = this.target;
    if (this.rules !== '') {
      // The rules' draft, cut to fit: the runner's 6,000 characters, and fewer when the report would outweigh its limit.
      let rules = cutRunes(this.rules, 6000);
      this.report.rulesDraft = rules;
      while (rules !== '' && Buffer.byteLength(JSON.stringify(this.report), 'utf8') > WIKI_PLAN_JOB_RULES.reportMaxBytes) {
        rules = cutRunes(rules, Math.floor([...rules].length * 0.8));
        this.report.rulesDraft = rules;
      }
    }
    return this.report;
  }

  // ── The steps ───────────────────────────────────────────────────────────────────────────────────

  /** The job, and the version it stored, or why it did not. */
  private async steps(planJob: PlanJobRow): Promise<number> {
    await this.readPlan(planJob);
    await this.frame(planJob);
    let assembled = emptyAssembled();
    for (let attempt = 1; attempt <= WIKI_PLAN_JOB_RULES.attemptsMax; attempt += 1) {
      await progressWikiPlanJobOfJob(this.deps.prisma, { planJobId: this.planJobId, wikiJobId: this.context.job.id, attempt });
      await this.progress({ attempt, step: 'draft' });
      this.say(`Attempt ${attempt} of ${WIKI_PLAN_JOB_RULES.attemptsMax}.`);
      if (attempt === 1) await this.firstDraft();
      else await this.redo(attempt, this.lastErrors, assembled);
      await this.readSymbolTexts();
      assembled = wikiPlanAssemble(this);
      this.lastDraft = assembled.plan;
      const round = { attempt, local: assembled.errors.length, server: 0, checks: {} as Record<string, number> };
      this.report.categories = assembled.plan.categories.length;
      this.report.docs = assembled.plan.docs.length;
      this.report.sections = assembled.sections;
      this.report.repo = { sha: assembled.repo.sha, checked: assembled.repo.checked, missing: assembled.repo.missing.length };
      if (assembled.errors.length > 0) {
        for (const e of assembled.errors) round.checks[e.check] = (round.checks[e.check] ?? 0) + 1;
        this.report.attempts.push(round);
        this.lastErrors = assembled.errors;
        this.say(`Attempt ${attempt}: this job's gate found ${count(assembled.errors.length, 'error', 'errors')} (${checksLine(round.checks)}); handing them back to the model.`);
        continue;
      }
      await this.progress({ attempt, step: 'submit' });
      const { version, refused } = await this.submit(assembled);
      if (refused === null) {
        this.report.attempts.push(round);
        this.say(`Attempt ${attempt}: both gates let the draft through; it is version ${version}.`);
        return version;
      }
      round.server = refused.length;
      for (const e of refused) round.checks[e.check] = (round.checks[e.check] ?? 0) + 1;
      this.report.attempts.push(round);
      this.lastErrors = refused;
      this.say(`Attempt ${attempt}: the server's gate refused it with ${count(refused.length, 'error', 'errors')} (${checksLine(round.checks)}); handing them back to the model.`);
    }
    throw new WikiPlanStop(`the draft did not pass the plan's gate in ${WIKI_PLAN_JOB_RULES.attemptsMax} rounds: ${count(this.lastErrors.length, 'error', 'errors')} `
      + `on the last, the first of them: ${errorLine(this.lastErrors[0])}`);
  }

  /** Where the job is, for Activity: its own progress, under the claim's generation. */
  private async progress(progress: Record<string, unknown>): Promise<void> {
    const { job } = this.context;
    await writeWikiJobProgress(this.deps.prisma, { id: job.id, generation: job.leaseGeneration, progress: { planJobId: this.planJobId, ...progress } });
  }

  /**
   * The version the draft revises — the space's draft when it has one, else its confirmed version — the target the
   * draft is held to, and a revision's instructions.
   */
  private async readPlan(planJob: PlanJobRow): Promise<void> {
    const { job } = this.context;
    const state = await this.deps.plans.state(job.ownerId, job.spaceId);
    let base = state.draft ?? state.confirmed;
    if (base && base.authorJobId === job.id) {
      // A replay of a job whose draft was stored before its end was said: it drafts from what that draft revised,
      // so it asks the same questions, submits the same draft under the same key and is answered with its version.
      base = base.baseVersion === null ? null : await this.deps.plans.version(job.ownerId, job.spaceId, base.baseVersion);
    }
    this.base = base as unknown as WikiPlanVersionRead | null;
    if (this.base && this.base.target.min > 0) this.target = { ...this.base.target };
    this.baseIds = new Map();
    this.baseDocs = new Map();
    if (this.base) {
      this.base.categories.forEach((cat, c) => {
        let n = 0;
        for (const doc of this.base!.docs) {
          if (doc.category !== cat.key) continue;
          n += 1;
          this.baseIds.set(`${c + 1}.${n}`, doc.slug);
          this.baseDocs.set(doc.slug, doc);
        }
      });
      this.say(`The plan stands at version ${this.base.version} (${this.base.status}): ${this.base.docs.length} documents; the draft is held to ${this.target.min}–${this.target.max}.`);
    } else {
      this.say(`The space has no plan yet; the draft is held to ${this.target.min}–${this.target.max} documents.`);
    }
    // A revision's plan job always carries the owner's words (wiki_plan_job_instructions_chk).
    this.instructions = this.kind === 'revise' ? (planJob.instructions ?? '').trim() : '';
  }

  /**
   * The materials the job drafts from, read once (contract `plan.jobs.server.materials`): the space's snapshot of
   * origin/main — a fresh one when its runner can take it now — what Orbit says of the space, and the texts at the
   * sha the snapshot does not carry. Kept on the plan job, so a replay drafts from the same.
   */
  private async frame(planJob: PlanJobRow): Promise<void> {
    const { job } = this.context;
    const { prisma } = this.deps;
    const stored = frameOf(planJob.materials);
    let snapshot = await readWikiRepoSnapshot(prisma, { ownerId: job.ownerId, spaceId: job.spaceId });
    let frame = stored && snapshot && snapshot.sha === stored.sha ? stored : null;
    if (stored && !frame) {
      this.say(`the space's snapshot moved from ${shortWikiHash(stored.sha)} to ${snapshot ? shortWikiHash(snapshot.sha) : 'none'}: the draft starts over at it`);
    }
    if (!frame) {
      await this.progress({ step: 'snapshot' });
      snapshot = await this.freshSnapshot(snapshot);
      if (!snapshot) {
        const readiness = await readWikiRepoReadiness(prisma, { ownerId: job.ownerId, spaceId: job.spaceId });
        throw new WikiJobInfraError(`the space has no snapshot of its repository yet, and its runner could not take one (${readiness.look}): the draft waits for it`);
      }
      this.snapshot = JSON.parse(snapshot.index) as WikiPlanSnapshotIndex;
      this.repo = new WikiPlanRepo(this.snapshot);
      await this.progress({ step: 'materials' });
      const materials = await wikiPlanMaterials(prisma, job.ownerId, job.spaceId, new Date());
      const reads = [
        ...this.repo.overviewFiles().map((path) => ({ path, maxChars: Math.min(WIKI_REPO_OPS.sectionChars, WIKI_PLAN_MATERIAL_CAPS.overview.full + 400) })),
        ...this.repo.schemaFiles().map((path) => ({ path, maxChars: WIKI_REPO_OPS.wholeFileChars })),
      ];
      const texts = Object.fromEntries(await this.readTexts(snapshot.sha, reads));
      frame = { sha: snapshot.sha, date: materials.asOf.slice(0, 10), materials, texts };
      await saveWikiPlanJobMaterials(prisma, { planJobId: this.planJobId, wikiJobId: job.id, materials: frame as unknown as Record<string, unknown> });
    } else {
      this.snapshot = JSON.parse(snapshot!.index) as WikiPlanSnapshotIndex;
    }
    this.repo = new WikiPlanRepo(this.snapshot!).withTexts(frame.texts);
    this.materials = frame.materials;
    this.spaceTitle = frame.materials.title;
    this.date = frame.date;
    this.sessionsText = await wikiPlanSessionsText(frame.materials, this.deps.sliceMs);
    this.say(`origin/main ${shortWikiHash(frame.sha)}: ${this.repo.files.length} files, ${this.repo.docFiles().length} documents; `
      + `materials: ${frame.materials.projects.length} projects, ${frame.materials.sessions.items.length} of ${frame.materials.sessions.total} sessions, ${frame.materials.topics.length} topics.`);
  }

  /**
   * A fresh snapshot of origin/main when the space's runner can take one now, waited for a while; else the snapshot
   * the space holds; else none.
   */
  private async freshSnapshot(held: WikiRepoSnapshotRead | null): Promise<WikiRepoSnapshotRead | null> {
    const { job, signal } = this.context;
    const { prisma } = this.deps;
    const readiness = await readWikiRepoReadiness(prisma, { ownerId: job.ownerId, spaceId: job.spaceId });
    if (readiness.look !== 'ready') {
      this.say(`the space's repository cannot be read now (${readiness.look}): the draft is made from the snapshot the space holds`);
      return held;
    }
    const opId = wikiPlanOpId(`wiki-plan-snapshot:${job.id}:${job.attempts}`);
    try {
      if (!(await readWikiRepoOp(prisma, { id: opId, ownerId: job.ownerId }))) {
        await this.deps.repoOps.enqueueWikiRepoOp({ id: opId, jobId: job.id, kind: 'snapshot', input: { skipSha: held?.sha ?? null } });
      }
      const settled = await waitForWikiRepoOp(prisma, {
        id: opId,
        ownerId: job.ownerId,
        timeoutMs: this.deps.snapshotWaitMs ?? WIKI_PLAN_SERVER_JOB.snapshotWaitSeconds * 1000,
        wake: this.deps.repoWake,
        signal,
      });
      if (settled.state !== 'succeeded') this.say(`the snapshot ${settled.state}: ${settled.error ?? ''} — the draft is made from the snapshot the space holds`);
    } catch (error) {
      if (!(error instanceof WikiRepoOpWaitTimedOut || error instanceof WikiRepoOpRefused)) throw error;
      this.say(`no fresh snapshot (${error.message}): the draft is made from the snapshot the space holds`);
    }
    return readWikiRepoSnapshot(prisma, { ownerId: job.ownerId, spaceId: job.spaceId });
  }

  /**
   * Texts of the repository at the sha, through the runner's `read` (contract `repoOps.kinds.read`): packed so each
   * request stays within one section's material, by the sizes the snapshot gives, and waited for together. A read
   * that does not come back is the platform's: the job is tried again.
   */
  private async readTexts(sha: string, items: ReadonlyArray<{ path: string; maxChars: number }>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (items.length === 0) return out;
    const { job, signal } = this.context;
    const { prisma } = this.deps;
    const packs: Array<Array<{ path: string; maxChars: number }>> = [];
    let pack: Array<{ path: string; maxChars: number }> = [];
    let budget = 0;
    for (const item of items) {
      const need = Math.max(1, Math.min(item.maxChars, this.repo.sizeOf(item.path) || item.maxChars));
      if (pack.length > 0 && budget + need > WIKI_REPO_OPS.sectionChars) {
        packs.push(pack);
        pack = [];
        budget = 0;
      }
      pack.push(item);
      budget += need;
    }
    if (pack.length > 0) packs.push(pack);
    const ops = packs.map((items) => ({
      id: wikiPlanOpId(`wiki-plan-read:${job.id}:${job.attempts}:${sha}:${items.map((i) => `${i.path}#${i.maxChars}`).join('|')}`),
      items,
    }));
    for (const op of ops) {
      if (!(await readWikiRepoOp(prisma, { id: op.id, ownerId: job.ownerId }))) {
        await this.deps.repoOps.enqueueWikiRepoOp({ id: op.id, jobId: job.id, kind: 'read', input: { sha, items: op.items } });
      }
    }
    const deadline = Date.now() + (this.deps.readWaitMs ?? WIKI_PLAN_SERVER_JOB.readWaitSeconds * 1000);
    for (const op of ops) {
      let settled;
      try {
        settled = await waitForWikiRepoOp(prisma, { id: op.id, ownerId: job.ownerId, timeoutMs: Math.max(1, deadline - Date.now()), wake: this.deps.repoWake, signal });
      } catch (error) {
        if (error instanceof WikiRepoOpWaitTimedOut) {
          throw new WikiJobInfraError(`a read of the repository at ${shortWikiHash(sha)} did not come back in time: the space's runner is away`);
        }
        throw error;
      }
      if (settled.state !== 'succeeded') {
        throw new WikiJobInfraError(`a read of the repository at ${shortWikiHash(sha)} ${settled.state}: ${settled.error ?? 'no reason given'}`);
      }
      const read = (settled.result?.read ?? {}) as { items?: Array<{ path?: unknown; found?: unknown; text?: unknown }> };
      for (const piece of read.items ?? []) {
        if (typeof piece.path === 'string') out.set(piece.path, piece.found === true && typeof piece.text === 'string' ? piece.text : '');
      }
    }
    return out;
  }

  /** The texts the gate reads to settle a symbol the index does not name: read at the sha before a round is gated. */
  private async readSymbolTexts(): Promise<void> {
    const wanted = wikiPlanTextsWanted(this);
    if (wanted.length === 0) return;
    await this.progress({ step: 'read' });
    this.repo.withTexts(await this.readTexts(this.repo.sha, wanted.map((path) => ({ path, maxChars: WIKI_REPO_OPS.wholeFileChars }))));
  }

  // ── One call ────────────────────────────────────────────────────────────────────────────────────

  /**
   * One unit's answer: one call through the queue — met again when a replay asks it, waited for when it is in
   * flight — and, when its answer does not read, asked again with the format said once more.
   */
  private async ask(attempt: number, step: string, unit: string, prompt: string, parses?: (text: string) => boolean): Promise<string> {
    let call = prompt;
    let last = '';
    for (let tried = 0; tried < WIKI_PLAN_SERVER_JOB.formatTries; tried += 1) {
      const request = { system: WIKI_PLAN_SYSTEM_PROMPT, prompt: call, maxTokens: WIKI_PLAN_SERVER_JOB.maxTokens };
      const queueStep = `plan_${step.replaceAll('-', '_')}`;
      let answer: string;
      try {
        const row = await this.context.ask(queueStep, `a${attempt}/${wikiPlanFileName(unit)}@${wikiModelRequestSha256(request).slice(0, 12)}`, request);
        answer = row.answer ?? '';
      } catch (error) {
        if (error instanceof WikiJobContentError) throw new WikiPlanUnitError(`${step} ${unit}: ${error.message}`);
        throw error;
      }
      if (!parses || parses(answer)) return answer;
      last = 'the answer does not follow the format it was asked for';
      call += NEEDS_FORMAT;
      this.say(`${step} ${unit}: ${last}; asking again.`);
    }
    throw new WikiPlanUnitError(`${step} ${unit}: ${last}`);
  }

  /** The catalogue's call: when it fails for good the draft has nothing to stand on, and the job ends with why. */
  private async askCatalogue(attempt: number, step: string, unit: string, prompt: string): Promise<WikiPlanCatalogue> {
    try {
      return parseWikiPlanCatalogue(await this.ask(attempt, step, unit, prompt, (text) => parseWikiPlanCatalogue(text) !== null))!;
    } catch (error) {
      if (error instanceof WikiPlanUnitError) throw new WikiPlanStop(error.message);
      throw error;
    }
  }

  /** A unit's call that failed for good leaves the unit without what it would have written; anything else stops the run. */
  private unitFailure(error: unknown): void {
    if (!(error instanceof WikiPlanUnitError)) throw error;
    this.say(error.message);
  }

  /** `call` for 0..n-1, `concurrency` at a time; every call runs, and the first error that stops the run is answered. */
  private async parallel(n: number, call: (i: number) => Promise<void>): Promise<void> {
    const width = Math.max(1, this.deps.concurrency ?? WIKI_PLAN_SERVER_JOB.concurrency);
    let next = 0;
    let first: unknown = null;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= n) return;
        try {
          await call(i);
        } catch (error) {
          if (first === null) first = error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, n) }, () => worker()));
    if (first !== null) throw first;
  }

  // ── The first draft ─────────────────────────────────────────────────────────────────────────────

  /** Round 1: the four steps of a draft, or a revision's catalogue and rewrites. */
  private async firstDraft(): Promise<void> {
    if (this.kind === 'revise' && this.base) return this.revise(1);
    return this.draft(1);
  }

  /** The sample's four steps: the catalogue's skeleton; each category's documents in detail; each document's outline, beside the rules' draft. */
  private async draft(attempt: number): Promise<void> {
    this.say('Step 1 of 4: the catalogue.');
    await this.progress({ attempt, step: 'skeleton' });
    this.adoptCatalogue(await this.askCatalogue(attempt, 'skeleton', 'catalogue', `${wikiPlanFullMaterials(this)}\n${wikiPlanSkeletonPrompt(this)}`), false);
    this.say(`The catalogue: ${this.cats.length} categories, ${this.units.length} documents.`);
    await this.catalogueToTarget(attempt);
    const rules = this.ask(attempt, 'rules', 'rules', wikiPlanRulesPrompt(this))
      .then((text) => {
        this.rules = text;
        return null;
      }, (error: unknown) => error);
    let bodies: unknown = null;
    try {
      await this.writeBodies(attempt, this.units);
    } catch (error) {
      bodies = error;
    }
    const rulesError = await rules;
    if (bodies !== null) throw bodies;
    if (rulesError !== null) {
      if (!(rulesError instanceof WikiPlanUnitError)) throw rulesError;
      this.say(`Step 4 of 4: the rules draft was not written (${rulesError.message}); the plan does not need it.`);
    }
  }

  /**
   * A draft's catalogue outside the target, sent back with the gate's own count error before any document's body is
   * written for it (the runner's wikiPlanCountTries, 2). A revision's is left to the gate.
   */
  private async catalogueToTarget(attempt: number): Promise<void> {
    if (this.kind === 'revise' && this.base) return;
    for (let tried = 1; tried <= 2; tried += 1) {
      const count = wikiPlanCountError(this.units.length, this.target);
      if (!count) return;
      this.say(`The catalogue has ${this.units.length} documents, outside ${this.target.min}–${this.target.max}: written again before any document of it (${tried} of 2).`);
      await this.redoCatalogue(attempt, `catalogue-count-${tried}`, [count], emptyAssembled());
      this.say(`The catalogue: ${this.cats.length} categories, ${this.units.length} documents.`);
    }
  }

  /** The given documents' bodies: their categories' details (step 2), then each one's outline (step 3); or, in a revision, each one's rewrite. */
  private async writeBodies(attempt: number, units: readonly WikiPlanUnit[]): Promise<void> {
    if (units.length === 0) return;
    if (this.kind === 'revise' && this.base) return this.rewrite(attempt, units);
    this.say(`Step 2 of 4: ${count(units.length, 'document', 'documents')} in detail.`);
    await this.progress({ attempt, step: 'details' });
    const byCat = new Map<number, WikiPlanUnit[]>();
    for (const unit of units) byCat.set(unit.cat, [...(byCat.get(unit.cat) ?? []), unit]);
    const cats = [...byCat.keys()];
    const catalogue = wikiPlanCatalogueText(this);
    const prefix = `${wikiPlanDetailMaterials(this)}\n# 文档目录\n${catalogue}\n`;
    await this.parallel(cats.length, async (i) => {
      const c = cats[i];
      const ids = byCat.get(c)!.map((unit) => unit.id);
      try {
        const answer = await this.ask(attempt, 'details', `${c + 1}-${ids.join('_')}`, prefix + wikiPlanDetailPrompt(this, c, ids), (text) => parseWikiPlanDetails(text).size > 0);
        const details = parseWikiPlanDetails(answer);
        for (const unit of byCat.get(c)!) {
          const header = details.get(unit.id);
          if (header) unit.header = header;
        }
      } catch (error) {
        this.unitFailure(error);
      }
    });
    this.say(`Step 3 of 4: the outlines of ${count(units.length, 'document', 'documents')}.`);
    await this.progress({ attempt, step: 'outlines' });
    const refs = this.currentRefs();
    await this.parallel(units.length, async (i) => {
      const unit = units[i];
      try {
        const answer = await this.ask(attempt, 'outline', unit.slug,
          `${wikiPlanDocMaterials(this, unit)}\n# 文档目录\n${catalogue}\n${wikiPlanOutlinePrompt(unit)}`,
          (text) => parseWikiPlanDocBody(text).sections.length > 0);
        const { sections, stray } = parseWikiPlanDocBody(answer);
        unit.sections = sections;
        unit.stray = stray;
        unit.hasBody = true;
        unit.refs = refs;
      } catch (error) {
        this.unitFailure(error);
      }
    });
  }

  adoptCatalogue(catalogue: WikiPlanCatalogue, revision: boolean): void {
    wikiPlanAdoptCatalogue(this, catalogue, revision);
  }

  /** The catalogue as it stands, number → slug: what a body written now means by `见 3.2`. */
  private currentRefs(): Map<string, string> {
    return new Map(this.units.map((unit) => [unit.id, unit.slug]));
  }

  // ── A revision ──────────────────────────────────────────────────────────────────────────────────

  /** A revision's first round: the new catalogue, then the documents that merge or are new, written again. */
  private async revise(attempt: number): Promise<void> {
    this.say(`Revising version ${this.base!.version} with the owner's instructions: the new catalogue.`);
    await this.progress({ attempt, step: 'revise-catalogue' });
    this.adoptCatalogue(await this.askCatalogue(attempt, 'revise-catalogue', 'catalogue', wikiPlanRevisionCataloguePrompt(this, [], '')), true);
    const rewrite = this.units.filter((unit) => unit.protectedDoc === null && unit.kept === null);
    this.say(`The new catalogue: ${this.cats.length} categories, ${this.units.length} documents; ${this.units.length - rewrite.length} carried as they were, ${rewrite.length} to write again.`);
    await this.rewrite(attempt, rewrite);
  }

  /** The documents of a revision that merge, are new, or take moved sections, written again. */
  private async rewrite(attempt: number, units: readonly WikiPlanUnit[]): Promise<void> {
    await this.progress({ attempt, step: 'rewrite' });
    const catalogue = wikiPlanCatalogueText(this);
    const refs = this.currentRefs();
    await this.parallel(units.length, async (i) => {
      const unit = units[i];
      try {
        const answer = await this.ask(attempt, 'revise-doc', unit.slug, wikiPlanRewritePrompt(this, unit, catalogue), (text) => parseWikiPlanDocBody(text).sections.length > 0);
        const { header, sections, stray } = parseWikiPlanDocBody(answer);
        Object.assign(unit, { header, sections, stray, hasBody: true, refs, kept: null });
      } catch (error) {
        this.unitFailure(error);
      }
    });
  }

  // ── Another round ───────────────────────────────────────────────────────────────────────────────

  /**
   * What the gates found handed back to the model: the catalogue's errors to a catalogue it writes again, each
   * document's to that document. A protected document is never written again.
   */
  private async redo(attempt: number, errs: readonly WikiPlanGateError[], last: WikiPlanAssembled): Promise<void> {
    const byUnit = new Map<WikiPlanUnit, WikiPlanGateError[]>();
    const catalogue: WikiPlanGateError[] = [];
    for (const e of errs) {
      const i = wikiPlanDocIndex(e.path);
      if (i !== null && !wikiPlanCatalogueLevel(e.path) && i < last.units.length && last.units[i].protectedDoc === null) {
        byUnit.set(last.units[i], [...(byUnit.get(last.units[i]) ?? []), e]);
        continue;
      }
      catalogue.push(e);
    }
    if (catalogue.length > 0) {
      this.say(`Round ${attempt}: the catalogue again, for ${count(catalogue.length, 'error', 'errors')}.`);
      await this.redoCatalogue(attempt, 'catalogue', catalogue, last);
      await this.catalogueToTarget(attempt);
    }
    const present = new Set(this.units);
    const write = this.units.filter((unit) => unit.protectedDoc === null && unit.kept === null && !unit.hasBody);
    const fix = [...byUnit.keys()]
      .filter((unit) => (present.has(unit) && unit.hasBody) || (present.has(unit) && unit.kept !== null))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (write.length > 0) {
      this.say(`Round ${attempt}: writing ${count(write.length, 'document', 'documents')} the catalogue now has.`);
      await this.writeBodies(attempt, write);
    }
    if (fix.length === 0) return;
    this.say(`Round ${attempt}: ${count(fix.length, 'document', 'documents')} written again with their errors.`);
    await this.progress({ attempt, step: 'redo' });
    const catalogueText = wikiPlanCatalogueText(this);
    const refs = this.currentRefs();
    await this.parallel(fix.length, async (i) => {
      const unit = fix[i];
      const prompt = `${wikiPlanDocMaterials(this, unit)}\n${wikiPlanRedoDocPrompt(this, unit, byUnit.get(unit)!, last, catalogueText)}`;
      try {
        const answer = await this.ask(attempt, 'redo-doc', unit.slug, prompt, (text) => parseWikiPlanDocBody(text).sections.length > 0);
        const parsed = parseWikiPlanDocBody(answer);
        // A line the answer left out is the line as it stood: what was not wrong need not be written again.
        const header = mergeHeader(parsed.header, headerOf(last, unit));
        Object.assign(unit, { header, sections: parsed.sections, stray: parsed.stray, hasBody: true, refs, kept: null });
      } catch (error) {
        this.unitFailure(error);
      }
    });
  }

  /** The catalogue written again with its errors; its answer is kept as unit's. */
  private async redoCatalogue(attempt: number, unit: string, errs: readonly WikiPlanGateError[], last: WikiPlanAssembled): Promise<void> {
    const lines = wikiPlanErrorLines(errs, last);
    const revision = this.kind === 'revise' && this.base !== null;
    await this.progress({ attempt, step: revision ? 'revise-catalogue' : 'skeleton' });
    const catalogue = revision
      ? await this.askCatalogue(attempt, 'revise-catalogue', unit, wikiPlanRevisionCataloguePrompt(this, errs, lines))
      : await this.askCatalogue(attempt, 'skeleton', unit, `${wikiPlanFullMaterials(this)}\n${wikiPlanCatalogueRedoPrompt(this, lines)}`);
    this.adoptCatalogue(catalogue, revision);
  }

  // ── Submitting it ───────────────────────────────────────────────────────────────────────────────

  /**
   * A draft this job's gate let through, submitted to the server's: the version it became, or the server's errors.
   * It goes under its key, so a replay that submits it again is answered with the version the first stored.
   */
  private async submit(a: WikiPlanAssembled): Promise<{ version: number; refused: WikiPlanGateError[] | null }> {
    const { job } = this.context;
    const request: Record<string, unknown> = {
      baseVersion: this.base?.version ?? null,
      target: { ...this.target },
      plan: a.plan,
      repoCheck: a.repo,
    };
    if (this.deps.model) request.model = this.deps.model;
    request.idempotencyKey = wikiPlanServerDraftKey(this.planJobId, job.id, request);
    try {
      const stored = await this.deps.plans.submitServerDraft({ ownerId: job.ownerId, spaceId: job.spaceId, wikiJobId: job.id }, request);
      if (stored.replayed) this.say(`The server had stored this draft already, as version ${stored.version}: a replay submitted it again.`);
      return { version: stored.version, refused: null };
    } catch (error) {
      if (!(error instanceof WikiRefusalError)) throw error;
      const refusal = error.refusal as { code: string; message: string; errors?: unknown };
      if (refusal.code === 'WIKI_PLAN_GATE') {
        const errors = Array.isArray(refusal.errors) && refusal.errors.length > 0
          ? (refusal.errors as WikiPlanGateError[])
          : [{ check: 'schema', path: 'plan', message: refusal.message } as WikiPlanGateError];
        return { version: 0, refused: errors };
      }
      if (refusal.code === 'WIKI_PLAN_STALE') {
        throw new WikiPlanStop(`the plan changed while the draft was written (${refusal.code}: ${refusal.message}): nothing was stored; the owner asks for another draft`);
      }
      throw new WikiPlanStop(`the server refused the draft (${refusal.code}): ${refusal.message}`);
    }
  }
}

/**
 * A catalogue made the draft's: its categories, and its documents — a document of the same slug as one already
 * written keeping what was written of it. In a revision, a document of the version revised that the catalogue
 * names is carried: a protected one as it is, one made from it alone with its outline, less the sections moved out.
 */
export function wikiPlanAdoptCatalogue(r: WikiPlanRunState, catalogue: WikiPlanCatalogue, revision: boolean): void {
  const previous = new Map<string, WikiPlanUnit>();
  for (const unit of r.units) previous.set(unit.slug, unit);
  // What each document takes in by moves, before and after: a document whose moved sections changed is written again.
  const incoming = (moves: readonly WikiPlanMove[]): Map<string, string> => {
    const out = new Map<string, string>();
    for (const move of moves) if (move.target) out.set(move.target.slug, `${out.get(move.target.slug) ?? ''}${move.from}§${move.section},`);
    return out;
  };
  const before = incoming(r.moves);
  const after = incoming(catalogue.moves);
  r.cats = catalogue.cats;
  r.moves = catalogue.moves;
  r.cats.forEach((cat, i) => {
    // A key the model left out: the category's number, which the owner never sees.
    if (cat.key === '') cat.key = `c${i + 1}`;
  });
  const units: WikiPlanUnit[] = [];
  const kept = new Map<WikiPlanUnit, WikiPlanUnit>();
  for (const card of catalogue.units) {
    let unit = card;
    const old = previous.get(card.slug);
    if (old && sameSources(old.sources, card.sources) && (before.get(card.slug) ?? '') === (after.get(card.slug) ?? '')) {
      old.cat = card.cat;
      old.title = card.title;
      old.question = card.question;
      old.cardScope = card.cardScope;
      old.sources = card.sources;
      old.stray = card.stray;
      unit = old;
      kept.set(card, old);
    }
    units.push(unit);
  }
  for (const move of r.moves) {
    const old = move.target ? kept.get(move.target) : undefined;
    if (old) move.target = old;
  }
  r.units = units;
  wikiPlanNumber(r);
  const receives = new Set<WikiPlanUnit>();
  for (const move of r.moves) if (move.target) receives.add(move.target);
  for (const unit of r.units) {
    const base = r.baseDocs.get(unit.slug);
    if (base?.protected) {
      unit.protectedDoc = wikiPlanDocInput(base);
      unit.kept = null;
      unit.hasBody = true;
      continue;
    }
    unit.protectedDoc = null;
    if (!revision || unit.hasBody) continue;
    unit.kept = null;
    unit.keptDrop = null;
    if (unit.sources.length === 1 && !receives.has(unit)) {
      const slug = r.baseIds.get(unit.sources[0]);
      if (slug !== undefined) {
        unit.kept = r.baseDocs.get(slug)!;
        unit.keptDrop = new Set();
        unit.refs = r.baseIds;
        for (const move of r.moves) if (move.from === unit.sources[0]) unit.keptDrop.add(move.section);
      }
    }
  }
}

/**
 * The files whose text the gate will read to settle a symbol of the round's draft (WikiPlanRepo.textsWantedFor):
 * every code source of every document — a protected one's and a kept one's too, whose references the repository
 * check reports — in Go's byte order.
 */
export function wikiPlanTextsWanted(r: Pick<WikiPlanRunState, 'repo' | 'units'>): string[] {
  const wanted = new Set<string>();
  const collect = (code: WikiPlanSources['code']): void => {
    for (const c of code) {
      if (!r.repo.hasPath(c.path)) continue;
      for (const symbol of c.symbols) for (const file of r.repo.textsWantedFor(c.path, symbol)) wanted.add(file);
    }
  };
  for (const unit of r.units) {
    if (unit.protectedDoc) for (const s of unit.protectedDoc.sections) collect(s.sources.code);
    else if (unit.kept) for (const s of wikiPlanDocInput(unit.kept).sections) collect(s.sources.code);
    else for (const s of unit.sections) collect(s.code);
  }
  return [...wanted].sort(goCompare);
}

function emptyAssembled(): WikiPlanAssembled {
  return { plan: { categories: [], docs: [] }, units: [], errors: [], repo: { sha: '', checked: 0, missing: [] }, sections: 0, slugIds: new Map() };
}

function frameOf(raw: unknown): WikiPlanFrame | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const frame = raw as Partial<WikiPlanFrame>;
  if (typeof frame.sha !== 'string' || typeof frame.date !== 'string' || !frame.materials || typeof frame.materials !== 'object') return null;
  return { sha: frame.sha, date: frame.date, materials: frame.materials, texts: (frame.texts ?? {}) as Record<string, string> };
}

function sameSources(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** A document's header as the last round assembled it, in the line format's terms, its scope-out targets as the numbers they had. */
function headerOf(a: WikiPlanAssembled, unit: WikiPlanUnit): WikiPlanHeader {
  const i = a.units.indexOf(unit);
  if (i < 0) {
    return { title: unit.title, question: unit.question, audience: [], scopeIn: unit.cardScope, scopeOut: [], length: '', keyDocs: [], keyCode: [], keyContracts: [], topics: [], projects: [] };
  }
  const doc = a.plan.docs[i];
  const h: WikiPlanHeader = {
    title: doc.title, question: doc.question, audience: doc.audience, scopeIn: doc.scopeIn, scopeOut: [], length: '',
    keyDocs: [], keyCode: [], keyContracts: [], topics: [], projects: [],
  };
  for (const out of doc.scopeOut) {
    const ids = out.docs.flatMap((slug) => (a.slugIds.has(slug) ? [a.slugIds.get(slug)!] : []));
    h.scopeOut.push(ids.length > 0 ? `${out.text}（见 ${ids.join('、')}）` : out.text);
  }
  if (doc.length.min > 0) h.length = `${doc.length.min}–${doc.length.max} 字`;
  return h;
}

/** A header written again, each field it left out taken from the one before. */
function mergeHeader(next: WikiPlanHeader, prev: WikiPlanHeader): WikiPlanHeader {
  return {
    ...next,
    title: next.title !== '' ? next.title : prev.title,
    question: next.question !== '' ? next.question : prev.question,
    audience: next.audience.length > 0 ? next.audience : prev.audience,
    scopeIn: next.scopeIn.length > 0 ? next.scopeIn : prev.scopeIn,
    scopeOut: next.scopeOut.length > 0 ? next.scopeOut : prev.scopeOut,
    length: next.length !== '' ? next.length : prev.length,
  };
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

function checksLine(checks: Record<string, number>): string {
  return Object.keys(checks).sort(goCompare).map((name) => `${name} ${checks[name]}`).join(', ');
}

function errorLine(e: WikiPlanGateError | undefined): string {
  return e ? `[${e.check}] ${e.path}: ${e.message}` : '';
}
