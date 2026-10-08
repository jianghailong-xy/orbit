/**
 * The wiki job queue and its executor (contracts/wiki.contract.json `jobs`, migration 0401), against a real PostgreSQL
 * and a System model played by a local Node http server:
 *
 *   1. the executor switch: under the default `runner` nothing is claimed at all, `canary` claims only the accounts it
 *      lists, `server` claims every account's — the default behavior is the one the deployment has always had;
 *   2. the claim takes the highest priority first, and a space never has two jobs running at once (the partial unique
 *      index is the same rule in the database);
 *   3. a job whose worker died is reclaimed by the next one, which finishes it — reusing the answer its job had
 *      already obtained instead of calling the model again;
 *   4. the smoke job runs end to end: a job claimed, one request enqueued, the call made, the answer written into the
 *      job's report — and the wake-up that ends the job's wait comes over pg_notify, with the poll as the fallback;
 *   5. a request that waited past its step's limit fails, and the job that made it fails as infra: back to queued with
 *      the lost attempt counted, not the space's failure to carry;
 *   6. a job of a kind this build runs no pipeline for stays queued.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki-worker/wiki-jobs.pg.spec.ts
 *
 * Not destructive: it writes only rows under its own account and spaces, and deletes them afterwards.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { after, afterEach, test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { WikiJobExecutor } from './wiki-job-executor';
import { claimWikiJobs, enqueueWikiJob } from './wiki-jobs';
import { WikiModelRequestChannel } from './wiki-model-notify';
import { enqueueWikiModelRequest, WIKI_MODEL_WAIT_LIMIT_ERROR as WAIT_LIMIT, wikiModelRequestSha256 } from './wiki-model-queue';
import { wikiSmokeJobInput } from './wiki-smoke-job';
import { WikiModelRequestQueue } from './wiki-model-queue.service';
import { WikiModelStatusProbe } from './wiki-model-status';
import { readWikiSystemModel, type WikiSystemModelConfig } from './wiki-system-model';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;

const KEY = `sk-spec-${randomUUID()}`;
const MODEL = 'qwen3-coder-spec';

interface Hit {
  prompt: string;
}

interface FakeModel {
  base: string;
  host: string;
  behaviour: { health: number; answer: (hit: Hit) => { kind: 'stream'; chunks: string[]; holdAfter?: number } };
  gate: Promise<void>;
  release: () => void;
  hits: Hit[];
  close: () => Promise<void>;
}

async function fakeModel(): Promise<FakeModel> {
  const sockets = new Set<Socket>();
  const hits: Hit[] = [];
  let releaseGate!: () => void;
  const state = {
    base: '',
    host: '',
    behaviour: { health: 200, answer: (): { kind: 'stream'; chunks: string[] } => ({ kind: 'stream', chunks: ['pong'] }) },
    gate: new Promise<void>((resolve) => {
      releaseGate = resolve;
    }),
    release: () => releaseGate(),
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
        response.writeHead(state.behaviour.health, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      let prompt = '';
      try {
        prompt = (JSON.parse(body) as { messages?: Array<{ content?: string }> }).messages?.[0]?.content ?? '';
      } catch {
        prompt = '';
      }
      hits.push({ prompt });
      const behaviour = state.behaviour.answer({ prompt });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const write = (what: string) => {
        try {
          response.write(what);
        } catch {
          /* the call was abandoned */
        }
      };
      const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      write(event('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 3, output_tokens: 1 } } }));
      void (async () => {
        for (const [index, chunk] of behaviour.chunks.entries()) {
          write(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }));
          if (behaviour.holdAfter === index + 1) {
            await Promise.race([state.gate, new Promise<void>((resolve) => response.on('close', () => resolve()))]);
            if (response.destroyed || response.writableEnded) return;
          }
        }
        write(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }));
        write(event('message_stop', { type: 'message_stop' }));
        try {
          response.end();
        } catch {
          /* the call was abandoned */
        }
      })();
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  state.base = `http://127.0.0.1:${port}`;
  state.host = `127.0.0.1:${port}`;
  state.close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

interface Fixture {
  id: string;
  spaceId: string;
  otherSpaceId: string;
}

interface Harness {
  sql: Client;
  prisma: PrismaClient;
  model: FakeModel;
  owner: Fixture;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  process.env.ORBIT_WIKI_EXECUTOR = 'server';
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL_);
    const sql = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const prisma = prismaClientFor(URL_ as string);
    const model = await fakeModel();
    return { sql, prisma, model, owner: await fixture(prisma) };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const { prisma, sql, model, owner } = await harness;
  delete process.env.ORBIT_WIKI_EXECUTOR;
  await prisma.wikiSpace.deleteMany({ where: { ownerId: owner.id } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: owner.id } }).catch(() => undefined);
  await prisma.wikiModelStatus.deleteMany({ where: { id: 1 } }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await sql.end().catch(() => undefined);
  await model.close().catch(() => undefined);
});

/** One account with two spaces, so "one job per space" has somewhere to be seen. */
async function fixture(prisma: PrismaClient): Promise<Fixture> {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `wiki-jobs-${id}@wiki.invalid`, name: 'jobs spec', passwordHash: 'x' } });
  const spaceId = randomUUID();
  const otherSpaceId = randomUUID();
  await prisma.wikiSpace.create({ data: { id: spaceId, ownerId: id, slug: `jobs-${id.slice(0, 8)}`, title: 'Jobs spec' } });
  await prisma.wikiSpace.create({ data: { id: otherSpaceId, ownerId: id, slug: `jobs-b-${id.slice(0, 8)}`, title: 'Jobs spec B' } });
  return { id, spaceId, otherSpaceId };
}

function config(h: Harness, concurrency = 2): WikiSystemModelConfig {
  return readWikiSystemModel({
    ORBIT_WIKI_MODEL_BASE_URL: h.model.base,
    ORBIT_WIKI_MODEL_API_KEY: KEY,
    ORBIT_WIKI_MODEL: MODEL,
    ORBIT_WIKI_MODEL_CONCURRENCY: String(concurrency),
  });
}

/**
 * The workers this case started. A case that fails halfway must not leave one running: its loop would go on
 * claiming the next case's jobs, which reads as a flake in a test that is not about it.
 */
const live: Array<{ queue: WikiModelRequestQueue; executor: WikiJobExecutor }> = [];

afterEach(async () => {
  const started = live.splice(0);
  for (const one of started) await one.executor.onModuleDestroy().catch(() => undefined);
  for (const one of started) await one.queue.onModuleDestroy().catch(() => undefined);
});

/** The executor under test, with its own queue: fast timings, so a pass is milliseconds of work. */
function worker(h: Harness, options: { channel?: WikiModelRequestChannel; pollMs?: number; concurrency?: number } = {}): {
  queue: WikiModelRequestQueue;
  executor: WikiJobExecutor;
} {
  const options_ = { leaseMs: 400, renewMs: 100, partialMs: 40, pollMs: options.pollMs ?? 30 };
  const queue = new WikiModelRequestQueue(
    h.prisma as unknown as PrismaService, config(h, options.concurrency ?? 2),
    new WikiModelStatusProbe(h.prisma as unknown as PrismaService, config(h, options.concurrency ?? 2)),
    options.channel, options_,
  );
  const executor = new WikiJobExecutor(h.prisma as unknown as PrismaService, queue, options_);
  live.push({ queue, executor });
  return { queue, executor };
}

async function modelUp(h: Harness): Promise<void> {
  h.model.behaviour.health = 200;
  await new WikiModelStatusProbe(h.prisma as unknown as PrismaService, config(h)).check();
}

async function reset(h: Harness): Promise<void> {
  await h.sql.query('DELETE FROM "wiki_job" WHERE "owner_id" = $1', [h.owner.id]);
  h.model.hits.length = 0;
  h.model.behaviour.health = 200;
  h.model.behaviour.answer = () => ({ kind: 'stream', chunks: ['pong'] });
  let release!: () => void;
  h.model.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.model.release = release;
  await h.sql.query('DELETE FROM "wiki_model_status"');
}

/** Enqueue one job of this spec's account. */
async function job(h: Harness, options: { kind?: string; spaceId?: string; priority?: number; input?: Record<string, unknown> } = {}): Promise<string> {
  const id = randomUUID();
  await enqueueWikiJob(h.prisma as unknown as PrismaService, {
    id,
    ownerId: h.owner.id,
    spaceId: options.spaceId ?? h.owner.spaceId,
    kind: options.kind ?? 'smoke',
    priority: options.priority,
    input: options.input,
  });
  return id;
}

interface JobRow {
  id: string;
  kind: string;
  state: string;
  attempts: number;
  failure_kind: string | null;
  error: string | null;
  report: Record<string, unknown> | null;
  lease_deadline_at: Date | null;
  next_attempt_at: Date | null;
}

async function jobRow(h: Harness, id: string): Promise<JobRow> {
  const { rows } = await h.sql.query<JobRow>(
    `SELECT "id", "kind", "state", "attempts", "failure_kind", "error", "report", "lease_deadline_at", "next_attempt_at"
     FROM "wiki_job" WHERE "id" = $1`, [id]);
  assert.ok(rows[0], `no job ${id}`);
  return rows[0];
}

async function waitFor(what: string, ok: () => boolean | Promise<boolean>, seconds = 10): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await ok()) return;
    assert.ok(Date.now() < deadline, `${what} within ${seconds}s`);
    await delay(20);
  }
}

/** Run an executor and its queue for a while, until `done` or the deadline. */
async function pass(executor: WikiJobExecutor, queue: WikiModelRequestQueue, rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await executor.runOnce();
    await queue.runOnce();
    await delay(30);
  }
}

test('the executor switch: runner claims nothing at all, canary only the listed accounts, server every account', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  await modelUp(h);
  const { queue, executor } = worker(h);
  const id = await job(h);
  // The default: the path that has always run. No claim, whatever is queued.
  process.env.ORBIT_WIKI_EXECUTOR = 'runner';
  assert.equal(await executor.runOnce(), 0);
  assert.equal((await jobRow(h, id)).state, 'queued');
  // Canary, with nobody listed: the same.
  process.env.ORBIT_WIKI_EXECUTOR = 'canary';
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  assert.equal(await executor.runOnce(), 0);
  assert.equal((await jobRow(h, id)).state, 'queued');
  // Canary, with somebody else listed: still nothing of this account's.
  process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS = randomUUID();
  assert.equal(await executor.runOnce(), 0);
  assert.equal((await jobRow(h, id)).state, 'queued');
  // This account listed: claimed.
  process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS = h.owner.id;
  assert.equal(await executor.runOnce(), 1);
  await queue.runOnce();
  await queue.whenIdle();
  await executor.whenIdle();
  assert.equal((await jobRow(h, id)).state, 'succeeded');
  await queue.onModuleDestroy();
  await executor.onModuleDestroy();
  process.env.ORBIT_WIKI_EXECUTOR = 'server';
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
});

test('the claim takes the highest priority first, and one space never runs two jobs at once', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  await modelUp(h);
  h.model.behaviour.answer = () => ({ kind: 'stream', chunks: ['held'], holdAfter: 1 });
  const { queue, executor } = worker(h);
  const plain = await job(h);
  const urgent = await job(h, { priority: 7 });
  const alsoPlain = await job(h);
  const otherSpace = await job(h, { spaceId: h.owner.otherSpaceId });
  // Two passes' worth: the space's urgent job and the other space's job run; the two plain ones of space one wait.
  assert.equal(await executor.runOnce(), 2);
  await waitFor('two jobs running', async () => {
    const { rows } = await h.sql.query<{ n: string }>(
      `SELECT count(*)::text AS "n" FROM "wiki_job" WHERE "owner_id" = $1 AND "state" = 'running'`, [h.owner.id]);
    return rows[0].n === '2';
  });
  // Another pass claims nothing: the space whose job runs is busy, and its other job is not older than the rest.
  assert.equal(await executor.runOnce(), 0);
  h.model.release();
  await queue.runOnce();
  await queue.whenIdle();
  await executor.whenIdle();
  assert.equal((await jobRow(h, urgent)).state, 'succeeded');
  assert.equal((await jobRow(h, otherSpace)).state, 'succeeded');
  const left = await h.sql.query<{ id: string }>(
    `SELECT "id" FROM "wiki_job" WHERE "owner_id" = $1 AND "state" = 'queued' ORDER BY "created_at", "id"`, [h.owner.id]);
  assert.equal(left.rows.length, 2, 'the space runs one job at a time');
  // The space's other two succeed one after the other.
  await pass(executor, queue, 4);
  await executor.whenIdle();
  assert.equal((await jobRow(h, plain)).state, 'succeeded');
  assert.equal((await jobRow(h, alsoPlain)).state, 'succeeded');
  const { rows } = await h.sql.query<{ n: string }>(
    `SELECT count(*)::text AS "n" FROM "wiki_job" WHERE "owner_id" = $1 AND "state" = 'succeeded'`, [h.owner.id]);
  assert.equal(rows[0].n, '4');
  await queue.onModuleDestroy();
  await executor.onModuleDestroy();
});

test('a job whose worker died is reclaimed by the next one, which finishes it from the answer already obtained', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  await modelUp(h);
  const { queue, executor } = worker(h);
  const id = await job(h);
  // The dead worker: a claim whose lease is not renewed, and one request it made that answered before it died.
  const claimed = await claimWikiJobs(h.prisma as unknown as PrismaService, {
    workerId: randomUUID(), kinds: ['smoke'], owners: null, limit: 1, leaseMs: 400,
  });
  assert.deepEqual(claimed.map((one) => one.id), [id]);
  const answered = await h.prisma.wikiModelRequest.create({
    data: {
      jobId: id, ownerId: h.owner.id, spaceId: h.owner.spaceId, step: 'smoke', unit: 'call',
      request: { ...wikiSmokeJobInput({}) }, requestSha256: wikiModelRequestSha256(wikiSmokeJobInput({})),
      state: 'succeeded', answer: 'pong', endedAt: new Date(),
    },
  });
  assert.equal(h.model.hits.length, 0);
  // The lease runs out; the next worker reclaims the job and finishes it without calling the model again.
  await h.sql.query(`UPDATE "wiki_job" SET "lease_deadline_at" = now() - interval '1 second' WHERE "id" = $1`, [id]);
  await pass(executor, queue, 4);
  await executor.whenIdle();
  const row = await jobRow(h, id);
  assert.equal(row.state, 'succeeded', `job ${row.state}: ${row.error}`);
  assert.equal(row.attempts, 1, 'the lost attempt was counted');
  assert.equal(row.failure_kind, null, 'a success clears what the lost attempt said');
  const request = await h.prisma.wikiModelRequest.findUnique({ where: { id: answered.id } });
  assert.equal(request?.state, 'succeeded');
  assert.equal(request?.answer, 'pong', 'the answer stands');
  assert.equal(h.model.hits.length, 0, 'the model was not called again');
  assert.equal(row.report?.answer, 'pong', 'the run finished from the answer already obtained');
  await queue.onModuleDestroy();
  await executor.onModuleDestroy();
});

test('the smoke job runs end to end, and the wake-up that ends its wait comes over pg_notify', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  await modelUp(h);
  // A real listener on the queue's channel, and a poll far longer than the test: only the NOTIFY can wake it.
  process.env.DATABASE_URL = URL_;
  const channel = new WikiModelRequestChannel();
  channel.onModuleInit();
  await delay(300);
  const { queue, executor } = worker(h, { channel, pollMs: 30_000 });
  const started = Date.now();
  const id = await job(h, { input: { prompt: 'say pong' } });
  await executor.runOnce();
  // The job's own call is now queued; the queue makes it, and the job is woken to write its report.
  await waitFor('the request to be enqueued', async () => (await h.prisma.wikiModelRequest.count({ where: { jobId: id } })) === 1);
  await queue.runOnce();
  await queue.whenIdle();
  await executor.whenIdle();
  const elapsed = Date.now() - started;
  const row = await jobRow(h, id);
  assert.equal(row.state, 'succeeded');
  assert.equal(row.report?.answer, 'pong', JSON.stringify(row.report));
  assert.deepEqual(row.report?.usage, { inputTokens: 3, outputTokens: 12 });
  assert.equal(row.report?.httpStatus, 200);
  assert.ok(elapsed < 10_000, `the job settled in ${elapsed} ms, not on the 30 s poll`);
  const request = await h.prisma.wikiModelRequest.findFirst({ where: { jobId: id } });
  assert.equal(request?.state, 'succeeded');
  assert.equal(request?.answer, 'pong');
  assert.deepEqual([request?.inputTokens, request?.outputTokens], [3, 12]);
  assert.equal(h.model.hits.length, 1);
  delete process.env.DATABASE_URL;
  await queue.onModuleDestroy();
  await executor.onModuleDestroy();
  channel.onModuleDestroy();
});

test('a request that waited past its step\'s limit fails, and the job that made it fails as infra', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  await modelUp(h);
  const { queue, executor } = worker(h);
  const id = await job(h);
  await executor.runOnce();
  await waitFor('the job\'s request', async () => (await h.prisma.wikiModelRequest.count({ where: { jobId: id } })) === 1);
  // The request has been waiting past the smoke step's limit (its step is not one of the design's shorter ones).
  assert.match(WAIT_LIMIT, /waited past/u);
  await h.sql.query(`UPDATE "wiki_model_request" SET "enqueued_at" = now() - interval '901 seconds' WHERE "job_id" = $1`, [id]);
  await queue.runOnce();
  await queue.whenIdle();
  await executor.whenIdle();
  const row = await jobRow(h, id);
  assert.equal(row.state, 'queued', 'an infra failure is retried, not ended');
  assert.equal(row.attempts, 1);
  assert.equal(row.failure_kind, 'infra');
  assert.match(row.error ?? '', /waited past its step's limit \(900 s\)/);
  assert.ok(row.next_attempt_at, 'the retry has a time');
  assert.equal(h.model.hits.length, 0, 'the model was never called');
  await queue.onModuleDestroy();
  await executor.onModuleDestroy();
});

test('a job of a kind this build runs no pipeline for stays queued', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  await modelUp(h);
  const { queue, executor } = worker(h);
  const id = await job(h, { kind: 'import' });
  assert.equal(await executor.runOnce(), 0);
  assert.equal((await jobRow(h, id)).state, 'queued');
  await pass(executor, queue, 2);
  assert.equal((await jobRow(h, id)).state, 'queued', 'the phase that implements it will take it');
  await queue.onModuleDestroy();
  await executor.onModuleDestroy();
});
