/**
 * The reaper's runner presence alert (ReaperService.alertRunnerPresence, migration 1800) against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty. What it is held to:
 *
 *   (1) a runner silent past RUNNER_REAP_AFTER_MS that did not sign off is pushed offline once, and `offline_alerted_at`
 *       records it; a second sweep sends nothing;
 *   (2) none of these is pushed: a runner silent for less than the line, one that signed off, one whose last beat said
 *       it was draining, an Orbit-managed runner, one silent for longer than RUNNER_OFFLINE_ALERT_WITHIN_MS, one never
 *       heard from, and one whose last beat falls in a mass disconnection the reaper kept;
 *   (3) nothing is pushed offline by a reaper inside its startup grace;
 *   (4) an alerted runner heard again is pushed back online once and its record cleared; a runner back that was never
 *       pushed offline is not pushed back online.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/realtime/runner-presence-alert.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates, on the disposable database the script creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RunnerPresenceService } from '../runners/runner-presence';
import { ReaperService, RUNNER_OFFLINE_ALERT_WITHIN_MS, RUNNER_REAP_AFTER_MS } from './reaper.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const MINUTE = 60_000;

test('runner presence alert: pushed offline once when a runner goes quiet on its own, and back online once when it returns', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  const sent: string[] = [];
  const push = {
    notifyRunnerPresence: async (runnerId: string, presence: string) => { sent.push(`${presence}:${runnerId}`); },
  } as unknown as PushService;
  const presence = new RunnerPresenceService(db as unknown as PrismaService);
  const reaperOf = () => new ReaperService(db as unknown as PrismaService, {} as never, undefined, presence, undefined, push);

  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `alert-${RUN}@presence-alert.test`, name: 'alert', passwordHash: 'x' } });
  async function runner(name: string, beatAgoMs: number | null, data: Partial<Prisma.RunnerUncheckedCreateInput> = {}) {
    const id = randomUUID();
    await db.runner.create({
      data: { id, ownerId, name: `${name}-${RUN}`, tokenHash: randomUUID(), status: 'ONLINE', ...data },
    });
    if (beatAgoMs !== null) {
      await db.runnerPresence.create({ data: { runnerId: id, lastBeatAt: new Date(Date.now() - beatAgoMs), linkState: 'LINK' } });
    }
    return id;
  }
  const alertedAt = async (id: string) =>
    (await db.runner.findUniqueOrThrow({ where: { id }, select: { offlineAlertedAt: true } })).offlineAlertedAt;

  const past = RUNNER_REAP_AFTER_MS + MINUTE;
  const silent = await runner('silent', past);
  const recent = await runner('recent', 2 * MINUTE);
  const signedOff = await runner('signed-off', past, { status: 'OFFLINE' });
  const draining = await runner('draining', past, { heartbeatDraining: true });
  const longGone = await runner('long-gone', RUNNER_OFFLINE_ALERT_WITHIN_MS + MINUTE,
    { lastHeartbeatAt: new Date(Date.now() - RUNNER_OFFLINE_ALERT_WITHIN_MS - MINUTE) });
  const neverHeard = await runner('never-heard', null);
  const backNeverAlerted = await runner('online', 10_000);
  const managed = await runner('managed', past);
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId: managed, name: `managed-${RUN}`, enabled: true } });
  await db.managedRunner.create({
    data: {
      ownerId, runnerId: managed, defaultWorkspaceId: workspaceId, clusterKey: 'presence-alert-spec', namespace: 'orbit',
      pvcName: `mr-data-${managed}`, desiredState: 'SLEEPING', managementState: 'SLEEPING',
    },
  });
  const disconnectBeat = Date.now() - past - 30_000;
  const inDisconnect = await runner('in-disconnect', past + 30_000);
  const disconnect = await db.runnerMassDisconnect.create({
    data: { lostFrom: new Date(disconnectBeat - 5_000), lostTo: new Date(disconnectBeat + 5_000), runners: 5, heard: 10 },
  });

  await t.test('(3) a reaper inside its startup grace pushes nobody offline', async () => {
    const reaper = reaperOf();
    (reaper as unknown as { startedAt: number }).startedAt = Date.now();
    await reaper.alertRunnerPresence();
    assert.deepEqual(sent, []);
    assert.equal(await alertedAt(silent), null);
  });

  await t.test('(1)(2) only the runner that went quiet on its own is pushed offline, once', async () => {
    await reaperOf().alertRunnerPresence();
    assert.deepEqual(sent, [`offline:${silent}`]);
    assert.notEqual(await alertedAt(silent), null);
    for (const id of [recent, signedOff, draining, longGone, neverHeard, backNeverAlerted, managed, inDisconnect]) {
      assert.equal(await alertedAt(id), null, `not alerted: ${id}`);
    }
    await reaperOf().alertRunnerPresence();
    assert.deepEqual(sent, [`offline:${silent}`], 'a second sweep sends nothing');
  });

  await t.test('(2) once the mass disconnection no longer holds it, the runner in it is pushed too', async () => {
    await db.runnerMassDisconnect.delete({ where: { id: disconnect.id } });
    sent.length = 0;
    await reaperOf().alertRunnerPresence();
    assert.deepEqual(sent, [`offline:${inDisconnect}`]);
  });

  await t.test('(4) an alerted runner heard again is pushed back online once', async () => {
    await db.runnerPresence.update({ where: { runnerId: silent }, data: { lastBeatAt: new Date() } });
    sent.length = 0;
    await reaperOf().alertRunnerPresence();
    assert.deepEqual(sent, [`online:${silent}`]);
    assert.equal(await alertedAt(silent), null);
    await reaperOf().alertRunnerPresence();
    assert.deepEqual(sent, [`online:${silent}`], 'a second sweep sends nothing');
  });
});
