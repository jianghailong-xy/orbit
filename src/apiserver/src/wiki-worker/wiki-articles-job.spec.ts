import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  WIKI_ARTICLE_RULES,
  WIKI_ARTICLES_JOB,
  type WikiArticleInput,
  type WikiArticlePlan,
  type WikiArticleWriteRequest,
  type WikiArticleWriteResult,
} from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import type { WikiArticles } from '../wiki/wiki-articles';
import { WikiRefusalError, type WikiPrincipal } from '../wiki/wiki.service';
import { runWikiArticlesJob, type WikiArticlesJobDeps, type WikiArticlesReport } from './wiki-articles-job';
import type { WikiArticleWriterEntry } from './wiki-articles-writer';
import { WikiJobContentError, WikiJobInfraError, type WikiJobContext } from './wiki-job-executor';
import type { WikiModelRequestCall, WikiModelRequestRead } from './wiki-model-queue';
import { WikiRepoOpRefused, type WikiRepoOps } from './wiki-repo-ops';

/**
 * The server's `articles` job (wiki-articles-job.ts, contract `jobs.kindRuns.articles`) with everything around it
 * stood in for: the plan, a topic's input and the write of `WikiArticles`, the space's snapshot, and the queue —
 * `ask`, answered as the fixture's model answers. What `src/runner-go/wiki_articles_test.go` holds the runner's
 * command to, held here to the job:
 *
 *   - it asks exactly what the runner asks: every call of `wiki-article-writer.fixture.json`, word for word, by
 *     the unit it is filed under — and groups the big topic as the runner does;
 *   - a topic whose entries did not change is neither read nor written, and the model is not asked about it;
 *   - a draft that keeps too little is asked for once more;
 *   - a write refused WIKI_ARTICLE_STALE, or a call that ended in a way that is the work's, leaves that topic
 *     unwritten — the job tries the others and then fails as content, its report on the row;
 *   - a failure that is the platform's ends the attempt with nothing written;
 *   - the ref is the space's snapshot's, and with none to be had the articles are written without one.
 *
 * The end-to-end run — the executor, the queue, a fake System model, the real write path and a canary account —
 * is `wiki-articles-job.pg.spec.ts`.
 */

const ROOT = path.resolve(__dirname, '../../../..');
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, 'src/shared/src/wiki-article-writer.fixture.json'), 'utf8')) as {
  model: { names: string[]; article: string; short: string; shortFor: string };
  topics: Array<{ slug: string; title: string; entrySetSha256: string; entries: Array<WikiArticleWriterEntry & { revision: number }> }>;
  system: string;
  calls: Record<string, Record<string, string>>;
  groups: Record<string, string[][]>;
};

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const MODEL = 'qwen3-coder-system';

interface Asked {
  step: string;
  unit: string;
  call: WikiModelRequestCall;
}

/** The fixture's model: names in order, an article, and the short draft for the topic it names. */
function fixtureModel(): (prompt: string) => string {
  let named = 0;
  return (prompt) => {
    if (prompt.includes('起一个简短的中文小标题')) return `好的，这组的小标题是：\n「${FIXTURE.model.names[named++]}」`;
    if (prompt.includes('A previous draft kept only')) return FIXTURE.model.article;
    if (prompt.startsWith(`Write a wiki article titled "${FIXTURE.model.shortFor}",`)) return FIXTURE.model.short;
    return FIXTURE.model.article;
  };
}

function row(answer: string): WikiModelRequestRead {
  return {
    id: 'r', jobId: 'job', step: WIKI_ARTICLES_JOB.step, unit: 'u', attempt: 1, attempts: 1, state: 'succeeded', answer, partial: null,
    inputTokens: 100, outputTokens: 40, httpStatus: 200, error: null, errorKind: null, requestSha256: 'x',
    enqueuedAt: new Date(), notBefore: null, startedAt: new Date(), endedAt: new Date(),
  };
}

function context(answer: (prompt: string, unit: string) => string | Error): { ctx: WikiJobContext; asked: Asked[] } {
  const asked: Asked[] = [];
  const ctx: WikiJobContext = {
    job: { id: 'job-1', ownerId: 'owner-1', spaceId: 'space-1', kind: 'articles', input: {}, priority: 0, attempts: 0, leaseGeneration: 'gen-1' },
    signal: new AbortController().signal,
    log: () => undefined,
    ask: async (step, unit, call) => {
      asked.push({ step, unit, call });
      const said = answer(call.prompt, unit);
      if (said instanceof Error) throw said;
      return row(said);
    },
  };
  return { ctx, asked };
}

interface Door {
  articles: WikiArticles;
  inputs: string[];
  writes: Map<string, WikiArticleWriteRequest>;
  principals: WikiPrincipal[];
}

/** WikiArticles as the runner door answers: the fixture's topics, every one changed unless `unchanged` names it. */
function door(options: { unchanged?: string[]; refuse?: (slug: string) => Error | null } = {}): Door {
  const inputs: string[] = [];
  const writes = new Map<string, WikiArticleWriteRequest>();
  const principals: WikiPrincipal[] = [];
  const articles = {
    plan: async (principal: WikiPrincipal, spaceId: string): Promise<WikiArticlePlan> => {
      principals.push(principal);
      return {
        spaceId, seeded: 0, entries: 0, unassigned: 0,
        topics: FIXTURE.topics.map((topic) => ({
          slug: topic.slug, title: topic.title, category: 'platform', entryCount: topic.entries.length,
          entrySetSha256: topic.entrySetSha256, articleSha256: null, generatedAt: null,
          changed: !(options.unchanged ?? []).includes(topic.slug),
        })),
      };
    },
    input: async (principal: WikiPrincipal, spaceId: string, slug: string): Promise<WikiArticleInput> => {
      principals.push(principal);
      inputs.push(slug);
      const topic = FIXTURE.topics.find((one) => one.slug === slug)!;
      return {
        spaceId,
        topic: { slug, title: topic.title, category: 'platform', description: null },
        entrySetSha256: topic.entrySetSha256,
        articleSha256: null,
        entries: topic.entries.map((entry) => ({ ...entry, trust: 'auto', recordedAt: '2026-10-08T00:00:00.000Z' })),
      };
    },
    write: async (principal: WikiPrincipal, spaceId: string, slug: string, body: unknown): Promise<WikiArticleWriteResult> => {
      principals.push(principal);
      const refused = options.refuse?.(slug) ?? null;
      if (refused) throw refused;
      const request = body as WikiArticleWriteRequest;
      writes.set(slug, request);
      const stats = { sentences: 10, sentencesDeleted: 0, markers: 12, markersStripped: 0, sentencesTrimmed: 0, chars: 600, footnotes: 3 };
      return {
        spaceId, slug, written: true, unchanged: false, reason: null,
        parts: request.articles.map((part) => ({ part: part.part, kind: part.kind, title: part.title, kept: true, stats })),
        stats,
      };
    },
  } as unknown as WikiArticles;
  return { articles, inputs, writes, principals };
}

function deps(articles: WikiArticles, snapshot: { sha: string } | null = { sha: SHA }, extra: Partial<WikiArticlesJobDeps> = {}): WikiArticlesJobDeps {
  return {
    prisma: {
      wikiRepoSnapshot: { findFirst: async () => snapshot },
      wikiRepoOp: { findFirst: async () => null },
    } as unknown as PrismaService,
    articles,
    repoOps: {} as WikiRepoOps,
    model: MODEL,
    ...extra,
  };
}

/** A call's unit without its topic's address: what the fixture files it under. */
function unitOf(unit: string): { slug: string; unit: string } {
  const [address, ...rest] = unit.split('/');
  return { slug: address.split('@')[0], unit: rest.join('/') };
}

test('the job asks what the runner asks: every call of wiki-article-writer.fixture.json, word for word, by its unit', async () => {
  const d = door();
  const { ctx, asked } = context(fixtureModel());
  const report = await runWikiArticlesJob(ctx, deps(d.articles));

  const calls: Record<string, Record<string, string>> = {};
  for (const one of asked) {
    assert.equal(one.step, WIKI_ARTICLES_JOB.step);
    assert.equal(one.call.system, FIXTURE.system, 'the writer\'s system prompt, the runner\'s');
    const { slug, unit } = unitOf(one.unit);
    assert.match(one.unit, new RegExp(`^${slug}@${FIXTURE.topics.find((t) => t.slug === slug)!.entrySetSha256.slice(0, 12)}/`, 'u'),
      'a call is addressed by its topic and the fingerprint it was written from');
    assert.equal(one.call.maxTokens, unit.startsWith('name-') ? WIKI_ARTICLES_JOB.nameMaxTokens : WIKI_ARTICLES_JOB.articleMaxTokens);
    calls[slug] ??= {};
    assert.equal(calls[slug][unit], undefined, `${slug} ${unit} asked twice`);
    calls[slug][unit] = one.call.prompt;
  }
  assert.deepEqual(Object.keys(calls).sort(), Object.keys(FIXTURE.calls).sort());
  for (const [slug, want] of Object.entries(FIXTURE.calls)) {
    assert.deepEqual(Object.keys(calls[slug]).sort(), Object.keys(want).sort(), `the units of ${slug}`);
    for (const [unit, prompt] of Object.entries(want)) assert.equal(calls[slug][unit], prompt, `${slug} ${unit}, word for word`);
  }

  // The writes: what the server's write route is handed, as the runner hands it.
  const groups: Record<string, string[][]> = {};
  for (const topic of FIXTURE.topics) {
    const written = d.writes.get(topic.slug)!;
    assert.equal(written.entrySetSha256, topic.entrySetSha256);
    assert.equal(written.ref, SHA, 'written at the snapshot\'s commit');
    assert.equal(written.model, MODEL, 'written with the System model');
    assert.equal(written.articles[0].part, 0);
    for (const [i, part] of written.articles.entries()) {
      if (part.kind !== 'subtopic') continue;
      assert.equal(part.part, i);
      (groups[topic.slug] ??= []).push(part.entries!);
      assert.deepEqual(part.notes, part.entries!.slice(0, WIKI_ARTICLE_RULES.entriesPerArticle), 'a subtopic cites its own best entries');
    }
  }
  assert.deepEqual(groups, FIXTURE.groups);
  const wiki = d.writes.get('wiki')!;
  assert.equal(wiki.articles[0].kind, 'overview');
  assert.deepEqual(wiki.articles[0].notes, FIXTURE.groups.wiki.flatMap((group) => group.slice(0, 2)), 'the overview: the best two of each group');
  assert.equal(wiki.articles[0].title, '文章写作规则', 'a title is the draft\'s own');
  const database = d.writes.get('database')!;
  assert.deepEqual(database.articles.map((part) => part.kind), ['article']);
  assert.deepEqual(database.articles[0].notes, FIXTURE.topics[0].entries.map((entry) => entry.id), 'a small topic cites from all of its entries');
  assert.equal(database.articles[0].markdown, FIXTURE.model.article, 'the longer second draft');

  // Every read and write went as the server's own job: maintenance, no session and no user.
  for (const principal of d.principals) {
    assert.deepEqual(principal, { origin: 'maintenance', ownerId: 'owner-1', userId: null, sessionId: null, toolCallId: null, authorKind: 'system' });
  }
  assert.equal(report.written, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.calls, asked.length);
  assert.deepEqual(report.usage, { inputTokens: 100 * asked.length, outputTokens: 40 * asked.length });
  assert.equal(report.ref, SHA);
  assert.equal(report.refWhy, null);
});

test('a topic whose entries did not change is neither read nor written, and the model is not asked about it', async () => {
  const d = door({ unchanged: ['database', 'wiki'] });
  const { ctx, asked } = context(fixtureModel());
  const report = await runWikiArticlesJob(ctx, deps(d.articles));
  assert.deepEqual(d.inputs, []);
  assert.equal(d.writes.size, 0);
  assert.equal(asked.length, 0);
  assert.equal(report.topics.length, 0);
  // One of two: only the other is read.
  const one = door({ unchanged: ['wiki'] });
  await runWikiArticlesJob(context(fixtureModel()).ctx, deps(one.articles));
  assert.deepEqual(one.inputs, ['database']);
});

test('a write refused WIKI_ARTICLE_STALE leaves its topic unwritten: the others are written, and the job fails as content with its report', async () => {
  const stale = new WikiRefusalError({ code: 'WIKI_ARTICLE_STALE', message: 'the entries of topic database changed while its articles were written' });
  const d = door({ refuse: (slug) => (slug === 'database' ? stale : null) });
  const { ctx } = context(fixtureModel());
  await assert.rejects(runWikiArticlesJob(ctx, deps(d.articles)), (error: unknown) => {
    assert.ok(error instanceof WikiJobContentError, String(error));
    assert.match(error.message, /1 topic was left unwritten: the next run tries again/u);
    const report = error.report as unknown as WikiArticlesReport;
    assert.equal(report.written, 1);
    assert.equal(report.failed, 1);
    const database = report.topics.find((topic) => topic.slug === 'database')!;
    assert.equal(database.outcome, 'failed');
    assert.match(database.why ?? '', /^WIKI_ARTICLE_STALE: the entries of topic database changed/u);
    return true;
  });
  assert.ok(d.writes.has('wiki'), 'the topic after it was still written');
});

test('a call that ends in a way that is the work\'s leaves its topic unwritten; a nameless group is named by its path', async () => {
  const model = fixtureModel();
  // Every part of the small topic fails; the big topic's names come back empty.
  const d = door();
  const { ctx, asked } = context((prompt, unit) => {
    if (unit.startsWith('database@')) return new WikiJobContentError('the call ended other: the budget ran out');
    if (prompt.includes('起一个简短的中文小标题')) return '\n\n';
    return model(prompt);
  });
  await assert.rejects(runWikiArticlesJob(ctx, deps(d.articles)), (error: unknown) => {
    assert.ok(error instanceof WikiJobContentError);
    const report = error.report as unknown as WikiArticlesReport;
    assert.equal(report.topics.find((topic) => topic.slug === 'database')?.why, 'the call ended other: the budget ran out');
    return true;
  });
  const wiki = d.writes.get('wiki')!;
  assert.equal(wiki.articles.filter((part) => part.kind === 'subtopic').length, FIXTURE.groups.wiki.length, 'the big topic is written');
  // No name from the model: each group is asked about, and listed in the overview, by the path most of it shares.
  const titled = asked
    .map((one) => /^Write a wiki article titled "([^"]+)" \(a part of the topic "Wiki"\)/u.exec(one.call.prompt)?.[1])
    .filter((title): title is string => title !== undefined);
  assert.equal(titled.length, FIXTURE.groups.wiki.length);
  for (const title of titled) assert.match(title, /^[^/]+\/[^/]+/u, `a group named by its path, not ${title}`);
  const overview = asked.find((one) => one.call.prompt.startsWith('Write the overview of the wiki topic "Wiki"'))!;
  for (const title of titled) assert.ok(overview.call.prompt.includes(`- ${title}（`), `the overview lists ${title}`);
});

test('a failure that is the platform\'s ends the attempt, and nothing is written', async () => {
  const d = door();
  const { ctx } = context(() => new WikiJobInfraError("the request waited past its step's limit (900 s)"));
  await assert.rejects(runWikiArticlesJob(ctx, deps(d.articles)), WikiJobInfraError);
  assert.equal(d.writes.size, 0);
  // A platform failure among a topic's parallel calls wins over the work's: the attempt is retried whole.
  const model = fixtureModel();
  const mixed = door({ unchanged: ['database'] });
  const { ctx: both } = context((prompt, unit) => {
    if (unit.endsWith('/part-1')) return new WikiJobContentError('one part could not be written');
    if (unit.endsWith('/part-2')) return new WikiJobInfraError('the worker is stopping');
    return model(prompt);
  });
  await assert.rejects(runWikiArticlesJob(both, deps(mixed.articles)), WikiJobInfraError);
  assert.equal(mixed.writes.size, 0);
});

test('with no snapshot to name, the articles are written without a ref, and the report says why', async () => {
  // The space names no checkout to read: no snapshot can be asked for.
  const d = door({ unchanged: ['wiki'] });
  const refused = { enqueueWikiRepoOp: async () => { throw new WikiRepoOpRefused('INVALID_RESULT', 'the space names no workspace to read its repository in'); } };
  const { ctx } = context(fixtureModel());
  const report = await runWikiArticlesJob(ctx, deps(d.articles, null, { repoOps: refused as unknown as WikiRepoOps }));
  assert.equal(report.ref, null);
  assert.match(report.refWhy ?? '', /no snapshot could be asked for: the space names no workspace/u);
  assert.equal(d.writes.get('database')?.ref, undefined, 'the write names no ref');
  // An earlier attempt of this job asked, and the snapshot failed: it is not asked for again.
  const again = door({ unchanged: ['wiki'] });
  const asked = { state: 'failed', error: 'the checkout is not the space\'s repository', id: 'op-1' };
  const withFailed = deps(again.articles, null, {
    repoOps: { enqueueWikiRepoOp: async () => assert.fail('a snapshot asked for twice') } as unknown as WikiRepoOps,
  });
  (withFailed.prisma as unknown as { wikiRepoOp: { findFirst: () => Promise<unknown> } }).wikiRepoOp.findFirst = async () => asked;
  const second = await runWikiArticlesJob(context(fixtureModel()).ctx, withFailed);
  assert.equal(second.ref, null);
  assert.match(second.refWhy ?? '', /ended failed: the checkout is not the space's repository/u);
  assert.ok(again.writes.has('database'));
});
