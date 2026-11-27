import assert from 'node:assert/strict';
import { createECDH, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { WebPushTransport } from './web-push-transport';

const url = process.env.COORDINATOR_PG_URL;

const p256 = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh;
};

test('a browser registration on the real schema: stored keys, picked as a target, sent to, pruned when gone', {
  skip: !url, timeout: 120_000,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(url!);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  const user = await db.user.create({ data: { email: `web-push-${randomUUID()}@example.invalid`, name: 'Web Push', passwordHash: 'test-only' } });
  t.after(async () => { await db.user.deleteMany({ where: { id: user.id } }); });

  const vapid = p256();
  const values: Record<string, string> = {
    WEB_PUSH_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'),
    WEB_PUSH_PRIVATE_KEY: vapid.getPrivateKey().toString('base64url'),
  };
  const config = { get: (k: string) => values[k] } as any;
  const ctrl = new PushController(db as any, config);
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
  const webKeys = { p256dh: p256().getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') };
  await ctrl.register({ userId: user.id, email: user.email }, { platform: 'web', token: endpoint, bundleId: 'web', webKeys } as any);

  const { rows } = await sql.query('SELECT platform, bundle_id, environment, web_keys FROM device_token WHERE token = $1', [endpoint]);
  assert.deepEqual(rows, [{ platform: 'web', bundle_id: 'web', environment: 'production', web_keys: webKeys }]);

  const push = new PushService(db as any, config);
  let status = 201;
  const sent: string[] = [];
  (push as any).web = new WebPushTransport(config, async (to) => { sent.push(String(to)); return new Response(null, { status }); });
  const tokens = await (push as any).targets(user.id);
  assert.deepEqual(tokens.map((row: { token: string }) => row.token), [endpoint]);
  const body = JSON.stringify({ aps: { alert: { title: 'Orbit', body: 'Ready' } }, kind: 'notify' });
  assert.equal(await (push as any).deliver(tokens, body, 'alert', '10'), 1);
  assert.deepEqual(sent, [endpoint]);

  status = 410;
  assert.equal(await (push as any).deliver(tokens, body, 'alert', '10'), 0);
  assert.equal(await db.deviceToken.count({ where: { token: endpoint } }), 0);
});
