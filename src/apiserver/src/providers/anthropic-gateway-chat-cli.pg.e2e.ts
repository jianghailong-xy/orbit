/**
 * Claude Code on an OpenAI-compatible (Chat Completions) key, end to end (docs/claude-engine-openai-gateway-design.md
 * §10), on real PostgreSQL that `scripts/run-pg-spec.sh` migrates, with the REAL claude CLI:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/providers/anthropic-gateway-chat-cli.pg.e2e.ts
 *
 * Needs the claude CLI (ORBIT_CLAUDE_BIN, else ~/.local/bin/claude, where the runner installs it), which CI does not
 * install: not in CI's pg roster, which takes *.pg.spec only.
 *
 *  (1) With the gateway on, ProvidersService answers an OpenAI-compatible key (`runtime: 'kimi'`) whose endpoint
 *      passes the upstream rule (gateway-upstream.ts: https, a host ORBIT_GATEWAY_UPSTREAM_HOSTS lists) with Claude
 *      Code among its engines, after Kimi; keys on an unlisted host, or on plain http, without it.
 *  (2) A Claude Code session on the first key is created and claimed by the real SessionsService and QueueService,
 *      which mint its gateway token. The CLI, spawned with the environment the claim handed it, runs one turn
 *      through the real controller behind Nest against a stand-in for the key's /v1/chat/completions, which answers
 *      with the streams recorded from a real Chat Completions server (fixtures/chat-completions/): a tool call, then
 *      — once the CLI ran it and sent its result — text. The turn completes with the text, the stand-in saw the
 *      tool's output come back as a `tool` message (with the reasoning as `reasoning_content`) and never the token,
 *      and the session's usage rows, key_gateway_usage rows and cost_usd hold the streams' usage, priced.
 *
 * It only adds rows, and refuses to run anywhere but the disposable server `coordinator-pg-test-safety` identifies.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import net, { type AddressInfo, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, RunnerStatus } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { DisabledAccounts } from '../auth/disabled-accounts';
import { generateToken, sha256 } from '../common/crypto.util';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { AnthropicGatewayController } from './anthropic-gateway.controller';
import { AnthropicGatewayService } from './anthropic-gateway.service';
import { AnthropicLoginGatewayService } from './anthropic-login-gateway.service';
import { GATEWAY_UPSTREAM_HOSTS_ENV } from './gateway-upstream';
import { ANTHROPIC_GATEWAY_FLAG, KEY_GATEWAY_TOKEN_PREFIX } from './key-gateway';
import { responseCostMicros } from './openai-prices';
import { ProviderPlanUsageService } from './plan-usage.service';
import { ProvidersService } from './providers.service';

const URL = process.env.COORDINATOR_PG_URL;
const CLAUDE = process.env.ORBIT_CLAUDE_BIN ?? path.join(homedir(), '.local/bin/claude');
process.env.PROVIDER_SECRET_KEY ??= 'anthropic-gateway-chat-cli-e2e';
process.env.PUBLIC_ORIGIN = 'https://orbit.chat-gateway-e2e.invalid';
process.env[ANTHROPIC_GATEWAY_FLAG] = 'true';
/** The relay's host, which the deployment admin lists; api.openai.com is always allowed. */
const RELAY_HOST = 'llm.relay-e2e.example';
process.env[GATEWAY_UPSTREAM_HOSTS_ENV] = RELAY_HOST;

const realtime = new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) }) as RealtimeService;

interface ChatRecording {
  request: { messages: Array<Record<string, unknown>> };
  response: { body: string };
}
const recorded = (name: string) =>
  JSON.parse(readFileSync(path.resolve(__dirname, `../../src/providers/fixtures/chat-completions/${name}.json`), 'utf8')) as ChatRecording;
/** A tool call: reasoning, then Bash `echo hi`, its arguments streamed in fragments (kimi-tool-call.json). */
const TOOL_CALL = recorded('kimi-tool-call').response.body;
/** Text once the tool's result came back: "The command completed successfully." */
const ANSWER = recorded('kimi-tool-result-with-reasoning').response.body;
/** Each stream's usage, as its last chunk counts it. */
function usageOf(body: string): { prompt_tokens: number; completion_tokens: number; completion_tokens_details: { reasoning_tokens: number } } {
  const last = body.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)) as { usage?: never }).filter((c) => c.usage).at(-1)!;
  return last.usage!;
}

const suite = URL ? test : test.skip;

suite('Claude Code on an OpenAI-compatible key: engines, claim, and a real CLI turn through /chat/completions', { timeout: 600_000 }, async (t) => {
  assert.ok(existsSync(CLAUDE), `no claude CLI at ${CLAUDE} (set ORBIT_CLAUDE_BIN)`);
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

  // The key's endpoint, as far as the gateway can tell: what it was asked, and the recorded streams.
  const calls: Array<{ method: string; url: string; authorization: string | undefined; body: Record<string, unknown> | null; reply?: string }> = [];
  const upstream: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      const call: (typeof calls)[number] = { method: req.method!, url: req.url!, authorization: req.headers.authorization, body };
      calls.push(call);
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `no ${req.url} here`, type: 'not_found' } }));
        return;
      }
      const messages = (body?.messages ?? []) as Array<{ role: string }>;
      const main = Array.isArray(body?.tools) && (body!.tools as Array<{ function: { name: string } }>).some((tool) => tool.function.name === 'Bash');
      // The main loop gets the tool call until it sends a result back; anything else (a side request) the text.
      const reply = main && messages.at(-1)?.role !== 'tool' ? TOOL_CALL : ANSWER;
      call.reply = reply;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end(reply);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const gateway = new AnthropicGatewayService(prisma, disabledAccounts);
  // The upstream rule runs as for any key: the relay's name resolves (to a public address), and the pinned
  // connection the gateway's agent is asked for is opened — to the stand-in, in plain HTTP.
  gateway.resolveHost = async (host) => {
    assert.equal(host, RELAY_HOST);
    return [{ address: '162.159.140.245', family: 4 }];
  };
  gateway.agent = new (class extends HttpsAgent {
    override createConnection(): Socket {
      return net.connect(upstreamPort, '127.0.0.1');
    }
  })();
  @Module({ controllers: [AnthropicGatewayController], providers: [{ provide: AnthropicGatewayService, useValue: gateway },
      { provide: AnthropicLoginGatewayService, useValue: {} }] })
  class GatewayDoors {}
  const app = await NestFactory.create(GatewayDoors, { bodyParser: false, logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const scratch = mkdtempSync(path.join(tmpdir(), 'gw-chat-cli-'));

  t.after(async () => {
    await app.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    disabledAccounts.onModuleDestroy();
    await db.$disconnect();
    await client.end();
    rmSync(scratch, { recursive: true, force: true });
  });

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `cy-${ownerId}@chat-gateway-e2e.invalid`, name: 'Cy', passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'cy-runner', tokenHash: sha256(generateToken(32)),
      status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'cy-agent', enabled: true, workDir: '/tmp/cy' } });

  const secret = `sk-relay-${randomUUID().replace(/-/g, '')}`;
  const MODEL = 'relay-coder';
  const compatible = (label: string, baseUrl: string, apiKey = `sk-relay-${randomUUID().replace(/-/g, '')}`) =>
    providers.create(ownerId, {
      label, runtime: 'kimi', baseUrl, apiKey,
      models: [{ value: MODEL, label: 'Relay Coder', contextWindow: 200_000 }],
    } as never) as Promise<{ id: string; slug: string; engines: string[] }>;

  let key!: { id: string; slug: string; engines: string[] };
  await t.test('(1) an OpenAI-compatible key lists Claude Code exactly when its endpoint passes the upstream rule', async () => {
    key = await compatible('Relay', `https://${RELAY_HOST}/v1`, secret);
    assert.deepEqual(key.engines, ['kimi', 'claude', 'opencode'], 'Claude Code after the native engine, Kimi (D7)');
    assert.deepEqual((await compatible('Unlisted', 'https://llm.unlisted-e2e.example/v1')).engines, ['kimi', 'opencode'], 'a host the admin did not list');
    assert.deepEqual((await compatible('Plain', `http://${RELAY_HOST}/v1`)).engines, ['kimi', 'opencode'], 'not https');
    assert.deepEqual((await compatible('Moonshot', 'https://api.moonshot.ai/v1')).engines, ['kimi', 'opencode'], 'Moonshot is not listed either');
    // The list the clients read says the same.
    const listed = (await providers.listMine(ownerId)) as unknown as Array<{ id: string; engines: string[] }>;
    assert.deepEqual(listed.find((row) => row.id === key.id)?.engines, ['kimi', 'claude', 'opencode']);
  });

  let token = '';
  await t.test('(2) a Claude Code session on it completes a streamed turn with a tool call and its result, and its usage and cost are booked', async () => {
    const sessionId = (await sessions.create(ownerId, {
      prompt: 'Run `echo hi` with the Bash tool, then say whether it worked.', title: 'relay', workspaceId,
      provider: key.slug, engine: 'claude', model: MODEL,
    } as never)).id;
    await db.session.update({ where: { id: sessionId }, data: { turnState: 'QUEUED', cancelRequestedAt: null } });
    const claimed = await queue.claimSessionForRunner({ id: runnerId });
    assert.ok(claimed, 'the runner was offered no session');
    assert.equal(claimed.sessionId, sessionId);
    const env = claimed.agent.env!;
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://orbit.chat-gateway-e2e.invalid/api/gw/anthropic', 'the engine is pointed at the gateway');
    assert.ok(env.ANTHROPIC_AUTH_TOKEN.startsWith(KEY_GATEWAY_TOKEN_PREFIX), 'a minted token, never the key');
    token = env.ANTHROPIC_AUTH_TOKEN;
    assert.ok(!Object.values(env).includes(secret), 'the key is in no variable the engine gets');
    assert.equal(env.ANTHROPIC_MODEL, MODEL);
    await db.session.update({ where: { id: sessionId }, data: { turnState: 'IN_FLIGHT' } });

    // The CLI as the runner spawns it (claude_spawn.go's flags) with the environment the claim handed it; only the
    // gateway's origin is this spec's.
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
        ...env,
        ANTHROPIC_BASE_URL: `${base}/api/gw/anthropic`,
        PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), TERM: 'dumb', IS_SANDBOX: '1',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Run `echo hi` with the Bash tool, then say whether it worked.' }] } })}\n`);
    const timer = setTimeout(() => child.kill('SIGKILL'), 170_000);
    const events: Array<Record<string, unknown> & { type: string }> = [];
    for await (const line of createInterface({ input: child.stdout })) {
      let event: Record<string, unknown> & { type: string };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      events.push(event);
      if (event.type === 'result') child.stdin.end();
    }
    clearTimeout(timer);

    // What the CLI did: called Bash with the streamed arguments, ran it, and ended the turn with the answer.
    const result = events.find((e) => e.type === 'result');
    assert.ok(result, 'the CLI reported the turn');
    assert.equal(result.subtype, 'success', JSON.stringify(result));
    assert.equal(result.is_error, false);
    assert.equal(result.result, 'The command completed successfully.');
    const blocks = (type: string) => events.filter((e) => e.type === type)
      .flatMap((e) => ((e.message as { content?: unknown } | undefined)?.content ?? []) as Array<Record<string, unknown>>)
      .filter((b) => typeof b === 'object');
    const toolUse = blocks('assistant').find((b) => b.type === 'tool_use');
    assert.deepEqual(toolUse && { id: toolUse.id, name: toolUse.name, input: toolUse.input },
      { id: 'tool_qA7BBUA5qKEuJOWNQY88URNC', name: 'Bash', input: { command: 'echo hi' } });
    const toolResult = blocks('user').find((b) => b.type === 'tool_result');
    assert.equal(toolResult?.tool_use_id, 'tool_qA7BBUA5qKEuJOWNQY88URNC');
    assert.match(JSON.stringify(toolResult?.content), /hi/, 'the command really ran');
    assert.equal(blocks('assistant').find((b) => b.type === 'text')?.text, 'The command completed successfully.');

    // What the key's endpoint saw: Chat Completions only, with the key, and the tool's output sent back.
    assert.ok(calls.length >= 2, `the endpoint was asked ${calls.length} times`);
    assert.deepEqual([...new Set(calls.map((c) => `${c.method} ${c.url}`))], ['POST /v1/chat/completions'], 'no /responses, no token count');
    for (const call of calls) {
      assert.equal(call.authorization, `Bearer ${secret}`, 'the key, decrypted for the request');
      assert.equal(call.body!.stream, true);
      assert.deepEqual(call.body!.stream_options, { include_usage: true });
      assert.equal(call.body!.model, MODEL);
    }
    const main = calls.filter((c) => (c.body!.messages as Array<{ role: string }>).at(-1)?.role === 'tool');
    assert.equal(main.length, 1, 'one request carried the tool result');
    const messages = main[0].body!.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0].role, 'system');
    const assistant = messages.at(-2)!;
    assert.equal(assistant.role, 'assistant');
    assert.deepEqual(assistant.tool_calls, [{ id: 'tool_qA7BBUA5qKEuJOWNQY88URNC', type: 'function', function: { name: 'Bash', arguments: '{"command":"echo hi"}' } }]);
    assert.match(String(assistant.reasoning_content), /^The user wants one short sentence/, 'the streamed reasoning goes back with its call');
    const tool = messages.at(-1)!;
    assert.equal(tool.tool_call_id, 'tool_qA7BBUA5qKEuJOWNQY88URNC');
    assert.match(String(tool.content), /hi/);

    // What Orbit booked: one usage row and one key_gateway_usage row per answer, priced, added to the session's cost.
    const expected = calls.map((c) => c.reply!).map((body) => {
      const u = usageOf(body);
      const priced = { input_tokens: u.prompt_tokens, input_tokens_details: { cached_tokens: 0 }, output_tokens: u.completion_tokens };
      return { input: u.prompt_tokens, output: u.completion_tokens, reasoning: u.completion_tokens_details.reasoning_tokens, micros: responseCostMicros('kimi-for-coding', undefined, priced) };
    });
    let rows: Array<{ provider_id: string; model: string; input_tokens: string; cached_input_tokens: string; output_tokens: string; reasoning_tokens: string; cost_micros: string }> = [];
    for (let i = 0; i < 50 && rows.length < calls.length; i += 1) {
      rows = (await client.query(
        `SELECT provider_id::text, model, input_tokens::text, cached_input_tokens::text, output_tokens::text, reasoning_tokens::text,
                cost_micros::text FROM key_gateway_usage WHERE session_id = $1::uuid ORDER BY id`, [sessionId])).rows;
      if (rows.length < calls.length) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const sort = <T>(list: T[]) => list.map((r) => JSON.stringify(r)).sort();
    assert.deepEqual(sort(rows), sort(expected.map((e) => ({
      provider_id: key.id, model: 'kimi-for-coding', input_tokens: String(e.input), cached_input_tokens: '0',
      output_tokens: String(e.output), reasoning_tokens: String(e.reasoning), cost_micros: String(e.micros),
    }))));
    const usageRows = (await client.query<{ model: string; input_tokens: string; output_tokens: string; cost_usd: number }>(
      'SELECT model, input_tokens::text, output_tokens::text, cost_usd FROM usage WHERE session_id = $1::uuid ORDER BY id', [sessionId])).rows;
    assert.deepEqual(sort(usageRows), sort(expected.map((e) => ({
      model: 'kimi-for-coding', input_tokens: String(e.input), output_tokens: String(e.output), cost_usd: e.micros / 1_000_000,
    }))));
    const { costUsd } = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { costUsd: true } });
    const total = expected.reduce((sum, e) => sum + e.micros, 0) / 1_000_000;
    assert.ok(total > 0);
    assert.ok(Math.abs(costUsd - total) < 1e-9, `cost_usd ${costUsd}, the answers priced ${total}`);
  });

  await t.test('(3) switching the key off revokes its gateway tokens, and the gateway refuses them from then on', async () => {
    const live = await gateway.caller(token);
    assert.ok(live && typeof live === 'object' && live.key.dialect === 'openai-compatible', 'the token serves while the key is on');
    await providers.update(ownerId, key.id, { enabled: false } as never);
    const { rows } = await client.query<{ revoked: boolean }>(
      'SELECT revoked_at IS NOT NULL AS revoked FROM key_gateway_token WHERE provider_id = $1::uuid', [key.id]);
    assert.ok(rows.length > 0 && rows.every((r) => r.revoked), 'every token of the key is revoked');
    assert.equal(await gateway.caller(token), null);
  });
});
