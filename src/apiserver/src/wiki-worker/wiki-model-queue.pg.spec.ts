/**
 * The model request queue (contracts/wiki.contract.json `modelQueue`, migration 0401), against a real PostgreSQL and a
 * System model played by a local Node http server whose answers the spec holds open:
 *
 *   1. several schedulers claim at once and the deployment's concurrency is never passed: with N = 2, however many
 *      schedulers run, no more than two calls are in flight, and the claim takes the highest priority first, then the
 *      longest-waiting;
 *   2. a scheduler is stopped mid-call and another takes over: the requests that already answered are not issued
 *      again, the interrupted one keeps its partial, is requeued and finishes, and every unit has one row and one
 *      answer;
 *   3. a 401 pauses the queue and a worker that starts with a good key resumes it; a model that is down is not called
 *      at all until it is up again;
 *   4. a request that waited past its step's limit fails with the wait limit's words, which is the job's cue to fail
 *      as infra;
 *   5. the metrics read the queue's rows: depth, in flight, wait and run quantiles, tokens and errors by status.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki-worker/wiki-model-queue.pg.spec.ts
 *
 * Not destructive: it writes only rows under its own account and space, and deletes them afterwards.
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
import { readWikiModelQueueStats } from '../wiki/wiki-model-metrics';
import { enqueueWikiModelRequest, WIKI_MODEL_WAIT_LIMIT_ERROR, wikiModelRequestFailedOnWaitLimit } from './wiki-model-queue';
import { WikiModelRequestQueue } from './wiki-model-queue.service';
import { WikiModelStatusProbe } from './wiki-model-status';
import { readWikiSystemModel, type WikiSystemModelConfig } from './wiki-system-model';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;

const KEY = `sk-spec-${randomUUID()}`;
const MODEL = 'qwen3-coder-spec';

/** What one call to /v1/messages does: stream (holding after a chunk until the gate lets go), or refuse. */
type Behaviour = { kind: 'stream'; chunks: string[]; holdAfter?: number } | { kind: 'status'; status: number };

interface Hit {
  prompt: string;
}

interface FakeModel {
  base: string;
  host: string;
  behaviour: { health: number; answer: (hit: Hit, index: number) => Behaviour };
  /** Held answers wait for this, and for the socket closing; a spec that releases it lets the held calls finish. */
  gate: Promise<void>;
  release: () => void;
  hits: Hit[];
  inFlight: number;
  peak: number;
  close: () => Promise<void>;
}

async function fakeModel(): Promise<FakeModel> {
  const sockets = new Set<Socket>();
  const hits: Hit[] = [];
  let releaseGate!: () => void;
  const state = {
    base: '',
    host: '',
    behaviour: { health: 200, answer: (): Behaviour => ({ kind: 'stream', chunks: ['ok'] }) },
    gate: new Promise<void>((resolve) => {
      releaseGate = resolve;
    }),
    release: () => releaseGate(),
    hits,
    inFlight: 0,
    peak: 0,
    close: async () => undefined,
  } as FakeModel;
  const stream = async (response: ServerResponse, behaviour: Behaviour): Promise<void> => {
    // A call the scheduler aborted is a closed socket: writing to it is not an error worth throwing over.
    const write = (what: string) => {
      try {
        response.write(what);
      } catch {
        /* the call was abandoned */
      }
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    write(event('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 3, output_tokens: 1 } } }));
    const chunks = behaviour.kind === 'stream' ? behaviour.chunks : [];
    for (const [index, chunk] of chunks.entries()) {
      write(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }));
      if (behaviour.kind === 'stream' && behaviour.holdAfter === index + 1) {
        // The call stays in flight until the spec releases the gate or the client goes away.
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
  };
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
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      response.on('close', () => {
        state.inFlight -= 1;
      });
      const behaviour = state.behaviour.answer({ prompt }, hits.length - 1);
      if (behaviour.kind === 'status') {
        response.writeHead(behaviour.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        return;
      }
      void stream(response, behaviour);
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

interface Owner {
  id: string;
  spaceId: string;
  jobId: string;
}

interface Harness {
  sql: Client;
  prisma: PrismaClient;
  model: FakeModel;
  owner: Owner;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  // The switch the specs run under: `server`, so the queue this spec drives claims its rows (the default
  // `runner` claims nothing at all, which the job spec holds it to).
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
  // Not destructive: the account and space this spec made take their jobs and requests with them.
  await prisma.wikiSpace.deleteMany({ where: { ownerId: owner.id } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: owner.id } }).catch(() => undefined);
  await prisma.wikiModelStatus.deleteMany({ where: { id: 1 } }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await sql.end().catch(() => undefined);
  await model.close().catch(() => undefined);
});

/** One account, one space, and a job to hang requests on. */
async function fixture(prisma: PrismaClient): Promise<Owner> {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `wiki-queue-${id}@wiki.invalid`, name: 'queue spec', passwordHash: 'x' } });
  const spaceId = randomUUID();
  await prisma.wikiSpace.create({ data: { id: spaceId, ownerId: id, slug: `queue-${id.slice(0, 8)}`, title: 'Queue spec' } });
  const jobId = randomUUID();
  await prisma.wikiJob.create({ data: { id: jobId, ownerId: id, spaceId, kind: 'smoke' } });
  return { id, spaceId, jobId };
}

/** The worker's configuration, pointing at the fake System model (or as `env` says). */
function config(h: Harness, env: Record<string, string> = {}): WikiSystemModelConfig {
  return readWikiSystemModel({
    ORBIT_WIKI_MODEL_BASE_URL: h.model.base,
    ORBIT_WIKI_MODEL_API_KEY: KEY,
    ORBIT_WIKI_MODEL: MODEL,
    ...env,
  });
}

/**
 * The schedulers this case started. A case that fails halfway must not leave one running: its loop would go on
 * claiming the next case's requests, which reads as a flake in a test that is not about it.
 */
const live: WikiModelRequestQueue[] = [];

afterEach(async () => {
  for (const one of live.splice(0)) await one.onModuleDestroy().catch(() => undefined);
});

/** A scheduler of one spec: fast timings, so a pass is milliseconds of work. */
function scheduler(h: Harness, probe: WikiModelStatusProbe, concurrency = 2): WikiModelRequestQueue {
  const queue = new WikiModelRequestQueue(
    h.prisma as unknown as PrismaService,
    config(h, { ORBIT_WIKI_MODEL_CONCURRENCY: String(concurrency) }),
    probe,
    undefined,
    { leaseMs: 400, renewMs: 100, partialMs: 40, pollMs: 30 },
  );
  live.push(queue);
  return queue;
}

/** The state row says up: a probe against the fake /health, which the queue reads before it claims. */
async function modelUp(h: Harness, conf: WikiSystemModelConfig = config(h)): Promise<WikiModelStatusProbe> {
  h.model.behaviour.health = 200;
  const probe = new WikiModelStatusProbe(h.prisma as unknown as PrismaService, conf);
  await probe.check();
  return probe;
}

/**
 * The shared harness, reset for one case: this account's requests gone, the fake answering `ok` again, its counters
 * zeroed, its answers held until the case says otherwise.
 */
async function reset(h: Harness): Promise<void> {
  await h.sql.query('DELETE FROM "wiki_model_request" WHERE "owner_id" = $1', [h.owner.id]);
  h.model.hits.length = 0;
  h.model.peak = 0;
  h.model.behaviour.health = 200;
  h.model.behaviour.answer = () => ({ kind: 'stream', chunks: ['ok'] });
  freshGate(h);
  await h.sql.query('DELETE FROM "wiki_model_status"');
}

/** A fresh gate: held answers wait for it, so a spec decides when the calls in flight finish. */
function freshGate(h: Harness): () => void {
  let release!: () => void;
  h.model.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

/** Enqueue one request for `jobId` (the fixture's job unless told otherwise). */
async function enqueue(
  h: Harness,
  step: string,
  unit: string,
  options: { priority?: number; prompt?: string; enqueuedAt?: Date; jobId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await enqueueWikiModelRequest(h.prisma as unknown as PrismaService, {
    id,
    jobId: options.jobId ?? h.owner.jobId,
    ownerId: h.owner.id,
    spaceId: h.owner.spaceId,
    step,
    unit,
    priority: options.priority,
    request: { system: 's', prompt: options.prompt ?? `${step}/${unit}`, maxTokens: 32 },
  });
  if (options.enqueuedAt) {
    await h.sql.query(`UPDATE "wiki_model_request" SET "enqueued_at" = $2 WHERE "id" = $1`, [id, options.enqueuedAt.toISOString()]);
  }
  return id;
}

interface RequestRow {
  id: string;
  state: string;
  attempts: number;
  answer: string | null;
  partial: string | null;
  error: string | null;
  error_kind: string | null;
  lease_deadline_at: Date | null;
  started_at: Date | null;
}

async function request(h: Harness, id: string): Promise<RequestRow> {
  const { rows } = await h.sql.query<RequestRow>(
    `SELECT "id", "state", "attempts", "answer", "partial", "error", "error_kind", "lease_deadline_at", "started_at"
     FROM "wiki_model_request" WHERE "id" = $1`, [id]);
  assert.ok(rows[0], `no request ${id}`);
  return rows[0];
}

/** How many of the fake's calls carried `prompt`. */
function hitsOf(h: Harness, prompt: string): number {
  return h.model.hits.filter((hit) => hit.prompt === prompt).length;
}

async function waitFor(what: string, ok: () => boolean | Promise<boolean>, seconds = 10): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await ok()) return;
    assert.ok(Date.now() < deadline, `${what} within ${seconds} s`);
    await delay(20);
  }
}

/** One more job of the same space, for the cases where the per-job cap must not decide anything. */
async function secondJob(h: Harness): Promise<string> {
  const id = randomUUID();
  await h.prisma.wikiJob.create({ data: { id, ownerId: h.owner.id, spaceId: h.owner.spaceId, kind: 'smoke' } });
  return id;
}

const PROMPTS = ['p-one', 'p-two', 'p-three', 'p-four', 'p-five'] as const;

test('several schedulers claim at once; the deployment\'s concurrency is never passed, and the order is priority then first-come', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  const probe = await modelUp(h);
  // Five requests of two jobs (so the per-job cap does not bind), priorities and arrival mixed.
  const priorities: Record<string, number> = { 'p-one': 0, 'p-two': 5, 'p-three': 0, 'p-four': 0, 'p-five': 3 };
  const other = await secondJob(h);
  const ids: string[] = [];
  for (const [index, prompt] of PROMPTS.entries()) {
    ids.push(await enqueue(h, 'extract', `unit-${index}`, {
      prompt,
      priority: priorities[prompt],
      enqueuedAt: new Date(Date.now() - (PROMPTS.length - index) * 1_000),
      jobId: index < 3 ? h.owner.jobId : other,
    }));
  }
  // Every answer is held, so what is in flight is decided by the claims alone.
  const release = freshGate(h);
  h.model.behaviour.answer = () => ({ kind: 'stream', chunks: ['held'], holdAfter: 1 });

  const schedulers = [scheduler(h, probe), scheduler(h, probe), scheduler(h, probe)];
  const passes = schedulers.map((one) => one.runOnce());
  // Every claim is done before the gate opens: a pass that claimed late would take the room a finished call freed.
  await Promise.all(passes);
  await waitFor('two calls in flight', () => h.model.inFlight === 2);
  // The two in flight are the highest priority and then the longest-waiting; no more than two ever.
  const running = await h.sql.query<{ id: string }>(
    `SELECT "id" FROM "wiki_model_request" WHERE "state" = 'running' AND "lease_deadline_at" > now() ORDER BY "started_at"`);
  assert.equal(running.rows.length, 2, 'running with an unexpired lease');
  assert.deepEqual(new Set(running.rows.map((row) => row.id)), new Set([ids[1], ids[4]]), 'priority 5, then priority 3');
  release();
  await Promise.all(schedulers.map((one) => one.whenIdle()));
  assert.ok(h.model.peak <= 2, `in flight peaked at ${h.model.peak}`);
  // The two that ran answered; the other three wait in the order they will be taken — priority 0, by age.
  for (const id of [ids[1], ids[4]]) assert.equal((await request(h, id)).state, 'succeeded');
  const left = await h.sql.query<{ id: string }>(
    `SELECT "id" FROM "wiki_model_request" WHERE "state" = 'queued' ORDER BY "priority" DESC, "enqueued_at", "id"`);
  assert.deepEqual(left.rows.map((row) => row.id), [ids[0], ids[2], ids[3]], 'the rest wait in priority then arrival order');
  // More passes take the rest, still never more than two at once.
  h.model.behaviour.answer = () => ({ kind: 'stream', chunks: ['rest'] });
  await Promise.all([schedulers[0].runOnce(), schedulers[1].runOnce()]);
  await schedulers[0].runOnce();
  await Promise.all(schedulers.map((one) => one.whenIdle()));
  for (const one of schedulers) await one.onModuleDestroy();
  const states = await h.sql.query<{ state: string; n: string }>(
    `SELECT "state", count(*)::text AS "n" FROM "wiki_model_request" WHERE "owner_id" = $1 GROUP BY 1`, [h.owner.id]);
  assert.deepEqual(states.rows, [{ state: 'succeeded', n: String(PROMPTS.length) }], 'every request answered');
  assert.ok(h.model.peak <= 2, `in flight peaked at ${h.model.peak}`);
  for (const prompt of PROMPTS) assert.equal(hitsOf(h, prompt), 1, `${prompt} was issued once`);
});

test('a scheduler stopped mid-call: answered requests are not issued again, the interrupted one keeps its partial and finishes', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  const probe = await modelUp(h);
  const one = await enqueue(h, 'extract', 'one', { prompt: 'done-already' });
  const two = await enqueue(h, 'extract', 'two', { prompt: 'interrupted' });
  const three = await enqueue(h, 'extract', 'three', { prompt: 'never-started' });
  // The first call answers at once; the second streams one chunk and then holds until the spec lets go.
  freshGate(h);
  h.model.behaviour.answer = (hit) => (hit.prompt === 'interrupted'
    ? { kind: 'stream', chunks: ['Part'], holdAfter: 1 }
    : { kind: 'stream', chunks: ['whole'] });

  const first = scheduler(h, probe);
  const pass = first.runOnce();
  await waitFor('the interrupted call to have streamed its first chunk', async () => (await request(h, two)).partial === 'Part');
  await first.onModuleDestroy();
  await pass;
  // The one that answered is settled and was issued once; the interrupted one kept its partial and let its lease out.
  const answered = await request(h, one);
  assert.equal(answered.state, 'succeeded');
  assert.equal(answered.answer, 'whole');
  assert.equal(hitsOf(h, 'done-already'), 1);
  const interrupted = await request(h, two);
  assert.equal(interrupted.state, 'running', 'the interruption does not settle the row');
  assert.equal(interrupted.partial, 'Part', 'the text received so far was saved');
  assert.ok(interrupted.lease_deadline_at && interrupted.lease_deadline_at.getTime() <= Date.now() + 1_000, 'the lease was let out to now');
  assert.equal((await request(h, three)).state, 'queued', 'the third never started');

  // The next process: its sweep requeues the interrupted row with its partial, and re-issues it to the full answer.
  h.model.behaviour.answer = (hit) => ({ kind: 'stream', chunks: hit.prompt === 'interrupted' ? ['Part', ' two: done'] : ['whole'] });
  const second = scheduler(h, probe);
  await second.runOnce();
  await second.whenIdle();
  await second.runOnce();
  await second.onModuleDestroy();
  const finished = await request(h, two);
  assert.equal(finished.state, 'succeeded');
  assert.equal(finished.answer, 'Part two: done');
  assert.equal(finished.attempts, 1, 'one lost attempt was counted');
  assert.equal((await request(h, three)).state, 'succeeded');
  assert.equal(hitsOf(h, 'interrupted'), 2, 'the interrupted call was issued again, once');
  // Every unit has one row and one answer; the one that had already answered was not issued again.
  const rows = await h.sql.query<{ n: string }>(`SELECT count(*)::text AS "n" FROM "wiki_model_request" WHERE "job_id" = $1`, [h.owner.jobId]);
  assert.equal(rows.rows[0].n, '3');
  assert.equal(hitsOf(h, 'done-already'), 1);
  assert.equal((await request(h, one)).answer, 'whole');
});

test('a 401 pauses the queue, and a worker that starts with a good key resumes it', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  const conf = config(h);
  const probe = await modelUp(h, conf);
  const queue = scheduler(h, probe);
  // An honest call goes through.
  const one = await enqueue(h, 'extract', 'one', { prompt: 'before' });
  assert.equal(await queue.runOnce(), 1);
  await queue.whenIdle();
  assert.equal((await request(h, one)).state, 'succeeded');

  // The endpoint refuses the key: the request goes back to the queue and the state turns auth_failed.
  h.model.behaviour.answer = () => ({ kind: 'status', status: 401 });
  const two = await enqueue(h, 'extract', 'two', { prompt: 'refused' });
  await queue.runOnce();
  await queue.whenIdle();
  const refused = await request(h, two);
  assert.equal(refused.state, 'queued', 'a refused key is not the request\'s failure to keep');
  assert.equal(refused.error_kind, 'unauthorized');
  assert.equal((await h.prisma.wikiModelStatus.findUnique({ where: { id: 1 } }))?.state, 'auth_failed');
  // Nothing is claimed while the key is refused, whatever the endpoint would answer now.
  h.model.behaviour.answer = () => ({ kind: 'stream', chunks: ['would work'] });
  const before = h.model.hits.length;
  assert.equal(await queue.runOnce(), 0, 'no claim while auth_failed');
  await delay(150);
  assert.equal(h.model.hits.length, before, 'the model was not called');
  await queue.onModuleDestroy();

  // A worker that starts over reads the corrected key: up again, and the request it kept finishes.
  const restarted = new WikiModelStatusProbe(h.prisma as unknown as PrismaService, conf);
  await restarted.check();
  const resumed = scheduler(h, restarted);
  assert.equal(await resumed.runOnce(), 1);
  await resumed.whenIdle();
  await resumed.onModuleDestroy();
  assert.equal((await request(h, two)).state, 'succeeded');
  assert.equal((await request(h, two)).answer, 'would work');
  assert.equal((await h.prisma.wikiModelStatus.findUnique({ where: { id: 1 } }))?.state, 'up');
});

test('a model that is down is not called at all, and its recovery resumes the queue', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  const probe = await modelUp(h);
  const queue = scheduler(h, probe);
  h.model.behaviour.answer = () => ({ kind: 'stream', chunks: ['ok'] });
  h.model.behaviour.health = 503;
  await probe.check();
  const id = await enqueue(h, 'extract', 'down', { prompt: 'while down' });
  const before = h.model.hits.length;
  assert.equal(await queue.runOnce(), 0, 'no claim while down');
  assert.equal((await request(h, id)).state, 'queued');
  await delay(150);
  assert.equal(h.model.hits.length, before, 'the model was not called');
  // Up again: the same pass shape claims it and it answers.
  h.model.behaviour.health = 200;
  await probe.check();
  assert.equal(await queue.runOnce(), 1);
  await queue.whenIdle();
  await queue.onModuleDestroy();
  assert.equal((await request(h, id)).state, 'succeeded');
  assert.equal((await request(h, id)).answer, 'ok');
});

test('a request that waited past its step\'s limit fails with the wait limit\'s words — the job\'s cue to fail as infra', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  const probe = await modelUp(h);
  const queue = scheduler(h, probe);
  const late = await enqueue(h, 'docs_build', 'late', { prompt: 'too late', enqueuedAt: new Date(Date.now() - 4 * 60_000) });
  const inTime = await enqueue(h, 'verify', 'fine', { prompt: 'in time', enqueuedAt: new Date(Date.now() - 4 * 60_000) });
  await queue.runOnce();
  await queue.whenIdle();
  await queue.onModuleDestroy();
  const failed = await request(h, late);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error_kind, 'other');
  assert.equal(failed.error, `${WIKI_MODEL_WAIT_LIMIT_ERROR} (180 s)`);
  assert.equal(wikiModelRequestFailedOnWaitLimit(failed.error), true);
  // The same age under a step with the default limit is not late: 4 minutes is inside the 900 s.
  assert.equal((await request(h, inTime)).state, 'succeeded');
});

test('the metrics read the queue\'s rows: depth, in flight, wait and run, tokens and errors by status', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await reset(h);
  const probe = await modelUp(h);
  const queue = scheduler(h, probe);
  // Each prompt answers the same way every time it is tried: 500 is retryable (the row is requeued), 404 is nobody's.
  h.model.behaviour.answer = (hit) => (hit.prompt === 'a 500' ? { kind: 'status', status: 500 }
    : hit.prompt === 'a 404' ? { kind: 'status', status: 404 }
      : { kind: 'stream', chunks: ['ok'] });
  const ok = await enqueue(h, 'extract', 'ok', { prompt: 'counted' });
  await queue.runOnce();
  const retryable = await enqueue(h, 'extract', 'retryable', { prompt: 'a 500' });
  await queue.runOnce();
  const other = await enqueue(h, 'extract', 'other', { prompt: 'a 404' });
  await queue.runOnce();
  const waiting = await enqueue(h, 'extract', 'waiting', { prompt: 'queued' });
  await queue.whenIdle();
  await queue.onModuleDestroy();

  const stats = await readWikiModelQueueStats(h.prisma as unknown as PrismaService);
  assert.equal(stats.depth, 2, 'the requeued one and the one that never ran are queued');
  assert.equal(stats.inFlight, 0);
  assert.deepEqual(stats.calls, { succeeded: 1, retryable: 1, unauthorized: 0, other: 1 });
  assert.deepEqual(stats.tokens, { input: 3, output: 12 });
  assert.equal(stats.run.count, 2, 'the two rows that ended after having run');
  assert.ok((stats.run.p50 ?? -1) >= 0);
  assert.equal(stats.wait.count, 2);
  assert.ok(stats.wait.sum >= 0);
  assert.deepEqual(stats.errors, [{ status: '404', count: 1 }]);
  assert.equal((await request(h, retryable)).state, 'queued');
  assert.equal((await request(h, waiting)).state, 'queued');
  assert.equal((await request(h, ok)).state, 'succeeded');
  assert.equal((await request(h, other)).state, 'failed');
});
