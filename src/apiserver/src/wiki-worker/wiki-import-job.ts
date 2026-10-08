import { createHash } from 'node:crypto';
import { WIKI_IMPORT_JOB, WIKI_IMPORT_RULES, type WikiOpOutcome } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { wikiImportPrincipal } from '../wiki/wiki-import';
import { WikiRefusalError, type WikiProposeInput, type WikiService } from '../wiki/wiki.service';
import { WikiJobContentError, type WikiJobContext, type WikiJobRunner } from './wiki-job-executor';
import { writeWikiJobProgress } from './wiki-jobs';
import {
  buildWikiImportOps,
  cutRunes,
  goJson,
  goTrimSpace,
  mergeWikiImportRetry,
  parseWikiImportAnswer,
  WIKI_IMPORT_SYSTEM_PROMPT,
  wikiImportNoteLanguage,
  wikiImportPrompt,
  wikiImportRetrySuffix,
  WikiImportRepo,
  type WikiImportBuilt,
  type WikiImportNote,
  type WikiImportOp,
} from './wiki-import-extract';
import {
  readWikiRepoOp,
  readWikiRepoReadiness,
  readWikiRepoSnapshot,
  waitForWikiRepoOp,
  WikiRepoOpRefused,
  WikiRepoOpWaitTimedOut,
  type WikiRepoOps,
  type WikiRepoOpWake,
} from './wiki-repo-ops';

/**
 * The server's import (contracts/wiki.contract.json `import.server` and `jobs.kindRuns.import`, design §2.2 and
 * §8, P5): what `orbit wiki import` did on the runner after it registered its notes, done by the wiki-worker
 * with the System model.
 *
 * THE COMMAND STILL OWNS THE FILES. It lists them, reads their frontmatter, registers each as a note
 * (`import.note`) and remembers on its machine how far it has taken each (`import.cli.resume`); what it hands
 * this job is the notes, in the order it would have read them, each either to be read or carrying the ops an
 * earlier run found in it and has not proposed yet. The job's report is what the command prints and what it
 * writes back into its memory — so a run picks up where the last one stopped whichever of the two paths ran it.
 *
 * ONE RUN, AS THE RUNNER RAN IT. Notes are read a wave at a time (the command's --concurrency) until the run's
 * ops are found (--max-ops, at most rules.opsPerRun); each read is one call through the queue (step `import`,
 * unit the note), checked, and asked once more with what did not hold up (step `import_retry`). The anchors are
 * held to the space's snapshot of origin/main rather than to a checkout. Then one dry run, and the ops that
 * passed it proposed with origin import under a key made of the space and the ops; from the first op refused
 * for room — WIKI_QUOTA, WIKI_REVIEW_QUEUE_FULL — the rest wait for a later run (`import.cli.batches`).
 *
 * A REPLAY ASKS NOTHING TWICE. A job taken over after its worker died, or retried after the model was away,
 * starts from the beginning: each read meets the request row it already made (modelQueue.identity), the
 * proposal is the same batch under the same key — the server replays its answer — and the snapshot operation
 * is the job's own, by an id made from the job's.
 */

/** One note the command hands the job, in its order. */
export interface WikiImportJobNote {
  /** The note's id, as `import.note` answered it. */
  noteId: string;
  /** The file's path as the command names it: the key of its memory, and what a refusal names. */
  file: string;
  /** YYYY-MM-DD: the note's date, from its frontmatter or the file's time — what a decision defaults to. */
  date: string;
  /** Ops an earlier run found in this note and did not propose, each at its index in that run's list. */
  ops?: Array<{ index: number; body: Record<string, unknown> }>;
}

/** The job's input (`import.server.input`). */
export interface WikiImportJobInput {
  /** The session the command runs in: the changeset is recorded against it, as the runner's proposal was. */
  sessionId: string;
  maxOps: number;
  concurrency: number;
  /** The checkout the command ran in, when it ran in one: a note's absolute path under it is read relative to it. */
  checkoutRoot: string;
  notes: WikiImportJobNote[];
}

/** One op of the report: what an op is, and what became of it. Outcome '' is not proposed yet. */
export interface WikiImportJobReportOp {
  index: number;
  body?: Record<string, unknown>;
  outcome: '' | 'applied' | 'pending' | 'verifying' | 'refused';
  why?: string;
  opId?: string;
  entryId?: string;
}

/** One note of the report: read this run, failed this run, or carrying an earlier run's ops. */
export interface WikiImportJobReportNote {
  file: string;
  noteId: string;
  status: 'read' | 'failed' | 'carried';
  why?: string;
  principles?: number;
  dropped?: number;
  ops: WikiImportJobReportOp[];
}

export interface WikiImportRefusal {
  file: string;
  title: string;
  code: string;
  why: string;
}

/** The run's counts: the command prints these as they are (`import.server.report`). */
export interface WikiImportJobSummary {
  /** The notes handed, and of them the ones the model read this run. */
  notes: number;
  read: number;
  entries: number;
  principles: number;
  dropped: number;
  failed: number;
  proposed: number;
  applied: number;
  pending: number;
  verifying: number;
  refused: number;
  deferred: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  refusals: WikiImportRefusal[];
  stopped: string;
}

export interface WikiImportJobReport {
  kind: 'import';
  /** The System model that read the notes. */
  model: string | null;
  /** The snapshot the anchors were held to; null when there was none, and the anchors were left out. */
  snapshot: { sha: string; fresh: boolean } | null;
  summary: WikiImportJobSummary;
  notes: WikiImportJobReportNote[];
}

/** What the job needs besides its own context. */
export interface WikiImportJobDeps {
  prisma: PrismaService;
  wiki: WikiService;
  repoOps: WikiRepoOps;
  /** The System model's name, for the report and the changeset's rationale. */
  model: string | null;
  repoWake?: WikiRepoOpWake;
  /** How long the job waits for a fresh snapshot; WIKI_IMPORT_JOB.snapshotWaitSeconds unless a test says otherwise. */
  snapshotWaitMs?: number;
}

/** The kind's runner, as the worker module puts it in the executor's map. */
export function wikiImportJobRunner(deps: WikiImportJobDeps): WikiJobRunner {
  return async (context) => (await new WikiImportRun(context, deps).run()) as unknown as Record<string, unknown>;
}

/** The refusals that say nothing about an op but that there is no room for it now (`import.cli.batches`). */
const ROOM_CODES = new Set(['WIKI_QUOTA', 'WIKI_REVIEW_QUEUE_FULL']);

/** A ref into the run's queue: the note's place in the report, and the op's in its list. */
interface QueuedOp {
  note: WikiImportJobReportNote;
  op: WikiImportJobReportOp;
}

/** What reading one note came to. */
interface Extraction {
  ops: WikiImportOp[];
  principles: number;
  dropped: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** The model answered, and nothing it said could be read: the note is not read again. */
  failed: string;
}

class WikiImportRun {
  private readonly input: WikiImportJobInput;
  private readonly report: WikiImportJobReport;
  private readonly queue: QueuedOp[] = [];
  private repo: WikiImportRepo | null = null;

  constructor(private readonly context: WikiJobContext, private readonly deps: WikiImportJobDeps) {
    this.input = readWikiImportJobInput(context.job.input);
    this.report = {
      kind: 'import',
      model: deps.model,
      snapshot: null,
      summary: {
        notes: this.input.notes.length, read: 0, entries: 0, principles: 0, dropped: 0, failed: 0, proposed: 0, applied: 0,
        pending: 0, verifying: 0, refused: 0, deferred: 0, calls: 0, inputTokens: 0, outputTokens: 0, refusals: [], stopped: '',
      },
      notes: [],
    };
  }

  async run(): Promise<WikiImportJobReport> {
    const texts = await this.notes();
    if (this.input.notes.some((note) => !note.ops?.length && texts.has(note.noteId))) {
      await this.progress('snapshot');
      await this.snapshot();
    }
    await this.collect(texts);
    await this.progress('proposing');
    await this.propose();
    return this.report;
  }

  /** The notes' texts as the server kept them — what the model reads, and what a quote is checked against. */
  private async notes(): Promise<Map<string, { path: string; text: string }>> {
    const { job } = this.context;
    const rows = await this.deps.prisma.wikiNote.findMany({
      where: { ownerId: job.ownerId, spaceId: job.spaceId, id: { in: this.input.notes.map((note) => note.noteId) } },
      select: { id: true, path: true, text: true },
    });
    return new Map(rows.map((row) => [row.id, { path: row.path, text: row.text }]));
  }

  /**
   * The repository the anchors are held to (contract `import.server.snapshot`): a fresh snapshot of origin/main
   * when the space's runner can take one now, waited for at most WIKI_IMPORT_JOB.snapshotWaitSeconds; else the
   * snapshot the space already holds; else none, and the anchors are left out.
   */
  private async snapshot(): Promise<void> {
    const { job, signal } = this.context;
    const { prisma } = this.deps;
    let asked: { sha: string } | null = null;
    const readiness = await readWikiRepoReadiness(prisma, { ownerId: job.ownerId, spaceId: job.spaceId });
    if (readiness.look === 'ready') {
      const opId = wikiImportSnapshotOpId(job.id);
      try {
        if (!(await readWikiRepoOp(prisma, { id: opId, ownerId: job.ownerId }))) {
          const held = await readWikiRepoSnapshot(prisma, { ownerId: job.ownerId, spaceId: job.spaceId });
          await this.deps.repoOps.enqueueWikiRepoOp({ id: opId, jobId: job.id, kind: 'snapshot', input: { skipSha: held?.sha ?? null } });
        }
        const settled = await waitForWikiRepoOp(prisma, {
          id: opId,
          ownerId: job.ownerId,
          timeoutMs: this.deps.snapshotWaitMs ?? WIKI_IMPORT_JOB.snapshotWaitSeconds * 1000,
          wake: this.deps.repoWake,
          signal,
        });
        if (settled.state === 'succeeded' && typeof settled.result?.sha === 'string') asked = { sha: settled.result.sha };
        else this.context.log(`the snapshot ${settled.state}: ${settled.error ?? ''} — the anchors are held to the snapshot the space holds`);
      } catch (error) {
        if (!(error instanceof WikiRepoOpWaitTimedOut || error instanceof WikiRepoOpRefused)) throw error;
        this.context.log(`no fresh snapshot (${error.message}): the anchors are held to the snapshot the space holds`);
      }
    } else {
      this.context.log(`the space's repository cannot be read now (${readiness.look}): the anchors are held to the snapshot it holds`);
    }
    const snapshot = await readWikiRepoSnapshot(prisma, { ownerId: job.ownerId, spaceId: job.spaceId });
    if (!snapshot) return;
    const index = JSON.parse(snapshot.index) as { files?: Array<{ path?: unknown }>; commits?: unknown[] };
    const space = await prisma.wikiSpace.findFirst({ where: { id: job.spaceId, ownerId: job.ownerId }, select: { repoUrlNorm: true } });
    this.repo = new WikiImportRepo(
      {
        files: (index.files ?? []).map((file) => file.path).filter((path): path is string => typeof path === 'string'),
        commits: (index.commits ?? []).filter((sha): sha is string => typeof sha === 'string'),
      },
      this.input.checkoutRoot,
      wikiImportRepoName(space?.repoUrlNorm ?? null, this.input.checkoutRoot),
    );
    this.report.snapshot = { sha: snapshot.sha, fresh: asked?.sha === snapshot.sha };
  }

  /**
   * The notes in order until this run's ops are found: a note carrying an earlier run's ops has them queued as
   * they are, and the notes to read are read a wave at a time.
   */
  private async collect(texts: Map<string, { path: string; text: string }>): Promise<void> {
    let wave: WikiImportJobNote[] = [];
    for (const note of this.input.notes) {
      if (this.queue.length >= this.input.maxOps) break;
      if (note.ops?.length) {
        // Read before, proposed in part: its ops go in their place, after the notes before it.
        await this.flush(wave, texts);
        wave = [];
        const carried: WikiImportJobReportNote = {
          file: note.file,
          noteId: note.noteId,
          status: 'carried',
          ops: note.ops.map((op) => ({ index: op.index, body: op.body, outcome: '' })),
        };
        this.report.notes.push(carried);
        this.enqueue(carried);
        continue;
      }
      wave.push(note);
      if (wave.length >= this.input.concurrency) {
        await this.flush(wave, texts);
        wave = [];
      }
    }
    await this.flush(wave, texts);
  }

  /** Read a wave of notes at once, and queue what the model found, in note order. */
  private async flush(wave: WikiImportJobNote[], texts: Map<string, { path: string; text: string }>): Promise<void> {
    if (wave.length === 0) return;
    const settled = await Promise.allSettled(wave.map((note) => {
      const kept = texts.get(note.noteId);
      return kept ? this.extract(note, kept) : Promise.resolve(null);
    }));
    // A read the platform could not finish (the model away past the wait limit, the worker stopping) ends the
    // pass: the job is retried, and the reads that did answer are met again, not asked again.
    const thrown = settled.find((one): one is PromiseRejectedResult => one.status === 'rejected');
    if (thrown) throw thrown.reason;
    for (const [i, note] of wave.entries()) {
      const result = (settled[i] as PromiseFulfilledResult<Extraction | null>).value;
      if (!result) {
        this.fail(note, 'the space no longer holds this note');
        continue;
      }
      const summary = this.report.summary;
      summary.calls += result.calls;
      summary.inputTokens += result.inputTokens;
      summary.outputTokens += result.outputTokens;
      if (result.failed !== '') {
        this.fail(note, result.failed);
        continue;
      }
      summary.read += 1;
      summary.entries += result.ops.length;
      summary.principles += result.principles;
      summary.dropped += result.dropped;
      const read: WikiImportJobReportNote = {
        file: note.file,
        noteId: note.noteId,
        status: 'read',
        principles: result.principles,
        dropped: result.dropped,
        ops: result.ops.map((op, index) => ({ index, body: op.body, outcome: '' })),
      };
      this.report.notes.push(read);
      this.enqueue(read);
    }
    await this.progress('reading');
  }

  private fail(note: WikiImportJobNote, why: string): void {
    this.report.summary.failed += 1;
    this.report.notes.push({ file: note.file, noteId: note.noteId, status: 'failed', why, ops: [] });
  }

  /** A note's ops that have not been proposed, up to what the run has room for. */
  private enqueue(note: WikiImportJobReportNote): void {
    for (const op of note.ops) {
      if (this.queue.length >= this.input.maxOps) return;
      if (op.outcome === '') this.queue.push({ note, op });
    }
  }

  /** Have the model read one note, and turn its answer into ops — asking once more, with what was wrong, when it does not hold up. */
  private async extract(input: WikiImportJobNote, kept: { path: string; text: string }): Promise<Extraction> {
    const note: WikiImportNote = { id: input.noteId, path: kept.path, date: input.date, text: kept.text, lang: '' };
    note.lang = wikiImportNoteLanguage(note.text);
    const prompt = wikiImportPrompt(note);
    const result: Extraction = { ops: [], principles: 0, dropped: 0, calls: 0, inputTokens: 0, outputTokens: 0, failed: '' };
    const first = await this.ask(WIKI_IMPORT_JOB.steps.read, note.id, prompt, result);
    if (first === null) return result;
    let entries = parseWikiImportAnswer(first);
    let built: WikiImportBuilt = buildWikiImportOps(entries ?? [], note, this.repo);
    if (entries === null || built.problems.length > 0) {
      const again = await this.ask(WIKI_IMPORT_JOB.steps.retry, note.id, prompt + wikiImportRetrySuffix(first, entries !== null, built), result);
      if (again === null) return result;
      const more = parseWikiImportAnswer(again);
      if (more !== null) {
        if (entries !== null) mergeWikiImportRetry(built, buildWikiImportOps(more, note, this.repo));
        else {
          // The first answer held nothing to read: the second is the whole answer.
          built = buildWikiImportOps(more, note, this.repo);
          entries = more;
        }
      }
    }
    if (entries === null) {
      result.failed = "the model's answer held no JSON array of entries";
      return result;
    }
    result.ops = built.ops;
    result.principles = built.principles;
    result.dropped = built.dropped;
    if (result.ops.length > WIKI_IMPORT_RULES.entriesPerNote) {
      result.dropped += result.ops.length - WIKI_IMPORT_RULES.entriesPerNote;
      result.ops = result.ops.slice(0, WIKI_IMPORT_RULES.entriesPerNote);
    }
    return result;
  }

  /**
   * One read through the queue. A call the queue ended for a reason of its own (the call's budget, a refusal
   * that is no outage) is the note's failure — the runner's "about the file" — and null; one the platform could
   * not finish throws, and the job is retried.
   */
  private async ask(step: string, unit: string, prompt: string, result: Extraction): Promise<string | null> {
    try {
      const row = await this.context.ask(step, unit, { system: WIKI_IMPORT_SYSTEM_PROMPT, prompt, maxTokens: WIKI_IMPORT_JOB.maxTokens });
      result.calls += 1;
      result.inputTokens += row.inputTokens ?? 0;
      result.outputTokens += row.outputTokens ?? 0;
      return row.answer ?? '';
    } catch (error) {
      if (!(error instanceof WikiJobContentError)) throw error;
      result.calls += 1;
      result.failed = `the model gave no answer for it: ${error.message}`;
      return null;
    }
  }

  /** Check the run's ops with a dry run, and propose the ones that passed, up to the first that has no room. */
  private async propose(): Promise<void> {
    const refs = this.queue.slice(0, this.input.maxOps);
    if (refs.length === 0) return;
    const summary = this.report.summary;
    const dry = await this.send(refs, true);
    const sendable: QueuedOp[] = [];
    let room = '';
    for (const [i, ref] of refs.entries()) {
      const outcome = outcomeAt(dry, i);
      if (outcome.status === 'refused' || outcome.status === 'conflict') {
        const [code, why] = reasonOf(outcome);
        if (ROOM_CODES.has(code)) {
          room = `${code}: ${why}`;
          summary.deferred += refs.length - i;
          break;
        }
        this.refuse(ref, code, why);
        continue;
      }
      sendable.push(ref);
    }
    if (sendable.length === 0) {
      if (room !== '') {
        summary.stopped = `no room to propose anything now (${room}): the owner decides what waits in Review, `
          + 'or another session carries on, before the import can go on';
      }
      return;
    }
    const answer = await this.send(sendable, false);
    for (const [i, ref] of sendable.entries()) {
      const outcome = outcomeAt(answer, i);
      if (outcome.status === 'applied') {
        ref.op.outcome = 'applied';
        summary.applied += 1;
      } else if (outcome.status === 'pending') {
        if (outcome.waitsFor === 'verification') {
          ref.op.outcome = 'verifying';
          summary.verifying += 1;
        } else {
          ref.op.outcome = 'pending';
          summary.pending += 1;
        }
      } else {
        const [code, why] = reasonOf(outcome);
        if (ROOM_CODES.has(code)) {
          // Room the dry run saw was taken since: the op waits for a later run.
          summary.deferred += 1;
          continue;
        }
        this.refuse(ref, code, why);
        continue;
      }
      if (outcome.opId) ref.op.opId = outcome.opId;
      if (outcome.entryId) ref.op.entryId = outcome.entryId;
      summary.proposed += 1;
    }
  }

  private refuse(ref: QueuedOp, code: string, why: string): void {
    ref.op.outcome = 'refused';
    ref.op.why = goTrimSpace(`${code}: ${why}`);
    this.report.summary.refused += 1;
    const entry = ref.op.body?.entry as Record<string, unknown> | undefined;
    this.report.summary.refusals.push({ file: ref.note.file, title: typeof entry?.title === 'string' ? entry.title : '', code, why });
  }

  /**
   * Propose the ops (or check them, dryRun) as the calling session, origin import: one changeset, under a key
   * made of the space and the ops, so the same batch sent again — a replay of this job — is recorded once.
   */
  private async send(refs: QueuedOp[], dryRun: boolean): Promise<WikiOpOutcome[]> {
    const { job } = this.context;
    const ops = refs.map((ref) => ref.op.body as Record<string, unknown>);
    const files: string[] = [];
    for (const ref of refs) if (!files.includes(ref.note.file)) files.push(ref.note.file);
    const body: WikiProposeInput = {
      ops,
      rationale: wikiImportRationale(this.deps.model, files, ops.length),
      ...(dryRun ? { dryRun: true } : { idempotencyKey: wikiImportIdempotencyKey(job.spaceId, ops) }),
    };
    try {
      const answer = await this.deps.wiki.submitChangeset(wikiImportPrincipal(job.ownerId, this.input.sessionId), job.spaceId, body);
      return Array.isArray(answer.ops) ? (answer.ops as WikiOpOutcome[]) : [];
    } catch (error) {
      // A refusal of the whole request — not of an op — is no answer this run can go on from.
      if (error instanceof WikiRefusalError) {
        throw new WikiJobContentError(`the import's proposal was refused: ${error.refusal.code}: ${error.refusal.message}`);
      }
      throw error;
    }
  }

  private async progress(step: 'snapshot' | 'reading' | 'proposing'): Promise<void> {
    const { job } = this.context;
    const summary = this.report.summary;
    await writeWikiJobProgress(this.deps.prisma, {
      id: job.id,
      generation: job.leaseGeneration,
      progress: { step, notes: summary.notes, read: summary.read, failed: summary.failed, ops: this.queue.length },
    });
  }
}

/** The outcome of the op at seq, whichever order the answer lists them in. */
function outcomeAt(ops: WikiOpOutcome[], seq: number): WikiOpOutcome {
  return ops.find((op) => op.seq === seq)
    ?? { seq, status: 'refused', reasons: [{ code: '' as never, message: 'the server answered nothing for it' }] };
}

function reasonOf(outcome: WikiOpOutcome): [string, string] {
  if (outcome.status === 'conflict') return ['WIKI_REVISION_CONFLICT', 'the entry moved since'];
  if (outcome.status === 'refused') {
    const first = outcome.reasons[0];
    if (first) return [first.code ?? '', first.message ?? ''];
  }
  return ['', 'refused'];
}

/** The changeset's rationale: what was read, and by which model (contract `import.server.propose`). */
export function wikiImportRationale(model: string | null, files: readonly string[], ops: number): string {
  const names = files.length > 5 ? [...files.slice(0, 5), `and ${files.length - 5} more`] : [...files];
  return cutRunes(
    `orbit wiki import: ${count(ops, 'entry', 'entries')} the System model (${model ?? 'unnamed'}) read in `
      + `${count(files.length, 'note', 'notes')}: ${names.join(', ')}`,
    1000,
  );
}

/** The key a batch is proposed under: the space and the ops, so the same batch is the same key (Go's form of the ops). */
export function wikiImportIdempotencyKey(spaceId: string, ops: readonly unknown[]): string {
  return `wiki-import:${createHash('sha256').update(`${spaceId}\n${goJson(ops)}`).digest('hex').slice(0, 40)}`;
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** The repository's name for a note's absolute paths: the space's repository's last segment, else the checkout's. */
export function wikiImportRepoName(repoUrlNorm: string | null, checkoutRoot: string): string {
  const from = (value: string): string => value.replace(/\/+$/u, '').split('/').pop()?.replace(/\.git$/u, '') ?? '';
  if (repoUrlNorm) return from(repoUrlNorm);
  return checkoutRoot === '' ? '' : from(checkoutRoot);
}

/** The id of the job's own snapshot operation: one per job, so a replay meets the operation it already made. */
export function wikiImportSnapshotOpId(jobId: string): string {
  const hex = createHash('sha256').update(`wiki-import-snapshot:${jobId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The job's input as its row holds it, checked again where it is used: the route checked it on the way in,
 * and a row that does not read this way is one no run of this build can finish (a content failure).
 */
export function readWikiImportJobInput(raw: Record<string, unknown>): WikiImportJobInput {
  const wrong = (what: string): never => {
    throw new WikiJobContentError(`the import job's input is not one this build reads: ${what}`);
  };
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : wrong('sessionId');
  const maxOps = Number.isInteger(raw.maxOps) && (raw.maxOps as number) >= 1 && (raw.maxOps as number) <= WIKI_IMPORT_RULES.opsPerRun
    ? (raw.maxOps as number)
    : wrong('maxOps');
  const concurrency = Number.isInteger(raw.concurrency) && (raw.concurrency as number) >= 1
    && (raw.concurrency as number) <= WIKI_IMPORT_JOB.maxConcurrency
    ? (raw.concurrency as number)
    : wrong('concurrency');
  const checkoutRoot = typeof raw.checkoutRoot === 'string' ? raw.checkoutRoot : '';
  if (!Array.isArray(raw.notes)) wrong('notes');
  const notes = (raw.notes as unknown[]).map((note): WikiImportJobNote => {
    const one = (note ?? {}) as Record<string, unknown>;
    if (typeof one.noteId !== 'string' || typeof one.file !== 'string' || typeof one.date !== 'string') return wrong('notes[]');
    const ops = Array.isArray(one.ops)
      ? (one.ops as Array<Record<string, unknown>>).map((op) => ({ index: Number(op?.index), body: (op?.body ?? {}) as Record<string, unknown> }))
      : undefined;
    return { noteId: one.noteId, file: one.file, date: one.date, ...(ops ? { ops } : {}) };
  });
  return { sessionId, maxOps, concurrency, checkoutRoot, notes };
}
