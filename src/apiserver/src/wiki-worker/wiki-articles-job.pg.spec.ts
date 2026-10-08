/**
 * The server's `articles` job end to end (contracts/wiki.contract.json `articles.serverExecution`, `jobs.kindRuns.articles`,
 * P4), against a real PostgreSQL and a System model played by a local Node http server: the executor, the request queue,
 * the snapshot cache and the real write path, for an account on the canary list (ORBIT_WIKI_EXECUTOR=canary).
 *
 *   1. the job writes the topics whose entries changed — one article for a small topic, an overview and subtopic articles
 *      for a big one — at the commit of the space's snapshot and with the System model's name, and the footnote check
 *      keeps exactly what names the topic's entries: every footnote of every part resolves to an entry of its topic, the
 *      marker out of range is stripped and the sentence left without one deleted. A second job asks nothing and writes
 *      nothing;
 *   2. with no snapshot, the job asks the space's runner for one, parks without a lease, and writes at its commit once the
 *      runner answers; a snapshot that fails is asked for once, and the articles are written without a ref;
 *   3. the System model refuses the key: the queue stops at the first 401 and nothing is written — the job waits as the
 *      platform's failure, not the work's; a 500 is tried again by the queue, and the article is written from the answer
 *      that came (wiki_articles_test.go's 401 and retry cases, on the server);
 *   4. entries that change while the articles are written: WIKI_ARTICLE_STALE leaves the topic unwritten, and the job fails
 *      as content with its report on the row;
 *   5. the trigger (owner, 2026-10-08): a maintenance run's end makes one articles job when it succeeded, recorded ops and
 *      was not made while the space was behind, and only for an account the server runs — one per space while queued or
 *      parked;
 *   6. the runner door in both modes: under the default runner a maintenance session reads and writes the articles as it
 *      always has; for a canary account it is refused WIKI_SERVER_EXECUTES on all three routes, and the job is not.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki-worker/wiki-articles-job.pg.spec.ts
 *
 * Not destructive: it writes only rows under its own accounts, and deletes them afterwards.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { after, afterEach, test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { WIKI_ARTICLE_RULES, WIKI_ARTICLES_JOB, WIKI_REPO_OP_CAPABILITY, type WikiArticleView } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { WikiArticles, wikiArticlesJobPrincipal } from '../wiki/wiki-articles';
import { enqueueWikiArticlesJob, queueWikiArticlesAfterRun, queueWikiArticlesAfterSessionRun } from '../wiki/wiki-articles-jobs';
import { WikiRefusalError, WikiService, type WikiPrincipal } from '../wiki/wiki.service';
import { wikiArticlesJobRunner } from './wiki-articles-job';
import { WikiJobExecutor } from './wiki-job-executor';
import { WikiModelRequestQueue } from './wiki-model-queue.service';
import { WikiModelStatusProbe } from './wiki-model-status';
import { WikiRepoOps } from './wiki-repo-ops';
import { readWikiSystemModel, type WikiSystemModelConfig } from './wiki-system-model';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;

const KEY = `sk-spec-${randomUUID()}`;
const MODEL = 'qwen3-coder-articles-spec';
const SHA = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';

// ── the System model ────────────────────────────────────────────────────────────────────────────

interface Hit {
  prompt: string;
  system: string;
  maxTokens: number;
}

interface FakeModel {
  base: string;
  hits: Hit[];
  /** The status of the nth call (1-based), and what an answered call says. */
  status: (n: number) => number;
  answer: (prompt: string) => string;
  /** Run before a call is answered: what the world does while the model writes. */
  before: (prompt: string) => Promise<void>;
  close: () => Promise<void>;
}

async function fakeModel(): Promise<FakeModel> {
  const sockets = new Set<Socket>();
  const state = {
    base: '',
    hits: [] as Hit[],
    status: (_n: number) => 200,
    answer: (_prompt: string) => '',
    before: async (_prompt: string) => undefined,
    close: async () => undefined,
  } as FakeModel;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      void (async () => {
        if (request.url === '/health') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{}');
          return;
        }
        const parsed = JSON.parse(body) as { system?: string; max_tokens?: number; messages?: Array<{ content?: string }> };
        const prompt = parsed.messages?.[0]?.content ?? '';
        state.hits.push({ prompt, system: parsed.system ?? '', maxTokens: parsed.max_tokens ?? 0 });
        const status = state.status(state.hits.length);
        if (status !== 200) {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'api_error', message: 'no' } }));
          return;
        }
        await state.before(prompt);
        const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(event('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 30, output_tokens: 1 } } }));
        response.write(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: state.answer(prompt) } }));
        response.write(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 90 } }));
        response.write(event('message_stop', { type: 'message_stop' }));
        response.end();
      })();
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

/**
 * What a model writes: a title, sentences footnoted to the entries it was given — one marker out of range, one sentence
 * with none — long enough that the server keeps more than rules.minChars of it. A name for a naming prompt.
 */
function writer(names: string[] = []): (prompt: string) => string {
  let named = 0;
  return (prompt) => {
    if (prompt.includes('起一个简短的中文小标题')) return `好的，这组的小标题是：\n「${names[named++] ?? `第 ${named} 组`}」`;
    const title = /titled "([^"]+)"/u.exec(prompt)?.[1] ?? /topic "([^"]+)"/u.exec(prompt)?.[1] ?? '文章';
    const lines = [`# ${title}`, ''];
    for (let i = 0; i < 12; i += 1) {
      lines.push(`第 ${i + 1} 句写清楚这一组条目说的一条规则，以及它背后的原因和常见的坑[${(i % 2) + 1}]。`);
    }
    lines.push('这一句越界引用了一条不存在的条目[99]。', '这一句没有脚注，会被删掉。');
    return lines.join('\n');
  };
}

// ── the harness ─────────────────────────────────────────────────────────────────────────────────

interface Owner {
  id: string;
  spaceId: string;
  workspaceId: string;
  runnerId: string;
  listId: string;
}

interface Harness {
  sql: Client;
  prisma: PrismaClient;
  model: FakeModel;
  wiki: WikiService;
  articles: WikiArticles;
  ops: WikiRepoOps;
  owners: string[];
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL_);
    const sql = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const prisma = prismaClientFor(URL_ as string);
    const service = prisma as unknown as PrismaService;
    const hub = { publishWikiChanged: () => undefined } as unknown as RealtimeService;
    return {
      sql,
      prisma,
      model: await fakeModel(),
      wiki: new WikiService(service, hub, {} as unknown as PushService),
      articles: new WikiArticles(service),
      ops: new WikiRepoOps(service),
      owners: [],
    };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const { prisma, sql, model, owners } = await harness;
  for (const id of owners) {
    await prisma.wikiSpace.deleteMany({ where: { ownerId: id } }).catch(() => undefined);
    await prisma.session.deleteMany({ where: { ownerId: id } }).catch(() => undefined);
    await prisma.task.deleteMany({ where: { ownerId: id } }).catch(() => undefined);
    await prisma.taskList.deleteMany({ where: { ownerId: id } }).catch(() => undefined);
    await prisma.workspace.deleteMany({ where: { ownerId: id } }).catch(() => undefined);
    await prisma.runner.deleteMany({ where: { ownerId: id } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id } }).catch(() => undefined);
  }
  await prisma.wikiModelStatus.deleteMany({ where: { id: 1 } }).catch(() => undefined);
  delete process.env.ORBIT_WIKI_EXECUTOR;
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  await prisma.$disconnect().catch(() => undefined);
  await sql.end().catch(() => undefined);
  await model.close().catch(() => undefined);
});

/** An account with a runner that does repository work, a workspace on it, and a space whose maintenance names both. */
async function owner(h: Harness): Promise<Owner> {
  const id = randomUUID();
  h.owners.push(id);
  await h.prisma.user.create({ data: { id, email: `wiki-articles-job-${id}@wiki.invalid`, name: 'articles job spec', passwordHash: 'x' } });
  const runnerId = randomUUID();
  await h.prisma.runner.create({
    data: {
      id: runnerId, name: `articles-${id.slice(0, 8)}`, ownerId: id, tokenHash: `hash-${runnerId}`,
      capabilities: [WIKI_REPO_OP_CAPABILITY], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  await h.prisma.workspace.create({ data: { id: workspaceId, ownerId: id, name: 'articles checkout', runnerId, workDir: '/tmp/articles-spec' } });
  const listId = randomUUID();
  await h.prisma.taskList.create({ data: { id: listId, ownerId: id, title: 'Wiki maintenance' } });
  const spaceId = randomUUID();
  await h.prisma.wikiSpace.create({
    data: {
      id: spaceId, ownerId: id, slug: `articles-${spaceId.slice(0, 8)}`, title: 'Articles job spec',
      repoUrlNorm: 'github.com/example/orbit', rootCommitSha: 'a'.repeat(40),
      settings: { maintenance: { workspaceId, listId } },
    },
  });
  return { id, spaceId, workspaceId, runnerId, listId };
}

const ownerPrincipal = (o: Owner): WikiPrincipal => ({ origin: 'owner', ownerId: o.id, userId: o.id, sessionId: null, toolCallId: null });

/** The owner's own adds, applied at once: their entry ids, in the order given. */
async function adds(h: Harness, o: Owner, entries: Array<Record<string, unknown>>): Promise<string[]> {
  const ids: string[] = [];
  for (let at = 0; at < entries.length; at += 30) {
    const answer = await h.wiki.submitChangeset(ownerPrincipal(o), o.spaceId, {
      rationale: 'what the articles are written from',
      ops: entries.slice(at, at + 30).map((entry) => ({ op: 'add', entry })),
    });
    for (const op of answer.ops as Array<{ status: string; entryId: string }>) {
      assert.equal(op.status, 'applied', `the owner's add applies at once: ${JSON.stringify(op).slice(0, 300)}`);
      ids.push(op.entryId);
    }
  }
  return ids;
}

function pitfall(title: string, summary: string, at: string): Record<string, unknown> {
  return {
    kind: 'pitfall',
    title,
    summary,
    fields: { trigger: { paths: [at], commands: [] }, symptom: summary, cause: '顺序不对。', fix: '按顺序来。' },
    anchors: [{ type: 'path', path: at }],
  };
}

/** A small topic (the database's, by its paths) and a big one (the web client's, in two directories). */
async function topics(h: Harness, o: Owner): Promise<{ database: string[]; web: string[] }> {
  const database = await adds(h, o, Array.from({ length: 4 }, (_, i) =>
    pitfall(`迁移编号先扫描再取 ${i}`, `取迁移号之前先扫描 main 和各个项目分支，第 ${i} 条。`, `src/apiserver/prisma/migrations/04${i}0_x/migration.sql`)));
  const web = await adds(h, o, [
    ...Array.from({ length: 26 }, (_, i) =>
      pitfall(`组件测试要 stub 渲染 ${i}`, `组件的渲染测试里先 stub 子组件，第 ${i} 条。`, `src/web/src/components/Widget${i}.tsx`)),
    ...Array.from({ length: 24 }, (_, i) =>
      pitfall(`lib 请求一律走 api 模块 ${i}`, `lib 里发请求一律经过 api 模块，第 ${i} 条。`, `src/web/src/lib/client${i}.ts`)),
  ]);
  return { database, web };
}

async function snapshot(h: Harness, o: Owner, sha = SHA): Promise<void> {
  await h.prisma.wikiRepoSnapshot.deleteMany({ where: { spaceId: o.spaceId } });
  await h.prisma.wikiRepoSnapshot.create({
    data: { spaceId: o.spaceId, ownerId: o.id, sha, digest: 'd'.repeat(64), sizeBytes: BigInt(2), fragmentCount: 1, fragments: { create: [{ ordinal: 0, content: '{}' }] } },
  });
}

function config(h: Harness): WikiSystemModelConfig {
  return readWikiSystemModel({
    ORBIT_WIKI_MODEL_BASE_URL: h.model.base,
    ORBIT_WIKI_MODEL_API_KEY: KEY,
    ORBIT_WIKI_MODEL: MODEL,
    ORBIT_WIKI_MODEL_CONCURRENCY: '4',
  });
}

/** The workers a case started: stopped after it, so a case that fails halfway leaves nothing claiming. */
const live: Array<{ queue: WikiModelRequestQueue; executor: WikiJobExecutor }> = [];

afterEach(async () => {
  for (const one of live.splice(0)) {
    await one.executor.onModuleDestroy().catch(() => undefined);
    await one.queue.onModuleDestroy().catch(() => undefined);
  }
});

function worker(h: Harness, extra: { snapshotWaitMs?: number } = {}): { queue: WikiModelRequestQueue; executor: WikiJobExecutor } {
  const options = { leaseMs: 2_000, renewMs: 300, partialMs: 100, pollMs: 30 };
  const service = h.prisma as unknown as PrismaService;
  const queue = new WikiModelRequestQueue(service, config(h), new WikiModelStatusProbe(service, config(h)), undefined, options);
  const executor = new WikiJobExecutor(service, queue, options, {
    articles: wikiArticlesJobRunner({ prisma: service, articles: h.articles, repoOps: h.ops, model: MODEL, ...extra }),
  });
  live.push({ queue, executor });
  return { queue, executor };
}

async function canary(h: Harness, ...ids: string[]): Promise<void> {
  process.env.ORBIT_WIKI_EXECUTOR = 'canary';
  process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS = ids.join(',');
  await h.sql.query('DELETE FROM "wiki_model_status"');
  await new WikiModelStatusProbe(h.prisma as unknown as PrismaService, config(h)).check();
}

interface JobRow {
  id: string;
  state: string;
  waiting_for: string | null;
  lease_owner: string | null;
  attempts: number;
  failure_kind: string | null;
  error: string | null;
  priority: number;
  input: Record<string, unknown>;
  report: Record<string, unknown> | null;
}

async function jobs(h: Harness, o: Owner): Promise<JobRow[]> {
  const { rows } = await h.sql.query<JobRow>(
    `SELECT "id", "state", "waiting_for", "lease_owner", "attempts", "failure_kind", "error", "priority", "input", "report"
     FROM "wiki_job" WHERE "space_id" = $1 AND "kind" = 'articles' ORDER BY "created_at", "id"`, [o.spaceId]);
  return rows;
}

/** Run the worker until `done` says so, or fail at the deadline. */
async function until(what: string, worker_: { queue: WikiModelRequestQueue; executor: WikiJobExecutor }, done: () => Promise<boolean>, seconds = 30): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await done()) return;
    assert.ok(Date.now() < deadline, `${what} within ${seconds}s`);
    await worker_.executor.runOnce();
    await worker_.queue.runOnce();
    await delay(30);
  }
}

const settled = (rows: JobRow[]) => rows.length > 0 && rows.every((row) => ['succeeded', 'failed'].includes(row.state));

/** Every part of a topic as the owner reads it, and the footnote check: each footnote names an entry of the topic. */
async function footnotesHold(h: Harness, o: Owner, slug: string, entries: readonly string[]): Promise<WikiArticleView[]> {
  const lead = await h.articles.article(o.id, o.spaceId, slug, 0);
  const views = [lead, ...(await Promise.all(lead.parts.map((part) => h.articles.article(o.id, o.spaceId, slug, part.part))))];
  const topic = new Set(entries);
  for (const view of views) {
    assert.ok(view.blocks.length > 0, `${slug} part ${view.part} has sentences`);
    assert.ok(view.footnotes.length > 0, `${slug} part ${view.part} has footnotes`);
    for (const footnote of view.footnotes) {
      assert.ok(topic.has(footnote.entryId), `${slug} part ${view.part}: footnote ${footnote.n} names an entry of the topic`);
      assert.ok(footnote.entry !== null, `${slug} part ${view.part}: footnote ${footnote.n} resolves to the entry as it stands`);
      assert.equal(footnote.revision, footnote.entry?.currentRevision, 'at the revision it was written from');
    }
    for (const block of view.blocks) {
      for (const sentence of block.sentences) {
        assert.ok(sentence.notes.length > 0, `every kept sentence keeps a footnote: ${sentence.text}`);
        for (const n of sentence.notes) assert.ok(n >= 1 && n <= view.footnotes.length, `footnote ${n} of ${view.footnotes.length}`);
        assert.doesNotMatch(sentence.text, /\[\d+\]/u, 'the markers are out of the text');
      }
    }
    assert.ok(view.chars <= WIKI_ARTICLE_RULES.maxChars, `${view.chars} characters`);
    assert.equal(view.model, MODEL, 'written with the System model');
  }
  return views;
}

// ── 1. the articles, written by the server ──────────────────────────────────────────────────────

test('canary: the server writes the changed topics\' articles, and the footnote check keeps only what names the topic\'s entries', { skip, timeout: 120_000 }, async () => {
  const h = await boot();
  const o = await owner(h);
  const made = await topics(h, o);
  await snapshot(h, o);
  await canary(h, o.id);
  h.model.hits.length = 0;
  h.model.status = () => 200;
  h.model.before = async () => undefined;
  h.model.answer = writer(['组件渲染', 'lib 请求']);
  const w = worker(h);
  assert.equal(await enqueueWikiArticlesJob(h.prisma as unknown as PrismaService, { ownerId: o.id, spaceId: o.spaceId }), true);
  await until('the articles job', w, async () => settled(await jobs(h, o)), 90);
  const [job] = await jobs(h, o);
  assert.equal(job.state, 'succeeded', `job ${job.state}: ${job.error}`);
  assert.equal(job.priority, WIKI_ARTICLES_JOB.priority);
  const report = job.report as { written: number; failed: number; ref: string; model: string; calls: number; topics: Array<{ slug: string; outcome: string }>; stats: { markersStripped: number; sentencesDeleted: number } };
  assert.equal(report.ref, SHA, 'written at the snapshot\'s commit');
  assert.equal(report.model, MODEL);
  assert.deepEqual(report.topics.map((topic) => [topic.slug, topic.outcome]).sort(), [['database', 'written'], ['web-client', 'written']]);
  assert.ok(report.stats.markersStripped >= 1 && report.stats.sentencesDeleted >= 1, 'the check stripped the stray marker and deleted the bare sentence');

  // The small topic: one article. The big one: an overview over two subtopics that hold its entries, each once.
  const database = await footnotesHold(h, o, 'database', made.database);
  assert.deepEqual(database.map((view) => view.kind), ['article']);
  const web = await footnotesHold(h, o, 'web-client', made.web);
  assert.equal(web[0].kind, 'overview');
  assert.deepEqual(web.slice(1).map((view) => view.kind), ['subtopic', 'subtopic']);
  const pooled = web.slice(1).flatMap((view) => view.entryIds);
  assert.equal(new Set(pooled).size, made.web.length, 'every entry of the topic is in exactly one subtopic');
  for (const view of web.slice(1)) {
    const dirs = new Set(view.entries.map((entry) => (entry.anchors as Array<{ path: string }>)[0].path.split('/')[3]));
    assert.equal(dirs.size, 1, `a subtopic holds one directory, not ${[...dirs].join(' and ')}`);
  }
  const rows = await h.prisma.wikiTopicSummary.findMany({ where: { ownerId: o.id }, select: { ref: true, model: true } });
  assert.ok(rows.length === 4 && rows.every((row) => row.ref === SHA && row.model === MODEL));

  // Every call went through the queue, as the job's: the writer's system prompt, the contract's max_tokens.
  const requests = await h.prisma.wikiModelRequest.findMany({ where: { jobId: job.id }, select: { step: true, unit: true, state: true } });
  assert.equal(requests.length, h.model.hits.length, 'one request a call');
  assert.equal(report.calls, requests.length);
  assert.ok(requests.every((request) => request.step === WIKI_ARTICLES_JOB.step && request.state === 'succeeded'));
  assert.deepEqual(requests.filter((request) => request.unit.includes('/name-')).length, 2, 'the two groups were named');
  for (const hit of h.model.hits) {
    assert.match(hit.system, /encyclopedia-style wiki articles/u);
    assert.equal(hit.maxTokens, hit.prompt.includes('起一个简短的中文小标题') ? WIKI_ARTICLES_JOB.nameMaxTokens : WIKI_ARTICLES_JOB.articleMaxTokens);
  }

  // Nothing changed since: the next job asks nothing and writes nothing.
  const asked = h.model.hits.length;
  assert.equal(await enqueueWikiArticlesJob(h.prisma as unknown as PrismaService, { ownerId: o.id, spaceId: o.spaceId }), true);
  await until('the second job', w, async () => settled(await jobs(h, o)), 30);
  const second = (await jobs(h, o))[1];
  assert.equal(second.state, 'succeeded');
  assert.deepEqual((second.report as { topics: unknown[] }).topics, [], 'no topic\'s entries changed');
  assert.equal(h.model.hits.length, asked, 'the model was not asked again');
});

// ── 2. the ref: the snapshot's, asked for when there is none ─────────────────────────────────────

test('no snapshot yet: the job asks the space\'s runner for one, parks without a lease, and writes at its commit once it lands', { skip, timeout: 120_000 }, async () => {
  const h = await boot();
  const o = await owner(h);
  await adds(h, o, Array.from({ length: 3 }, (_, i) =>
    pitfall(`迁移编号先扫描再取 ${i}`, `取迁移号之前先扫描，第 ${i} 条。`, `src/apiserver/prisma/migrations/05${i}0_x/migration.sql`)));
  await canary(h, o.id);
  h.model.hits.length = 0;
  h.model.status = () => 200;
  h.model.before = async () => undefined;
  h.model.answer = writer();
  const w = worker(h);
  await enqueueWikiArticlesJob(h.prisma as unknown as PrismaService, { ownerId: o.id, spaceId: o.spaceId });
  // Parked: waiting for the repository, no lease, and one snapshot asked of the workspace's runner.
  await until('the job to park', w, async () => (await jobs(h, o))[0]?.state === 'waiting', 20);
  const parked = (await jobs(h, o))[0];
  assert.equal(parked.waiting_for, 'repo');
  assert.equal(parked.lease_owner, null, 'a parked job holds no lease');
  const asked = await h.prisma.wikiRepoOp.findMany({ where: { jobId: parked.id }, select: { id: true, kind: true, runnerId: true, state: true } });
  assert.deepEqual(asked.map((op) => [op.kind, op.runnerId, op.state]), [['snapshot', o.runnerId, 'queued']]);
  assert.equal(h.model.hits.length, 0, 'nothing was asked of the model before the ref was known');

  // The runner beats, takes it, and answers with the commit it read.
  const leaseOwner = randomUUID();
  const [claim] = await h.ops.dispatch({ runnerId: o.runnerId, leaseOwner, draining: false, capabilities: [WIKI_REPO_OP_CAPABILITY] });
  assert.equal(claim.kind, 'snapshot');
  const sha = 'feedface'.repeat(5);
  await h.ops.applyWikiRepoOpResult({
    id: claim.id, runnerId: o.runnerId,
    body: { claimGeneration: claim.claimGeneration, leaseOwner, state: 'succeeded', result: { sha, index: '{"paths":[]}' } },
  });
  await until('the job to resume and write', w, async () => settled(await jobs(h, o)), 40);
  const done = (await jobs(h, o))[0];
  assert.equal(done.state, 'succeeded', `${done.state}: ${done.error}`);
  assert.equal((done.report as { ref: string }).ref, sha);
  const row = await h.prisma.wikiTopicSummary.findFirst({ where: { ownerId: o.id, part: 0 }, select: { ref: true } });
  assert.equal(row?.ref, sha, 'the article names the commit the runner read');
  assert.equal(await h.prisma.wikiRepoOp.count({ where: { jobId: done.id } }), 1, 'asked once');

  // A snapshot that fails: asked for once, and the articles are written without a ref.
  const failing = await owner(h);
  await adds(h, failing, [pitfall('迁移先 generate', '改了 schema 先 prisma generate。', 'src/apiserver/prisma/schema.prisma')]);
  await canary(h, o.id, failing.id);
  const w2 = worker(h);
  await enqueueWikiArticlesJob(h.prisma as unknown as PrismaService, { ownerId: failing.id, spaceId: failing.spaceId });
  await until('the second space\'s job to park', w2, async () => (await jobs(h, failing))[0]?.state === 'waiting', 20);
  const [bad] = await h.ops.dispatch({ runnerId: failing.runnerId, leaseOwner, draining: false, capabilities: [WIKI_REPO_OP_CAPABILITY] });
  await h.ops.applyWikiRepoOpResult({
    id: bad.id, runnerId: failing.runnerId,
    body: { claimGeneration: bad.claimGeneration, leaseOwner, state: 'failed', error: 'the checkout is not the space\'s repository' },
  });
  await until('the job to write without a ref', w2, async () => settled(await jobs(h, failing)), 40);
  const without = (await jobs(h, failing))[0];
  assert.equal(without.state, 'succeeded', `${without.state}: ${without.error}`);
  assert.equal((without.report as { ref: string | null }).ref, null);
  assert.match((without.report as { refWhy: string }).refWhy, /ended failed: the checkout is not the space's repository/u);
  assert.equal(without.attempts, 1, 'the failed snapshot was the platform\'s attempt, counted once');
  assert.equal(await h.prisma.wikiRepoOp.count({ where: { jobId: without.id } }), 1, 'not asked for twice');
  const unreffed = await h.prisma.wikiTopicSummary.findFirst({ where: { ownerId: failing.id, part: 0 }, select: { ref: true } });
  assert.equal(unreffed?.ref, null);
});

// ── 3. the model's endpoint: a 401 stops the queue, a 500 is tried again ─────────────────────────

test('the System model refuses the key: the queue stops at the first 401, nothing is written, and the job waits as infra', { skip, timeout: 120_000 }, async () => {
  const h = await boot();
  const o = await owner(h);
  await adds(h, o, Array.from({ length: 3 }, (_, i) => pitfall(`迁移 ${i}`, `迁移说明 ${i}。`, `src/apiserver/prisma/migrations/06${i}0_x/migration.sql`)));
  await snapshot(h, o);
  await canary(h, o.id);
  h.model.hits.length = 0;
  h.model.status = () => 401;
  h.model.before = async () => undefined;
  h.model.answer = writer();
  const w = worker(h);
  await enqueueWikiArticlesJob(h.prisma as unknown as PrismaService, { ownerId: o.id, spaceId: o.spaceId });
  await until('the first call', w, async () => h.model.hits.length >= 1, 20);
  for (let i = 0; i < 20; i += 1) {
    await w.executor.runOnce();
    await w.queue.runOnce();
    await delay(30);
  }
  assert.equal(h.model.hits.length, 1, 'the endpoint was asked once: the queue stops at the first 401');
  const status = await h.prisma.wikiModelStatus.findUnique({ where: { id: 1 }, select: { state: true } });
  assert.equal(status?.state, 'auth_failed');
  assert.equal(await h.prisma.wikiTopicSummary.count({ where: { ownerId: o.id } }), 0, 'nothing was written');
  // The request waits for the key until its step's limit; then the job is the platform's to retry, not ended.
  const [job] = await jobs(h, o);
  await h.sql.query(`UPDATE "wiki_model_request" SET "enqueued_at" = now() - interval '901 seconds' WHERE "job_id" = $1`, [job.id]);
  await until('the job to be handed back', w, async () => (await jobs(h, o))[0].failure_kind === 'infra', 20);
  const back = (await jobs(h, o))[0];
  assert.equal(back.state, 'queued', 'retried, not ended');
  assert.equal(back.attempts, 1);
  assert.match(back.error ?? '', /waited past its step's limit/u);
  assert.equal(await h.prisma.wikiTopicSummary.count({ where: { ownerId: o.id } }), 0);
  await h.sql.query('DELETE FROM "wiki_job" WHERE "id" = $1', [job.id]);
});

test('a 500 is tried again by the queue, and the article is written from the answer that came', { skip, timeout: 120_000 }, async () => {
  const h = await boot();
  const o = await owner(h);
  await adds(h, o, Array.from({ length: 3 }, (_, i) => pitfall(`迁移 ${i}`, `迁移说明 ${i}。`, `src/apiserver/prisma/migrations/07${i}0_x/migration.sql`)));
  await snapshot(h, o);
  await canary(h, o.id);
  h.model.hits.length = 0;
  h.model.status = (n) => (n === 1 ? 500 : 200);
  h.model.before = async () => undefined;
  h.model.answer = writer();
  const w = worker(h);
  await enqueueWikiArticlesJob(h.prisma as unknown as PrismaService, { ownerId: o.id, spaceId: o.spaceId });
  await until('the job', w, async () => settled(await jobs(h, o)), 60);
  const [job] = await jobs(h, o);
  assert.equal(job.state, 'succeeded', `${job.state}: ${job.error}`);
  assert.equal(h.model.hits.length, 2, 'asked twice: the 500, then the answer');
  const [request] = await h.prisma.wikiModelRequest.findMany({ where: { jobId: job.id }, select: { attempts: true, state: true } });
  assert.equal(request.state, 'succeeded');
  assert.equal(request.attempts, 1, 'the queue put the call back once after the 500, on its own backoff');
  assert.equal(await h.prisma.wikiTopicSummary.count({ where: { ownerId: o.id, part: 0 } }), 1, 'the article was written');
});

// ── 4. entries that move while the model writes ──────────────────────────────────────────────────

test('entries that change while the articles are written: WIKI_ARTICLE_STALE leaves the topic unwritten, and the job fails as content', { skip, timeout: 120_000 }, async () => {
  const h = await boot();
  const o = await owner(h);
  const [first] = await adds(h, o, Array.from({ length: 3 }, (_, i) =>
    pitfall(`迁移 ${i}`, `迁移说明 ${i}。`, `src/apiserver/prisma/migrations/08${i}0_x/migration.sql`)));
  await snapshot(h, o);
  await canary(h, o.id);
  h.model.hits.length = 0;
  h.model.status = () => 200;
  h.model.answer = writer();
  // While the model writes, the owner amends one of the topic's entries: its fingerprint moves.
  let amended = false;
  h.model.before = async () => {
    if (amended) return;
    amended = true;
    const answer = await h.wiki.submitChangeset(ownerPrincipal(o), o.spaceId, {
      rationale: 'a sharper summary',
      ops: [{ op: 'amend', entryId: first, baseRevision: 1, changes: { summary: '迁移说明，改得更清楚。' } }],
    });
    assert.equal((answer.ops as Array<{ status: string }>)[0].status, 'applied', JSON.stringify(answer).slice(0, 300));
  };
  const w = worker(h);
  await enqueueWikiArticlesJob(h.prisma as unknown as PrismaService, { ownerId: o.id, spaceId: o.spaceId });
  await until('the job', w, async () => settled(await jobs(h, o)), 60);
  const [job] = await jobs(h, o);
  assert.equal(job.state, 'failed');
  assert.equal(job.failure_kind, 'content');
  assert.match(job.error ?? '', /1 topic was left unwritten: the next run tries again/u);
  const report = job.report as { failed: number; topics: Array<{ slug: string; outcome: string; why: string }> };
  assert.equal(report.failed, 1);
  assert.equal(report.topics[0].outcome, 'failed');
  assert.match(report.topics[0].why, /^WIKI_ARTICLE_STALE: /u);
  assert.equal(await h.prisma.wikiTopicSummary.count({ where: { ownerId: o.id } }), 0, 'nothing was written from the old entries');
});

// ── 5. the trigger ──────────────────────────────────────────────────────────────────────────────

/** A maintenance run of the space that ended: its task and session, the run row, and — when it recorded ops — its changeset. */
async function runEnd(h: Harness, o: Owner, end: { outcome: string; catchUp?: string | null; ops?: boolean }): Promise<string> {
  const taskId = randomUUID();
  await h.prisma.task.create({ data: { id: taskId, title: 'Wiki maintenance run', ownerId: o.id, creatorType: 'USER', creatorId: o.id, listId: o.listId, completionCriterion: 'OWNER_CONFIRMED' } });
  const sessionId = randomUUID();
  await h.sql.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","workspace_id","assigned_runner_id","task_id","status","dispatch_origin","updated_at")
     VALUES ($1,'a maintenance run','p',$2,$2,$3,$4,$5,'SUCCEEDED'::run_status,'USER',now())`,
    [sessionId, o.id, o.workspaceId, o.runnerId, taskId],
  );
  await h.prisma.wikiMaintenanceRun.create({
    data: {
      spaceId: o.spaceId, ownerId: o.id, taskId, sessionId, startedAt: new Date(), endedAt: new Date(),
      outcome: end.outcome, failureKind: end.outcome === 'succeeded' ? null : 'content', catchUp: end.catchUp ?? null,
    },
  });
  if (end.ops !== false) {
    await h.prisma.wikiChangeset.create({ data: { ownerId: o.id, spaceId: o.spaceId, origin: 'maintenance', sessionId, status: 'settled', decidedAt: new Date() } });
  }
  return sessionId;
}

test('a maintenance run\'s end makes one articles job: succeeded, ops recorded, not behind — and only for an account the server runs', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  const o = await owner(h);
  const service = h.prisma as unknown as PrismaService;
  const after_ = (sessionId: string) => queueWikiArticlesAfterSessionRun(service, { ownerId: o.id, spaceId: o.spaceId, sessionId });

  // The default runner: nothing, whatever the run.
  delete process.env.ORBIT_WIKI_EXECUTOR;
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  assert.equal(await after_(await runEnd(h, o, { outcome: 'succeeded' })), false);
  // Canary, with another account listed: nothing.
  await canary(h, randomUUID());
  assert.equal(await after_(await runEnd(h, o, { outcome: 'succeeded' })), false);
  assert.equal((await jobs(h, o)).length, 0);

  await canary(h, o.id);
  // Runs the rule does not name: failed, truncated, behind (active or paused), no ops.
  assert.equal(await after_(await runEnd(h, o, { outcome: 'failed' })), false);
  assert.equal(await after_(await runEnd(h, o, { outcome: 'truncated' })), false);
  assert.equal(await after_(await runEnd(h, o, { outcome: 'succeeded', catchUp: 'active' })), false);
  assert.equal(await after_(await runEnd(h, o, { outcome: 'succeeded', catchUp: 'paused' })), false);
  assert.equal(await after_(await runEnd(h, o, { outcome: 'succeeded', ops: false })), false);
  assert.equal((await jobs(h, o)).length, 0);

  // The run it names: one articles job, background, with nothing in its input.
  assert.equal(await after_(await runEnd(h, o, { outcome: 'succeeded' })), true);
  let made = await jobs(h, o);
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].state, made[0].priority, made[0].input], ['queued', WIKI_ARTICLES_JOB.priority, {}]);
  // Another run ends while it is queued, or parked: it covers that one too.
  assert.equal(await after_(await runEnd(h, o, { outcome: 'succeeded' })), false);
  await h.sql.query(`UPDATE "wiki_job" SET "state" = 'waiting', "waiting_for" = 'repo' WHERE "id" = $1`, [made[0].id]);
  assert.equal(await after_(await runEnd(h, o, { outcome: 'succeeded' })), false);
  // Once it runs it may have read the plan: the next run's end queues one behind it.
  await h.sql.query(`UPDATE "wiki_job" SET "state" = 'running', "waiting_for" = NULL, "lease_owner" = gen_random_uuid(),
    "lease_generation" = gen_random_uuid(), "lease_deadline_at" = now() + interval '1 minute' WHERE "id" = $1`, [made[0].id]);
  assert.equal(await after_(await runEnd(h, o, { outcome: 'succeeded' })), true);
  made = await jobs(h, o);
  assert.deepEqual(made.map((row) => row.state), ['running', 'queued']);
  // P8's entry, with its own run's facts, reads the same rule.
  assert.equal(await queueWikiArticlesAfterRun(service, { ownerId: o.id, spaceId: o.spaceId, outcome: 'succeeded', catchUp: 'active', recordedOps: true }), false);
  assert.equal(await queueWikiArticlesAfterRun(service, { ownerId: o.id, spaceId: o.spaceId, outcome: 'succeeded', catchUp: null, recordedOps: true }), false, 'one is queued already');
  await h.sql.query(`DELETE FROM "wiki_job" WHERE "space_id" = $1`, [o.spaceId]);
});

// ── 6. the runner door, in both modes ───────────────────────────────────────────────────────────

test('the runner door: a maintenance session writes as ever under runner, and is refused WIKI_SERVER_EXECUTES for a canary account', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  const o = await owner(h);
  await adds(h, o, [pitfall('迁移先 generate', '改了 schema 先 prisma generate。', 'src/apiserver/prisma/schema.prisma')]);
  // A maintenance run of the space: a session whose task is in the space's maintenance list.
  const taskId = randomUUID();
  await h.prisma.task.create({ data: { id: taskId, title: 'Wiki maintenance run', ownerId: o.id, creatorType: 'USER', creatorId: o.id, listId: o.listId, completionCriterion: 'OWNER_CONFIRMED' } });
  const sessionId = randomUUID();
  await h.sql.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","workspace_id","assigned_runner_id","task_id","status","dispatch_origin","updated_at")
     VALUES ($1,'a maintenance run','p',$2,$2,$3,$4,$5,'RUNNING'::run_status,'USER',now())`,
    [sessionId, o.id, o.workspaceId, o.runnerId, taskId],
  );
  const session: WikiPrincipal = { origin: 'maintenance', ownerId: o.id, userId: null, sessionId, toolCallId: null };

  // The default runner: the plan, the input and the write, as they have always been.
  delete process.env.ORBIT_WIKI_EXECUTOR;
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  const plan = await h.articles.plan(session, o.spaceId);
  const topic = plan.topics.find((one) => one.changed)!;
  const input = await h.articles.input(session, o.spaceId, topic.slug);
  const body = {
    entrySetSha256: input.entrySetSha256, ref: SHA, model: 'qwen3.8-27b-fp8',
    articles: [{ part: 0, kind: 'article', title: '迁移', markdown: '改了 schema 先 prisma generate[1]。', notes: [input.entries[0].id] }],
  };
  assert.equal((await h.articles.write(session, o.spaceId, topic.slug, body)).written, true);

  // A canary account: refused on all three, and nothing is read or written.
  await canary(h, o.id);
  const refused = async (call: () => Promise<unknown>, what: string) => {
    await assert.rejects(call, (error: unknown) => {
      assert.ok(error instanceof WikiRefusalError, `${what}: ${String(error)}`);
      assert.equal(error.refusal.code, 'WIKI_SERVER_EXECUTES', what);
      assert.equal(error.getStatus(), 409, what);
      assert.match(error.refusal.message, /ORBIT_WIKI_EXECUTOR=canary/u);
      return true;
    });
  };
  await refused(() => h.articles.plan(session, o.spaceId), 'the plan');
  await refused(() => h.articles.input(session, o.spaceId, topic.slug), 'the input');
  await refused(() => h.articles.write(session, o.spaceId, topic.slug, { ...body, entrySetSha256: 'f'.repeat(64) }), 'the write');
  // Another account's session is refused as it always was; the server's own job is not refused at all.
  await assert.rejects(h.articles.plan({ ...session, sessionId: randomUUID() }, o.spaceId), (error: unknown) =>
    error instanceof WikiRefusalError && error.refusal.code === 'WIKI_NOT_MAINTENANCE_SESSION');
  const asJob = await h.articles.plan(wikiArticlesJobPrincipal(o.id), o.spaceId);
  assert.equal(asJob.spaceId, o.spaceId);
  delete process.env.ORBIT_WIKI_EXECUTOR;
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
});
