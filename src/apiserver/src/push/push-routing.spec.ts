import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { PushService } from './push.service';
import { fitCollapseId } from './collapse-id';
import { findingCollapseId } from '../schedules/schedule-attention';

const configValues: Record<string, string> = {
  APNS_KEY_ID: 'test', APNS_TEAM_ID: 'test', APNS_KEY: Buffer.from('test-only').toString('base64'),
  FCM_PROJECT_ID: 'test', FCM_CLIENT_EMAIL: 'test@example.invalid', FCM_PRIVATE_KEY: Buffer.from('test-only').toString('base64'),
};
const ios = { id: 'ios-row', userId: 'owner', token: 'apns-token', platform: 'ios', environment: 'sandbox',
  bundleId: 'io.orbitd.app', updatedAt: new Date(0) };
const android = { ...ios, id: 'android-row', token: 'fcm-token', platform: 'android',
  bundleId: 'io.orbitd.android', environment: 'production' };

function harness(channels: 'ios' | 'android' | 'both' | 'none' = 'both', overrides: Record<string, string | undefined> = {}) {
  const queries: any[] = [];
  const removed: any[] = [];
  const apns: any[][] = [];
  const fcm: any[][] = [];
  let pending = ['session'];
  // The session row's 0 → pending edge (claimApprovalAlert), modelled: a session rings once until it
  // leaves the pending set. The claim itself is held against PostgreSQL in push-claims.pg.spec.ts.
  const alerted = new Set<string>();
  const prisma = {
    session: { findFirst: async () => ({ title: 'Orbit', ownerId: 'owner' }) },
    deviceToken: {
      findMany: async (q: any) => {
        queries.push(q);
        return [ios, android].filter((row) => q.where.OR.some((w: any) => w.platform === row.platform));
      },
      findFirst: async () => ({ id: 'current' }),
      deleteMany: async (q: any) => { removed.push(q); },
    },
  };
  const values = { ...configValues, ...overrides };
  const config = { get: (k: string) => (channels === 'both' || channels === 'ios' && k.startsWith('APNS_')
    || channels === 'android' && k.startsWith('FCM_')) ? values[k] : undefined } as ConfigService;
  const service = new PushService(prisma as any, config);
  (service as any).needsYouSessions = async () => pending;
  (service as any).claimApprovalAlert = async (sessionId: string) => {
    if (alerted.has(sessionId)) return false;
    alerted.add(sessionId);
    return true;
  };
  (service as any).authToken = () => { assert.notEqual(channels, 'android'); return 'apns-auth'; };
  (service as any).send = async (...args: any[]) => { apns.push(args); return { status: 200 }; };
  (service as any).fcm.send = async (...args: any[]) => {
    assert.equal(await args[2](), true);
    fcm.push(args);
    return { accepted: true, invalidToken: false };
  };
  const setPending = (p: string[]) => {
    pending = p;
    for (const id of [...alerted]) if (!p.includes(id)) alerted.delete(id);
  };
  return { service, prisma, queries, removed, apns, fcm, setPending };
}

test('query restricts owner, configured channel, package and environment; Android never reaches APNs', async () => {
  const h = harness();
  await h.service.notifyApprovalRequest('session', 'approval-1', 'Bash');
  assert.deepEqual(h.queries[0].where, { userId: 'owner', OR: [
    { platform: 'ios', bundleId: 'io.orbitd.app', environment: { in: ['production', 'sandbox'] } },
    { platform: 'android', bundleId: 'io.orbitd.android', environment: 'production' },
  ] });
  assert.equal(h.apns.length, 1);
  assert.deepEqual(h.apns[0].slice(0, 2), ['api.sandbox.push.apple.com', 'apns-token']);
  assert.equal(h.fcm.length, 1);
  assert.equal(h.fcm[0][0], 'fcm-token');
  assert.equal(h.fcm[0][1].registrationKey, android.id);
  assert.equal(JSON.parse(h.fcm[0][1].payload).category, 'ORBIT_APPROVAL');
});

for (const channel of ['ios', 'android', 'both'] as const) {
  test(`${channel}: repeated parallel approvals alert once; processed items clear silently on every enabled channel`, async () => {
    const h = harness(channel);
    await Promise.all(['Bash', 'Write', 'Edit'].map((tool) =>
      h.service.notifyApprovalRequest('session', `approval-${tool}`, tool)));
    assert.equal(h.apns.length, channel === 'android' ? 0 : 1);
    assert.equal(h.fcm.length, channel === 'ios' ? 0 : 1);
    h.setPending([]);
    await (h.service as any).reconcileBadge('owner');
    await (h.service as any).reconcileBadge('owner');
    await h.service.notifyApprovalRequest('session', 'approval-late', 'late call');
    if (channel !== 'android') {
      assert.equal(h.apns.length, 2);
      assert.deepEqual(JSON.parse(h.apns[1][2]), { aps: { 'content-available': 1, badge: 0 }, clearSessions: ['session'] });
      assert.deepEqual(h.apns[1].slice(4, 6), ['background', '5']);
    }
    if (channel !== 'ios') {
      assert.equal(h.fcm.length, 2);
      assert.equal(h.fcm[1][1].type, 'sync');
      assert.deepEqual(JSON.parse(h.fcm[1][1].payload), { clearSessions: ['session'], badge: 0 });
    }
    h.setPending(['session']);
    await h.service.notifyApprovalRequest('session', 'approval-new', 'new approval');
    assert.equal(channel === 'ios' ? h.apns.length : h.fcm.length, 3);
  });
}

test('an unconfigured deployment is a no-op; disabled channels are excluded from selection', async () => {
  const off = harness('none');
  await off.service.notifyApprovalRequest('session', 'approval-1', 'Bash');
  assert.equal(off.queries.length, 0);
  for (const channel of ['ios', 'android'] as const) {
    const h = harness(channel);
    await h.service.notifyApprovalRequest('session', 'approval-1', 'Bash');
    assert.deepEqual(h.queries[0].where.OR.map((w: any) => w.platform), [channel]);
  }
});

test('defensive routing rejects foreign package/platform/environment even if a caller hands them in', async () => {
  const h = harness();
  const body = JSON.stringify({ aps: { alert: { title: 'x', body: 'y' } } });
  const rejected = [ { ...android, bundleId: 'other.package' }, { ...android, environment: 'sandbox' },
    { ...ios, platform: 'web' }, { ...ios, bundleId: 'other.bundle' }, { ...ios, environment: 'unknown' } ];
  assert.equal(await (h.service as any).deliver(rejected, body, 'alert', '10'), 0);
  assert.equal(h.apns.length + h.fcm.length, 0);
});

test('APNs failure does not suppress Android; invalid cleanup matches the exact registration snapshot', async () => {
  const h = harness();
  (h.service as any).send = async () => ({ status: 410, reason: 'Unregistered' });
  await h.service.notifyApprovalRequest('session', 'approval-1', 'Bash');
  assert.equal(h.fcm.length, 1);
  assert.deepEqual(h.removed[0].where, ios);
  const f = harness('android');
  (f.service as any).fcm.send = async () => ({ accepted: false, invalidToken: true, reason: 'UNREGISTERED' });
  await f.service.notifyApprovalRequest('session', 'approval-1', 'Bash');
  assert.deepEqual(f.removed[0].where, android);
});

test('APNs production host, transport arguments and collapse identity remain unchanged', async () => {
  const h = harness('ios');
  const body = JSON.stringify({ aps: { alert: { title: 'Orbit', body: 'Finished' }, category: 'ORBIT_SESSION' },
    kind: 'finished', sessionID: 'session' });
  assert.equal(await (h.service as any).deliver([{ ...ios, environment: 'production' }], body, 'alert', '10', 'settled-session'), 1);
  assert.deepEqual(h.apns[0], ['api.push.apple.com', 'apns-token', body, 'apns-auth', 'alert', '10', 'settled-session']);
});

test('APNs signs each host with its own key and JWT cache; legacy credentials still serve either host', async () => {
  const production = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sandbox = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const encoded = (key: typeof production.privateKey) => Buffer.from(key.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
  const values = { APNS_KEY: encoded(production.privateKey), APNS_KEY_ID: 'default-key',
    APNS_SANDBOX_KEY: encoded(sandbox.privateKey), APNS_SANDBOX_KEY_ID: 'sandbox-key' };
  const h = harness('ios', values);
  (h.service as any).authToken = (PushService.prototype as any).authToken;
  const rows = [{ ...ios, environment: 'production' }, ios];
  const body = JSON.stringify({ aps: { badge: 1 } });
  assert.equal(await (h.service as any).deliver(rows, body, 'background', '5'), 2);
  assert.equal(await (h.service as any).deliver(rows, body, 'background', '5'), 2);
  for (const [index, pair, keyId, host] of [
    [0, production, 'default-key', 'api.push.apple.com'],
    [1, sandbox, 'sandbox-key', 'api.sandbox.push.apple.com'],
  ] as const) {
    const token = h.apns[index][3];
    assert.equal(h.apns[index][0], host);
    assert.equal(h.apns[index + 2][3], token);
    assert.equal(jwt.decode(token, { complete: true })!.header.kid, keyId);
    assert.equal((jwt.verify(token, pair.publicKey.export({ type: 'spki', format: 'pem' }), { algorithms: ['ES256'] }) as jwt.JwtPayload).iss, 'test');
  }
  // Expiring one cache never changes the other environment's token.
  (h.service as any).apnsCredentials.sandbox.cached = { token: 'expired', iat: 0 };
  assert.notEqual((h.service as any).authToken('sandbox'), 'expired');
  assert.equal((h.service as any).authToken('production'), h.apns[0][3]);

  const fallback = harness('ios', { APNS_KEY: values.APNS_KEY, APNS_KEY_ID: values.APNS_KEY_ID });
  (fallback.service as any).authToken = (PushService.prototype as any).authToken;
  assert.equal(await (fallback.service as any).deliver(rows, body, 'background', '5'), 2);
  for (const args of fallback.apns) {
    assert.equal(jwt.decode(args[3], { complete: true })!.header.kid, 'default-key');
    jwt.verify(args[3], production.publicKey.export({ type: 'spki', format: 'pem' }), { algorithms: ['ES256'] });
  }
  const explicit = harness('ios', { ...values, APNS_KEY: undefined, APNS_KEY_ID: undefined,
    APNS_PRODUCTION_KEY: values.APNS_KEY, APNS_PRODUCTION_KEY_ID: 'production-key' });
  (explicit.service as any).authToken = (PushService.prototype as any).authToken;
  assert.equal(await (explicit.service as any).deliver(rows, body, 'background', '5'), 2);
  assert.equal(jwt.decode(explicit.apns[0][3], { complete: true })!.header.kid, 'production-key');
});

for (const environment of ['sandbox', 'production'] as const) {
  test(`APNs ${environment} key rejection logs once, preserves tokens and skips future sends; other channels continue`, async () => {
    const h = harness();
    const warnings: string[] = [];
    (h.service as any).log.warn = (message: string) => warnings.push(message);
    (h.service as any).send = async (...args: any[]) => {
      h.apns.push(args);
      return args[0] === (environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com')
        ? { status: 403, reason: 'BadEnvironmentKeyInToken' } : { status: 200 };
    };
    const rows = [ios, { ...ios, id: 'production-row', environment: 'production' }, android];
    const body = JSON.stringify({ aps: { alert: { title: 'Orbit', body: 'x' } } });
    // Concurrent requests can already be in flight when the key is first rejected.
    assert.deepEqual(await Promise.all([1, 2, 3].map(() => (h.service as any).deliver(rows, body, 'alert', '10'))), [2, 2, 2]);
    assert.equal(h.apns.length, 6);
    assert.equal(await (h.service as any).deliver(rows, body, 'alert', '10'), 2);
    assert.equal(h.apns.length, 7);
    assert.equal(h.fcm.length, 4);
    assert.equal(h.removed.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`403 BadEnvironmentKeyInToken for ${environment}`));
    assert.match(warnings[0], /api\.(sandbox\.)?push\.apple\.com/);
    assert.ok(!warnings[0].includes(ios.token));
  });
}

test('missing or partial environment credentials are skipped once without mixing keys or suppressing the other host', async () => {
  for (const overrides of [
    { APNS_KEY: undefined, APNS_KEY_ID: undefined, APNS_PRODUCTION_KEY: 'test', APNS_PRODUCTION_KEY_ID: 'prod' },
    { APNS_SANDBOX_KEY: 'test' },
    { APNS_SANDBOX_KEY_ID: 'sandbox' },
  ]) {
    const h = harness('ios', overrides);
    const warnings: string[] = [];
    (h.service as any).log.warn = (message: string) => warnings.push(message);
    const body = JSON.stringify({ aps: { badge: 1 } });
    for (let i = 0; i < 2; i++) {
      assert.equal(await (h.service as any).deliver([ios, { ...ios, environment: 'production' }], body, 'background', '5'), 1);
    }
    assert.equal(h.apns.length, 2);
    assert.ok(h.apns.every((args) => args[0] === 'api.push.apple.com'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sandbox.*no complete credentials/);
    assert.equal(h.removed.length, 0);
  }
});

test('other APNs 403 errors do not permanently disable an environment', async () => {
  const h = harness('ios');
  const warnings: string[] = [];
  (h.service as any).log.warn = (message: string) => warnings.push(message);
  (h.service as any).send = async (...args: any[]) => {
    h.apns.push(args);
    return h.apns.length === 1 ? { status: 403, reason: 'ExpiredProviderToken' } : { status: 200 };
  };
  const body = JSON.stringify({ aps: { badge: 1 } });
  assert.equal(await (h.service as any).deliver([ios], body, 'background', '5'), 0);
  assert.equal(await (h.service as any).deliver([ios], body, 'background', '5'), 1);
  assert.equal(h.removed.length, 0);
  assert.match(warnings[0], /ExpiredProviderToken for sandbox \(api.sandbox.push.apple.com\)/);
});

test('a schedule finding with a 200-character key reaches APNs with a collapse id of at most 64 bytes, the same for the same key', async () => {
  const h = harness('both');
  const scheduleId = '0196a6b2-7c1e-7f00-8a00-0123456789ab';
  const key = 'x1-walkthrough version: 2 — '.padEnd(200, 'a: b ');
  assert.equal(key.length, 200);
  const alert = (k: string) => ({ kind: 'FINDING', ownerId: 'owner', scheduleId, opens: { sessionId: 'session' },
    ownerRequestId: null, title: 'x1 walkthrough version check', body: 'Changed', collapseId: findingCollapseId(scheduleId, k) });
  await h.service.notifySchedule(alert(key));
  await h.service.notifySchedule(alert(key));
  await h.service.notifySchedule(alert(`${key.slice(0, 199)}b`));
  const ids = h.apns.map((args) => args[6] as string);
  assert.equal(ids.length, 3);
  for (const id of ids) assert.ok(Buffer.byteLength(id, 'utf8') <= 64, id);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
  // Android collapses on the same id.
  assert.deepEqual(h.fcm.map((args) => args[1].notificationKey), ids);
});

test('the transport fits any collapse id over 64 bytes, stably, and leaves one within it untouched', async () => {
  const h = harness('ios');
  const body = JSON.stringify({ aps: { alert: { title: 'Orbit', body: 'x' } }, kind: 'schedule' });
  const long = `schedule-finding-0196a6b2-7c1e-7f00-8a00-0123456789ab-${'é: '.repeat(40)}`;
  const exact = 'a'.repeat(64);
  for (const id of [long, long, exact]) await (h.service as any).deliver([ios], body, 'alert', '10', id);
  const sent = h.apns.map((args) => args[6] as string);
  assert.equal(Buffer.byteLength(sent[0], 'utf8'), 64);
  assert.equal(sent[0], sent[1]);
  assert.equal(sent[0], fitCollapseId(long));
  assert.equal(sent[2], exact);
  assert.equal(fitCollapseId('settled-session'), 'settled-session');
});
