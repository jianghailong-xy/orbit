/**
 * A provider switch onto an account pool queues a `reload`, and the inbox builds the environment it
 * re-spawns the engine with only when it hands that reload out (RunnerApiController.reloadProviderEnv).
 * This is what happens when the pool is deleted in between: the switch was accepted while the pool
 * existed, and by the time the runner asks for the reload, nothing holds the slug the session names.
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

import { BadRequestException } from '@nestjs/common';
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
  const turns = (sessionId: string) =>
    db.conversationTurn.findMany({
      where: { sessionId, seq: { gt: 1 } },
      orderBy: { seq: 'asc' },
      select: { id: true, kind: true, status: true, deliveredAt: true },
    });
  const recorded = (sessionId: string) =>
    db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true, error: true } });
  const refusedWith400 = (error: unknown) =>
    error instanceof BadRequestException && error.getStatus() === 400 && /provider not available/.test(error.message);

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

  await t.test('(1) every inbox poll of a running session is refused 400 once its pool is gone, and the reload stays at the head of its queue', async () => {
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

    for (let poll = 1; poll <= 3; poll += 1) {
      await assert.rejects(inbox(box, live), refusedWith400, `poll ${poll} was not refused 400`);
      assert.deepEqual(
        (await turns(live)).map(({ kind, status, deliveredAt }) => ({ kind, status, deliveredAt })),
        [
          { kind: 'reload', status: 'PENDING', deliveredAt: null },
          { kind: 'message', status: 'PENDING', deliveredAt: null },
        ],
        `after poll ${poll}`,
      );
    }
    assert.equal((await turns(live))[1]?.id, message.turnId);
    assert.deepEqual(await recorded(live), { status: RunStatus.RUNNING, error: null });
  });

  await t.test('(2) an idle session is refused 400 at every poll too, with nothing said on it', async () => {
    const box = await machine(db, me, 'deleted-pool-idle');
    const live = await liveSession(db, me, box, 'claude');
    const pool = await newPool('Claude accounts again');
    await sessions.updateConfig(me, live, { provider: pool.slug });
    await providers.removePool(me, pool.id);

    for (let poll = 1; poll <= 3; poll += 1) {
      await assert.rejects(dequeue(live, box.runnerId, null), refusedWith400, `poll ${poll} was not refused 400`);
    }
    assert.deepEqual(
      (await turns(live)).map(({ kind, status, deliveredAt }) => ({ kind, status, deliveredAt })),
      [{ kind: 'reload', status: 'PENDING', deliveredAt: null }],
    );
    assert.deepEqual(await recorded(live), { status: RunStatus.AWAITING_INPUT, error: null });
  });
});
