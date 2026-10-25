/**
 * A disabled account's pool gateway tokens, pools and credentials (docs/google-sign-in-design.md §5.5), end
 * to end on real PostgreSQL: the real controller behind main.ts's own layers, both gateways, sessions claimed
 * by the real claim, the account disabled and enabled again by the administrators' own handler
 * (AdminController.setDisabled, which reads the disabled accounts again as it does on the server it runs on),
 * and one recorder standing where OpenAI's API and ChatGPT's Codex backend stand.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/providers/pool-gateway-account-disable.pg.spec.ts
 *
 *  (1) A person's token (`orbit-gw-`) on a pool's API key, minted before the disable: from the next
 *      request on it is refused 403 ACCOUNT_DISABLED, in the words the account's runner credential is
 *      refused with, and nothing reaches OpenAI; the other member's token goes through as before; a token
 *      that is not good anyway is still 401; enabled again, the same token goes through.
 *  (2) The same on a pool's ChatGPT account: a member's token (`orbit-gw-`) and the owner's own
 *      (`orbit-gwl-`), each refused while its own account is disabled with nothing reaching the backend,
 *      the other's going through, and each going through again once enabled.
 *  (3) The pool's owner disabled: the pool stops. The members' requests on its API keys — the owner's key
 *      and a member's own alike — are refused 403 ACCOUNT_DISABLED, in words naming the owner's account,
 *      with nothing reaching OpenAI; the owner's own token is refused as (1) refuses one; enabled again,
 *      the same requests go through.
 *  (4) The same on the owner's ChatGPT account: a member's turn and the CLI's own backend call are refused
 *      with nothing reaching the backend or the token endpoint, and go through again once she is enabled.
 *  (5) A disable another server writes (here, straight into the table): within 30 seconds the owner's pools
 *      stop, the one on her key and the one on her ChatGPT account, and within 30 seconds of the enable the
 *      same requests go through again.
 *  (6) A key whose contributor, not the pool's owner, is disabled serves nobody while the pool's other key
 *      goes on, and serves again once its contributor is enabled.
 *  (7) The same for a ChatGPT account a member signed in to the owner's pool.
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
import { setTimeout as sleep } from 'node:timers/promises';

import { HttpException, Module, ValidationPipe, type ExecutionContext } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import type { ClaimedSession } from '@orbit/shared';
import { json, urlencoded } from 'express';
import { Client } from 'pg';

import { accountDisabled, DISABLED_ACCOUNTS_WITHIN_MS, DisabledAccounts } from '../auth/disabled-accounts';
import type { AuthUser } from '../common/current-user.decorator';
import { generateToken, sha256 } from '../common/crypto.util';
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
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { SessionsService } from '../sessions/sessions.service';
import { AdminController } from '../users/admin.controller';
import { CodexLoginService } from './codex-login.service';
import { ProviderPlanUsageService } from './plan-usage.service';
import { outsideThePoolGateway, PoolGatewayController } from './pool-gateway.controller';
import { PoolGatewayService } from './pool-gateway.service';
import { PoolLoginGatewayService } from './pool-login-gateway.service';
import { PoolLoginLedger } from './pool-login-ledger';
import { PoolUsageLedger } from './pool-usage-ledger';
import { encryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';
import { SharedPoolsService } from './shared-pools.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'pool-gateway-account-disable-spec';
process.env.PUBLIC_ORIGIN = 'https://orbit.pool-gateway-account-disable.invalid';

const realtime = new Proxy(
  {},
  { get: (_target, key) => (key === 'then' ? undefined : () => undefined) },
) as RealtimeService;

/** What codex 0.158 sent through a configured provider, and the stream it completed its turn on. */
interface Recording {
  request: { headers: Array<[string, string]>; bodyBase64: string };
  response: { status: number; headers: Array<[string, string]>; bodyBase64: string };
}
const RECORDING = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../src/providers/fixtures/codex-gateway-recording.json'), 'utf8'),
) as Recording;
const RECORDED_BODY = Buffer.from(RECORDING.request.bodyBase64, 'base64');
const RECORDED_STREAM = Buffer.from(RECORDING.response.bodyBase64, 'base64');

/** Codex's own headers, with `token` as its credential; `host` and the length are the transport's. */
function codexHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of RECORDING.request.headers) {
    if (name === 'host' || name === 'content-length' || name === 'authorization') continue;
    headers[name] = value;
  }
  headers.authorization = `Bearer ${token}`;
  return headers;
}

/** What a runner credential of a disabled account is answered: the convention every 403 door keeps. */
const RUNNER_REFUSAL = accountDisabled().getResponse() as { code: string; message: string };
/** What a member of a pool whose owner is disabled is told, under the same code: whose account it is. */
const ownerDisabled = (label: string) =>
  `The Orbit account that owns "${label}" is disabled — the pool serves nobody until an administrator enables that account again`;
/** What a session on a key or ChatGPT account whose own account is disabled is told, under the same code. */
const contributorDisabled = (credential: string, label: string) =>
  `${credential} in "${label}" belongs to an Orbit account that is disabled — it serves nobody until an administrator enables that account again`;

const hex = () => randomUUID().replace(/-/g, '');

interface Person {
  name: string;
  id: string;
  email: string;
  runnerId: string;
  runnerToken: string;
  workspaceId: string;
}

async function person(db: PrismaClient, name: string): Promise<Person> {
  const id = randomUUID();
  const runnerId = randomUUID();
  const runnerToken = generateToken(32);
  const workspaceId = randomUUID();
  const email = `${name}-${id}@pool-gateway-account-disable.invalid`;
  await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId: id, name: `${name}-runner`, tokenHash: sha256(runnerToken),
      status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId: id, runnerId, name: `${name}-agent`, enabled: true, workDir: `/tmp/${name}` },
  });
  return { name, id, email, runnerId, runnerToken, workspaceId };
}

/** One request the recorder standing in for OpenAI and the Codex backend was sent. */
interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
}

/** A pool's ChatGPT account as this spec signs one in: its id, its access token and its email. */
interface ChatgptAccount {
  accountId: string;
  access: string;
  email: string;
}

/** An HTTP exchange, bytes in and bytes out. */
function exchange(
  base: string,
  urlPath: string,
  headers: Record<string, string>,
  body: Buffer,
  method = 'POST',
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}${urlPath}`, { method, headers: { ...headers, 'content-length': String(body.length) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

const suite = URL ? test : test.skip;

suite("a disabled account's pool gateway tokens, end to end on real PostgreSQL", { timeout: 600_000 }, async (t) => {
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
  // The disabled accounts as this server holds them: read now, and again every 25 seconds.
  const disabledAccounts = new DisabledAccounts(prisma);
  await disabledAccounts.onModuleInit();
  // setDisabled reads and writes nothing but the database, then has this server read the disabled accounts
  // again; the token and Google services are other routes'.
  const admin = new AdminController(prisma, {} as never, {} as never, disabledAccounts);
  const runnerGuard = new RunnerAuthGuard(prisma);

  // OpenAI's API and ChatGPT's Codex backend, as far as the gateways can tell: every request recorded, and
  // answered with the stream codex completed its recorded turn on.
  const seen: Seen[] = [];
  const upstream: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      res.writeHead(RECORDING.response.status, Object.fromEntries(RECORDING.response.headers));
      res.end(RECORDED_STREAM);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const recorder = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const keys = new PoolGatewayService(prisma, pools, new PoolUsageLedger(prisma), `${recorder}/v1`, disabledAccounts);
  const accounts = new PoolLoginGatewayService(
    prisma, new CodexLoginService(prisma, realtime), new PoolLoginLedger(prisma), realtime,
    `${recorder}/backend-api/codex`, `${recorder}/oauth/token`, disabledAccounts,
  );

  @Module({
    controllers: [PoolGatewayController],
    providers: [
      { provide: PoolGatewayService, useValue: keys },
      { provide: PoolLoginGatewayService, useValue: accounts },
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
    await new Promise((resolve) => upstream.close(resolve));
    disabledAccounts.onModuleDestroy();
    await db.$disconnect();
    await client.end();
  });

  /** Codex's recorded request, sent with `token` — or, with `get`, the CLI's own GET of that path. */
  const ask = (token: string, get?: string) =>
    get
      ? exchange(base, `/api/gw/codex${get}`, codexHeaders(token), Buffer.alloc(0), 'GET')
      : exchange(base, '/api/gw/codex/responses', codexHeaders(token), RECORDED_BODY);

  /** The runner asking for work — which has to be `sessionId` — leaving it parked, as a turn would. */
  async function claim(who: Person, sessionId: string): Promise<ClaimedSession> {
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.PENDING, cancelRequestedAt: null } });
    const claimed = await queue.claimSessionForRunner({ id: who.runnerId }, 0, false, false);
    assert.ok(claimed, 'the runner was offered no session');
    assert.equal(claimed.sessionId, sessionId);
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.AWAITING_INPUT } });
    return claimed;
  }
  /** A session of `who`'s on the pool `slug`, claimed: the token its engine was handed. */
  async function tokenOn(who: Person, slug: string): Promise<{ sessionId: string; token: string }> {
    const sessionId = (await sessions.create(who.id, { prompt: 'hello', title: slug, workspaceId: who.workspaceId, provider: slug })).id;
    return { sessionId, token: (await claim(who, sessionId)).agent.env!.OPENAI_API_KEY! };
  }

  const root = await person(db, 'Root');
  await db.user.update({ where: { id: root.id }, data: { role: 'ADMIN' } });
  const administrator: AuthUser = { userId: root.id, email: root.email };
  /** An administrator disabling `who`'s account, or enabling it again, as PATCH /admin/users/:id/disabled does. */
  async function setDisabled(who: Person, disabled: boolean): Promise<void> {
    const user = await admin.setDisabled(administrator, who.id, { disabled });
    assert.equal(user?.disabledAt !== null, disabled, `${who.name}: the account is not ${disabled ? 'disabled' : 'enabled'}`);
  }

  /** `token` goes through: one request upstream, to `upstreamPath`, on `authorization` — not the token. */
  async function goesThrough(token: string, why: string, upstreamPath: string, authorization: string, get?: string): Promise<void> {
    const before = seen.length;
    const answer = await ask(token, get);
    assert.equal(answer.status, 200, `${why}: ${answer.body.toString('utf8')}`);
    assert.ok(answer.body.equals(RECORDED_STREAM), `${why}: the stream did not come back as it was sent`);
    assert.equal(seen.length, before + 1, `${why}: one request from codex is one request upstream`);
    assert.equal(seen[before].url, upstreamPath, why);
    assert.equal(seen[before].headers.authorization, authorization, why);
  }
  /**
   * `token` refused for its account alone: 403 with the code and the words a runner credential of a disabled
   * account is answered with, in the shape OpenAI's errors take, which is what codex reads — and nothing
   * reaches the upstream. With `message`, for somebody else's account — the pool's owner's, a credential's
   * contributor's: the same code and shape, in those words.
   */
  async function refusedAsDisabled(token: string, why: string, message = RUNNER_REFUSAL.message, get?: string): Promise<void> {
    const before = seen.length;
    const answer = await ask(token, get);
    assert.equal(answer.status, 403, `${why}: ${answer.body.toString('utf8')}`);
    assert.deepEqual(
      JSON.parse(answer.body.toString('utf8')),
      { error: { message, type: 'orbit_gateway', param: null, code: RUNNER_REFUSAL.code } },
      why,
    );
    assert.equal(seen.length, before, `${why}: the refused request reached the upstream`);
  }
  /** `token` goes through on the pool key whose secret is `secret`. */
  const throughKey = (token: string, why: string, secret: string) => goesThrough(token, why, '/v1/responses', `Bearer ${secret}`);
  /** `token` goes through on the ChatGPT account `account` — its turn, or with `get` one of the CLI's own calls. */
  async function throughAccount(token: string, why: string, account: ChatgptAccount, get?: string): Promise<void> {
    await goesThrough(token, why, get ? `/backend-api${get}` : '/backend-api/codex/responses', `Bearer ${account.access}`, get);
    assert.equal(seen[seen.length - 1].headers['chatgpt-account-id'], account.accountId, why);
  }
  /** A ChatGPT account `who` signed in to the pool `poolId`, as the sign-in stores one; its access token nowhere near its expiry. */
  async function chatgptAccount(who: Person, poolId: string): Promise<ChatgptAccount> {
    const account = {
      accountId: `acct-${randomUUID()}`,
      access: `codex-access-${randomUUID()}`,
      email: `${who.name.toLowerCase()}-${randomUUID()}@pool-gateway-account-disable.invalid`,
    };
    await db.poolCodexLogin.create({
      data: {
        poolId, userId: who.id, accountId: account.accountId, email: account.email, plan: 'plus',
        accessTokenEnc: encryptSecret(account.access), refreshTokenEnc: encryptSecret(`codex-refresh-${randomUUID()}`),
        expiresAt: new Date('2100-01-01T00:00:00Z'),
      },
    });
    return account;
  }
  /** The ChatGPT account the session `sessionId` runs on, as its last claim recorded it. */
  const accountOfSession = async (sessionId: string) =>
    (await db.session.findUniqueOrThrow({ where: { id: sessionId } })).poolCodexAccountId;
  /** What `who`'s runner credential is answered now, by the runner API's own guard. */
  async function runnerCredential(who: Person): Promise<{ status: number; body: unknown }> {
    const request: Record<string, unknown> = { headers: { authorization: `Bearer ${who.runnerToken}` } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
    try {
      await runnerGuard.canActivate(context);
      return { status: 200, body: null };
    } catch (error) {
      assert.ok(error instanceof HttpException, String(error));
      return { status: error.getStatus(), body: error.getResponse() };
    }
  }

  await t.test("(1) a person's token on a pool's API key: refused from the disable on, the other member's going through, and the same token good again once enabled", async () => {
    const ann = await person(db, 'Ann');
    const mia = await person(db, 'Mia');
    const max = await person(db, 'Max');
    const made = await pools.create(ann.id, { label: 'Disable on keys' });
    await pools.addPerson(ann.id, made.id, { email: mia.email });
    await pools.addPerson(ann.id, made.id, { email: max.email });
    const secret = `sk-proj-${hex()}${hex()}`;
    await pools.addKey(ann.id, made.id, { label: 'orbit-org', apiKey: secret });
    const onKey = (token: string, why: string) => goesThrough(token, why, '/v1/responses', `Bearer ${secret}`);

    // Tokens minted while the accounts are enabled, each on Ann's key.
    const miaOn = await tokenOn(mia, made.slug);
    const maxOn = await tokenOn(max, made.slug);
    assert.match(miaOn.token, /^orbit-gw-/);
    assert.match(maxOn.token, /^orbit-gw-/);
    await onKey(miaOn.token, 'Mia, enabled');
    await onKey(maxOn.token, 'Max, enabled');
    assert.equal((await runnerCredential(mia)).status, 200);

    // Mia disabled: her token is refused from the next request on — in the words her runner credential
    // is refused with now — and Max, whom nobody disabled, goes on as before.
    await setDisabled(mia, true);
    await refusedAsDisabled(miaOn.token, 'Mia, disabled: the token she was handed before');
    assert.deepEqual(await runnerCredential(mia), { status: 403, body: RUNNER_REFUSAL });
    await onKey(maxOn.token, 'Max, not disabled');

    // A token that is not good anyway is the 401 it always was: ACCOUNT_DISABLED is only for a token that
    // enabling the account lets back in.
    const minted = await db.poolGatewayToken.findUniqueOrThrow({ where: { tokenHash: sha256(miaOn.token) }, select: { expiresAt: true } });
    await db.poolGatewayToken.update({ where: { tokenHash: sha256(miaOn.token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await ask(miaOn.token);
    assert.equal(expired.status, 401, expired.body.toString('utf8'));
    assert.equal((JSON.parse(expired.body.toString('utf8')) as { error: { code: string } }).error.code, 'orbit_gateway_token_invalid');
    await db.poolGatewayToken.update({ where: { tokenHash: sha256(miaOn.token) }, data: { expiresAt: minted.expiresAt } });
    await refusedAsDisabled(miaOn.token, 'Mia, disabled: the token good again but for her account');

    // Enabled again: the same token goes through, on the same key; so does her runner credential.
    await setDisabled(mia, false);
    await onKey(miaOn.token, 'Mia, enabled again');
    assert.equal((await runnerCredential(mia)).status, 200);
    await onKey(maxOn.token, 'Max, throughout');
  });

  await t.test("(2) a pool's ChatGPT account: a member's token and the owner's own, each refused while its account is disabled, the other's going through, and both good again once enabled", async () => {
    const olga = await person(db, 'Olga');
    const pia = await person(db, 'Pia');
    const made = await providers.createPool(olga.id, { label: 'Disable on an account', engine: 'codex' });
    // Her ChatGPT account, as the sign-in stores one; its access token nowhere near its expiry.
    const accountId = `acct-${randomUUID()}`;
    const access = `codex-access-${randomUUID()}`;
    await db.poolCodexLogin.create({
      data: {
        poolId: made.id, userId: olga.id, accountId, email: 'olga@pool-gateway-account-disable.invalid', plan: 'plus',
        accessTokenEnc: encryptSecret(access), refreshTokenEnc: encryptSecret(`codex-refresh-${randomUUID()}`),
        expiresAt: new Date('2100-01-01T00:00:00Z'),
      },
    });
    await pools.addPerson(olga.id, made.id, { email: pia.email });
    const onAccount = async (token: string, why: string) => {
      await goesThrough(token, why, '/backend-api/codex/responses', `Bearer ${access}`);
      assert.equal(seen[seen.length - 1].headers['chatgpt-account-id'], accountId, why);
    };

    // Olga's own session on a login pool's token, Pia's on a person's — both on Olga's account.
    const olgaOn = await tokenOn(olga, made.slug);
    const piaOn = await tokenOn(pia, made.slug);
    assert.match(olgaOn.token, /^orbit-gwl-/);
    assert.match(piaOn.token, /^orbit-gw-/);
    for (const sessionId of [olgaOn.sessionId, piaOn.sessionId]) {
      assert.equal((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).poolCodexAccountId, accountId);
    }
    await onAccount(olgaOn.token, 'Olga, enabled');
    await onAccount(piaOn.token, 'Pia, enabled');

    // Pia disabled: her token no longer spends Olga's account; Olga's own goes on.
    await setDisabled(pia, true);
    await refusedAsDisabled(piaOn.token, 'Pia, disabled');
    await onAccount(olgaOn.token, 'Olga, not disabled');
    await setDisabled(pia, false);
    await onAccount(piaOn.token, 'Pia, enabled again');

    // Olga disabled: her login pool's token is refused the same way; enabled again, it goes through.
    await setDisabled(olga, true);
    await refusedAsDisabled(olgaOn.token, 'Olga, disabled');
    await setDisabled(olga, false);
    await onAccount(olgaOn.token, 'Olga, enabled again');
  });

  await t.test("(3) the pool's owner disabled: the pool stops on every key, a member's own included, with nothing reaching OpenAI, and serves again once she is enabled", async () => {
    const una = await person(db, 'Una');
    const vic = await person(db, 'Vic');
    const wes = await person(db, 'Wes');
    const label = 'Owner disabled, keys';
    const made = await pools.create(una.id, { label });
    await pools.addPerson(una.id, made.id, { email: vic.email });
    await pools.addPerson(una.id, made.id, { email: wes.email });
    // Una's key, the only one when Vic's session is claimed; then Wes's, which his own session takes first,
    // as Una's own session takes hers.
    const unaSecret = `sk-proj-${hex()}${hex()}`;
    await pools.addKey(una.id, made.id, { label: 'una-org', apiKey: unaSecret });
    const vicOn = await tokenOn(vic, made.slug);
    const wesSecret = `sk-proj-${hex()}${hex()}`;
    await pools.addKey(wes.id, made.id, { label: 'wes-org', apiKey: wesSecret });
    const wesOn = await tokenOn(wes, made.slug);
    const unaOn = await tokenOn(una, made.slug);
    await throughKey(vicOn.token, "Vic on Una's key, Una enabled", unaSecret);
    await throughKey(wesOn.token, 'Wes on his own key, Una enabled', wesSecret);
    await throughKey(unaOn.token, 'Una on her own key, enabled', unaSecret);

    // Una disabled: nobody's session runs on her pool, not even on the key Wes put in, and each is told it
    // is the owner's account; her own token is refused as a disabled account's own is.
    await setDisabled(una, true);
    await refusedAsDisabled(vicOn.token, "Vic on Una's key, Una disabled", ownerDisabled(label));
    await refusedAsDisabled(wesOn.token, 'Wes on his own key, Una disabled', ownerDisabled(label));
    await refusedAsDisabled(unaOn.token, 'Una, disabled');

    // Enabled again: the same tokens go through, each on the key it ran on.
    await setDisabled(una, false);
    await throughKey(vicOn.token, "Vic on Una's key, Una enabled again", unaSecret);
    await throughKey(wesOn.token, 'Wes on his own key, Una enabled again', wesSecret);
    await throughKey(unaOn.token, 'Una on her own key, enabled again', unaSecret);
  });

  await t.test("(4) the pool's owner disabled: no member's session runs on her ChatGPT account, its turn or the CLI's own call, with nothing reaching the backend or the token endpoint, and both go through again once she is enabled", async () => {
    const xia = await person(db, 'Xia');
    const yan = await person(db, 'Yan');
    const label = 'Owner disabled, ChatGPT';
    const made = await providers.createPool(xia.id, { label, engine: 'codex' });
    const account = await chatgptAccount(xia, made.id);
    await pools.addPerson(xia.id, made.id, { email: yan.email });
    const yanOn = await tokenOn(yan, made.slug);
    assert.match(yanOn.token, /^orbit-gw-/);
    assert.equal(await accountOfSession(yanOn.sessionId), account.accountId);
    await throughAccount(yanOn.token, "Yan on Xia's account, Xia enabled", account);
    await throughAccount(yanOn.token, "Yan's CLI on Xia's account, Xia enabled", account, '/wham/settings/user');

    // Xia disabled: the recorder stands for the token endpoint too, and hears nothing either.
    await setDisabled(xia, true);
    await refusedAsDisabled(yanOn.token, "Yan on Xia's account, Xia disabled", ownerDisabled(label));
    await refusedAsDisabled(yanOn.token, "Yan's CLI on Xia's account, Xia disabled", ownerDisabled(label), '/wham/settings/user');

    await setDisabled(xia, false);
    await throughAccount(yanOn.token, "Yan on Xia's account, Xia enabled again", account);
    await throughAccount(yanOn.token, "Yan's CLI on Xia's account, Xia enabled again", account, '/wham/settings/user');
  });

  await t.test("(5) a disable another server writes: within 30 seconds the owner's pools stop, on her key and on her ChatGPT account, and within 30 seconds of the enable the same requests go through again", async () => {
    const zoe = await person(db, 'Zoe');
    const amy = await person(db, 'Amy');
    const bea = await person(db, 'Bea');
    // Zoe's shared pool on her key, Amy in it; and her own Codex pool on her ChatGPT account, Bea in it.
    const keyLabel = 'Another server, keys';
    const keyPool = await pools.create(zoe.id, { label: keyLabel });
    await pools.addPerson(zoe.id, keyPool.id, { email: amy.email });
    const secret = `sk-proj-${hex()}${hex()}`;
    await pools.addKey(zoe.id, keyPool.id, { label: 'zoe-org', apiKey: secret });
    const accountLabel = 'Another server, ChatGPT';
    const accountPool = await providers.createPool(zoe.id, { label: accountLabel, engine: 'codex' });
    const account = await chatgptAccount(zoe, accountPool.id);
    await pools.addPerson(zoe.id, accountPool.id, { email: bea.email });
    const amyOn = await tokenOn(amy, keyPool.slug);
    const beaOn = await tokenOn(bea, accountPool.slug);
    await throughKey(amyOn.token, "Amy on Zoe's key, Zoe enabled", secret);
    await throughAccount(beaOn.token, "Bea on Zoe's account, Zoe enabled", account);

    /** Whether `token`'s pool is stopped for its owner now: refused, with nothing upstream — else it went through. */
    async function stopped(token: string, label: string, why: string): Promise<boolean> {
      const before = seen.length;
      const answer = await ask(token);
      if (answer.status === 200) {
        assert.equal(seen.length, before + 1, `${why}: one request from codex is one request upstream`);
        return false;
      }
      assert.equal(answer.status, 403, `${why}: ${answer.body.toString('utf8')}`);
      assert.deepEqual(
        JSON.parse(answer.body.toString('utf8')),
        { error: { message: ownerDisabled(label), type: 'orbit_gateway', param: null, code: RUNNER_REFUSAL.code } },
        why,
      );
      assert.equal(seen.length, before, `${why}: the refused request reached the upstream`);
      return true;
    }
    const both = async () => [await stopped(amyOn.token, keyLabel, 'Amy'), await stopped(beaOn.token, accountLabel, 'Bea')];

    // Disabled on another server: this one stops her pools once it reads the disabled accounts again, within
    // the 30 seconds §5.5 promises — no grace on top.
    const written = Date.now();
    await db.user.update({ where: { id: zoe.id }, data: { disabledAt: new Date() } });
    let state = await both();
    while (!(state[0] && state[1]) && Date.now() < written + DISABLED_ACCOUNTS_WITHIN_MS) {
      await sleep(250);
      state = await both();
    }
    const tookMs = Date.now() - written;
    assert.deepEqual(state, [true, true], `both pools stopped within ${DISABLED_ACCOUNTS_WITHIN_MS} ms (${tookMs} ms)`);
    assert.ok(tookMs <= DISABLED_ACCOUNTS_WITHIN_MS, `stopped within ${DISABLED_ACCOUNTS_WITHIN_MS} ms, not ${tookMs} ms`);
    t.diagnostic(`the owner's pools refused their members ${tookMs} ms after the disable was written`);

    // Enabled the same way: the same requests go through again, within the same 30 seconds.
    const enabledAt = Date.now();
    await db.user.update({ where: { id: zoe.id }, data: { disabledAt: null } });
    state = await both();
    while ((state[0] || state[1]) && Date.now() < enabledAt + DISABLED_ACCOUNTS_WITHIN_MS) {
      await sleep(250);
      state = await both();
    }
    const backMs = Date.now() - enabledAt;
    assert.deepEqual(state, [false, false], `both pools served again within ${DISABLED_ACCOUNTS_WITHIN_MS} ms (${backMs} ms)`);
    assert.ok(backMs <= DISABLED_ACCOUNTS_WITHIN_MS, `serving again within ${DISABLED_ACCOUNTS_WITHIN_MS} ms, not ${backMs} ms`);
    t.diagnostic(`the owner's pools served their members again ${backMs} ms after the enable was written`);
    await throughKey(amyOn.token, "Amy on Zoe's key, Zoe enabled again", secret);
    await throughAccount(beaOn.token, "Bea on Zoe's account, Zoe enabled again", account);
  });

  await t.test("(6) a key whose contributor, not the pool's owner, is disabled serves nobody while the pool's other key goes on, and serves again once its contributor is enabled", async () => {
    const kai = await person(db, 'Kai');
    const lee = await person(db, 'Lee');
    const mo = await person(db, 'Mo');
    const label = 'Contributor disabled, keys';
    const made = await pools.create(kai.id, { label });
    await pools.addPerson(kai.id, made.id, { email: lee.email });
    await pools.addPerson(kai.id, made.id, { email: mo.email });
    // Lee's key, the only one when Mo's session is claimed; then Kai's, which his own session takes first.
    const leeSecret = `sk-proj-${hex()}${hex()}`;
    await pools.addKey(lee.id, made.id, { label: 'lee-org', apiKey: leeSecret });
    const moOn = await tokenOn(mo, made.slug);
    const kaiSecret = `sk-proj-${hex()}${hex()}`;
    await pools.addKey(kai.id, made.id, { label: 'kai-org', apiKey: kaiSecret });
    const kaiOn = await tokenOn(kai, made.slug);
    await throughKey(moOn.token, "Mo on Lee's key, Lee enabled", leeSecret);
    await throughKey(kaiOn.token, 'Kai on his own key, Lee enabled', kaiSecret);

    // Lee disabled: his key serves nobody, and Mo is told whose account it is; the pool goes on on Kai's.
    await setDisabled(lee, true);
    await refusedAsDisabled(moOn.token, "Mo on Lee's key, Lee disabled", contributorDisabled(`lee-org (sk-…${leeSecret.slice(-4)})`, label));
    await throughKey(kaiOn.token, 'Kai on his own key, Lee disabled', kaiSecret);

    await setDisabled(lee, false);
    await throughKey(moOn.token, "Mo on Lee's key, Lee enabled again", leeSecret);
  });

  await t.test("(7) a ChatGPT account a member signed in to the owner's pool serves nobody while she is disabled, the owner's own account going on, and serves again once she is enabled", async () => {
    const rex = await person(db, 'Rex');
    const sue = await person(db, 'Sue');
    const tom = await person(db, 'Tom');
    const label = 'Contributor disabled, ChatGPT';
    const made = await providers.createPool(rex.id, { label, engine: 'codex' });
    await pools.addPerson(rex.id, made.id, { email: sue.email });
    await pools.addPerson(rex.id, made.id, { email: tom.email });
    // Sue's account, the only one when Tom's session is claimed. Then Rex's, which his own session is put on
    // while Sue's says its usage limit is reached — as a claim would find it — and her mark is taken off after.
    const sues = await chatgptAccount(sue, made.id);
    const tomOn = await tokenOn(tom, made.slug);
    const rexes = await chatgptAccount(rex, made.id);
    const suesRow = { poolId_accountId: { poolId: made.id, accountId: sues.accountId } };
    await db.poolCodexLogin.update({ where: suesRow, data: { spentUntil: new Date(Date.now() + 3_600_000) } });
    const rexOn = await tokenOn(rex, made.slug);
    await db.poolCodexLogin.update({ where: suesRow, data: { spentUntil: null } });
    assert.equal(await accountOfSession(tomOn.sessionId), sues.accountId);
    assert.equal(await accountOfSession(rexOn.sessionId), rexes.accountId);
    await throughAccount(tomOn.token, "Tom on Sue's account, Sue enabled", sues);
    await throughAccount(rexOn.token, 'Rex on his own account, Sue enabled', rexes);

    // Sue disabled: her account serves nobody, and Tom is told whose account it is; Rex's goes on.
    await setDisabled(sue, true);
    await refusedAsDisabled(tomOn.token, "Tom on Sue's account, Sue disabled", contributorDisabled(`The ChatGPT account ${sues.email}`, label));
    await throughAccount(rexOn.token, 'Rex on his own account, Sue disabled', rexes);

    await setDisabled(sue, false);
    await throughAccount(tomOn.token, "Tom on Sue's account, Sue enabled again", sues);
  });
});
