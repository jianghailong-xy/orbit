/**
 * An account pool at dispatch, on real PostgreSQL: a claim on a session whose provider is a pool runs
 * on the member with the most 5-hour room, stays on it while it lasts, moves once it is spent, never
 * resolves another owner's pool, and leaves a line in the transcript when it moves.
 *
 * Everything between the rows and the job env is production code: the claim (QueueService), the quota
 * cache it reads (ProviderPlanUsageService, fed through `fetch` exactly as the usage endpoint answers)
 * and the runner event ingest that writes the transcript (RunnerApiController.events). Only the
 * network is replaced.
 *
 * It only adds rows, under ids and slugs of its own, and still refuses to run anywhere but the
 * disposable server `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, type ModelProvider } from '@prisma/client';
import { RunEventType, type ClaimedSession } from '@orbit/shared';
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
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { QueueService } from './queue.service';

const URL = process.env.COORDINATOR_PG_URL;
// The spec encrypts the members' keys and the claim decrypts them; both only need the same secret.
process.env.PROVIDER_SECRET_KEY ??= 'pool-claim-selection-spec';

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

interface Owner {
  id: string;
  runnerId: string;
  workspaceId: string;
}

async function owner(db: PrismaClient, label: string): Promise<Owner> {
  const id = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id, email: `${label}-${id}@pool-claim.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId: id, name: `${label}-runner`, tokenHash: `x-${runnerId}`,
      status: RunnerStatus.ONLINE, maxConcurrent: 4,
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId: id, runnerId, name: `${label}-ws`, enabled: true, workDir: `/tmp/${label}` },
  });
  return { id, runnerId, workspaceId };
}

interface Account {
  row: ModelProvider;
  /** The plaintext key, which only the job env may ever carry. */
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

/** A session queued on `provider` for `who`'s runner. */
async function queuedSession(db: PrismaClient, who: Owner, provider: string): Promise<string> {
  const session = await db.session.create({
    data: {
      title: 'pool',
      prompt: 'hello',
      status: RunStatus.PENDING,
      ownerId: who.id,
      creatorId: who.id,
      workspaceId: who.workspaceId,
      assignedRunnerId: who.runnerId,
      provider,
      providerBuiltin: false,
      usesRuntimeDefaultModel: true,
    },
    select: { id: true },
  });
  return session.id;
}

const suite = URL ? test : test.skip;

suite('an account pool at claim time, on real PostgreSQL', async (t) => {
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

  const realtime = {
    publish: () => {},
    publishSessionUpdated: () => {},
    publishQueuedTurnsChanged: () => {},
    publishForUser: () => {},
    publishForAllUsers: () => {},
  } as unknown as RealtimeService;
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(db as unknown as PrismaService, realtime, usage);
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
  /** The session's next message queued, which is what has the runner claim it again. */
  async function nextTurn(sessionId: string): Promise<void> {
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.PENDING } });
  }
  const token = (claimed: ClaimedSession) => claimed.agent.env?.ANTHROPIC_AUTH_TOKEN;
  const recorded = (sessionId: string) =>
    db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { poolMemberProviderId: true, poolSwitchNotice: true },
    });

  const me = await owner(db, 'pool-owner');
  // Three members reporting three different 5-hour utilizations, and one reporting nothing at all.
  const work = await account(db, me.id, 'Work');
  const personal = await account(db, me.id, 'Personal');
  const team = await account(db, me.id, 'Team');
  const spare = await account(db, me.id, 'Spare');
  const members = [work, personal, team, spare];
  usageAnswers.set(work.key, fiveHour(45));
  usageAnswers.set(personal.key, fiveHour(12));
  usageAnswers.set(team.key, fiveHour(70));
  // A claim reads the cache and never waits on the network, so the numbers go in first — where they
  // are once anybody has opened a provider picker.
  await Promise.all(members.map((m) => usage.refresh(m.row)));
  assert.equal(usage.snapshot(spare.row), null, 'the unreported member has a snapshot after all');
  assert.equal(usage.snapshot(personal.row)?.fiveHour?.utilization, 12);

  const pool = await db.providerPool.create({
    data: {
      slug: `claude-accounts-${randomUUID()}`,
      label: 'Claude accounts',
      ownerId: me.id,
      members: { createMany: { data: members.map((m) => ({ providerId: m.row.id })) } },
    },
    select: { id: true, slug: true },
  });
  const sessionId = await queuedSession(db, me, pool.slug);

  await t.test('(1) the claim runs on the member with the most 5-hour room, its key decrypted into the job env', async () => {
    const claimed = await claim(me.runnerId, sessionId);
    assert.equal(claimed.provider, 'claude');
    assert.equal(token(claimed), personal.key);
    assert.equal(claimed.agent.env?.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
    assert.equal((await recorded(sessionId)).poolMemberProviderId, personal.row.id);
  });

  await t.test('(2) the next claims stay on that member: with the numbers unchanged, and even once another has more room', async () => {
    await nextTurn(sessionId);
    assert.equal(token(await claim(me.runnerId, sessionId)), personal.key);

    // Team now has the most room of all, and the session still does not move.
    usageAnswers.set(team.key, fiveHour(5));
    await usage.refresh(team.row);
    try {
      await nextTurn(sessionId);
      assert.equal(token(await claim(me.runnerId, sessionId)), personal.key);
    } finally {
      usageAnswers.set(team.key, fiveHour(70));
      await usage.refresh(team.row);
    }

    assert.deepEqual(await recorded(sessionId), { poolMemberProviderId: personal.row.id, poolSwitchNotice: null });
  });

  await t.test("(3) once that member's 5-hour window is spent the claim moves, to a member that reported before one that did not", async () => {
    usageAnswers.set(personal.key, fiveHour(100));
    await usage.refresh(personal.row);
    await nextTurn(sessionId);
    const claimed = await claim(me.runnerId, sessionId);
    // Work (45%) — ahead of Team (70%), and ahead of Spare, whose silence is not taken for 0%.
    assert.equal(token(claimed), work.key);
    assert.equal((await recorded(sessionId)).poolMemberProviderId, work.row.id);
  });

  await t.test("(4) another owner's session naming the pool gets none of its tokens", async () => {
    const stranger = await owner(db, 'pool-stranger');
    const theirs = await queuedSession(db, stranger, pool.slug);
    const claimed = await claim(stranger.runnerId, theirs);
    // Dispatched as a slug naming nothing this owner has: the Claude default, which signs in itself.
    assert.equal(claimed.provider, 'claude');
    assert.equal(token(claimed), undefined);
    const keys = new Set(members.map((m) => m.key));
    assert.deepEqual(Object.values(claimed.agent.env ?? {}).filter((value) => keys.has(value)), []);
    assert.deepEqual(await recorded(theirs), { poolMemberProviderId: null, poolSwitchNotice: null });
  });

  await t.test('(5) the switch leaves its line in the transcript, on the first engine start after it', async () => {
    const line = "Switched to Work — Personal's 5-hour window is spent";
    assert.equal((await recorded(sessionId)).poolSwitchNotice, line);
    // The claim wrote nothing into the event stream itself: the runner numbers it.
    assert.equal(await db.runEvent.count({ where: { sessionId } }), 0);

    const { runtimeSessionId } = await db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { runtimeSessionId: true },
    });
    await runnerApi.events({ id: me.runnerId }, sessionId, {
      events: [{
        seq: 1,
        type: RunEventType.SYSTEM,
        ts: new Date().toISOString(),
        payload: { subtype: 'init', sessionId: runtimeSessionId, model: 'claude-opus-5' },
      }],
    });

    const transcript = await db.runEvent.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
      select: { seq: true, type: true, payload: true },
    });
    assert.deepEqual(
      transcript.map((e) => [e.seq, e.type, (e.payload as { notice?: unknown }).notice]),
      [[1, RunEventType.SYSTEM, line]],
    );
    assert.equal((await recorded(sessionId)).poolSwitchNotice, null, 'the line is owed once, not on every start');
  });

  await t.test('a pool emptied, then deleted, under a session falls back to the Claude default instead of failing the claim', async () => {
    await db.providerPoolMember.deleteMany({ where: { poolId: pool.id } });
    await nextTurn(sessionId);
    const emptied = await claim(me.runnerId, sessionId);
    assert.equal(emptied.provider, 'claude');
    assert.equal(token(emptied), undefined);

    await db.providerPool.delete({ where: { id: pool.id } });
    await nextTurn(sessionId);
    const deleted = await claim(me.runnerId, sessionId);
    assert.equal(deleted.provider, 'claude');
    assert.equal(token(deleted), undefined);
  });
});
