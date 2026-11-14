/**
 * POST /sessions/:id/restart on real PostgreSQL: the Settings panel's Restart queues a `reload`, and the
 * inbox (RunnerApiController.dequeueTurn) hands it out with the session's env resolved at that moment —
 * the session's variables laid over the workspace's — and only while no message or shell turn is in
 * flight, so a restart asked for mid-turn reaches the runner once that turn ends. Handing it out stamps
 * envAppliedAt. An ended engine is refused 409 ENGINE_NOT_RUNNING, and a second restart while one is
 * queued is that one.
 *
 * Everything between the rows and what the runner receives is production code: SessionsService (the
 * restart and the messages), QueueService (the claim) and RunnerApiController (the inbox).
 *
 * It only adds rows, under ids of its own, and refuses to run anywhere but the disposable server
 * `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ConflictException } from '@nestjs/common';
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
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { ReferenceExpansionService } from '../tasks/reference-expansion';
import { SessionsService } from './sessions.service';
import '../test-support/dequeue-under-lease';
import { sessionLease } from '../test-support/dequeue-under-lease';

const URL = process.env.COORDINATOR_PG_URL;

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
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-ws`, enabled: true, workDir: `/tmp/${label}`,
      env: { SHARED: 'workspace', ONLY_WORKSPACE: '1' },
    },
  });
  return { runnerId, workspaceId };
}

/** A session with a Claude engine up and idle, its env changed since that engine started. */
async function liveSession(db: PrismaClient, ownerId: string, on: Machine): Promise<string> {
  const session = await db.session.create({
    data: {
      title: 'live',
      prompt: 'hello',
      status: RunStatus.AWAITING_INPUT,
      ownerId,
      creatorId: ownerId,
      workspaceId: on.workspaceId,
      assignedRunnerId: on.runnerId,
      provider: 'claude',
      providerBuiltin: true,
      model: 'claude-opus-5',
      permissionMode: 'default',
      numTurns: 1,
      runtimeSessionId: randomUUID(),
      usesRuntimeDefaultModel: true,
      env: { SHARED: 'session', ONLY_SESSION: 'restart-me' },
      engineStartedAt: new Date(Date.now() - 60_000),
      envChangedAt: new Date(Date.now() - 1_000),
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

suite('POST /sessions/:id/restart, on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL);
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const sessions = new SessionsService(prisma, queue, realtime);
  const runnerApi = new RunnerApiController(
    prisma, queue, realtime, {} as never, {} as never, new ReferenceExpansionService(prisma),
  );
  /** The inbox's own body. */
  const dequeue = (runnerApi as unknown as {
    dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: string | null): Promise<RunInboxResponse | null>;
  }).dequeueTurn.bind(runnerApi);
  /** The runner's inbox poll, as GET /runner/sessions/:id/inbox runs it. */
  const inbox = async (on: Machine, sessionId: string) =>
    runnerApi.inbox({ id: on.runnerId }, sessionId, await sessionLease(prisma, sessionId), '1');
  const reloads = (sessionId: string) =>
    db.conversationTurn.findMany({ where: { sessionId, kind: 'reload' }, select: { id: true, status: true } });
  const appliedAt = async (sessionId: string) =>
    (await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { envAppliedAt: true } })).envAppliedAt;

  const me = randomUUID();
  await db.user.create({
    data: { id: me, email: `owner-${me}@session-restart.invalid`, name: 'owner', passwordHash: 'x' },
  });

  await t.test('(1) a live idle session: the reload is handed out with the fresh env, and envAppliedAt is stamped', async () => {
    const box = await machine(db, me, 'restart-idle');
    const live = await liveSession(db, me, box);
    assert.equal(await appliedAt(live), null);

    assert.deepEqual(await sessions.restart(me, live), { queued: true, afterTurn: false });
    assert.deepEqual((await reloads(live)).map((r) => r.status), ['PENDING']);

    const handed = await dequeue(live, box.runnerId, null);
    assert.equal(handed?.kind, 'reload');
    assert.equal(handed?.env?.SHARED, 'session', 'the session env wins over the workspace env');
    assert.equal(handed?.env?.ONLY_SESSION, 'restart-me');
    assert.equal(handed?.env?.ONLY_WORKSPACE, '1');
    assert.deepEqual((await reloads(live)).map((r) => r.status), ['ANSWERED']);
    assert.ok(await appliedAt(live), 'handing the reload out did not stamp envAppliedAt');
  });

  await t.test('(2) during a turn in flight: queued now, handed out only once that turn has ended', async () => {
    const box = await machine(db, me, 'restart-inflight');
    const live = await liveSession(db, me, box);
    const message = await sessions.createTurn(me, live, { clientTurnId: randomUUID(), content: 'long work' });
    const claimed = await queue.claimSessionForRunner({ id: box.runnerId });
    assert.equal(claimed?.sessionId, live);
    const running = await inbox(box, live);
    assert.deepEqual({ turnId: running.turnId, kind: running.kind }, { turnId: message.turnId, kind: 'message' });

    assert.deepEqual(await sessions.restart(me, live), { queued: true, afterTurn: true });

    // The turn is still running: the poll hands out nothing, and the reload stays queued.
    assert.equal(await dequeue(live, box.runnerId, null), null, 'the reload was handed out mid-turn');
    assert.deepEqual((await reloads(live)).map((r) => r.status), ['PENDING']);

    // The turn ends; the next poll is the reload, with the env.
    await db.conversationTurn.update({
      where: { id: message.turnId },
      data: { status: 'ANSWERED', answeredAt: new Date() },
    });
    const handed = await dequeue(live, box.runnerId, null);
    assert.equal(handed?.kind, 'reload');
    assert.equal(handed?.env?.ONLY_SESSION, 'restart-me');
  });

  await t.test('(3) an ended engine is refused 409 ENGINE_NOT_RUNNING and nothing is queued', async () => {
    const box = await machine(db, me, 'restart-ended');
    const ended = await liveSession(db, me, box);
    await db.session.update({ where: { id: ended }, data: { status: RunStatus.CANCELLED } });

    await assert.rejects(sessions.restart(me, ended), (error: unknown) => {
      assert.ok(error instanceof ConflictException, String(error));
      assert.equal((error.getResponse() as { code?: string }).code, 'ENGINE_NOT_RUNNING');
      return true;
    });
    assert.equal((await reloads(ended)).length, 0);
  });

  await t.test('(4) a second restart while one is queued returns the queued one; after it is handed out, a new one queues', async () => {
    const box = await machine(db, me, 'restart-coalesce');
    const live = await liveSession(db, me, box);

    const [first, second] = await Promise.all([sessions.restart(me, live), sessions.restart(me, live)]);
    assert.deepEqual([first, second], [{ queued: true, afterTurn: false }, { queued: true, afterTurn: false }]);
    assert.equal((await reloads(live)).length, 1, 'two restarts queued two reloads');

    assert.equal((await dequeue(live, box.runnerId, null))?.kind, 'reload');
    await sessions.restart(me, live);
    assert.deepEqual((await reloads(live)).map((r) => r.status).sort(), ['ANSWERED', 'PENDING']);
  });
});
