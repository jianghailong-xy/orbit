/**
 * Account pools' security boundary on real PostgreSQL, written as regressions of their own rather than as
 * side effects of the specs that built pools (provider-pool, pool-claim-selection, pool-provider-doors).
 * Each is a property nothing downstream asks about again once it slips:
 *
 *  (A) A personal account pool resolves only for its owner's sessions. Another owner naming its slug gets
 *      none of its tokens, at every door that accepts a provider slug or builds an engine's environment —
 *      and what is asserted is what each door RESOLVED: the row it wrote or did not write, the
 *      environment it handed out. Never the wording of a refusal.
 *  (C) No browser-visible providers or pool payload carries a credential. Every route the providers
 *      controllers declare is called, refusals included, and no body holds `sk-ant`, a stored
 *      ciphertext or a key field. The owner's own reveal route, which exists to return a key, is the
 *      positive control that shows the check can see one.
 *  (D) The key never lands in an agent's env (Workspace.env), nor anywhere else at rest: it is
 *      decrypted at the claim, into the job env alone.
 *
 * (B) — the usage probe and pool admission — needs no database: pool-security-boundary.spec.ts.
 *
 * Every refusal is paired with the same request made for the owner, which has to go through, so a door
 * that refused everything could not pass. Everything between the rows and the answers is production
 * code: the providers controllers behind real HTTP, with the global pipe, interceptors and filter
 * main.ts installs; SessionsService, TasksService, ProvidersService, QueueService, RunnerApiController
 * and the quota cache (ProviderPlanUsageService). Only the network the server calls out on (`fetch`) and
 * the check of a person's signed token are stand-ins.
 *
 * It only adds rows, under ids and slugs of its own, and refuses to run anywhere but the disposable
 * server `coordinator-pg-test-safety` identifies.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Module, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, RunStatus, RunnerStatus, type ModelProvider } from '@prisma/client';
import { uuidToBase62, type ClaimedSession } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { sha256 } from '../common/crypto.util';
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
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RunnerProvidersController } from '../runner-api/runner-providers.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { AdminProvidersController } from './admin-providers.controller';
import { accountPoolRuntime } from './custom-provider';
import { OAUTH_USAGE_URL } from './plan-usage';
import { ProviderPlanUsageService } from './plan-usage.service';
import { encryptSecret } from './provider-crypto';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';

const URL = process.env.COORDINATOR_PG_URL;
// The spec encrypts keys and the code under test decrypts them; both only need the same secret.
process.env.PROVIDER_SECRET_KEY ??= 'pool-security-boundary-spec';

const ANTHROPIC = 'https://api.anthropic.com';

/** Every plaintext key this spec makes: none may reach a browser payload, an agent's env or a table. */
const KEYS = new Set<string>();
const minted = (key: string) => (KEYS.add(key), key);
const subscription = () => minted(`sk-ant-oat01-${randomUUID()}`);
const metered = () => minted(`sk-ant-api03-${randomUUID()}`);

/** What the usage endpoint answers for each key. A key with no answer gets a 500: nothing to read. */
const usageAnswers = new Map<string, unknown>();

/** The endpoint's body for a 5-hour window at `utilization`, resetting in two hours. */
function fiveHour(utilization: number) {
  return { five_hour: { utilization, resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() } };
}

/** The network the server calls out on: the usage endpoint, and nothing else that answers. */
const serverNetwork = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
  const key = String(init?.headers?.authorization ?? '').replace(/^Bearer /, '');
  const body = String(input) === OAUTH_USAGE_URL ? usageAnswers.get(key) : undefined;
  return body === undefined
    ? new Response('unavailable', { status: 500 })
    : new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

/** How this spec itself reaches the doors it opens — kept before `serverNetwork` replaces the global. */
const realFetch = globalThis.fetch;

/** Every broadcast the code under test makes: (C) reads what would have reached a client's stream. */
const broadcasts: unknown[][] = [];
const realtime = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === 'then' ? undefined : (...args: unknown[]) => void broadcasts.push([String(key), ...args]),
  },
) as RealtimeService;

/** A runner and the agent (workspace) bound to it. */
interface Machine {
  label: string;
  runnerId: string;
  /** The runner's bearer token, for the runner-facing door. */
  runnerToken: string;
  workspaceId: string;
}

/** What each agent's env was configured with, by workspace id — all (D) accepts finding there after. */
const configuredEnv = new Map<string, Record<string, string>>();

async function machine(db: PrismaClient, ownerId: string, label: string): Promise<Machine> {
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const runnerToken = `pool-security-runner-${randomUUID()}`;
  const env = { ORBIT_POOL_SECURITY_AGENT: label };
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: sha256(runnerToken),
      status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true, workDir: `/tmp/${label}`, env },
  });
  configuredEnv.set(workspaceId, env);
  return { label, runnerId, runnerToken, workspaceId };
}

async function person(db: PrismaClient, label: string, role = 'MEMBER'): Promise<string> {
  const id = randomUUID();
  await db.user.create({
    data: { id, email: `${label}-${id}@pool-security.invalid`, name: label, passwordHash: 'x', role },
  });
  return id;
}

interface Account {
  row: ModelProvider;
  /** The plaintext key, which only the job env of its owner's own sessions may ever carry. */
  key: string;
}

/** One of `ownerId`'s own Claude credentials — by default a subscription on api.anthropic.com, the only
 *  kind a pool admits. */
async function account(db: PrismaClient, ownerId: string, label: string, key = subscription()): Promise<Account> {
  const row = await db.modelProvider.create({
    data: { slug: `pool-security-${randomUUID()}`, label, runtime: 'claude', baseUrl: ANTHROPIC, apiKeyEnc: encryptSecret(key), ownerId },
  });
  return { row, key };
}

const pub = (account: Account) => uuidToBase62(account.row.id);

/**
 * A session row on `provider`, written straight into the table — which is the only way another owner's
 * pool gets onto one, since every door refuses to write it there (A2). Built-in only for `claude`.
 */
async function sessionOn(
  db: PrismaClient,
  ownerId: string,
  at: Machine,
  provider: string,
  status: RunStatus,
  started = false,
): Promise<string> {
  const session = await db.session.create({
    data: {
      title: 'pool security',
      prompt: 'hello',
      status,
      ownerId,
      creatorId: ownerId,
      workspaceId: at.workspaceId,
      assignedRunnerId: at.runnerId,
      provider,
      providerBuiltin: provider === 'claude',
      model: 'claude-opus-5',
      permissionMode: 'default',
      usesRuntimeDefaultModel: true,
      // What an engine that has run leaves behind: what a live one is re-spawned from, and what a
      // terminal one needs to be revivable at all.
      ...(started ? { numTurns: 1, runtimeSessionId: randomUUID(), startedAt: new Date() } : {}),
    },
    select: { id: true },
  });
  return session.id;
}
const queued = (db: PrismaClient, ownerId: string, at: Machine, provider: string) =>
  sessionOn(db, ownerId, at, provider, RunStatus.PENDING);
/** An engine up and idle on `provider` — what a provider switch re-spawns and a restarted runner reclaims. */
const live = (db: PrismaClient, ownerId: string, at: Machine, provider: string) =>
  sessionOn(db, ownerId, at, provider, RunStatus.AWAITING_INPUT, true);
/** A run that ended but can be revived. */
const ended = (db: PrismaClient, ownerId: string, at: Machine, provider: string) =>
  sessionOn(db, ownerId, at, provider, RunStatus.FAILED, true);

const TASK_CHECK = {
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
} as const;

/** `value` as the text it would go over the wire as. Rows carry BIGINT columns, which main.ts serializes. */
const wire = (value: unknown) =>
  JSON.stringify(value ?? null, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

/** A credential in a response body: the key in the clear, a stored ciphertext, or a field named for one. */
function credentialsIn(text: string, ciphertexts: Iterable<string>): string[] {
  const found: string[] = [];
  if (/sk-ant/i.test(text)) found.push('an sk-ant key');
  for (const ciphertext of ciphertexts) {
    if (text.includes(ciphertext)) {
      found.push('a stored ciphertext');
      break;
    }
  }
  if (/"apiKey(?:Enc)?"\s*:/.test(text)) found.push('a key field');
  return found;
}

/**
 * What a door did with a request, without reading why: the assertions on another owner's pool are about
 * what the door resolved and wrote, and a refusal is only checked AFTER that — never by its wording.
 */
async function settle(request: Promise<unknown>): Promise<'went through' | 'refused'> {
  try {
    await request;
    return 'went through';
  } catch {
    return 'refused';
  }
}

/** Every route the given controllers declare, as `METHOD path/with/:params`. */
function routesOf(...controllers: Array<new (...args: never[]) => unknown>): string[] {
  return controllers.flatMap((controller) => {
    const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
    return Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
      const handler = (controller.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function' || name === 'constructor') return [];
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) return [];
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      return [`${method} ${[prefix, path].filter((part) => part && part !== '/').join('/')}`];
    });
  });
}

/** The tables holding any of this spec's keys in the clear, read row by row as text. */
async function tablesHoldingAKey(client: Client): Promise<string[]> {
  const { rows: tables } = await client.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`,
  );
  // The sweep has to have read the tables a key could land in, or its empty answer means nothing.
  const names = tables.map((t) => t.name);
  for (const table of ['workspace', 'session', 'conversation_turn', 'run_event', 'model_provider', 'provider_pool']) {
    assert.ok(names.includes(table), `the sweep did not read ${table}`);
  }
  const holding: string[] = [];
  for (const name of names) {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${name.replace(/"/g, '""')}" AS r WHERE strpos(lower(r::text), 'sk-ant') > 0`,
    );
    if (rows[0].n > 0) holding.push(name);
  }
  return holding;
}

/** What the providers doors are built around; set before Nest builds them. */
const doorsOver: { providers: ProvidersService | null; prisma: unknown } = { providers: null, prisma: null };

@Module({
  controllers: [ProvidersController, AdminProvidersController, RunnerProvidersController],
  providers: [
    { provide: ProvidersService, useFactory: () => doorsOver.providers },
    { provide: PrismaService, useFactory: () => doorsOver.prisma },
    JwtAuthGuard,
    AdminRoleGuard,
    RunnerAuthGuard,
    Reflector,
    // A person is whoever their bearer names: what a verified token would say, with the user id as the token.
    { provide: JwtService, useValue: { verifyAsync: async (bearer: string) => ({ sub: bearer }) } },
  ],
})
class ProviderDoors {}

/** The doors, up and reachable, with main.ts's own layers around every handler. */
async function openDoors() {
  const app = await NestFactory.create(ProviderDoors, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  return { base: await app.getUrl(), close: () => app.close() };
}

/** One HTTP exchange with the doors, as a browser (or, for `runner/…`, a runner) had it. */
interface Answer {
  method: string;
  /** The route as the controller declares it, `:params` and all. */
  route: string;
  path: string;
  who: string;
  expected: number;
  status: number;
  text: string;
  json: any;
}

const suite = URL ? test : test.skip;

suite("account pools' security boundary, on real PostgreSQL", { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL!);
  globalThis.fetch = serverNetwork;

  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const sessions = new SessionsService(prisma, queue, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const runnerApi = new RunnerApiController(
    db as never, queue as never, realtime as never, {} as never, {} as never, {} as never,
  );
  doorsOver.providers = providers;
  doorsOver.prisma = db;
  const doors = await openDoors();
  t.after(async () => {
    await doors.close();
    globalThis.fetch = realFetch;
    await db.$disconnect();
    await client.end();
  });

  /** Every ciphertext a provider row has held while this spec ran, rotated and deleted ones included. */
  const ciphertexts = new Set<string>();
  const track = async () => {
    for (const row of await db.modelProvider.findMany({ select: { apiKeyEnc: true } })) ciphertexts.add(row.apiKeyEnc);
  };
  const names = new Map<string, string>();
  const answers: Answer[] = [];
  /** Ask a door, as `bearer`, and keep the answer for (C) — whose status is checked there, after the
   *  body: a 500 is no evidence, but a leak has to be reported as the leak it is. */
  async function ask(
    bearer: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    route: string,
    params: Record<string, string>,
    body: unknown,
    expected: number,
  ): Promise<Answer> {
    const path = route.replace(/:(\w+)/g, (_, param: string) => params[param] ?? assert.fail(`no ${param} for ${route}`));
    const response = await realFetch(`${doors.base}/api/${path}`, {
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
      /* not JSON: the text alone is checked */
    }
    const answer = { method, route, path, who: names.get(bearer) ?? bearer, expected, status: response.status, text, json };
    answers.push(answer);
    await track();
    return answer;
  }
  const statusOf = (answer: Answer) => `${answer.method} /api/${answer.path} as ${answer.who} → ${answer.status}: ${answer.text}`;
  /** `ask`, for a caller that goes on to use the answer: it has to be the one expected. */
  async function call(...args: Parameters<typeof ask>): Promise<Answer> {
    const answer = await ask(...args);
    assert.equal(answer.status, answer.expected, statusOf(answer));
    return answer;
  }

  /** The runner asking for work — which has to be `sessionId`. */
  async function claim(runnerId: string, sessionId: string): Promise<ClaimedSession> {
    const claimed = await queue.claimSessionForRunner({ id: runnerId }, 0, false, false);
    assert.ok(claimed, 'the runner was offered no session');
    assert.equal(claimed.sessionId, sessionId);
    return claimed;
  }
  /** The runner's inbox poll, until it is handed the reload a provider switch queued. */
  async function dequeueReload(sessionId: string, runnerId: string) {
    const dequeue = (runnerApi as unknown as {
      dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: string | null): Promise<
        { kind: string; env?: Record<string, string> } | null
      >;
    }).dequeueTurn.bind(runnerApi);
    for (let polls = 0; polls < 4; polls += 1) {
      const turn = await dequeue(sessionId, runnerId, null);
      assert.ok(turn, 'the inbox handed out nothing');
      if (turn.kind === 'reload') return turn;
    }
    throw new Error('the inbox never handed out the reload');
  }
  const token = (env: Record<string, string> | undefined) => env?.ANTHROPIC_AUTH_TOKEN;
  const recorded = (sessionId: string) =>
    db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { provider: true, status: true, poolMemberProviderId: true },
    });

  const alice = await person(db, 'alice');
  const bob = await person(db, 'bob');
  const admin = await person(db, 'admin', 'ADMIN');
  names.set(alice, 'alice').set(bob, 'bob').set(admin, 'an admin');
  const aliceHome = await machine(db, alice, 'alice-home');
  const bobHome = await machine(db, bob, 'bob-home');
  names.set(aliceHome.runnerToken, "alice's runner").set(bobHome.runnerToken, "bob's runner");

  // Alice's two subscriptions, Personal with the most 5-hour room; Bob's one.
  const work = await account(db, alice, 'Work');
  const personal = await account(db, alice, 'Personal');
  const theirs = await account(db, bob, 'Theirs');
  /** Every key of Alice's a pool of hers could hand out. None may reach anything of Bob's. */
  const hers = [work, personal];
  const herKeysIn = (value: unknown) => hers.filter((a) => wire(value).includes(a.key)).map((a) => a.row.label);
  usageAnswers.set(work.key, fiveHour(45));
  usageAnswers.set(personal.key, fiveHour(12));
  usageAnswers.set(theirs.key, fiveHour(30));
  // Every door reads the quota cache and never waits on the network, so the numbers go in first.
  await Promise.all([work, personal, theirs].map((a) => usage.refresh(a.row)));
  assert.equal(usage.snapshot(personal.row)?.fiveHour?.utilization, 12);
  await track();

  // Both pools made through the browser's own door, so (C) reads those answers too.
  async function poolOver(ownerId: string, label: string, members: Account[]) {
    await call(ownerId, 'POST', 'providers/pools', {}, { label, providerIds: members.map(pub) }, 201);
    return db.providerPool.findFirstOrThrow({ where: { ownerId, label }, select: { id: true, slug: true } });
  }
  const alicePool = await poolOver(alice, 'Claude accounts', hers);
  const bobPool = await poolOver(bob, 'His accounts', [theirs]);

  await t.test("(A1) another owner's pool slug resolves to nothing — accountPoolRuntime and resolvePoolMember themselves", async () => {
    // Positive control: for its owner, the slug is a Claude pool, and a session of hers resolves to a member.
    assert.equal(await accountPoolRuntime(db, alice, alicePool.slug), 'claude');
    const herSession = await live(db, alice, aliceHome, alicePool.slug);
    const chosen = await queue.resolvePoolMember(db, { id: herSession, ownerId: alice, poolMemberProviderId: null }, alicePool.slug);
    assert.equal(chosen?.id, personal.row.id);

    assert.equal(await accountPoolRuntime(db, bob, alicePool.slug), null, 'the write doors resolve her pool for him');
    const hisSession = await live(db, bob, bobHome, alicePool.slug);
    const resolved = await queue.resolvePoolMember(db, { id: hisSession, ownerId: bob, poolMemberProviderId: null }, alicePool.slug);
    assert.equal(resolved, null, `the claim resolves her pool for him, to ${resolved?.label}`);
    assert.equal((await recorded(hisSession)).poolMemberProviderId, null);
  });

  await t.test("(A2) a session opens on its owner's own pool, and on another owner's pool not at all", async () => {
    const at = await machine(db, bob, 'bob-opens');
    const own = await sessions.create(bob, { prompt: 'hello', title: 'on his pool', workspaceId: at.workspaceId, provider: bobPool.slug });
    assert.equal((await recorded(own.id)).provider, bobPool.slug);

    const attempt = await settle(
      sessions.create(bob, { prompt: 'hello', title: 'on her pool', workspaceId: at.workspaceId, provider: alicePool.slug }),
    );
    assert.deepEqual(
      await db.session.findMany({ where: { workspaceId: at.workspaceId, provider: alicePool.slug }, select: { id: true } }),
      [],
      'a session of his was written on her pool',
    );
    assert.equal(attempt, 'refused');
  });

  await t.test("(A2) a live session switches onto its owner's own pool, and onto another owner's pool not at all", async () => {
    const at = await machine(db, bob, 'bob-switches');
    const session = await live(db, bob, at, 'claude');

    const attempt = await settle(sessions.updateConfig(bob, session, { provider: alicePool.slug }));
    assert.equal((await recorded(session)).provider, 'claude', 'his session was moved onto her pool');
    assert.equal(await db.conversationTurn.count({ where: { sessionId: session } }), 0, 'a reload was queued onto her pool');
    assert.equal(attempt, 'refused');

    await sessions.updateConfig(bob, session, { provider: bobPool.slug });
    assert.equal((await recorded(session)).provider, bobPool.slug);
    assert.equal(await db.conversationTurn.count({ where: { sessionId: session, kind: 'reload' } }), 1);
  });

  await t.test("(A2) an ended session revives onto its owner's own pool, and onto another owner's pool not at all", async () => {
    const at = await machine(db, bob, 'bob-revives');
    const session = await ended(db, bob, at, 'claude');

    const attempt = await settle(
      sessions.resume(bob, session, { clientTurnId: randomUUID(), content: 'again', provider: alicePool.slug }),
    );
    assert.deepEqual(
      { ...(await recorded(session)), turns: await db.conversationTurn.count({ where: { sessionId: session } }) },
      { provider: 'claude', status: RunStatus.FAILED, poolMemberProviderId: null, turns: 0 },
      'his session was revived onto her pool',
    );
    assert.equal(attempt, 'refused');

    await sessions.resume(bob, session, { clientTurnId: randomUUID(), content: 'again', provider: bobPool.slug });
    const revived = await recorded(session);
    assert.equal(revived.provider, bobPool.slug);
    assert.equal(revived.status, RunStatus.PENDING);
  });

  await t.test("(A2) a task pins its owner's own pool, and another owner's pool not at all", async () => {
    const title = `pinned ${randomUUID()}`;
    const pinned = await tasks.create(bob, { title, provider: bobPool.slug, ...TASK_CHECK } as never);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: pinned.id } })).provider, bobPool.slug);

    const created = await settle(tasks.create(bob, { title: `${title} on hers`, provider: alicePool.slug, ...TASK_CHECK } as never));
    const repinned = await settle(tasks.update(bob, pinned.id, { provider: alicePool.slug }));
    assert.deepEqual(
      await db.task.findMany({ where: { ownerId: bob, provider: alicePool.slug }, select: { title: true } }),
      [],
      'a task of his was pinned to her pool',
    );
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: pinned.id } })).provider, bobPool.slug);
    assert.deepEqual({ created, repinned }, { created: 'refused', repinned: 'refused' });
  });

  await t.test("(A2) the provider list an agent reads names its owner's own pool, and another owner's not at all", async () => {
    const slugs = (answer: Answer) => (answer.json as Array<{ slug: string }>).map((p) => p.slug);
    const his = slugs(await call(bobHome.runnerToken, 'GET', 'runner/providers', {}, undefined, 200));
    assert.ok(his.includes(bobPool.slug), 'his own pool is missing from his list');
    assert.equal(his.includes(alicePool.slug), false, 'her pool is on his list');
    const theirs_ = slugs(await call(aliceHome.runnerToken, 'GET', 'runner/providers', {}, undefined, 200));
    assert.ok(theirs_.includes(alicePool.slug), 'her own pool is missing from her list');
    assert.equal(theirs_.includes(bobPool.slug), false, 'his pool is on her list');
  });

  await t.test("(A2) a mention of an agent that last ran on its owner's own pool opens a session there, and on another owner's pool none", async () => {
    // Two agents of Bob's: one whose project last ran on his pool, one whose last session names hers —
    // a row no door writes, put there by hand as a stale or forged history would be.
    const ownAgent = await machine(db, bob, 'bob-mentioned-own');
    const herAgent = await machine(db, bob, 'bob-mentioned-hers');
    await sessionOn(db, bob, ownAgent, bobPool.slug, RunStatus.SUCCEEDED, true);
    const forged = await sessionOn(db, bob, herAgent, alicePool.slug, RunStatus.SUCCEEDED, true);
    const task = await tasks.create(bob, { title: `mentions ${randomUUID()}`, ...TASK_CHECK } as never);
    const comment = await db.taskComment.create({
      data: {
        taskId: task.id,
        authorType: 'USER',
        authorId: bob,
        body: 'have a look at this',
        mentions: [ownAgent.workspaceId, herAgent.workspaceId],
        mentionDeliveryVersion: 1,
      },
      select: { id: true },
    });

    await tasks.deliverMentions();

    const deliveries = await db.taskCommentMentionDelivery.findMany({
      where: { commentId: comment.id },
      select: { workspaceId: true, status: true, errorCode: true, targetSessionId: true },
    });
    const to = (at: Machine) => deliveries.find((d) => d.workspaceId === at.workspaceId);
    const own = to(ownAgent);
    assert.equal(own?.status, 'SESSION_CREATED', JSON.stringify(own));
    assert.equal((await recorded(own!.targetSessionId!)).provider, bobPool.slug);

    const toHers = to(herAgent);
    assert.ok(toHers, 'no delivery was made for the second mention');
    assert.deepEqual(
      (await db.session.findMany({ where: { workspaceId: herAgent.workspaceId }, select: { id: true } })).map((s) => s.id),
      [forged],
      'the mention opened a session on her pool',
    );
    assert.equal(toHers.targetSessionId, null, 'the mention was bound to a session');
    assert.equal(toHers.errorCode, 'PROVIDER_UNAVAILABLE');
  });

  await t.test("(A3) the claim hands another owner's session none of the pool's tokens, whether it names the pool or a member", async () => {
    // Positive control: his own pool dispatches with his own key.
    const ownAt = await machine(db, bob, 'bob-claims-own');
    const own = await queued(db, bob, ownAt, bobPool.slug);
    assert.equal(token((await claim(ownAt.runnerId, own)).agent.env), theirs.key);

    const poolAt = await machine(db, bob, 'bob-claims-her-pool');
    const onPool = await queued(db, bob, poolAt, alicePool.slug);
    const claimed = await claim(poolAt.runnerId, onPool);
    assert.deepEqual(herKeysIn(claimed), [], 'her key is in what his runner was handed');
    // Exactly the agent's own env: the Claude default, with nothing resolved for the slug.
    assert.deepEqual(claimed.agent.env, configuredEnv.get(poolAt.workspaceId));
    assert.equal((await recorded(onPool)).poolMemberProviderId, null);

    const memberAt = await machine(db, bob, 'bob-claims-her-member');
    const onMember = await queued(db, bob, memberAt, personal.row.slug);
    const direct = await claim(memberAt.runnerId, onMember);
    assert.deepEqual(herKeysIn(direct), [], 'her key is in what his runner was handed');
    assert.deepEqual(direct.agent.env, configuredEnv.get(memberAt.workspaceId));
  });

  await t.test("(A3) a restarted runner's reclaim rebuilds another owner's session with none of the pool's tokens", async () => {
    const at = await machine(db, bob, 'bob-reclaims');
    const own = await live(db, bob, at, bobPool.slug);
    const onHers = await live(db, bob, at, alicePool.slug);
    const reclaimed = (await runnerApi.reclaim({ id: at.runnerId, ownerId: bob })).sessions;
    const rebuilt = (id: string) => reclaimed.find((s) => s.sessionId === id);

    assert.equal(token(rebuilt(own)?.agent.env), theirs.key, 'his own pool session was not rebuilt on his key');
    assert.ok(rebuilt(onHers), 'the session on her pool was left out of the reclaim, so it says nothing');
    assert.deepEqual(herKeysIn(rebuilt(onHers)), [], 'her key is in what his runner was handed');
    assert.deepEqual(rebuilt(onHers)?.agent.env, configuredEnv.get(at.workspaceId));
    assert.equal((await recorded(onHers)).poolMemberProviderId, null);
  });

  await t.test("(A3) a provider-switch reload re-spawns another owner's session with none of the pool's tokens", async () => {
    // Positive control: a switch onto his own pool re-spawns on his own key.
    const ownAt = await machine(db, bob, 'bob-reloads-own');
    const own = await live(db, bob, ownAt, 'claude');
    await sessions.updateConfig(bob, own, { provider: bobPool.slug });
    assert.equal(token((await dequeueReload(own, ownAt.runnerId)).env), theirs.key);

    // Past the door — the row and the queued reload written by hand, as nothing in the product can.
    const at = await machine(db, bob, 'bob-reloads-hers');
    const onHers = await live(db, bob, at, alicePool.slug);
    await db.conversationTurn.create({
      data: {
        sessionId: onHers,
        seq: 1,
        clientTurnId: randomUUID(),
        kind: 'reload',
        content: JSON.stringify({ provider: alicePool.slug }),
        status: 'PENDING',
      },
    });
    const reload = await dequeueReload(onHers, at.runnerId);
    assert.deepEqual(herKeysIn(reload), [], 'her key is in what his runner was handed');
    // Exactly the agent's own env: nothing was resolved for the slug at all.
    assert.deepEqual(reload.env, configuredEnv.get(at.workspaceId));
    assert.equal((await recorded(onHers)).poolMemberProviderId, null);
  });

  await t.test("(C) no providers or pool response carries a credential — every route, refusals included; only the owner's own reveal does", async () => {
    const meteredRow = await account(db, alice, 'Metered', metered());
    await track();
    // The pickers, the management lists and the pools, for both owners; the vendor catalogue.
    for (const person_ of [alice, bob]) {
      await ask(person_, 'GET', 'providers', {}, undefined, 200);
      await ask(person_, 'GET', 'providers/mine', {}, undefined, 200);
      await ask(person_, 'GET', 'providers/pools', {}, undefined, 200);
    }
    await ask(alice, 'GET', 'providers/presets', {}, undefined, 200);
    // A shared provider, which only an admin manages and whose key nobody reads back.
    const shared = await ask(admin, 'POST', 'admin/providers', {}, { label: `Shared ${randomUUID()}`, baseUrl: ANTHROPIC, apiKey: subscription() }, 201);
    const sharedId = String(shared.json.id);
    await ask(admin, 'GET', 'admin/providers', {}, undefined, 200);
    await ask(bob, 'GET', 'admin/providers', {}, undefined, 403);
    // The one body that exists to carry a key: its owner's own, on the reveal route.
    const reveal = await ask(alice, 'GET', 'providers/mine/:id/key', { id: pub(personal) }, undefined, 200);
    // …and on that route nobody gets anyone else's: another owner's provider, a pool, a shared provider.
    await ask(bob, 'GET', 'providers/mine/:id/key', { id: pub(personal) }, undefined, 404);
    await ask(alice, 'GET', 'providers/mine/:id/key', { id: uuidToBase62(alicePool.id) }, undefined, 404);
    await ask(alice, 'GET', 'providers/mine/:id/key', { id: sharedId }, undefined, 404);
    // A key typed into the connect form is probed with, not echoed.
    await ask(alice, 'POST', 'providers/test', {}, { baseUrl: ANTHROPIC, apiKey: subscription(), model: 'claude-opus-5', runtime: 'claude' }, 201);
    // One of her own connected, its key rotated, then deleted.
    const spare = await ask(alice, 'POST', 'providers/mine', {}, { label: 'Spare', baseUrl: ANTHROPIC, apiKey: subscription() }, 201);
    const spareId = String(spare.json.id);
    await ask(alice, 'PATCH', 'providers/mine/:id', { id: spareId }, { apiKey: subscription() }, 200);
    // A pool made, refused a metered key, refused to another owner, added to, emptied and deleted.
    const scratch = await ask(alice, 'POST', 'providers/pools', {}, { label: 'Scratch', providerIds: [spareId] }, 201);
    const scratchId = String(scratch.json.id);
    await ask(alice, 'POST', 'providers/pools', {}, { label: 'With a metered key', providerIds: [pub(meteredRow)] }, 400);
    await ask(bob, 'POST', 'providers/pools', {}, { label: 'With her key', providerIds: [pub(personal)] }, 404);
    await ask(alice, 'POST', 'providers/pools/:id/members', { id: scratchId }, { providerId: pub(work) }, 201);
    await ask(alice, 'POST', 'providers/pools/:id/members', { id: scratchId }, { providerId: pub(meteredRow) }, 400);
    await ask(bob, 'POST', 'providers/pools/:id/members', { id: scratchId }, { providerId: pub(theirs) }, 404);
    await ask(alice, 'DELETE', 'providers/pools/:id/members/:providerId', { id: scratchId, providerId: pub(work) }, undefined, 200);
    await ask(alice, 'DELETE', 'providers/pools/:id', { id: scratchId }, undefined, 200);
    await ask(alice, 'DELETE', 'providers/mine/:id', { id: spareId }, undefined, 200);
    // The runner's doors onto the same rows (`orbit provider create|update|delete`): one of hers
    // connected from her machine, its key rotated and the row deleted by the slug the list shows —
    // and another owner's runner, naming that slug, turned away as if it did not exist.
    const fromRunner = await ask(
      aliceHome.runnerToken,
      'POST',
      'runner/providers',
      {},
      { label: 'From her runner', baseUrl: ANTHROPIC, apiKey: subscription(), models: [{ value: 'claude-opus-5', label: 'Opus 5' }] },
      201,
    );
    const bySlug = { slug: String(fromRunner.json.slug) };
    await ask(aliceHome.runnerToken, 'PATCH', 'runner/providers/:slug', bySlug, { apiKey: subscription() }, 200);
    await ask(bobHome.runnerToken, 'PATCH', 'runner/providers/:slug', bySlug, { apiKey: subscription() }, 404);
    await ask(bobHome.runnerToken, 'DELETE', 'runner/providers/:slug', bySlug, undefined, 404);
    await ask(aliceHome.runnerToken, 'DELETE', 'runner/providers/:slug', bySlug, undefined, 200);
    await ask(admin, 'PATCH', 'admin/providers/:id', { id: sharedId }, { apiKey: subscription() }, 200);
    await ask(admin, 'DELETE', 'admin/providers/:id', { id: sharedId }, undefined, 200);

    // The check sees a key where there is one: the reveal, caught as exactly that.
    assert.deepEqual(credentialsIn(reveal.text, ciphertexts), ['an sk-ant key', 'a key field']);
    const leaks = answers
      .filter((answer) => answer !== reveal)
      .flatMap((answer) => {
        const found = credentialsIn(answer.text, ciphertexts);
        return found.length ? [`${answer.method} /api/${answer.route} as ${answer.who} → ${answer.status}: ${found.join(', ')}`] : [];
      });
    assert.deepEqual(leaks, [], 'responses carrying a credential');
    const pushed = broadcasts.filter((broadcast) => credentialsIn(wire(broadcast), ciphertexts).length > 0);
    assert.deepEqual(pushed, [], 'broadcasts carrying a credential');
    // And each was the answer its request should get: a body checked is only evidence if it is that one.
    assert.deepEqual(answers.filter((answer) => answer.status !== answer.expected).map(statusOf), []);
    assert.equal(reveal.json.apiKey, personal.key);
  });

  await t.test('(C) …and those responses are every route the providers controllers declare', () => {
    const declared = routesOf(ProvidersController, AdminProvidersController, RunnerProvidersController);
    assert.ok(declared.length >= 18, `read only ${declared.length} routes off the controllers`);
    const swept = new Set(answers.map((answer) => `${answer.method} ${answer.route}`));
    assert.deepEqual(
      declared.filter((route) => !swept.has(route)),
      [],
      'routes whose responses were never checked for a credential — call them in (C)',
    );
  });

  await t.test("(D) the key is decrypted into the job env at the claim, and lands nowhere at rest: not an agent's env, not any table", async () => {
    // Positive control: the claim does carry it — Personal's, the most 5-hour room — beside the agent's own env.
    const at = await machine(db, alice, 'alice-claims');
    const session = await queued(db, alice, at, alicePool.slug);
    const claimed = await claim(at.runnerId, session);
    assert.equal(token(claimed.agent.env), personal.key);
    assert.equal(claimed.agent.env?.ORBIT_POOL_SECURITY_AGENT, at.label);
    // Rotated, the next claim carries the new key: decrypted from the row at the claim, kept nowhere.
    const rotated = subscription();
    await providers.update(alice, personal.row.id, { apiKey: rotated });
    await db.session.update({ where: { id: session }, data: { status: RunStatus.PENDING } });
    assert.equal(token((await claim(at.runnerId, session)).agent.env), rotated);

    // Every agent this spec made holds exactly the env it was configured with, after every door above.
    const agents = await db.workspace.findMany({
      where: { id: { in: [...configuredEnv.keys()] } },
      select: { id: true, name: true, env: true },
    });
    assert.equal(agents.length, configuredEnv.size);
    for (const agent of agents) assert.deepEqual(agent.env, configuredEnv.get(agent.id), `${agent.name}'s env`);

    // The sweep sees a key where one lands: planted in an agent's env, in a transaction rolled back.
    await client.query('BEGIN');
    try {
      await client.query(`UPDATE workspace SET env = jsonb_build_object('ANTHROPIC_AUTH_TOKEN', $1::text) WHERE id = $2::uuid`, [
        rotated,
        at.workspaceId,
      ]);
      assert.deepEqual(await tablesHoldingAKey(client), ['workspace']);
    } finally {
      await client.query('ROLLBACK');
    }
    // A provider's key is at rest as ciphertext only; nothing else holds one at all.
    assert.deepEqual(await tablesHoldingAKey(client), [], 'tables holding a key in the clear');
  });
});
