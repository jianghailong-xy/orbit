/**
 * An account pool's admission, closed at the doors T6's regression found open — on real PostgreSQL. Each
 * part is asserted as what a door RESOLVED (the row it wrote or left alone, the environment it handed out,
 * the line it put in the transcript) before anything about the words it answered with:
 *
 *  (1) An edit is held to the admission joining was. A member of an account pool is not edited into a
 *      metered key, an endpoint that is not api.anthropic.com or a runtime that is not Claude
 *      (PATCH /providers/mine/:id): the edit is refused with the reason joining would have been refused
 *      with, and the row stays exactly as it was, in its pool. Rotating to another subscription token goes
 *      through, and the next claim carries that token.
 *  (2) Every door that takes a provider — opening a session (named, or inherited from the project's last
 *      one), switching a live session or reviving an ended one onto it, pinning a task, answering an
 *      @mention — refuses a pool with no account in it, and a pool none of whose accounts can run (each
 *      disabled, turned away by the pool's own admission, or refused by the usage endpoint), saying why in
 *      English. A pool whose accounts are only spent is taken at every one of them: it waits for a reset.
 *  (3) A pool that loses its last account that can run under a session it already has — emptied, or every
 *      key refused — still dispatches that session's claim, on the Claude default as it always did, and the
 *      transcript now says so: which pool, and where the run went.
 *  (4) No session payload that carries a pool's member — the session lists, the detail, the transcript, the
 *      turns, the search — holds `sk-ant`, a stored ciphertext, a key field or an endpoint.
 *
 * Every refusal is paired with the same request made with a pool or a key that qualifies, which has to go
 * through, so a door that refused everything could not pass. Everything between the rows and the answers is
 * production code: the providers and sessions controllers behind real HTTP, with the global pipe,
 * interceptors and filter main.ts installs; SessionsService, TasksService, ProvidersService, QueueService,
 * RunnerApiController and the quota cache (ProviderPlanUsageService). Only the network the server calls out
 * on (`fetch`) and the check of a person's signed token are stand-ins.
 *
 * It only adds rows, under ids and slugs of its own, and refuses to run anywhere but the disposable server
 * `coordinator-pg-test-safety` identifies.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, RunStatus, RunnerStatus, type ModelProvider } from '@prisma/client';
import { RunEventType, uuidToBase62, type ClaimedSession } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
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
import { SessionTagsService } from '../session-tags/session-tags.service';
import { AutoRetryService } from '../sessions/auto-retry.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsController } from '../sessions/sessions.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { OAUTH_USAGE_URL } from './plan-usage';
import { ProviderPlanUsageService } from './plan-usage.service';
import { encryptSecret } from './provider-crypto';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';

declare global {
  interface BigInt { toJSON(): string; }
}
// `main.ts` installs this before it creates the app, and a session's detail needs it: the row carries
// BIGINT columns that Prisma maps to native BigInts, which `JSON.stringify` throws on.
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const URL = process.env.COORDINATOR_PG_URL;
// The spec encrypts keys and the code under test decrypts them; both only need the same secret.
process.env.PROVIDER_SECRET_KEY ??= 'pool-admission-closure-spec';

const ANTHROPIC = 'https://api.anthropic.com';
/** Somewhere that is not Anthropic, which an edit tries to move a member's subscription token to. */
const GATEWAY = 'https://gateway.pool-closure.invalid';

/** Every plaintext key this spec makes: none may reach a session payload. */
const KEYS = new Set<string>();
const minted = (key: string) => (KEYS.add(key), key);
const subscription = () => minted(`sk-ant-oat01-${randomUUID()}`);
const metered = () => minted(`sk-ant-api03-${randomUUID()}`);

/** What the usage endpoint answers for each key. A key with no answer gets a 500: nothing to read. */
const usageAnswers = new Map<string, { status: number; body: unknown }>();
/** The endpoint's body for a 5-hour window at `utilization`, resetting in two hours. */
const fiveHour = (utilization: number) => ({
  status: 200,
  body: { five_hour: { utilization, resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() } },
});
/** The endpoint turning the credential itself away — final, as ProviderPlanUsageService takes it. */
const REFUSED = { status: 401, body: { error: { message: 'OAuth token does not meet scope requirement user:profile' } } };

/** The network the server calls out on: the usage endpoint, and nothing else that answers. */
const serverNetwork = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
  const key = String(init?.headers?.authorization ?? '').replace(/^Bearer /, '');
  const answer = String(input) === OAUTH_USAGE_URL ? usageAnswers.get(key) : undefined;
  return answer
    ? new Response(JSON.stringify(answer.body), { status: answer.status })
    : new Response('unavailable', { status: 500 });
}) as typeof fetch;

/** How this spec itself reaches the doors it opens — kept before `serverNetwork` replaces the global. */
const realFetch = globalThis.fetch;

/** Every broadcast the code under test makes: (4) reads what would have reached a client's stream. */
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
  workspaceId: string;
}

/** What each agent's env was configured with: all a claim on the Claude default may hand out. */
const configuredEnv = new Map<string, Record<string, string>>();

async function machine(db: PrismaClient, ownerId: string, label: string): Promise<Machine> {
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const env = { ORBIT_POOL_CLOSURE_AGENT: label };
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `x-${runnerId}`,
      status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true, workDir: `/tmp/${label}`, env },
  });
  configuredEnv.set(workspaceId, env);
  return { label, runnerId, workspaceId };
}

async function person(db: PrismaClient, label: string): Promise<string> {
  const id = randomUUID();
  await db.user.create({
    data: { id, email: `${label}-${id}@pool-closure.invalid`, name: label, passwordHash: 'x' },
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
async function account(
  db: PrismaClient,
  ownerId: string,
  label: string,
  over: { key?: string; runtime?: string; baseUrl?: string } = {},
): Promise<Account> {
  const key = over.key ?? subscription();
  const row = await db.modelProvider.create({
    data: {
      slug: `pool-closure-${randomUUID()}`,
      label,
      runtime: over.runtime ?? 'claude',
      baseUrl: over.baseUrl ?? ANTHROPIC,
      apiKeyEnc: encryptSecret(key),
      ownerId,
    },
  });
  return { row, key };
}

const pub = (id: string) => uuidToBase62(id);

/** A session row on `provider`, written straight into the table: a project's history, or a session that
 *  was opened while its pool could still run. */
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
      title: 'pool closure',
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
      ...(started ? { numTurns: 1, runtimeSessionId: randomUUID(), startedAt: new Date() } : {}),
    },
    select: { id: true },
  });
  return session.id;
}
/** An engine up and idle on `provider` — what a provider switch re-spawns. */
const live = (db: PrismaClient, ownerId: string, at: Machine, provider: string) =>
  sessionOn(db, ownerId, at, provider, RunStatus.AWAITING_INPUT, true);
/** A run that ended but can be revived. */
const ended = (db: PrismaClient, ownerId: string, at: Machine, provider: string) =>
  sessionOn(db, ownerId, at, provider, RunStatus.FAILED, true);
/** The project's last interactive session, which a session opened without a provider starts from. */
const history = (db: PrismaClient, ownerId: string, at: Machine, provider: string) =>
  sessionOn(db, ownerId, at, provider, RunStatus.SUCCEEDED, true);

const TASK_CHECK = {
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
} as const;

/** `value` as the text it would go over the wire as. Rows carry BIGINT columns, which main.ts serializes. */
const wire = (value: unknown) =>
  JSON.stringify(value ?? null, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

/** A credential or an endpoint in a body: the key in the clear, a stored ciphertext, a field named for
 *  either, or an endpoint's address. */
function credentialsIn(text: string, ciphertexts: Iterable<string>): string[] {
  const found: string[] = [];
  if (/sk-ant/i.test(text)) found.push('an sk-ant key');
  for (const ciphertext of ciphertexts) {
    if (text.includes(ciphertext)) {
      found.push('a stored ciphertext');
      break;
    }
  }
  if (/"(?:apiKey|apiKeyEnc|ANTHROPIC_AUTH_TOKEN)"\s*:/.test(text)) found.push('a key field');
  if (/"(?:baseUrl|ANTHROPIC_BASE_URL)"\s*:/.test(text)) found.push('an endpoint field');
  if (text.includes('api.anthropic.com') || text.includes(new globalThis.URL(GATEWAY).host)) found.push('an endpoint');
  return found;
}

/** What a door did with a request, and what it said if it refused — read only after what it wrote. */
async function outcome(request: Promise<unknown>): Promise<{ went: boolean; said: string }> {
  try {
    await request;
    return { went: true, said: '' };
  } catch (error) {
    return { went: false, said: error instanceof Error ? error.message : String(error) };
  }
}

/** What the doors are built around; set before Nest builds them. */
const doorsOver: { providers: unknown; sessions: unknown; prisma: unknown } = {
  providers: null,
  sessions: null,
  prisma: null,
};

@Module({
  controllers: [ProvidersController, SessionsController],
  providers: [
    { provide: ProvidersService, useFactory: () => doorsOver.providers },
    { provide: SessionsService, useFactory: () => doorsOver.sessions },
    { provide: PrismaService, useFactory: () => doorsOver.prisma },
    { provide: RealtimeService, useValue: realtime },
    // The session routes this spec reads use none of these; the controller is built with them.
    { provide: SessionTagsService, useValue: {} },
    { provide: MergeReceiptService, useValue: {} },
    { provide: AutoRetryService, useValue: {} },
    JwtAuthGuard,
    Reflector,
    // A person is whoever their bearer names: what a verified token would say, with the user id as the token.
    { provide: JwtService, useValue: { verifyAsync: async (bearer: string) => ({ sub: bearer }) } },
  ],
})
class Doors {}

/** The doors, up and reachable, with main.ts's own layers around every handler. */
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

/** One HTTP exchange with the doors, as a browser had it. */
interface Answer {
  method: string;
  path: string;
  status: number;
  text: string;
  json: any;
}

const suite = URL ? test : test.skip;

suite("an account pool's admission, closed at every door, on real PostgreSQL", { timeout: 600_000 }, async (t) => {
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
  doorsOver.sessions = sessions;
  doorsOver.prisma = db;
  const doors = await openDoors();
  t.after(async () => {
    await doors.close();
    globalThis.fetch = realFetch;
    await db.$disconnect();
    await client.end();
  });

  /** Every ciphertext a provider row has held while this spec ran, rotated ones included. */
  const ciphertexts = new Set<string>();
  const track = async () => {
    for (const row of await db.modelProvider.findMany({ select: { apiKeyEnc: true } })) ciphertexts.add(row.apiKeyEnc);
  };
  /** Every session answer (4) reads. */
  const sessionAnswers: Answer[] = [];
  async function ask(bearer: string, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<Answer> {
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
    return { method, path, status: response.status, text, json };
  }
  const statusOf = (answer: Answer) => `${answer.method} /api/${answer.path} → ${answer.status}: ${answer.text}`;

  /** The runner asking for work — which has to be `sessionId`. */
  async function claim(runnerId: string, sessionId: string): Promise<ClaimedSession> {
    const claimed = await queue.claimSessionForRunner({ id: runnerId }, 0, false, false);
    assert.ok(claimed, 'the runner was offered no session');
    assert.equal(claimed.sessionId, sessionId);
    return claimed;
  }
  /** The session's next message queued, which is what has the runner claim it again. */
  const nextTurn = (sessionId: string) =>
    db.session.update({ where: { id: sessionId }, data: { status: RunStatus.PENDING } });
  /** The runner reporting its engine up: the first event of the process the claim just spawned. */
  async function engineStarted(runnerId: string, sessionId: string, seq: number) {
    const { runtimeSessionId } = await db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { runtimeSessionId: true },
    });
    await runnerApi.events({ id: runnerId }, sessionId, {
      events: [{
        seq,
        type: RunEventType.SYSTEM,
        ts: new Date().toISOString(),
        payload: { subtype: 'init', sessionId: runtimeSessionId, model: 'claude-opus-5' },
      }],
    });
  }
  /** The lines the transcript carries about the pool, in order. */
  const noticesOf = async (sessionId: string) =>
    (await db.runEvent.findMany({ where: { sessionId }, orderBy: { seq: 'asc' }, select: { payload: true } }))
      .map((event) => (event.payload as { notice?: unknown }).notice)
      .filter((notice): notice is string => typeof notice === 'string');
  const token = (env: Record<string, string> | undefined) => env?.ANTHROPIC_AUTH_TOKEN;
  const recorded = (sessionId: string) =>
    db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { provider: true, status: true, poolMemberProviderId: true, poolSwitchNotice: true },
    });
  const memberIdsOf = async (poolId: string) =>
    (await db.providerPoolMember.findMany({ where: { poolId }, select: { providerId: true } }))
      .map((member) => member.providerId)
      .sort();

  const alice = await person(db, 'alice');
  const bob = await person(db, 'bob');

  // Alice's pool of two subscriptions, Work with the most 5-hour room.
  const work = await account(db, alice, 'Work');
  const personal = await account(db, alice, 'Personal');
  usageAnswers.set(work.key, fiveHour(10));
  usageAnswers.set(personal.key, fiveHour(50));
  // Every door reads the quota cache and never waits on the network, so the numbers go in first.
  await Promise.all([work, personal].map((a) => usage.refresh(a.row)));
  assert.equal(usage.snapshot(work.row)?.fiveHour?.utilization, 10);
  const alicePool = await providers.createPool(alice, { label: 'Claude accounts', providerIds: [work.row.id, personal.row.id] });
  await track();

  // ─── (2)'s pools ─────────────────────────────────────────────────────────────────────────────────
  // No account at all, through the door that makes pools.
  const empty = await providers.createPool(alice, { label: 'Nothing in it', providerIds: [] });
  // Three accounts, none of which can run, each for a reason of its own: Refused key's key was refused by
  // the usage endpoint; Metered since holds a metered key, put there before edits were held to the pool's
  // admission (written straight into the table, as no door can any more); Switched off is disabled.
  const refusedKey = await account(db, alice, 'Refused key');
  const meteredSince = await account(db, alice, 'Metered since');
  const switchedOff = await account(db, alice, 'Switched off');
  usageAnswers.set(refusedKey.key, REFUSED);
  usageAnswers.set(switchedOff.key, fiveHour(5));
  const unusable = await providers.createPool(alice, {
    label: 'None can run',
    providerIds: [refusedKey.row.id, meteredSince.row.id, switchedOff.row.id],
  });
  await usage.refresh(refusedKey.row);
  assert.equal(usage.refused(refusedKey.row), true, 'the endpoint refusal did not register');
  await db.modelProvider.update({ where: { id: meteredSince.row.id }, data: { apiKeyEnc: encryptSecret(metered()) } });
  await db.modelProvider.update({ where: { id: switchedOff.row.id }, data: { enabled: false } });
  // Two accounts whose every window is spent: nothing runs until a reset, and then it does.
  const spentA = await account(db, alice, 'Spent A');
  const spentB = await account(db, alice, 'Spent B');
  usageAnswers.set(spentA.key, fiveHour(100));
  usageAnswers.set(spentB.key, fiveHour(100));
  await Promise.all([spentA, spentB].map((a) => usage.refresh(a.row)));
  const spent = await providers.createPool(alice, { label: 'All spent', providerIds: [spentA.row.id, spentB.row.id] });
  await track();

  /** Each refused pool, and what its refusal has to say. */
  const refusedPools = [
    { pool: empty, says: [/the account pool "Nothing in it" has no accounts in it/] },
    {
      pool: unusable,
      says: [
        /no account in the pool "None can run" can run/,
        /Refused key: key refused/,
        /Metered since: Metered API key — no 5-hour window/,
        /Switched off: disabled/,
      ],
    },
  ];
  const saysWhy = (said: string, says: RegExp[], door: string) => {
    for (const phrase of says) assert.match(said, phrase, `${door}'s refusal does not say why`);
  };

  // A session on Alice's pool: (1) claims it before and after a key rotation, and (4) reads it back.
  const aliceAt = await machine(db, alice, 'alice-claims');
  const sticky = await sessions.create(alice, {
    prompt: 'hello', title: 'on her pool', workspaceId: aliceAt.workspaceId, provider: alicePool.slug,
  });

  await t.test('(1) a pool member is not edited into what the pool would refuse; the row stays as it was, in the pool — and a key rotated to another subscription is taken, and claimed with', async () => {
    // It runs on Work, the most 5-hour room — and stays on it while Work can run.
    assert.equal(token((await claim(aliceAt.runnerId, sticky.id)).agent.env), work.key);
    assert.equal((await recorded(sticky.id)).poolMemberProviderId, work.row.id);

    // What joining the pool answers a provider with each defect: the answer the edit has to give.
    const meteredRow = await account(db, alice, 'Metered', { key: metered() });
    const proxyRow = await account(db, alice, 'Proxy', { baseUrl: GATEWAY });
    const codexRow = await account(db, alice, 'Codex', { runtime: 'codex' });
    const edits = [
      { edit: { apiKey: metered() }, joining: meteredRow, reason: 'NOT_SUBSCRIPTION_TOKEN' },
      { edit: { baseUrl: GATEWAY }, joining: proxyRow, reason: 'NOT_ANTHROPIC_ENDPOINT' },
      { edit: { runtime: 'codex' }, joining: codexRow, reason: 'NOT_CLAUDE_RUNTIME' },
    ];
    for (const { edit, joining, reason } of edits) {
      const before = await db.modelProvider.findUniqueOrThrow({ where: { id: work.row.id } });
      const edited = await ask(alice, 'PATCH', `providers/mine/${pub(work.row.id)}`, edit);
      // What it resolved first: the row exactly as it was, and still in the pool.
      assert.deepEqual(
        await db.modelProvider.findUniqueOrThrow({ where: { id: work.row.id } }),
        before,
        `${JSON.stringify(edit)} changed the member's row`,
      );
      assert.deepEqual(await memberIdsOf(alicePool.id), [work.row.id, personal.row.id].sort(), 'Work left the pool');
      // Then the answer: refused, for the reason — and in the words — joining is refused with.
      assert.equal(edited.status, 400, statusOf(edited));
      const joined = await ask(alice, 'POST', `providers/pools/${pub(alicePool.id)}/members`, { providerId: pub(joining.row.id) });
      assert.equal(joined.status, 400, statusOf(joined));
      assert.equal(edited.json.reason, reason, statusOf(edited));
      assert.equal(joined.json.reason, reason, statusOf(joined));
      assert.equal(edited.json.code, joined.json.code);
      assert.equal(edited.json.message, joined.json.message.replace(`${joining.row.label}: `, 'Work: '));
    }
    assert.deepEqual(await memberIdsOf(alicePool.id), [work.row.id, personal.row.id].sort());

    // The same edits on a provider in no pool go through: what is held is membership, not the key.
    const loose = await account(db, alice, 'Loose');
    const looseEdit = await ask(alice, 'PATCH', `providers/mine/${pub(loose.row.id)}`, { apiKey: metered(), baseUrl: GATEWAY });
    assert.equal(looseEdit.status, 200, statusOf(looseEdit));

    // Rotated to another subscription token, the member is taken — and the next claim carries the new key.
    await track();
    const rotated = subscription();
    const rotation = await ask(alice, 'PATCH', `providers/mine/${pub(work.row.id)}`, { apiKey: rotated });
    assert.equal(rotation.status, 200, statusOf(rotation));
    await track();
    await nextTurn(sticky.id);
    const reclaimed = await claim(aliceAt.runnerId, sticky.id);
    assert.equal(token(reclaimed.agent.env), rotated);
    assert.equal(reclaimed.agent.env?.ANTHROPIC_BASE_URL, ANTHROPIC);
    assert.deepEqual(await memberIdsOf(alicePool.id), [work.row.id, personal.row.id].sort());
  });

  await t.test('(2) opening a session refuses a pool with no account, and one with none that can run — named or inherited; a pool that is only spent is taken', async () => {
    const at = await machine(db, alice, 'alice-opens');
    for (const { pool, says } of refusedPools) {
      const opened = await outcome(
        sessions.create(alice, { prompt: 'hello', title: `on ${pool.label}`, workspaceId: at.workspaceId, provider: pool.slug }),
      );
      assert.equal(await db.session.count({ where: { provider: pool.slug } }), 0, `a session was written on ${pool.label}`);
      assert.equal(opened.went, false);
      saysWhy(opened.said, says, 'SessionsService.create');
    }
    const onSpent = await sessions.create(alice, {
      prompt: 'hello', title: 'on the spent pool', workspaceId: at.workspaceId, provider: spent.slug,
    });
    assert.equal((await recorded(onSpent.id)).provider, spent.slug);

    // A project whose last session ran on the pool: a session opened without naming one starts there — or,
    // when the pool can run nothing, not at all.
    for (const { pool, says } of refusedPools) {
      const project = await machine(db, alice, `alice-inherits-${pool.slug}`);
      const last = await history(db, alice, project, pool.slug);
      const opened = await outcome(sessions.create(alice, { prompt: 'again', title: 'inherits', workspaceId: project.workspaceId }));
      assert.deepEqual(
        (await db.session.findMany({ where: { workspaceId: project.workspaceId }, select: { id: true } })).map((s) => s.id),
        [last],
        `a session was opened on ${pool.label} from the project's history`,
      );
      assert.equal(opened.went, false);
      saysWhy(opened.said, says, 'SessionsService.create (inherited)');
    }
    const spentProject = await machine(db, alice, 'alice-inherits-spent');
    await history(db, alice, spentProject, spent.slug);
    const inherited = await sessions.create(alice, { prompt: 'again', title: 'inherits', workspaceId: spentProject.workspaceId });
    assert.equal((await recorded(inherited.id)).provider, spent.slug);
  });

  await t.test('(2) switching a live session, or reviving an ended one, onto a pool that can run nothing is refused; onto a spent pool it goes through', async () => {
    for (const { pool, says } of refusedPools) {
      const at = await machine(db, alice, `alice-switches-${pool.slug}`);
      const session = await live(db, alice, at, 'claude');
      const switched = await outcome(sessions.updateConfig(alice, session, { provider: pool.slug }));
      assert.equal((await recorded(session)).provider, 'claude', `the session was moved onto ${pool.label}`);
      assert.equal(await db.conversationTurn.count({ where: { sessionId: session } }), 0, 'a reload was queued');
      assert.equal(switched.went, false);
      saysWhy(switched.said, says, 'updateConfig');

      const over = await ended(db, alice, at, 'claude');
      const revived = await outcome(
        sessions.resume(alice, over, { clientTurnId: randomUUID(), content: 'again', provider: pool.slug }),
      );
      assert.deepEqual(
        { ...(await recorded(over)), turns: await db.conversationTurn.count({ where: { sessionId: over } }) },
        { provider: 'claude', status: RunStatus.FAILED, poolMemberProviderId: null, poolSwitchNotice: null, turns: 0 },
        `the session was revived onto ${pool.label}`,
      );
      assert.equal(revived.went, false);
      saysWhy(revived.said, says, 'resume');
    }

    const at = await machine(db, alice, 'alice-switches-spent');
    const session = await live(db, alice, at, 'claude');
    await sessions.updateConfig(alice, session, { provider: spent.slug });
    assert.equal((await recorded(session)).provider, spent.slug);
    assert.equal(await db.conversationTurn.count({ where: { sessionId: session, kind: 'reload' } }), 1);
    const over = await ended(db, alice, at, 'claude');
    await sessions.resume(alice, over, { clientTurnId: randomUUID(), content: 'again', provider: spent.slug });
    const revived = await recorded(over);
    assert.equal(revived.provider, spent.slug);
    assert.equal(revived.status, RunStatus.PENDING);
  });

  await t.test('(2) a task is not pinned to a pool that can run nothing, created or edited; it is pinned to a spent pool', async () => {
    const pinned = await tasks.create(alice, { title: `pinned ${randomUUID()}`, provider: spent.slug, ...TASK_CHECK } as never);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: pinned.id } })).provider, spent.slug);
    for (const { pool, says } of refusedPools) {
      const title = `pinned to ${pool.label} ${randomUUID()}`;
      const created = await outcome(tasks.create(alice, { title, provider: pool.slug, ...TASK_CHECK } as never));
      const repinned = await outcome(tasks.update(alice, pinned.id, { provider: pool.slug }));
      assert.deepEqual(
        await db.task.findMany({ where: { ownerId: alice, provider: pool.slug }, select: { title: true } }),
        [],
        `a task was pinned to ${pool.label}`,
      );
      assert.equal((await db.task.findUniqueOrThrow({ where: { id: pinned.id } })).provider, spent.slug);
      assert.equal(created.went, false);
      assert.equal(repinned.went, false);
      saysWhy(created.said, says, 'TasksService.create');
      saysWhy(repinned.said, says, 'TasksService.update');
    }
    const repinned = await tasks.create(alice, { title: `pinned later ${randomUUID()}`, ...TASK_CHECK } as never);
    await tasks.update(alice, repinned.id, { provider: spent.slug });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: repinned.id } })).provider, spent.slug);
  });

  await t.test('(2) a mention of an agent whose project runs on a pool that can run nothing is held, not answered on the runner login; on a spent pool it is answered there', async () => {
    const agents = new Map<string, Machine>();
    for (const { pool } of [...refusedPools, { pool: spent }]) {
      const agent = await machine(db, alice, `alice-mentioned-${pool.slug}`);
      await history(db, alice, agent, pool.slug);
      agents.set(pool.slug, agent);
    }
    const task = await tasks.create(alice, { title: `mentions ${randomUUID()}`, ...TASK_CHECK } as never);
    const comment = await db.taskComment.create({
      data: {
        taskId: task.id,
        authorType: 'USER',
        authorId: alice,
        body: 'have a look at this',
        mentions: [...agents.values()].map((agent) => agent.workspaceId),
        mentionDeliveryVersion: 1,
      },
      select: { id: true },
    });

    await tasks.deliverMentions();

    const deliveries = await db.taskCommentMentionDelivery.findMany({
      where: { commentId: comment.id },
      select: { workspaceId: true, status: true, errorCode: true, lastError: true, targetSessionId: true },
    });
    const to = (slug: string) => deliveries.find((d) => d.workspaceId === agents.get(slug)!.workspaceId);
    const answered = to(spent.slug);
    assert.equal(answered?.status, 'SESSION_CREATED', JSON.stringify(answered));
    assert.equal((await recorded(answered!.targetSessionId!)).provider, spent.slug);

    for (const { pool, says } of refusedPools) {
      const held = to(pool.slug);
      assert.ok(held, `no delivery was made for the mention of the agent on ${pool.label}`);
      assert.equal(
        await db.session.count({ where: { workspaceId: agents.get(pool.slug)!.workspaceId } }),
        1,
        `the mention opened a session on ${pool.label}`,
      );
      assert.equal(held.targetSessionId, null, 'the mention was bound to a session');
      assert.equal(held.errorCode, 'PROVIDER_UNAVAILABLE', JSON.stringify(held));
      saysWhy(held.lastError ?? '', says, 'the mention delivery');
    }
  });

  await t.test("(3) a pool that loses its last account that can run under a session still dispatches it, on the Claude default — and the transcript names the pool and where the run went", async () => {
    // Positive control: while its account can run, the claim runs on it, and the transcript owes nothing.
    const lone = await account(db, alice, 'Lone');
    const fades = await account(db, alice, 'Fades');
    usageAnswers.set(lone.key, fiveHour(20));
    usageAnswers.set(fades.key, fiveHour(30));
    await Promise.all([lone, fades].map((a) => usage.refresh(a.row)));
    const vanishing = await providers.createPool(alice, { label: 'Vanishing', providerIds: [lone.row.id] });
    const fading = await providers.createPool(alice, { label: 'Fading', providerIds: [fades.row.id] });
    await track();
    const controlAt = await machine(db, alice, 'alice-claims-while-it-can');
    const control = await sessions.create(alice, {
      prompt: 'hello', title: 'while it can', workspaceId: controlAt.workspaceId, provider: vanishing.slug,
    });
    assert.equal(token((await claim(controlAt.runnerId, control.id)).agent.env), lone.key);
    await engineStarted(controlAt.runnerId, control.id, 1);
    assert.deepEqual(await noticesOf(control.id), []);

    // Two sessions opened while their pools could run: then one pool is emptied, the other's key refused.
    const emptiedAt = await machine(db, alice, 'alice-claims-emptied');
    const onEmptied = await sessions.create(alice, {
      prompt: 'hello', title: 'on a pool about to be emptied', workspaceId: emptiedAt.workspaceId, provider: vanishing.slug,
    });
    const refusedAt = await machine(db, alice, 'alice-claims-refused');
    const onRefused = await sessions.create(alice, {
      prompt: 'hello', title: 'on a pool whose key is about to be refused', workspaceId: refusedAt.workspaceId, provider: fading.slug,
    });
    await providers.removePoolMember(alice, vanishing.id, lone.row.id);
    usageAnswers.set(fades.key, REFUSED);
    await usage.refresh(fades.row);
    assert.equal(usage.refused(fades.row), true);

    for (const { at, sessionId, pool } of [
      { at: emptiedAt, sessionId: onEmptied.id, pool: vanishing },
      { at: refusedAt, sessionId: onRefused.id, pool: fading },
    ]) {
      // The claim is not failed: it dispatches on the Claude default, the agent's own env and no key.
      const claimed = await claim(at.runnerId, sessionId);
      assert.equal(claimed.provider, 'claude');
      assert.deepEqual(claimed.agent.env, configuredEnv.get(at.workspaceId), `${pool.label}: the claim handed out more than the agent's env`);
      assert.deepEqual(
        [...KEYS].filter((key) => wire(claimed).includes(key)),
        [],
        `${pool.label}: a key reached the runner`,
      );
      assert.equal((await recorded(sessionId)).poolMemberProviderId, null, 'the run is recorded on a member it is not on');

      // …and says so on the engine's first event: which pool, and where the run went.
      await engineStarted(at.runnerId, sessionId, 1);
      const notices = await noticesOf(sessionId);
      assert.equal(notices.length, 1, `${pool.label}: ${JSON.stringify(notices)}`);
      assert.match(notices[0], new RegExp(`"${pool.label}"`), 'the line does not name the pool');
      assert.match(notices[0], /Claude default \(this runner's own login\)/, 'the line does not say where the run went');
      assert.equal((await recorded(sessionId)).poolSwitchNotice, null, 'the line is still owed after the start carried it');
    }

    // A pool that is only spent is not one with nothing to run on: its claim goes to one of its own
    // accounts, which waits out the reset, and no fallback is said.
    const spentAt = await machine(db, alice, 'alice-claims-spent');
    const onSpent = await sessions.create(alice, {
      prompt: 'hello', title: 'on the spent pool', workspaceId: spentAt.workspaceId, provider: spent.slug,
    });
    const claimed = await claim(spentAt.runnerId, onSpent.id);
    assert.ok([spentA.key, spentB.key].includes(token(claimed.agent.env) ?? ''), 'the spent pool fell back');
    await engineStarted(spentAt.runnerId, onSpent.id, 1);
    assert.deepEqual(await noticesOf(onSpent.id), []);
  });

  await t.test("(4) no session payload that carries a pool's member holds a credential or an endpoint — the lists, the detail, the transcript, the turns, the search", async () => {
    await track();
    const workspaces = await db.session.findMany({
      where: { ownerId: alice },
      distinct: ['workspaceId'],
      select: { workspaceId: true },
    });
    const everySession = await db.session.findMany({ where: { ownerId: alice }, select: { id: true } });
    const read = async (path: string) => {
      const answer = await ask(alice, 'GET', path);
      assert.equal(answer.status, 200, statusOf(answer));
      sessionAnswers.push(answer);
      return answer;
    };
    await read('sessions');
    for (const view of ['open', 'completed']) {
      for (const { workspaceId } of workspaces) await read(`sessions?workspaceId=${pub(workspaceId!)}&view=${view}`);
    }
    await read('sessions/search?q=pool');
    for (const { id } of everySession) {
      await read(`sessions/${pub(id)}`);
      await read(`sessions/${pub(id)}/events/page?tail=200`);
      await read(`sessions/${pub(id)}/turns`);
    }
    // And another owner's reads of them, which are refusals.
    const theirs = await ask(bob, 'GET', `sessions/${pub(sticky.id)}`);
    assert.equal(theirs.status, 404, statusOf(theirs));
    sessionAnswers.push(theirs);

    // The payloads read are the ones that carry the pool's member: the session on Work names it…
    const detail = sessionAnswers.find((answer) => answer.path === `sessions/${pub(sticky.id)}`)!;
    assert.equal(detail.json.poolMemberProviderId, pub(work.row.id));
    assert.equal(detail.json.provider, alicePool.slug);
    // …and a session that fell back carries the line that says so.
    assert.ok(
      sessionAnswers.some((answer) => answer.path.endsWith('/events/page?tail=200') && answer.text.includes('Claude default')),
      'no transcript read carries a pool line',
    );

    // The check sees a credential where there is one: the member's own row, as it is stored…
    const memberRow = wire(await db.modelProvider.findUniqueOrThrow({ where: { id: work.row.id } }));
    assert.deepEqual(credentialsIn(memberRow, ciphertexts), ['a stored ciphertext', 'a key field', 'an endpoint field', 'an endpoint']);
    // …and the environment a claim hands the runner.
    assert.deepEqual(credentialsIn(wire({ env: { ANTHROPIC_AUTH_TOKEN: work.key } }), ciphertexts), ['an sk-ant key', 'a key field']);

    const leaks = sessionAnswers.flatMap((answer) => {
      const found = credentialsIn(answer.text, ciphertexts);
      return found.length ? [`${answer.method} /api/${answer.path} → ${answer.status}: ${found.join(', ')}`] : [];
    });
    assert.deepEqual(leaks, [], 'session payloads carrying a credential or an endpoint');
    const pushed = broadcasts.filter((broadcast) => credentialsIn(wire(broadcast), ciphertexts).length > 0);
    assert.deepEqual(pushed, [], 'broadcasts carrying a credential or an endpoint');
    assert.ok(sessionAnswers.length > 3 * everySession.length, `read only ${sessionAnswers.length} payloads`);
  });
});
