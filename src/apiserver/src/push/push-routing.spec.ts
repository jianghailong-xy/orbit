import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { PushService } from './push.service';

const configValues: Record<string, string> = {
  APNS_KEY_ID: 'test', APNS_TEAM_ID: 'test', APNS_KEY: Buffer.from('test-only').toString('base64'),
  FCM_PROJECT_ID: 'test', FCM_CLIENT_EMAIL: 'test@example.invalid', FCM_PRIVATE_KEY: Buffer.from('test-only').toString('base64'),
};
const ios = { id: 'ios-row', userId: 'owner', token: 'apns-token', platform: 'ios', environment: 'sandbox',
  bundleId: 'io.orbitd.app', updatedAt: new Date(0) };
const android = { ...ios, id: 'android-row', token: 'fcm-token', platform: 'android',
  bundleId: 'io.orbitd.android', environment: 'production' };

function harness(channels: 'ios' | 'android' | 'both' | 'none' = 'both') {
  const queries: any[] = [];
  const removed: any[] = [];
  const apns: any[][] = [];
  const fcm: any[][] = [];
  let pending = ['session'];
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
  const config = { get: (k: string) => (channels === 'both' || channels === 'ios' && k.startsWith('APNS_')
    || channels === 'android' && k.startsWith('FCM_')) ? configValues[k] : undefined } as ConfigService;
  const service = new PushService(prisma as any, config);
  (service as any).needsYouSessions = async () => pending;
  (service as any).authToken = () => { assert.notEqual(channels, 'android'); return 'apns-auth'; };
  (service as any).send = async (...args: any[]) => { apns.push(args); return { status: 200 }; };
  (service as any).fcm.send = async (...args: any[]) => {
    assert.equal(await args[2](), true);
    fcm.push(args);
    return { accepted: true, invalidToken: false };
  };
  return { service, prisma, queries, removed, apns, fcm, setPending: (p: string[]) => { pending = p; } };
}

test('query restricts owner, configured channel, package and environment; Android never reaches APNs', async () => {
  const h = harness();
  await h.service.notifyApprovalRequest('session', 'Bash');
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
    await Promise.all(['Bash', 'Write', 'Edit'].map((tool) => h.service.notifyApprovalRequest('session', tool)));
    assert.equal(h.apns.length, channel === 'android' ? 0 : 1);
    assert.equal(h.fcm.length, channel === 'ios' ? 0 : 1);
    h.setPending([]);
    await (h.service as any).reconcileBadge('owner');
    await (h.service as any).reconcileBadge('owner');
    await h.service.notifyApprovalRequest('session', 'late call');
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
    await h.service.notifyApprovalRequest('session', 'new approval');
    assert.equal(channel === 'ios' ? h.apns.length : h.fcm.length, 3);
  });
}

test('an unconfigured deployment is a no-op; disabled channels are excluded from selection', async () => {
  const off = harness('none');
  await off.service.notifyApprovalRequest('session', 'Bash');
  assert.equal(off.queries.length, 0);
  for (const channel of ['ios', 'android'] as const) {
    const h = harness(channel);
    await h.service.notifyApprovalRequest('session', 'Bash');
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
  await h.service.notifyApprovalRequest('session', 'Bash');
  assert.equal(h.fcm.length, 1);
  assert.deepEqual(h.removed[0].where, ios);
  const f = harness('android');
  (f.service as any).fcm.send = async () => ({ accepted: false, invalidToken: true, reason: 'UNREGISTERED' });
  await f.service.notifyApprovalRequest('session', 'Bash');
  assert.deepEqual(f.removed[0].where, android);
});

test('APNs production host, transport arguments and collapse identity remain unchanged', async () => {
  const h = harness('ios');
  const body = JSON.stringify({ aps: { alert: { title: 'Orbit', body: 'Finished' }, category: 'ORBIT_SESSION' },
    kind: 'finished', sessionID: 'session' });
  assert.equal(await (h.service as any).deliver([{ ...ios, environment: 'production' }], body, 'alert', '10', 'settled-session'), 1);
  assert.deepEqual(h.apns[0], ['api.push.apple.com', 'apns-token', body, 'apns-auth', 'alert', '10', 'settled-session']);
});
