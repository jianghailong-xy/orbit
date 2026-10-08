/**
 * A Codex pool of the account owner's own ChatGPT login, through the pool gateway, end to end on real
 * PostgreSQL (P3-b; migrations 0323/0324): the real controller behind main.ts's own layers, sessions
 * claimed by the real claim, and a recorder standing where ChatGPT's Codex backend and OpenAI's token
 * endpoint stand (POOL_LOGIN_UPSTREAM and POOL_LOGIN_TOKEN_ENDPOINT — in production CHATGPT_CODEX_BASE and
 * OPENAI_OAUTH_TOKEN_URL, which nothing can change).
 *
 *  (1) The contract. A request a session's codex really sent through its configured provider
 *      (fixtures/codex-gateway-recording.json) reaches the backend in the shape the official codex CLI
 *      sends a ChatGPT login's turn there (fixtures/codex-chatgpt-backend-recording.json, recorded by
 *      runner-go codex_chatgpt_backend_recording_test.go): the same path, the login as
 *      `Authorization: Bearer` and `ChatGPT-Account-ID`, and codex's body in the CLI's own shape — the
 *      built-in provider's `guardian_credits_requested` field added and the body zstd-compressed, plus
 *      its `version` and `x-codex-routing-hint` headers — with every other header as codex sent it. The
 *      backend's recorded stream comes back byte for byte, window headers and all; its usage goes into
 *      the ledger for that session and hour, and its window reading onto the account. The claim hands the
 *      runner the gateway and a token, and nothing of the login.
 *  (2) A token is refused (401) once its session ended, moved to another provider or is not its person's,
 *      it expired or was revoked, or its pool was deleted; a good one reaches nothing but POST /responses
 *      (403) — and none of it reaches the backend. A session whose account the pool no longer holds keeps
 *      its token and is answered 403, as a pool holding no account is.
 *  (3) usage_limit_reached (recorded): answered as it came, asked once, and the account recorded spent
 *      until the reset it names; the session is owed the line, its failed turn waits for that reset, and it
 *      stays on the same account; the claim that runs it again has a resident engine say the line first;
 *      the next answer the backend takes clears the mark.
 *  (4) A 401: refreshed exactly as the codex CLI refreshes (recorded), and sent once more on the new token;
 *      the new pair stored, encrypted, in place of the old. An access token about to expire is refreshed
 *      before it is sent — or sent as it is while the token endpoint cannot be reached; two requests
 *      refused at once refresh once.
 *  (5) A refresh the token endpoint refuses, or a 401 on a token just refreshed: SIGNED_OUT with the
 *      reason, answered 403 — "only you can sign in again" — and the session told; nothing more goes out.
 *      Only the owner can sign in again, and the same session goes on when they do.
 *  (6) A rate limit (recorded) is waited out on the same login, and marks nothing — the short mark that
 *      holds the account out of new claims (0302… 0382) is left only when the gateway's own wait is spent
 *      and the 429 goes back to codex, which does not retry one.
 *  (7) The ledger: per session and hour, summed; a row whose session is gone before the write is dropped.
 *  (8) No database connection is held while a response streams.
 *  (9) Nothing the gateway logged carries a token, in the clear or encrypted.
 * (10) The account is the session's, not the token's (migration 0355): a token minted on one account
 *      follows its session to another — the backend gets the new account's ChatGPT-Account-ID and access
 *      token — and taking the account it was minted on out of the pool leaves it working. A session whose
 *      account the pool no longer holds, or which has none, is answered as a pool holding no account, and
 *      nothing goes out.
 *
 * It only adds rows, and refuses to run anywhere but the disposable server `coordinator-pg-test-safety`
 * identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import test from 'node:test';
import { zstdDecompressSync } from 'node:zlib';

import { Logger, Module, NotFoundException, ValidationPipe, type LoggerService } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { PrismaPg } from '@prisma/adapter-pg';
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
import { sha256 } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { maskedAccount } from './codex-login';
import { CODEX_OAUTH_CLIENT_ID, loginMissingReason } from './codex-login-gateway';
import { CodexLoginService } from './codex-login.service';
import { responseCostMicros } from './openai-prices';
import { ProviderPlanUsageService } from './plan-usage.service';
import { outsideThePoolGateway, PoolGatewayController } from './pool-gateway.controller';
import { PoolGatewayService } from './pool-gateway.service';
import { PoolLoginGatewayService } from './pool-login-gateway.service';
import { loginUsageWindowStart, PoolLoginLedger } from './pool-login-ledger';
import { PoolUsageLedger } from './pool-usage-ledger';
import { decryptSecret, encryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';
import { SharedPoolsService } from './shared-pools.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'pool-login-gateway-spec';
process.env.PUBLIC_ORIGIN = 'https://orbit.pool-login-gateway.invalid';

const realtime = new Proxy(
  {},
  { get: (_target, key) => (key === 'then' ? undefined : () => undefined) },
) as RealtimeService;

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(path.resolve(__dirname, `../../src/providers/fixtures/${name}`), 'utf8')) as T;

/** A value as text, BigInts and all — for asserting what a payload does not contain. */
const text = (value: unknown) => JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));

interface Exchange { method: string; path: string; headers: Array<[string, string]>; bodyBase64: string }
interface Answered { status: number; headers: Array<[string, string]>; bodyBase64: string }
interface Verdict { turnStatus: string; requests: number; errorMessage?: string; codexErrorInfo?: unknown; willRetry: boolean }

/** What a session's codex (0.158) sends through its configured provider — the gateway's input. */
const SESSION = fixture<{ codex: string; request: Exchange }>('codex-gateway-recording.json');
/** What the official codex CLI (0.158) sends a ChatGPT login's backend, and what it makes of the answers. */
const CLI = fixture<{
  codex: string;
  account: string;
  refreshToken: string;
  turn: { request: Exchange; response: Answered; codex: Verdict };
  refresh: { rejected: { request: Exchange; response: Answered }; token: { request: Exchange; response: Answered }; resent: Exchange; codex: Verdict };
  usageLimit: { request: Exchange; response: Answered; codex: Verdict };
  rateLimit: { request: Exchange; response: Answered; codex: Verdict };
}>('codex-chatgpt-backend-recording.json');

const SESSION_BODY = Buffer.from(SESSION.request.bodyBase64, 'base64');
const bodyOf = (answered: Answered) => Buffer.from(answered.bodyBase64, 'base64');
const headersOf = (answered: Answered) => Object.fromEntries(answered.headers);
const RECORDED_STREAM = bodyOf(CLI.turn.response);
/** The usage the recorded stream's `response.completed` carries. */
const RECORDED_USAGE = { input_tokens: 11290, input_tokens_details: { cached_tokens: 9984 }, output_tokens: 57 };
/** The reset the recorded 429 and window headers name: 2100-01-01T00:00:00Z. */
const RECORDED_RESET = new Date(4102444800 * 1000);

/** Codex's own headers, with `token` as its credential; `host` and the length are the transport's. */
function codexHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of SESSION.request.headers) {
    if (name === 'host' || name === 'content-length' || name === 'authorization') continue;
    headers[name] = value;
  }
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return headers;
}

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: object) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.signature`;
const FAR = 4102444800; // 2100-01-01: an access token that is nowhere near its expiry

/** Every credential this spec makes, for (9). */
const MADE: string[] = [];

/** A ChatGPT login's pair, as the CLI would hold one for `accountId`. */
function pair(accountId: string, email: string, exp = FAR, plan = 'plus') {
  const claims = { email, exp, 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: plan } };
  const made = { access: jwt({ ...claims, nonce: randomUUID() }), refresh: `rt_${randomUUID()}`, exp: new Date(exp * 1000) };
  MADE.push(made.access, made.refresh);
  return made;
}

interface Person { name: string; id: string; email: string; runnerId: string; workspaceId: string }

async function person(db: PrismaClient, name: string): Promise<Person> {
  const id = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const email = `${name}-${id}@pool-login-gateway.invalid`;
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

/** One request the recorder standing in for the backend or the token endpoint was sent. */
interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer }

/** What the recorder answers with; `hold` keeps the second half of the body back that long. */
interface Scripted { status: number; headers?: Record<string, string>; body: Buffer; hold?: number }

const jsonAnswer = (status: number, value: unknown, headers: Record<string, string> = {}): Scripted => ({
  status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(value)),
});

/** A Responses stream like the recorded one, for `usage` of its own. */
function streamWith(usage: { input: number; cached: number; output: number }, hold?: number): Scripted {
  const response = {
    id: 'resp_spec', object: 'response', status: 'completed', model: 'gpt-5.1-codex', service_tier: 'default', output: [],
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
  return { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' }, body: Buffer.from(text), hold };
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

/** Waits for `check` to hold, as a write that happens after an answer's end does. */
async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let polls = 0; polls < 100; polls += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`never: ${what}`);
}

const suite = URL ? test : test.skip;

suite("a login pool's gateway, end to end on real PostgreSQL", { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  // The gateway's own client has ONE connection: a request that held it while its answer streamed would
  // hold every other query of the gateway up behind it — which (8) measures.
  const gatewayDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL!, max: 1 }) });
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const sessions = new SessionsService(prisma, queue, realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const pools = new SharedPoolsService(prisma, realtime, providers);
  const logins = new CodexLoginService(prisma, realtime);
  const ledger = new PoolLoginLedger(prisma);
  const runnerApi = new RunnerApiController(
    db as never, queue as never, realtime as never, {} as never, {} as never,
    // Delivering a message expands its #references; this spec's messages have none.
    { expand: async (_ownerId: string, content?: string) => content } as never,
  );

  // ChatGPT's Codex backend and OpenAI's token endpoint, as far as the gateway can tell.
  const seen: Seen[] = [];
  const script: Scripted[] = [];
  const tokenScript: Scripted[] = [];
  /** When set, answers every backend request instead of the script (a refusal keyed on the credential). */
  let backend: ((request: Seen) => Scripted | undefined) | null = null;
  const upstream: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(request);
      let answer: Scripted;
      if (request.url === '/oauth/token') {
        answer = tokenScript.shift() ?? jsonAnswer(500, { error: 'no refresh was scripted' });
      } else {
        answer = backend?.(request) ?? script.shift() ?? {
          status: CLI.turn.response.status, headers: headersOf(CLI.turn.response), body: RECORDED_STREAM,
        };
      }
      res.writeHead(answer.status, answer.headers ?? {});
      // In two pieces, as a stream arrives: the gateway must pass on what it has, not wait for the end.
      const half = Math.floor(answer.body.length / 2);
      res.write(answer.body.subarray(0, half));
      setTimeout(() => res.end(answer.body.subarray(half)), answer.hold ?? 20);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const recorder = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const gateway = new PoolLoginGatewayService(
    gatewayDb as unknown as PrismaService, logins, ledger, realtime, `${recorder}/backend-api/codex`, `${recorder}/oauth/token`,
  );
  // A shared pool's token, or none at all, is the other gateway's: present, and never reached here.
  const sharedGateway = new PoolGatewayService(prisma, pools, new PoolUsageLedger(prisma), `${recorder}/v1`);

  @Module({
    controllers: [PoolGatewayController],
    providers: [
      { provide: PoolGatewayService, useValue: sharedGateway },
      { provide: PoolLoginGatewayService, useValue: gateway },
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
  // Everything the gateway logs, for (9): every credential this spec makes is kept to look for there.
  const logged: string[] = [];
  const secrets: string[] = [];
  const capture = (message: unknown) => {
    logged.push(String(message));
  };
  const captured: LoggerService = { log: capture, warn: capture, error: capture, debug: capture, verbose: capture, fatal: capture };
  Logger.overrideLogger(captured);

  const scratch = await mkdtemp(join(tmpdir(), 'pool-login-gateway-spec-'));
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => upstream.close(resolve));
    await gatewayDb.$disconnect();
    await db.$disconnect();
    await client.end();
    await rm(scratch, { recursive: true, force: true });
  });

  /** Codex's recorded request, sent with `token`. */
  const ask = (token: string | null, method = 'POST', urlPath = '/api/gw/codex/responses') =>
    exchange(base, method, urlPath, codexHeaders(token), method === 'GET' ? undefined : SESSION_BODY);
  const backendRequests = () => seen.filter((request) => request.url !== '/oauth/token');
  const tokenRequests = () => seen.filter((request) => request.url === '/oauth/token');

  /** The runner asking for work — which has to be `sessionId` — leaving it RUNNING or parked, as a turn would. */
  async function claim(who: Person, sessionId: string, park = true): Promise<ClaimedSession> {
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
      select: { ownerId: true, provider: true, poolCodexAccountId: true, poolSwitchNotice: true, retryAt: true, status: true },
    });
  const loginRow = (poolId: string, accountId: string) =>
    db.poolCodexLogin.findUniqueOrThrow({ where: { poolId_accountId: { poolId, accountId } } });
  const carriers = (sessionId: string) =>
    db.conversationTurn.findMany({ where: { sessionId, kind: 'reload' }, select: { content: true, status: true } });
  const dequeue = (who: Person, sessionId: string) =>
    (runnerApi as unknown as {
      dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: string | null): Promise<
        { turnId: string; kind: string; env?: Record<string, string> } | null
      >;
    }).dequeueTurn(sessionId, who.runnerId, null);

  const owner = await person(db, 'Owner');
  const stranger = await person(db, 'Stranger');

  /** One more ChatGPT account signed in on `poolId`, as the sign-in would store it. */
  /**
   * How many accounts this spec has added, so each gets a `created_at` of its own: the column is
   * TIMESTAMP(3), and two rows added within the same millisecond order by their random account id — which
   * one a claim lands on would be a coin flip (the pool's accounts are ordered by `created_at` first).
   */
  let accountsAdded = 0;
  async function addAccount(poolId: string, access?: { exp?: number }) {
    const accountId = `acct-${randomUUID()}`;
    const email = `owner-${randomUUID().slice(0, 8)}@chatgpt.invalid`;
    const login = pair(accountId, email, access?.exp ?? FAR);
    const stored = await db.poolCodexLogin.create({
      data: {
        poolId, userId: owner.id, accountId, email, plan: 'plus',
        accessTokenEnc: encryptSecret(login.access), refreshTokenEnc: encryptSecret(login.refresh), expiresAt: login.exp,
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000 + accountsAdded++ * 60_000),
      },
    });
    secrets.push(stored.accessTokenEnc, stored.refreshTokenEnc);
    return { accountId, email, login };
  }

  /** A Codex pool of the owner's own, with a ChatGPT account signed in as the sign-in would store it. */
  async function world(label: string, access?: { exp?: number }) {
    const made = await providers.createPool(owner.id, { label, engine: 'codex' });
    const { accountId, email, login } = await addAccount(made.id, access);
    const sessionOf = async () =>
      (await sessions.create(owner.id, { prompt: 'hello', title: label, workspaceId: owner.workspaceId, provider: made.slug })).id;
    return { id: made.id, slug: made.slug, label, accountId, email, login, sessionOf };
  }

  await t.test('(1) a request a session\'s codex sent reaches the backend in the codex CLI\'s own shape, on the login, and the stream comes back byte for byte', async () => {
    // Both halves of the contract were recorded off the same codex.
    assert.equal(SESSION.codex, CLI.codex);
    const pool = await world('Replay');
    const session = await pool.sessionOf();
    const claimed = await claim(owner, session);
    const token = tokenOf(claimed);

    // The claim: the gateway and a token of the login pool's own kind — and nothing of the login.
    assert.equal(claimed.agent.provider, 'codex');
    assert.equal(claimed.agent.env!.OPENAI_BASE_URL, 'https://orbit.pool-login-gateway.invalid/api/gw/codex');
    assert.match(token, /^orbit-gwl-/);
    const stored = await loginRow(pool.id, pool.accountId);
    for (const secret of [pool.login.access, pool.login.refresh, stored.accessTokenEnc, stored.refreshTokenEnc]) {
      assert.ok(!Object.values(claimed.agent.env!).some((value) => value.includes(secret)), 'the claim carried the login');
      assert.ok(!text(claimed).includes(secret), 'the claim carried the login');
    }
    assert.equal((await sessionRow(session)).poolCodexAccountId, pool.accountId, 'the session names the account it runs on');
    // The token names its (pool, person, session) and no account at all (migration 0355).
    const minted = await db.poolLoginToken.findMany({ where: { sessionId: session } });
    assert.deepEqual(minted.map((row) => [row.poolId, row.userId]), [[pool.id, owner.id]]);
    assert.deepEqual(Object.keys(minted[0]).filter((column) => column.includes('account')), []);
    assert.ok(!JSON.stringify(minted).includes(token), 'the token is stored, not its hash');
    // The session's own read names no account id.
    assert.ok(!text(await sessions.get(owner.id, session)).includes(pool.accountId), 'a session read names the account id');

    seen.length = 0;
    const answer = await ask(token);
    assert.equal(answer.status, 200, answer.body.toString('utf8'));
    assert.ok(answer.body.equals(RECORDED_STREAM), 'the stream codex got back is not the stream the backend sent');
    for (const [name, value] of CLI.turn.response.headers) {
      assert.equal(answer.headers[name], value, `the backend's ${name} header did not come back`);
    }

    const [sent, ...more] = backendRequests();
    assert.deepEqual(more, [], 'one request from codex is one request to the backend');
    const cli = CLI.turn.request;
    const cliHeaders = Object.fromEntries(cli.headers);
    // The CLI's own path, credential and account header, the login's.
    assert.equal(sent.method, cli.method);
    assert.equal(sent.url, cli.path);
    assert.match(cliHeaders.authorization, /^Bearer ey/);
    assert.equal(sent.headers.authorization, `Bearer ${pool.login.access}`);
    assert.equal(cliHeaders['chatgpt-account-id'], CLI.account);
    assert.equal(sent.headers['chatgpt-account-id'], pool.accountId);
    // The backend body: codex's own, in the CLI's built-in-provider shape — zstd-compressed, and carrying
    // the metadata field a configured provider omits.
    assert.equal(cliHeaders['content-encoding'], 'zstd');
    assert.equal(sent.headers['content-encoding'], 'zstd');
    const backendBody = JSON.parse(zstdDecompressSync(sent.body).toString('utf8')) as Record<string, unknown>;
    const cliBody = JSON.parse(zstdDecompressSync(Buffer.from(cli.bodyBase64, 'base64')).toString('utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(backendBody).sort(), Object.keys(cliBody).sort());
    for (const field of ['model', 'instructions', 'store', 'stream', 'include', 'tool_choice', 'parallel_tool_calls', 'reasoning']) {
      assert.deepEqual(backendBody[field], cliBody[field], `the request's ${field} is not the CLI's`);
    }
    assert.equal(
      (backendBody.client_metadata as Record<string, unknown>).guardian_credits_requested,
      (cliBody.client_metadata as Record<string, unknown>).guardian_credits_requested,
      "the backend body does not carry the CLI's guardian_credits_requested",
    );
    // Every other header as codex sent it, plus the three the built-in provider adds — which now match the
    // CLI's own, so nothing separates the two requests but the credential and the account.
    for (const [name, value] of Object.entries(codexHeaders(null))) {
      assert.equal(sent.headers[name], value, `codex's ${name} header did not arrive as sent`);
    }
    const builtin = ['content-encoding', 'version', 'x-codex-routing-hint'].sort();
    const transport = new Set(['host', 'connection', 'content-length', 'authorization', 'chatgpt-account-id']);
    assert.deepEqual(
      Object.keys(sent.headers).filter((name) => !(name in codexHeaders(null)) && !transport.has(name)).sort(),
      builtin,
      'the gateway added headers that are not the built-in provider\'s',
    );
    for (const name of ['version', 'x-codex-routing-hint']) {
      assert.equal(sent.headers[name], cliHeaders[name], `the gateway's ${name} is not the CLI's`);
    }
    assert.deepEqual(
      Object.keys(cliHeaders).filter((name) => !(name in sent.headers)).sort(),
      [],
      'a header the CLI sends the backend is missing from what the gateway sent',
    );
    assert.ok(!JSON.stringify(sent.headers).includes(token), 'the session token went on to the backend');

    // Its use, priced, for this session and hour; the window reading onto the account.
    await ledger.flush();
    const [row, ...others] = await db.poolLoginUsage.findMany({ where: { sessionId: session } });
    assert.deepEqual(others, []);
    assert.deepEqual(
      {
        pool: row.poolId, account: row.accountId, window: row.windowStart.toISOString(), requests: row.requests,
        input: row.inputTokens, cached: row.cachedInputTokens, output: row.outputTokens, cost: row.costMicros,
      },
      {
        pool: pool.id, account: pool.accountId, window: loginUsageWindowStart(new Date()).toISOString(), requests: 1,
        input: 11290n, cached: 9984n, output: 57n, cost: BigInt(responseCostMicros('gpt-5.1-codex', 'default', RECORDED_USAGE)),
      },
    );
    const read = await loginRow(pool.id, pool.accountId);
    assert.ok(read.usageReadAt);
    const { fetchedAt, ...reading } = read.usage as Record<string, unknown>;
    assert.ok(typeof fetchedAt === 'string');
    assert.deepEqual(reading, {
      provider: 'codex',
      limitId: 'codex',
      primary: { utilization: 42, resetsAt: '2100-01-01T00:00:00.000Z', windowDurationMins: 300 },
      secondary: { utilization: 64, resetsAt: '2100-01-04T00:00:00.000Z', windowDurationMins: 10080 },
    });
    // The pool page reads it.
    const page = await providers.getPool(owner.id, pool.id);
    assert.deepEqual((page as { login: { usage: unknown; usageUnavailable: unknown } }).login.usage, read.usage);
    assert.equal((page as { login: { usageUnavailable: unknown } }).login.usageUnavailable, null);
  });

  await t.test('(2) a token is refused once its session ended, moved or is not its person\'s, it expired or was revoked, or its pool went — and a good one reaches nothing but POST /responses', async () => {
    const pool = await world('Doors');
    const refused = async (token: string | null, why: string) => {
      const answer = await ask(token);
      assert.equal(answer.status, 401, why);
      assert.equal(errorOf(answer).code, 'orbit_gateway_token_invalid', why);
    };
    seen.length = 0;
    await refused(null, 'no credential at all');
    await refused(`orbit-gwl-${randomUUID()}${randomUUID()}`, 'a token nobody minted');

    const session = await pool.sessionOf();
    let token = tokenOf(await claim(owner, session));
    assert.equal((await ask(token)).status, 200);
    seen.length = 0;

    // Outside the path list: refused, whatever the token — every other path the CLI itself asks a ChatGPT
    // backend for included.
    for (const [method, urlPath] of [
      ['GET', '/api/gw/codex/responses'],
      ['POST', '/api/gw/codex/responses/compact'],
      ['GET', '/api/gw/codex/models'],
      ['POST', '/api/gw/codex/models'],
      ['POST', '/api/gw/codex/analytics-events/events'],
      ['GET', '/api/gw/codex/wham/accounts/check'],
      ['POST', '/api/gw/codex/chat/completions'],
      ['POST', '/api/gw/codex/backend-api/codex/responses'],
      ['POST', '/api/gw/codex'],
    ] as const) {
      const answer = await ask(token, method, urlPath);
      assert.equal(answer.status, 403, `${method} ${urlPath}`);
      assert.equal(errorOf(answer).code, 'orbit_gateway_path_not_allowed', `${method} ${urlPath}`);
    }
    assert.equal(seen.length, 0, 'a refused request reached the backend');

    // The session ends, then is completed; open again, the token is good again.
    await db.session.update({ where: { id: session }, data: { status: RunStatus.CANCELLED } });
    await refused(token, 'the session ended');
    await db.session.update({ where: { id: session }, data: { status: RunStatus.AWAITING_INPUT, completedAt: new Date() } });
    await refused(token, 'the session was completed');
    await db.session.update({ where: { id: session }, data: { completedAt: null } });
    assert.equal((await ask(token)).status, 200, 'an open session again: its token is good again');

    // The session moves to another provider.
    await db.session.update({ where: { id: session }, data: { provider: 'codex', providerBuiltin: true } });
    await refused(token, 'the session moved to another provider');
    await db.session.update({ where: { id: session }, data: { provider: pool.slug, providerBuiltin: false } });

    // Expired, and revoked.
    token = tokenOf(await claim(owner, session));
    await db.poolLoginToken.updateMany({ where: { sessionId: session }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await refused(token, 'the token expired');
    token = tokenOf(await claim(owner, session));
    await db.poolLoginToken.updateMany({ where: { sessionId: session }, data: { revokedAt: new Date() } });
    await refused(token, 'the token was revoked');

    // Not its person's: a token of the owner's pool on a session somebody else owns is nobody's. (Its person
    // is held to the pool's owner by the table itself; the session is what could be another's.)
    const theirs = (await sessions.create(stranger.id, { prompt: 'hello', title: 'theirs', workspaceId: stranger.workspaceId, provider: 'codex' })).id;
    await db.session.update({ where: { id: theirs }, data: { provider: pool.slug, providerBuiltin: false } });
    const foreign = `orbit-gwl-${randomUUID()}`;
    await db.poolLoginToken.create({
      data: { tokenHash: sha256(foreign), poolId: pool.id, userId: owner.id, sessionId: theirs, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    await refused(foreign, "a session that is not the token's person's");
    await assert.rejects(
      db.poolLoginToken.create({
        data: { tokenHash: sha256(`orbit-gwl-${randomUUID()}`), poolId: pool.id, userId: stranger.id, sessionId: theirs, expiresAt: new Date(Date.now() + 3_600_000) },
      }),
      'a token naming anybody but the pool\'s owner was stored',
    );

    // The account the session ran on is taken out of the pool: the token stays — it names no account
    // (migration 0355) — and the gateway answers it as a pool holding no account, which is 403, not 401.
    token = tokenOf(await claim(owner, session));
    assert.equal((await ask(token)).status, 200);
    await logins.signOut(owner.id, pool.id);
    const emptied = await ask(token);
    assert.equal(emptied.status, 403, 'the session whose account left the pool');
    assert.equal(errorOf(emptied).code, 'orbit_pool_login_missing');
    assert.equal(await db.poolLoginToken.count({ where: { sessionId: session } }), 1);

    // The pool is deleted.
    const next = await world('Doors again');
    const nextSession = await next.sessionOf();
    const nextToken = tokenOf(await claim(owner, nextSession));
    assert.equal((await ask(nextToken)).status, 200);
    await providers.removePool(owner.id, next.id);
    await refused(nextToken, 'its pool was deleted');
    assert.equal(seen.filter((request) => request.headers.authorization === `Bearer ${next.login.access}`).length, 1);
  });

  await t.test('(3) usage_limit_reached: answered as it came, asked once, the account spent until its reset; the session is told, waits for the reset, and stays on its account', async () => {
    const pool = await world('Quota');
    const session = await pool.sessionOf();
    const token = tokenOf(await claim(owner, session, false));
    const recorded = CLI.usageLimit;
    // What the codex CLI makes of this answer: usageLimitExceeded, not asked again.
    assert.deepEqual([recorded.codex.codexErrorInfo, recorded.codex.requests, recorded.codex.willRetry], ['usageLimitExceeded', 1, false]);

    // As a turn goes: the runner hands its engine the message, and codex asks the backend.
    const turn = await dequeue(owner, session);
    assert.equal(turn?.kind, 'message');
    script.push({ status: recorded.response.status, headers: headersOf(recorded.response), body: bodyOf(recorded.response) });
    seen.length = 0;
    const answer = await ask(token);
    assert.equal(answer.status, 429);
    assert.ok(answer.body.equals(bodyOf(recorded.response)), "the backend's answer did not go back as it came");
    assert.equal(answer.headers['x-codex-primary-used-percent'], '100.0');
    assert.equal(backendRequests().length, 1, 'a spent subscription is not asked again');
    const spent = await loginRow(pool.id, pool.accountId);
    assert.deepEqual({ state: spent.state, spentUntil: spent.spentUntil }, { state: 'ACTIVE', spentUntil: RECORDED_RESET });
    assert.equal((spent.usage as { primary: { utilization: number } }).primary.utilization, 100);

    // The transcript is owed the reason — by the session row, not by an event of the gateway's own.
    const line = `The 5-hour window on ${pool.email} is spent — this session waits for its reset at 2100-01-01 00:00 UTC`;
    assert.equal((await sessionRow(session)).poolSwitchNotice, line);
    assert.equal(await db.runEvent.count({ where: { sessionId: session } }), 0, 'the gateway wrote into the event stream');
    // A second refusal owes it once.
    script.push({ status: recorded.response.status, headers: headersOf(recorded.response), body: bodyOf(recorded.response) });
    assert.equal((await ask(token)).status, 429);
    assert.equal((await sessionRow(session)).poolSwitchNotice, line);

    // The turn it ended fails as codex reports it, and waits for the reset: no other account to go to.
    await runnerApi.turnComplete({ id: owner.runnerId }, session, {
      turnId: turn!.turnId,
      status: 'FAILED' as TurnCompleteRequest['status'],
      result: recorded.codex.errorMessage,
      numTurns: 0,
      costUsd: 0,
    });
    const failed = await sessionRow(session);
    assert.equal(failed.status, RunStatus.FAILED);
    assert.ok(failed.retryAt, 'no retry was armed for a turn the spent account ended');
    assert.ok(
      failed.retryAt!.getTime() >= RECORDED_RESET.getTime() && failed.retryAt!.getTime() < RECORDED_RESET.getTime() + 60_000,
      `the retry is not the reset: ${failed.retryAt!.toISOString()}`,
    );
    assert.equal(failed.poolCodexAccountId, pool.accountId, 'the session moved off its account');
    assert.deepEqual(await queue.accountPoolResumesAt(owner.id, pool.slug, new Date()), RECORDED_RESET);
    assert.deepEqual(await queue.loginPoolRetryAt(db, failed, new Date()), RECORDED_RESET);
    assert.equal((await providers.getPool(owner.id, pool.id) as { login: { spentUntil: string } }).login.spentUntil, RECORDED_RESET.toISOString());

    // When it goes again it is on the same account, and a resident engine says the line first: the claim
    // queued it a reload that changes nothing.
    const again = tokenOf(await claim(owner, session, false));
    assert.equal((await sessionRow(session)).poolCodexAccountId, pool.accountId);
    assert.deepEqual(await carriers(session), [{ content: '{}', status: 'PENDING' }]);
    assert.equal(await db.poolLoginToken.count({ where: { sessionId: session } }), 2, 'the second claim minted a token beside the first');
    const carrier = await dequeue(owner, session);
    assert.equal(carrier?.kind, 'reload');
    assert.equal(carrier?.env, undefined);
    await runnerApi.events({ id: owner.runnerId }, session, {
      events: [{ seq: 1, type: RunEventType.SYSTEM, ts: new Date().toISOString(), payload: { subtype: 'resumed', reason: 'config_changed', runtime: 'app-server' } }],
    });
    const [said] = await db.runEvent.findMany({ where: { sessionId: session }, select: { payload: true } });
    assert.equal((said.payload as { notice?: string }).notice, line);
    assert.equal((await sessionRow(session)).poolSwitchNotice, null, 'the line is owed once');

    // The limit has reset: the backend takes the next request, and the mark goes.
    seen.length = 0;
    assert.equal((await ask(again)).status, 200);
    assert.equal(backendRequests()[0].headers.authorization, `Bearer ${pool.login.access}`);
    await eventually(async () => (await loginRow(pool.id, pool.accountId)).spentUntil === null, 'the spent mark cleared');
    // And the window reading that answer carried takes the spent one's place at the ledger's next write:
    // a reading with a window used up keeps the account off too (pool-login-select.ts loginCanRun).
    await ledger.flush();
    const read = await loginRow(pool.id, pool.accountId);
    assert.equal((read.usage as { primary: { utilization: number } }).primary.utilization, 42);
    const at = new Date();
    assert.deepEqual(await queue.accountPoolResumesAt(owner.id, pool.slug, at), at);
  });

  await t.test('(4) a 401 is refreshed as the codex CLI refreshes and sent once more on the new token; an expiring token is refreshed first; two refusals refresh once', async () => {
    const pool = await world('Refresh', { exp: FAR });
    const session = await pool.sessionOf();
    const token = tokenOf(await claim(owner, session));
    const fresh = pair(pool.accountId, pool.email, FAR, 'pro');
    // Refused on the old token, taken on the new.
    backend = (request) => (request.headers.authorization === `Bearer ${fresh.access}`
      ? undefined
      : { status: CLI.refresh.rejected.response.status, headers: headersOf(CLI.refresh.rejected.response), body: bodyOf(CLI.refresh.rejected.response) });
    tokenScript.push(jsonAnswer(200, { id_token: fresh.access, access_token: fresh.access, refresh_token: fresh.refresh }));
    seen.length = 0;
    try {
      const answer = await ask(token);
      assert.equal(answer.status, 200, answer.body.toString('utf8'));
      assert.ok(answer.body.equals(RECORDED_STREAM));
    } finally {
      backend = null;
    }
    const [refused, resent, ...rest] = backendRequests();
    assert.deepEqual(rest, []);
    assert.equal(refused.headers.authorization, `Bearer ${pool.login.access}`);
    assert.equal(resent.headers.authorization, `Bearer ${fresh.access}`);
    assert.equal(resent.headers['chatgpt-account-id'], pool.accountId);
    // The retry carries the same built-in-provider shape the first attempt did: the gateway's own body.
    assert.equal(refused.headers['content-encoding'], 'zstd');
    assert.ok(resent.body.equals(refused.body), 'the retry body is not the one the first attempt sent');
    const resentBody = JSON.parse(zstdDecompressSync(resent.body).toString('utf8')) as Record<string, unknown>;
    assert.equal((resentBody.client_metadata as Record<string, unknown>).guardian_credits_requested, 'true');

    // The refresh is the CLI's, field for field, on the stored refresh token.
    const [refresh, ...moreRefreshes] = tokenRequests();
    assert.deepEqual(moreRefreshes, []);
    const cli = CLI.refresh.token.request;
    assert.equal(refresh.method, cli.method);
    assert.equal(refresh.headers['content-type'], Object.fromEntries(cli.headers)['content-type']);
    const cliRefresh = JSON.parse(Buffer.from(cli.bodyBase64, 'base64').toString('utf8')) as Record<string, string>;
    assert.equal(cliRefresh.refresh_token, CLI.refreshToken);
    assert.equal(cliRefresh.client_id, CODEX_OAUTH_CLIENT_ID);
    assert.deepEqual(JSON.parse(refresh.body.toString('utf8')), { ...cliRefresh, refresh_token: pool.login.refresh });
    assert.equal(refresh.body.toString('utf8'), Buffer.from(cli.bodyBase64, 'base64').toString('utf8').replace(CLI.refreshToken, pool.login.refresh));

    // The new pair, stored encrypted in place of the old; the plan the new token names.
    const stored = await loginRow(pool.id, pool.accountId);
    assert.equal(decryptSecret(stored.accessTokenEnc), fresh.access);
    assert.equal(decryptSecret(stored.refreshTokenEnc), fresh.refresh);
    assert.ok(!stored.accessTokenEnc.includes(fresh.access) && !stored.refreshTokenEnc.includes(fresh.refresh));
    assert.deepEqual({ state: stored.state, expiresAt: stored.expiresAt, plan: stored.plan }, { state: 'ACTIVE', expiresAt: fresh.exp, plan: 'pro' });

    // An access token about to expire is refreshed before it is sent.
    const soon = Math.floor(Date.now() / 1000) + 60;
    const expiring = pair(pool.accountId, pool.email, soon);
    await db.poolCodexLogin.update({
      where: { poolId_accountId: { poolId: pool.id, accountId: pool.accountId } },
      data: { accessTokenEnc: encryptSecret(expiring.access), expiresAt: new Date(soon * 1000) },
    });
    const later = pair(pool.accountId, pool.email);
    tokenScript.push(jsonAnswer(200, { access_token: later.access, refresh_token: later.refresh }));
    seen.length = 0;
    assert.equal((await ask(token)).status, 200);
    assert.deepEqual(seen.map((request) => request.url), ['/oauth/token', '/backend-api/codex/responses']);
    assert.equal(backendRequests()[0].headers.authorization, `Bearer ${later.access}`);
    assert.equal(JSON.parse(tokenRequests()[0].body.toString('utf8')).refresh_token, fresh.refresh);

    // The token endpoint down just then: a token with a minute left is sent on as it is, and nothing is marked.
    const minute = Math.floor(Date.now() / 1000) + 60;
    const lastMinute = pair(pool.accountId, pool.email, minute);
    await db.poolCodexLogin.update({
      where: { poolId_accountId: { poolId: pool.id, accountId: pool.accountId } },
      data: { accessTokenEnc: encryptSecret(lastMinute.access), expiresAt: new Date(minute * 1000) },
    });
    tokenScript.push(jsonAnswer(503, { error: 'temporarily_unavailable' }));
    seen.length = 0;
    assert.equal((await ask(token)).status, 200);
    assert.deepEqual(seen.map((request) => request.url), ['/oauth/token', '/backend-api/codex/responses']);
    assert.equal(backendRequests()[0].headers.authorization, `Bearer ${lastMinute.access}`);
    assert.equal((await loginRow(pool.id, pool.accountId)).state, 'ACTIVE');
    await db.poolCodexLogin.update({
      where: { poolId_accountId: { poolId: pool.id, accountId: pool.accountId } },
      data: { accessTokenEnc: encryptSecret(later.access), expiresAt: later.exp },
    });

    // Two requests refused at once: one refresh, both sent again on what it brought.
    const last = pair(pool.accountId, pool.email);
    backend = (request) => (request.headers.authorization === `Bearer ${last.access}`
      ? streamWith({ input: 1, cached: 0, output: 1 })
      : jsonAnswer(401, { error: { message: 'expired', code: 'token_expired' } }));
    tokenScript.push({ ...jsonAnswer(200, { access_token: last.access, refresh_token: last.refresh }), hold: 200 });
    seen.length = 0;
    try {
      const both = await Promise.all([ask(token), ask(token)]);
      assert.deepEqual(both.map((answer) => answer.status), [200, 200]);
    } finally {
      backend = null;
    }
    assert.equal(tokenRequests().length, 1, 'two refusals refreshed twice — a refresh token is good once');
    assert.equal(decryptSecret((await loginRow(pool.id, pool.accountId)).accessTokenEnc), last.access);
  });

  await t.test('(5) a refused refresh, or a 401 on a token just refreshed, signs the account out: 403, the session told, nothing more sent; only its owner signs in again, and the session goes on', async () => {
    const pool = await world('Signed out');
    const session = await pool.sessionOf();
    const token = tokenOf(await claim(owner, session));
    script.push(jsonAnswer(401, { error: { message: 'Your authentication token has expired.', code: 'token_expired' } }));
    tokenScript.push(jsonAnswer(401, { error: { message: 'Your refresh token has expired.', code: 'refresh_token_expired' } }));
    seen.length = 0;
    const answer = await ask(token);
    assert.equal(answer.status, 403);
    const line = `The ChatGPT account ${pool.email} on "Signed out" was signed out by OpenAI — only you can sign in again, on the pool's page`;
    assert.deepEqual(JSON.parse(answer.body.toString('utf8')), {
      error: { message: line, type: 'orbit_gateway', param: null, code: 'orbit_pool_login_signed_out' },
    });
    assert.ok(!answer.body.toString('utf8').includes('refresh token'), "the token endpoint's words reached codex");
    const out = await loginRow(pool.id, pool.accountId);
    assert.deepEqual(
      { state: out.state, lastError: out.lastError },
      { state: 'SIGNED_OUT', lastError: 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.' },
    );
    assert.equal((await sessionRow(session)).poolSwitchNotice, line);

    // Nothing more goes out on it: codex's own retries are answered here.
    seen.length = 0;
    const again = await ask(token);
    assert.equal(again.status, 403);
    assert.equal(errorOf(again).code, 'orbit_pool_login_signed_out');
    assert.equal(seen.length, 0, 'the refusal reached the backend');
    assert.equal(await queue.accountPoolResumesAt(owner.id, pool.slug, new Date()), null, 'no wait brings a signed-out account back');
    assert.equal(await queue.loginPoolRetryAt(db, await sessionRow(session), new Date()), null);
    // The doors refuse a new session on it, with why.
    assert.match(
      String(await queue.accountPoolRefusal(owner.id, pool.slug)),
      /was rejected by OpenAI — sign in again on its page/,
    );

    // Only its owner can sign in again: to anybody else the pool is not there.
    await assert.rejects(logins.start(stranger.id, pool.id), NotFoundException);
    const bin = join(scratch, `codex-${randomUUID()}`);
    const homeFile = join(scratch, `home-${randomUUID()}.txt`);
    const renewed = pair(pool.accountId, pool.email);
    const auth = JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: renewed.access, access_token: renewed.access, refresh_token: renewed.refresh, account_id: pool.accountId }, last_refresh: new Date().toISOString() });
    await writeFile(bin, `#!/usr/bin/env bash
printf '%s' "$CODEX_HOME" > ${JSON.stringify(homeFile)}
printf '1. Open this link in your browser and sign in to your account\\r\\n   https://auth.openai.com/codex/device\\r\\n\\r\\n'
printf '2. Enter this one-time code (expires in 15 minutes)\\r\\n   ABCD-EF123\\r\\n\\r\\n'
while [ ! -f "$CODEX_HOME/approve" ]; do sleep 0.05; done
cat > "$CODEX_HOME/auth.json" <<'AUTHJSON'
${auth}
AUTHJSON
exit 0
`, { mode: 0o755 });
    const previousBin = process.env.CODEX_LOGIN_BIN;
    process.env.CODEX_LOGIN_BIN = bin;
    try {
      await logins.start(owner.id, pool.id);
      let home = '';
      await eventually(async () => (home = await readFile(homeFile, 'utf8').catch(() => '')) !== '', 'the sign-in started its CLI');
      await writeFile(join(home, 'approve'), '');
      let polled = await logins.poll(owner.id, pool.id);
      for (let polls = 0; polls < 200 && polled.status === 'PENDING'; polls += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        polled = await logins.poll(owner.id, pool.id);
      }
      assert.equal(polled.status, 'CONFIRMED');
    } finally {
      process.env.CODEX_LOGIN_BIN = previousBin;
    }
    const back = await loginRow(pool.id, pool.accountId);
    assert.deepEqual({ state: back.state, lastError: back.lastError }, { state: 'ACTIVE', lastError: null });
    // The session's next claim says the line before its turn, on the same account.
    await claim(owner, session);
    assert.deepEqual(await carriers(session), [{ content: '{}', status: 'PENDING' }]);
    assert.equal((await sessionRow(session)).poolCodexAccountId, pool.accountId);
    // And it goes on on the same token too: that was bound to the account, which never left.
    seen.length = 0;
    assert.equal((await ask(token)).status, 200);
    assert.equal(backendRequests()[0].headers.authorization, `Bearer ${renewed.access}`);

    // Refused again on a token just issued: the login itself is refused.
    const other = await world('Refused twice');
    const otherSession = await other.sessionOf();
    const otherToken = tokenOf(await claim(owner, otherSession));
    const issued = pair(other.accountId, other.email);
    backend = () => jsonAnswer(401, { error: { message: 'This account is deactivated.', code: 'account_deactivated' } });
    tokenScript.push(jsonAnswer(200, { access_token: issued.access, refresh_token: issued.refresh }));
    seen.length = 0;
    try {
      assert.equal((await ask(otherToken)).status, 403);
    } finally {
      backend = null;
    }
    assert.deepEqual(backendRequests().map((request) => request.headers.authorization), [`Bearer ${other.login.access}`, `Bearer ${issued.access}`]);
    const deactivated = await loginRow(other.id, other.accountId);
    assert.deepEqual({ state: deactivated.state, lastError: deactivated.lastError }, { state: 'SIGNED_OUT', lastError: 'This account is deactivated.' });
  });

  await t.test('(6) a rate limit is waited out on the same login, and marks nothing', async () => {
    const pool = await world('Limits');
    const session = await pool.sessionOf();
    const token = tokenOf(await claim(owner, session));
    const recorded = CLI.rateLimit;
    // The codex CLI does not ask again on its own: the wait is the gateway's.
    assert.deepEqual([recorded.codex.requests, recorded.codex.willRetry], [1, false]);
    const limited = (): Scripted => ({ status: recorded.response.status, headers: { ...headersOf(recorded.response), 'retry-after': '1' }, body: bodyOf(recorded.response) });
    script.push(limited(), limited());
    seen.length = 0;
    const started = Date.now();
    const answer = await ask(token);
    assert.equal(answer.status, 200);
    assert.ok(answer.body.equals(RECORDED_STREAM));
    assert.ok(Date.now() - started >= 2000, 'the waits the backend asked for were not kept');
    assert.equal(backendRequests().length, 3);
    for (const sent of backendRequests()) {
      assert.equal(sent.headers.authorization, `Bearer ${pool.login.access}`);
      assert.equal(sent.headers['chatgpt-account-id'], pool.accountId);
    }
    const row = await loginRow(pool.id, pool.accountId);
    assert.deepEqual({ state: row.state, spentUntil: row.spentUntil }, { state: 'ACTIVE', spentUntil: null });
    // Waited out inside the request, so nothing is held against the account: no throttle either.
    assert.equal(row.throttledUntil, null);
    assert.equal((await sessionRow(session)).poolSwitchNotice, null);
    assert.deepEqual(await carriers(session), []);
  });

  await t.test("(6) a rate limit that outlasts the gateway's own wait is held against the account", async () => {
    const pool = await world('Throttled');
    const session = await pool.sessionOf();
    const token = tokenOf(await claim(owner, session));
    const recorded = CLI.rateLimit;
    const limited = (): Scripted => ({ status: recorded.response.status, headers: { ...headersOf(recorded.response), 'retry-after': '1' }, body: bodyOf(recorded.response) });
    // One more 429 than the gateway may send, so its own wait is spent and the 429 goes back to codex.
    script.push(limited(), limited(), limited(), limited());
    seen.length = 0;
    const before = Date.now();
    const answer = await ask(token);
    assert.equal(answer.status, 429, 'the upstream 429 goes back unchanged');
    assert.equal(backendRequests().length, 4, 'and only after every send the gateway may make');
    // Held out of new claims for the mark's floor — the backend asked for 1s, which is shorter than the
    // wait the gateway has already spent — while `spent_until` stays untouched: a rate limit is not a budget.
    const row = await loginRow(pool.id, pool.accountId);
    assert.equal(row.spentUntil, null);
    assert.ok(row.throttledUntil !== null, 'the account is held out');
    const held = row.throttledUntil!.getTime() - before;
    assert.ok(held >= 60_000, `expected at least a minute, got ${held}ms`);
    assert.ok(held < 120_000, `and no more than the floor plus the request, got ${held}ms`);
    // The gateway moves nobody: the next claim is what takes the session off the account.
    const moved = await sessionRow(session);
    assert.deepEqual({ accountId: moved.poolCodexAccountId, notice: moved.poolSwitchNotice }, { accountId: pool.accountId, notice: null });
  });

  await t.test('(7) the ledger: per session and hour, summed; a row whose session is gone before the write is dropped', async () => {
    const pool = await world('Ledger');
    const first = await pool.sessionOf();
    const second = await pool.sessionOf();
    const firstToken = tokenOf(await claim(owner, first));
    const secondToken = tokenOf(await claim(owner, second));
    script.push(streamWith({ input: 1000, cached: 400, output: 100 }), streamWith({ input: 2000, cached: 0, output: 50 }));
    script.push(streamWith({ input: 10, cached: 0, output: 1 }));
    assert.equal((await ask(firstToken)).status, 200);
    assert.equal((await ask(firstToken)).status, 200);
    assert.equal((await ask(secondToken)).status, 200);
    await ledger.flush();
    const price = (input: number, cached: number, output: number) =>
      BigInt(responseCostMicros('gpt-5.1-codex', 'default', { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output }));
    const rows = await db.poolLoginUsage.findMany({ where: { poolId: pool.id } });
    const bySession = Object.fromEntries(rows.map((row) => [row.sessionId, row]));
    assert.equal(rows.length, 2);
    assert.deepEqual(
      [bySession[first].requests, bySession[first].inputTokens, bySession[first].cachedInputTokens, bySession[first].outputTokens, bySession[first].costMicros],
      [2, 3000n, 400n, 150n, price(1000, 400, 100) + price(2000, 0, 50)],
    );
    assert.deepEqual(
      [bySession[second].requests, bySession[second].inputTokens, bySession[second].outputTokens, bySession[second].costMicros],
      [1, 10n, 1n, price(10, 0, 1)],
    );
    assert.equal(bySession[first].windowStart.getTime() % 3_600_000, 0, 'a window is a whole UTC hour');

    // Used, then its session deleted before the write: that row is dropped; the rest of the batch is written.
    const now = new Date();
    ledger.record({ poolId: pool.id, accountId: pool.accountId, sessionId: first, inputTokens: 5, cachedInputTokens: 0, outputTokens: 5, costMicros: 5, at: now });
    ledger.record({ poolId: pool.id, accountId: pool.accountId, sessionId: second, inputTokens: 7, cachedInputTokens: 0, outputTokens: 7, costMicros: 7, at: now });
    await db.session.delete({ where: { id: second } });
    await ledger.flush();
    const after = await db.poolLoginUsage.findMany({ where: { poolId: pool.id } });
    assert.deepEqual(after.map((row) => [row.sessionId, row.requests]), [[first, 3]]);
  });

  await t.test('(8) no database connection is held while a response streams', async () => {
    const pool = await world('Streaming');
    const session = await pool.sessionOf();
    const token = tokenOf(await claim(owner, session));
    // The backend sends half its stream, then holds the rest back for a second and a half.
    script.push(streamWith({ input: 1, cached: 0, output: 1 }, 1_500));
    const streaming = ask(token);
    await eventually(async () => backendRequests().length > 0 && seen.at(-1)!.headers.authorization === `Bearer ${pool.login.access}`, 'the request reached the backend');
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The gateway's client has one connection: were it held by the stream, this would wait out the stream.
    const started = Date.now();
    await gatewayDb.$queryRaw`SELECT 1`;
    assert.ok(Date.now() - started < 1_000, `a query waited ${Date.now() - started}ms behind a streaming response`);
    assert.equal((await streaming).status, 200);
  });

  await t.test('(9) nothing the gateway logged carries a token, in the clear or encrypted', async () => {
    Logger.overrideLogger(false);
    // The ciphertexts every refresh above wrote, beside the ones the worlds were made with.
    for (const row of await db.poolCodexLogin.findMany({ select: { accessTokenEnc: true, refreshTokenEnc: true } })) {
      secrets.push(row.accessTokenEnc, row.refreshTokenEnc);
    }
    for (const token of await db.poolLoginToken.findMany({ select: { tokenHash: true } })) secrets.push(token.tokenHash);
    assert.ok(logged.some((line) => /account …/.test(line)), 'nothing was logged: the capture did not work');
    const all = [...secrets, ...MADE];
    assert.ok(all.length > 20);
    const leaked = logged.filter((line) => all.some((secret) => line.includes(secret)) || /orbit-gwl-|Bearer |rt_/.test(line));
    assert.deepEqual(leaked, [], 'a log line carried a credential');
  });

  await t.test('(10) the account is the session\'s, not the token\'s: a warm token follows its session to another account, and one account leaving does not take it with it', async () => {
    const pool = await world('Moved');
    const second = await addAccount(pool.id);
    const session = await pool.sessionOf();
    // The token a warm engine holds was minted while the session was on the pool's first account.
    const token = tokenOf(await claim(owner, session));
    assert.equal((await sessionRow(session)).poolCodexAccountId, pool.accountId);

    // The session moves to the pool's other account — what a claim does — and the engine goes on with the
    // token it was started with. The account the backend is asked as is the session's now, not the one the
    // token was minted on, and the use is booked to the account it really ran on.
    await db.session.update({ where: { id: session }, data: { poolCodexAccountId: second.accountId } });
    seen.length = 0;
    const answer = await ask(token);
    assert.equal(answer.status, 200, answer.body.toString('utf8'));
    assert.ok(answer.body.equals(RECORDED_STREAM));
    const [sent, ...more] = backendRequests();
    assert.deepEqual(more, []);
    assert.equal(sent.headers['chatgpt-account-id'], second.accountId);
    assert.equal(sent.headers.authorization, `Bearer ${second.login.access}`);
    await ledger.flush();
    assert.deepEqual(
      (await db.poolLoginUsage.findMany({ where: { sessionId: session } })).map((row) => row.accountId),
      [second.accountId],
    );

    // A session naming no account with the pool holding two: nothing is picked for it, and nothing goes out.
    await db.session.update({ where: { id: session }, data: { poolCodexAccountId: null } });
    seen.length = 0;
    const unnamed = await ask(token);
    assert.equal(unnamed.status, 403);
    assert.equal(errorOf(unnamed).code, 'orbit_pool_login_missing');
    assert.equal(seen.length, 0, 'a refused request reached the backend');
    await db.session.update({ where: { id: session }, data: { poolCodexAccountId: second.accountId } });

    // The account the token was minted on is taken out of the pool: the token keeps working on the account
    // its session is on — it names no account, so nothing about it was deleted (migration 0355).
    assert.deepEqual(await logins.signOut(owner.id, pool.id, maskedAccount(pool.accountId)), { removed: 1 });
    assert.equal(await db.poolLoginToken.count({ where: { sessionId: session } }), 1, 'the token went with the account it was minted on');
    seen.length = 0;
    assert.equal((await ask(token)).status, 200);
    assert.equal(backendRequests()[0].headers['chatgpt-account-id'], second.accountId);
    assert.equal(backendRequests()[0].headers.authorization, `Bearer ${second.login.access}`);

    // The session's own account leaving is the pool's no-account answer, not a refusal of the token: the
    // token is still good, and what it is told is that there is no account to run on.
    assert.deepEqual(await logins.signOut(owner.id, pool.id, maskedAccount(second.accountId)), { removed: 1 });
    seen.length = 0;
    const emptied = await ask(token);
    assert.equal(emptied.status, 403, 'the session whose account left the pool');
    assert.deepEqual(errorOf(emptied), {
      message: loginMissingReason(pool.label), type: 'orbit_gateway', param: null, code: 'orbit_pool_login_missing',
    });
    assert.equal(seen.length, 0, 'a refused request reached the backend');
    assert.equal(await db.poolLoginToken.count({ where: { sessionId: session } }), 1, 'the token went with the account');
  });
});
