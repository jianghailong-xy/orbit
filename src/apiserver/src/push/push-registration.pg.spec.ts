import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { PushController } from './push.controller';
import { PushService } from './push.service';

const url = process.env.COORDINATOR_PG_URL;

test('real registrations: migration preservation, rotation, account transfer, concurrency and stale delivery cleanup', {
  skip: !url, timeout: 120_000,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(url!);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  const users = await Promise.all([1, 2].map((n) => db.user.create({ data: {
    email: `push-${n}-${randomUUID()}@example.invalid`, name: `Push ${n}`, passwordHash: 'test-only',
  } })));
  t.after(async () => { await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } }); });
  const owner = { userId: users[0].id, email: users[0].email };
  const nextOwner = { userId: users[1].id, email: users[1].email };
  const ctrl = new PushController(db as any);
  const registration = { platform: 'android', token: 'fcm-old', bundleId: 'io.orbitd.android', installationId: randomUUID() };

  await t.test('additive migration retains legacy tokens; NULL installs, unique token and owner cascade still work', async () => {
    // Roll back this isolated DDL probe so subsequent tests run on the fully migrated schema.
    await sql.query('BEGIN');
    try {
      await sql.query('ALTER TABLE device_token DROP COLUMN installation_id');
      const legacyId = randomUUID();
      await sql.query(`INSERT INTO device_token (id,user_id,token,bundle_id,updated_at)
        VALUES ($1,$2,'legacy-before-migration','io.orbitd.app',now())`, [legacyId, owner.userId]);
      await sql.query(readFileSync(path.resolve(__dirname,
        '../../prisma/migrations/0375_android_push_installation/migration.sql'), 'utf8'));
      const row = (await sql.query('SELECT * FROM device_token WHERE id=$1', [legacyId])).rows[0];
      assert.equal(row.token, 'legacy-before-migration');
      assert.equal(row.user_id, owner.userId);
      assert.equal(row.platform, 'ios');
      assert.equal(row.environment, 'production');
      assert.equal(row.installation_id, null);
    } finally { await sql.query('ROLLBACK'); }
    await ctrl.register(owner, { token: 'apns-1', bundleId: 'io.orbitd.app' });
    await ctrl.register(owner, { token: 'apns-2', bundleId: 'io.orbitd.app' });
    assert.equal(await db.deviceToken.count({ where: { platform: 'ios', userId: owner.userId } }), 2);
    await assert.rejects(db.deviceToken.create({ data: {
      userId: owner.userId, token: 'apns-1', platform: 'android', bundleId: 'io.orbitd.android',
    } }), (e: any) => e.code === 'P2002');
  });

  let activeKey: string;
  await t.test('token rotation and account switch replace the installation atomically', async () => {
    const first = await ctrl.register(owner, registration);
    const rotated = await ctrl.register(owner, { ...registration, token: 'fcm-rotated' });
    assert.notEqual(first.registrationKey, rotated.registrationKey);
    assert.equal(await db.deviceToken.count({ where: { token: 'fcm-old' } }), 0);
    const switched = await ctrl.register(nextOwner, { ...registration, token: 'fcm-current' });
    activeKey = switched.registrationKey!;
    const rows = await db.deviceToken.findMany({ where: { installationId: registration.installationId } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, nextOwner.userId);
    assert.equal(rows[0].token, 'fcm-current');
    await ctrl.unregister(owner, { platform: 'android', token: 'fcm-current', registrationKey: first.registrationKey });
    assert.equal(await db.deviceToken.count({ where: { id: activeKey } }), 1);
  });

  await t.test('same token transfers to another account; delayed same-account logout cannot erase a re-registration', async () => {
    const rebound = await ctrl.register(owner, { ...registration, token: 'fcm-current' });
    assert.notEqual(rebound.registrationKey, activeKey);
    await ctrl.unregister(nextOwner, { platform: 'android', token: 'fcm-current', registrationKey: activeKey });
    const newer = await ctrl.register(owner, { ...registration, token: 'fcm-current' });
    await ctrl.unregister(owner, { platform: 'android', token: 'fcm-current', registrationKey: rebound.registrationKey });
    assert.equal(await db.deviceToken.count({ where: { id: newer.registrationKey } }), 1);
    activeKey = newer.registrationKey!;
  });

  await t.test('a failure after removing the old token rolls the whole rotation back', async () => {
    await assert.rejects(ctrl.register({ userId: randomUUID(), email: 'gone@example.invalid' },
      { ...registration, token: 'fcm-failed-rotation' }), (e: any) => e.code === 'P2003');
    assert.equal(await db.deviceToken.count({ where: { id: activeKey } }), 1);
    assert.equal(await db.deviceToken.count({ where: { token: 'fcm-failed-rotation' } }), 0);
  });

  await t.test('APNs transfer remains token-based and platform collisions cannot overwrite either channel', async () => {
    await ctrl.register(nextOwner, { token: 'apns-1', bundleId: 'io.orbitd.app' });
    await ctrl.unregister(owner, { token: 'apns-1' });
    assert.equal((await db.deviceToken.findUnique({ where: { token: 'apns-1' } }))?.userId, nextOwner.userId);
    await assert.rejects(ctrl.register(owner, { ...registration, token: 'apns-1' }), /different push platform/);
    await assert.rejects(ctrl.register(owner, { token: 'fcm-current', bundleId: 'io.orbitd.app' }), /different push platform/);
    assert.equal(await db.deviceToken.count({ where: { id: activeKey } }), 1);
  });

  await t.test('concurrent registration is serialized by both uniqueness constraints', async () => {
    await Promise.all(['fcm-race-a', 'fcm-race-b'].map((token) => ctrl.register(owner, { ...registration, token })));
    const rows = await db.deviceToken.findMany({ where: { installationId: registration.installationId } });
    assert.equal(rows.length, 1);
    assert.ok(['fcm-race-a', 'fcm-race-b'].includes(rows[0].token));
  });

  await t.test('in-flight FCM invalidation cannot delete a newer account binding; current invalid token is pruned', async () => {
    await ctrl.register(owner, { ...registration, token: 'fcm-inflight' });
    const old = await db.deviceToken.findUniqueOrThrow({ where: { token: 'fcm-inflight' } });
    const values: Record<string, string> = { FCM_PROJECT_ID: 'isolated', FCM_CLIENT_EMAIL: 'test@example.invalid',
      FCM_PRIVATE_KEY: Buffer.from('test-only').toString('base64') };
    const push = new PushService(db as any, { get: (k: string) => values[k] } as any);
    (push as any).fcm.send = async (_token: string, _data: unknown, current: () => Promise<boolean>) => {
      assert.equal(await current(), true);
      await ctrl.register(nextOwner, { ...registration, token: old.token });
      assert.equal(await current(), false);
      return { accepted: false, invalidToken: true };
    };
    const body = JSON.stringify({ aps: { alert: { title: 'Orbit', body: 'Needs your reply' } }, kind: 'approval', sessionID: 's' });
    assert.equal(await (push as any).deliver([old], body, 'alert', '10'), 0);
    const next = await db.deviceToken.findUniqueOrThrow({ where: { token: old.token } });
    assert.equal(next.userId, nextOwner.userId);
    assert.notEqual(next.id, old.id);
    (push as any).fcm.send = async () => ({ accepted: false, invalidToken: true });
    await (push as any).deliver([next], body, 'alert', '10');
    assert.equal(await db.deviceToken.count({ where: { token: old.token } }), 0);
  });

  await t.test('APNs stale invalidation is also scoped, and user deletion still cascades', async () => {
    const old = await db.deviceToken.findUniqueOrThrow({ where: { token: 'apns-2' } });
    const values: Record<string, string> = { APNS_KEY_ID: 'test', APNS_TEAM_ID: 'test',
      APNS_KEY: Buffer.from('test-only').toString('base64') };
    const push = new PushService(db as any, { get: (k: string) => values[k] } as any);
    (push as any).authToken = () => 'test';
    (push as any).send = async () => {
      await ctrl.register(nextOwner, { token: old.token, bundleId: 'io.orbitd.app' });
      return { status: 410 };
    };
    await (push as any).deliver([old], JSON.stringify({ aps: { badge: 0 } }), 'background', '5');
    assert.equal((await db.deviceToken.findUnique({ where: { token: old.token } }))?.userId, nextOwner.userId);
    await ctrl.register(nextOwner, registration);
    await db.user.delete({ where: { id: nextOwner.userId } });
    assert.equal(await db.deviceToken.count({ where: { userId: nextOwner.userId } }), 0);
  });
});
