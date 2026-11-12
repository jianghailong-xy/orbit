/**
 * The drain's one push (docs/runner-update-drain-design.md §3.4, D3; board 3 ⑥) against a real PostgreSQL, through
 * the production heartbeat and GET /runners:
 *
 *   (1) A runner draining with nothing of its owner's waiting pushes nothing, and lists no drainWaiting.
 *   (2) Once the owner's work queues behind it, the next beat pushes exactly once, in the banner's words, and GET
 *       /runners lists what waits: a session that never ran and a session sent a message. Further beats, and more
 *       work queuing in the same drain, push nothing more.
 *   (3) A drain that starts with work already waiting pushes at its first beat; a beat that is not draining ends the
 *       drain, and the next drain pushes once more.
 *   (4) Work that is not the owner's, cancelled or deleted is not waiting work, and a runner not draining never
 *       pushes, whatever waits on it.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-drain-waiting-push.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { RunStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunnerStatus, type RunnerSelfUpdate } from '@orbit/shared';
import { drainWaitingSentence, type DrainWaitingPush } from '../common/runner-drain-waiting';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnersService } from './runners.service';
import '../test-support/dequeue-under-lease';

const url = process.env.COORDINATOR_PG_URL;

const DRAINING: RunnerSelfUpdate = {
  state: 'waitingForIdle',
  phase: 'draining',
  targetVersion: '0.1.254',
  availableSince: '2026-11-12T08:00:00Z',
  drainingSince: '2026-11-12T09:00:00Z',
  turnsInFlight: 2,
  turnsAtDrain: 2,
};

test('one push per drain, only while something of the owner’s waits on it', {
  skip: !url, timeout: 300_000, concurrency: 1,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(url!);
  const sql = new Client({ connectionString: url });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });

  const pushes: DrainWaitingPush[] = [];
  const push = { notifyRunnerDrainWaiting: async (p: DrainWaitingPush) => { pushes.push(p); } };
  const runners = new RunnersService(db as never, { notifyRunnerWake: () => undefined } as never);
  const realtime = new Proxy({
    drainCancellations: async () => [],
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
  }, { get: (target, key) => (key in target ? (target as Record<string, unknown>)[key as string] : () => undefined) });
  const api = new RunnerApiController(db as never, { notifySessionQueued: () => undefined } as never, realtime as never,
    push as never, {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);
  const beat = (runnerId: string, draining: boolean) =>
    api.heartbeat({ id: runnerId, version: null },
      { status: RunnerStatus.ONLINE, idleCapacity: 1, draining, ...(draining ? { selfUpdate: DRAINING } : {}) }, '');
  const pushesFor = (runnerId: string) => pushes.filter((p) => p.runnerId === runnerId);
  const listed = async (ownerId: string, runnerId: string) =>
    ((await runners.listRunners(ownerId)) as unknown as Array<{ id: string; drainWaiting?: unknown }>)
      .find((r) => r.id === runnerId)?.drainWaiting;

  async function fixture() {
    const ownerId = randomUUID(), runnerId = randomUUID(), workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@drain-push.invalid`, name: 'Drain push test', passwordHash: 'x' } });
    await db.runner.create({ data: {
      id: runnerId, ownerId, name: 'studio-mac', tokenHash: randomUUID(), status: 'ONLINE', lastHeartbeatAt: new Date(),
    } });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'drain-push-workspace', enabled: true } });
    return { ownerId, runnerId, workspaceId };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  /** A session of `ownerId` (the fixture's owner by default) on the runner. `numTurns` > 0 is one sent a message. */
  async function session(f: Fixture, opts: {
    status?: RunStatus; numTurns?: number; ownerId?: string; cancelled?: boolean; deleted?: boolean;
  } = {}) {
    const id = randomUUID();
    const ownerId = opts.ownerId ?? f.ownerId;
    await db.session.create({ data: {
      id, ownerId, creatorId: ownerId, workspaceId: f.workspaceId, assignedRunnerId: f.runnerId, title: 'waiting',
      prompt: 'p', provider: 'claude', status: opts.status ?? RunStatus.PENDING, dispatchOrigin: SessionDispatchOrigin.USER,
      numTurns: opts.numTurns ?? 0,
      ...(opts.cancelled ? { cancelRequestedAt: new Date() } : {}),
      ...(opts.deleted ? { deletedAt: new Date() } : {}),
    } });
    return id;
  }

  await t.test('(1) draining with nothing of the owner’s waiting pushes nothing', async () => {
    const f = await fixture();
    await session(f, { status: RunStatus.RUNNING, numTurns: 1 });
    await session(f, { status: RunStatus.RUNNING, numTurns: 3 });
    for (let i = 0; i < 3; i++) await beat(f.runnerId, true);
    assert.equal(pushesFor(f.runnerId).length, 0);
    assert.equal(await listed(f.ownerId, f.runnerId), undefined);
  });

  await t.test('(2) the first work queuing behind the drain pushes once, in the banner’s words; nothing more this drain', async () => {
    const f = await fixture();
    await session(f, { status: RunStatus.RUNNING, numTurns: 1 });
    await beat(f.runnerId, true);
    assert.equal(pushesFor(f.runnerId).length, 0);

    await session(f);                 // a new session, never started
    await session(f, { numTurns: 4 }); // a message sent to a session that had run
    await beat(f.runnerId, true);
    const sent = pushesFor(f.runnerId);
    assert.equal(sent.length, 1);
    assert.deepEqual({ ...sent[0] }, {
      runnerId: f.runnerId, ownerId: f.ownerId, machine: 'studio-mac', targetVersion: '0.1.254', turns: 2,
      waiting: { sessions: 1, messages: 1 },
    });
    assert.equal(drainWaitingSentence(sent[0]),
      'studio-mac is updating to 0.1.254 — 1 session and 1 message are waiting for 2 turns to finish.');
    assert.deepEqual(await listed(f.ownerId, f.runnerId), { sessions: 1, messages: 1 });

    await beat(f.runnerId, true);
    await session(f);
    await beat(f.runnerId, true);
    await beat(f.runnerId, true);
    assert.equal(pushesFor(f.runnerId).length, 1, 'the same drain pushed twice');
    assert.deepEqual(await listed(f.ownerId, f.runnerId), { sessions: 2, messages: 1 });
  });

  await t.test('(3) a drain starting with work waiting pushes at once; after the drain ends, the next drain pushes once more', async () => {
    const f = await fixture();
    await session(f);
    await beat(f.runnerId, false);
    assert.equal(pushesFor(f.runnerId).length, 0, 'a runner that is not draining pushed');
    assert.equal(await listed(f.ownerId, f.runnerId), undefined);

    await beat(f.runnerId, true);
    assert.equal(pushesFor(f.runnerId).length, 1);
    await beat(f.runnerId, true);
    assert.equal(pushesFor(f.runnerId).length, 1);

    await beat(f.runnerId, false);
    assert.equal(await listed(f.ownerId, f.runnerId), undefined, 'drainWaiting outlived the drain');
    const stored = await db.runner.findUniqueOrThrow({ where: { id: f.runnerId }, select: { drainWaitingPushedAt: true } });
    assert.equal(stored.drainWaitingPushedAt, null);

    await beat(f.runnerId, true);
    await beat(f.runnerId, true);
    assert.equal(pushesFor(f.runnerId).length, 2, 'the second drain did not push exactly once');
  });

  await t.test('(4) another account’s, cancelled and deleted work is not waiting work', async () => {
    const f = await fixture();
    const stranger = randomUUID();
    await db.user.create({ data: { id: stranger, email: `${stranger}@drain-push.invalid`, name: 'Stranger', passwordHash: 'x' } });
    await session(f, { ownerId: stranger });
    await session(f, { cancelled: true });
    await session(f, { deleted: true });
    await beat(f.runnerId, true);
    await beat(f.runnerId, true);
    assert.equal(pushesFor(f.runnerId).length, 0);
    assert.equal(await listed(f.ownerId, f.runnerId), undefined);
  });
});
