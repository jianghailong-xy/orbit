/**
 * A provider switch onto an account pool queues a `reload`, and the inbox builds the environment it
 * re-spawns the engine with only when it hands that reload out (RunnerApiController.reloadProviderEnv).
 * This is what happens when the pool is deleted in between: the switch was accepted while the pool
 * existed, and by the time the runner asks for the reload, nothing holds the slug the session names.
 *
 * The reload used to be refused with a 400 that rolled its own ack back, so it was first in line again
 * at every poll and nothing queued behind it was ever handed out. Now the inbox answers it without
 * handing it out, the session says why in the sentence the claim holds such a session with
 * (PROVIDER_UNAVAILABLE_ERROR), and the poll goes on to what was queued behind it. The claim keeps that
 * sentence while the provider stays unavailable and clears it once one that runs is chosen. A Claude
 * pool of the owner's own that none of its members can run is not unavailable: its reload re-spawns on
 * the Claude default, as before.
 *
 * Everything between the rows and what the runner receives is production code: SessionsService (the
 * switch and the messages), ProvidersService (the pool, made and deleted through its own doors),
 * QueueService (the claim) and RunnerApiController (the inbox). Only the network is replaced.
 *
 * It only adds rows, under ids and slugs of its own, and refuses to run anywhere but the disposable
 * server `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import type { RunInboxResponse } from '@orbit/shared';
import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { encryptSecret } from '../providers/provider-crypto';
import { ProvidersService } from '../providers/providers.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { ReferenceExpansionService } from '../tasks/reference-expansion';
import { RunnerApiController } from './runner-api.controller';
import { PROVIDER_UNAVAILABLE_ERROR } from './runner-provider-support';

const URL = process.env.COORDINATOR_PG_URL;
// The spec encrypts the member's key and the doors decrypt it; both only need the same secret.
process.env.PROVIDER_SECRET_KEY ??= 'reload-onto-deleted-pool-spec';

/** Every broadcast these doors make lands here and goes nowhere. */
const realtime = new Proxy({}, {
  get: (_target, key) => (key === 'then' ? undefined : () => undefined),
}) as RealtimeService;

/** The quota endpoint answers nothing, so the pool's member reports no usage — and nothing leaves the host. */
const noNetwork = (async () => new Response('unavailable', { status: 500 })) as typeof fetch;

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

/** A session with an engine up and idle on `provider` — what a provider switch re-spawns: its opening
 *  turn delivered and answered, as the claim that started it leaves one. */
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
  await db.conversationTurn.create({
    data: {
      sessionId: session.id, seq: 1, clientTurnId: `initial-${session.id}`, kind: 'message', content: 'hello',
      status: 'ANSWERED', deliveredAt: new Date(), answeredAt: new Date(),
    },
  });
  return session.id;
}

const suite = URL ? test : test.skip;

suite('a reload onto an account pool deleted before the inbox hands it out, on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL);
  const realFetch = globalThis.fetch;
  globalThis.fetch = noNetwork;
  t.after(async () => {
    globalThis.fetch = realFetch;
    await db.$disconnect();
    await client.end();
  });

  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const sessions = new SessionsService(prisma, queue, realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const runnerApi = new RunnerApiController(
    prisma, queue, realtime, {} as never, {} as never, new ReferenceExpansionService(prisma),
  );
  /** The inbox's own body, for a poll that finds nothing to hand out and would otherwise long-poll. */
  const dequeue = (runnerApi as unknown as {
    dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: string | null): Promise<RunInboxResponse | null>;
  }).dequeueTurn.bind(runnerApi);

  /** The runner's inbox poll, as GET /runner/sessions/:id/inbox runs it. */
  const inbox = (on: Machine, sessionId: string) => runnerApi.inbox({ id: on.runnerId }, sessionId, undefined, '1');
  /** The runner asking for work — which has to be `sessionId`. */
  async function claim(on: Machine, sessionId: string) {
    const claimed = await queue.claimSessionForRunner({ id: on.runnerId }, 0, false, false);
    assert.equal(claimed?.sessionId, sessionId, 'the runner was not handed the session');
  }
  /** What the session was given after its opening turn, in the order it was queued. */
  const turns = async (sessionId: string) =>
    (await db.conversationTurn.findMany({
      where: { sessionId, seq: { gt: 1 } },
      orderBy: { seq: 'asc' },
      select: { id: true, kind: true, status: true, deliveredAt: true },
    })).map(({ id, kind, status, deliveredAt }) => ({ id, kind, status, delivered: deliveredAt !== null }));
  const queueOf = async (sessionId: string) =>
    (await turns(sessionId)).map(({ kind, status, delivered }) => ({ kind, status, delivered }));
  const recorded = (sessionId: string) =>
    db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true, error: true } });

  const me = randomUUID();
  await db.user.create({
    data: { id: me, email: `owner-${me}@reload-deleted-pool.invalid`, name: 'owner', passwordHash: 'x' },
  });
  // One Claude subscription of the owner's own on api.anthropic.com — the kind a pool admits.
  const member = await db.modelProvider.create({
    data: {
      slug: `pool-member-${randomUUID()}`,
      label: 'Personal',
      runtime: 'claude',
      baseUrl: 'https://api.anthropic.com',
      apiKeyEnc: encryptSecret(`sk-ant-oat01-${randomUUID()}`),
      ownerId: me,
    },
  });
  const newPool = (label: string) => providers.createPool(me, { label, providerIds: [member.id] });

  await t.test('(1) a running session: the poll is not refused — it answers the reload without handing it out, says why on the session, and hands out the message queued behind it', async () => {
    const box = await machine(db, me, 'deleted-pool-running');
    const live = await liveSession(db, me, box, 'claude');
    const pool = await newPool('Claude accounts');

    // The switch is accepted while the pool exists, and a message is sent behind it; the claim that
    // follows runs the session on the pool.
    await sessions.updateConfig(me, live, { provider: pool.slug });
    const message = await sessions.createTurn(me, live, { clientTurnId: randomUUID(), content: 'and now this' });
    await claim(box, live);
    // Then the pool goes, before the runner asks for the reload.
    await providers.removePool(me, pool.id);

    const handed = await inbox(box, live);
    assert.deepEqual({ turnId: handed.turnId, kind: handed.kind }, { turnId: message.turnId, kind: 'message' });
    assert.deepEqual(await queueOf(live), [
      { kind: 'reload', status: 'ANSWERED', delivered: false },
      { kind: 'message', status: 'IN_FLIGHT', delivered: true },
    ]);
    assert.equal((await turns(live))[1]?.id, message.turnId);
    // Why the switch did not happen, in the claim's own words; the session runs on the engine it has.
    assert.deepEqual(await recorded(live), { status: RunStatus.RUNNING, error: PROVIDER_UNAVAILABLE_ERROR });

    // The next poll is not refused either, and the reload does not come back.
    assert.equal(await dequeue(live, box.runnerId, null), null);
    assert.equal((await turns(live)).length, 2);
  });

  await t.test('(2) an idle session: the poll hands out nothing and is not refused, and the claim holds the next message with the same sentence until the session is moved onto a provider that runs', async () => {
    const box = await machine(db, me, 'deleted-pool-idle');
    const live = await liveSession(db, me, box, 'claude');
    const pool = await newPool('Claude accounts again');
    await sessions.updateConfig(me, live, { provider: pool.slug });
    await providers.removePool(me, pool.id);

    assert.equal(await dequeue(live, box.runnerId, null), null, 'the inbox handed out the reload');
    assert.deepEqual(await queueOf(live), [{ kind: 'reload', status: 'ANSWERED', delivered: false }]);
    assert.deepEqual(await recorded(live), { status: RunStatus.AWAITING_INPUT, error: PROVIDER_UNAVAILABLE_ERROR });

    // The next message waits for a claim, which holds the session saying the same thing while the pool is gone…
    const message = await sessions.createTurn(me, live, { clientTurnId: randomUUID(), content: 'still there?' });
    assert.equal(await queue.claimSessionForRunner({ id: box.runnerId }, 0, false, false), null, 'the runner was handed the session');
    assert.deepEqual(await recorded(live), { status: RunStatus.PENDING, error: PROVIDER_UNAVAILABLE_ERROR });
    // …and once its person moves it onto a provider that runs, the claim clears it and the message is handed out.
    await sessions.updateConfig(me, live, { provider: 'claude' });
    await claim(box, live);
    assert.deepEqual(await recorded(live), { status: RunStatus.RUNNING, error: null });
    const handed = await inbox(box, live);
    assert.deepEqual({ turnId: handed.turnId, kind: handed.kind }, { turnId: message.turnId, kind: 'message' });
  });

  await t.test("(3) a Claude pool of the owner's own that none of its members can run is not unavailable: its reload is handed out, re-spawning on the Claude default", async () => {
    const box = await machine(db, me, 'emptied-pool');
    const live = await liveSession(db, me, box, 'claude');
    const pool = await newPool('Claude accounts emptied');
    await sessions.updateConfig(me, live, { provider: pool.slug });
    // Emptied, not deleted: the pool still holds its slug.
    await providers.removePoolMember(me, pool.id, member.id);

    const handed = await dequeue(live, box.runnerId, null);
    assert.equal(handed?.kind, 'reload');
    // The runner's own Claude sign-in: an empty environment, which drops whatever the engine had.
    assert.deepEqual(handed?.env, {});
    assert.deepEqual(await recorded(live), { status: RunStatus.AWAITING_INPUT, error: null });
  });
});
