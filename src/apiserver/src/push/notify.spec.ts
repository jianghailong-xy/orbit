/**
 * POST /notify (push/notify.controller.ts) and what it sends (PushService.notifyOwner), with a fake APNs sender standing
 * in for Apple: the real routing, eligibility and delivery code runs against an in-memory device table holding two
 * accounts' devices, and only the HTTP/2 round-trip is replaced. Through the production apiserver and PostgreSQL —
 * the scope, the refusals, the caps and the limit as a caller meets them — see notify.pg.spec.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NOTIFY_RATE_LIMIT, NotifyController } from './notify.controller';
import { PushService } from './push.service';

const config = (values: Record<string, string>) => ({ get: (key: string) => values[key] }) as ConfigService;
const APNS = { APNS_KEY_ID: 'key-id', APNS_TEAM_ID: 'team-id', APNS_KEY: Buffer.from('test-key').toString('base64') };

const device = (id: string, userId: string, token: string) => ({
  id, userId, token, platform: 'ios', environment: 'production', bundleId: 'io.orbitd.app',
  installationId: null, loginSessionId: null, createdAt: new Date(0), updatedAt: new Date(0),
});

/** Two accounts with two and one iPhones, and a PushService whose APNs round-trip is recorded instead of sent. */
function harness(values: Record<string, string> = APNS, accepted = 200) {
  const devices = [device('d-1', 'owner', 'owner-phone'), device('d-2', 'owner', 'owner-ipad'), device('d-3', 'other', 'other-phone')];
  const reads: unknown[] = [];
  const matches = (row: ReturnType<typeof device>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => key === 'OR' || (row as Record<string, unknown>)[key] === value);
  const prisma = {
    deviceToken: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        reads.push(where);
        return devices.filter((row) => matches(row, where));
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => devices.find((row) => matches(row, where)) ?? null,
      deleteMany: async () => ({ count: 0 }),
    },
    refreshToken: { findMany: async () => [] },
  };
  const service = new PushService(prisma as never, config(values));
  const sent: Array<{ token: string; body: Record<string, any>; priority: string }> = [];
  Object.assign(service as object, {
    authToken: () => 'provider-jwt',
    send: async (_host: string, token: string, body: string, _auth: string, _type: string, priority: string) => {
      sent.push({ token, body: JSON.parse(body), priority });
      return { status: accepted };
    },
  });
  return { service, sent, reads };
}

test("a notification goes to the token owner's devices and to no other account's", async () => {
  const { service, sent, reads } = harness();
  const result = await service.notifyOwner('owner', { title: 'Disk over 85%', message: '/ is 91% full', priority: 'normal' });
  assert.deepEqual(result, { delivered: true, devices: 2 });
  assert.deepEqual(sent.map((s) => s.token).sort(), ['owner-ipad', 'owner-phone']);
  assert.equal((reads[0] as { userId: string }).userId, 'owner', 'the devices are read by the owner alone');
  assert.deepEqual(sent[0].body, {
    aps: { alert: { title: 'Disk over 85%', body: '/ is 91% full' }, sound: 'default', 'thread-id': 'orbit-notify' },
    kind: 'notify',
  });
  assert.equal(sent[0].priority, '10');
});

test('low is silent and sent at APNs priority 5; high breaks through Focus; a url rides in the payload', async () => {
  const { service, sent } = harness();
  await service.notifyOwner('owner', { title: 't', message: 'm', priority: 'low' });
  assert.equal(sent[0].priority, '5');
  assert.equal(sent[0].body.aps.sound, undefined);
  sent.length = 0;
  await service.notifyOwner('owner', { title: 't', message: 'm', priority: 'high', url: 'https://grafana.example.com/alerting' });
  assert.equal(sent[0].priority, '10');
  assert.equal(sent[0].body.aps['interruption-level'], 'time-sensitive');
  assert.equal(sent[0].body.url, 'https://grafana.example.com/alerting');
});

test('without APNs or FCM credentials the call is answered PUSH_NOT_CONFIGURED, reading and sending nothing', async () => {
  const { service, sent, reads } = harness({});
  assert.deepEqual(await service.notifyOwner('owner', { title: 't', message: 'm', priority: 'normal' }), {
    delivered: false, reason: 'PUSH_NOT_CONFIGURED',
  });
  assert.equal(reads.length, 0);
  assert.equal(sent.length, 0);
});

test('an account with no device answers NO_DEVICES, and devices that refuse it answer NOT_ACCEPTED', async () => {
  assert.deepEqual(await harness().service.notifyOwner('nobody', { title: 't', message: 'm', priority: 'normal' }), {
    delivered: false, reason: 'NO_DEVICES',
  });
  const refusing = harness(APNS, 500);
  assert.deepEqual(await refusing.service.notifyOwner('owner', { title: 't', message: 'm', priority: 'normal' }), {
    delivered: false, reason: 'NOT_ACCEPTED',
  });
  assert.equal(refusing.sent.length, 2, 'it was tried on both devices');
});

test(`the controller sends for the caller's own account, trims, and holds each token to ${NOTIFY_RATE_LIMIT.max} a minute`, async () => {
  const calls: Array<{ ownerId: string; input: unknown }> = [];
  const push = { notifyOwner: async (ownerId: string, input: unknown) => (calls.push({ ownerId, input }), { delivered: false, reason: 'PUSH_NOT_CONFIGURED' }) };
  const controller = new NotifyController(push as never);
  const as = (tokenId: string) => ({ userId: 'owner', email: 'o@example.invalid', credential: { kind: 'PAT' as const, tokenId, scopes: ['notify'], workspaceIds: [] } });

  await controller.send(as('t-1'), { title: '  Disk  ', message: ' full ' });
  assert.deepEqual(calls[0], { ownerId: 'owner', input: { title: 'Disk', message: 'full', priority: 'normal' } });
  for (let i = 1; i < NOTIFY_RATE_LIMIT.max; i++) await controller.send(as('t-1'), { title: 't', message: 'm' });
  await assert.rejects(controller.send(as('t-1'), { title: 't', message: 'm' }), (error: unknown) =>
    error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS);
  assert.equal(calls.length, NOTIFY_RATE_LIMIT.max, 'the refused call sent nothing');
  // Another token of the same account has its own window.
  await controller.send(as('t-2'), { title: 't', message: 'm' });
  assert.equal(calls.length, NOTIFY_RATE_LIMIT.max + 1);
});
