/**
 * A pool of one person's own ChatGPT login, at every door that takes a provider slug, on real PostgreSQL
 * (migration 0323): for its owner it is a pool like any other — seen, picked, opened a session on, switched
 * on — and for every other Orbit user it does not exist, at each of those doors and at the sign-in's own.
 *
 * "Does not exist" is what the shared pools answer a person who is not in them (migration 0321,
 * docs/codex-shared-pool-design.md §2.5), and it is the same answer here for a different reason: a login
 * pool has no membership table at all, because the account it runs on belongs to one person and is shared
 * with nobody. What the doors are asserted on is what they RESOLVED — the row written, the list it appears
 * in — before whether they refused, and every refusal is paired with the same request made by the pool's
 * owner, which has to go through.
 *
 * The last case is the one a quota could get wrong: an account whose quota nobody has read is ACTIVE and
 * runnable, and its view says the reading is missing rather than that the credential was refused.
 *
 * Needs COORDINATOR_PG_URL (scripts/run-pg-spec.sh provides a disposable one); without it every case
 * reports as skipped, and that script counts a skip as red.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { toUuid } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { sha256 } from '../common/crypto.util';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RunnerProvidersController } from '../runner-api/runner-providers.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { CodexLoginService } from './codex-login.service';
import { ProviderPlanUsageService } from './plan-usage.service';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';
import { encryptSecret } from './provider-crypto';

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

process.env.PROVIDER_SECRET_KEY ??= 'codex-login-scope-spec';

const realtime = new Proxy(
  {},
  { get: (_target, key) => (key === 'then' ? undefined : () => undefined) },
) as RealtimeService;

/** A person, with a runner and an agent of their own bound to it. */
interface Person {
  name: string;
  id: string;
  runnerId: string;
  runnerToken: string;
  workspaceId: string;
}

async function person(db: PrismaClient, name: string): Promise<Person> {
  const id = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const runnerToken = `codex-login-scope-${randomUUID()}`;
  await db.user.create({
    data: { id, email: `${name}-${id}@codex-login-scope.invalid`, name, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId: id, name: `${name}-runner`, tokenHash: sha256(runnerToken),
      status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId: id, runnerId, name: `${name}-agent`, enabled: true, workDir: `/tmp/${name}` },
  });
  return { name, id, runnerId, runnerToken, workspaceId };
}

/** A session row written straight into the table: the only way a slug gets onto a session the doors
 *  refuse to put it on. */
async function sessionOn(db: PrismaClient, owner: Person, provider: string, status: RunStatus): Promise<string> {
  const session = await db.session.create({
    data: {
      title: 'codex login scope',
      prompt: 'hello',
      status,
      ownerId: owner.id,
      creatorId: owner.id,
      workspaceId: owner.workspaceId,
      assignedRunnerId: (await db.workspace.findUniqueOrThrow({ where: { id: owner.workspaceId } })).runnerId,
      provider,
      providerBuiltin: provider === 'codex',
      model: 'gpt-5.5',
      permissionMode: 'default',
      usesRuntimeDefaultModel: true,
      numTurns: 1,
      runtimeSessionId: randomUUID(),
      startedAt: new Date(),
    },
    select: { id: true },
  });
  return session.id;
}

async function settle(request: Promise<unknown>): Promise<'went through' | 'refused'> {
  try {
    await request;
    return 'went through';
  } catch {
    return 'refused';
  }
}

/** A task whose completion needs nothing of this spec: EXECUTABLE, and the command that says so. */
const TASK_CHECK = {
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
} as const;

const doorsOver: { providers: unknown; login: unknown; prisma: unknown } = {
  providers: null,
  login: null,
  prisma: null,
};

@Module({
  controllers: [ProvidersController, RunnerProvidersController],
  providers: [
    { provide: ProvidersService, useFactory: () => doorsOver.providers },
    { provide: CodexLoginService, useFactory: () => doorsOver.login },
    { provide: PrismaService, useFactory: () => doorsOver.prisma },
    JwtAuthGuard,
    RunnerAuthGuard,
    Reflector,
    // A person is whoever their bearer names: what a verified token would say, with the user id as the token.
    { provide: JwtService, useValue: { verifyAsync: async (bearer: string) => ({ sub: bearer }) } },
  ],
})
class Doors {}

async function openDoors() {
  const app = await NestFactory.create(Doors, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  return { base: await app.getUrl(), close: () => app.close() };
}

const suite = PG_URL ? test : test.skip;

suite("a pool of one's own ChatGPT login, at every door — its owner's, and nobody else's", { timeout: 300_000 }, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const sessions = new SessionsService(prisma, queue, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const login = new CodexLoginService(prisma, realtime);
  doorsOver.providers = providers;
  doorsOver.login = login;
  doorsOver.prisma = db;
  const doors = await openDoors();
  t.after(async () => {
    await doors.close();
    login.onModuleDestroy();
    await db.$disconnect().catch(() => undefined);
    await client.end().catch(() => undefined);
  });

  async function ask(bearer: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
    const response = await fetch(`${doors.base}/api/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: response.status, text, json, said: `${method} /api/${path} → ${response.status}: ${text}` };
  }
  async function call(expected: number, ...args: Parameters<typeof ask>) {
    const answer = await ask(...args);
    assert.equal(answer.status, expected, answer.said);
    return answer;
  }

  const owner = await person(db, 'Owner');
  const stranger = await person(db, 'Stranger');
  /** The pool its owner makes: Codex, not shared, and holding no members — its account is the credential. */
  const made = await call(201, owner.id, 'POST', 'providers/pools', { label: 'My ChatGPT', engine: 'codex' });
  const pool = { id: toUuid(String(made.json.id)), slug: String(made.json.slug) };
  const at = `providers/pools/${pool.id}`;

  const ACCOUNT_ID = randomUUID();
  const signIn = () =>
    db.poolCodexLogin.create({
      data: {
        poolId: pool.id,
        userId: owner.id,
        accountId: ACCOUNT_ID,
        email: 'owner@example.invalid',
        plan: 'plus',
        accessTokenEnc: encryptSecret('access-token-not-a-real-one'),
        refreshTokenEnc: encryptSecret('refresh-token-not-a-real-one'),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

  await t.test('the pool as made: Codex, its owner’s, not shared, with no members and no account yet', async () => {
    const row = await db.providerPool.findUniqueOrThrow({ where: { id: pool.id } });
    assert.deepEqual(
      { engine: row.engine, shared: row.shared, ownerId: row.ownerId },
      { engine: 'codex', shared: false, ownerId: owner.id },
    );
    assert.equal(await db.providerPoolMember.count({ where: { poolId: pool.id } }), 0);
    const page = (await call(200, owner.id, 'GET', at)).json;
    assert.deepEqual(
      { slug: page.slug, engine: page.engine, login: page.login, unavailable: page.unavailable, members: page.members },
      {
        slug: pool.slug,
        engine: 'codex',
        login: null,
        unavailable: 'the pool "My ChatGPT" has no ChatGPT account signed in — sign in on its page, or pick another provider',
        members: [],
      },
    );
    // A Codex pool runs on a login, not on member providers: naming one refuses the whole create.
    assert.deepEqual(
      await settle(providers.createPool(owner.id, { label: 'wrong', engine: 'codex', providerIds: [randomUUID()] })),
      'refused',
    );
    assert.equal(await db.providerPool.count({ where: { ownerId: owner.id } }), 1);
  });

  await t.test('(1) see it, pick it: its owner does, every other user’s list does not name it', async () => {
    for (const [who, seen] of [[owner, true], [stranger, false]] as const) {
      const listed = (await call(200, who.id, 'GET', 'providers/pools')).json as Array<{ slug: string }>;
      assert.equal(listed.some((entry) => entry.slug === pool.slug), seen, `${who.name}'s pool list`);
      const usable = (await call(200, who.runnerToken, 'GET', 'runner/providers')).json as Array<{ slug: string; runtime: string }>;
      assert.equal(usable.some((entry) => entry.slug === pool.slug), seen, `${who.name}'s agent provider list`);
      // The service the doors read, asserted the same way.
      assert.equal((await providers.listUsable(who.id)).some((entry) => entry.slug === pool.slug), seen);
      assert.equal((await providers.listPools(who.id)).some((entry) => entry.slug === pool.slug), seen);
    }
    // Its owner's list says what it runs on: the pool is a Codex provider, whichever engine it holds.
    const usable = (await call(200, owner.runnerToken, 'GET', 'runner/providers')).json as Array<{ slug: string; runtime: string }>;
    assert.equal(usable.find((entry) => entry.slug === pool.slug)?.runtime, 'codex');
  });

  await t.test('(2) its page: 404 for everyone else, and the same 404 as a pool that does not exist', async () => {
    assert.equal((await call(200, owner.id, 'GET', at)).json.slug, pool.slug);
    const strangerPage = await call(404, stranger.id, 'GET', at);
    const noSuch = await call(404, stranger.id, 'GET', `providers/pools/${randomUUID()}`);
    assert.equal(strangerPage.json.message, noSuch.json.message);
    assert.equal(strangerPage.json.message, 'pool not found');
    // And the sign-in's own doors, which are the page's buttons.
    const loginAt = `${at}/codex-login`;
    for (const [method, path] of [['POST', loginAt], ['GET', loginAt], ['DELETE', loginAt], ['DELETE', `${loginAt}/account`]] as const) {
      const answer = await call(404, stranger.id, method, path);
      assert.equal(answer.json.message, 'pool not found', `${method} ${path}`);
    }
    assert.equal(await db.poolCodexLogin.count({ where: { poolId: pool.id } }), 0);
  });

  await t.test('(3) open a session on it: its owner may, nobody else — and with no account signed in, nobody may yet', async () => {
    // No account: the pool cannot run, and the door says which login is missing rather than opening a
    // session that would dispatch on the runner's own.
    assert.match(String(await queue.accountPoolRefusal(owner.id, pool.slug)), /no ChatGPT account signed in/u);
    assert.deepEqual(
      await settle(sessions.create(owner.id, { prompt: 'hello', title: 'too early', workspaceId: owner.workspaceId, provider: pool.slug })),
      'refused',
    );

    await signIn();
    // Its owner: a session is written, on the pool.
    const opened = await sessions.create(owner.id, {
      prompt: 'hello', title: 'on my login', workspaceId: owner.workspaceId, provider: pool.slug,
    });
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: opened.id } })).provider, pool.slug);

    // Anybody else: no session, and nothing of the account is in the refusal.
    const his = await settle(
      sessions.create(stranger.id, { prompt: 'hello', title: 'on their login', workspaceId: stranger.workspaceId, provider: pool.slug }),
    );
    assert.equal(his, 'refused');
    assert.equal(await db.session.count({ where: { ownerId: stranger.id, provider: pool.slug } }), 0);
    // The claim's own read of the pool: nothing of it, for anybody but its owner.
    assert.equal(await queue.accountPoolRefusal(stranger.id, pool.slug), null);
    assert.equal(await queue.accountPoolRefusal(owner.id, pool.slug), null);
  });

  await t.test('(4) switch a live session onto it: its owner may, nobody else — their session stays where it was', async () => {
    const mine = await sessionOn(db, owner, 'codex', RunStatus.AWAITING_INPUT);
    await sessions.updateConfig(owner.id, mine, { provider: pool.slug });
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: mine } })).provider, pool.slug);

    const his = await sessionOn(db, stranger, 'codex', RunStatus.AWAITING_INPUT);
    assert.deepEqual(await settle(sessions.updateConfig(stranger.id, his, { provider: pool.slug })), 'refused');
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: his } })).provider, 'codex');
  });

  await t.test('(5) pin a task to it: its owner may, nobody else — the same helper both doors take', async () => {
    const pinned = await tasks.create(owner.id, { title: `on my login ${randomUUID()}`, provider: pool.slug, ...TASK_CHECK } as never);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: pinned.id } })).provider, pool.slug);
    assert.deepEqual(
      await settle(tasks.create(stranger.id, { title: `on their login ${randomUUID()}`, provider: pool.slug, ...TASK_CHECK } as never)),
      'refused',
    );
    assert.equal(await db.task.count({ where: { creatorId: stranger.id, provider: pool.slug } }), 0);
  });

  await t.test('the claim of a session on it carries nothing of the account — no token, and not the ciphertext either', async () => {
    const mine = await sessions.create(owner.id, {
      prompt: 'hello', title: 'claimed', workspaceId: owner.workspaceId, provider: pool.slug,
    });
    let claim = await queue.claimSessionForRunner({ id: owner.runnerId }, 0, false, false);
    while (claim && claim.sessionId !== mine.id) {
      claim = await queue.claimSessionForRunner({ id: owner.runnerId }, 0, false, false);
    }
    assert.ok(claim, 'the runner was offered no session');
    const env = claim.agent.env ?? {};
    const rows_ = await db.poolCodexLogin.findMany({ where: { poolId: pool.id } });
    const forbidden = rows_.flatMap((row) => [row.accessTokenEnc, row.refreshTokenEnc]);
    assert.equal(forbidden.length, 2, 'the pool has no stored credential to look for');
    assert.deepEqual(
      Object.entries(env).filter(([, value]) => forbidden.some((secret) => value.includes(secret))),
      [],
      'the claim payload carried the account’s credential',
    );
    // And the plaintext the tokens were encrypted from is nowhere in it either.
    for (const secret of ['access-token-not-a-real-one', 'refresh-token-not-a-real-one']) {
      assert.equal(Object.values(env).some((value) => value.includes(secret)), false);
    }
  });

  await t.test('the page reads the account by its email and four characters, and never says a missing quota is a refusal', async () => {
    const page = (await call(200, owner.id, 'GET', at)).json;
    assert.deepEqual(page.login, {
      state: 'ACTIVE',
      email: 'owner@example.invalid',
      plan: 'plus',
      fingerprint: `…${ACCOUNT_ID.slice(-4)}`,
      lastError: null,
      expiresAt: page.login.expiresAt,
      linkedAt: page.login.linkedAt,
      // Nothing has read this account's quota: that is what the null says, and the pool is runnable.
      usage: null,
      usageUnavailable: 'no quota has been read for this account yet',
      spentUntil: null,
    });
    assert.equal(page.unavailable, null, 'a pool with an account signed in is refused');
    assert.ok(!Number.isNaN(Date.parse(page.login.expiresAt)));
    // What no reader of another account's page can see: nothing here is on the stranger's.
    const listed = (await call(200, stranger.id, 'GET', 'providers/pools')).json as unknown[];
    assert.deepEqual(listed, []);
    assert.equal(JSON.stringify(listed).includes('owner@example.invalid'), false);

    // Only the credential's fate moves the account: the gateway's 401 marks it out, the owner is the only
    // one who can sign it in again, and the page says which of the two it is.
    assert.equal(await login.markSignedOut(pool.id, 'your authentication token has been invalidated'), true);
    const out = (await call(200, owner.id, 'GET', at)).json;
    assert.deepEqual(
      { state: out.login.state, lastError: out.login.lastError, unavailable: out.unavailable },
      {
        state: 'SIGNED_OUT',
        lastError: 'your authentication token has been invalidated',
        unavailable:
          'the ChatGPT account owner@example.invalid on the pool "My ChatGPT" was rejected by OpenAI — sign in again on its page, or pick another provider',
      },
    );
    assert.match(String(await queue.accountPoolRefusal(owner.id, pool.slug)), /was rejected by OpenAI/u);
    assert.equal(await login.markSignedOut(pool.id, 'second refusal'), false, 'a signed-out account moved twice');
  });

  await t.test('the sign-in doors are the owner’s: a stranger’s poll of a pool they cannot see is that pool not existing', async () => {
    // The account is still there and still signed out — nothing the stranger did reached it.
    const rows = await db.poolCodexLogin.findMany({ where: { poolId: pool.id } });
    assert.deepEqual(rows.map((row) => [row.accountId, row.state]), [[ACCOUNT_ID, 'SIGNED_OUT']]);
    // Its owner signs the account out of the pool entirely; the tokens go with it.
    assert.deepEqual(await login.signOut(owner.id, pool.id), { removed: 1 });
    assert.equal(await db.poolCodexLogin.count({ where: { poolId: pool.id } }), 0);
    const page = (await call(200, owner.id, 'GET', at)).json;
    assert.equal(page.login, null);
    assert.match(String(page.unavailable), /no ChatGPT account signed in/u);
  });
});
