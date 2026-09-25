/**
 * An account pool through every door that takes a provider slug, on real PostgreSQL: a session opened
 * on it, a task pinned to it, a live session switched onto it, and the list an agent reads its slugs
 * from — each accepting the owner's own pool and refusing another owner's with `provider not
 * available`, as the claim never resolves one for them either. A mention of an agent whose project
 * last ran on the pool is answered there too.
 *
 * A pool has no key of its own, so a switch onto it re-spawns the engine on a member: the reload the
 * switch queues is handed out with that member's key, chosen and recorded exactly as the claim chooses
 * and records it — the claim after it stays on that member, and so does a restarted runner's reclaim.
 *
 * Everything between the rows and what the runner receives is production code: SessionsService,
 * TasksService, ProvidersService, the claim (QueueService), the inbox and the reclaim
 * (RunnerApiController), and the quota cache they read (ProviderPlanUsageService, fed through `fetch`
 * as the usage endpoint answers). Only the network is replaced.
 *
 * It only adds rows, under ids and slugs of its own, and still refuses to run anywhere but the
 * disposable server `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, type ModelProvider } from '@prisma/client';
import type { ClaimedSession } from '@orbit/shared';
import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { OAUTH_USAGE_URL } from '../providers/plan-usage';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { encryptSecret } from '../providers/provider-crypto';
import { ProvidersService } from '../providers/providers.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { TasksService } from '../tasks/tasks.service';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
// The spec encrypts the members' keys and the doors decrypt them; both only need the same secret.
process.env.PROVIDER_SECRET_KEY ??= 'pool-provider-doors-spec';

/** What the usage endpoint answers for each key. A key with no answer gets a 500: nothing to read. */
const usageAnswers = new Map<string, unknown>();

/** The endpoint's body for a 5-hour window at `utilization`, resetting in two hours. */
function fiveHour(utilization: number) {
  return { five_hour: { utilization, resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() } };
}

const usageEndpoint = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
  const key = String(init?.headers?.authorization ?? '').replace(/^Bearer /, '');
  const body = String(input) === OAUTH_USAGE_URL ? usageAnswers.get(key) : undefined;
  return body === undefined
    ? new Response('unavailable', { status: 500 })
    : new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

/** Every broadcast these doors make lands here and goes nowhere. */
const realtime = new Proxy({}, {
  get: (_target, key) => (key === 'then' ? undefined : () => undefined),
}) as RealtimeService;

interface Machine {
  runnerId: string;
  workspaceId: string;
}

async function machine(db: PrismaClient, ownerId: string, label: string): Promise<Machine> {
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `x-${runnerId}`,
      status: RunnerStatus.ONLINE, maxConcurrent: 4,
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-ws`, enabled: true, workDir: `/tmp/${label}` },
  });
  return { runnerId, workspaceId };
}

async function owner(db: PrismaClient, label: string): Promise<Machine & { id: string }> {
  const id = randomUUID();
  await db.user.create({
    data: { id, email: `${label}-${id}@pool-doors.invalid`, name: label, passwordHash: 'x' },
  });
  return { id, ...(await machine(db, id, label)) };
}

interface Account {
  row: ModelProvider;
  /** The plaintext key, which only what the runner receives may ever carry. */
  key: string;
}

/** One of `ownerId`'s own Claude subscriptions on api.anthropic.com — the only kind a pool admits. */
async function account(db: PrismaClient, ownerId: string, label: string): Promise<Account> {
  const key = `sk-ant-oat01-${randomUUID()}`;
  const row = await db.modelProvider.create({
    data: {
      slug: `pool-member-${randomUUID()}`,
      label,
      runtime: 'claude',
      baseUrl: 'https://api.anthropic.com',
      apiKeyEnc: encryptSecret(key),
      ownerId,
    },
  });
  return { row, key };
}

async function accountPool(db: PrismaClient, ownerId: string, label: string, members: Account[]) {
  return db.providerPool.create({
    data: {
      slug: `claude-accounts-${randomUUID()}`,
      label,
      ownerId,
      members: { createMany: { data: members.map((m) => ({ providerId: m.row.id })) } },
    },
    select: { id: true, slug: true, label: true },
  });
}

/** A session with an engine up and idle on `provider` — what a provider switch re-spawns. */
async function liveSession(db: PrismaClient, ownerId: string, on: Machine, provider: string): Promise<string> {
  const session = await db.session.create({
    data: {
      title: 'live',
      prompt: 'hello',
      status: RunStatus.AWAITING_INPUT,
      ownerId,
      creatorId: ownerId,
      workspaceId: on.workspaceId,
      assignedRunnerId: on.runnerId,
      provider,
      providerBuiltin: true,
      model: 'claude-opus-5',
      permissionMode: 'default',
      numTurns: 1,
      runtimeSessionId: randomUUID(),
      usesRuntimeDefaultModel: true,
    },
    select: { id: true },
  });
  return session.id;
}

const TASK_CHECK = {
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
} as const;

const suite = URL ? test : test.skip;

suite('an account pool through the doors that take a provider, on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL);
  const realFetch = globalThis.fetch;
  globalThis.fetch = usageEndpoint;
  t.after(async () => {
    globalThis.fetch = realFetch;
    await db.$disconnect();
    await client.end();
  });

  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const sessions = new SessionsService(prisma, queue, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const runnerApi = new RunnerApiController(
    db as never, queue as never, realtime as never, {} as never, {} as never, {} as never,
  );

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
        { kind: string; content?: string; env?: Record<string, string> } | null
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
      select: { provider: true, providerBuiltin: true, poolMemberProviderId: true, poolSwitchNotice: true },
    });

  const me = await owner(db, 'pool-doors-owner');
  // Three members reporting three different 5-hour utilizations, and one reporting nothing at all.
  const work = await account(db, me.id, 'Work');
  const personal = await account(db, me.id, 'Personal');
  const team = await account(db, me.id, 'Team');
  const spare = await account(db, me.id, 'Spare');
  const members = [work, personal, team, spare];
  usageAnswers.set(work.key, fiveHour(45));
  usageAnswers.set(personal.key, fiveHour(12));
  usageAnswers.set(team.key, fiveHour(70));
  // Every door reads the cache and never waits on the network, so the numbers go in first — where
  // they are once anybody has opened a provider picker.
  await Promise.all(members.map((m) => usage.refresh(m.row)));
  assert.equal(usage.snapshot(personal.row)?.fiveHour?.utilization, 12);
  const pool = await accountPool(db, me.id, 'Claude accounts', members);

  // Another owner, with a pool of their own.
  const stranger = await owner(db, 'pool-doors-stranger');
  const theirAccount = await account(db, stranger.id, 'Theirs');
  const theirPool = await accountPool(db, stranger.id, 'Their accounts', [theirAccount]);
  const keys = new Set([...members, theirAccount].map((m) => m.key));
  const carriesAKey = (env: Record<string, string> | undefined) =>
    Object.values(env ?? {}).filter((value) => keys.has(value));

  await t.test("(1) a session opens on its owner's own pool; another owner's pool is not available", async () => {
    const opened = await sessions.create(me.id, {
      prompt: 'hello',
      title: 'on the pool',
      workspaceId: me.workspaceId,
      provider: pool.slug,
    });
    const row = await recorded(opened.id);
    assert.equal(row.provider, pool.slug);
    assert.equal(row.providerBuiltin, false);
    // It dispatches on the member with the most 5-hour room, its key decrypted into the job env.
    assert.equal(token((await claim(me.runnerId, opened.id)).agent.env), personal.key);

    // A session opened with no provider starts where the last one in this project did: the pool.
    const inherited = await sessions.create(me.id, {
      prompt: 'hello again',
      title: 'inherits the pool',
      workspaceId: me.workspaceId,
    });
    assert.equal((await recorded(inherited.id)).provider, pool.slug);
    assert.equal(token((await claim(me.runnerId, inherited.id)).agent.env), personal.key);

    await assert.rejects(
      sessions.create(stranger.id, {
        prompt: 'hello',
        title: 'on somebody else’s pool',
        workspaceId: stranger.workspaceId,
        provider: pool.slug,
      }),
      /provider not available/,
    );
    await assert.rejects(
      sessions.create(me.id, {
        prompt: 'hello',
        title: 'on somebody else’s pool',
        workspaceId: me.workspaceId,
        provider: theirPool.slug,
      }),
      /provider not available/,
    );
    assert.equal(await db.session.count({ where: { ownerId: stranger.id } }), 0);
    assert.equal(await db.session.count({ where: { ownerId: me.id } }), 2);
  });

  await t.test("(2) a task may pin its owner's own pool, and not another owner's", async () => {
    const pinned = await tasks.create(me.id, { title: 'pinned to the pool', provider: pool.slug, ...TASK_CHECK } as never);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: pinned.id } })).provider, pool.slug);

    const repinned = await tasks.create(me.id, { title: 'pinned later', ...TASK_CHECK } as never);
    await tasks.update(me.id, repinned.id, { provider: pool.slug });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: repinned.id } })).provider, pool.slug);

    await assert.rejects(
      tasks.create(me.id, { title: 'pinned to theirs', provider: theirPool.slug, ...TASK_CHECK } as never),
      /provider not available/,
    );
    await assert.rejects(tasks.update(me.id, repinned.id, { provider: theirPool.slug }), /provider not available/);
    await assert.rejects(
      tasks.create(stranger.id, { title: 'pinned to mine', provider: pool.slug, ...TASK_CHECK } as never),
      /provider not available/,
    );
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: repinned.id } })).provider, pool.slug);
    assert.equal(await db.task.count({ where: { ownerId: stranger.id } }), 0);
  });

  await t.test('(3) a live session switched onto its own pool re-spawns on the member the claim would choose', async () => {
    const box = await machine(db, me.id, 'pool-doors-live');
    const live = await liveSession(db, me.id, box, 'claude');

    await sessions.updateConfig(me.id, live, { provider: pool.slug });
    assert.equal((await recorded(live)).provider, pool.slug);
    // The queued reload names the pool and nothing else: the key is resolved when it is handed out.
    const queued = await db.conversationTurn.findMany({ where: { sessionId: live, kind: 'reload' } });
    assert.equal(queued.length, 1);
    assert.equal(JSON.parse(queued[0].content ?? '{}').provider, pool.slug);
    assert.doesNotMatch(queued[0].content ?? '', /sk-ant/);

    const reload = await dequeueReload(live, box.runnerId);
    // Personal: the most 5-hour room, as the claim chooses — not the runner's own login.
    assert.equal(token(reload.env), personal.key);
    assert.equal(reload.env?.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
    assert.deepEqual(carriesAKey(reload.env), [personal.key]);
    // Recorded as the claim records it: where the session starts on the pool, not a move.
    assert.deepEqual(await recorded(live), {
      provider: pool.slug,
      providerBuiltin: false,
      poolMemberProviderId: personal.row.id,
      poolSwitchNotice: null,
    });

    // The claim after it stays on that member, and so does a restarted runner.
    await db.session.update({ where: { id: live }, data: { status: RunStatus.PENDING } });
    assert.equal(token((await claim(box.runnerId, live)).agent.env), personal.key);
    const reclaimed = (await runnerApi.reclaim({ id: box.runnerId, ownerId: me.id })).sessions;
    assert.equal(token(reclaimed.find((s) => s.sessionId === live)?.agent.env), personal.key);

    // Team now has the most room, and a switch away and back still re-spawns on Personal: the
    // reload keeps the member the session runs on for as long as it is usable, as the claim does.
    usageAnswers.set(team.key, fiveHour(5));
    await usage.refresh(team.row);
    try {
      await sessions.updateConfig(me.id, live, { provider: 'claude' });
      // Onto the built-in engine, which signs in itself: an empty environment drops the member's key.
      assert.deepEqual((await dequeueReload(live, box.runnerId)).env, {});
      await sessions.updateConfig(me.id, live, { provider: pool.slug });
      assert.equal(token((await dequeueReload(live, box.runnerId)).env), personal.key);
    } finally {
      usageAnswers.set(team.key, fiveHour(70));
      await usage.refresh(team.row);
    }
    assert.equal((await recorded(live)).poolMemberProviderId, personal.row.id);
  });

  await t.test("(3) …and a switch onto another owner's pool is refused, nor does its reload ever carry their keys", async () => {
    const box = await machine(db, me.id, 'pool-doors-refused');
    const live = await liveSession(db, me.id, box, 'claude');
    await assert.rejects(
      sessions.updateConfig(me.id, live, { provider: theirPool.slug }),
      /provider not available/,
    );
    const theirLive = await liveSession(db, stranger.id, stranger, 'claude');
    await assert.rejects(
      sessions.updateConfig(stranger.id, theirLive, { provider: pool.slug }),
      /provider not available/,
    );
    for (const sessionId of [live, theirLive]) {
      assert.equal((await recorded(sessionId)).provider, 'claude');
      assert.equal(await db.conversationTurn.count({ where: { sessionId } }), 0);
    }

    // Past the door — the row written by hand, as nothing in the product can — the reload still
    // resolves the pool within the session's owner only: the Claude default, which signs in itself.
    await db.session.update({ where: { id: theirLive }, data: { provider: pool.slug, providerBuiltin: false } });
    await db.conversationTurn.create({
      data: {
        sessionId: theirLive,
        seq: 1,
        clientTurnId: randomUUID(),
        kind: 'reload',
        content: JSON.stringify({ provider: pool.slug }),
        status: 'PENDING',
      },
    });
    const reload = await dequeueReload(theirLive, stranger.runnerId);
    assert.deepEqual(reload.env, {});
    assert.deepEqual(carriesAKey(reload.env), []);
    assert.equal((await recorded(theirLive)).poolMemberProviderId, null);
  });

  await t.test("(4) the list an agent reads its slugs from names its owner's own pool, keyless, and nobody else's", async () => {
    const mine = await providers.listUsable(me.id);
    assert.deepEqual(
      mine.find((p) => p.slug === pool.slug),
      { slug: pool.slug, label: 'Claude accounts', runtime: 'claude', builtin: false },
    );
    assert.equal(mine.some((p) => p.slug === theirPool.slug), false);

    const theirs = await providers.listUsable(stranger.id);
    assert.deepEqual(
      theirs.find((p) => p.slug === theirPool.slug),
      { slug: theirPool.slug, label: 'Their accounts', runtime: 'claude', builtin: false },
    );
    assert.equal(theirs.some((p) => p.slug === pool.slug), false);

    for (const listed of [mine, theirs]) {
      const body = JSON.stringify(listed);
      assert.doesNotMatch(body, /sk-ant/);
      // No key, no endpoint, and nothing of the members behind a pool.
      assert.doesNotMatch(body, /"(?:apiKey|apiKeyEnc|baseUrl|members|providerId)"/);
      assert.doesNotMatch(body, /api\.anthropic\.com/);
    }
  });

  await t.test('(5) a mention of an agent whose project last ran on its pool is answered on the pool, not held as unavailable', async () => {
    // The agent in (1) last started a session on the pool, so that is where it starts the next one.
    const task = await tasks.create(me.id, { title: 'somebody mentions the agent', ...TASK_CHECK } as never);
    const comment = await db.taskComment.create({
      data: {
        taskId: task.id,
        authorType: 'USER',
        authorId: me.id,
        body: 'have a look at this',
        mentions: [me.workspaceId],
        mentionDeliveryVersion: 1,
      },
      select: { id: true },
    });

    await tasks.deliverMentions();

    const delivery = await db.taskCommentMentionDelivery.findFirstOrThrow({
      where: { commentId: comment.id },
      select: { status: true, errorCode: true, targetSessionId: true },
    });
    assert.equal(delivery.errorCode, null);
    assert.equal(delivery.status, 'SESSION_CREATED');
    assert.ok(delivery.targetSessionId);
    assert.equal((await recorded(delivery.targetSessionId)).provider, pool.slug);
  });
});
