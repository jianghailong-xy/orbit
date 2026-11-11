/**
 * The /api/gw/anthropic route (docs/claude-engine-openai-gateway-design.md §4.1): AnthropicGatewayController and
 * AnthropicGatewayService behind a real HTTP server with main.ts's own body parsers in front, and a recorder
 * standing where the key's OpenAI endpoint stands. Only the database is replaced, by a stand-in answering the one
 * read the gateway makes: the token by its hash. The token's lifecycle on PostgreSQL is key-gateway.pg.spec.ts.
 *
 *  - A missing, unknown or foreign-prefixed token, and any token with the deployment flag off, is refused 401 in
 *    Anthropic's error shape; a good token of a disabled account 403.
 *  - With a good token, a path outside the gateway's two is refused 404 in Anthropic's error shape, nothing sent on.
 *  - POST /v1/messages?beta=true is translated and sent to `<baseUrl>/responses` with the key, and the stream comes
 *    back as Messages events; count_tokens asks `/responses/input_tokens`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';

import express, { json, urlencoded } from 'express';

import { ACCOUNT_DISABLED_MESSAGE, DisabledAccounts } from '../auth/disabled-accounts';
import { sha256 } from '../common/crypto.util';
import type { PrismaService } from '../prisma/prisma.service';
import { AnthropicGatewayController } from './anthropic-gateway.controller';
import { AnthropicGatewayService } from './anthropic-gateway.service';
import { ANTHROPIC_GATEWAY_FLAG } from './key-gateway';
import { outsideThePoolGateway } from './pool-gateway.controller';
import { encryptSecret } from './provider-crypto';

process.env.PROVIDER_SECRET_KEY ??= 'anthropic-gateway-controller-spec';

const SECRET = 'sk-proj-anthropic-gateway-controller-0123456789';
const GOOD = 'orbit-gwk-good-token-for-the-controller-spec';
const DISABLED = 'orbit-gwk-token-of-a-disabled-account';
const USER = '0190f3c2-0000-7000-8000-0000000000bb';

/** The first request Claude Code 2.1.322 sent on a turn (P0 recording), as the body this route is given. */
const BASIC = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../src/providers/fixtures/claude-cli-2.1.322/basic.json'), 'utf8'),
) as { requests: Array<{ method: string; path: string; body?: unknown }> };
const TURN = BASIC.requests.find((r) => r.method === 'POST' && r.path.startsWith('/v1/messages'))!.body as Record<string, unknown>;

let upstream: Server;
let gateway: Server;
let base: string;
/** What the recorder standing in for OpenAI was sent. */
const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }> = [];

function tokenRow(disabledAt: Date | null, upstreamBase: string) {
  return {
    sessionId: '0190f3c2-0000-7000-8000-0000000000aa',
    userId: USER,
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
    provider: {
      id: '0190f3c2-0000-7000-8000-000000000001', slug: 'openai', ownerId: USER, runtime: 'codex', baseUrl: upstreamBase,
      apiKeyEnc: encryptSecret(SECRET), enabled: true, presetSlug: 'openai', followsPreset: true, models: [],
    },
    session: {
      status: 'RUNNING', ownerId: USER, provider: 'openai', engine: 'claude', model: 'gpt-5.1', completedAt: null,
      deletedAt: null, cancelRequestedAt: null, endReason: null, owner: { disabledAt },
    },
  };
}

const STREAM = [
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.1' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
  { type: 'response.output_text.delta', output_index: 0, delta: 'Hello' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
  { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.1', status: 'completed', usage: { input_tokens: 7, output_tokens: 1 }, output: [] } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

before(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url === '/v1/responses/input_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: 42 }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end(STREAM);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  const rows = new Map([
    [sha256(GOOD), tokenRow(null, upstreamBase)],
    [sha256(DISABLED), tokenRow(new Date(), upstreamBase)],
  ]);
  const prisma = {
    keyGatewayToken: { findUnique: async ({ where }: { where: { tokenHash: string } }) => rows.get(where.tokenHash) ?? null },
  } as unknown as PrismaService;
  const controller = new AnthropicGatewayController(new AnthropicGatewayService(prisma, new DisabledAccounts(prisma)));
  const app = express();
  // main.ts's own layers: the body parsers every other route gets, which must leave this one's body unread.
  app.use(outsideThePoolGateway(json({ limit: '10mb' })));
  app.use(outsideThePoolGateway(urlencoded({ extended: true, limit: '10mb' })));
  app.all(/^\/api\/gw\/anthropic(\/.*)?$/, (req, res) => void controller.forward(req, res));
  gateway = createServer(app);
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  process.env[ANTHROPIC_GATEWAY_FLAG] = 'true';
});

after(async () => {
  delete process.env[ANTHROPIC_GATEWAY_FLAG];
  for (const server of [gateway, upstream]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function send(method: string, url: string, token: string | null, body?: unknown): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = httpRequest(`${base}${url}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        'anthropic-version': '2023-06-01',
        'openai-organization': 'org-not-the-keys',
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Anthropic's error shape, `{type: "error", error: {type, message}}`, and nothing else. */
function assertAnthropicError(answer: { status: number; body: string }, status: number, type: string): string {
  assert.equal(answer.status, status);
  const parsed = JSON.parse(answer.body) as { type: string; error: { type: string; message: string } };
  assert.deepEqual(Object.keys(parsed).sort(), ['error', 'type']);
  assert.equal(parsed.type, 'error');
  assert.deepEqual(Object.keys(parsed.error).sort(), ['message', 'type']);
  assert.equal(parsed.error.type, type);
  assert.ok(parsed.error.message.length > 0);
  return parsed.error.message;
}

test('a bad token is refused in Anthropic’s error shape, and nothing is sent on', async () => {
  const before = seen.length;
  for (const token of [null, 'orbit-gwk-nobody-holds-this', 'orbit-gw-a-pool-token', SECRET]) {
    const message = assertAnthropicError(await send('POST', '/api/gw/anthropic/v1/messages?beta=true', token, TURN), 401, 'authentication_error');
    assert.ok(!message.includes(SECRET));
  }
  // An unknown path with a bad token is the same 401: the path tells an unauthenticated caller nothing.
  assertAnthropicError(await send('GET', '/api/gw/anthropic/v1/models', 'orbit-gwk-nobody-holds-this'), 401, 'authentication_error');
  assert.equal(seen.length, before);
});

test('an unknown path is refused in Anthropic’s error shape, and nothing is sent on', async () => {
  const before = seen.length;
  for (const [method, url] of [
    ['GET', '/api/gw/anthropic/v1/models'],
    ['POST', '/api/gw/anthropic/v1/complete'],
    ['GET', '/api/gw/anthropic/v1/messages'],
    ['POST', '/api/gw/anthropic/api/hello'],
    ['POST', '/api/gw/anthropic'],
    ['POST', '/api/gw/anthropic/v1/messages/batches?beta=true'],
  ] as const) {
    const message = assertAnthropicError(await send(method, url, GOOD, method === 'POST' ? TURN : undefined), 404, 'not_found_error');
    assert.match(message, /is not something the Orbit gateway forwards/);
  }
  // The CLI's HEAD <base>/api/hello before its first request: a 404, with no body for a HEAD.
  assert.equal((await send('HEAD', '/api/gw/anthropic/api/hello', GOOD)).status, 404);
  assert.equal(seen.length, before);
});

test('a good token of a disabled account is refused 403 in Anthropic’s error shape', async () => {
  const message = assertAnthropicError(await send('POST', '/api/gw/anthropic/v1/messages?beta=true', DISABLED, TURN), 403, 'permission_error');
  assert.equal(message, ACCOUNT_DISABLED_MESSAGE);
});

test('with the deployment flag off a good token is refused like a bad one', async () => {
  process.env[ANTHROPIC_GATEWAY_FLAG] = 'false';
  try {
    assertAnthropicError(await send('POST', '/api/gw/anthropic/v1/messages?beta=true', GOOD, TURN), 401, 'authentication_error');
  } finally {
    process.env[ANTHROPIC_GATEWAY_FLAG] = 'true';
  }
});

test('POST /v1/messages?beta=true is sent to <baseUrl>/responses with the key and answered as Messages events', async () => {
  seen.length = 0;
  const answer = await send('POST', '/api/gw/anthropic/v1/messages?beta=true', GOOD, { ...TURN, stream: true });
  assert.equal(answer.status, 200);
  assert.match(answer.type, /text\/event-stream/);
  assert.match(answer.body, /event: message_start/);
  assert.match(answer.body, /"text":"Hello"/);
  assert.match(answer.body, /event: message_stop/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/v1/responses');
  assert.equal(seen[0].headers.authorization, `Bearer ${SECRET}`);
  // Nothing the CLI sent is passed on: not its Anthropic headers, not an organization of its own.
  assert.equal(seen[0].headers['anthropic-version'], undefined);
  assert.equal(seen[0].headers['openai-organization'], undefined);
  const sent = JSON.parse(seen[0].body) as Record<string, unknown>;
  // The GPT id the CLI was started with (--model) passes through; a Claude id would become the session's.
  assert.equal(sent.model, TURN.model);
  assert.equal(sent.store, false);
  assert.equal(sent.stream, true);
  assert.equal(sent.prompt_cache_key, '0190f3c2-0000-7000-8000-0000000000aa');
});

test('an unstreamed POST /v1/messages is answered as one Messages JSON object', async () => {
  const answer = await send('POST', '/api/gw/anthropic/v1/messages', GOOD, { ...TURN, stream: false });
  assert.equal(answer.status, 200);
  assert.match(answer.type, /application\/json/);
  const message = JSON.parse(answer.body) as { type: string; role: string; content: Array<{ type: string; text?: string }> };
  assert.equal(message.role, 'assistant');
  assert.deepEqual(message.content.map((b) => b.text), ['Hello']);
});

test('POST /v1/messages/count_tokens?beta=true asks OpenAI’s input-token count', async () => {
  seen.length = 0;
  const answer = await send('POST', '/api/gw/anthropic/v1/messages/count_tokens?beta=true', GOOD,
    { model: 'gpt-5.1', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.body), { input_tokens: 42 });
  assert.equal(seen[0].url, '/v1/responses/input_tokens');
  assert.equal(seen[0].headers.authorization, `Bearer ${SECRET}`);
});
