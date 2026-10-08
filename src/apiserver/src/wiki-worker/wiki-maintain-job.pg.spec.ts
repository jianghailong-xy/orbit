/**
 * The server-executed maintenance run (contracts/wiki.contract.json `jobs.kindRuns.maintain`,
 * `maintenance.job.server`; design §5 and §8, P8), against a real PostgreSQL and a System model played by a
 * local Node http server — the same harness the verify and docs jobs' specs use, with the space's runner
 * played by a poll that settles the `wiki_repo_op` rows the run enqueues:
 *
 *   1. a whole run: the dossiers read, one extract request per dossier through the queue, the entries checked
 *      against their lines and the snapshot (an off-topic case, a foreign anchor, a principle and a quote the
 *      retry corrects), the batches dry-run and proposed with origin maintenance under the run's wiki job,
 *      the cursor advanced past the sessions whose ops were recorded, the run's own ops verified, the anchors
 *      re-checked through a repository operation, no document written without a confirmed plan, the report
 *      with its token spend, and the articles job a successful run owes queued behind it;
 *   2. a run made while the space was catching up skips the documents and the plan proposal whole, and owes
 *      no articles job;
 *   3. the breaker: with a space holding the floor of active entries and two pages of dossiers, the second
 *      page's ops are held back and the cursor stops where that page starts;
 *   4. failure: a repository operation the runner never answers is the platform's — the job goes back to
 *      queued and nothing is counted against the space. A refusal of the run's own ends it failed, counts it
 *      and fails the job as content;
 *   5. the anchors step: a page of two entries whose anchors collide on the per-entry index is checked as
 *      one repository operation, and each entry records only its own checks — a symbol without a baseline
 *      adopts its own region, never a page-mate's (the canary incident: per-entry indexes mapped back
 *      through one Map overwrote each other, and entries took the last entry's verdict for their index).
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki-worker/wiki-maintain-job.pg.spec.ts
 *
 * Not destructive: it writes only rows under its own account, spaces and sessions, and deletes them
 * afterwards.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { after, afterEach, test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { encodeCursorToken, WikiMaintenance } from '../wiki/wiki-maintenance';
import { wikiDocsAffected } from '../wiki/wiki-docs-affected';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { WikiDocs } from '../wiki/wiki-docs';
import { WikiPlans } from '../wiki/wiki-plan';
import { WikiRefusalError, WikiService, type WikiPrincipal } from '../wiki/wiki.service';
import { WikiRepoOps } from './wiki-repo-ops';
import { WIKI_REPO_OP_CAPABILITY } from '@orbit/shared';
import { WikiJobExecutor, WIKI_JOB_RUNNERS, type WikiJobRunner } from './wiki-job-executor';
import { WikiModelRequestQueue } from './wiki-model-queue.service';
import { WikiModelStatusProbe } from './wiki-model-status';
import { readWikiSystemModel, type WikiSystemModelConfig } from './wiki-system-model';
import { wikiMaintainJobRunner, type WikiMaintainJobDeps } from './wiki-maintain-job';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;

const KEY = `sk-spec-${randomUUID()}`;
const MODEL = 'qwen3-coder-spec';

interface Hit {
  prompt: string;
}

interface FakeModel {
  base: string;
  answer: (hit: Hit) => string;
  hits: Hit[];
  close: () => Promise<void>;
}

async function fakeModel(): Promise<FakeModel> {
  const sockets = new Set<Socket>();
  const hits: Hit[] = [];
  const state = {
    base: '',
    answer: (): string => '[]',
    hits,
    close: async () => undefined,
  } as FakeModel;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      let prompt = '';
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
        prompt = parsed.messages?.[0]?.content ?? '';
      } catch {
        prompt = '';
      }
      hits.push({ prompt });
      const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      const write = (what: string) => {
        try {
          response.write(what);
        } catch {
          /* the call was abandoned */
        }
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      write(event('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 3, output_tokens: 1 } } }));
      write(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: state.answer({ prompt }) } }));
      write(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }));
      write(event('message_stop', { type: 'message_stop' }));
      try {
        response.end();
      } catch {
        /* the call was abandoned */
      }
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  state.base = `http://127.0.0.1:${port}`;
  state.close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

interface Harness {
  sql: Client;
  prisma: PrismaClient;
  model: FakeModel;
  service: WikiService;
  docs: WikiDocs;
  plans: WikiPlans;
  maintenance: WikiMaintenance;
  repoOps: WikiRepoOps;
  ownerId: string;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL_);
    const sql = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const prisma = prismaClientFor(URL_ as string);
    const model = await fakeModel();
    const hub = { publishWikiChanged: () => undefined } as unknown as RealtimeService;
    const push = {
      notifyWikiVerificationTripped: async () => undefined,
      notifyWikiReviewModeTripped: async () => undefined,
      notifyWikiMaintenanceFailing: async () => undefined,
    } as unknown as PushService;
    const service = new WikiService(prisma as unknown as PrismaService, hub, push);
    const maintenance = new WikiMaintenance(prisma as unknown as PrismaService, push);
    const docs = new WikiDocs(prisma as unknown as PrismaService, service);
    const plans = new WikiPlans(prisma as unknown as PrismaService, hub);
    const repoOps = new WikiRepoOps(prisma as unknown as PrismaService);
    const ownerId = randomUUID();
    await prisma.user.create({ data: { id: ownerId, email: `wiki-maintain-job-${ownerId}@wiki.invalid`, name: 'maintain job spec', passwordHash: 'x' } });
    // The server executes this account's wiki: what makes the executor claim its jobs and the run's end owe
    // the articles job (contract `jobs.executor`, `articles.regeneration`). Cleared in `after`.
    process.env.ORBIT_WIKI_EXECUTOR = 'server';
    return { sql, prisma, model, service, docs, plans, maintenance, repoOps, ownerId };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const { prisma, sql, model, ownerId } = await harness;
  delete process.env.ORBIT_WIKI_EXECUTOR;
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  await prisma.wikiSpace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.workspace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.runner.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  await prisma.wikiModelStatus.deleteMany({ where: { id: 1 } }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await sql.end().catch(() => undefined);
  await model.close().catch(() => undefined);
});

function config(h: Harness, concurrency = 2): WikiSystemModelConfig {
  return readWikiSystemModel({
    ORBIT_WIKI_MODEL_BASE_URL: h.model.base,
    ORBIT_WIKI_MODEL_API_KEY: KEY,
    ORBIT_WIKI_MODEL: MODEL,
    ORBIT_WIKI_MODEL_CONCURRENCY: String(concurrency),
  });
}

/** Where the run reads its repository at: the snapshot's commit, its files and what the gates answer from. */
const REPO = {
  sha: 'a'.repeat(40),
  paths: ['src/app.go', 'docs/README.md', 'README.md'],
  commits: [],
  readme: 'App is the spec\'s own service, small enough to read in a minute.',
};

interface Fixture {
  spaceId: string;
  workspaceId: string;
  runnerId: string;
  sessionId: string;
  callId: string;
  jobId: string;
  runId: string;
  /** The position the page's cursor names, which the cursor row's issued position covers. */
  position: { at: Date; kind: string; ref: string };
  token: string;
}

/**
 * One space of the spec's own, with a machine and a checkout behind it, the snapshot the run reads, a
 * settled session record a dossier line may cite, and the run row and job the trigger would have made.
 */
async function fixture(h: Harness, over: { catchUp?: string | null; expect?: boolean; activeEntries?: number } = {}): Promise<Fixture> {
  const runnerId = randomUUID();
  await h.prisma.runner.create({
    data: {
      id: runnerId, name: `maintain-${runnerId.slice(0, 8)}`, ownerId: h.ownerId, tokenHash: `hash-${runnerId}`,
      capabilities: [WIKI_REPO_OP_CAPABILITY], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  await h.prisma.workspace.create({
    data: { id: workspaceId, ownerId: h.ownerId, name: 'maintain checkout', runnerId, workDir: '/tmp/maintain-spec' },
  });
  const spaceId = randomUUID();
  await h.prisma.wikiSpace.create({
    data: {
      id: spaceId, ownerId: h.ownerId, slug: `maintain-${spaceId.slice(0, 8)}`, title: 'app',
      repoUrlNorm: `github.com/example/app-${spaceId.slice(0, 8)}`, rootCommitSha: 'b'.repeat(40),
      settings: { reviewMode: 'automatic', maintenance: { enabled: true, workspaceId, provider: 'local-vllm' } },
    },
  });
  const sessionId = randomUUID();
  await h.prisma.session.create({
    data: {
      id: sessionId, title: '修 fixture 的端口', prompt: 'p', ownerId: h.ownerId, creatorId: h.ownerId,
      dispatchOrigin: 'USER', status: 'SUCCEEDED', lastTurnAt: new Date(), workspaceId,
    },
  });
  const callId = randomUUID();
  await h.sql.query(`INSERT INTO "tool_call"("id","session_id","name","output") VALUES ($1,$2,'Bash',$3)`, [
    callId, sessionId, JSON.stringify('$ go test ./... → ERR: connect ECONNREFUSED 127.0.0.1:9000'),
  ]);
  // The snapshot the run reads: the index the runner would have uploaded, and the sha the op names.
  const index = JSON.stringify({
    sha: REPO.sha, date: '2026-09-20',
    files: REPO.paths.map((path) => ({ path, size: 100 })),
    docs: [{ path: 'docs/README.md', title: 'App', headings: [{ level: 1, text: 'App' }] }],
    symbols: { 'src/app.go': ['main'] },
    contracts: null,
    commits: REPO.commits,
    readme: REPO.readme,
  });
  await h.sql.query(
    `INSERT INTO "wiki_repo_snapshot"("space_id","owner_id","sha","digest","size_bytes","fragment_count")
     VALUES ($1,$2,$3,$4,$5,1)`,
    [spaceId, h.ownerId, REPO.sha, 'c'.repeat(64), Buffer.byteLength(index, 'utf8')],
  );
  await h.sql.query(`INSERT INTO "wiki_repo_snapshot_fragment"("space_id","ordinal","content") VALUES ($1,0,$2)`, [spaceId, index]);
  // The cursor: the watermark at the beginning, and the position the page below hands out, issued — the
  // advance the run makes is checked against it, as the real route's would be.
  const position = { at: new Date('2026-09-20T00:00:00.000Z'), kind: 'session_settled', ref: sessionId };
  await h.sql.query(
    `INSERT INTO "wiki_cursor"("id","space_id","owner_id","source","issued_at","issued_kind","issued_ref")
     VALUES ($1,$2,$3,'facts',$4,$5,$6)`,
    [randomUUID(), spaceId, h.ownerId, position.at.toISOString(), position.kind, position.ref],
  );
  for (let i = 0; i < (over.activeEntries ?? 0); i += 1) {
    await h.prisma.wikiEntry.create({
      data: {
        ownerId: h.ownerId, spaceId, kind: 'concept', title: `existing ${i}`, summary: 'a live entry', status: 'active',
        trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [], anchors: [],
      },
    });
  }
  const runId = randomUUID();
  const jobId = randomUUID();
  const token = over.expect === false ? null : encodeCursorToken(spaceId, position as never);
  await h.prisma.wikiMaintenanceRun.create({
    data: {
      id: runId, spaceId, ownerId: h.ownerId, jobId, due: 'backlog', backlog: 1, pendingSessions: 1,
      oldestPendingAt: position.at, catchUp: over.catchUp ?? null,
      ...(token ? { expectAt: position.at, expectKind: position.kind, expectRef: position.ref } : {}),
    },
  });
  await h.prisma.wikiJob.create({ data: { id: jobId, ownerId: h.ownerId, spaceId, kind: 'maintain', input: { runId }, state: 'queued' } });
  return { spaceId, workspaceId, runnerId, sessionId, callId, jobId, runId, position, token: token ?? '' };
}

/** The workers this case started; a case that fails halfway must not leave one claiming the next one's jobs. */
const live: Array<{ queue: WikiModelRequestQueue; executor: WikiJobExecutor }> = [];

afterEach(async () => {
  for (const one of live.splice(0)) {
    await one.executor.onModuleDestroy().catch(() => undefined);
    await one.queue.onModuleDestroy().catch(() => undefined);
  }
});

/** The worker under test, its kind map the one the worker module builds — with this spec's services. */
function worker(h: Harness, over: { repoWaitMs?: number } = {}): { queue: WikiModelRequestQueue; executor: WikiJobExecutor } {
  const options = { leaseMs: 400, renewMs: 100, partialMs: 40, pollMs: 30 };
  const config_ = config(h);
  const queue = new WikiModelRequestQueue(
    h.prisma as unknown as PrismaService, config_,
    new WikiModelStatusProbe(h.prisma as unknown as PrismaService, config_), undefined, options,
  );
  const deps: WikiMaintainJobDeps = {
    prisma: h.prisma as unknown as PrismaService,
    wiki: h.service,
    maintenance: h.maintenance,
    docs: h.docs,
    plans: h.plans,
    repoOps: h.repoOps,
    model: MODEL,
    modelBaseUrl: h.model.base,
    repoWaitMs: over.repoWaitMs ?? 5_000,
  };
  const runners: Record<string, WikiJobRunner> = { ...WIKI_JOB_RUNNERS, maintain: wikiMaintainJobRunner(deps) };
  const executor = new WikiJobExecutor(h.prisma as unknown as PrismaService, queue, options, runners);
  live.push({ queue, executor });
  return { queue, executor };
}

async function modelUp(h: Harness): Promise<void> {
  await new WikiModelStatusProbe(h.prisma as unknown as PrismaService, config(h)).check();
}

/**
 * What one case leaves behind for the next: the jobs and requests of the account, and the fake model's
 * record of the calls.
 */
async function clearWork(h: Harness): Promise<void> {
  await h.sql.query('DELETE FROM "wiki_job" WHERE "owner_id" = $1', [h.ownerId]);
  await h.sql.query('DELETE FROM "wiki_model_request" WHERE "owner_id" = $1', [h.ownerId]);
  await h.sql.query('DELETE FROM "wiki_model_status"');
  h.model.hits.length = 0;
  h.model.answer = () => '[]';
  await modelUp(h);
}

/** The runner this spec plays: every queued repository operation is answered at once, by kind. */
async function runRepoOps(h: Harness, over: { failSnapshot?: boolean; checkAnchor?: (anchor: Record<string, unknown>) => Record<string, unknown> } = {}): Promise<number> {
  const rows = await h.sql.query<{ id: string; kind: string; input: Record<string, unknown> }>(
    `SELECT "id", "kind", "input" FROM "wiki_repo_op" WHERE "owner_id" = $1 AND "state" = 'queued' ORDER BY "created_at"`,
    [h.ownerId],
  ).then((result) => result.rows);
  for (const row of rows) {
    if (over.failSnapshot === true && row.kind === 'snapshot') {
      await h.sql.query(`UPDATE "wiki_repo_op" SET "state"='failed', "error"='the machine went away', "ended_at"=now() WHERE "id"=$1`, [row.id]);
      continue;
    }
    const input = row.input ?? {};
    const result = row.kind === 'snapshot'
      ? { sha: REPO.sha }
      : row.kind === 'read'
        ? { read: { sha: REPO.sha, items: (Array.isArray(input.items) ? input.items : []).map((item: { path?: unknown; maxChars?: unknown }) => ({ path: String(item.path ?? ''), found: true, text: 'package app\n', chars: 12 })), chars: 12 } }
        : row.kind === 'diff'
          ? { diff: { from: String(input.from ?? ''), to: String(input.to ?? ''), files: [], docs: [] } }
          : {
              anchors: {
                sha: REPO.sha,
                anchors: (Array.isArray(input.anchors) ? input.anchors : []).map(
                  (anchor: Record<string, unknown>) => over.checkAnchor?.(anchor) ?? {
                    ...anchor,
                    state: 'verified',
                    // A symbol's region hash is required of a symbol that was found and of nothing else.
                    ...(anchor.type === 'symbol' ? { regionSha256: 'd'.repeat(64) } : {}),
                  },
                ),
              },
            };
    await h.sql.query(`UPDATE "wiki_repo_op" SET "state"='succeeded', "result"=$2::jsonb, "ended_at"=now() WHERE "id"=$1`, [row.id, JSON.stringify(result)]);
  }
  return rows.length;
}

/** Run the workers and the runner until `done`, or fail the case: a job left queued here is the next case's flake. */
async function pass(
  h: Harness,
  which: { queue: WikiModelRequestQueue; executor: WikiJobExecutor },
  done: () => Promise<boolean>,
  over: { failSnapshot?: boolean; checkAnchor?: (anchor: Record<string, unknown>) => Record<string, unknown> } = {},
  rounds = 400,
): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await which.executor.runOnce();
    await which.queue.runOnce();
    await runRepoOps(h, over);
    if (await done()) return;
    await delay(25);
  }
  const ops = await h.sql.query(`SELECT "kind","state","error" FROM "wiki_repo_op" WHERE "owner_id" = $1 ORDER BY "created_at"`, [h.ownerId]);
  assert.fail(`the worker did not finish: ${JSON.stringify(await jobRows(h))} repo ops ${JSON.stringify(ops.rows)}`);
}

interface JobRow {
  id: string;
  kind: string;
  state: string;
  input: { runId?: string } | null;
  report: Record<string, unknown> | null;
  error: string | null;
  failure_kind: string | null;
}

async function jobRows(h: Harness): Promise<JobRow[]> {
  return h.sql.query<JobRow>(
    `SELECT "id", "kind", "state", "input", "report", "error", "failure_kind" FROM "wiki_job"
      WHERE "owner_id" = $1 ORDER BY "created_at", "id"`, [h.ownerId],
  ).then((result) => result.rows);
}

async function jobOf(h: Harness, jobId: string): Promise<JobRow> {
  const rows = await h.sql.query<JobRow>(
    `SELECT "id", "kind", "state", "input", "report", "error", "failure_kind" FROM "wiki_job" WHERE "id" = $1`, [jobId],
  );
  return rows.rows[0]!;
}

/** The page the run reads: two dossiers — the port case and one about something else — and the position's token. */
function pageOf(fx: Fixture, options: { offTopic?: boolean; entries?: number; extraPage?: boolean } = {}): unknown {
  const port = dossier(fx, 'session-1', options.entries ?? 2);
  const werewolf = dossier(fx, 'session-2', 0, true);
  const dossiers = options.extraPage === true
    ? [port]
    : [port, ...(options.offTopic === false ? [] : [werewolf])].filter((one) => one !== null);
  return {
    spaceId: fx.spaceId,
    from: 'tok-watermark',
    cursor: fx.token || 'tok-expect',
    more: false,
    facts: dossiers.length,
    dossiers,
    batches: [],
    errorClusters: [],
    state: { position: null, backlog: dossiers.length, consecutiveFailures: 0 },
  };
}

/** One dossier, its lines the fixture's record, as the server's dossier route hands it out. */
function dossier(fx: Fixture, sessionId: string, entryCount: number, offTopic = false, page = 1): Record<string, unknown> {
  const command = 'go test ./...';
  const output = 'connect ECONNREFUSED 127.0.0.1:9000';
  const text = `SESSION: p${page} ${offTopic ? '设计狼人杀软件界面' : '修 fixture 的端口'}\n`
    + 'anthropic/claude-opus-5 · started 2026-09-20 · status SUCCEEDED\n\n'
    + 'L1 owner: 以后 fixture 里不要写死端口，一律从 fixture 的返回值里取。\n'
    + `L2 tool: $ ${command} → ERR: ${output}\n`
    + 'L3 agent: 根因：src/app.go 在导入时读取 PORT，fixture 之后才设置。\n';
  const sources = [
    { ref: 'L1', kind: 'turn', id: randomUUID(), spans: [{ start: 0, end: 27, text: '以后 fixture 里不要写死端口，一律从 fixture 的返回值里取。' }] },
    {
      ref: 'L2', kind: 'tool_call', id: fx.callId,
      spans: [{ start: 14, end: 14 + command.length, text: command }, { start: 28, end: 28 + output.length, text: output }],
    },
    { ref: 'L3', kind: 'event', id: randomUUID(), spans: [{ start: 0, end: 36, text: '根因：src/app.go 在导入时读取 PORT，fixture 之后才设置。' }] },
  ];
  return { sessionId, taskId: null, title: offTopic ? '狼人杀' : '修 fixture 的端口', text, tokens: 200, truncated: false, tainted: false, sources, hash: 'e'.repeat(64), unchanged: false };
}

/** What the fake model answers: an extraction per case file, a correction for a retry, a verdict otherwise. */
function extractor(fx: Fixture, entryCount: number): (hit: Hit) => string {
  return (hit) => {
    if (hit.prompt.includes('==== CASE FILE ====')) {
      if (hit.prompt.includes('狼人杀')) return '{"offTopic": true}';
      const page = Number(/SESSION: p(\d+)/u.exec(hit.prompt)?.[1] ?? '1');
      if (hit.prompt.includes('SOME ENTRIES IN YOUR ANSWER WERE REJECTED')) {
        return JSON.stringify([pitfall(fx, 'PORT 在导入时读取，fixture 之后再设无效', { quote: 'connect ECONNREFUSED 127.0.0.1:9000' })]);
      }
      const entries: Array<Record<string, unknown>> = [];
      for (let i = 0; i < entryCount; i += 1) {
        entries.push(pitfall(fx, `PORT 在导入时读取 p${page} ${i}`, { quote: 'connect ECONNREFUSED 127.0.0.1:9000' }));
      }
      // One anchored outside the repository, one principle, and one whose quote is not copied from its line —
      // the checks the runner's tests hold: foreign, owner-only and a retry.
      entries.push(pitfall(fx, `游戏面板渲染慢 p${page}`, { anchors: { paths: ['src/components/GameBoard.tsx'], commits: [] }, quote: 'connect ECONNREFUSED 127.0.0.1:9000' }));
      entries.push({ kind: 'principle', title: '一切从简', summary: '越简单越好。', statement: '从简', rationale: '少出错' });
      entries.push(pitfall(fx, `bad quote p${page}`, { quote: 'connection refused' }));
      return JSON.stringify(entries);
    }
    return '{"verdict":"supported","reason":"the cited turn says exactly this"}';
  };
}

/** A valid pitfall of the fixture's own record. */
function pitfall(fx: Fixture, title: string, over: { quote?: string; anchors?: Record<string, unknown> } = {}): Record<string, unknown> {
  return {
    kind: 'pitfall',
    title,
    summary: 'PORT 必须在导入前设好。',
    topic: 'testing',
    trigger: { paths: ['src/app.go'], commands: ['go test ./...'], errorSignature: 'connect ECONNREFUSED' },
    symptom: '测试报 ECONNREFUSED',
    cause: '导入时读取 PORT',
    fix: 'fixture 返回 url',
    anchors: over.anchors ?? { paths: ['src/app.go'], commits: [] },
    sources: [{ ref: 'L2', quote: over.quote ?? 'connect ECONNREFUSED 127.0.0.1:9000' }],
    verified: true,
  };
}

async function runRow(h: Harness, runId: string) {
  return h.prisma.wikiMaintenanceRun.findFirstOrThrow({ where: { id: runId } });
}

// ── A whole run ─────────────────────────────────────────────────────────────────────────────────

test('a server run reads, checks, proposes, advances, verifies and re-checks the anchors, and owes an articles job', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  h.model.answer = extractor(fx, 2);
  // The dossiers read is the server's own reader; this case hands it the pages the spec wrote.
  const page = pageOf(fx);
  h.maintenance.dossierPage = (async () => page) as unknown as WikiMaintenance['dossierPage'];

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded');

  // The run row: succeeded, no op refused, the report and the job that ran it.
  const run = await runRow(h, fx.runId);
  assert.equal(run.outcome, 'succeeded');
  assert.equal(run.opsRefused, 0);
  assert.equal(run.jobId, fx.jobId);
  assert.ok(run.report, 'the report is kept on the run row');
  const report = run.report as Record<string, unknown>;
  assert.equal(report.sessions, 2);
  assert.equal(report.dossiers, 2);
  assert.equal(report.offTopic, 1, 'the werewolf case is taken as off topic and nothing is kept of it');
  const entries = report.entries as Record<string, number>;
  assert.equal(entries.foreign, 1, 'the game-board entry is another repository\'s knowledge');
  assert.equal(entries.principles, 1, 'a principle is counted and set aside');
  assert.equal(entries.dropped, 0, 'the bad quote was corrected by the retry, so nothing stays dropped');
  const ops = report.ops as Record<string, number>;
  assert.equal(ops.refused, 0);
  assert.equal(ops.recorded, 3, 'two ports and the corrected one');
  assert.equal(ops.selfCheckDropped, 0);
  assert.equal(report.cursorAdvanced, true);
  const tokens = report.tokens as Record<string, number>;
  assert.ok(tokens.calls >= 4, `the extraction, the retry and the verdicts are calls: ${JSON.stringify(tokens)}`);
  assert.ok(tokens.input > 0 && tokens.output > 0);

  // The cursor moved to the page's position.
  const cursor = await h.prisma.wikiCursor.findFirstOrThrow({ where: { spaceId: fx.spaceId, source: 'facts' } });
  assert.equal(cursor.positionRef, fx.position.ref);
  assert.equal(cursor.positionKind, fx.position.kind);
  assert.equal(cursor.consecutiveFailures, 0);

  // The model was asked once per dossier through the queue, the retry under its own unit.
  const requests = await h.sql.query<{ step: string; unit: string }>(
    `SELECT "step", "unit" FROM "wiki_model_request" WHERE "owner_id" = $1 ORDER BY "enqueued_at", "id"`, [h.ownerId],
  ).then((result) => result.rows);
  assert.deepEqual(requests.filter((row) => row.step === 'extract').map((row) => row.unit).sort(), ['session-1', 'session-1#retry', 'session-2']);
  assert.ok(requests.some((row) => row.step === 'verify'), 'the run verified its own ops');

  // The changesets are the run's: origin maintenance, under its wiki job, and their ops were applied by the
  // verdicts the run itself asked for.
  const changesets = await h.prisma.wikiChangeset.findMany({ where: { ownerId: h.ownerId, spaceId: fx.spaceId } });
  assert.ok(changesets.length >= 1);
  for (const changeset of changesets) {
    assert.equal(changeset.origin, 'maintenance');
    assert.equal(changeset.jobId, fx.jobId);
    assert.equal(changeset.sessionId, null);
  }
  const opRows = await h.prisma.wikiChangesetOp.findMany({ where: { ownerId: h.ownerId, changeset: { spaceId: fx.spaceId } } });
  assert.equal(opRows.length, 3);
  assert.ok(opRows.every((op) => op.decision !== 'verifying'), 'every op the run recorded was verified by the run');

  // The anchors went through a repository operation, and the entries it checked are recorded.
  const repoOpKinds = await h.sql.query<{ kind: string }>(
    `SELECT "kind" FROM "wiki_repo_op" WHERE "owner_id" = $1 ORDER BY "created_at"`, [h.ownerId],
  ).then((result) => result.rows.map((row) => row.kind));
  assert.ok(repoOpKinds.includes('snapshot'));
  assert.ok(repoOpKinds.includes('anchors'));
  const anchors = report.anchors as Record<string, number>;
  assert.equal(anchors.entries, 3);
  const stored = await h.prisma.wikiEntry.findMany({ where: { ownerId: h.ownerId, spaceId: fx.spaceId, status: 'active' } });
  assert.equal(stored.length, 3);

  // No confirmed plan: no document was written, and the report says so.
  const docs = report.docs as Record<string, unknown>;
  assert.equal(docs.skipped, 'no_confirmed_plan');

  // The articles job the run's end owes: one, queued, at background priority.
  const jobs = await jobRows(h);
  const articles = jobs.filter((job) => job.kind === 'articles');
  assert.equal(articles.length, 1);
  assert.equal(articles[0]!.state, 'queued');
});

// ── The anchors of a page: every entry keeps its own checks ─────────────────────────────────────

/**
 * The fake repository the anchor step is checked against: one file, one reachable commit, and a
 * region hash derived from the symbol's name — different symbols hash differently, which is what
 * tells one entry's symbol check from another's.
 */
const ANCHOR_REPO = {
  file: 'src/app.go',
  commit: createHash('sha1').update('the commit the spec keeps').digest('hex'),
  regionOf: (symbol: string): string => createHash('sha256').update(`region of ${symbol}`).digest('hex'),
};

/** What the runner answers for one anchor of the anchors op, checking it against ANCHOR_REPO. */
function checkAnchorAgainstRepo(anchor: Record<string, unknown>): Record<string, unknown> {
  if (anchor.type === 'path') {
    return { ...anchor, state: anchor.path === ANCHOR_REPO.file ? 'verified' : 'missing' };
  }
  if (anchor.type === 'commit') {
    return { ...anchor, state: anchor.sha === ANCHOR_REPO.commit ? 'verified' : 'missing' };
  }
  return { ...anchor, state: 'verified', regionSha256: ANCHOR_REPO.regionOf(String(anchor.symbol ?? '')) };
}

test('the anchors step records each entry\'s checks on its own anchors — a page of entries is never one entry', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  // No dossiers: the run proposes nothing, and the anchors step is what this case is about.
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
  // Two live entries whose anchors collide on the per-entry index: each has a path, a symbol and a
  // commit at indexes 0, 1 and 2. The first entry's symbol names no baseline: its first check adopts
  // the region the check found, so a verdict laid on the wrong entry's symbol would stick as a
  // wrong baseline.
  const serveBaseline = createHash('sha256').update('the baseline the serve anchor names').digest('hex');
  const goneCommit = createHash('sha1').update('a commit the repository never held').digest('hex');
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
  await h.prisma.wikiEntry.create({
    data: {
      id: first, ownerId: h.ownerId, spaceId: fx.spaceId, kind: 'concept', title: 'the kept entry', summary: 'a live entry',
      status: 'active', trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [],
      anchors: [
        { type: 'path', path: ANCHOR_REPO.file },
        { type: 'symbol', path: ANCHOR_REPO.file, symbol: 'main' },
        { type: 'commit', sha: ANCHOR_REPO.commit },
      ],
    },
  });
  await h.prisma.wikiEntry.create({
    data: {
      id: second, ownerId: h.ownerId, spaceId: fx.spaceId, kind: 'concept', title: 'the broken entry', summary: 'a live entry',
      status: 'active', trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [],
      anchors: [
        { type: 'path', path: 'src/gone.go' },
        { type: 'symbol', path: ANCHOR_REPO.file, symbol: 'serve', regionSha256: serveBaseline },
        { type: 'commit', sha: goneCommit },
      ],
    },
  });

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded' || (await jobOf(h, fx.jobId)).state === 'failed',
    { checkAnchor: checkAnchorAgainstRepo });

  // The job succeeds: every reported check names the anchor it belongs to, so nothing is refused.
  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'succeeded', `the anchors step must not fail: ${job.error ?? ''}`);

  const kept = await h.prisma.wikiEntry.findFirstOrThrow({ where: { id: first } });
  const keptAnchors = kept.anchors as Array<Record<string, unknown> & { check?: Record<string, unknown> }>;
  assert.equal(keptAnchors[0]!.check?.state, 'verified', 'the kept entry\'s path holds');
  assert.equal(keptAnchors[1]!.check?.state, 'verified', 'the kept entry\'s symbol is found');
  assert.equal(keptAnchors[1]!.check?.regionSha256, ANCHOR_REPO.regionOf('main'), 'the kept entry\'s symbol check is its own');
  assert.equal(keptAnchors[1]!.check?.baselineSha256, ANCHOR_REPO.regionOf('main'), 'the baseline the first check adopts is its own region');
  assert.equal(keptAnchors[2]!.check?.state, 'verified', 'the kept entry\'s commit is reachable');
  assert.equal(kept.anchorState, 'verified');
  assert.equal(kept.challenged, false, 'a fully verified entry draws no challenge');

  const broken = await h.prisma.wikiEntry.findFirstOrThrow({ where: { id: second } });
  const brokenAnchors = broken.anchors as Array<Record<string, unknown> & { check?: Record<string, unknown> }>;
  assert.equal(brokenAnchors[0]!.check?.state, 'missing', 'the gone path is missing');
  assert.equal(brokenAnchors[1]!.check?.state, 'changed', 'the serve symbol\'s region moved against its own baseline');
  assert.equal(brokenAnchors[1]!.check?.regionSha256, ANCHOR_REPO.regionOf('serve'), 'the changed check carries the region its own symbol holds now');
  assert.equal(brokenAnchors[1]!.check?.baselineSha256, undefined, 'an anchor that names its own baseline is held to it there: the check does not copy it');
  assert.equal(brokenAnchors[1]!.regionSha256, serveBaseline, 'and the baseline the anchor named is untouched by the check');
  assert.equal(brokenAnchors[2]!.check?.state, 'missing', 'the unheld commit is missing');
  assert.equal(broken.anchorState, 'missing');
  assert.equal(broken.challenged, true, 'the broken entry is challenged for the owner');

  const report = (await runRow(h, fx.runId)).report as Record<string, unknown>;
  const anchors = report.anchors as Record<string, number>;
  assert.deepEqual(anchors, { entries: 2, changed: 0, missing: 1 }, 'one entry verified, the broken one out as missing');
});

test('anchor verdicts that name anchors no entry asked for fail the run: nothing is laid on a guess', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
  const first = '00000000-0000-4000-8000-000000000010';
  await h.prisma.wikiEntry.create({
    data: {
      id: first, ownerId: h.ownerId, spaceId: fx.spaceId, kind: 'concept', title: 'the kept entry, again', summary: 'a live entry',
      status: 'active', trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [],
      anchors: [{ type: 'path', path: ANCHOR_REPO.file }],
    },
  });
  // A runner that answers one check with an echo naming a different type than the anchor at that
  // index: the run cannot tell whose verdict it is, so it fails as content and writes nothing.
  const lying = (anchor: Record<string, unknown>): Record<string, unknown> => ({
    ...checkAnchorAgainstRepo(anchor),
    ...(anchor.type === 'path' ? { type: 'commit' } : {}),
  });

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'failed', { checkAnchor: lying });

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'failed');
  assert.equal(job.failure_kind, 'content');
  assert.match(job.error ?? '', /refuses to guess/u);
  const kept = await h.prisma.wikiEntry.findFirstOrThrow({ where: { id: first } });
  assert.equal(((kept.anchors as unknown[])[0] as { check?: unknown }).check, undefined, 'no verdict is laid on a guess');
});

test('a run made while the space is catching up writes no document and proposes no plan change, and owes no articles job', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h, { catchUp: 'active' });
  h.model.answer = extractor(fx, 1);
  h.maintenance.dossierPage = (async () => pageOf(fx)) as unknown as WikiMaintenance['dossierPage'];

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded');

  const run = await runRow(h, fx.runId);
  assert.equal(run.outcome, 'succeeded');
  const report = run.report as Record<string, unknown>;
  const docs = report.docs as Record<string, unknown>;
  assert.equal(docs.skipped, 'catching_up');
  assert.equal(docs.planVersion, null);
  assert.equal(docs.proposal, null);
  // Nothing of the documents was read: the only repository operation is the snapshot and the anchors.
  const kinds = await h.sql.query<{ kind: string }>(
    `SELECT "kind" FROM "wiki_repo_op" WHERE "owner_id" = $1`, [h.ownerId],
  ).then((result) => result.rows.map((row) => row.kind));
  assert.ok(!kinds.includes('diff'), 'the repository\'s half of the documents is not read');
  assert.equal((await jobRows(h)).filter((job) => job.kind === 'articles').length, 0);
});

// ── The breaker ─────────────────────────────────────────────────────────────────────────────────

test('the breaker holds back the ops of the first page that does not fit and stops the cursor where that page starts', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  // 100 live entries is the breaker's floor: ten of them may change, and the model offers more.
  const fx = await fixture(h, { activeEntries: 100 });
  h.model.answer = extractor(fx, 6);
  h.maintenance.dossierPage = (async () => pageOf(fx)) as unknown as WikiMaintenance['dossierPage'];

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded');

  const run = await runRow(h, fx.runId);
  const report = run.report as Record<string, unknown>;
  const ops = report.ops as Record<string, number>;
  assert.equal(ops.heldBackByBreaker, 0, 'the page\'s six entries fit in the ten the run may change');
  const stored = await h.prisma.wikiEntry.count({ where: { ownerId: h.ownerId, spaceId: fx.spaceId, status: 'active' } });
  assert.equal(stored, 106, 'the six the run proposed are live');
});

test('a run whose second page does not fit holds it back and stops the cursor there', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h, { activeEntries: 100 });
  h.model.answer = extractor(fx, 6);
  // Two pages: the first fits in the ten the breaker allows, the second's six do not.
  let pages = 0;
  const first = pageOf(fx) as Record<string, unknown>;
  const second = {
    ...(pageOf(fx) as Record<string, unknown>),
    from: fx.token, cursor: fx.token, more: false,
    dossiers: [dossier(fx, 'session-3', 6, false, 2), dossier(fx, 'session-4', 0, true, 2)].filter(() => true),
  };
  h.maintenance.dossierPage = (async () => {
    pages += 1;
    return pages === 1 ? { ...first, more: true, cursor: fx.token } : second;
  }) as unknown as WikiMaintenance['dossierPage'];

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded');

  const run = await runRow(h, fx.runId);
  const report = run.report as Record<string, unknown>;
  const ops = report.ops as Record<string, number>;
  assert.equal(ops.heldBackByBreaker, 6, 'the second page\'s six ops are held back');
  assert.equal(ops.recorded, 6, 'the first page\'s six ops were proposed');
  // The cursor stops where the held-back page starts: the advance never passed the page it held back.
  const cursor = await h.prisma.wikiCursor.findFirstOrThrow({ where: { spaceId: fx.spaceId, source: 'facts' } });
  const before = cursor.positionAt;
  assert.ok(before === null || before.getTime() <= fx.position.at.getTime(), 'the cursor did not pass the held-back page');
});

// ── Failure ─────────────────────────────────────────────────────────────────────────────────────

test('a repository operation the runner never answers is the platform\'s: the job is queued again and nothing is counted', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  h.model.answer = extractor(fx, 1);
  h.maintenance.dossierPage = (async () => pageOf(fx)) as unknown as WikiMaintenance['dossierPage'];

  const which = worker(h, { repoWaitMs: 200 });
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'queued' && (await jobOf(h, fx.jobId)).failure_kind === 'infra',
    { failSnapshot: true });

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'queued', 'the platform\'s failure is tried again');
  assert.equal(job.failure_kind, 'infra');
  assert.match(job.error ?? '', /REPO_OP_FAILED|REPO_OP_WAIT|snapshot of origin\/main/u);
  const run = await runRow(h, fx.runId);
  assert.equal(run.outcome, null, 'the run is not ended by a failure of the platform');
  assert.equal(run.endedAt, null);
  const cursor = await h.prisma.wikiCursor.findFirstOrThrow({ where: { spaceId: fx.spaceId, source: 'facts' } });
  assert.equal(cursor.consecutiveFailures, 0, 'an infrastructure failure is not counted against the space');
});

test('a refusal of the run\'s own ends it failed, counts it against the space and fails the job as content', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  h.model.answer = extractor(fx, 1);
  h.maintenance.dossierPage = (async () => {
    throw new WikiRefusalError({ code: 'WIKI_CURSOR_INVALID', message: 'the page names no position this space handed out' });
  }) as unknown as WikiMaintenance['dossierPage'];

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'failed');

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.failure_kind, 'content');
  assert.match(job.error ?? '', /dossiers could not be read/u);
  const run = await runRow(h, fx.runId);
  assert.equal(run.outcome, 'failed');
  assert.equal(run.failureKind, 'content');
  assert.ok(run.endedAt);
  const cursor = await h.prisma.wikiCursor.findFirstOrThrow({ where: { spaceId: fx.spaceId, source: 'facts' } });
  assert.equal(cursor.consecutiveFailures, 1, 'a failure of the work is counted against the space');
});
