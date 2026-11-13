/**
 * What a Claude Code session on an OpenAI key spends, as the /api/gw/anthropic gateway books it
 * (docs/claude-engine-openai-gateway-design.md §5.5, decision D8, migration 0613), on real PostgreSQL.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/providers/key-gateway-usage.pg.spec.ts
 *
 * The key is made by ProvidersService.create, the session claimed by QueueService (which mints the token), and
 * the real controller answers behind Nest. OpenAI's stand-in answers with the recorded Responses stream of
 * fixtures/codex-gateway-recording.json, whose final event counts cached and reasoning tokens.
 *
 *  (1) The streamed answer reaches the CLI translated, and the gateway records the input, cached, output and
 *      reasoning tokens the stream's final event counted, priced with openai-prices.ts, per session and key; the
 *      same figure is the session's `usage` row and its `cost_usd`. An unstreamed request is recorded the same way.
 *  (2) turn-complete for such a session reports the CLI's own `total_cost_usd` and `modelUsage`; the session's cost
 *      and usage rows stay the gateway's figures, and the CLI's are not booked.
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
import { RunEventType, RunStatus as SharedRunStatus } from '@orbit/shared';
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
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { AnthropicGatewayController } from './anthropic-gateway.controller';
import { AnthropicLoginGatewayService } from './anthropic-login-gateway.service';
import { AnthropicGatewayService } from './anthropic-gateway.service';
import { ANTHROPIC_GATEWAY_FLAG } from './key-gateway';
import { responseCostMicros, type ResponsesUsage } from './openai-prices';
import { ProviderPlanUsageService } from './plan-usage.service';
import { ProvidersService } from './providers.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'key-gateway-usage-pg-spec';
process.env.PUBLIC_ORIGIN = 'https://orbit.key-gateway-usage-pg.invalid';
process.env[ANTHROPIC_GATEWAY_FLAG] = 'true';

const realtime = new Proxy(
  {},
  { get: (_target, key) => (key === 'then' ? undefined : () => undefined) },
) as RealtimeService;

/** The turn Claude Code 2.1.322 sent (P0 recording). */
const BASIC = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../src/providers/fixtures/claude-cli-2.1.322/basic.json'), 'utf8'),
) as { requests: Array<{ method: string; path: string; body?: unknown }> };
const TURN_BODY = BASIC.requests.find((r) => r.method === 'POST')!.body as Record<string, unknown>;

/** OpenAI's answer, as recorded: a Responses stream ending in `response.completed` with its usage. */
const RECORDED = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../src/providers/fixtures/codex-gateway-recording.json'), 'utf8'),
) as { response: { bodyBase64: string } };
const STREAM = Buffer.from(RECORDED.response.bodyBase64, 'base64');
const COMPLETED = STREAM.toString('utf8').split('\n')
  .filter((line) => line.startsWith('data: '))
  .map((line) => JSON.parse(line.slice(6)) as { type: string; response?: { model: string; service_tier: string; usage: ResponsesUsage } })
  .find((event) => event.type === 'response.completed')!.response!;

function exchange(base: string, token: string, stream: boolean): Promise<{ status: number; body: string }> {
  const payload = Buffer.from(JSON.stringify({ ...TURN_BODY, stream }));
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/gw/anthropic/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01',
        'content-length': String(payload.length),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.end(payload);
  });
}

const suite = URL ? test : test.skip;

suite('the gateway books a Claude-on-OpenAI session\'s usage and cost, on real PostgreSQL', { timeout: 600_000 }, async (t) => {
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
  const api = new RunnerApiController(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    realtime,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  (api as unknown as { logger: { warn: (line: string) => void } }).logger.warn = () => undefined;

  // OpenAI, as far as the gateway can tell: the recorded stream, for every request.
  const upstream: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end(STREAM);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const gateway = new AnthropicGatewayService(prisma, disabledAccounts);
  gateway.resolveHost = async () => [{ address: '162.159.140.245', family: 4 }];
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
  await db.user.create({ data: { id: ownerId, email: `bo-${ownerId}@key-gateway-usage-pg.invalid`, name: 'Bo', passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'bo-runner', tokenHash: sha256(generateToken(32)),
      status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'bo-agent', enabled: true, workDir: '/tmp/bo' } });

  const key = await providers.create(ownerId, {
    label: 'Metered', runtime: 'codex', baseUrl: 'https://api.openai.com/v1',
    apiKey: `sk-proj-${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`, presetSlug: 'openai', followsPreset: true,
  }) as { id: string; slug: string };

  const sessionId = (await sessions.create(ownerId, {
    prompt: 'hello', title: 'metered', workspaceId, provider: key.slug, engine: 'claude', model: 'gpt-5.1',
  } as never)).id;
  await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.PENDING, cancelRequestedAt: null } });
  const claimed = await queue.claimSessionForRunner({ id: runnerId });
  assert.ok(claimed, 'the runner was offered no session');
  assert.equal(claimed.sessionId, sessionId);
  const token = claimed.agent.env!.ANTHROPIC_AUTH_TOKEN;
  assert.match(token, /^orbit-gwk-/);
  await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.AWAITING_INPUT } });

  /** The recorded answer's figures: OpenAI's counts, and their price from openai-prices.ts. */
  const u = COMPLETED.usage;
  const input = u.input_tokens!;
  const cached = u.input_tokens_details!.cached_tokens!;
  const output = u.output_tokens!;
  const reasoning = u.output_tokens_details!.reasoning_tokens!;
  const costMicros = responseCostMicros(COMPLETED.model, COMPLETED.service_tier, u);

  type GatewayRow = {
    provider_id: string; model: string; service_tier: string | null; input_tokens: string;
    cached_input_tokens: string; output_tokens: string; reasoning_tokens: string; cost_micros: string;
  };
  async function gatewayRows(): Promise<GatewayRow[]> {
    const { rows } = await client.query<GatewayRow>(
      `SELECT provider_id::text, model, service_tier, input_tokens::text, cached_input_tokens::text, output_tokens::text,
              reasoning_tokens::text, cost_micros::text
         FROM key_gateway_usage WHERE session_id = $1::uuid ORDER BY id`, [sessionId]);
    return rows;
  }
  async function usageRows(): Promise<Array<[string, number, number, number, number, number]>> {
    const { rows } = await client.query<{ row: [string, number, number, number, number, number] }>(
      `SELECT json_build_array(model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd) AS row
         FROM usage WHERE session_id = $1::uuid ORDER BY id`, [sessionId]);
    return rows.map((r) => r.row);
  }
  async function sessionCost(): Promise<number> {
    return (await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { costUsd: true } })).costUsd;
  }
  /** The record is written once the answer is out: wait for it, briefly. */
  async function rowsReach(n: number): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      if ((await gatewayRows()).length >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`key_gateway_usage holds ${(await gatewayRows()).length} rows, not ${n}`);
  }

  const expectedRow: GatewayRow = {
    provider_id: key.id, model: 'gpt-5.1-codex', service_tier: 'default',
    input_tokens: String(input), cached_input_tokens: String(cached), output_tokens: String(output),
    reasoning_tokens: String(reasoning), cost_micros: String(costMicros),
  };
  const expectedUsage: [string, number, number, number, number, number] =
    ['gpt-5.1-codex', input - cached, output, 0, cached, costMicros / 1_000_000];

  await t.test('(1) a recorded Responses stream through the gateway records its tokens and cost from openai-prices', async () => {
    // The recording, stated: cached and reasoning tokens both present, priced at gpt-5.1's rate.
    assert.deepEqual([input, cached, output, reasoning], [11290, 9984, 57, 48]);
    assert.equal(costMicros, 3451, '(11290 − 9984) × 1.25 + 9984 × 0.125 + 57 × 10 = 3450.5 µ$');

    const streamed = await exchange(base, token, true);
    assert.equal(streamed.status, 200, streamed.body);
    assert.match(streamed.body, /event: message_start/);
    assert.match(streamed.body, /"text":"DONE"|"text_delta","text":"DO/);
    assert.match(streamed.body, /event: message_stop/);
    await rowsReach(1);
    assert.deepEqual(await gatewayRows(), [expectedRow]);
    assert.deepEqual(await usageRows(), [expectedUsage]);
    assert.equal(await sessionCost(), costMicros / 1_000_000);

    const whole = await exchange(base, token, false);
    assert.equal(whole.status, 200, whole.body);
    assert.equal(JSON.parse(whole.body).type, 'message');
    await rowsReach(2);
    assert.deepEqual(await gatewayRows(), [expectedRow, expectedRow], 'an unstreamed answer is recorded the same way');
    assert.deepEqual(await usageRows(), [expectedUsage, expectedUsage]);
    assert.equal(await sessionCost(), (2 * costMicros) / 1_000_000);
  });

  await t.test('(2) the session\'s reported cost is the gateway\'s figure, not the CLI\'s total_cost_usd', async () => {
    const before = await sessionCost();
    const rowsBefore = await usageRows();
    // A turn the CLI answered, and its completion with Claude Code's own running totals for the GPT id.
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.RUNNING, engineTurnActive: true, assignedRunnerId: runnerId } });
    // The session's opening prompt is not this turn's to answer: settled, so nothing else is queued behind it.
    await db.conversationTurn.updateMany({ where: { sessionId }, data: { status: 'ANSWERED', answeredAt: new Date() } });
    const { _max } = await db.conversationTurn.aggregate({ where: { sessionId }, _max: { seq: true } });
    const seq = (_max.seq ?? 0) + 1;
    const { id: turnId } = await db.conversationTurn.create({
      data: {
        sessionId, seq, clientTurnId: `metered-${randomUUID()}`, kind: 'message', content: 'hello',
        status: 'IN_FLIGHT', deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 300_000),
      },
      select: { id: true },
    });
    await api.events({ id: runnerId }, sessionId, {
      events: [{ seq: 10_000, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId, payload: { text: 'DONE' } }],
    });
    const cliCost = 0.5;
    const ack = await api.turnComplete({ id: runnerId }, sessionId, {
      turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'success', numTurns: 1,
      costUsd: cliCost,
      modelUsage: {
        'gpt-5.1': { inputTokens: 1306, outputTokens: 57, cacheCreationInputTokens: 0, cacheReadInputTokens: 9984, costUSD: cliCost },
      },
      runningTotals: { process: randomUUID(), restored: { costUsd: 0, modelUsage: {} } },
    });
    assert.deepEqual(ack, { ok: true, status: RunStatus.AWAITING_INPUT });
    assert.equal(await sessionCost(), before, 'the CLI\'s own total_cost_usd was booked onto the session');
    assert.equal(before, (2 * costMicros) / 1_000_000);
    assert.deepEqual(await usageRows(), rowsBefore, 'the CLI\'s modelUsage was written as usage rows');
    const booked = (await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { engineUsageTotals: true } })).engineUsageTotals as { costUsd: number };
    assert.equal(booked.costUsd, cliCost, 'the CLI\'s totals are still kept, for the next completion to be measured from');
  });
});
