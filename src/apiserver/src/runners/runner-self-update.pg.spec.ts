import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { RunnerStatus, type RunnerSelfUpdate } from '@orbit/shared';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnersService } from './runners.service';

const url = process.env.COORDINATOR_PG_URL;

const REPORT: RunnerSelfUpdate = {
  state: 'dirNotWritable',
  installDir: '/usr/local/bin',
  lastUpdatedAt: '2026-10-06T06:00:00.000Z',
  lastUpdatedFrom: '0.1.200',
  lastUpdatedTo: '0.1.217',
};

// Migration 0384 against a real PostgreSQL: what a heartbeat reports lands in runner.self_update,
// the list and the detail return it (null for a runner that does not report one), and Update Runner
// Now is the owner's alone, stamped in runner.self_update_requested_at and handed to one heartbeat.
test('runner self-update state persists, is listed and detailed, and Update Runner Now reaches the runner', { skip: !url, timeout: 120_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(url!);
  const sql = new Client({ connectionString: url });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });

  const wakes: string[] = [];
  const runners = new RunnersService(db as never, { notifyRunnerWake: (id: string) => wakes.push(id) } as never);
  const realtime = {
    drainCancellations: async () => [],
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
  };
  const api = new RunnerApiController(db as never, {} as never, realtime as never, {} as never, {} as never, {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);
  const beat = (runnerId: string, extra: Record<string, unknown> = {}) =>
    api.heartbeat({ id: runnerId, version: null }, { status: RunnerStatus.ONLINE, idleCapacity: 1, ...extra });
  // The column itself, read past Prisma: the report has to be in runner.self_update.
  const column = async (runnerId: string) =>
    (await sql.query<{ self_update: unknown }>('SELECT self_update FROM runner WHERE id = $1', [runnerId])).rows[0].self_update;
  const requestedAt = async (runnerId: string) =>
    (await db.runner.findUniqueOrThrow({ where: { id: runnerId }, select: { selfUpdateRequestedAt: true } })).selfUpdateRequestedAt;
  async function fixture(status: 'ONLINE' | 'OFFLINE' = 'ONLINE') {
    const ownerId = randomUUID(), runnerId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@self-update.invalid`, name: 'Self-update test', passwordHash: 'x' } });
    await db.runner.create({ data: {
      id: runnerId, ownerId, name: 'self-update-runner', tokenHash: randomUUID(), status, lastHeartbeatAt: new Date(),
    } });
    return { ownerId, runnerId };
  }

  await t.test('a reported state is stored and returned by the list and the detail', async () => {
    const f = await fixture();
    await beat(f.runnerId, { selfUpdate: REPORT });
    assert.deepEqual(await column(f.runnerId), REPORT);
    assert.deepEqual((await runners.listRunners(f.ownerId))[0].selfUpdate, REPORT);
    assert.deepEqual((await runners.getRunner(f.ownerId, f.runnerId)).selfUpdate, REPORT);

    // Each beat's report replaces the last.
    await beat(f.runnerId, { selfUpdate: { state: 'waitingForIdle', installDir: '/home/u/.orbit/bin' } });
    const waiting = { state: 'waitingForIdle', installDir: '/home/u/.orbit/bin' };
    assert.deepEqual(await column(f.runnerId), waiting);
    assert.deepEqual((await runners.getRunner(f.ownerId, f.runnerId)).selfUpdate, waiting);
  });

  await t.test('a runner that never reports it reads null, and so does one that stops', async () => {
    const f = await fixture();
    await beat(f.runnerId);
    assert.equal(await column(f.runnerId), null);
    assert.equal((await runners.listRunners(f.ownerId))[0].selfUpdate, null);
    assert.equal((await runners.getRunner(f.ownerId, f.runnerId)).selfUpdate, null);

    // Rolled back to a release from before the field: the newer binary's state does not outlive it.
    await beat(f.runnerId, { selfUpdate: REPORT });
    await beat(f.runnerId);
    assert.equal(await column(f.runnerId), null);
    assert.equal((await runners.getRunner(f.ownerId, f.runnerId)).selfUpdate, null);
  });

  await t.test('the detail is the owner’s alone', async () => {
    const f = await fixture();
    const other = await fixture();
    await assert.rejects(() => runners.getRunner(other.ownerId, f.runnerId), /runner not found/);
  });

  await t.test('Update Runner Now: the owner’s alone, stamped, woken, and handed to one heartbeat', async () => {
    const f = await fixture();
    const other = await fixture();
    await beat(f.runnerId, { selfUpdate: { state: 'enabled' } });

    await assert.rejects(() => runners.requestSelfUpdate(other.ownerId, f.runnerId), /runner not found/);
    assert.equal(await requestedAt(f.runnerId), null);
    assert.deepEqual(wakes, []);

    const asked = await runners.requestSelfUpdate(f.ownerId, f.runnerId);
    assert.equal((await requestedAt(f.runnerId))?.toISOString(), asked.requestedAt);
    assert.deepEqual(wakes, [f.runnerId]);

    assert.equal((await beat(f.runnerId, { selfUpdate: { state: 'enabled' } })).checkSelfUpdate, true);
    assert.equal(await requestedAt(f.runnerId), null);
    assert.equal((await beat(f.runnerId, { selfUpdate: { state: 'enabled' } })).checkSelfUpdate, undefined);
  });

  await t.test('a runner offline, or too old to act on the request, is refused and holds nothing', async () => {
    const old = await fixture();
    await beat(old.runnerId);
    await assert.rejects(() => runners.requestSelfUpdate(old.ownerId, old.runnerId), /too old/i);
    assert.equal(await requestedAt(old.runnerId), null);

    const offline = await fixture('OFFLINE');
    await assert.rejects(() => runners.requestSelfUpdate(offline.ownerId, offline.runnerId), /offline/i);
    assert.equal(await requestedAt(offline.runnerId), null);
  });
});
