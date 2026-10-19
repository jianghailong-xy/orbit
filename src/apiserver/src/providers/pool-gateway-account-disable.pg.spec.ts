/**
 * A disabled account's pool gateway tokens (docs/google-sign-in-design.md §5.5), end to end on real
 * PostgreSQL: the real controller behind main.ts's own layers, both gateways, sessions claimed by the real
 * claim, the account disabled and enabled again by the administrators' own handler
 * (AdminController.setDisabled), and one recorder standing where OpenAI's API and ChatGPT's Codex backend
 * stand.
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

import { HttpException, Module, ValidationPipe, type ExecutionContext } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import type { ClaimedSession } from '@orbit/shared';
import { json, urlencoded } from 'express';
import { Client } from 'pg';

import { accountDisabled } from '../auth/disabled-accounts';
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

/** An HTTP exchange, bytes in and bytes out. */
function exchange(
  base: string,
  urlPath: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}${urlPath}`, { method: 'POST', headers: { ...headers, 'content-length': String(body.length) } }, (res) => {
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
  // setDisabled reads nothing but the database; the token and Google services are other routes'.
  const admin = new AdminController(prisma, {} as never, {} as never);
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
  const keys = new PoolGatewayService(prisma, pools, new PoolUsageLedger(prisma), `${recorder}/v1`);
  const accounts = new PoolLoginGatewayService(
    prisma, new CodexLoginService(prisma, realtime), new PoolLoginLedger(prisma), realtime,
    `${recorder}/backend-api/codex`, `${recorder}/oauth/token`,
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
    await db.$disconnect();
    await client.end();
  });

  /** Codex's recorded request, sent with `token`. */
  const ask = (token: string) => exchange(base, '/api/gw/codex/responses', codexHeaders(token), RECORDED_BODY);

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
  async function goesThrough(token: string, why: string, upstreamPath: string, authorization: string): Promise<void> {
    const before = seen.length;
    const answer = await ask(token);
    assert.equal(answer.status, 200, `${why}: ${answer.body.toString('utf8')}`);
    assert.ok(answer.body.equals(RECORDED_STREAM), `${why}: the stream did not come back as it was sent`);
    assert.equal(seen.length, before + 1, `${why}: one request from codex is one request upstream`);
    assert.equal(seen[before].url, upstreamPath, why);
    assert.equal(seen[before].headers.authorization, authorization, why);
  }
  /**
   * `token` refused for its account alone: 403 with the code and the words a runner credential of a disabled
   * account is answered with, in the shape OpenAI's errors take, which is what codex reads — and nothing
   * reaches the upstream.
   */
  async function refusedAsDisabled(token: string, why: string): Promise<void> {
    const before = seen.length;
    const answer = await ask(token);
    assert.equal(answer.status, 403, `${why}: ${answer.body.toString('utf8')}`);
    assert.deepEqual(
      JSON.parse(answer.body.toString('utf8')),
      { error: { message: RUNNER_REFUSAL.message, type: 'orbit_gateway', param: null, code: RUNNER_REFUSAL.code } },
      why,
    );
    assert.equal(seen.length, before, `${why}: the refused request reached the upstream`);
  }
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
});
