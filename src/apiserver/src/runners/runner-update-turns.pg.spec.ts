import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RunnersService } from './runners.service';

const url = process.env.COORDINATOR_PG_URL;
const MINUTE = 60_000;

// The runner page's Update card names the turns a drain waits for (docs/runner-update-drain-design.md
// §3.5, board 4): GET /runners and GET /runners/:id carry `updateTurns` on a runner draining for its
// self-update — the viewer's RUNNING sessions on it, longest-running first, with when each current run
// was claimed. A runner that is not draining carries none; another owner's turns are not named.
test('a draining runner lists the viewer’s turns it waits for; no other runner does', { skip: !url, timeout: 120_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(url!);
  const sql = new Client({ connectionString: url });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  const runners = new RunnersService(db as never, { notifyRunnerWake: () => undefined } as never);

  async function user(name: string) {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${id}@update-turns.invalid`, name, passwordHash: 'x' } });
    return id;
  }
  async function runner(ownerId: string, selfUpdate: object | null, heartbeatDraining = false) {
    const id = randomUUID(), workspaceId = randomUUID();
    await db.runner.create({ data: {
      id, ownerId, name: `update-turns-${id.slice(0, 8)}`, tokenHash: randomUUID(), status: 'ONLINE',
      lastHeartbeatAt: new Date(), heartbeatDraining, ...(selfUpdate ? { selfUpdate } : {}),
    } });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId: id, name: `ws-${id.slice(0, 8)}`, enabled: true } });
    return { id, workspaceId };
  }
  async function session(ownerId: string, r: { id: string; workspaceId: string }, title: string, status: RunStatus, claimedMinutesAgo?: number) {
    const id = randomUUID();
    await db.session.create({ data: {
      id, ownerId, creatorId: ownerId, workspaceId: r.workspaceId, assignedRunnerId: r.id, title, prompt: title,
      provider: 'claude', providerBuiltin: true, status, dispatchOrigin: SessionDispatchOrigin.USER,
      ...(claimedMinutesAgo !== undefined ? { runClaimedAt: new Date(Date.now() - claimedMinutesAgo * MINUTE) } : {}),
    } });
    return id;
  }

  const alice = await user('alice');
  const bob = await user('bob');
  const draining = { state: 'waitingForIdle', phase: 'draining', targetVersion: '0.1.254', drainingSince: new Date().toISOString(), turnsInFlight: 3, turnsAtDrain: 8 };

  await t.test('draining: the owner’s RUNNING sessions, longest first, with their claim time', async () => {
    const r = await runner(alice, draining, true);
    const metrics = await session(alice, r, 'Why are 11-08 metrics zero', RunStatus.RUNNING, 47);
    const backfill = await session(alice, r, 'Backfill missing shard rows', RunStatus.RUNNING, 112);
    await session(alice, r, 'Queued behind the drain', RunStatus.PENDING);
    await session(alice, r, 'Finished earlier', RunStatus.COMPLETED, 300);
    // Bob's turn on Alice's runner is counted by turnsInFlight but never named to Alice.
    await session(bob, r, 'Bob’s private turn', RunStatus.RUNNING, 200);

    const listed = (await runners.listRunners(alice)).find((x) => x.id === r.id)!;
    const detail = await runners.getRunner(alice, r.id);
    for (const view of [listed, detail]) {
      assert.deepEqual(view.updateTurns!.map((x) => [x.id, x.title]), [
        [backfill, 'Backfill missing shard rows'],
        [metrics, 'Why are 11-08 metrics zero'],
      ]);
      const ran = Math.round((Date.now() - Date.parse(view.updateTurns![0].startedAt!)) / MINUTE);
      assert.equal(ran, 112, 'running time counts from the run’s claim');
    }
  });

  await t.test('a report saying draining is enough, even before the heartbeat flag', async () => {
    const r = await runner(alice, draining, false);
    const id = await session(alice, r, 'Long run', RunStatus.RUNNING, 10);
    assert.deepEqual((await runners.getRunner(alice, r.id)).updateTurns!.map((x) => x.id), [id]);
  });

  await t.test('a runner not draining carries no updateTurns, whatever runs on it', async () => {
    for (const report of [null, { state: 'waitingForIdle', phase: 'available', targetVersion: '0.1.254' }, { state: 'enabled', phase: 'restarting', targetVersion: '0.1.254' }]) {
      const r = await runner(alice, report, false);
      await session(alice, r, 'Running as usual', RunStatus.RUNNING, 5);
      assert.equal('updateTurns' in (await runners.getRunner(alice, r.id)), false, JSON.stringify(report));
    }
  });

  await t.test('a draining runner with none of the owner’s turns lists an empty array', async () => {
    const r = await runner(alice, draining, true);
    await session(bob, r, 'Only Bob runs here', RunStatus.RUNNING, 30);
    assert.deepEqual((await runners.getRunner(alice, r.id)).updateTurns, []);
  });
});
