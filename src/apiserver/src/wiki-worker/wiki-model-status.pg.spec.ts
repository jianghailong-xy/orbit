/**
 * The System model's state (contracts/wiki.contract.json `systemModel.status` and `.read`), against a real PostgreSQL,
 * a System model played by a local Node http server, and the read's real route:
 *
 *   1. the read answers the model's name and its state, and nothing that names where the model answers or the key it
 *      is called with — and neither does the row the worker writes;
 *   2. the endpoint's /health failing turns the state down, and its recovery turns it up again, `since` saying when
 *      each began;
 *   3. the endpoint refusing the key (401), to the probe or to a call, turns it auth_failed, which holds until the
 *      worker restarts;
 *   4. a heartbeat older than workerStaleSeconds, or none at all, reads as worker_not_running — the settings page's and
 *      the health line's "wiki worker not running" — on the read and on /api/metrics;
 *   5. with no System model configured the state is unconfigured, and the heartbeat still goes on;
 *   6. the worker itself, WikiWorkerModule booted as main.ts boots it, writes the row and keeps its heartbeat moving,
 *      and stops cleanly.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki-worker/wiki-model-status.pg.spec.ts
 *
 * Not destructive: the one table it writes is the one this phase adds, in a database the script made for it. Only the
 * credential check is stood in for.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { after, test } from 'node:test';

import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
import { WIKI_SYSTEM_MODEL } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MetricsController } from '../metrics/metrics.controller';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { WikiSystemModelReads } from '../wiki/wiki-system-model';
import { WikiSystemModelController } from '../wiki/wiki-system-model.controller';
import { askWikiSystemModel, WikiModelError } from './wiki-model-client';
import { WikiModelStatusProbe } from './wiki-model-status';
import { readWikiSystemModel, type WikiSystemModelConfig } from './wiki-system-model';
import { WikiWorkerModule } from './wiki-worker.module';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;

const KEY = `sk-spec-${randomUUID()}`;
const MODEL = 'qwen3-coder-spec';

/** What the fake System model answers: /health's status (or `drop`, the connection cut), and /v1/messages's. */
interface Behaviour {
  health: number | 'drop';
  messages: number | 'stream';
}

interface FakeModel {
  base: string;
  host: string;
  behaviour: Behaviour;
  healthChecks: () => number;
  close: () => Promise<void>;
}

async function fakeModel(): Promise<FakeModel> {
  const behaviour: Behaviour = { health: 200, messages: 'stream' };
  const sockets = new Set<Socket>();
  let healthChecks = 0;
  const reply = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.url === '/health') {
        healthChecks += 1;
        if (behaviour.health === 'drop') {
          response.socket?.destroy();
          return;
        }
        reply(response, behaviour.health, {});
        return;
      }
      if (request.url === '/v1/messages' && behaviour.messages !== 'stream') {
        reply(response, behaviour.messages, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: MODEL, usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })}\n\n`,
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(''));
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    behaviour,
    healthChecks: () => healthChecks,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Harness {
  base: string;
  sql: Client;
  prisma: PrismaClient;
  app: INestApplication;
  model: FakeModel;
  bearer: string;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL_);
    const sql = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const prisma = prismaClientFor(URL_ as string);
    const bearer = `bearer-${randomUUID()}`;
    const userId = randomUUID();

    @Module({
      controllers: [WikiSystemModelController, MetricsController],
      providers: [
        { provide: WikiSystemModelReads, useValue: new WikiSystemModelReads(prisma as unknown as PrismaService) },
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
        Reflector,
        {
          provide: JwtService,
          useValue: {
            verifyAsync: async (token: string) => {
              if (token !== bearer) throw new Error('not a bearer this run issued');
              return { sub: userId, email: `${userId}@wiki.invalid` };
            },
          },
        },
      ],
    })
    class SystemModelReadModule {}

    const app = await NestFactory.create(SystemModelReadModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    return { base: await app.getUrl(), sql, prisma, app, model: await fakeModel(), bearer };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const { app, prisma, sql, model } = await harness;
  await app.close().catch(() => undefined);
  await model.close().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await sql.end().catch(() => undefined);
});

/** The worker's configuration, pointing at the fake System model (or as `env` says). */
function configured(h: Harness): WikiSystemModelConfig {
  return readWikiSystemModel({ ORBIT_WIKI_MODEL_BASE_URL: h.model.base, ORBIT_WIKI_MODEL_API_KEY: KEY, ORBIT_WIKI_MODEL: MODEL });
}

/** A worker's probe, as a fresh process would hold it. */
function worker(h: Harness, config: WikiSystemModelConfig = configured(h)): WikiModelStatusProbe {
  return new WikiModelStatusProbe(h.prisma as unknown as PrismaService, config);
}

/** The read, over HTTP, as the settings page makes it: its status, its body, and the body as sent. */
async function read(h: Harness, bearer: string | null = h.bearer): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const response = await fetch(`${h.base}/api/wiki/system-model`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
  const text = await response.text();
  return { status: response.status, text, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

interface Row {
  state: string;
  model: string | null;
  since: Date;
  last_error: string | null;
  checked_at: Date | null;
  worker_seen_at: Date;
}

async function row(h: Harness): Promise<Row | null> {
  const { rows } = await h.sql.query<Row>('SELECT "state", "model", "since", "last_error", "checked_at", "worker_seen_at" FROM "wiki_model_status"');
  assert.ok(rows.length <= 1, `wiki_model_status holds ${rows.length} rows`);
  return rows[0] ?? null;
}

async function fresh(h: Harness): Promise<void> {
  await h.sql.query('DELETE FROM "wiki_model_status"');
  h.model.behaviour.health = 200;
  h.model.behaviour.messages = 'stream';
}

/** Nothing in `text` names where the model answers or its key. */
function assertNoAddressOrKey(h: Harness, text: string, what: string): void {
  for (const secret of [KEY, h.model.base, h.model.host]) {
    assert.equal(text.includes(secret), false, `${what} names ${secret}: ${text}`);
  }
}

test('the read answers the model\'s name and its state, and nothing that names its address or its key; nor does the row', { skip }, async () => {
  const h = await boot();
  await fresh(h);
  // Behind the account's credential, like every wiki route.
  assert.equal((await read(h, null)).status, 401);

  // No worker has ever written: no row, and the read says the worker is not running.
  const before = await read(h);
  assert.equal(before.status, 200);
  // Beside the model's state, the executor switch as it stands for the caller (P9): unset here, so runner.
  assert.deepEqual(before.body, {
    state: 'worker_not_running', model: null, since: null, checkedAt: null, workerSeenAt: null,
    executor: { mode: 'runner', serverExecutes: false },
  });

  await worker(h).check();
  const stored = await row(h);
  assert.ok(stored);
  assert.equal(stored.state, 'up');
  assert.equal(stored.model, MODEL);
  assert.equal(stored.last_error, null);
  assert.ok(stored.checked_at);

  const answer = await read(h);
  assert.equal(answer.status, 200);
  assert.deepEqual(Object.keys(answer.body).sort(), ['checkedAt', 'executor', 'model', 'since', 'state', 'workerSeenAt']);
  assert.equal(answer.body.state, 'up');
  assert.equal(answer.body.model, MODEL);
  assert.equal(answer.body.since, stored.since.toISOString());
  assert.equal(answer.body.checkedAt, stored.checked_at.toISOString());
  assert.equal(answer.body.workerSeenAt, stored.worker_seen_at.toISOString());
  assertNoAddressOrKey(h, answer.text, 'the read');

  // The row itself, every column of it: the worker writes neither.
  const { rows } = await h.sql.query('SELECT row_to_json(s)::text AS json FROM "wiki_model_status" s');
  assertNoAddressOrKey(h, rows[0].json as string, 'the row');
});

test('the endpoint\'s /health failing turns the state down, its recovery up again; since says when each began', { skip }, async () => {
  const h = await boot();
  await fresh(h);
  const probe = worker(h);
  await probe.check();
  const up = await row(h);
  assert.equal(up?.state, 'up');

  // Another probe that finds the same: the heartbeat moves, since does not.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await probe.check();
  const again = await row(h);
  assert.equal(again?.since.getTime(), up?.since.getTime());
  assert.ok((again?.worker_seen_at.getTime() ?? 0) > (up?.worker_seen_at.getTime() ?? 0), 'the heartbeat did not move');

  h.model.behaviour.health = 503;
  await probe.check();
  const down = await row(h);
  assert.equal(down?.state, 'down');
  assert.equal(down?.last_error, '/health answered HTTP 503');
  assert.ok((down?.since.getTime() ?? 0) > (up?.since.getTime() ?? 0), 'since did not move to the start of down');
  let answer = await read(h);
  assert.equal(answer.body.state, 'down');
  assert.equal(answer.body.since, down?.since.toISOString());
  assertNoAddressOrKey(h, answer.text, 'the read while down');

  // No answer at all: the connection is cut. Down still, and the reason names no address.
  h.model.behaviour.health = 'drop';
  await probe.check();
  const cut = await row(h);
  assert.equal(cut?.state, 'down');
  assert.match(cut?.last_error ?? '', /^\/health could not be reached \(/);
  assertNoAddressOrKey(h, cut?.last_error ?? '', 'last_error');
  assert.equal(cut?.since.getTime(), down?.since.getTime(), 'down stayed down: since stays');

  h.model.behaviour.health = 200;
  await probe.check();
  const recovered = await row(h);
  assert.equal(recovered?.state, 'up');
  assert.equal(recovered?.last_error, null);
  assert.ok((recovered?.since.getTime() ?? 0) > (down?.since.getTime() ?? 0));
  answer = await read(h);
  assert.equal(answer.body.state, 'up');

  // A 404 is up as well: an endpoint with no /health of its own still answers.
  h.model.behaviour.health = 404;
  await probe.check();
  assert.equal((await row(h))?.state, 'up');
});

test('the endpoint refusing the key — to the probe or to a call — is auth_failed, and holds until the worker restarts', { skip }, async () => {
  const h = await boot();
  await fresh(h);

  // To the probe.
  const first = worker(h);
  h.model.behaviour.health = 401;
  await first.check();
  let stored = await row(h);
  assert.equal(stored?.state, 'auth_failed');
  assert.equal(stored?.last_error, 'the key was refused: /health answered HTTP 401');
  assert.equal((await read(h)).body.state, 'auth_failed');
  // /health answering again says nothing about the key: the same process stays auth_failed.
  h.model.behaviour.health = 200;
  await first.check();
  assert.equal((await row(h))?.state, 'auth_failed');

  // A restart reads the key again, and starts over.
  const restarted = worker(h);
  await restarted.check();
  assert.equal((await row(h))?.state, 'up');

  // To a call: the client classes the 401, and the queue reports it to the probe.
  h.model.behaviour.messages = 401;
  const config = configured(h);
  let refused: WikiModelError | undefined;
  try {
    await askWikiSystemModel(
      { baseUrl: config.baseUrl as string, apiKey: config.apiKey as string, model: config.model as string },
      { system: 's', prompt: 'p', maxTokens: 16, timeoutMs: 5_000 },
    );
  } catch (error) {
    refused = error as WikiModelError;
  }
  assert.ok(refused instanceof WikiModelError);
  assert.equal(refused.kind, 'unauthorized');
  assert.equal(refused.status, 401);
  await restarted.keyRefused(refused.message);
  stored = await row(h);
  assert.equal(stored?.state, 'auth_failed');
  assert.equal(stored?.last_error, 'HTTP 401 authentication_error: invalid x-api-key');
  const answer = await read(h);
  assert.equal(answer.body.state, 'auth_failed');
  assertNoAddressOrKey(h, answer.text, 'the read while auth_failed');
  await restarted.check();
  assert.equal((await row(h))?.state, 'auth_failed', 'a /health that answers does not undo a refused key');
});

test('a heartbeat older than workerStaleSeconds reads as worker_not_running, on the read and on /api/metrics', { skip }, async () => {
  const h = await boot();
  await fresh(h);
  await worker(h).check();
  const stale = WIKI_SYSTEM_MODEL.workerStaleSeconds;

  // Just inside: the stored state.
  await h.sql.query(`UPDATE "wiki_model_status" SET "worker_seen_at" = now() - interval '${stale - 5} seconds'`);
  assert.equal((await read(h)).body.state, 'up');

  // Past it: the worker is not running, whatever the row last said; since is its last heartbeat.
  await h.sql.query(`UPDATE "wiki_model_status" SET "worker_seen_at" = now() - interval '${stale + 1} seconds'`);
  const stored = await row(h);
  const answer = await read(h);
  assert.equal(answer.body.state, 'worker_not_running');
  assert.equal(answer.body.model, MODEL);
  assert.equal(answer.body.since, stored?.worker_seen_at.toISOString());
  assert.equal(answer.body.workerSeenAt, stored?.worker_seen_at.toISOString());

  const metrics = await fetch(`${h.base}/api/metrics`, { headers: { authorization: `Bearer ${h.bearer}` } });
  assert.equal(metrics.status, 200);
  const body = await metrics.text();
  assert.match(body, /^orbit_wiki_model_state\{state="worker_not_running"\} 1$/m);
  assert.match(body, /^orbit_wiki_model_state\{state="up"\} 0$/m);
  const age = /^orbit_wiki_worker_heartbeat_age_seconds (\S+)$/m.exec(body);
  assert.ok(age && Number(age[1]) > stale, `heartbeat age ${age?.[1]}`);
  assert.match(body, /^orbit_wiki_model_calls_total\{outcome="succeeded"\} 0$/m);
  assertNoAddressOrKey(h, body, '/api/metrics');

  // The worker writes again: running again.
  await worker(h).check();
  assert.equal((await read(h)).body.state, 'up');
});

test('with no System model configured the state is unconfigured, nothing is probed, and the heartbeat goes on', { skip }, async () => {
  const h = await boot();
  await fresh(h);
  const checks = h.model.healthChecks();
  const probe = worker(h, readWikiSystemModel({}));
  await probe.check();
  const stored = await row(h);
  assert.equal(stored?.state, 'unconfigured');
  assert.equal(stored?.model, null);
  assert.equal(stored?.checked_at, null);
  assert.equal(stored?.last_error, 'ORBIT_WIKI_MODEL_BASE_URL, ORBIT_WIKI_MODEL_API_KEY, ORBIT_WIKI_MODEL: not set or not usable');
  assert.equal(h.model.healthChecks(), checks, 'an unconfigured worker probed something');
  assert.deepEqual(
    { state: (await read(h)).body.state, model: (await read(h)).body.model },
    { state: 'unconfigured', model: null },
  );

  // Only the key missing: unconfigured, and the model it is waiting for is named.
  await worker(h, readWikiSystemModel({ ORBIT_WIKI_MODEL_BASE_URL: h.model.base, ORBIT_WIKI_MODEL: MODEL })).check();
  const waiting = await row(h);
  assert.equal(waiting?.state, 'unconfigured');
  assert.equal(waiting?.model, MODEL);
  assert.equal(waiting?.last_error, 'ORBIT_WIKI_MODEL_API_KEY: not set or not usable');
});

test('the worker as main.ts boots it writes the row, keeps its heartbeat moving, and stops cleanly', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await fresh(h);
  // The worker's environment, as Compose gives it; put back as it was afterwards.
  const environment: Record<string, string> = {
    DATABASE_URL: URL_ as string,
    ORBIT_WIKI_MODEL_BASE_URL: h.model.base,
    ORBIT_WIKI_MODEL_API_KEY: KEY,
    ORBIT_WIKI_MODEL: MODEL,
  };
  const saved = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
  Object.assign(process.env, environment);
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  const context = await NestFactory.createApplicationContext(WikiWorkerModule, { logger: false });
  try {
    const waitFor = async (what: string, ok: (stored: Row | null) => boolean, seconds: number): Promise<Row> => {
      const deadline = Date.now() + seconds * 1000;
      for (;;) {
        const stored = await row(h);
        if (stored && ok(stored)) return stored;
        assert.ok(Date.now() < deadline, `${what} within ${seconds} s`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    };
    const first = await waitFor('the first write', (stored) => stored?.state === 'up', 10);
    assert.equal(first.model, MODEL);
    // The next heartbeat, one probeIntervalSeconds later.
    const second = await waitFor(
      'the next heartbeat',
      (stored) => (stored?.worker_seen_at.getTime() ?? 0) > first.worker_seen_at.getTime(),
      WIKI_SYSTEM_MODEL.probeIntervalSeconds + 5,
    );
    const gap = second.worker_seen_at.getTime() - first.worker_seen_at.getTime();
    assert.ok(gap >= (WIKI_SYSTEM_MODEL.probeIntervalSeconds - 1) * 1000, `heartbeats ${gap} ms apart`);
    assert.equal(second.since.getTime(), first.since.getTime());
    assert.ok(h.model.healthChecks() >= 2);
    assert.equal((await read(h)).body.state, 'up');
  } finally {
    await context.close();
    restore();
  }
  // Closed: no probe runs after it.
  const checks = h.model.healthChecks();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(h.model.healthChecks(), checks);
});
