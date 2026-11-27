/**
 * POST /api/notify through the production apiserver — `build/main.js`, the whole AppModule — against a real PostgreSQL
 * that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/push/notify.pg.spec.ts
 *
 *   (1) on a deployment with no APNs or FCM credentials, a token holding `notify` is answered 200
 *       `{ delivered: false, reason: 'PUSH_NOT_CONFIGURED' }`: accepted, not an error;
 *   (2) a token without the scope is refused 403 PAT_SCOPE_MISSING, and a call with no token, or a revoked one, 401;
 *   (3) a blank or over-long title or message, an over-long or non-http url and an unknown priority are refused 400;
 *   (4) each token may send NOTIFY_RATE_LIMIT.max a minute, then is answered 429, while another token is not;
 *   (5) with FCM configured, an account with no device of its own is answered NO_DEVICES although another account has
 *       one: only the token owner's devices are read. (Delivery to them, with a fake sender: notify.spec.ts.)
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { PAT_SCOPES, PatService } from '../auth/pat.service';
import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { NOTIFY_LIMITS } from './dto';
import { NOTIFY_RATE_LIMIT } from './notify.controller';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
/** No push credentials reach the child from this process's environment: (1) is a server without them. */
const NO_PUSH = Object.fromEntries(
  ['APNS_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_SANDBOX_KEY', 'APNS_SANDBOX_KEY_ID', 'APNS_PRODUCTION_KEY',
    'APNS_PRODUCTION_KEY_ID', 'FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY'].map((name) => [name, '']),
);

test('POST /api/notify: the notify scope, its refusals, its caps and its per-token limit', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const servers: Apiserver[] = [];
  t.after(async () => {
    for (const server of servers) await server.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  const mkUser = async (label: string) => {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `notify-${label}-${RUN}@personal-access-token.invalid`, name: label, passwordHash: 'x' } });
    return id;
  };
  const [ownerId, otherId] = [await mkUser('owner'), await mkUser('other')];
  const pats = new PatService(db as unknown as PrismaService);
  const issue = async (userId: string, name: string, scopes: readonly string[]) =>
    pats.issue(userId, { name, scopes: [...scopes], expiresInDays: 90, createdVia: 'WEB', workspaceIds: [] });
  const notifier = (await issue(ownerId, 'grafana', ['notify'])).token;
  const second = (await issue(ownerId, 'second grafana', ['notify'])).token;
  const without = (await issue(ownerId, 'everything but notify', PAT_SCOPES.filter((scope) => scope !== 'notify'))).token;
  const revoked = await issue(ownerId, 'revoked', ['notify']);
  await pats.revoke(ownerId, revoked.id);

  const server = await startApiserver(url, `notify-${randomUUID()}`, NO_PUSH);
  servers.push(server);
  const notify = (bearer: string | undefined, body: unknown) => call(server, 'POST', '/api/notify', bearer, body);
  const ok = { title: 'Disk over 85%', message: '/ is 91% full on orbit-host' };

  // (1)
  const answered = await notify(notifier, { ...ok, priority: 'high', url: 'https://grafana.example.com/alerting/list' });
  assert.equal(answered.status, 200, answered.text);
  assert.deepEqual(answered.json, { delivered: false, reason: 'PUSH_NOT_CONFIGURED' });

  // (2)
  const noScope = await notify(without, ok);
  assert.equal(noScope.status, 403, noScope.text);
  assert.equal(noScope.json.code, 'PAT_SCOPE_MISSING');
  assert.equal(noScope.json.scope, 'notify');
  assert.equal((await notify(undefined, ok)).status, 401);
  assert.equal((await notify(revoked.token, ok)).status, 401);

  // (3)
  const refused: Array<[string, unknown]> = [
    ['a title past the cap', { ...ok, title: 'x'.repeat(NOTIFY_LIMITS.title + 1) }],
    ['a message past the cap', { ...ok, message: 'x'.repeat(NOTIFY_LIMITS.message + 1) }],
    ['a url past the cap', { ...ok, url: `https://example.com/${'x'.repeat(NOTIFY_LIMITS.url)}` }],
    ['a url that is not http', { ...ok, url: 'javascript:alert(1)' }],
    ['a blank title', { ...ok, title: '   ' }],
    ['no message', { title: ok.title }],
    ['an unknown priority', { ...ok, priority: 'urgent' }],
  ];
  for (const [what, body] of refused) {
    const reply = await notify(second, body);
    assert.equal(reply.status, 400, `${what}: ${reply.text}`);
  }
  // Exactly at the caps is taken.
  const atCaps = await notify(second, { title: 'x'.repeat(NOTIFY_LIMITS.title), message: 'é'.repeat(NOTIFY_LIMITS.message) });
  assert.equal(atCaps.status, 200, atCaps.text);

  // (4) The first token has spent one of its window in (1).
  for (let i = 1; i < NOTIFY_RATE_LIMIT.max; i++) {
    const reply = await notify(notifier, ok);
    assert.equal(reply.status, 200, `call ${i + 1}: ${reply.text}`);
  }
  const limited = await notify(notifier, ok);
  assert.equal(limited.status, 429, limited.text);
  assert.match(limited.json.message, /too many notifications/);
  assert.equal((await notify(second, ok)).status, 200, "another token's window is its own");

  // (5) FCM configured, with a key Google never saw: nothing here reaches it, because the owner has no device.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fcm = await startApiserver(url, `notify-fcm-${randomUUID()}`, {
    ...NO_PUSH,
    FCM_PROJECT_ID: 'orbit-notify-spec',
    FCM_CLIENT_EMAIL: 'spec@orbit-notify-spec.iam.gserviceaccount.com',
    FCM_PRIVATE_KEY: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString('base64'),
  });
  servers.push(fcm);
  await db.deviceToken.create({ data: {
    userId: otherId, token: `other-device-${RUN}`, platform: 'android', environment: 'production',
    bundleId: 'io.orbitd.android', installationId: randomUUID(),
  } });
  const noDevices = await call(fcm, 'POST', '/api/notify', notifier, ok);
  assert.equal(noDevices.status, 200, noDevices.text);
  assert.deepEqual(noDevices.json, { delivered: false, reason: 'NO_DEVICES' });
});
