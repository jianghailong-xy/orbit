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
 *   6. a job of a kind this build runs no pipeline for stays queued;
 *   7. the retry limit (`jobs.retry.limit`, 2026-10-09): an error the build did not expect ends the job at its third
 *      attempt and its plan job with it; an infra failure ends it at its tenth, and its maintenance run with it; and a
 *      job the lease sweep puts back at the limit is ended by the next pass, never run again, its calls cancelled;
 *   8. the stop (design §5.4): a job its worker stops is handed back whatever its pipeline ends with once stopped —
 *      queued again at once, never settled, nothing counted (the owner's decision of 2026-10-09) — and asks the model
 *      nothing new; a claim the stop overtakes hands back what it took instead of starting it;
 *   9. a stop against a crash, in one space: the build a stop handed back is the next worker's first claim, ahead of a
 *      lower-priority job of its space, its attempts as they were; the build whose worker crashed — its lease ran out,
 *      nobody handed it back — is counted and backed off 0, 10, then 30 s, as before;
 *  10. maintenance first, an articles job yields one round at most (the owner's decision of 2026-10-10): the round
 *      queued behind its space's articles job is claimed first, every attempt of it, even while it backs off, and the
 *      round after finds the articles job ahead; the owner's own work still goes first; another space keeps its place
 *      in the line; an articles job that has run before yields to nothing; and Activity reads each where the claim
 *      takes it.
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
import { WikiJobReads } from '../wiki/wiki-job-reads';
import { WikiJobExecutor, WikiJobInfraError, type WikiJobRunner } from './wiki-job-executor';
import {
  claimWikiJobs,
  enqueueWikiJob,
  reclaimExpiredWikiJobs,
  releaseWikiJobLease,
  requeueWikiJobForInfra,
  succeedWikiJob,
  type ClaimedWikiJob,
} from './wiki-jobs';
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
function worker(h: Harness, options: { channel?: WikiModelRequestChannel; pollMs?: number; concurrency?: number; runners?: Record<string, WikiJobRunner> } = {}): {
  queue: WikiModelRequestQueue;
  executor: WikiJobExecutor;
} {
  const options_ = { leaseMs: 400, renewMs: 100, partialMs: 40, pollMs: options.pollMs ?? 30 };
  const queue = new WikiModelRequestQueue(
    h.prisma as unknown as PrismaService, config(h, options.concurrency ?? 2),
    new WikiModelStatusProbe(h.prisma as unknown as PrismaService, config(h, options.concurrency ?? 2)),
    options.channel, options_,
  );
  const executor = new WikiJobExecutor(h.prisma as unknown as PrismaService, queue, options_, options.runners);
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

// ── 7. the retry limit (`jobs.retry.limit`) ─────────────────────────────────────────────────────

// The limits as the contract states them (`jobs.retry`, pinned to WIKI_JOB by src/shared/src/wikiContract.spec.ts):
// ten attempts in all, three for an error the build did not expect.
const MAX_ATTEMPTS = 10;
const UNEXPECTED_MAX_ATTEMPTS = 3;

/** One attempt of every due job: a pass, its runs to their end, and the backoff skipped so the next one is due now. */
async function attempt(h: Harness, executor: WikiJobExecutor, id: string): Promise<JobRow> {
  await executor.runOnce();
  await executor.whenIdle();
  await h.sql.query(`UPDATE "wiki_job" SET "next_attempt_at" = now() WHERE "id" = $1 AND "state" = 'queued'`, [id]);
  return jobRow(h, id);
}

/** A build of the space's plan made by a docs_build job, as the owner's confirmation makes one (plan.jobs.server). */
async function buildJob(h: Harness, spaceId: string, over: { attempts?: number } = {}): Promise<{ jobId: string; planJobId: string }> {
  const planJobId = randomUUID();
  const jobId = await job(h, { kind: 'docs_build', spaceId, priority: 1, input: { planJobId } });
  if (over.attempts) await h.sql.query('UPDATE "wiki_job" SET "attempts" = $2 WHERE "id" = $1', [jobId, over.attempts]);
  await h.sql.query(
    `INSERT INTO "wiki_plan_job"("id","space_id","owner_id","kind","trigger","state","version","job_id","made_at")
     VALUES ($1,$2,$3,'build','owner','made',27,$4::uuid,now())`,
    [planJobId, spaceId, h.owner.id, jobId],
  );
  return { jobId, planJobId };
}

async function planJobRow(h: Harness, id: string): Promise<{ state: string; outcome: string | null; error: string | null; job_id: string | null }> {
  return (await h.sql.query<{ state: string; outcome: string | null; error: string | null; job_id: string | null }>(
    'SELECT "state","outcome","error","job_id" FROM "wiki_plan_job" WHERE "id" = $1', [id])).rows[0];
}

test('an error the build did not expect ends the job at its third attempt, with its plan job, and Activity reads why', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  await modelUp(h);
  // docs_build 79620f23 (2026-10-09): the writer's assertion failed at every attempt, and the job was put back
  // every time its space was free.
  const SHOWN = "docs/article-durable-agent-work.md was shown before it was read: the build reads a section's files first";
  let runs = 0;
  const { queue, executor } = worker(h, {
    runners: {
      docs_build: async () => {
        runs += 1;
        throw new Error(SHOWN);
      },
    },
  });
  const { jobId, planJobId } = await buildJob(h, h.owner.spaceId);
  for (let i = 1; i < UNEXPECTED_MAX_ATTEMPTS; i += 1) {
    const row = await attempt(h, executor, jobId);
    assert.deepEqual([row.state, row.attempts, row.failure_kind, row.error], ['queued', i, 'infra', SHOWN], `attempt ${i} is retried in case it was passing`);
  }
  const ended = await attempt(h, executor, jobId);
  assert.deepEqual([ended.state, ended.attempts, ended.failure_kind], ['failed', UNEXPECTED_MAX_ATTEMPTS, 'infra'], `attempt ${UNEXPECTED_MAX_ATTEMPTS} ends it`);
  assert.equal(ended.error, `Ended after ${UNEXPECTED_MAX_ATTEMPTS} attempts (an error this build did not expect): ${SHOWN}`);
  const { rows } = await h.sql.query<{ ended_at: Date | null; lease_owner: string | null }>('SELECT "ended_at","lease_owner" FROM "wiki_job" WHERE "id" = $1', [jobId]);
  assert.ok(rows[0].ended_at, 'the job ended');
  assert.equal(rows[0].lease_owner, null);
  // Its plan job ends with it, still naming its maker: the plan page reads the build as failed, and why.
  assert.deepEqual(await planJobRow(h, planJobId), { state: 'ended', outcome: 'failed', error: ended.error, job_id: jobId });
  // Activity's Runs card reads the job's end and its error (jobs.read).
  const read = await new WikiJobReads(h.prisma as unknown as PrismaService).read(h.owner.id, h.owner.spaceId);
  const shown = read.jobs.find((one) => one.id === jobId);
  assert.deepEqual([shown?.state, shown?.failureKind, shown?.attempts, shown?.error], ['failed', 'infra', UNEXPECTED_MAX_ATTEMPTS, ended.error]);
  // It is not tried again.
  await pass(executor, queue, 3);
  await executor.whenIdle();
  assert.equal(runs, UNEXPECTED_MAX_ATTEMPTS, 'tried three times, and no more');
  assert.equal((await jobRow(h, jobId)).state, 'failed');
});

test('an infra failure ends the job at its tenth attempt, and its maintenance run ends failed / infra with it', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  await modelUp(h);
  const REPO = "REPO_NOT_READY: the space's repository cannot be read now (runner_offline)";
  let runs = 0;
  const { queue, executor } = worker(h, {
    runners: {
      maintain: async () => {
        runs += 1;
        throw new WikiJobInfraError(REPO);
      },
    },
  });
  const runId = randomUUID();
  const jobId = await job(h, { kind: 'maintain', spaceId: h.owner.otherSpaceId, input: { runId } });
  await h.prisma.wikiMaintenanceRun.create({
    data: { id: runId, spaceId: h.owner.otherSpaceId, ownerId: h.owner.id, jobId, due: 'backlog', backlog: 1, pendingSessions: 1, startedAt: new Date() },
  });
  for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
    const row = await attempt(h, executor, jobId);
    assert.deepEqual([row.state, row.attempts, row.failure_kind], ['queued', i, 'infra'], `attempt ${i} of the platform's failure is retried`);
  }
  // The run stays open while its job is retried: the next attempt starts it again.
  assert.equal((await h.prisma.wikiMaintenanceRun.findUniqueOrThrow({ where: { id: runId } })).outcome, null);
  const ended = await attempt(h, executor, jobId);
  assert.deepEqual([ended.state, ended.attempts, ended.failure_kind, ended.error], ['failed', MAX_ATTEMPTS, 'infra', `Ended after ${MAX_ATTEMPTS} attempts: ${REPO}`]);
  const run = await h.prisma.wikiMaintenanceRun.findUniqueOrThrow({ where: { id: runId } });
  assert.deepEqual([run.outcome, run.failureKind, run.error, run.endedAt !== null], ['failed', 'infra', ended.error, true],
    'the run ends as the platform\'s failure: the space\'s streak is not the pipeline\'s to carry');
  await pass(executor, queue, 3);
  await executor.whenIdle();
  assert.equal(runs, MAX_ATTEMPTS, 'tried ten times, and no more');
});

test('a job the lease sweep puts back at the limit is ended by the next pass and never run again; its calls are cancelled', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  await modelUp(h);
  let runs = 0;
  const { executor } = worker(h, {
    runners: {
      docs_build: async () => {
        runs += 1;
        return {};
      },
    },
  });
  // A worker that died while it ran the job's last attempt: running under a lease that ran out, one call still queued.
  const { jobId, planJobId } = await buildJob(h, h.owner.spaceId, { attempts: MAX_ATTEMPTS - 1 });
  await h.sql.query(
    `UPDATE "wiki_job" SET "state" = 'running', "lease_owner" = $2, "lease_generation" = $3, "lease_deadline_at" = now() - interval '1 second', "started_at" = now()
      WHERE "id" = $1`, [jobId, randomUUID(), randomUUID()]);
  const call = await enqueueWikiModelRequest(h.prisma as unknown as PrismaService, {
    id: randomUUID(), jobId, ownerId: h.owner.id, spaceId: h.owner.spaceId, step: 'docs_write', unit: 'doc#s1#abc', attempt: 1, priority: 1,
    request: { system: 's', prompt: 'p', maxTokens: 10 },
  });
  await executor.runOnce();
  await executor.whenIdle();
  const ended = await jobRow(h, jobId);
  assert.deepEqual([ended.state, ended.attempts, ended.failure_kind], ['failed', MAX_ATTEMPTS, 'infra'], 'the sweep counted the lost attempt, and the pass ended the job');
  assert.equal(ended.error, `Ended after ${MAX_ATTEMPTS} attempts: LEASE_EXPIRED: the worker holding this job stopped before settling it`);
  assert.equal(runs, 0, 'a job at the limit is never claimed again');
  assert.deepEqual(await planJobRow(h, planJobId), { state: 'ended', outcome: 'failed', error: ended.error, job_id: jobId });
  const request = await h.prisma.wikiModelRequest.findUniqueOrThrow({ where: { id: call.id } });
  assert.equal(request.state, 'cancelled', 'no model time is spent on a call nobody will read');
});

// ── 8. the stop (design §5.4) ───────────────────────────────────────────────────────────────────

/**
 * What a job the stop handed back says on its row (contract `jobs.lease.handBack`), and what the lease sweep says of
 * one nobody handed back (`jobs.lease.sweep`): pinned here word for word, as the contract states them.
 */
const HANDED_BACK = 'WORKER_STOPPED: the worker was stopped and handed this job back; the next one takes it over at once, without counting an attempt';
const LEASE_EXPIRED = 'LEASE_EXPIRED: the worker holding this job stopped before settling it';

test('a job its worker stops is handed back, whatever its pipeline ends with once stopped: queued at once, nothing counted, nothing new asked', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  await modelUp(h);
  // A pipeline waiting when the worker stops, which then does what a stopping pipeline still may: the next call of a
  // fan-out, and the end the documents' build gives when it sees the stop between two sections.
  let asked = '';
  const { executor } = worker(h, {
    runners: {
      docs_build: async (context) => {
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        asked = await context.ask('docs_write', 'after-the-stop', { system: 's', prompt: 'p', maxTokens: 10 })
          .then(() => 'answered', (error: Error) => error.name);
        throw new Error('the build was stopped: the worker is shutting down');
      },
    },
  });
  // One attempt short of the limit an error the build did not expect is held to: the stop must not count as one.
  const { jobId, planJobId } = await buildJob(h, h.owner.spaceId, { attempts: UNEXPECTED_MAX_ATTEMPTS - 1 });
  assert.equal(await executor.runOnce(), 1);
  await executor.onModuleDestroy();
  const row = await jobRow(h, jobId);
  assert.deepEqual(
    {
      state: row.state, lease: row.lease_deadline_at, nextAttemptAt: row.next_attempt_at, attempts: row.attempts, failureKind: row.failure_kind,
      error: row.error, asked, requests: await h.prisma.wikiModelRequest.count({ where: { jobId } }), planJob: (await planJobRow(h, planJobId)).state,
    },
    {
      state: 'queued', lease: null, nextAttemptAt: null, attempts: UNEXPECTED_MAX_ATTEMPTS - 1, failureKind: null,
      error: HANDED_BACK, asked: 'WikiModelWaitCancelled', requests: 0, planJob: 'made',
    },
    'the job is back in the queue as it stood, due at once with why on its row, and the call after the stop never reached the queue',
  );
});

test('a claim the stop overtakes hands back what it took, and starts nothing', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  await modelUp(h);
  const { jobId } = await buildJob(h, h.owner.spaceId, { attempts: 2 });
  let ran = 0;
  const { queue } = worker(h);
  // SIGTERM comes while the pass's claim is on its way to the database: the claim still takes the job, and the stop's
  // cancel has already gone past it.
  let executor!: WikiJobExecutor;
  const prisma = new Proxy(h.prisma, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (key !== '$queryRaw') return bound;
      return (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (Array.isArray(strings) && strings.join('?').includes(`SET "state" = 'running'`)) void executor.onModuleDestroy();
        return bound(strings, ...values);
      };
    },
  });
  executor = new WikiJobExecutor(prisma as unknown as PrismaService, queue, { leaseMs: 400, renewMs: 100, pollMs: 30 }, {
    docs_build: async () => {
      ran += 1;
      return {};
    },
  });
  live.push({ queue, executor });
  assert.equal(await executor.runOnce(), 0, 'the pass starts nothing');
  const row = await jobRow(h, jobId);
  assert.deepEqual(
    { ran, state: row.state, attempts: row.attempts, lease: row.lease_deadline_at, nextAttemptAt: row.next_attempt_at, error: row.error },
    { ran: 0, state: 'queued', attempts: 2, lease: null, nextAttemptAt: null, error: HANDED_BACK },
    'what the claim took is handed back at once, unstarted and with nothing counted',
  );
});

// ── 9. a stop against a crash, in one space (the owner's decision of 2026-10-09) ──────────────────────

/** A worker whose runs end at once, each saying which kind it was, in the order they ran. */
function recording(h: Harness): { ran: string[]; executor: WikiJobExecutor } {
  const ran: string[] = [];
  const record = (kind: string): WikiJobRunner => async () => {
    ran.push(kind);
    return {};
  };
  return { ran, executor: worker(h, { runners: { docs_build: record('docs_build'), articles: record('articles') } }).executor };
}

test('a build the stop handed back keeps its attempts and is the next worker\'s first claim, ahead of the articles of its space', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  await modelUp(h);
  // docs_build 79620f23 (2026-10-09): a build at priority 1 that had failed twice was running when a deploy stopped its
  // worker, and its space's articles job at priority 0 was queued behind it. The sweep counted the stop as a lost
  // attempt and backed the build off 30 s, so at 06:56Z the next worker took the articles first and the build waited
  // 40 minutes more; the day's deploys had cost it three of its ten attempts.
  const stopping = worker(h, {
    runners: {
      docs_build: async (context) => {
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('the build was stopped: the worker is shutting down');
      },
    },
  });
  const { jobId: build } = await buildJob(h, h.owner.spaceId, { attempts: 2 });
  assert.equal(await stopping.executor.runOnce(), 1, 'the build runs');
  const articles = await job(h, { kind: 'articles' });
  await stopping.executor.onModuleDestroy();
  const handedBack = await jobRow(h, build);
  // What Activity reads meanwhile (jobs.read): the build first in line, nothing scheduled and nothing counted — the Runs
  // card's `next in line`, never a `retrying in` — and the articles behind it.
  const { jobs } = await new WikiJobReads(h.prisma as unknown as PrismaService).read(h.owner.id, h.owner.spaceId);
  assert.deepEqual(
    [build, articles].map((id) => {
      const one = jobs.find((shown) => shown.id === id);
      return one && { state: one.state, attempts: one.attempts, ahead: one.ahead, nextAttemptAt: one.nextAttemptAt, failureKind: one.failureKind, error: one.error };
    }),
    [
      { state: 'queued', attempts: 2, ahead: 0, nextAttemptAt: null, failureKind: null, error: HANDED_BACK },
      { state: 'queued', attempts: 0, ahead: 1, nextAttemptAt: null, failureKind: null, error: null },
    ],
    'Activity reads the build first in line, with nothing scheduled or counted, and the articles behind it',
  );
  // The next worker's first pass: the one its bootstrap runs at once.
  const next = recording(h);
  const claimed = await next.executor.runOnce();
  await next.executor.whenIdle();
  assert.deepEqual(
    { claimed, ran: next.ran, attempts: (await jobRow(h, build)).attempts, articles: (await jobRow(h, articles)).state },
    { claimed: 1, ran: ['docs_build'], attempts: 2, articles: 'queued' },
    'the first pass takes the build, its attempts as they were, and the articles wait for their space',
  );
  assert.deepEqual(
    {
      state: handedBack.state, attempts: handedBack.attempts, nextAttemptAt: handedBack.next_attempt_at,
      lease: handedBack.lease_deadline_at, failureKind: handedBack.failure_kind, error: handedBack.error,
    },
    { state: 'queued', attempts: 2, nextAttemptAt: null, lease: null, failureKind: null, error: HANDED_BACK },
    'what the stop left: queued and due at once, nothing counted, and why on the row',
  );
});

test('a build whose worker crashed is reclaimed as before: the lost attempt counted and backed off, so the articles of its space go first', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  await modelUp(h);
  // The same two jobs, but the build's worker died holding it — killed, or past its grace — so nothing handed the
  // build back, and its lease ran out.
  const { jobId: build } = await buildJob(h, h.owner.spaceId, { attempts: 2 });
  const dead = await claimWikiJobs(h.prisma as unknown as PrismaService, {
    workerId: randomUUID(), kinds: ['docs_build'], owners: [h.owner.id], limit: 1, leaseMs: 400,
  });
  assert.deepEqual(dead.map((one) => one.id), [build]);
  const articles = await job(h, { kind: 'articles' });
  await h.sql.query(`UPDATE "wiki_job" SET "lease_deadline_at" = now() - interval '1 second' WHERE "id" = $1`, [build]);
  const next = recording(h);
  const claimed = await next.executor.runOnce();
  await next.executor.whenIdle();
  const { rows: [swept] } = await h.sql.query<{ state: string; attempts: number; failure_kind: string | null; error: string | null; backoff: number }>(
    `SELECT "state", "attempts", "failure_kind", "error", EXTRACT(EPOCH FROM ("next_attempt_at" - "updated_at"))::int AS "backoff"
       FROM "wiki_job" WHERE "id" = $1`, [build]);
  assert.deepEqual(
    { claimed, ran: next.ran, build: swept, articles: (await jobRow(h, articles)).state },
    {
      claimed: 1, ran: ['articles'],
      build: { state: 'queued', attempts: 3, failure_kind: 'infra', error: LEASE_EXPIRED, backoff: 30 },
      articles: 'succeeded',
    },
    'a lease nobody handed back is a lost attempt: counted, backed off 30 s at the third, and the space runs its next job meanwhile',
  );
});

test('the lease sweep counts each crash of a job one attempt, and backs it off by the attempts it had made: 0, 10, then 30 s', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  const id = await job(h, { kind: 'docs_build', priority: 1 });
  const swept: Array<{ attempts: number; backoff: number; error: string | null }> = [];
  for (let crash = 1; crash <= 4; crash += 1) {
    // A worker that died holding the job: running under a lease that ran out, never handed back.
    await h.sql.query(
      `UPDATE "wiki_job" SET "state" = 'running', "lease_owner" = $2::uuid, "lease_generation" = $3::uuid,
         "lease_deadline_at" = now() - interval '1 second' WHERE "id" = $1`, [id, randomUUID(), randomUUID()]);
    assert.ok((await reclaimExpiredWikiJobs(h.prisma as unknown as PrismaService, 10)).includes(id), `crash ${crash} is swept`);
    swept.push((await h.sql.query<{ attempts: number; backoff: number; error: string | null }>(
      `SELECT "attempts", EXTRACT(EPOCH FROM ("next_attempt_at" - "updated_at"))::int AS "backoff", "error"
         FROM "wiki_job" WHERE "id" = $1`, [id])).rows[0]);
  }
  assert.deepEqual(swept, [
    { attempts: 1, backoff: 0, error: LEASE_EXPIRED },
    { attempts: 2, backoff: 10, error: LEASE_EXPIRED },
    { attempts: 3, backoff: 30, error: LEASE_EXPIRED },
    { attempts: 4, backoff: 30, error: LEASE_EXPIRED },
  ]);
});

// ── 10. maintenance first, an articles job yields one round at most (the owner's decision of 2026-10-10) ──────────

/** A job of `kind` made `secondsAgo` seconds ago: which of a space's jobs was made first is what the claim reads. */
async function madeAgo(h: Harness, kind: string, secondsAgo: number, options: { spaceId?: string; priority?: number } = {}): Promise<string> {
  const id = await job(h, { kind, spaceId: options.spaceId, priority: options.priority });
  await h.sql.query(`UPDATE "wiki_job" SET "created_at" = now() - make_interval(secs => $2) WHERE "id" = $1`, [id, secondsAgo]);
  return id;
}

/** One claim of this spec's account by a worker that runs every kind these cases queue. */
async function claimed(h: Harness, limit = 1): Promise<ClaimedWikiJob[]> {
  return claimWikiJobs(h.prisma as unknown as PrismaService, {
    workerId: randomUUID(), kinds: ['articles', 'maintain', 'docs_build'], owners: [h.owner.id], limit, leaseMs: 60_000,
  });
}

/** Where Activity reads each named job of a space (jobs.read): how many queued jobs the claim takes before it. */
async function aheadIn(h: Harness, spaceId: string, names: Record<string, string>): Promise<Record<string, number | null>> {
  const { jobs } = await new WikiJobReads(h.prisma as unknown as PrismaService).read(h.owner.id, spaceId);
  return Object.fromEntries(jobs.filter((one) => names[one.id] !== undefined).map((one) => [names[one.id], one.ahead]));
}

async function succeeded(h: Harness, one: ClaimedWikiJob | undefined): Promise<void> {
  if (one) await succeedWikiJob(h.prisma as unknown as PrismaService, { id: one.id, generation: one.leaseGeneration });
}

test('the round of maintenance queued behind its space\'s articles job is claimed first, and Activity reads it next in line', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  // The canary, 2026-10-10: a run's end queues the articles job its ops owe (673 calls, an hour and a half), and the
  // space's next round of maintenance, queued after it, waited an hour and 47 minutes behind it.
  const articles = await madeAgo(h, 'articles', 60);
  const round = await madeAgo(h, 'maintain', 30);
  const names = { [articles]: 'articles', [round]: 'round' };
  // Under the default executor nothing is claimed at all, whatever is queued: the runner path is what it was.
  process.env.ORBIT_WIKI_EXECUTOR = 'runner';
  assert.equal(await worker(h).executor.runOnce(), 0);
  process.env.ORBIT_WIKI_EXECUTOR = 'server';
  const activity = await aheadIn(h, h.owner.spaceId, names);
  const first = (await claimed(h)).map((one) => names[one.id]);
  assert.deepEqual(
    { activity, first },
    { activity: { round: 0, articles: 1 }, first: ['round'] },
    'the round goes first, and Activity reads it next in line with the articles job behind it',
  );
});

test('an articles job yields one round, every attempt of it, and the round after it finds the articles job ahead', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  const prisma = h.prisma as unknown as PrismaService;
  // The run whose end queues the articles job (finishWikiMaintenanceJob): it is running when the job is made, and ends.
  const run = await madeAgo(h, 'maintain', 120);
  const [running] = await claimed(h);
  assert.equal(running?.id, run, 'the run that queues the articles job');
  const articles = await madeAgo(h, 'articles', 90);
  await succeeded(h, running);
  // The next round, made moments later: the first maintenance job made after the articles job, its round.
  const round = await madeAgo(h, 'maintain', 60);
  const names: Record<string, string> = { [articles]: 'articles', [round]: 'round' };
  const order: string[] = [];
  const take = async (): Promise<ClaimedWikiJob | undefined> => {
    const [one] = await claimed(h);
    order.push(one ? names[one.id] ?? one.kind : '(nothing)');
    return one;
  };
  // The round goes first, and finds the space's runner away: put back for infra, on the backoff.
  const first = await take();
  if (first) await requeueWikiJobForInfra(prisma, { id: first.id, generation: first.leaseGeneration, error: 'the runner is offline' });
  await h.sql.query(`UPDATE "wiki_job" SET "next_attempt_at" = now() + interval '10 seconds' WHERE "id" = $1 AND "state" = 'queued'`, [round]);
  // While it backs off, the articles job still waits for it: the space runs nothing rather than let the articles in.
  await take();
  // A second in the past: the column keeps milliseconds, rounded, so now() itself can land after the next claim's now().
  await h.sql.query(`UPDATE "wiki_job" SET "next_attempt_at" = now() - interval '1 second' WHERE "id" = $1 AND "state" = 'queued'`, [round]);
  // Its retry is still that round, and this time it ends.
  await succeeded(h, await take());
  // The round after it is made: the articles job has yielded its one round and goes first, the new round waits for the
  // space, and then runs.
  names[await madeAgo(h, 'maintain', 0)] = 'next round';
  const third = await take();
  await take();
  await succeeded(h, third);
  await take();
  assert.deepEqual(order, ['round', '(nothing)', 'round', 'articles', '(nothing)', 'next round']);
});

test('the owner\'s own work still goes before both the round and the articles job', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  const articles = await madeAgo(h, 'articles', 90);
  const round = await madeAgo(h, 'maintain', 60);
  // A build the owner's confirmation made (priority 1, jobs.priority), the newest of the three.
  const build = await madeAgo(h, 'docs_build', 30, { priority: 1 });
  const names = { [articles]: 'articles', [round]: 'round', [build]: 'build' };
  const activity = await aheadIn(h, h.owner.spaceId, names);
  const order: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const [one] = await claimed(h);
    order.push(one ? names[one.id] : '(nothing)');
    await succeeded(h, one);
  }
  assert.deepEqual(
    { activity, order },
    { activity: { build: 0, round: 1, articles: 2 }, order: ['build', 'round', 'articles'] },
    'priority first: the build, then the round, then the articles job',
  );
});

test('another space is not affected: each space keeps its place in the line, and only which of its own jobs takes it changes', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  // Space one: an articles job and then its round. Space two: an articles job made between the two, and nothing else.
  const queue = async () => {
    const articles = await madeAgo(h, 'articles', 90);
    const theirs = await madeAgo(h, 'articles', 60, { spaceId: h.owner.otherSpaceId });
    const round = await madeAgo(h, 'maintain', 30);
    return { [articles]: 'one: articles', [round]: 'one: round', [theirs]: 'two: articles' };
  };
  let names = await queue();
  const activity = { ...await aheadIn(h, h.owner.spaceId, names), ...await aheadIn(h, h.owner.otherSpaceId, names) };
  // A worker with room for one: space one's place comes first in the line and its round takes it; then space two's turn.
  const roomForOne = [(await claimed(h, 1)).map((one) => names[one.id]), (await claimed(h, 1)).map((one) => names[one.id])];
  // A worker with room for both: one claim takes a job of each space, space two's as it always would.
  await reset(h);
  names = await queue();
  const roomForTwo = (await claimed(h, 2)).map((one) => names[one.id]).sort();
  assert.deepEqual(
    { activity, roomForOne, roomForTwo },
    {
      activity: { 'one: round': 0, 'two: articles': 1, 'one: articles': 2 },
      roomForOne: [['one: round'], ['two: articles']],
      roomForTwo: ['one: round', 'two: articles'],
    },
    'space two reads and is claimed exactly where it was; space one keeps its place and gives it to its round',
  );
});

test('an articles job that has run before yields to nothing: one a stop handed back keeps its turn', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  const prisma = h.prisma as unknown as PrismaService;
  const articles = await madeAgo(h, 'articles', 60);
  const [running] = await claimed(h);
  assert.equal(running?.id, articles, 'alone in its space, the articles job is claimed at once');
  // The space's next round is made while it runs: nothing of the space is claimed, and the running job is not touched.
  const round = await madeAgo(h, 'maintain', 0);
  assert.deepEqual(await claimed(h), [], 'one job per space at a time');
  assert.equal((await jobRow(h, articles)).state, 'running');
  // A deploy stops its worker: the job is handed back, queued at once (jobs.lease.handBack). It has had its turn.
  assert.equal(await releaseWikiJobLease(prisma, { id: articles, generation: running!.leaseGeneration }), true);
  const names = { [articles]: 'articles', [round]: 'round' };
  assert.deepEqual(
    { activity: await aheadIn(h, h.owner.spaceId, names), next: (await claimed(h)).map((one) => names[one.id]) },
    { activity: { articles: 0, round: 1 }, next: ['articles'] },
    'the handed-back articles job takes its turn back, ahead of the round made while it ran',
  );
});
