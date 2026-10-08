import { createHash } from 'node:crypto';
import { WIKI_DOC_BUILD_RULES, WIKI_DOCS_BUILD_JOB, type WikiDocMaterialRecord, type WikiDocSectionStats, type WikiDocSentenceCounts } from '@orbit/shared';
import { goTrimSpace } from './wiki-import-extract';
import {
  WIKI_DOCS_BUILD_SYSTEM_PROMPT,
  wikiDocActionLine,
  wikiDocApplyMerge,
  wikiDocBodyOf,
  wikiDocCleanPath,
  wikiDocDispositions,
  wikiDocEndOnlyNote,
  wikiDocEndOnlyParagraphs,
  wikiDocFilter,
  wikiDocFingerprint,
  wikiDocFootnotes,
  wikiDocFootnoteWire,
  wikiDocHanded,
  wikiDocIsRepoKind,
  wikiDocMergePrompt,
  wikiDocOverviewFingerprint,
  wikiDocOverviewFootnotes,
  wikiDocOverviewMaterial,
  wikiDocOverviewPrompt,
  wikiDocParseQuotes,
  wikiDocParseWritten,
  wikiDocPiece,
  wikiDocQuoteRepairPrompt,
  wikiDocRepoPieces,
  wikiDocSelect,
  wikiDocStripHeading,
  wikiDocUnfoundCitations,
  wikiDocWritePrompt,
  type WikiDocFootnote,
  type WikiDocPiece,
  type WikiDocRepo,
  type WikiDocsPlanDoc,
  type WikiDocViewForOverview,
  type WikiDocWrittenSection,
} from './wiki-docs-writer';

/**
 * One build of a space's documents (contracts/wiki.contract.json `docs.build`, `docs.build.server`; design §8, P7):
 * `runWikiDocsBuild` in src/runner-go/wiki_docs_build.go, run on the server over what the job hands it.
 *
 * EACH DOCUMENT IN THE PLAN'S ORDER; IN EACH, ITS SECTIONS `docs.build.rules.parallel` AT A TIME, THE OVERVIEW LAST.
 * A section gathers its material — the repository's half from the files its sources name at the run's commit, the
 * server's half from its session condition — filters, caps and fingerprints it, and is left as it is when the
 * fingerprint is the one stored and nothing of it was withdrawn: the model is not asked at all. Otherwise one call
 * merges the pieces, one writes the section, a paragraph that marks only its last sentence is asked for once more,
 * a footnote with no quote that holds is asked about once more, and the section is written with its ledger — one
 * write at a time, since each classifies the whole document again. The overview is written from the others as they
 * are written. All of it is the Go file's, function for function (wiki-docs-writer.ts).
 *
 * WHAT A FAILURE IS. A call that ended in a way that is the call's (`WikiDocsCallFailed`) or a write the server
 * refused (`WikiDocsWriteRefused`) fails the section, and the run goes on to the next, as the runner's did. Anything
 * else — the queue's wait limit, the worker stopping, the database — stops the run: the sections in flight finish,
 * nothing new is started, and the error is the caller's, so the job is tried again and the sections already
 * written are left as they are by their fingerprints.
 */

/** A call whose own failure the section answers for (the model request ended failed): the section fails, the run goes on. */
export class WikiDocsCallFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikiDocsCallFailed';
  }
}

/** A write the server refused (WIKI_DOC_INVALID, WIKI_PLAN_STALE, …): the section fails with why, the run goes on. */
export class WikiDocsWriteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikiDocsWriteRefused';
  }
}

/** What the server holds of one section: its fingerprint, and whether it waits to be rewritten. */
export interface WikiDocsStoredSection {
  materialSha256: string;
  stale: boolean;
}

/** One write, as `POST …/docs/:slug` takes it (contract `docs.requests.write`). */
export interface WikiDocsWriteRequest {
  planVersion: number;
  repoSha: string;
  model?: string;
  sections: Array<{
    key: string;
    materialSha256: string;
    markdown: string;
    footnotes: Array<Record<string, unknown>>;
    dispositions: ReturnType<typeof wikiDocDispositions>;
  }>;
}

/** The write's answer, as far as a run reports it. */
export interface WikiDocsWriteAnswer {
  status: string;
  sections: Array<{ key: string; outcome: string; stats: WikiDocSectionStats | null }>;
  counts: WikiDocSentenceCounts | Record<string, number>;
}

/** What a build is handed: the repository, the server's reads and write, and the model. */
export interface WikiDocsBuildDeps {
  /** The checkout at the run's one commit. */
  repo: WikiDocRepo;
  /** Read the files these paths name before they are shown (the server reads through the space's runner). */
  prepare(paths: readonly string[]): Promise<void>;
  /** The server's half of a section's material: the records its session condition finds, redacted and placed. */
  material(doc: WikiDocsPlanDoc, key: string): Promise<{ records: WikiDocMaterialRecord[]; unresolved: Array<{ kind: string; ref: string }> }>;
  /** One document as it is written, for an overview over sections this run left as they are. */
  view(slug: string): Promise<WikiDocViewForOverview | null>;
  /** Write sections of one document; throws WikiDocsWriteRefused when the server refuses it. */
  write(slug: string, request: WikiDocsWriteRequest): Promise<WikiDocsWriteAnswer>;
  /** One model call through the queue; throws WikiDocsCallFailed for a failure that is the call's own. */
  ask(call: { step: string; unit: string; system: string; prompt: string }): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
  /** The System model's name, as each write records it. */
  model: string;
  log(message: string): void;
  /** Aborted when the worker is stopping: no section is started after it. */
  signal?: AbortSignal;
}

export interface WikiDocsBuildOptions {
  spaceId: string;
  planVersion: number;
  docs: WikiDocsPlanDoc[];
  stored: Map<string, Map<string, WikiDocsStoredSection>>;
  /** Only this document (--doc), and of it only this section (--section). */
  doc?: string;
  section?: string;
  /** The sections to take up, by document: a maintenance run's, what its facts touched (absent: every section). */
  only?: Map<string, Set<string>>;
  /** Hears of each document as it is taken up — done of total, and the document — and of the end (doc null). */
  onDoc?(done: number, total: number, doc: WikiDocsPlanDoc | null): Promise<void>;
}

/** One section the run took up (`wikiDocsBuildSectionRun`). */
export interface WikiDocsBuildSectionRun {
  key: string;
  title: string;
  kind: string;
  outcome: 'written' | 'unchanged' | 'failed';
  why?: string;
  materialSha256: string;
  pieces: number;
  actions: Record<string, number>;
  missing?: string[];
  footnotes: { total: number; found: number; noQuote: number };
  calls: number;
  usage: { inputTokens: number; outputTokens: number };
  seconds: number;
  stats?: WikiDocSectionStats | null;
}

export interface WikiDocsBuildDocRun {
  slug: string;
  status?: string;
  counts?: WikiDocsWriteAnswer['counts'];
  sections: WikiDocsBuildSectionRun[];
}

/** What a run did (`wikiDocsBuildSummary`): what the job reports. */
export interface WikiDocsBuildSummary {
  spaceId: string;
  planVersion: number;
  repoSha: string;
  model: string;
  docs: WikiDocsBuildDocRun[];
  written: number;
  unchanged: number;
  failed: number;
  calls: number;
  usage: { inputTokens: number; outputTokens: number };
  seconds: number;
}

/** Write the documents of the confirmed plan — or the one `doc` names, or one section of it — and say what was done. */
export async function runWikiDocsBuild(deps: WikiDocsBuildDeps, options: WikiDocsBuildOptions): Promise<WikiDocsBuildSummary> {
  const started = Date.now();
  const run = new DocsBuildRun(deps, options.planVersion);
  const summary: WikiDocsBuildSummary = {
    spaceId: options.spaceId, planVersion: options.planVersion, repoSha: deps.repo.sha, model: deps.model, docs: [],
    written: 0, unchanged: 0, failed: 0, calls: 0, usage: { inputTokens: 0, outputTokens: 0 }, seconds: 0,
  };
  let docs = options.docs;
  if (options.doc) docs = docs.filter((doc) => doc.slug === options.doc);
  if (options.only) docs = docs.filter((doc) => (options.only?.get(doc.slug)?.size ?? 0) > 0);
  deps.log(`plan version ${options.planVersion}, ${docs.length === 1 ? '1 document' : `${docs.length} documents`}; the repository at ${deps.repo.sha.slice(0, 12)}`);
  try {
    for (const [i, doc] of docs.entries()) {
      if (deps.signal?.aborted) throw new Error('the build was stopped: the worker is shutting down');
      await options.onDoc?.(i, docs.length, doc);
      const result = await run.document(doc, options.stored.get(doc.slug) ?? new Map(), options.section ?? '', options.only?.get(doc.slug) ?? null);
      summary.docs.push(result);
      for (const section of result.sections) {
        if (section.outcome === 'written') summary.written += 1;
        else if (section.outcome === 'unchanged') summary.unchanged += 1;
        else summary.failed += 1;
      }
    }
    await options.onDoc?.(docs.length, docs.length, null);
    return summary;
  } finally {
    summary.calls = run.calls;
    summary.usage = { ...run.usage };
    summary.seconds = (Date.now() - started) / 1000;
  }
}

class DocsBuildRun {
  calls = 0;
  readonly usage = { inputTokens: 0, outputTokens: 0 };
  /** The writes of the run go one at a time: each classifies its whole document again. */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: WikiDocsBuildDeps, private readonly planVersion: number) {}

  /** One call: counted against the section and the run. */
  private async ask(section: WikiDocsBuildSectionRun, step: string, label: string, prompt: string): Promise<string> {
    const unit = `${label}#${createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 12)}`;
    this.calls += 1;
    section.calls += 1;
    const answer = await this.deps.ask({ step, unit, system: WIKI_DOCS_BUILD_SYSTEM_PROMPT, prompt });
    this.usage.inputTokens += answer.inputTokens;
    this.usage.outputTokens += answer.outputTokens;
    section.usage.inputTokens += answer.inputTokens;
    section.usage.outputTokens += answer.outputTokens;
    return answer.text;
  }

  /**
   * One document (`document`): its sections — every one, `only`, or those `take` names — then its overview, last,
   * taken up with any other section of the document, since it summarizes them.
   */
  async document(doc: WikiDocsPlanDoc, stored: Map<string, WikiDocsStoredSection>, only: string, take: Set<string> | null): Promise<WikiDocsBuildDocRun> {
    const result: WikiDocsBuildDocRun = { slug: doc.slug, sections: [] };
    const body: number[] = [];
    let overviews: number[] = [];
    doc.sections.forEach((section, i) => {
      if (only !== '' && section.key !== only) return;
      if (section.kind === 'overview') overviews.push(i);
      else if (take === null || take.has(section.key)) body.push(i);
    });
    if (take !== null && body.length === 0) overviews = overviews.filter((i) => take.has(doc.sections[i].key));
    const runs: Array<WikiDocsBuildSectionRun | null> = doc.sections.map(() => null);
    const written: Array<WikiDocWrittenSection | null> = doc.sections.map(() => null);
    const fingerprints = doc.sections.map((section) => stored.get(section.key)?.materialSha256 ?? '');
    await pool(body, WIKI_DOC_BUILD_RULES.parallel, this.deps.signal, async (i) => {
      const done = await this.section(doc, i, stored.get(doc.sections[i].key));
      runs[i] = done.run;
      if (done.section) written[i] = done.section;
      if (done.run.outcome !== 'failed') fingerprints[i] = done.run.materialSha256;
      if (done.answer) {
        result.status = done.answer.status;
        result.counts = done.answer.counts;
      }
    });
    for (const i of overviews) {
      if (this.deps.signal?.aborted) throw new Error('the build was stopped: the worker is shutting down');
      const done = await this.overview(doc, i, stored.get(doc.sections[i].key), fingerprints, written);
      runs[i] = done.run;
      if (done.answer) {
        result.status = done.answer.status;
        result.counts = done.answer.counts;
      }
    }
    for (const run of runs) if (run) result.sections.push(run);
    return result;
  }

  private newRun(doc: WikiDocsPlanDoc, index: number): WikiDocsBuildSectionRun {
    const section = doc.sections[index];
    return {
      key: section.key, title: section.title, kind: section.kind, outcome: 'failed', materialSha256: '', pieces: 0, actions: {},
      footnotes: { total: 0, found: 0, noQuote: 0 }, calls: 0, usage: { inputTokens: 0, outputTokens: 0 }, seconds: 0,
    };
  }

  /** Gather, fingerprint, merge, write, check and submit one section that is not an overview (`section`). */
  private async section(doc: WikiDocsPlanDoc, index: number, stored: WikiDocsStoredSection | undefined): Promise<{
    run: WikiDocsBuildSectionRun;
    section: WikiDocWrittenSection | null;
    answer: WikiDocsWriteAnswer | null;
  }> {
    const planSection = doc.sections[index];
    const started = Date.now();
    const run = this.newRun(doc, index);
    const label = `${doc.slug}#${planSection.key}`;
    const fail = (why: string) => {
      run.outcome = 'failed';
      run.why = why;
      run.seconds = (Date.now() - started) / 1000;
      this.deps.log(`${label}: not written — ${why}`);
      return { run, section: null, answer: null };
    };
    const gathered = await this.gather(doc, index);
    const pieces = gathered.pieces;
    run.pieces = pieces.length;
    if (gathered.missing.length > 0) run.missing = gathered.missing;
    wikiDocFilter(pieces);
    wikiDocSelect(planSection.kind, pieces);
    run.materialSha256 = wikiDocFingerprint(planSection, pieces);
    if (stored && stored.materialSha256 === run.materialSha256 && !stored.stale) {
      run.outcome = 'unchanged';
      run.seconds = (Date.now() - started) / 1000;
      this.deps.log(`${label}: its material is the one it was written from (${run.materialSha256.slice(0, 12)}), so it is left as it is.`);
      return { run, section: null, answer: null };
    }
    const handed = wikiDocHanded(pieces);
    let state: string[] = [];
    if (handed.length > 0) {
      let text: string;
      try {
        text = await this.ask(run, WIKI_DOCS_BUILD_JOB.steps.merge, label, wikiDocMergePrompt(doc, index, handed));
      } catch (error) {
        if (error instanceof WikiDocsCallFailed) return fail(`the merge: ${error.message}`);
        throw error;
      }
      state = wikiDocApplyMerge(text, pieces);
    }
    const used = pieces.filter((piece) => piece.action === 'adopt' || piece.action === 'merge');
    const prompt = wikiDocWritePrompt(doc, index, state, used);
    let text: string;
    try {
      text = await this.ask(run, WIKI_DOCS_BUILD_JOB.steps.write, label, prompt);
    } catch (error) {
      if (error instanceof WikiDocsCallFailed) return fail(`the writing: ${error.message}`);
      throw error;
    }
    let draft = wikiDocParseWritten(text);
    // A paragraph that marks only its last sentence is asked for once more, marked sentence by sentence.
    const lonely = wikiDocEndOnlyParagraphs(draft.body);
    if (lonely.length > 0) {
      try {
        const again = wikiDocParseWritten(await this.ask(run, WIKI_DOCS_BUILD_JOB.steps.rewrite, label, prompt + wikiDocEndOnlyNote(lonely)));
        if (again.body !== '' && wikiDocEndOnlyParagraphs(again.body).length < lonely.length) draft = again;
      } catch (error) {
        // The first draft stands, as on the runner when the second call did not answer.
        if (!(error instanceof WikiDocsCallFailed)) throw error;
      }
    }
    if (draft.body === '') return fail('the model wrote no body for it');
    let footnoted = wikiDocFootnotes(this.deps.repo, draft, used);
    // A footnote with no quote that holds is asked about once more.
    const missingQuotes = wikiDocUnfoundCitations(draft, footnoted.section, used);
    if (missingQuotes.length > 0) {
      try {
        const answer = await this.ask(run, WIKI_DOCS_BUILD_JOB.steps.quotes, label, wikiDocQuoteRepairPrompt(draft, missingQuotes, used));
        for (const [id, quotes] of wikiDocParseQuotes(answer)) draft.quotes.set(id, [...quotes, ...(draft.quotes.get(id) ?? [])]);
        footnoted = wikiDocFootnotes(this.deps.repo, draft, used);
      } catch (error) {
        if (!(error instanceof WikiDocsCallFailed)) throw error;
      }
    }
    run.footnotes = footnoted.counts;
    for (const piece of pieces) run.actions[piece.action] = (run.actions[piece.action] ?? 0) + 1;
    let answer: WikiDocsWriteAnswer;
    try {
      answer = await this.submit(doc.slug, {
        key: planSection.key,
        materialSha256: run.materialSha256,
        markdown: footnoted.section.markdown,
        footnotes: footnoted.section.footnotes.map((footnote) => wikiDocFootnoteWire(footnote)),
        dispositions: wikiDocDispositions(pieces),
      });
    } catch (error) {
      if (error instanceof WikiDocsWriteRefused) return fail(error.message);
      throw error;
    }
    run.outcome = 'written';
    if (answer.sections.length > 0) {
      run.stats = answer.sections[0].stats;
      if (answer.sections[0].outcome === 'unchanged') run.outcome = 'unchanged';
    }
    run.seconds = (Date.now() - started) / 1000;
    this.deps.log(`${label}: written — ${pieces.length} pieces of material (${wikiDocActionLine(run.actions)}), `
      + `${run.footnotes.total === 1 ? '1 footnote' : `${run.footnotes.total} footnotes`}, ${run.footnotes.found} of them with a quote this run found in its original.`);
    return { run, section: footnoted.section, answer };
  }

  /** A section's material (`gather`): the repository's half from the files it names, the server's half from its door. */
  private async gather(doc: WikiDocsPlanDoc, index: number): Promise<{ pieces: WikiDocPiece[]; missing: string[] }> {
    const section = doc.sections[index];
    const paths = [
      ...(section.sources.docs ?? []).map((source) => source.path),
      ...(section.sources.code ?? []).map((source) => source.path),
      ...(section.sources.contracts ?? []).map((source) => source.path),
    ].map((path) => wikiDocCleanPath(path)).filter((path) => path !== '');
    await this.deps.prepare(paths);
    const { pieces, missing } = wikiDocRepoPieces(this.deps.repo, section);
    if (section.sources.sessions) {
      const answer = await this.deps.material(doc, section.key);
      let n = 0;
      for (const record of answer.records) {
        n += 1;
        pieces.push(wikiDocPiece({ id: `S${n}`, kind: record.kind, ref: record.ref, chars: { ...record.chars }, text: record.text, record }));
      }
      for (const item of answer.unresolved) missing.push(`${item.kind} ${item.ref} (no record of this account answers it)`);
    }
    return { pieces, missing };
  }

  /** Write one section of a document; the run's writes go one at a time. */
  private submit(slug: string, section: WikiDocsWriteRequest['sections'][number]): Promise<WikiDocsWriteAnswer> {
    const write = this.writing.then(() => this.deps.write(slug, {
      planVersion: this.planVersion,
      repoSha: this.deps.repo.sha,
      ...(this.deps.model !== '' ? { model: this.deps.model } : {}),
      sections: [section],
    }));
    this.writing = write.catch(() => undefined);
    return write;
  }

  /**
   * A document's overview (`overview`), from its other sections as they are written, citing their footnotes (and
   * their quotes) and nothing else. Its material is theirs: it is written again whenever one of them is.
   */
  private async overview(
    doc: WikiDocsPlanDoc,
    index: number,
    stored: WikiDocsStoredSection | undefined,
    fingerprints: readonly string[],
    written: ReadonlyArray<WikiDocWrittenSection | null>,
  ): Promise<{ run: WikiDocsBuildSectionRun; answer: WikiDocsWriteAnswer | null }> {
    const planSection = doc.sections[index];
    const started = Date.now();
    const run = this.newRun(doc, index);
    const label = `${doc.slug}#${planSection.key}`;
    const fail = (why: string) => {
      run.outcome = 'failed';
      run.why = why;
      run.seconds = (Date.now() - started) / 1000;
      this.deps.log(`${label}: not written — ${why}`);
      return { run, answer: null };
    };
    run.materialSha256 = wikiDocOverviewFingerprint(planSection, doc, index, fingerprints);
    if (stored && stored.materialSha256 === run.materialSha256 && !stored.stale) {
      run.outcome = 'unchanged';
      run.seconds = (Date.now() - started) / 1000;
      this.deps.log(`${label}: the sections it sums up are the ones it was written from, so it is left as it is.`);
      return { run, answer: null };
    }
    // The other sections as they are written: this run's own, and the server's for the ones it left alone.
    let view: WikiDocViewForOverview | null = null;
    const needsView = doc.sections.some((section, i) => i !== index && section.kind !== 'overview' && written[i] === null && fingerprints[i] !== '');
    if (needsView) {
      view = await this.deps.view(doc.slug);
      if (!view) return fail('reading the sections it sums up: the document is not written');
    }
    const material = wikiDocOverviewMaterial(doc, index, written, view);
    if (material.sections.length === 0) return fail('none of the sections it sums up is written yet');
    run.pieces = material.notes.length;
    // The repository quotes it may cite are looked for again at this run's commit: their files are read first.
    await this.deps.prepare(material.notes
      .filter((note) => wikiDocIsRepoKind(note.footnote.kind) && note.footnote.path)
      .map((note) => wikiDocCleanPath(note.footnote.path ?? '')));
    let text: string;
    try {
      text = await this.ask(run, WIKI_DOCS_BUILD_JOB.steps.overview, label, wikiDocOverviewPrompt(doc, index, material.sections, material.notes));
    } catch (error) {
      if (error instanceof WikiDocsCallFailed) return fail(`the writing: ${error.message}`);
      throw error;
    }
    const body = wikiDocStripHeading(wikiDocBodyOf(text));
    const { markdown, footnotes } = wikiDocOverviewFootnotes(this.deps.repo, body, material.notes);
    if (goTrimSpace(markdown) === '') return fail('the model wrote no body for it');
    run.footnotes = countFootnotes(footnotes);
    let answer: WikiDocsWriteAnswer;
    try {
      answer = await this.submit(doc.slug, {
        key: planSection.key,
        materialSha256: run.materialSha256,
        markdown,
        footnotes: footnotes.map((footnote) => wikiDocFootnoteWire(footnote)),
        dispositions: [],
      });
    } catch (error) {
      if (error instanceof WikiDocsWriteRefused) return fail(error.message);
      throw error;
    }
    run.outcome = 'written';
    if (answer.sections.length > 0) run.stats = answer.sections[0].stats;
    run.seconds = (Date.now() - started) / 1000;
    this.deps.log(`${label}: the overview written last, from ${material.sections.length === 1 ? '1 section' : `${material.sections.length} sections`}, `
      + `with ${footnotes.length === 1 ? '1 footnote' : `${footnotes.length} footnotes`}.`);
    return { run, answer };
  }
}

/** An overview's footnotes as its run counts them: a repository one is found unless its check said it was not. */
function countFootnotes(footnotes: readonly WikiDocFootnote[]): WikiDocsBuildSectionRun['footnotes'] {
  const counts = { total: footnotes.length, found: 0, noQuote: 0 };
  for (const footnote of footnotes) {
    if (footnote.quote === null) counts.noQuote += 1;
    else if (footnote.verified === undefined || footnote.verified === null || footnote.verified) counts.found += 1;
  }
  return counts;
}

/**
 * Run `work` over `items`, at most `limit` at once, the way the runner's semaphore does. The first error that is
 * not a section's own stops it: nothing new is started, the ones running finish, and the error is thrown.
 */
async function pool<T>(items: readonly T[], limit: number, signal: AbortSignal | undefined, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const lane = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      if (signal?.aborted) {
        failure ??= { error: new Error('the build was stopped: the worker is shutting down') };
        return;
      }
      const item = items[next];
      next += 1;
      try {
        await work(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
  if (failure !== null) throw (failure as { error: unknown }).error;
}
