/**
 * Claude Code on the account owner's own Codex login pool (P2b, docs/claude-engine-openai-gateway-design.md §9),
 * on real PostgreSQL, through production code: SessionsService, QueueService's claim, ProvidersService's lists,
 * the /api/gw/anthropic controller and the login gateway, against a recorder standing in for ChatGPT's Codex
 * backend.
 *
 *  (1) ORBIT_CLAUDE_CODEX_LOGIN_GATEWAY off: a Claude Code session on the pool is refused, the pool lists only
 *      codex, and a codex session on it dispatches as before.
 *  (2) On: the pool lists codex then claude; a Claude Code session is claimed on the owner's own account with
 *      /api/gw/anthropic and the pool's `orbit-gwl-` token — no account token, no account id, no Codex
 *      endpoint anywhere in its environment — and the token works on /api/gw/anthropic, not on /api/gw/codex.
 *  (3) On: a shared Codex pool, and somebody else's own pool the owner is one of the people of, are never
 *      offered Claude Code and refuse a Claude Code session.
 *  (4) A turn through the gateway reaches the backend as Claude Code's own request — its system prompt as the
 *      instructions, its User-Agent, the account's credential pair, and none of what the gateway adds for codex
 *      (`version`, `x-codex-routing-hint`, zstd, the guardian metadata) — and comes back as Anthropic SSE; its
 *      usage goes into the pool's ledger and onto the session's cost, which turn-complete then leaves alone.
 *  (5) usage_limit_reached: Anthropic's 429 with the usage-limit wording, and the account marked spent; a 401
 *      is refreshed once, as codex's is.
 *
 * It only adds rows, and refuses to run anywhere but the disposable server `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { PrismaClient, RunnerStatus, RunStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import express from 'express';
import { Client } from 'pg';

import { DisabledAccounts } from '../auth/disabled-accounts';
import { sha256 } from '../common/crypto.util';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { AnthropicGatewayController } from './anthropic-gateway.controller';
import { AnthropicGatewayService } from './anthropic-gateway.service';
import { AnthropicLoginGatewayService } from './anthropic-login-gateway.service';
import { CLAUDE_CODEX_LOGIN_FLAG } from './codex-login-claude';
import { CodexLoginService } from './codex-login.service';
import { gatewayBooksSpend } from './key-gateway';
import { ProviderPlanUsageService } from './plan-usage.service';
import { PoolLoginGatewayService } from './pool-login-gateway.service';
import { PoolLoginLedger } from './pool-login-ledger';
import { encryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';
import '../test-support/dequeue-under-lease';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'codex-login-claude-spec';
process.env.PUBLIC_ORIGIN = 'https://orbit.codex-login-claude.invalid';
const ANTHROPIC_GATEWAY = 'https://orbit.codex-login-claude.invalid/api/gw/anthropic';
const CODEX_GATEWAY = 'https://orbit.codex-login-claude.invalid/api/gw/codex';

const realtime = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => undefined) }) as RealtimeService;

/** Claude Code's own system prompt, as far as this spec needs one, and its User-Agent (claude 2.1.322). */
const CLAUDE_PROMPT = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_UA = 'claude-cli/2.1.322 (external, sdk-cli)';

const setFlag = (on: boolean) => {
  if (on) process.env[CLAUDE_CODEX_LOGIN_FLAG] = 'true';
  else delete process.env[CLAUDE_CODEX_LOGIN_FLAG];
};

interface Person { name: string; id: string; runnerId: string; workspaceId: string }

async function person(db: PrismaClient, name: string): Promise<Person> {
  const id = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({ data: { id, email: `${name}-${id}@codex-login-claude.invalid`, name, passwordHash: 'x' } });
  await db.runner.create({
    data: { id: runnerId, ownerId: id, name: `${name}-runner`, tokenHash: `x-${runnerId}`, status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date() },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId: id, runnerId, name: `${name}-agent`, enabled: true, workDir: `/tmp/${name}` } });
  return { name, id, runnerId, workspaceId };
}

/** A Responses stream as the Codex backend answers a turn: one text output and its usage. */
function textStream(model: string, usage: { input: number; cached: number; output: number }): Buffer {
  const response = {
    id: 'resp_1', object: 'response', model, status: 'completed', output: [],
    usage: {
      input_tokens: usage.input, input_tokens_details: { cached_tokens: usage.cached },
      output_tokens: usage.output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: usage.input + usage.output,
    },
  };
  const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] };
  return Buffer.from([
    { type: 'response.created', response: { ...response, status: 'in_progress', usage: null } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' },
    { type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', content: [{ type: 'output_text', text: 'ok' }] } },
    { type: 'response.completed', response },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

function post(base: string, path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  const bytes = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'content-length': String(bytes.length) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.end(bytes);
  });
}

async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let polls = 0; polls < 100; polls += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`never: ${what}`);
}

const suite = URL ? test : test.skip;

suite("Claude Code on the owner's own Codex login pool — on real PostgreSQL", { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const gatewayDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL!, max: 2 }) });
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const sessions = new SessionsService(prisma, queue, realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const logins = new CodexLoginService(prisma, realtime);
  const ledger = new PoolLoginLedger(prisma);
  const previousFlag = process.env[CLAUDE_CODEX_LOGIN_FLAG];

  // ChatGPT's Codex backend and OpenAI's token endpoint, as far as the gateway can tell.
  const seen: Array<{ url: string; headers: IncomingHttpHeaders; body: Buffer }> = [];
  const script: Array<{ status: number; headers?: Record<string, string>; body: Buffer }> = [];
  const upstream: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      const answer = script.shift() ?? { status: 500, body: Buffer.from('{"error":{"message":"nothing scripted"}}') };
      res.writeHead(answer.status, answer.headers ?? { 'content-type': 'application/json' });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const recorder = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const loginGateway = new PoolLoginGatewayService(
    gatewayDb as unknown as PrismaService, logins, ledger, realtime, `${recorder}/backend-api/codex`, `${recorder}/oauth/token`,
    new DisabledAccounts(prisma),
  );
  const controller = new AnthropicGatewayController(
    new AnthropicGatewayService(prisma, new DisabledAccounts(prisma)),
    new AnthropicLoginGatewayService(gatewayDb as unknown as PrismaService, loginGateway, `${recorder}/backend-api/codex`),
  );
  const app = express();
  app.use('/api/gw/anthropic', (req, res) => void controller.forward(req, res));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const gateway = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/gw/anthropic`;

  t.after(async () => {
    if (previousFlag === undefined) delete process.env[CLAUDE_CODEX_LOGIN_FLAG];
    else process.env[CLAUDE_CODEX_LOGIN_FLAG] = previousFlag;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await gatewayDb.$disconnect();
    await db.$disconnect();
    await client.end();
  });

  /** A Codex pool of `who`'s own with one ChatGPT account they signed in themselves. */
  async function loginPool(who: Person, label: string) {
    const made = await providers.createPool(who.id, { label, engine: 'codex' });
    const accountId = `acct-${randomUUID()}`;
    const access = `access-${randomUUID()}`;
    const refresh = `rt_${randomUUID()}`;
    await db.poolCodexLogin.create({
      data: {
        poolId: made.id, userId: who.id, accountId, email: `${who.name.toLowerCase()}@chatgpt.invalid`, plan: 'pro',
        accessTokenEnc: encryptSecret(access), refreshTokenEnc: encryptSecret(refresh), expiresAt: new Date('2100-01-01T00:00:00.000Z'),
      },
    });
    return { id: made.id, slug: made.slug, label, accountId, access, refresh };
  }
  const create = (who: Person, provider: string, engine: string) =>
    sessions.create(who.id, { prompt: 'hello', title: `${engine} on ${provider}`, workspaceId: who.workspaceId, provider, engine, model: 'gpt-5.6-sol' });
  const refused = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  async function claim(who: Person, sessionId: string) {
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.PENDING, cancelRequestedAt: null } });
    const claimed = await queue.claimSessionForRunner({ id: who.runnerId });
    if (claimed) await db.session.update({ where: { id: claimed.sessionId }, data: { status: RunStatus.AWAITING_INPUT } });
    return claimed;
  }
  const usableEngines = async (who: Person, slug: string) =>
    (await providers.listUsable(who.id)).find((p) => p.slug === slug)?.engines;

  const ann = await person(db, 'Ann');
  const pool = await loginPool(ann, 'Ann Codex');

  await t.test('(1) flag off: Claude Code is refused on the pool, which lists codex alone; codex dispatches as before', async () => {
    setFlag(false);
    assert.deepEqual(await usableEngines(ann, pool.slug), ['codex']);
    assert.equal('engines' in (await providers.getPool(ann.id, pool.id)), false, 'the pool view is as it was');
    assert.match((await refused(create(ann, pool.slug, 'claude'))) ?? '', /cannot run on Claude Code/);
    const codex = await create(ann, pool.slug, 'codex');
    const claimed = await claim(ann, codex.id);
    assert.equal(claimed?.sessionId, codex.id);
    assert.equal(claimed!.agent.env?.OPENAI_BASE_URL, CODEX_GATEWAY);
    assert.ok(claimed!.agent.env?.OPENAI_API_KEY?.startsWith('orbit-gwl-'));
    await db.session.update({ where: { id: codex.id }, data: { status: RunStatus.SUCCEEDED, completedAt: new Date() } });
  });

  let claudeToken = '';
  let claudeSession = '';
  await t.test("(2) flag on: codex then claude; the Claude Code session runs on the pool's token, never an account's", async () => {
    setFlag(true);
    assert.deepEqual(await usableEngines(ann, pool.slug), ['codex', 'claude'], 'codex stays the default (D7)');
    assert.deepEqual((await providers.getPool(ann.id, pool.id) as { engines?: string[] }).engines, ['codex', 'claude']);
    const session = await create(ann, pool.slug, 'claude');
    claudeSession = session.id;
    const claimed = await claim(ann, session.id);
    assert.equal(claimed?.sessionId, session.id);
    assert.equal(claimed!.agent.provider, 'claude');
    const env = claimed!.agent.env ?? {};
    assert.equal(env.ANTHROPIC_BASE_URL, ANTHROPIC_GATEWAY);
    claudeToken = env.ANTHROPIC_AUTH_TOKEN;
    assert.ok(claudeToken.startsWith('orbit-gwl-'), 'the pool session token');
    // Nothing of the account: neither of its tokens, its id, nor a Codex endpoint or key variable.
    const all = JSON.stringify(env);
    for (const secret of [pool.access, pool.refresh, pool.accountId, CODEX_GATEWAY, 'chatgpt.com']) {
      assert.equal(all.includes(secret), false, `the environment carries ${secret.slice(0, 12)}…`);
    }
    for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME', 'ANTHROPIC_API_KEY']) assert.equal(env[name], undefined, name);
    // Stored as a hash only, for this session and pool; the session is on the owner's own account.
    const row = await db.poolLoginToken.findUniqueOrThrow({ where: { tokenHash: sha256(claudeToken) }, select: { sessionId: true, poolId: true } });
    assert.deepEqual(row, { sessionId: session.id, poolId: pool.id });
    const stored = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { poolCodexAccountId: true, engine: true, provider: true } });
    assert.deepEqual(stored, { poolCodexAccountId: pool.accountId, engine: 'claude', provider: pool.slug });
    // The gateways: /api/gw/anthropic takes the token; /api/gw/codex does not take a Claude Code session's.
    const asClaude = await loginGateway.caller(claudeToken, 'claude' as never);
    assert.ok(asClaude && asClaude !== 'ACCOUNT_DISABLED' && asClaude.sessionId === session.id);
    assert.equal(await loginGateway.caller(claudeToken), null);
    assert.equal(await gatewayBooksSpend(db, { id: session.id, provider: pool.slug, engine: 'claude' }), true);
  });

  await t.test("(3) flag on: a shared Codex pool, and somebody else's own pool, are never offered Claude Code", async () => {
    setFlag(true);
    const shared = await db.providerPool.create({
      data: { slug: `team-${randomUUID().slice(0, 8)}`, label: 'Team Codex', ownerId: ann.id, engine: 'codex', shared: true, people: { create: { userId: ann.id, role: 'ADMIN' } } },
    });
    // A key in it, so the pool can run at all and what refuses Claude Code is the engine, not an empty pool.
    await db.poolApiKey.create({
      data: { poolId: shared.id, contributorId: ann.id, label: 'team key', keyFingerprint: `fp-${randomUUID()}`, keyHint: 'sk-…test', secretEncrypted: encryptSecret('sk-fake-team-key') },
    });
    assert.deepEqual(await usableEngines(ann, shared.slug), ['codex']);
    assert.match((await refused(create(ann, shared.slug, 'claude'))) ?? '', /cannot run on Claude Code/);
    // Bob's own pool, with Ann among its people (migration 0358): Ann reaches it, on codex alone.
    const bob = await person(db, 'Bob');
    const bobs = await loginPool(bob, 'Bob Codex');
    await db.providerPoolPerson.create({ data: { poolId: bobs.id, userId: ann.id, role: 'MEMBER' } });
    assert.deepEqual(await usableEngines(ann, bobs.slug), ['codex']);
    assert.deepEqual(await usableEngines(bob, bobs.slug), ['codex', 'claude']);
    assert.match((await refused(create(ann, bobs.slug, 'claude'))) ?? '', /cannot run on Claude Code/);
  });

  await t.test("(4) a turn reaches the backend as Claude Code's own request and comes back as Anthropic SSE; usage is booked", async () => {
    setFlag(true);
    seen.length = 0;
    script.push({ status: 200, headers: { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '11', 'x-codex-primary-window-minutes': '10080' }, body: textStream('gpt-5.6-sol', { input: 15_505, cached: 0, output: 5 }) });
    const answer = await post(gateway, '/v1/messages?beta=true', { authorization: `Bearer ${claudeToken}`, 'user-agent': CLAUDE_UA, 'anthropic-version': '2023-06-01' }, {
      model: 'claude-opus-5-5', max_tokens: 32_000, stream: true,
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.322;' }, { type: 'text', text: CLAUDE_PROMPT }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the word ok.' }] }],
    });
    assert.equal(answer.status, 200, answer.text);
    assert.match(answer.headers['content-type'] ?? '', /text\/event-stream/);
    assert.match(answer.text, /event: message_start/);
    assert.match(answer.text, /"text":"ok"|"text_delta","text":"ok"/);
    assert.equal(seen.length, 1);
    const [sent] = seen;
    assert.equal(sent.url, '/backend-api/codex/responses');
    assert.equal(sent.headers.authorization, `Bearer ${pool.access}`);
    assert.equal(sent.headers['chatgpt-account-id'], pool.accountId);
    assert.equal(sent.headers['user-agent'], CLAUDE_UA, "Claude Code's own User-Agent");
    assert.equal(sent.headers['session-id'], claudeSession, "the Orbit session, which keeps the session's prompt cache");
    for (const codexOnly of ['version', 'x-codex-routing-hint', 'content-encoding', 'originator', 'anthropic-version']) {
      assert.equal(sent.headers[codexOnly], undefined, `${codexOnly} was sent`);
    }
    const body = JSON.parse(sent.body.toString('utf8')) as Record<string, unknown>;
    assert.equal(body.model, 'gpt-5.6-sol', "the session's model, whatever Claude id the CLI named");
    assert.equal(body.instructions, CLAUDE_PROMPT, "Claude Code's own system prompt, the billing line dropped");
    assert.equal(body.store, false);
    assert.equal(body.client_metadata, undefined);
    // The pool's ledger, as for codex, and the session's cost line.
    await ledger.flush();
    await eventually(async () => (await db.poolLoginUsage.count({ where: { sessionId: claudeSession } })) > 0, 'the ledger row');
    const row = await db.poolLoginUsage.findFirstOrThrow({ where: { sessionId: claudeSession }, select: { inputTokens: true, outputTokens: true, costMicros: true } });
    assert.deepEqual({ input: Number(row.inputTokens), output: Number(row.outputTokens) }, { input: 15_505, output: 5 });
    await eventually(async () => (await db.llmUsage.count({ where: { sessionId: claudeSession } })) > 0, 'the session usage row');
    const cost = await db.session.findUniqueOrThrow({ where: { id: claudeSession }, select: { costUsd: true } });
    assert.equal(Number(cost.costUsd), Number(row.costMicros) / 1_000_000);
  });

  await t.test('(5) usage_limit_reached: Anthropic 429, the account spent until its reset; a 401 is refreshed once', async () => {
    setFlag(true);
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
    script.push({ status: 429, body: Buffer.from(JSON.stringify({ error: { type: 'usage_limit_reached', code: 'usage_limit_reached', message: 'The usage limit has been reached', resets_at: resetsAt } })) });
    const spent = await post(gateway, '/v1/messages', { authorization: `Bearer ${claudeToken}`, 'user-agent': CLAUDE_UA }, {
      model: 'gpt-5.6-sol', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(spent.status, 429);
    assert.equal(spent.headers['x-should-retry'], 'false');
    const error = (JSON.parse(spent.text) as { type: string; error: { type: string; message: string } });
    assert.equal(error.type, 'error');
    assert.equal(error.error.type, 'rate_limit_error');
    assert.match(error.error.message, /^You hit your usage limit on the ChatGPT account ann@chatgpt\.invalid of the pool "Ann Codex" · resets /);
    const account = await db.poolCodexLogin.findUniqueOrThrow({ where: { poolId_accountId: { poolId: pool.id, accountId: pool.accountId } }, select: { spentUntil: true } });
    assert.equal(account.spentUntil?.getTime(), resetsAt * 1000);
    await db.poolCodexLogin.update({ where: { poolId_accountId: { poolId: pool.id, accountId: pool.accountId } }, data: { spentUntil: null } });

    // A 401: refreshed on the token endpoint and sent once more on the new token.
    seen.length = 0;
    const fresh = `access-${randomUUID()}`;
    script.push(
      { status: 401, body: Buffer.from('{"error":{"message":"expired"}}') },
      { status: 200, body: Buffer.from(JSON.stringify({ access_token: fresh, refresh_token: `rt_${randomUUID()}` })) },
      { status: 200, headers: { 'content-type': 'text/event-stream' }, body: textStream('gpt-5.6-sol', { input: 10, cached: 0, output: 1 }) },
    );
    const retried = await post(gateway, '/v1/messages', { authorization: `Bearer ${claudeToken}`, 'user-agent': CLAUDE_UA }, {
      model: 'gpt-5.6-sol', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(retried.status, 200, retried.text);
    assert.deepEqual(seen.map((s) => s.url), ['/backend-api/codex/responses', '/oauth/token', '/backend-api/codex/responses']);
    assert.equal(seen[2].headers.authorization, `Bearer ${fresh}`);
  });

  await t.test('(6) the session ended: its token is refused in Anthropic\'s shape', async () => {
    await db.session.update({ where: { id: claudeSession }, data: { status: RunStatus.SUCCEEDED, completedAt: new Date() } });
    const answer = await post(gateway, '/v1/messages', { authorization: `Bearer ${claudeToken}` }, { model: 'gpt-5.6-sol', messages: [] });
    assert.equal(answer.status, 401);
    assert.equal((JSON.parse(answer.text) as { error: { type: string } }).error.type, 'authentication_error');
  });
});
