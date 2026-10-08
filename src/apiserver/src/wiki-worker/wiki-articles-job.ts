import { HttpException } from '@nestjs/common';
import {
  WIKI_ARTICLE_RULES,
  WIKI_ARTICLES_JOB,
  type WikiArticleInput,
  type WikiArticleKind,
  type WikiArticlePartInput,
  type WikiArticleStats,
  type WikiArticleWriteResult,
} from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { sumStats, wikiArticlesJobPrincipal, type WikiArticles } from '../wiki/wiki-articles';
import type { WikiPrincipal } from '../wiki/wiki.service';
import {
  WIKI_ARTICLE_SYSTEM_PROMPT,
  WIKI_ARTICLE_WRITER,
  groupWikiArticleEntries,
  wikiArticleDraftChars,
  wikiArticleFallbackName,
  wikiArticleGroupName,
  wikiArticleNamePrompt,
  wikiArticlePrompt,
  wikiArticleRetrySuffix,
  wikiArticleTitle,
  type WikiArticleWriterEntry,
} from './wiki-articles-writer';
import { WikiJobContentError, WikiJobInfraError, WikiJobParked, type WikiJobContext, type WikiJobRunner } from './wiki-job-executor';
import { WikiRepoOpRefused, waitForWikiRepoOpAsJob, type WikiRepoOps, type WikiRepoOpWake } from './wiki-repo-ops';

/**
 * The `articles` job (contracts/wiki.contract.json `jobs.kindRuns.articles`, `articles.job`; design §8, P4):
 * what `orbit wiki articles` does in a maintenance session, done by the wiki worker with the System model.
 *
 * THE SERVER DECIDES WHAT IT CAN; THE MODEL WRITES — as on the runner. The plan names the topics whose entry
 * set changed (`WikiArticles.plan`, which also gives a space with no topic the default ones); each such topic's
 * entries are read (`input`), a topic of more than `rules.splitAbove` entries is grouped by code
 * (`groupWikiArticleEntries`), the model names each group — one after another, each told the names already
 * taken — and writes the subtopic articles and the overview, `WIKI_ARTICLES_JOB.parallel` at a time, or the
 * one article of a smaller topic; a draft that keeps fewer than `rules.minChars` characters is asked for again
 * once. What it wrote goes through the same `WikiArticles.write` the runner door calls, which keeps a footnote
 * only when it names an entry of the topic: nothing the model says about which entry backs a sentence is
 * taken on trust here either.
 *
 * EVERY CALL IS A BREAKPOINT. Each model call is a queue request whose unit is the topic, its fingerprint and
 * the part (`<slug>@<sha12>/part-1`, `…/name-1`, `…/part-0/again`), so a job replayed after its worker died
 * reuses every answer it already had, and a topic whose entries changed meanwhile is asked afresh. The queue
 * does what the runner did by hand: it retries a 5xx, a 429 and a dropped connection with its own backoff, and
 * a 401 stops the whole queue (modelQueue.retry.unauthorized) — where the runner stopped its run.
 *
 * THE REF IS THE SNAPSHOT'S. An article records the commit it was written at (`ref`): on the runner it was the
 * checkout's `origin/main`; here it is the sha of the space's latest repository snapshot (repoOps.cache). A
 * space with none is asked one, once: the job parks on it (repoOps.waiting) and is replayed when it lands. A
 * job that asked and got none — the operation failed, or did not settle within
 * `WIKI_ARTICLES_JOB.snapshotWaitSeconds` — writes without a ref and says why, as the runner did with no
 * `origin/main` to read: the articles are written from the entries, not from the repository.
 *
 * HOW IT ENDS. Every topic it took up written or unchanged: succeeded, the report its summary. A topic left
 * unwritten — the model's call ended in a way that is the work's, or the entries changed while it wrote
 * (WIKI_ARTICLE_STALE) — fails the job as content once every other topic has been tried, its report on the
 * row, as the command exited non-zero: the next job writes it from the entries as they stand. A failure of the
 * platform (a request past its wait limit, the database, the worker stopping) is not the topic's and ends this
 * attempt as infra, to be replayed.
 */

/** What the job needs besides its context: the services it writes through, and the System model's name. */
export interface WikiArticlesJobDeps {
  prisma: PrismaService;
  articles: WikiArticles;
  repoOps: WikiRepoOps;
  /** The System model's name: what each write says the articles were written with ('' when none is set). */
  model: string;
  /** How a job parked on its snapshot hears it land; without it the wait polls. */
  repoWake?: WikiRepoOpWake;
  /** The specs' handles on the two waits a run can have. */
  snapshotWaitMs?: number;
  groupingSliceMs?: number;
}

/** One part of a topic the run wrote, as the report counts it. */
export interface WikiArticlesPartRun {
  part: number;
  kind: WikiArticleKind;
  title: string;
  entries: number;
  kept: boolean;
  stats: WikiArticleStats;
}

/** One topic the run took up. */
export interface WikiArticlesTopicRun {
  slug: string;
  entries: number;
  outcome: 'written' | 'unchanged' | 'failed';
  why?: string;
  parts: WikiArticlesPartRun[];
}

/** What a run did: the job's report, in the shape `orbit wiki articles --json` prints. */
export interface WikiArticlesReport {
  kind: 'articles';
  spaceId: string;
  model: string;
  seeded: number;
  /** The commit the articles were written at, and, when there was none, why. */
  ref: string | null;
  refWhy: string | null;
  topics: WikiArticlesTopicRun[];
  written: number;
  unchanged: number;
  failed: number;
  calls: number;
  usage: { inputTokens: number; outputTokens: number };
  stats: WikiArticleStats;
}

/** The runner the worker's module registers for `articles`. */
export function wikiArticlesJobRunner(deps: WikiArticlesJobDeps): WikiJobRunner {
  return (context) => runWikiArticlesJob(context, deps) as unknown as Promise<Record<string, unknown>>;
}

/** Write the articles of the space's topics whose entries changed, and say what was done. */
export async function runWikiArticlesJob(context: WikiJobContext, deps: WikiArticlesJobDeps): Promise<WikiArticlesReport> {
  const { job } = context;
  const principal = wikiArticlesJobPrincipal(job.ownerId);
  const report: WikiArticlesReport = {
    kind: 'articles',
    spaceId: job.spaceId,
    model: deps.model,
    seeded: 0,
    ref: null,
    refWhy: null,
    topics: [],
    written: 0,
    unchanged: 0,
    failed: 0,
    calls: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    stats: sumStats([]),
  };
  let plan;
  try {
    plan = await deps.articles.plan(principal, job.spaceId);
  } catch (error) {
    if (error instanceof HttpException) throw new WikiJobContentError(`the plan was refused: ${refusalText(error)}`, { ...report });
    throw error;
  }
  report.seeded = plan.seeded;
  if (plan.seeded > 0) context.log(`the space had no topic: it was given the ${plan.seeded} every space starts with`);
  const targets = plan.topics.filter((topic) => topic.changed).map((topic) => topic.slug);
  if (targets.length === 0) return report;

  const ref = await articlesRef(context, deps);
  report.ref = ref.sha;
  report.refWhy = ref.why;
  for (const slug of targets) {
    const topic = await writeTopic(context, deps, principal, slug, ref.sha, report);
    report.topics.push(topic);
    if (topic.outcome === 'written') report.written += 1;
    else if (topic.outcome === 'unchanged') report.unchanged += 1;
    else report.failed += 1;
    report.stats = sumStats([report.stats, ...topic.parts.map((part) => part.stats)]);
  }
  if (report.failed > 0) {
    throw new WikiJobContentError(
      `${report.failed === 1 ? '1 topic was' : `${report.failed} topics were`} left unwritten: the next run tries again`,
      report as unknown as Record<string, unknown>,
    );
  }
  return report;
}

// ── The ref ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The commit the articles are written at: the space's latest snapshot's sha. With none, a snapshot is asked
 * for once, and the job parks on it — `WikiJobParked` ends this attempt, and the replay finds the snapshot in
 * the cache. A job that asked already and has none, or whose space names no checkout to read, writes without.
 */
async function articlesRef(context: WikiJobContext, deps: WikiArticlesJobDeps): Promise<{ sha: string | null; why: string | null }> {
  const { job } = context;
  const held = await deps.prisma.wikiRepoSnapshot.findFirst({
    where: { spaceId: job.spaceId, ownerId: job.ownerId },
    select: { sha: true },
  });
  if (held) return { sha: held.sha, why: null };
  const asked = await deps.prisma.wikiRepoOp.findFirst({
    where: { jobId: job.id, kind: 'snapshot' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, state: true, error: true },
  });
  if (asked) {
    const why = asked.state === 'queued' || asked.state === 'running'
      ? `the snapshot this job asked for (${asked.id}) did not arrive within ${WIKI_ARTICLES_JOB.snapshotWaitSeconds} s`
      : `the snapshot this job asked for (${asked.id}) ended ${asked.state}${asked.error ? `: ${asked.error}` : ''}`;
    context.log(`no snapshot of the space's repository: ${why}; the articles are written without a ref`);
    return { sha: null, why };
  }
  let opId: string;
  try {
    opId = (await deps.repoOps.enqueueWikiRepoOp({ jobId: job.id, kind: 'snapshot' })).id;
  } catch (error) {
    if (!(error instanceof WikiRepoOpRefused)) throw error;
    const why = `no snapshot could be asked for: ${error.message}`;
    context.log(`no snapshot of the space's repository: ${why}; the articles are written without a ref`);
    return { sha: null, why };
  }
  context.log(`no snapshot of the space's repository yet: asked for one (${opId}), and parked until it lands`);
  try {
    await waitForWikiRepoOpAsJob(deps.prisma, {
      jobId: job.id,
      generation: job.leaseGeneration,
      opId,
      timeoutMs: deps.snapshotWaitMs ?? WIKI_ARTICLES_JOB.snapshotWaitSeconds * 1000,
      wake: deps.repoWake,
      signal: context.signal,
    });
  } catch (error) {
    // Not this run's to park: the claim was taken over before it could. Nothing of it is left to settle.
    if (error instanceof WikiRepoOpRefused && error.refusal === 'STALE_CLAIM') throw new WikiJobInfraError(error.message);
    // The wait ran out or the worker is stopping: the job is back in the queue with the reason on its row.
    throw new WikiJobParked(`parked on the snapshot ${opId}, which has not settled: ${(error as Error).message}`);
  }
  throw new WikiJobParked(`parked on the snapshot ${opId}, which settled: queued again, to replay with it`);
}

// ── One topic ───────────────────────────────────────────────────────────────────────────────────

/** What a run's calls cost, summed as they come back. */
type Tally = Pick<WikiArticlesReport, 'calls' | 'usage'>;

/** Write one topic's articles. A failure that is the topic's comes back as its outcome; the platform's is thrown. */
async function writeTopic(
  context: WikiJobContext,
  deps: WikiArticlesJobDeps,
  principal: WikiPrincipal,
  slug: string,
  ref: string | null,
  tally: Tally,
): Promise<WikiArticlesTopicRun> {
  const run: WikiArticlesTopicRun = { slug, entries: 0, outcome: 'failed', parts: [] };
  const fail = (why: string): WikiArticlesTopicRun => {
    run.outcome = 'failed';
    run.why = why;
    context.log(`topic ${slug}: not written — ${why}`);
    return run;
  };
  let input: WikiArticleInput;
  try {
    input = await deps.articles.input(principal, context.job.spaceId, slug);
  } catch (error) {
    if (error instanceof HttpException) return fail(refusalText(error));
    throw error;
  }
  run.entries = input.entries.length;
  if (input.entries.length === 0) return fail('the topic has no entry to write from');
  let parts: WikiArticlePartInput[];
  try {
    parts = await compose(context, deps, input, tally);
  } catch (error) {
    if (error instanceof WikiJobContentError) return fail(error.message);
    throw error;
  }
  let answer: WikiArticleWriteResult;
  try {
    answer = await deps.articles.write(principal, context.job.spaceId, slug, {
      entrySetSha256: input.entrySetSha256,
      ...(ref !== null ? { ref } : {}),
      ...(deps.model !== '' ? { model: deps.model } : {}),
      articles: parts,
    });
  } catch (error) {
    if (error instanceof HttpException) return fail(refusalText(error));
    throw error;
  }
  run.parts = answer.parts.map((part, i) => ({
    part: part.part,
    kind: part.kind,
    title: part.title,
    entries: parts[i]?.kind === 'subtopic' ? (parts[i].entries ?? []).length : input.entries.length,
    kept: part.kept,
    stats: part.stats,
  }));
  if (answer.unchanged) {
    run.outcome = 'unchanged';
    context.log(`topic ${slug}: its articles were written from these entries already, so nothing was written`);
    return run;
  }
  if (!answer.written) return fail(answer.reason ?? 'the server wrote nothing');
  run.outcome = 'written';
  const kept = answer.parts.filter((part) => part.kept).length;
  context.log(`topic ${slug}: ${kept} article(s) written from ${input.entries.length} entries — ${answer.stats.chars} characters; `
    + `${answer.stats.sentencesDeleted} of ${answer.stats.sentences} sentences deleted, `
    + `${answer.stats.markersStripped} of ${answer.stats.markers} footnotes stripped`);
  return run;
}

/**
 * Have the model write a topic's parts: one article, or — past `rules.splitAbove` entries — a named subtopic
 * article per group and an overview over them.
 */
async function compose(
  context: WikiJobContext,
  deps: WikiArticlesJobDeps,
  input: WikiArticleInput,
  tally: Tally,
): Promise<WikiArticlePartInput[]> {
  const entries: WikiArticleWriterEntry[] = input.entries;
  const topicTitle = input.topic.title;
  // A call's address in the job: the topic as it stands now, so a topic whose entries moved between two
  // attempts of the job is asked afresh rather than answered with what another set of entries got.
  const at = `${input.topic.slug}@${input.entrySetSha256.slice(0, 12)}`;
  if (entries.length <= WIKI_ARTICLE_RULES.splitAbove) {
    return [await writePart(context, tally, `${at}/part-0`, 'article', topicTitle, topicTitle, entries, entries.length, '', 0)];
  }
  const groups = await groupWikiArticleEntries(entries, { sliceMs: deps.groupingSliceMs });
  context.log(`topic ${input.topic.slug}: ${entries.length} entries split into ${groups.length} subtopics by their paths and words`);
  // One group after another, each told the names already taken.
  const names: string[] = [];
  for (const [g, group] of groups.entries()) {
    const members = group.map((i) => entries[i]);
    names.push(await nameGroup(context, tally, `${at}/name-${g + 1}`, topicTitle, members, names));
  }
  const lines = groups.map((group, g) => `- ${names[g]}（${group.length} 条）`).join('\n');
  const top = groups.flatMap((group) => group.slice(0, 2).map((i) => entries[i])).slice(0, WIKI_ARTICLE_RULES.entriesPerArticle);
  const written = await inParallel(groups.length + 1, WIKI_ARTICLES_JOB.parallel, async (i) => {
    if (i === groups.length) {
      return writePart(context, tally, `${at}/part-0`, 'overview', topicTitle, topicTitle, top, entries.length, lines, 0);
    }
    const members = groups[i].map((j) => entries[j]);
    const part = await writePart(context, tally, `${at}/part-${i + 1}`, 'subtopic', topicTitle, names[i], members, members.length, '', i + 1);
    return { ...part, entries: members.map((entry) => entry.id) };
  });
  return [written[groups.length], ...written.slice(0, groups.length)];
}

/**
 * Have the model write one part from its entries — the best supported `rules.entriesPerArticle` of them —
 * asking once more when the draft keeps fewer than `rules.minChars` characters and the pool had more to say.
 */
async function writePart(
  context: WikiJobContext,
  tally: Tally,
  unit: string,
  kind: WikiArticleKind,
  topicTitle: string,
  title: string,
  pool: readonly WikiArticleWriterEntry[],
  poolSize: number,
  subs: string,
  part: number,
): Promise<WikiArticlePartInput> {
  const fed = pool.slice(0, WIKI_ARTICLE_RULES.entriesPerArticle);
  const notes = fed.map((entry) => entry.id);
  const prompt = wikiArticlePrompt(kind, topicTitle, title, fed, subs);
  let text = await ask(context, tally, unit, prompt, WIKI_ARTICLES_JOB.articleMaxTokens);
  const chars = wikiArticleDraftChars(text, notes);
  if (chars < WIKI_ARTICLE_RULES.minChars && poolSize >= WIKI_ARTICLE_WRITER.retryPoolMin) {
    const again = await ask(context, tally, `${unit}/again`, prompt + wikiArticleRetrySuffix(chars), WIKI_ARTICLES_JOB.articleMaxTokens);
    if (wikiArticleDraftChars(again, notes) > chars) text = again;
  }
  return { part, kind, title: wikiArticleTitle(text, title), markdown: text, notes };
}

/**
 * Have the model name one group, differently from the names its topic's other groups already have — falling
 * back on the path most of it shares, then on its first title, when its answer gives no name or the call
 * ended in a way that is the work's.
 */
async function nameGroup(
  context: WikiJobContext,
  tally: Tally,
  unit: string,
  topicTitle: string,
  members: readonly WikiArticleWriterEntry[],
  taken: readonly string[],
): Promise<string> {
  let text = '';
  try {
    text = await ask(context, tally, unit, wikiArticleNamePrompt(topicTitle, members, taken), WIKI_ARTICLES_JOB.nameMaxTokens);
  } catch (error) {
    if (!(error instanceof WikiJobContentError)) throw error;
  }
  return wikiArticleGroupName(text) || wikiArticleFallbackName(members);
}

/** One model call through the queue, counted. Its row is the breakpoint; a failure is the context's to classify. */
async function ask(context: WikiJobContext, tally: Tally, unit: string, prompt: string, maxTokens: number): Promise<string> {
  const row = await context.ask(WIKI_ARTICLES_JOB.step, unit, { system: WIKI_ARTICLE_SYSTEM_PROMPT, prompt, maxTokens });
  tally.calls += 1;
  tally.usage.inputTokens += row.inputTokens ?? 0;
  tally.usage.outputTokens += row.outputTokens ?? 0;
  return row.answer ?? '';
}

/**
 * Run `n` calls, `limit` at a time, and wait for all of them. The first failure that is not the work's — the
 * platform's, which ends the attempt — is answered before any that is; else the first by index.
 */
async function inParallel<T>(n: number, limit: number, call: (i: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(n);
  const errors = new Array<unknown>(n);
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= n) return;
      try {
        results[i] = await call(i);
      } catch (error) {
        errors[i] = error ?? new Error('a call failed');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, n) }, () => lane()));
  const failed = errors.filter((error) => error !== undefined);
  const platform = failed.find((error) => !(error instanceof WikiJobContentError));
  if (platform !== undefined) throw platform;
  if (failed.length > 0) throw failed[0];
  return results;
}

/** What a refusal of the articles' own routes says, in one line: its code and message. */
function refusalText(error: HttpException): string {
  const body = error.getResponse() as { code?: unknown; message?: unknown } | string;
  if (typeof body === 'string') return body;
  const message = Array.isArray(body.message) ? body.message.join('; ') : String(body.message ?? error.message);
  return typeof body.code === 'string' ? `${body.code}: ${message}` : message;
}
