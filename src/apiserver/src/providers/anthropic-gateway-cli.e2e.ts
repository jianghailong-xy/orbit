/**
 * Design §5.4 and §4.6 (docs/claude-engine-openai-gateway-design.md), end to end: the REAL claude CLI — the
 * version the runner ships, run with the runner's flags and the environment injectedEnv gives a Claude Code
 * session on an OpenAI key — talks to AnthropicGatewayController / AnthropicGatewayService over HTTP, and they
 * talk to a scripted stand-in for OpenAI's /v1/responses. Only the database is replaced: a stand-in answering
 * the token read and recording the key row's writes (key-gateway-errors.pg.spec.ts makes the same writes on
 * PostgreSQL). The key's endpoint is OpenAI's own, https://api.openai.com/v1, and passes the gateway's upstream
 * guard (gateway-upstream.ts) as any key would: its name resolves (`resolveHost`, answered here with a public
 * address) and the gateway's agent opens the pinned connection — which here reaches the stand-in, in plain HTTP,
 * as gateway-upstream.spec.ts does.
 *
 * Each §5.4 row is one test, and each asserts both ends of it:
 *  - what the CLI did: retried (its `api_retry` events), compacted (`compact_boundary`), finished the turn, or
 *    failed it with the stated words — read from its own stream-json output;
 *  - what Orbit did: the key row's write (INVALID, spent until the reset), and what the session's auto-retry
 *    arms on the words the CLI ended the turn with, decided by the real RunnerApiController.retryPlanFor —
 *    the decision event ingestion makes for that reply.
 *
 * Not a unit spec: it needs the claude CLI, which CI and the merge check do not install, and no spec outside the
 * .pg family may skip (verification-tiering.spec.ts). Run it on a host that has the CLI:
 *
 *   npm run test:gateway-cli -w @orbit/apiserver
 *
 * The CLI is found at ORBIT_CLAUDE_BIN, else ~/.local/bin/claude (where the runner installs it); without one the
 * run fails, saying so.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import net, { type AddressInfo, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, beforeEach, test } from 'node:test';

import express from 'express';

import {
  API_ERROR_RETRY_BACKOFF_MS,
  isAuthErrorText,
  isRetryableApiErrorText,
  isUsageLimitErrorText,
  parseQuotaResetAt,
} from '@orbit/shared';
import { DisabledAccounts } from '../auth/disabled-accounts';
import { sha256 } from '../common/crypto.util';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import { RunnerApiController, type RetryPlanTransaction } from '../runner-api/runner-api.controller';
import { transactionDouble } from '../test-support/prisma-transaction-double';
import { AnthropicGatewayController } from './anthropic-gateway.controller';
import type { AnthropicLoginGatewayService } from './anthropic-login-gateway.service';
import { AnthropicGatewayService, resetsPhrase } from './anthropic-gateway.service';
import { ANTHROPIC_GATEWAY_FLAG } from './key-gateway';
import { encryptSecret } from './provider-crypto';

process.env.PROVIDER_SECRET_KEY ??= 'anthropic-gateway-cli-spec';

const CLAUDE = process.env.ORBIT_CLAUDE_BIN ?? path.join(homedir(), '.local/bin/claude');
const CASE = { timeout: 180_000 };

const TOKEN = 'orbit-gwk-cli-spec-token';
const USER = '0190f3c2-0000-7000-8000-0000000000bb';
const KEY_ID = '0190f3c2-0000-7000-8000-000000000001';
const SLUG = 'openai-work';
const LABEL = 'Work OpenAI';
const MODEL = 'gpt-5.1';
const SECRET = encryptSecret('sk-proj-anthropic-gateway-cli-spec-0123456789');

/** The key row as the stand-in database holds it, written by the gateway's updateMany. */
let key: { keyCheckState: string | null; keyCheckedAt: Date | null; spentUntil: Date | null };
/** Every write the gateway made to the key row. */
let writes: Array<Record<string, unknown>>;
/** What the stand-in for OpenAI was asked, in order. */
let calls: Array<{ url: string; body: string }>;
/** What the gateway answered as JSON (its refusals, unstreamed answers and counts), in order. */
let answers: Array<{ url: string; status: number; body: Record<string, unknown> }>;
/** How the stand-in for OpenAI answers call `n` (1-based) of /v1/responses. */
let script: (n: number, body: string) => Reply;
/** How it answers /v1/responses/input_tokens. */
let countReply: Reply;

type Reply = { status: number; headers?: Record<string, string>; json: unknown } | { sse: unknown[] };

let upstream: Server;
let gateway: Server;
let base: string;
let scratch: string;

/** A whole Responses stream that answers `text`. */
function ok(text: string): Reply {
  return {
    sse: [
      { type: 'response.created', response: { id: 'resp_1', model: MODEL } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
      { type: 'response.output_text.delta', output_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
      { type: 'response.completed', response: { id: 'resp_1', model: MODEL, status: 'completed', usage: { input_tokens: 900, output_tokens: 3 }, output: [] } },
    ],
  };
}

/** An OpenAI error answer. */
function err(status: number, code: string | null, message: string, headers?: Record<string, string>): Reply {
  return { status, headers, json: { error: { message, type: status === 429 ? 'insufficient_quota' : 'invalid_request_error', param: null, code } } };
}

before(async () => {
  assert.ok(existsSync(CLAUDE), `no claude CLI at ${CLAUDE} (set ORBIT_CLAUDE_BIN)`);
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ url: req.url!, body });
      const reply = req.url === '/v1/responses/input_tokens'
        ? countReply
        : script(calls.filter((c) => c.url === '/v1/responses').length, body);
      if ('sse' in reply) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.end(reply.sse.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
        return;
      }
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const upstreamBase = 'https://api.openai.com/v1';
  const prisma = {
    keyGatewayToken: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) => where.tokenHash !== sha256(TOKEN) ? null : {
        sessionId: '0190f3c2-0000-7000-8000-0000000000aa',
        userId: USER,
        expiresAt: new Date(Date.now() + 3_600_000),
        revokedAt: null,
        provider: {
          id: KEY_ID, slug: SLUG, label: LABEL, ownerId: USER, runtime: 'codex', baseUrl: upstreamBase, apiKeyEnc: SECRET,
          enabled: true, presetSlug: 'openai', followsPreset: true, models: [],
          keyCheckState: key.keyCheckState, spentUntil: key.spentUntil,
        },
        session: {
          status: 'RUNNING', ownerId: USER, provider: SLUG, engine: 'claude', model: MODEL, completedAt: null,
          deletedAt: null, cancelRequestedAt: null, endReason: null, owner: { disabledAt: null },
        },
      },
    },
    modelProvider: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.push({ where, data });
        const matches = where.id === KEY_ID && (where.apiKeyEnc === undefined || where.apiKeyEnc === SECRET);
        if (matches) Object.assign(key, data);
        return { count: matches ? 1 : 0 };
      },
    },
  } as unknown as PrismaService;
  const service = new AnthropicGatewayService(prisma, new DisabledAccounts(prisma));
  // The upstream guard runs as for any key: api.openai.com resolves (to a public address), and the connection the
  // gateway's agent is asked for is opened — to the stand-in, instead of OpenAI.
  service.resolveHost = async (host) => {
    assert.equal(host, 'api.openai.com');
    return [{ address: '162.159.140.245', family: 4 }];
  };
  service.agent = new (class extends HttpsAgent {
    override createConnection(): Socket {
      return net.connect(upstreamPort, '127.0.0.1');
    }
  })();
  const controller = new AnthropicGatewayController(service, {} as AnthropicLoginGatewayService);
  const app = express();
  app.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body: Record<string, unknown>) => {
      answers.push({ url: req.originalUrl, status: res.statusCode, body });
      return json(body);
    };
    next();
  });
  app.all(/^\/api\/gw\/anthropic(\/.*)?$/, (req, res) => void controller.forward(req, res));
  gateway = createServer(app);
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/api/gw/anthropic`;
  process.env[ANTHROPIC_GATEWAY_FLAG] = 'true';
  scratch = mkdtempSync(path.join(tmpdir(), 'gw-cli-'));
});

after(async () => {
  delete process.env[ANTHROPIC_GATEWAY_FLAG];
  for (const server of [gateway, upstream]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  key = { keyCheckState: null, keyCheckedAt: null, spentUntil: null };
  writes = [];
  calls = [];
  answers = [];
  countReply = { status: 200, json: { object: 'response.input_tokens', input_tokens: 4321 } };
});

type CliEvent = Record<string, unknown> & { type: string; subtype?: string };

/**
 * The CLI as the runner spawns it (claude_spawn.go's flags, injectedEnv's claudeEnv block for an OpenAI key),
 * with a fresh HOME, sent `prompts` one turn at a time: the next once the CLI reported the turn's result.
 */
async function cli(prompts: string[], env: Record<string, string> = {}): Promise<{ events: CliEvent[]; results: CliEvent[] }> {
  const home = mkdtempSync(path.join(scratch, 'home-'));
  const work = path.join(scratch, 'work');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(work, { recursive: true });
  const child = spawn(CLAUDE, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', MODEL,
    '--permission-mode', 'bypassPermissions',
  ], {
    cwd: work,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), TERM: 'dumb', IS_SANDBOX: '1',
      ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_MODEL: MODEL,
      ENABLE_CLAUDEAI_MCP_SERVERS: '0', CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP: '1', CLAUDE_CODE_INLINE_TOOLS: 'false',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '350000',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const events: CliEvent[] = [];
  const results: CliEvent[] = [];
  const say = (text: string) =>
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
  let next = 0;
  say(prompts[next++]);
  const timer = setTimeout(() => child.kill('SIGKILL'), 170_000);
  for await (const line of createInterface({ input: child.stdout })) {
    let event: CliEvent;
    try {
      event = JSON.parse(line) as CliEvent;
    } catch {
      continue;
    }
    events.push(event);
    if (event.type !== 'result') continue;
    results.push(event);
    if (next < prompts.length) say(prompts[next++]);
    else child.stdin.end();
  }
  clearTimeout(timer);
  rmSync(home, { recursive: true, force: true });
  assert.equal(results.length, prompts.length, `the CLI reported ${results.length} of ${prompts.length} turns`);
  return { events, results };
}

const retries = (events: CliEvent[]) => events.filter((e) => e.type === 'system' && e.subtype === 'api_retry');
const turnCalls = () => calls.filter((c) => c.url === '/v1/responses').length;

/**
 * What the session's auto-retry arms for a reply whose words are `text` — RunnerApiController.retryPlanFor, the
 * decision event ingestion makes, for a session on this key (no pool, no runner account).
 */
async function armed(text: string): Promise<{ retryAt?: Date | null; retryAttempts?: number }> {
  const tx = transactionDouble<RetryPlanTransaction>({
    runEvent: { findFirst: async () => null },
    session: {
      findMany: async () => [],
      findUnique: async () => ({
        ownerId: USER, provider: SLUG, taskId: null, retryAttempts: 0, poolCodexAccountId: null, poolKeyId: null,
        codexAccount: null, claudeAccount: null, claudeAccountPinned: false, kimiAccount: null, cursorAccount: null,
        poolSwitchNotice: null, workspace: null,
      }),
    },
    runner: { findUnique: async () => ({ planUsage: null, engines: null, capabilities: [] }) },
  });
  const queue = {
    sharedPoolRetryAt: async () => null,
    loginPoolRetryAt: async () => null,
    accountPoolResumesAt: async () => null,
  } as unknown as QueueService;
  const controller = new RunnerApiController(
    {} as never, queue, {} as never, {} as never, {} as never, {} as never,
    { appendFor: async (_tx: unknown, _id: unknown, content?: string) => content } as never,
  );
  return (controller as unknown as {
    retryPlanFor(tx: RetryPlanTransaction, id: string, runnerId: string, text: string, delivered: boolean): Promise<{ retryAt?: Date | null; retryAttempts?: number }>;
  }).retryPlanFor(tx, 'session-1', '11111111-1111-4111-8111-111111111111', text, true);
}

/** The retry is armed one step of the API-error ladder out (apiErrorRetryAt: the step plus up to a quarter). */
function assertLadderStep(at: Date | null | undefined, from: number): void {
  assert.ok(at instanceof Date, 'a retry is armed');
  const wait = at.getTime() - from;
  const step = API_ERROR_RETRY_BACKOFF_MS[0];
  assert.ok(wait >= step - 1_000 && wait <= step * 1.25 + 5_000, `armed ${wait}ms out, the first step is ${step}ms`);
}

test('§5.4 401: authentication_error naming the key, the CLI fails the turn at once, the key is marked INVALID, nothing is armed', CASE, async () => {
  script = () => err(401, 'invalid_api_key', 'Incorrect API key provided: sk-proj-****6789. You can find your API key at https://platform.openai.com/account/api-keys.');
  const { events, results } = await cli(['Say hi.', 'Say hi again.']);

  const said = String(results[0].result);
  assert.equal(results[0].is_error, true);
  assert.match(said, /^Failed to authenticate\. API Error: 401 OpenAI refused the key "Work OpenAI": Incorrect API key provided/);
  assert.match(said, /Orbit marked it invalid: add a new key in Providers to go on\.$/);
  // `x-should-retry: false`: without it 2.1.322 asks ten more times over three minutes (measured).
  assert.equal(retries(events).length, 0);
  assert.equal(key.keyCheckState, 'INVALID');
  assert.deepEqual(writes.map((w) => Object.keys(w.data as object).sort()), [['keyCheckState', 'keyCheckedAt']]);
  assert.equal((writes[0].where as { apiKeyEnc?: string }).apiKeyEnc, SECRET, 'only the secret OpenAI refused is marked');
  // The next turn is refused by the gateway itself: OpenAI was asked once.
  assert.equal(results[1].is_error, true);
  assert.match(String(results[1].result), /^Failed to authenticate\. API Error: 401 OpenAI refused the key "Work OpenAI"/);
  assert.equal(turnCalls(), 1);
  // A refused key is the owner's to replace: Orbit's ingestion reads it as a sign-in failure and arms nothing.
  assert.equal(isAuthErrorText(said), true);
  assert.deepEqual(await armed(said), { retryAt: null, retryAttempts: 0 });
});

test('§5.4 403: permission_error naming the key and the model, the CLI fails the turn without retrying, the key is left as it is', CASE, async () => {
  script = () => err(403, null, 'You are not allowed to sample from this model.');
  const { events, results } = await cli(['Say hi.']);

  const said = String(results[0].result);
  assert.equal(results[0].is_error, true);
  assert.equal(said, 'Failed to authenticate. API Error: 403 The key "Work OpenAI" may not use the model "gpt-5.1" on OpenAI: You are not allowed to sample from this model.');
  assert.equal(retries(events).length, 0);
  assert.equal(turnCalls(), 1);
  assert.deepEqual(writes, []);
  assert.deepEqual(await armed(said), { retryAt: null, retryAttempts: 0 });
});

test('§5.4 404 model: not_found_error naming the key and the model, the CLI fails the turn with its model message, the key is left as it is', CASE, async () => {
  script = () => err(404, 'model_not_found', 'The model `gpt-5.1` does not exist or you do not have access to it.');
  const { events, results } = await cli(['Say hi.']);

  const said = String(results[0].result);
  assert.equal(results[0].is_error, true);
  // The CLI words a 404 itself, naming the model; the gateway's own words name the key too.
  assert.match(said, /^There's an issue with the selected model \(gpt-5\.1\)/);
  const refusals = answers.filter((a) => a.status === 404 && a.url.includes('/v1/messages'));
  assert.ok(refusals.length >= 1);
  assert.deepEqual(refusals[0].body, {
    type: 'error',
    error: { type: 'not_found_error', message: 'OpenAI has no model "gpt-5.1" for the key "Work OpenAI": The model `gpt-5.1` does not exist or you do not have access to it.' },
  });
  assert.equal(retries(events).length, 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(await armed(said), { retryAt: null, retryAttempts: 0 });
});

test('§5.4 429 rate_limit_exceeded: waited out inside rateLimitWait\'s bound, the turn completes; past the bound rate_limit_error, no CLI retries, auto-retry armed', CASE, async () => {
  const limited = (ms: string) =>
    err(429, 'rate_limit_exceeded', 'Rate limit reached for gpt-5.1 on tokens per min (TPM): Limit 30000, Used 30000. Please try again in 300ms.', { 'retry-after-ms': ms });

  // Inside the bound: the gateway waits and asks again on the same key; the CLI never sees the limit.
  script = (n) => (n <= 2 ? limited('300') : ok('hi'));
  const waited = await cli(['Say hi.']);
  assert.equal(waited.results[0].is_error, false);
  assert.equal(waited.results[0].result, 'hi');
  assert.equal(turnCalls(), 3);
  assert.equal(retries(waited.events).length, 0);

  // Past it (a 25 s wait, over RATE_LIMIT_MAX_WAIT_MS): answered at once, and the CLI does not ask again.
  calls = [];
  script = () => limited('25000');
  const started = Date.now();
  const { events, results } = await cli(['Say hi.']);
  const said = String(results[0].result);
  assert.equal(results[0].is_error, true);
  assert.equal(said, 'API Error: Request rejected (429) · OpenAI is rate-limiting the key "Work OpenAI", and was still refusing after the Orbit gateway waited: Rate limit reached for gpt-5.1 on tokens per min (TPM): Limit 30000, Used 30000. Please try again in 300ms.');
  assert.equal(turnCalls(), 1);
  assert.equal(retries(events).length, 0);
  assert.deepEqual(writes, []);
  // Orbit's auto-retry takes it from there, on the API-error ladder.
  assert.equal(isRetryableApiErrorText(said), true);
  assert.equal(isUsageLimitErrorText(said), false);
  const plan = await armed(said);
  assertLadderStep(plan.retryAt, started);
});

test('§5.4 429 insufficient_quota: the wording Orbit\'s quota handling reads, the key spent until the reset, auto-retry armed for it — as an error answer and as response.failed', CASE, async () => {
  const quota = err(429, 'insufficient_quota', 'You exceeded your current quota, please check your plan and billing details.', { 'retry-after': '7200' });
  script = () => quota;
  const before = Date.now();
  const { events, results } = await cli(['Say hi.']);

  const until = key.spentUntil;
  assert.ok(until instanceof Date, 'the key is recorded spent');
  assert.ok(Math.abs(until.getTime() - (before + 7_200_000)) < 60_000, `spent until the reset OpenAI named, not ${until.toISOString()}`);
  const said = String(results[0].result);
  assert.equal(results[0].is_error, true);
  assert.equal(said, `API Error: Request rejected (429) · You hit your usage limit on the OpenAI key "Work OpenAI" · resets ${resetsPhrase(until)}`);
  assert.equal(turnCalls(), 1);
  assert.equal(retries(events).length, 0);
  // Read as a spent quota — not as a transient error — and armed for the reset it names (plus its jitter).
  assert.equal(isUsageLimitErrorText(said), true);
  const reset = parseQuotaResetAt(said, new Date())!;
  assert.ok(reset.getTime() >= until.getTime() && reset.getTime() - until.getTime() < 60_000);
  const plan = await armed(said);
  assert.ok(plan.retryAt instanceof Date);
  assert.ok(plan.retryAt.getTime() >= reset.getTime() && plan.retryAt.getTime() < reset.getTime() + 60_000, `armed for ${plan.retryAt.toISOString()}`);

  // The same budget, said inside the stream as its first word: answered the same; the next answered turn clears it.
  key.spentUntil = null;
  calls = [];
  script = (n) => n === 1
    ? { sse: [
      { type: 'response.created', response: { id: 'resp_q', model: MODEL } },
      { type: 'response.in_progress', response: { id: 'resp_q', model: MODEL } },
      { type: 'response.failed', response: { id: 'resp_q', status: 'failed', error: { code: 'insufficient_quota', message: 'You exceeded your current quota.' } } },
    ] }
    : ok('back');
  const streamed = await cli(['Say hi.', 'Say hi again.']);
  const streamedSaid = String(streamed.results[0].result);
  assert.match(streamedSaid, /^API Error: Request rejected \(429\) · You hit your usage limit on the OpenAI key "Work OpenAI" · resets [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}[ap]m \(UTC\)$/);
  assert.equal(isUsageLimitErrorText(streamedSaid), true);
  assert.ok((await armed(streamedSaid)).retryAt instanceof Date);
  assert.equal(streamed.results[1].result, 'back');
  assert.equal(key.spentUntil, null, 'an answered request clears the spent mark');
  assert.deepEqual(writes.slice(1).map((w) => w.data), [{ spentUntil: (writes[1].data as { spentUntil: unknown }).spentUntil }, { spentUntil: null }]);
});

test('§5.4 5xx / overload: 529 overloaded_error, the CLI retries and the turn completes; one that persists fails the turn and auto-retry re-sends', CASE, async () => {
  script = (n) => (n <= 2 ? err(500, 'server_error', 'The server had an error while processing your request.') : ok('hi'));
  const recovered = await cli(['Say hi.']);
  assert.equal(recovered.results[0].is_error, false);
  assert.equal(recovered.results[0].result, 'hi');
  assert.deepEqual(retries(recovered.events).map((e) => e.error_status), [529, 529]);
  assert.equal(turnCalls(), 3);

  // A stream that breaks after output began ends in an SSE error event; the CLI asks again unstreamed.
  calls = [];
  script = (n) => n === 1
    ? { sse: [
      { type: 'response.created', response: { id: 'resp_m', model: MODEL } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_m' } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'Hel' },
      { type: 'response.failed', response: { id: 'resp_m', status: 'failed', error: { code: 'server_error', message: 'The server had an error.' } } },
    ] }
    : ok('hi');
  const resumed = await cli(['Say hi.']);
  assert.equal(resumed.results[0].is_error, false);
  assert.equal(resumed.results[0].result, 'hi');
  assert.equal(turnCalls(), 2);

  // Still failing after the CLI's own retries (cut to one here; the runner leaves its default of ten).
  calls = [];
  script = () => err(503, null, 'Service Unavailable');
  const started = Date.now();
  const { events, results } = await cli(['Say hi.'], { CLAUDE_CODE_MAX_RETRIES: '1' });
  const said = String(results[0].result);
  assert.equal(results[0].is_error, true);
  assert.match(said, /^API Error: 529 OpenAI could not answer \(503\): Service Unavailable/);
  assert.equal(retries(events).length, 1);
  assert.deepEqual(writes, []);
  assert.equal(isRetryableApiErrorText(said), true);
  assertLadderStep((await armed(said)).retryAt, started);
});

test('§5.4 context_length_exceeded: 400 "prompt is too long: N tokens > M maximum", the CLI compacts and the turn completes', CASE, async () => {
  let refused = false;
  script = (_n, body) => {
    if (/detailed summary/i.test(body)) return ok('Summary: the user asked for greetings.');
    if (!refused && body.includes('Say hi again.')) {
      refused = true;
      return err(400, 'context_length_exceeded', 'Your input exceeds the context window of this model. Please adjust your input and try again.');
    }
    return ok('hi');
  };
  const { events, results } = await cli(['Say hi.', 'Say hi again.']);

  const overflow = answers.find((a) => a.status === 400);
  assert.ok(overflow, 'the overflow was answered 400');
  assert.equal((overflow.body.error as { type: string }).type, 'invalid_request_error');
  // gpt-5.1's declared window is 400k (providerPresets.ts); N is the estimate, at least M + 1.
  assert.match((overflow.body.error as { message: string }).message, /^prompt is too long: \d+ tokens > 400000 maximum$/);
  assert.ok(events.some((e) => e.type === 'system' && e.subtype === 'compact_boundary'), 'the CLI compacted');
  assert.ok(calls.some((c) => /detailed summary/i.test(c.body)), 'the compaction request went through the gateway');
  assert.equal(results[1].is_error, false);
  assert.equal(results[1].result, 'hi');
  assert.deepEqual(writes, []);
});

test('§4.6 count_tokens: /context is answered with OpenAI\'s input-token count, and with characters ÷ 4 when that endpoint fails', CASE, async () => {
  script = () => ok('hi');
  await cli(['/context']);
  const counted = answers.filter((a) => a.url.includes('/v1/messages/count_tokens'));
  assert.ok(counted.length > 0, 'the CLI asked for counts');
  assert.ok(counted.every((a) => a.status === 200 && a.body.input_tokens === 4321));
  assert.equal(calls.filter((c) => c.url === '/v1/responses/input_tokens').length, counted.length);

  answers = [];
  calls = [];
  countReply = { status: 500, json: { error: { message: 'boom', type: 'server_error', code: null } } };
  await cli(['/context']);
  const estimated = answers.filter((a) => a.url.includes('/v1/messages/count_tokens'));
  assert.ok(estimated.length > 0);
  assert.ok(estimated.every((a) => a.status === 200 && Number.isInteger(a.body.input_tokens) && (a.body.input_tokens as number) > 0 && a.body.input_tokens !== 4321));
});
