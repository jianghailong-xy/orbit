/**
 * `key_gateway_token` end to end on real PostgreSQL (docs/claude-engine-openai-gateway-design.md §4.2, §5.2):
 * Claude Code sessions on an OpenAI key, created and claimed by the real doors with the deployment flag on, and
 * the real /api/gw/anthropic controller behind main.ts's own layers, with a recorder standing where the key's
 * OpenAI endpoint stands.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/providers/key-gateway.pg.spec.ts
 *
 *  (1) The claim hands the engine the gateway and an `orbit-gwk-` token, and the table holds only its hash.
 *  (2) The token stops authenticating after each of: the session ended (SessionsService.end), the key disabled
 *      and the key given a new secret (ProvidersService.update, which revokes), the key deleted
 *      (ProvidersService.remove, which takes the row with it), and the account disabled
 *      (AdminController.setDisabled; 403, and good again once enabled). Each time, nothing reaches OpenAI.
 *
 * It only adds rows, and refuses to run anywhere but the disposable server `coordinator-pg-test-safety`
 * identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import net, { type AddressInfo, type Socket } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import type { ClaimedSession } from '@orbit/shared';
import { json, urlencoded } from 'express';
import { Client } from 'pg';

import { DisabledAccounts } from '../auth/disabled-accounts';
import type { AuthUser } from '../common/current-user.decorator';
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
import { AdminController } from '../users/admin.controller';
import { AnthropicGatewayController } from './anthropic-gateway.controller';
import { AnthropicLoginGatewayService } from './anthropic-login-gateway.service';
import { AnthropicGatewayService } from './anthropic-gateway.service';
import { ANTHROPIC_GATEWAY_FLAG } from './key-gateway';
import { ProviderPlanUsageService } from './plan-usage.service';
import { outsideThePoolGateway } from './pool-gateway.controller';
import { ProvidersService } from './providers.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'key-gateway-pg-spec';
process.env.PUBLIC_ORIGIN = 'https://orbit.key-gateway-pg.invalid';
process.env[ANTHROPIC_GATEWAY_FLAG] = 'true';

const realtime = new Proxy(
  {},
  { get: (_target, key) => (key === 'then' ? undefined : () => undefined) },
) as RealtimeService;

/** The turn Claude Code 2.1.322 sent (P0 recording), as this gateway is sent it. */
const BASIC = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../src/providers/fixtures/claude-cli-2.1.322/basic.json'), 'utf8'),
) as { requests: Array<{ method: string; path: string; body?: unknown }> };
const TURN = Buffer.from(JSON.stringify({
  ...(BASIC.requests.find((r) => r.method === 'POST')!.body as Record<string, unknown>),
  stream: true,
}));

/** A completed Responses stream, as OpenAI ends a turn. */
const STREAM = [
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.1' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
  { type: 'response.output_text.delta', output_index: 0, delta: 'Hello' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
  { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.1', status: 'completed', usage: { input_tokens: 7, output_tokens: 1 }, output: [] } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

interface Person {
  name: string;
  id: string;
  runnerId: string;
  workspaceId: string;
}

async function person(db: PrismaClient, name: string): Promise<Person> {
  const id = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({ data: { id, email: `${name}-${id}@key-gateway-pg.invalid`, name, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId: id, name: `${name}-runner`, tokenHash: sha256(generateToken(32)),
      status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId: id, runnerId, name: `${name}-agent`, enabled: true, workDir: `/tmp/${name}` },
  });
  return { name, id, runnerId, workspaceId };
}

function exchange(base: string, urlPath: string, token: string | null, body: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}${urlPath}`, {
      method: 'POST',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'content-length': String(body.length),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

const suite = URL ? test : test.skip;

suite('key_gateway_token, end to end on real PostgreSQL', { timeout: 600_000 }, async (t) => {
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
  const disabledAccounts = new DisabledAccounts(prisma);
  await disabledAccounts.onModuleInit();
  const admin = new AdminController(prisma, {} as never, {} as never, disabledAccounts);

  // The key's OpenAI endpoint, as far as the gateway can tell: every request recorded, each answered with a turn.
  const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  const upstream: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end(STREAM);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  // The keys stand on OpenAI's own endpoint, the one the upstream guard allows; the gateway resolves it to a
  // public address and its agent opens that connection to the recorder, in plain HTTP.
  const endpoint = 'https://api.openai.com/v1';
  const gateway = new AnthropicGatewayService(prisma, disabledAccounts);
  gateway.resolveHost = async (host) => {
    if (host !== 'api.openai.com') throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    return [{ address: '162.159.140.245', family: 4 }];
  };
  gateway.agent = new (class extends HttpsAgent {
    override createConnection(): Socket {
      return net.connect(upstreamPort, '127.0.0.1');
    }
  })();

  @Module({
    controllers: [AnthropicGatewayController],
    providers: [{ provide: AnthropicGatewayService, useValue: gateway },
      // The login pools' upstream (design §9): present, and never reached by a key's token.
      { provide: AnthropicLoginGatewayService, useValue: {} }],
  })
  class GatewayDoors {}
  const app = await NestFactory.create(GatewayDoors, { bodyParser: false, logger: false, abortOnError: false });
  app.use(outsideThePoolGateway(json({ limit: '10mb' })));
  app.use(outsideThePoolGateway(urlencoded({ extended: true, limit: '10mb' })));
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

  const root = await person(db, 'Root');
  await db.user.update({ where: { id: root.id }, data: { role: 'ADMIN' } });
  const administrator: AuthUser = { userId: root.id, email: `root@key-gateway-pg.invalid` };
  const ann = await person(db, 'Ann');

  /** One of Ann's OpenAI keys, from the `openai` preset, pointed at the recorder; its id, slug and secret. */
  async function openaiKey(label: string): Promise<{ id: string; slug: string; secret: string }> {
    const secret = `sk-proj-${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    const row = await providers.create(ann.id, {
      label, runtime: 'codex', baseUrl: endpoint, apiKey: secret, presetSlug: 'openai', followsPreset: true,
    }) as { id: string; slug: string };
    return { id: row.id, slug: row.slug, secret };
  }

  /** A Claude Code session of Ann's on `slug`, claimed by her runner: its id and what its engine was handed. */
  async function claudeSession(slug: string): Promise<{ sessionId: string; claimed: ClaimedSession }> {
    const sessionId = (await sessions.create(ann.id, {
      prompt: 'hello', title: slug, workspaceId: ann.workspaceId, provider: slug, engine: 'claude', model: 'gpt-5.1',
    } as never)).id;
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.PENDING, cancelRequestedAt: null } });
    const claimed = await queue.claimSessionForRunner({ id: ann.runnerId });
    assert.ok(claimed, 'the runner was offered no session');
    assert.equal(claimed.sessionId, sessionId);
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.AWAITING_INPUT } });
    return { sessionId, claimed };
  }

  const ask = (token: string) => exchange(base, '/api/gw/anthropic/v1/messages?beta=true', token, TURN);
  async function goesThrough(token: string, secret: string, why: string): Promise<void> {
    const before = seen.length;
    const answer = await ask(token);
    assert.equal(answer.status, 200, `${why}: ${answer.body}`);
    assert.match(answer.body, /event: message_start/, why);
    assert.equal(seen.length, before + 1, `${why}: one request in is one request upstream`);
    assert.equal(seen[before].url, '/v1/responses', why);
    assert.equal(seen[before].headers.authorization, `Bearer ${secret}`, why);
  }
  async function refused(token: string, status: number, type: string, why: string): Promise<void> {
    const before = seen.length;
    const answer = await ask(token);
    assert.equal(answer.status, status, `${why}: ${answer.body}`);
    const parsed = JSON.parse(answer.body) as { type: string; error: { type: string; message: string } };
    assert.equal(parsed.type, 'error', why);
    assert.equal(parsed.error.type, type, why);
    assert.equal(seen.length, before, `${why}: the refused request reached OpenAI`);
  }

  await t.test('(1) the claim hands the engine the gateway and an orbit-gwk- token, and only its hash is stored', async () => {
    const key = await openaiKey('Stored');
    const { sessionId, claimed } = await claudeSession(key.slug);
    const env = claimed.agent.env!;
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://orbit.key-gateway-pg.invalid/api/gw/anthropic');
    const token = env.ANTHROPIC_AUTH_TOKEN;
    assert.match(token, /^orbit-gwk-/);
    assert.ok(!Object.values(env).some((value) => value.includes(key.secret)), 'the key reached the engine');
    assert.ok(!Object.values(env).some((value) => value.includes(endpoint)), 'the key’s endpoint reached the engine');

    const { rows } = await client.query('SELECT * FROM key_gateway_token WHERE session_id = $1', [sessionId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_hash, sha256(token));
    assert.equal(rows[0].provider_id, key.id);
    assert.equal(rows[0].user_id, ann.id);
    assert.equal(rows[0].revoked_at, null);
    // Every column of the row, as text: neither the token nor the key is in any of them.
    const text = JSON.stringify(rows[0]);
    assert.ok(!text.includes(token), 'the token itself is stored');
    assert.ok(!text.includes(token.slice('orbit-gwk-'.length)), 'the token’s secret part is stored');
    assert.ok(!text.includes(key.secret), 'the key is stored with the token');
    // A second claim mints a second token; the first stays good, both pushed out together.
    await goesThrough(token, key.secret, 'the claimed token');
  });

  await t.test('(2a) the session ends: its token stops authenticating', async () => {
    const key = await openaiKey('Ended');
    const { sessionId, claimed } = await claudeSession(key.slug);
    const token = claimed.agent.env!.ANTHROPIC_AUTH_TOKEN;
    await goesThrough(token, key.secret, 'before the end');
    await sessions.end(ann.id, sessionId);
    await refused(token, 401, 'authentication_error', 'the session ended');
  });

  await t.test('(2b) the key is disabled, or given a new secret: its tokens are revoked', async () => {
    const key = await openaiKey('Disabled');
    const { sessionId, claimed } = await claudeSession(key.slug);
    const token = claimed.agent.env!.ANTHROPIC_AUTH_TOKEN;
    await goesThrough(token, key.secret, 'before the disable');
    await providers.update(ann.id, key.id, { enabled: false });
    await refused(token, 401, 'authentication_error', 'the key was disabled');
    const { rows } = await client.query('SELECT revoked_at FROM key_gateway_token WHERE session_id = $1', [sessionId]);
    assert.ok(rows.every((row) => row.revoked_at !== null), 'the disable revoked no token');
    // Enabled again, the revoked token stays revoked: a new claim mints the one that works.
    await providers.update(ann.id, key.id, { enabled: true });
    await refused(token, 401, 'authentication_error', 'a revoked token after the key was enabled again');

    const rotated = await openaiKey('Rotated');
    const second = await claudeSession(rotated.slug);
    const rotatedToken = second.claimed.agent.env!.ANTHROPIC_AUTH_TOKEN;
    await goesThrough(rotatedToken, rotated.secret, 'before the rotation');
    const replacement = `sk-proj-${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    await providers.update(ann.id, rotated.id, { apiKey: replacement });
    await refused(rotatedToken, 401, 'authentication_error', 'the key was given a new secret');
  });

  await t.test('(2c) the key is deleted: its tokens go with it', async () => {
    const key = await openaiKey('Deleted');
    const { sessionId, claimed } = await claudeSession(key.slug);
    const token = claimed.agent.env!.ANTHROPIC_AUTH_TOKEN;
    await goesThrough(token, key.secret, 'before the delete');
    await providers.remove(ann.id, key.id);
    await refused(token, 401, 'authentication_error', 'the key was deleted');
    const { rows } = await client.query('SELECT 1 FROM key_gateway_token WHERE session_id = $1', [sessionId]);
    assert.equal(rows.length, 0, 'the deleted key’s tokens are still there');
  });

  await t.test('(2d) the account is disabled: 403 in Anthropic’s shape, and good again once enabled', async () => {
    const key = await openaiKey('Account');
    const { claimed } = await claudeSession(key.slug);
    const token = claimed.agent.env!.ANTHROPIC_AUTH_TOKEN;
    await goesThrough(token, key.secret, 'before the disable');
    await admin.setDisabled(administrator, ann.id, { disabled: true });
    await refused(token, 403, 'permission_error', 'the account was disabled');
    await admin.setDisabled(administrator, ann.id, { disabled: false });
    await goesThrough(token, key.secret, 'the account enabled again');
  });

  await t.test('(2e) the deployment flag turned off: no token authenticates', async () => {
    const key = await openaiKey('Flag');
    const { claimed } = await claudeSession(key.slug);
    const token = claimed.agent.env!.ANTHROPIC_AUTH_TOKEN;
    process.env[ANTHROPIC_GATEWAY_FLAG] = 'false';
    try {
      await refused(token, 401, 'authentication_error', 'the flag is off');
    } finally {
      process.env[ANTHROPIC_GATEWAY_FLAG] = 'true';
    }
  });
});
