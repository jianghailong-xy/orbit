/**
 * What the /api/gw/anthropic gateway writes on an OpenAI key's row when OpenAI refuses it or says its budget is
 * spent (docs/claude-engine-openai-gateway-design.md §5.4, migration 0520), on real PostgreSQL. The key is made
 * by ProvidersService.create, the session claimed by QueueService (which mints the token), and the real controller
 * answers behind Nest; a scripted stand-in answers for OpenAI.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/providers/key-gateway-errors.pg.spec.ts
 *
 * The key's endpoint is OpenAI's own, https://api.openai.com/v1, and passes the upstream guard (gateway-upstream.ts)
 * as any key does: its name resolves (`resolveHost`, answered with a public address) and the gateway's agent opens
 * the pinned connection, which here reaches the stand-in in plain HTTP, as gateway-upstream.spec.ts does.
 *
 *  (1) A 401 marks the key INVALID (`key_check_state`, `key_checked_at`); the next turn is refused without asking
 *      OpenAI; a new secret clears the mark.
 *  (2) insufficient_quota sets `spent_until` to the reset OpenAI names; the next answered request clears it, and
 *      so does a new secret.
 *
 * It only adds rows, and refuses to run anywhere but the disposable server `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import net, { type AddressInfo, type Socket } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { DisabledAccounts } from '../auth/disabled-accounts';
import { generateToken, sha256 } from '../common/crypto.util';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { AnthropicGatewayController } from './anthropic-gateway.controller';
import { AnthropicLoginGatewayService } from './anthropic-login-gateway.service';
import { AnthropicGatewayService } from './anthropic-gateway.service';
import { ANTHROPIC_GATEWAY_FLAG } from './key-gateway';
import { ProviderPlanUsageService } from './plan-usage.service';
import { ProvidersService } from './providers.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'key-gateway-errors-pg-spec';
process.env.PUBLIC_ORIGIN = 'https://orbit.key-gateway-errors-pg.invalid';
process.env[ANTHROPIC_GATEWAY_FLAG] = 'true';

const realtime = new Proxy(
  {},
  { get: (_target, key) => (key === 'then' ? undefined : () => undefined) },
) as RealtimeService;

/** The turn Claude Code 2.1.322 sent (P0 recording), streamed. */
const BASIC = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../src/providers/fixtures/claude-cli-2.1.322/basic.json'), 'utf8'),
) as { requests: Array<{ method: string; path: string; body?: unknown }> };
const TURN = Buffer.from(JSON.stringify({
  ...(BASIC.requests.find((r) => r.method === 'POST')!.body as Record<string, unknown>),
  stream: true,
}));

const STREAM = [
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.1' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
  { type: 'response.output_text.delta', output_index: 0, delta: 'Hello' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
  { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.1', status: 'completed', usage: { input_tokens: 7, output_tokens: 1 }, output: [] } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

type Reply = 'ok' | { status: number; headers?: Record<string, string>; error: { code: string; type: string; message: string } };

function exchange(base: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/gw/anthropic/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01',
        'content-length': String(TURN.length),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.end(TURN);
  });
}

const suite = URL ? test : test.skip;

suite('the gateway\'s writes on an OpenAI key, on real PostgreSQL', { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db: PrismaClient = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const sessions = new SessionsService(prisma, queue, realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const disabledAccounts = new DisabledAccounts(prisma);
  await disabledAccounts.onModuleInit();

  // OpenAI, as far as the gateway can tell: answers what `reply` says, and counts the requests.
  let reply: Reply = 'ok';
  let asked = 0;
  const upstream: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      asked += 1;
      if (reply === 'ok') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.end(STREAM);
        return;
      }
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      res.end(JSON.stringify({ error: { ...reply.error, param: null } }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const gateway = new AnthropicGatewayService(prisma, disabledAccounts);
  gateway.resolveHost = async (host) => {
    assert.equal(host, 'api.openai.com');
    return [{ address: '162.159.140.245', family: 4 }];
  };
  gateway.agent = new (class extends HttpsAgent {
    override createConnection(): Socket {
      return net.connect(upstreamPort, '127.0.0.1');
    }
  })();
  @Module({ controllers: [AnthropicGatewayController], providers: [{ provide: AnthropicGatewayService, useValue: gateway },
      // The login pools' upstream (design §9): present, and never reached by a key's token.
      { provide: AnthropicLoginGatewayService, useValue: {} }] })
  class GatewayDoors {}
  const app = await NestFactory.create(GatewayDoors, { bodyParser: false, logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  t.after(async () => {
    await app.close();
    await new Promise((resolve) => upstream.close(resolve));
    disabledAccounts.onModuleDestroy();
    await db.$disconnect();
    await client.end();
  });

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `ann-${ownerId}@key-gateway-errors-pg.invalid`, name: 'Ann', passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'ann-runner', tokenHash: sha256(generateToken(32)),
      status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'ann-agent', enabled: true, workDir: '/tmp/ann' } });

  const secret = () => `sk-proj-${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;

  /** One of Ann's OpenAI keys on OpenAI's own endpoint, made by the real door. */
  async function openaiKey(label: string): Promise<{ id: string; slug: string }> {
    return await providers.create(ownerId, {
      label, runtime: 'codex', baseUrl: 'https://api.openai.com/v1', apiKey: secret(), presetSlug: 'openai', followsPreset: true,
    }) as { id: string; slug: string };
  }

  /** A Claude Code session on `slug`, claimed by Ann's runner: the gateway token its engine was handed. */
  async function claimedToken(slug: string): Promise<string> {
    const sessionId = (await sessions.create(ownerId, {
      prompt: 'hello', title: slug, workspaceId, provider: slug, engine: 'claude', model: 'gpt-5.1',
    } as never)).id;
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.PENDING, cancelRequestedAt: null } });
    const claimed = await queue.claimSessionForRunner({ id: runnerId });
    assert.ok(claimed, 'the runner was offered no session');
    assert.equal(claimed.sessionId, sessionId);
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.AWAITING_INPUT } });
    const token = claimed.agent.env!.ANTHROPIC_AUTH_TOKEN;
    assert.match(token, /^orbit-gwk-/);
    return token;
  }

  /**
   * The key row's three columns this gateway writes, as PostgreSQL holds them. They are TIMESTAMP(3) without a
   * zone, in which Prisma stores UTC; read as UTC, since `pg` would take a zoneless timestamp for local time.
   */
  async function row(id: string): Promise<{ key_check_state: string | null; key_checked_at: Date | null; spent_until: Date | null }> {
    const { rows } = await client.query(
      `SELECT key_check_state, key_checked_at AT TIME ZONE 'UTC' AS key_checked_at, spent_until AT TIME ZONE 'UTC' AS spent_until
         FROM model_provider WHERE id = $1`, [id]);
    assert.equal(rows.length, 1);
    return rows[0];
  }

  /** The clear after an answered request is written once the answer is out: wait for it, briefly. */
  async function eventually(id: string, check: (r: Awaited<ReturnType<typeof row>>) => boolean, what: string): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      if (check(await row(id))) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`${what}: ${JSON.stringify(await row(id))}`);
  }

  await t.test('(1) a 401 marks the key INVALID; the next turn is refused unasked; a new secret clears the mark', async () => {
    const key = await openaiKey('Refused');
    const token = await claimedToken(key.slug);
    assert.deepEqual(await row(key.id), { key_check_state: null, key_checked_at: null, spent_until: null });

    reply = { status: 401, error: { code: 'invalid_api_key', type: 'invalid_request_error', message: 'Incorrect API key provided.' } };
    const before = asked;
    const refused = await exchange(base, token);
    assert.equal(refused.status, 401, refused.body);
    assert.equal(JSON.parse(refused.body).error.type, 'authentication_error');
    const marked = await row(key.id);
    assert.equal(marked.key_check_state, 'INVALID');
    assert.ok(marked.key_checked_at instanceof Date && Math.abs(marked.key_checked_at.getTime() - Date.now()) < 60_000);
    assert.equal(asked, before + 1);

    reply = 'ok';
    const again = await exchange(base, token);
    assert.equal(again.status, 401, 'a key marked INVALID is refused');
    assert.equal(asked, before + 1, 'OpenAI was asked again with a key it refused');

    await providers.update(ownerId, key.id, { apiKey: secret() });
    assert.deepEqual(await row(key.id), { key_check_state: null, key_checked_at: null, spent_until: null });
    const fresh = await exchange(base, await claimedToken(key.slug));
    assert.equal(fresh.status, 200, fresh.body);
  });

  await t.test('(2) insufficient_quota sets spent_until to the reset; an answered request clears it, and so does a new secret', async () => {
    const key = await openaiKey('Spent');
    const token = await claimedToken(key.slug);
    reply = {
      status: 429,
      headers: { 'retry-after': '7200' },
      error: { code: 'insufficient_quota', type: 'insufficient_quota', message: 'You exceeded your current quota.' },
    };
    const started = Date.now();
    const spent = await exchange(base, token);
    assert.equal(spent.status, 429, spent.body);
    assert.match(JSON.parse(spent.body).error.message, /^You hit your usage limit on the OpenAI key "Spent" · resets /);
    const until = (await row(key.id)).spent_until;
    assert.ok(until instanceof Date, 'spent_until was not written');
    assert.ok(Math.abs(until.getTime() - (started + 7_200_000)) < 60_000, `spent until ${until.toISOString()}, not the reset OpenAI named`);
    assert.equal((await row(key.id)).key_check_state, null, 'a spent budget is not a refused key');

    reply = 'ok';
    const answered = await exchange(base, token);
    assert.equal(answered.status, 200, answered.body);
    await eventually(key.id, (r) => r.spent_until === null, 'an answered request did not clear spent_until');

    reply = {
      status: 429,
      error: { code: 'insufficient_quota', type: 'insufficient_quota', message: 'You exceeded your current quota.' },
    };
    assert.equal((await exchange(base, token)).status, 429);
    const monthly = (await row(key.id)).spent_until;
    // No reset named: the first of next month, as the pool gateway reads it (spentUntil).
    assert.ok(monthly instanceof Date && monthly.getTime() > Date.now());
    await providers.update(ownerId, key.id, { apiKey: secret() });
    assert.equal((await row(key.id)).spent_until, null, 'a new secret did not clear spent_until');
  });
});
