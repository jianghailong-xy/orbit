/**
 * The shared Codex pools' gateway, end to end on real PostgreSQL (docs/codex-shared-pool-design.md
 * §2.2–§2.3): the real controller behind main.ts's own layers, sessions claimed by the real claim, and a
 * recorder standing where OpenAI stands (POOL_GATEWAY_UPSTREAM — in production OPENAI_API_BASE, which
 * nothing can change).
 *
 *  (1) A request codex really sent (providers/fixtures/codex-gateway-recording.json, recorded by
 *      runner-go codex_gateway_recording_test.go) reaches OpenAI as codex sent it — the body byte for
 *      byte, every header but the credential, which is the key the session's claim chose — and the
 *      stream comes back byte for byte; its usage goes into the ledger, priced, for that person and key.
 *  (2) A session token is refused (401) once its session ended, its person was removed, its pool
 *      deleted, it expired or was revoked, or its session moved to another provider; a good token
 *      reaches nothing but POST /responses (403), and none of it reaches OpenAI.
 *  (3) insufficient_quota marks the key out of budget at once, the answer goes back as it came, and the
 *      turn it ended is armed to go again now; the next claim moves the session to another key and
 *      says why — through a `reload` that changes nothing, so a resident engine says it too — and the
 *      gateway sends the next request on the new key.
 *  (4) A 401 from OpenAI marks the key INVALID and answers with the reason and none of OpenAI's words
 *      about the key; the gateway sends nothing more on it, and the next claim moves, saying so.
 *  (5) A rate limit is waited out on the same key — sent again there until it goes through, or answered
 *      as it came — never on another key, never marking one, and the next claim stays.
 *  (6) Own key first, and share caps: a member's own key first, the others held to a key's cap — by the
 *      gateway the moment it is spent, not yet written, and by the claim — and its contributor never.
 *  (7) The ledger: per person and per key, summed across answers, written in one batch; a row whose key
 *      was removed before the write is dropped by the write, which does not fail.
 *  (8) A key marked out of budget is still asked while a session is on it — OpenAI decides — and a
 *      request it takes clears the mark; with every key spent the pool resumes at the first reset.
 *
 * It only adds rows, and refuses to run anywhere but the disposable server `coordinator-pg-test-safety`
 * identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { RunEventType, type ClaimedSession, type TurnCompleteRequest } from '@orbit/shared';
import { json, urlencoded } from 'express';
import { Client } from 'pg';

import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { ProviderPlanUsageService } from './plan-usage.service';
import { outsideThePoolGateway, PoolGatewayController } from './pool-gateway.controller';
import { PoolGatewayService } from './pool-gateway.service';
import { PoolLoginGatewayService } from './pool-login-gateway.service';
import { PoolUsageLedger } from './pool-usage-ledger';
import { ProvidersService } from './providers.service';
import { nextUsageWindowStart, usageWindowStart } from './shared-pool';
import { SharedPoolsService } from './shared-pools.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'pool-gateway-spec';
process.env.PUBLIC_ORIGIN = 'https://orbit.pool-gateway.invalid';

const realtime = new Proxy(
  {},
  { get: (_target, key) => (key === 'then' ? undefined : () => undefined) },
) as RealtimeService;

/** What codex 0.158 sent through a configured provider, and the stream it completed its turn on. */
interface Recording {
  codex: string;
  request: { method: string; path: string; headers: Array<[string, string]>; bodyBase64: string };
  response: { status: number; headers: Array<[string, string]>; bodyBase64: string };
}
const RECORDING = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../src/providers/fixtures/codex-gateway-recording.json'), 'utf8'),
) as Recording;
const RECORDED_BODY = Buffer.from(RECORDING.request.bodyBase64, 'base64');
const RECORDED_STREAM = Buffer.from(RECORDING.response.bodyBase64, 'base64');
const RECORDED_MODEL = (JSON.parse(RECORDED_BODY.toString('utf8')) as { model: string }).model;
/** The usage `response.completed` carries in the recorded stream. */
const RECORDED_USAGE = { input: 11290, cached: 9984, output: 57 };

/** Codex's own headers, with `token` as its credential; `host` and the length are the transport's. */
function codexHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of RECORDING.request.headers) {
    if (name === 'host' || name === 'content-length' || name === 'authorization') continue;
    headers[name] = value;
  }
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return headers;
}

const hex = () => randomUUID().replace(/-/g, '');
const openaiKey = () => `sk-proj-${hex()}${hex()}`;

interface Person {
  name: string;
  id: string;
  email: string;
  runnerId: string;
  workspaceId: string;
}

async function person(db: PrismaClient, name: string): Promise<Person> {
  const id = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const email = `${name}-${id}@pool-gateway.invalid`;
  await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId: id, name: `${name}-runner`, tokenHash: `x-${runnerId}`,
      status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId: id, runnerId, name: `${name}-agent`, enabled: true, workDir: `/tmp/${name}` },
  });
  return { name, id, email, runnerId, workspaceId };
}

/** One request the recorder standing in for OpenAI was sent. */
interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** What the recorder answers with: a status, headers and a body; the recorded stream when none is queued. */
interface Scripted {
  status: number;
  headers?: Record<string, string>;
  body: Buffer;
}

const openAIError = (status: number, error: Record<string, unknown>, headers: Record<string, string> = {}): Scripted => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(JSON.stringify({ error: { param: null, ...error } })),
});

/** A Responses stream like the recorded one, for `usage` of its own. */
function streamWith(model: string, usage: { input: number; cached: number; output: number }): Scripted {
  const response = {
    id: 'resp_spec', object: 'response', status: 'completed', model, service_tier: 'default', output: [],
    usage: {
      input_tokens: usage.input, input_tokens_details: { cached_tokens: usage.cached },
      output_tokens: usage.output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: usage.input + usage.output,
    },
  };
  const text = [
    { type: 'response.created', response: { ...response, status: 'in_progress', usage: null } },
    { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: 'ok' },
    { type: 'response.completed', response },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' }, body: Buffer.from(text) };
}

/** An HTTP exchange, bytes in and bytes out: nothing added to the request, nothing decoded in the answer. */
function exchange(
  base: string,
  method: string,
  urlPath: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}${urlPath}`, { method, headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

const errorOf = (answer: { body: Buffer }) =>
  (JSON.parse(answer.body.toString('utf8')) as { error: { code: string; message: string } }).error;

const suite = URL ? test : test.skip;

suite("the shared pools' gateway, end to end on real PostgreSQL", { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const sessions = new SessionsService(prisma, queue, realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const pools = new SharedPoolsService(prisma, realtime, providers);
  const ledger = new PoolUsageLedger(prisma);
  const runnerApi = new RunnerApiController(
    db as never, queue as never, realtime as never, {} as never, {} as never,
    // Delivering a message expands its #references; this spec's messages have none.
    { expand: async (_ownerId: string, content?: string) => content } as never,
  );

  // OpenAI, as far as the gateway can tell.
  const seen: Seen[] = [];
  const script: Scripted[] = [];
  const openai: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      const answer = script.shift() ?? {
        status: RECORDING.response.status,
        headers: Object.fromEntries(RECORDING.response.headers),
        body: RECORDED_STREAM,
      };
      res.writeHead(answer.status, answer.headers ?? {});
      // In two pieces, as a stream arrives: the gateway must pass on what it has, not wait for the end.
      const half = Math.floor(answer.body.length / 2);
      res.write(answer.body.subarray(0, half));
      setTimeout(() => res.end(answer.body.subarray(half)), 20);
    });
  });
  await new Promise<void>((resolve) => openai.listen(0, '127.0.0.1', resolve));
  const openaiBase = `http://127.0.0.1:${(openai.address() as AddressInfo).port}/v1`;
  const gateway = new PoolGatewayService(prisma, pools, ledger, openaiBase);

  @Module({
    controllers: [PoolGatewayController],
    providers: [
      { provide: PoolGatewayService, useValue: gateway },
      // A login pool's token is the other gateway's (pool-login-gateway.pg.spec.ts); this spec sends none.
      { provide: PoolLoginGatewayService, useValue: {} },
    ],
  })
  class GatewayDoors {}
  // main.ts's own layers, the body parsers included: the gateway has to get codex's body unread past them.
  const app = await NestFactory.create(GatewayDoors, { bodyParser: false, logger: false, abortOnError: false });
  app.use(outsideThePoolGateway(json({ limit: '10mb' })));
  app.use(outsideThePoolGateway(urlencoded({ extended: true, limit: '10mb' })));
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  t.after(async () => {
    await app.close();
    await new Promise((resolve) => openai.close(resolve));
    await db.$disconnect();
    await client.end();
  });

  /** Codex's recorded request, sent with `token`. */
  const ask = (token: string | null, method = 'POST', urlPath = '/api/gw/codex/responses') =>
    exchange(base, method, urlPath, codexHeaders(token), method === 'GET' ? undefined : RECORDED_BODY);

  /** The runner asking for work — which has to be `sessionId` — leaving it RUNNING or parked, as a turn would. */
  async function claim(who: Person, sessionId: string, park = true): Promise<ClaimedSession> {
    // A failed run is revived as AutoRetryService's resume revives it: PENDING, and the cancel cleared.
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.PENDING, cancelRequestedAt: null } });
    const claimed = await queue.claimSessionForRunner({ id: who.runnerId }, 0, false, false);
    assert.ok(claimed, 'the runner was offered no session');
    assert.equal(claimed.sessionId, sessionId);
    if (park) await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.AWAITING_INPUT } });
    return claimed;
  }
  const tokenOf = (claimed: ClaimedSession) => claimed.agent.env!.OPENAI_API_KEY!;
  const sessionRow = (sessionId: string) =>
    db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        ownerId: true, provider: true, poolKeyId: true, poolCodexAccountId: true,
        poolSwitchNotice: true, retryAt: true, status: true,
      },
    });
  const keyRow = (keyId: string) => db.poolApiKey.findUniqueOrThrow({ where: { id: keyId }, select: { state: true, spentUntil: true, throttledUntil: true } });
  const carriers = (sessionId: string) =>
    db.conversationTurn.findMany({ where: { sessionId, kind: 'reload' }, select: { content: true, status: true } });
  const dequeue = (who: Person, sessionId: string) =>
    (runnerApi as unknown as {
      dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: string | null): Promise<
        { turnId: string; kind: string; env?: Record<string, string> } | null
      >;
    }).dequeueTurn(sessionId, who.runnerId, null);

  const ann = await person(db, 'Ann');
  const mia = await person(db, 'Mia');
  const max = await person(db, 'Max');

  /** A shared pool of Ann's, with Mia and Max in it and the keys given, each as its label names it. */
  async function world(label: string, keys: Array<{ by: Person; label: string; shareCap?: number }>) {
    const made = await pools.create(ann.id, { label });
    await pools.addPerson(ann.id, made.id, { email: mia.email });
    await pools.addPerson(ann.id, made.id, { email: max.email });
    const byLabel: Record<string, { id: string; secret: string }> = {};
    for (const key of keys) {
      const secret = openaiKey();
      await pools.addKey(key.by.id, made.id, { label: key.label, apiKey: secret, shareCap: key.shareCap });
      const row = await db.poolApiKey.findFirstOrThrow({ where: { poolId: made.id, label: key.label }, select: { id: true } });
      byLabel[key.label] = { id: row.id, secret };
    }
    const sessionOf = async (who: Person) =>
      (await sessions.create(who.id, { prompt: 'hello', title: label, workspaceId: who.workspaceId, provider: made.slug })).id;
    return { id: made.id, slug: made.slug, label, keys: byLabel, sessionOf };
  }

  await t.test('(1) a recorded codex request reaches OpenAI as codex sent it, on the key its claim chose, and the stream comes back byte for byte', async () => {
    const pool = await world('Replay', [{ by: ann, label: 'orbit-org-1' }, { by: mia, label: 'orbit-org-2', shareCap: 10 }]);
    const session = await pool.sessionOf(mia);
    const token = tokenOf(await claim(mia, session));
    // Her own key first.
    assert.equal((await sessionRow(session)).poolKeyId, pool.keys['orbit-org-2'].id);

    seen.length = 0;
    const answer = await ask(token);
    assert.equal(answer.status, 200, answer.body.toString('utf8'));
    assert.equal(answer.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(answer.headers['x-request-id'], 'req_recorded');
    assert.ok(answer.body.equals(RECORDED_STREAM), 'the stream codex got back is not the stream OpenAI sent');

    const [upstream, ...more] = seen;
    assert.deepEqual(more, [], 'one request from codex is one request to OpenAI');
    assert.equal(upstream.method, 'POST');
    assert.equal(upstream.url, '/v1/responses');
    assert.ok(upstream.body.equals(RECORDED_BODY), "the body OpenAI got is not the body codex sent");
    // Every header codex sent, as it sent it, but the credential: her key, not the session token.
    for (const [name, value] of Object.entries(codexHeaders(null))) {
      assert.equal(upstream.headers[name], value, `codex's ${name} header did not arrive as sent`);
    }
    assert.equal(upstream.headers.authorization, `Bearer ${pool.keys['orbit-org-2'].secret}`);
    assert.equal(upstream.headers['content-length'], String(RECORDED_BODY.length));
    const transport = new Set(['host', 'connection']);
    const extra = Object.keys(upstream.headers).filter(
      (name) => !(name in codexHeaders(null)) && name !== 'authorization' && name !== 'content-length' && !transport.has(name),
    );
    assert.deepEqual(extra, [], 'the gateway added headers codex did not send');
    assert.ok(!JSON.stringify(upstream.headers).includes(token), 'the session token went on to OpenAI');

    // Its use, priced at the model's price, for her and her key.
    await ledger.flush();
    const row = await db.poolUsage.findUniqueOrThrow({
      where: {
        keyId_userId_windowStart: { keyId: pool.keys['orbit-org-2'].id, userId: mia.id, windowStart: usageWindowStart(new Date()) },
      },
    });
    assert.equal(RECORDED_MODEL, 'gpt-5.1-codex');
    // gpt-5.1-codex: $1.25 a million uncached input, $0.125 cached, $10 output — so that many micro-dollars a token.
    const cost = Math.round((RECORDED_USAGE.input - RECORDED_USAGE.cached) * 1.25 + RECORDED_USAGE.cached * 0.125 + RECORDED_USAGE.output * 10);
    assert.deepEqual(
      { input: row.inputTokens, output: row.outputTokens, cost: row.costMicros, pool: row.poolId },
      { input: BigInt(RECORDED_USAGE.input), output: BigInt(RECORDED_USAGE.output), cost: BigInt(cost), pool: pool.id },
    );
  });

  await t.test('(2) a token is refused once its session ended, its person was removed, its pool deleted, it expired or was revoked, or its session moved — and a good one reaches nothing but POST /responses', async () => {
    const pool = await world('Doors', [{ by: ann, label: 'orbit-org-1' }]);
    const refused = async (token: string | null, why: string) => {
      const answer = await ask(token);
      assert.equal(answer.status, 401, why);
      assert.equal(errorOf(answer).code, 'orbit_gateway_token_invalid', why);
    };
    seen.length = 0;
    await refused(null, 'no credential at all');
    await refused(`orbit-gw-${hex()}${hex()}`, 'a token nobody minted');

    // A good token first, so each refusal below is the event's doing.
    const maxSession = await pool.sessionOf(max);
    let token = tokenOf(await claim(max, maxSession));
    assert.equal((await ask(token)).status, 200);
    seen.length = 0;

    // Outside the path list: refused, whatever the token.
    for (const [method, urlPath] of [
      ['GET', '/api/gw/codex/responses'],
      ['POST', '/api/gw/codex/models'],
      ['GET', '/api/gw/codex/models'],
      ['POST', '/api/gw/codex/responses/compact'],
      ['POST', '/api/gw/codex/chat/completions'],
      ['POST', '/api/gw/codex/v1/responses'],
      ['POST', '/api/gw/codex'],
    ] as const) {
      const answer = await ask(token, method, urlPath);
      assert.equal(answer.status, 403, `${method} ${urlPath}`);
      assert.equal(errorOf(answer).code, 'orbit_gateway_path_not_allowed', `${method} ${urlPath}`);
    }
    assert.equal(seen.length, 0, 'a refused request reached OpenAI');

    // The session ends.
    await db.session.update({ where: { id: maxSession }, data: { status: RunStatus.CANCELLED } });
    await refused(token, 'the session ended');
    await db.session.update({ where: { id: maxSession }, data: { status: RunStatus.AWAITING_INPUT, completedAt: new Date() } });
    await refused(token, 'the session was completed');
    await db.session.update({ where: { id: maxSession }, data: { completedAt: null } });
    assert.equal((await ask(token)).status, 200, 'an open session again: its token is good again');

    // The session moves to another provider: its tokens name a pool it no longer runs on.
    await db.session.update({ where: { id: maxSession }, data: { provider: 'codex', providerBuiltin: true } });
    await refused(token, 'the session moved to another provider');
    await db.session.update({ where: { id: maxSession }, data: { provider: pool.slug, providerBuiltin: false } });

    // Expired, and revoked.
    token = tokenOf(await claim(max, maxSession));
    await db.poolGatewayToken.updateMany({ where: { sessionId: maxSession }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await refused(token, 'the token expired');
    token = tokenOf(await claim(max, maxSession));
    await db.poolGatewayToken.updateMany({ where: { sessionId: maxSession }, data: { revokedAt: new Date() } });
    await refused(token, 'the token was revoked');

    // The person is removed from the pool.
    token = tokenOf(await claim(max, maxSession));
    assert.equal((await ask(token)).status, 200);
    await pools.removePerson(ann.id, pool.id, max.id);
    await refused(token, 'its person was removed from the pool');

    // The pool is deleted.
    const miaSession = await pool.sessionOf(mia);
    const miaToken = tokenOf(await claim(mia, miaSession));
    assert.equal((await ask(miaToken)).status, 200);
    await pools.remove(ann.id, pool.id);
    await refused(miaToken, 'its pool was deleted');
  });

  await t.test('(3) insufficient_quota: the key is out of budget at once, the turn goes again now, and the next claim moves to another key and says why — on a resident engine too', async () => {
    const pool = await world('Quota', [{ by: ann, label: 'orbit-org-1' }, { by: mia, label: 'orbit-org-2', shareCap: 10 }]);
    const [first, second] = [pool.keys['orbit-org-1'], pool.keys['orbit-org-2']];
    const session = await pool.sessionOf(max);
    // Max has no key: the most room is Ann's, which has no cap.
    const token = tokenOf(await claim(max, session, false));
    assert.equal((await sessionRow(session)).poolKeyId, first.id);

    const refusal = openAIError(429, {
      message: 'You exceeded your current quota, please check your plan and billing details.',
      type: 'insufficient_quota',
      code: 'insufficient_quota',
    });
    script.push(refusal);
    seen.length = 0;
    const before = new Date();
    const answer = await ask(token);
    assert.equal(answer.status, 429);
    assert.ok(answer.body.equals(refusal.body), "OpenAI's answer did not go back as it came");
    assert.equal(seen.length, 1, 'a spent budget is not asked again');
    assert.equal(seen[0].headers.authorization, `Bearer ${first.secret}`);
    // A spent budget is not a rate limit: the throttle stays unset.
    assert.deepEqual(await keyRow(first.id), { state: 'ACTIVE', spentUntil: nextUsageWindowStart(before), throttledUntil: null });

    // The turn it ended fails, as codex reports it, and is armed to go again now: another key has room.
    const turn = await dequeue(max, session);
    assert.equal(turn?.kind, 'message');
    await runnerApi.turnComplete({ id: max.runnerId }, session, {
      turnId: turn!.turnId,
      status: 'FAILED' as TurnCompleteRequest['status'],
      result: 'Quota exceeded. Check your plan and billing details.',
      numTurns: 0,
      costUsd: 0,
    });
    const failed = await sessionRow(session);
    assert.equal(failed.status, RunStatus.FAILED);
    assert.ok(failed.retryAt, 'no retry was armed for a turn a spent key ended');
    assert.ok(failed.retryAt!.getTime() >= before.getTime() && failed.retryAt!.getTime() <= Date.now() + 61_000,
      `the retry is not now: ${failed.retryAt!.toISOString()}`);
    const at = new Date();
    assert.deepEqual(await queue.accountPoolResumesAt(max.id, pool.slug, at), at, 'the pool resumes now: another key has room');

    // The next claim moves the session to Mia's key and owes the transcript the reason.
    const line = 'Switched to orbit-org-2 — orbit-org-1 is out of budget';
    const next = tokenOf(await claim(max, session, false));
    const moved = await sessionRow(session);
    assert.equal(moved.poolKeyId, second.id);
    assert.equal(moved.poolSwitchNotice, line);
    assert.equal(await db.runEvent.count({ where: { sessionId: session } }), 0, 'the claim wrote into the event stream');
    // A resident engine starts nothing: the claim queued a reload that changes nothing, delivered first,
    // with no environment — so the engine answers it with a `resumed` and is not re-spawned.
    assert.deepEqual(await carriers(session), [{ content: '{}', status: 'PENDING' }]);
    const carrier = await dequeue(max, session);
    assert.equal(carrier?.kind, 'reload');
    assert.equal(carrier?.env, undefined);
    await runnerApi.events({ id: max.runnerId }, session, {
      events: [{
        seq: 1,
        type: RunEventType.SYSTEM,
        ts: new Date().toISOString(),
        payload: { subtype: 'resumed', reason: 'config_changed', runtime: 'app-server' },
      }],
    });
    const [said] = await db.runEvent.findMany({ where: { sessionId: session }, select: { payload: true } });
    assert.equal((said.payload as { notice?: string }).notice, line);
    assert.equal((await sessionRow(session)).poolSwitchNotice, null, 'the line is owed once');

    // Codex's next request goes out on the new key.
    seen.length = 0;
    assert.equal((await ask(next)).status, 200);
    assert.equal(seen[0].headers.authorization, `Bearer ${second.secret}`);
  });

  await t.test('(4) a 401 from OpenAI marks the key invalid, answers with the reason and none of OpenAI\'s words about the key, and the next claim moves', async () => {
    const pool = await world('Refused', [{ by: ann, label: 'orbit-org-1' }, { by: mia, label: 'orbit-org-2' }]);
    const [first, second] = [pool.keys['orbit-org-1'], pool.keys['orbit-org-2']];
    const session = await pool.sessionOf(max);
    const token = tokenOf(await claim(max, session));
    // Equal room (no caps): the lower id.
    const on = (await sessionRow(session)).poolKeyId!;
    const [chosen, other] = on === first.id ? [first, second] : [second, first];
    const [chosenLabel, otherLabel] = on === first.id ? ['orbit-org-1', 'orbit-org-2'] : ['orbit-org-2', 'orbit-org-1'];

    script.push(openAIError(401, {
      message: `Incorrect API key provided: ${chosen.secret.slice(0, 12)}****${chosen.secret.slice(-4)}. You can find your API key at https://platform.openai.com/account/api-keys.`,
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    }));
    seen.length = 0;
    const answer = await ask(token);
    assert.equal(answer.status, 403);
    const error = errorOf(answer);
    assert.equal(error.code, 'orbit_pool_key_rejected');
    assert.match(error.message, new RegExp(`^${chosenLabel} \\(sk-…${chosen.secret.slice(-4)}\\) was rejected by OpenAI`));
    assert.ok(!answer.body.toString('utf8').includes(chosen.secret.slice(0, 12)), "OpenAI's words about the key reached the member");
    assert.ok(!answer.body.toString('utf8').includes('Incorrect API key'), "OpenAI's words about the key reached the member");
    assert.equal((await keyRow(chosen.id)).state, 'INVALID');

    // Nothing more goes out on it: codex's own retries are answered here.
    seen.length = 0;
    const again = await ask(token);
    assert.equal(again.status, 403);
    assert.equal(errorOf(again).code, 'orbit_pool_key_unavailable');
    assert.match(errorOf(again).message, /was rejected by OpenAI — your next turn moves to another key$/);
    assert.equal(seen.length, 0, 'the refusal reached OpenAI');
    const at = new Date();
    assert.deepEqual(
      await queue.sharedPoolRetryAt(db, await sessionRow(session), at),
      at,
      'the turn a refused key ended goes again now, on the other key',
    );

    const next = tokenOf(await claim(max, session));
    assert.deepEqual(
      { key: (await sessionRow(session)).poolKeyId, line: (await sessionRow(session)).poolSwitchNotice },
      { key: other.id, line: `Switched to ${otherLabel} — ${chosenLabel} was rejected by OpenAI` },
    );
    seen.length = 0;
    assert.equal((await ask(next)).status, 200);
    assert.equal(seen[0].headers.authorization, `Bearer ${other.secret}`);
  });

  await t.test('(5) a rate limit is waited out on the same key; one that outlasts the wait is held against it, and the next claim moves', async () => {
    const pool = await world('Limits', [{ by: ann, label: 'orbit-org-1' }, { by: mia, label: 'orbit-org-2', shareCap: 10 }]);
    const first = pool.keys['orbit-org-1'];
    const session = await pool.sessionOf(max);
    const token = tokenOf(await claim(max, session));
    assert.equal((await sessionRow(session)).poolKeyId, first.id, 'on the uncapped key, with another key there to jump to');
    const limited = () => openAIError(
      429,
      { message: 'Rate limit reached for gpt-5.1-codex on tokens per min (TPM). Please try again in 200ms.', type: 'tokens', code: 'rate_limit_exceeded' },
      { 'retry-after-ms': '200' },
    );

    // Twice limited, then through: codex gets the stream, and every send was on the same key.
    script.push(limited(), limited());
    seen.length = 0;
    const started = Date.now();
    const answer = await ask(token);
    assert.equal(answer.status, 200);
    assert.ok(answer.body.equals(RECORDED_STREAM));
    assert.ok(Date.now() - started >= 400, 'the waits OpenAI asked for were not kept');
    assert.equal(seen.length, 3);
    for (const sent of seen) {
      assert.equal(sent.headers.authorization, `Bearer ${first.secret}`, 'a rate limit moved the request to another key');
      assert.ok(sent.body.equals(RECORDED_BODY));
    }

    // Limited throughout: answered as OpenAI answered, after the attempts the gateway allows.
    const last = limited();
    script.push(limited(), limited(), limited(), last);
    seen.length = 0;
    const exhausted = await ask(token);
    assert.equal(exhausted.status, 429);
    assert.ok(exhausted.body.equals(last.body));
    assert.equal(seen.length, 4);
    assert.ok(seen.every((sent) => sent.headers.authorization === `Bearer ${first.secret}`));

    // A wait longer than the gateway may hold codex: answered at once.
    script.push(openAIError(429, { message: 'slow down', code: 'rate_limit_exceeded' }, { 'retry-after': '30' }));
    seen.length = 0;
    assert.equal((await ask(token)).status, 429);
    assert.equal(seen.length, 1);

    // Both 429s above exhausted the gateway's own wait, so the key is held against new claims until the
    // mark passes (migration 0382) — and it is that mark, not a budget: `spent_until` is untouched.
    const held = await keyRow(first.id);
    assert.deepEqual({ state: held.state, spentUntil: held.spentUntil }, { state: 'ACTIVE', spentUntil: null });
    assert.ok(held.throttledUntil !== null, 'the key is held out');
    const marked = held.throttledUntil!.getTime() - Date.now();
    assert.ok(marked > 0 && marked <= 60_000, `expected the minute floor, got ${marked}ms`);
    // The pool answers for it, and the other key can run: work goes now, and the next claim moves there.
    const at = await queue.sharedPoolRetryAt(db, await sessionRow(session), new Date());
    assert.ok(at !== null && at.getTime() - Date.now() < 5_000, 'another key can run, so work goes now');
    await claim(max, session);
    assert.deepEqual(
      { key: (await sessionRow(session)).poolKeyId, line: (await sessionRow(session)).poolSwitchNotice },
      { key: pool.keys['orbit-org-2'].id, line: 'Switched to orbit-org-2 — orbit-org-1 is rate limited right now' },
    );
    assert.deepEqual(await carriers(session), []);
  });

  await t.test('(6) own key first; the others held to a share cap — by the gateway the moment it is spent, and by the claim — its contributor never', async () => {
    const pool = await world('Caps', [{ by: ann, label: 'orbit-org-1' }, { by: mia, label: 'orbit-org-2', shareCap: 1 }]);
    const [annKey, miaKey] = [pool.keys['orbit-org-1'], pool.keys['orbit-org-2']];
    const miaSession = await pool.sessionOf(mia);
    const miaToken = tokenOf(await claim(mia, miaSession));
    assert.equal((await sessionRow(miaSession)).poolKeyId, miaKey.id, "Mia's own key first");
    const maxSession = await pool.sessionOf(max);
    await claim(max, maxSession);
    assert.equal((await sessionRow(maxSession)).poolKeyId, annKey.id, 'Max: the most room, which is the uncapped key');

    // Ann switches hers off: Max's next claim moves to Mia's, $1 a month for the others.
    await pools.updateKey(ann.id, pool.id, annKey.id, { enabled: false });
    const maxToken = tokenOf(await claim(max, maxSession));
    assert.deepEqual(
      { key: (await sessionRow(maxSession)).poolKeyId, line: (await sessionRow(maxSession)).poolSwitchNotice },
      { key: miaKey.id, line: 'Switched to orbit-org-2 — orbit-org-1 is disabled' },
    );

    // One answer spends the whole cap: 100,000 output tokens at $10 a million.
    script.push(streamWith('gpt-5.1-codex', { input: 0, cached: 0, output: 100_000 }));
    assert.equal((await ask(maxToken)).status, 200);
    // Not written yet — and the gateway holds Max to it already.
    assert.equal(await db.poolUsage.count({ where: { keyId: miaKey.id } }), 0);
    seen.length = 0;
    const held = await ask(maxToken);
    assert.equal(held.status, 403);
    assert.equal(errorOf(held).code, 'orbit_pool_key_unavailable');
    const reopens = nextUsageWindowStart(new Date()).toISOString().slice(0, 16).replace('T', ' ');
    assert.equal(
      errorOf(held).message,
      `orbit-org-2 (sk-…${miaKey.secret.slice(-4)}) is out of budget — no key of "Caps" can run for you until ${reopens} UTC`,
    );
    assert.equal(seen.length, 0, 'the refusal reached OpenAI');
    // Mia herself is never capped on her own key.
    assert.equal((await ask(miaToken)).status, 200);
    assert.equal(seen.at(-1)?.headers.authorization, `Bearer ${miaKey.secret}`);

    // Written, the claim holds him to it too: no key can run for him, so he stays where he was, and
    // the pool resumes for him on the first of next month.
    await ledger.flush();
    await claim(max, maxSession);
    assert.equal((await sessionRow(maxSession)).poolKeyId, miaKey.id);
    assert.deepEqual(await queue.accountPoolResumesAt(max.id, pool.slug, new Date()), nextUsageWindowStart(new Date()));
    const at = new Date();
    assert.deepEqual(await queue.accountPoolResumesAt(mia.id, pool.slug, at), at, 'her own key still runs for her');

    // Ann's back on: the next claim moves him there, and says why he left Mia's.
    await pools.updateKey(ann.id, pool.id, annKey.id, { enabled: true });
    await claim(max, maxSession);
    assert.deepEqual(
      { key: (await sessionRow(maxSession)).poolKeyId, line: (await sessionRow(maxSession)).poolSwitchNotice },
      { key: annKey.id, line: 'Switched to orbit-org-1 — orbit-org-2 is out of budget' },
    );
  });

  await t.test('(7) the ledger: per person and per key, summed, in one write — a row whose key was removed first is dropped, not an error', async () => {
    const pool = await world('Ledger', [{ by: ann, label: 'orbit-org-1' }, { by: ann, label: 'orbit-org-9' }]);
    const key = pool.keys['orbit-org-1'];
    const maxSession = await pool.sessionOf(max);
    const miaSession = await pool.sessionOf(mia);
    const maxToken = tokenOf(await claim(max, maxSession));
    const miaToken = tokenOf(await claim(mia, miaSession));
    // Neither has a key of their own here: equal room, the lower id, for both.
    const on = (await sessionRow(maxSession)).poolKeyId!;
    assert.equal((await sessionRow(miaSession)).poolKeyId, on);
    script.push(streamWith('gpt-5', { input: 1000, cached: 400, output: 100 }), streamWith('gpt-5', { input: 2000, cached: 0, output: 50 }));
    script.push(streamWith('gpt-5', { input: 10, cached: 0, output: 1 }));
    assert.equal((await ask(maxToken)).status, 200);
    assert.equal((await ask(maxToken)).status, 200);
    assert.equal((await ask(miaToken)).status, 200);
    await ledger.flush();
    const rows = await db.poolUsage.findMany({ where: { poolId: pool.id }, orderBy: { userId: 'asc' } });
    const price = (i: number, c: number, o: number) => BigInt(Math.round((i - c) * 1.25 + c * 0.125 + o * 10));
    assert.deepEqual(
      rows.map((row) => ({ key: row.keyId, user: row.userId, input: row.inputTokens, output: row.outputTokens, cost: row.costMicros })),
      [
        { key: on, user: max.id, input: 3000n, output: 150n, cost: price(1000, 400, 100) + price(2000, 0, 50) },
        { key: on, user: mia.id, input: 10n, output: 1n, cost: price(10, 0, 1) },
      ].sort((a, b) => (a.user < b.user ? -1 : 1)),
    );

    // Used, then removed before the write: its row is dropped; the rest of the batch is written.
    const other = on === key.id ? pool.keys['orbit-org-9'] : key;
    const now = new Date();
    ledger.record({ poolId: pool.id, keyId: on, userId: max.id, inputTokens: 5, outputTokens: 5, costMicros: 5, at: now });
    ledger.record({ poolId: pool.id, keyId: other.id, userId: max.id, inputTokens: 7, outputTokens: 7, costMicros: 7, at: now });
    await pools.removeKey(ann.id, pool.id, on);
    await ledger.flush();
    assert.deepEqual(
      (await db.poolUsage.findMany({ where: { poolId: pool.id } })).map((row) => [row.keyId, row.userId, row.costMicros]),
      [[other.id, max.id, 7n]],
    );
    assert.equal(ledger.pendingOthersCostMicros(on, ann.id, usageWindowStart(now)), 0, 'the dropped row was kept to be tried again');
  });

  await t.test('(8) a key marked out of budget is still asked while a session is on it, and a request it takes clears the mark; with every key spent the pool resumes at the first reset', async () => {
    const pool = await world('Budget', [{ by: ann, label: 'orbit-org-1' }]);
    const key = pool.keys['orbit-org-1'];
    const session = await pool.sessionOf(max);
    const token = tokenOf(await claim(max, session));
    script.push(openAIError(429, { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' }));
    assert.equal((await ask(token)).status, 429);
    const reset = nextUsageWindowStart(new Date());
    assert.deepEqual(await keyRow(key.id), { state: 'ACTIVE', spentUntil: reset, throttledUntil: null });
    // Every key spent: the work waits for the first reset, and nothing moves the session meanwhile.
    assert.deepEqual(await queue.accountPoolResumesAt(max.id, pool.slug, new Date()), reset);
    assert.deepEqual(await queue.sharedPoolRetryAt(db, await sessionRow(session), new Date()), reset);
    await claim(max, session);
    assert.deepEqual(
      { key: (await sessionRow(session)).poolKeyId, line: (await sessionRow(session)).poolSwitchNotice },
      { key: key.id, line: null },
    );

    // The organization tops up: OpenAI takes the next request on it, and the mark goes.
    seen.length = 0;
    assert.equal((await ask(token)).status, 200);
    assert.equal(seen.length, 1);
    for (let polls = 0; polls < 50 && (await keyRow(key.id)).spentUntil; polls += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(await keyRow(key.id), { state: 'ACTIVE', spentUntil: null, throttledUntil: null });
    assert.deepEqual(await queue.sharedPoolRetryAt(db, await sessionRow(session), new Date()), null);
  });
});
