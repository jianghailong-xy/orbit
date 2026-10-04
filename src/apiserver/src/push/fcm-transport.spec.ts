import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { FcmTransport } from './fcm-transport';
import { fcmData } from './fcm-payload';
import { PushService } from './push.service';
import { RunnerNotifyController } from '../runner-api/runner-notify.controller';

// Ephemeral, test-only key. No Firebase project, device token or credential leaves this process.
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const values: Record<string, string> = {
  FCM_PROJECT_ID: 'isolated-project', FCM_CLIENT_EMAIL: 'test@example.invalid',
  FCM_PRIVATE_KEY: Buffer.from(key.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
  FCM_ANDROID_PACKAGE: 'io.orbitd.android.debug',
};
const config = { get: (k: string) => values[k] } as ConfigService;
const data = { ...fcmData(JSON.stringify({ aps: { alert: { title: 'Orbit', body: 'Needs your reply' }, badge: 1 },
  kind: 'approval', sessionID: 'session-1' }), 'alert', 'event-1', '2026-10-04T00:00:00.000Z'), registrationKey: 'binding-1' };
const ok = () => new Response(JSON.stringify({ name: 'projects/isolated-project/messages/1' }));
const error = (status: number, code?: string, headers?: Record<string, string>) => new Response(JSON.stringify({
  error: { status: 'ERROR', details: code ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code }] : [] },
}), { status, headers });

function harness(responses: Array<Response | Error | ((init: RequestInit) => Promise<Response>)> = [ok()], authWait?: Promise<void>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const waits: number[] = [];
  let authCalls = 0;
  const request = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') {
      await authWait;
      authCalls++;
      const form = init.body as URLSearchParams;
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const claims = jwt.verify(form.get('assertion')!, key.publicKey, { algorithms: ['RS256'],
        audience: url, issuer: values.FCM_CLIENT_EMAIL }) as jwt.JwtPayload;
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
      assert.equal(claims.exp! - claims.iat!, 3600);
      return new Response(JSON.stringify({ access_token: `oauth-${authCalls}`, expires_in: 3600 }));
    }
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, 'unexpected send/retry');
    if (typeof response === 'function') return response(init);
    return response;
  }) as typeof fetch;
  const transport = new FcmTransport(config, request, async (ms) => { waits.push(ms); });
  return { transport, calls, waits, messages: () => calls.filter((c) => c.url.includes('messages:send')) };
}

test('Android-only OAuth is signed, cached and single-flight; HTTP v1 uses data-only scoped messages', async () => {
  const h = harness([ok(), ok()]);
  assert.equal(h.transport.enabled, true);
  const results = await Promise.all([h.transport.send('fcm-1', data, async () => true),
    h.transport.send('fcm-2', data, async () => true)]);
  assert.ok(results.every((r) => r.accepted));
  assert.equal(h.calls.filter((c) => c.url.includes('/token')).length, 1);
  for (const call of h.messages()) {
    assert.equal(call.url, 'https://fcm.googleapis.com/v1/projects/isolated-project/messages:send');
    assert.equal((call.init.headers as any).authorization, 'Bearer oauth-1');
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal);
    const message = JSON.parse(call.init.body as string).message;
    assert.deepEqual(message.data, data);
    assert.deepEqual(message.android, { priority: 'HIGH', ttl: '300s', restricted_package_name: 'io.orbitd.android.debug' });
    assert.equal(message.notification, undefined);
    assert.equal(message.apns, undefined);
  }
});

test('retry keeps the exact event/payload and honors Retry-After; sync has normal priority', async () => {
  const h = harness([error(503, 'UNAVAILABLE', { 'retry-after': '3' }), ok()]);
  const sync = { ...fcmData(JSON.stringify({ aps: { 'content-available': 1, badge: 0 },
    clearSessions: ['session-1'] }), 'background', 'event-2', data.sentAt), registrationKey: 'binding-1' };
  assert.equal((await h.transport.send('fcm', sync, async () => true)).accepted, true);
  assert.ok(h.waits[0] >= 3000);
  assert.equal(h.messages()[0].init.body, h.messages()[1].init.body);
  const message = JSON.parse(h.messages()[0].init.body as string).message;
  assert.equal(message.android.priority, 'NORMAL');
  assert.deepEqual(JSON.parse(message.data.payload), { clearSessions: ['session-1'], badge: 0 });
});

test('quota backoff cannot fit the synchronous budget and never retries before Retry-After', async () => {
  const quota = harness([error(429)]);
  assert.deepEqual(await quota.transport.send('fcm', data, async () => true),
    { accepted: false, invalidToken: false, reason: 'HTTP_429' });
  assert.equal(quota.messages().length, 1);
  assert.deepEqual(quota.waits, []);
  const later = harness([error(503, undefined, { 'retry-after': '120' })]);
  assert.equal((await later.transport.send('fcm', data, async () => true)).accepted, false);
  assert.equal(later.messages().length, 1);
  assert.deepEqual(later.waits, []);
});

function brokenResponse(status = 200, headers?: Record<string, string>) {
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"name":'));
    controller.error(new TypeError('response stream interrupted'));
  } }), { status, headers });
}

test('interrupted HTTP 200 body retries the same logical message and can recover', async () => {
  const h = harness([brokenResponse(), ok()]);
  assert.deepEqual(await h.transport.send('fcm', data, async () => true), { accepted: true, invalidToken: false });
  assert.equal(h.messages().length, 2);
  assert.equal(h.messages()[0].init.body, h.messages()[1].init.body);
  assert.equal(h.waits.length, 1);
});

test('response read failures exhaust three attempts without invalidating a healthy token', async () => {
  const h = harness([brokenResponse(), brokenResponse(), brokenResponse()]);
  assert.deepEqual(await h.transport.send('fcm', data, async () => true),
    { accepted: false, invalidToken: false, reason: 'TRANSPORT_ERROR' });
  assert.equal(h.messages().length, 3);
  assert.equal(new Set(h.messages().map((c) => c.init.body)).size, 1);
  assert.equal(h.waits.length, 2);
});

test('a broken error body still respects known quota and Retry-After headers', async () => {
  for (const status of [429, 503]) {
    const h = harness([brokenResponse(status, { 'retry-after': '120' })]);
    assert.equal((await h.transport.send('fcm', data, async () => true)).accepted, false);
    assert.equal(h.messages().length, 1);
    assert.deepEqual(h.waits, []);
  }
});

function notifier(transport: FcmTransport) {
  const removed: unknown[] = [];
  let apnsSends = 0;
  const ios = { id: 'ios', userId: 'owner', platform: 'ios', bundleId: 'io.orbitd.app',
    token: 'apns', environment: 'production', updatedAt: new Date(0) };
  const android = { ...ios, id: 'android', platform: 'android', bundleId: values.FCM_ANDROID_PACKAGE, token: 'fcm' };
  const service = new PushService({
    user: { findUnique: async () => ({ preferences: {} }) },
    deviceToken: {
      findMany: async () => [ios, android], findFirst: async () => ({ id: 'current' }),
      deleteMany: async (q: unknown) => { removed.push(q); },
    },
  } as any, { get: (k: string) => values[k] ?? ({ APNS_KEY_ID: 'test', APNS_TEAM_ID: 'test',
    APNS_KEY: Buffer.from('test-only').toString('base64') } as Record<string, string>)[k] } as ConfigService);
  (service as any).fcm = transport;
  (service as any).authToken = () => 'test';
  (service as any).send = async () => { apnsSends++; return { status: 200 }; };
  const controller = new RunnerNotifyController(service);
  return { removed, apnsSends: () => apnsSends,
    notify: () => controller.notify({ ownerId: 'owner', name: 'runner' } as any, undefined, { message: 'Ready' }) };
}

test('runner notify returns the accepted APNs count when FCM is rate limited', async () => {
  const h = harness([error(429, undefined, { 'retry-after': '60' })]);
  const n = notifier(h.transport);
  assert.deepEqual(await n.notify(), { delivered: true, devices: 1 });
  assert.equal(n.apnsSends(), 1);
  assert.equal(h.messages().length, 1);
  assert.deepEqual(h.waits, []);
  assert.deepEqual(n.removed, []);
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const late of ['accepted', 'unregistered', 'body'] as const) {
  test(`runner notify bounds a slow FCM ${late} response and ignores late results`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const h = harness([async () => {
      if (late === 'body') return new Response(new ReadableStream({ async start(controller) {
        await waiting;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ name: 'accepted-too-late' })));
        controller.close();
      } }));
      await waiting;
      return late === 'accepted' ? ok() : error(404, 'UNREGISTERED');
    }]);
    const n = notifier(h.transport);
    let result: unknown;
    const sent = n.notify().then((r) => { result = r; });
    try {
      await flush();
      assert.equal(n.apnsSends(), 1);
      assert.equal(h.messages().length, 1);
      t.mock.timers.tick(15_000);
      await flush();
      assert.deepEqual(result, { delivered: true, devices: 1 });
      assert.equal(h.messages()[0].init.signal?.aborted, true);
    } finally {
      release();
      await sent;
    }
    await flush();
    t.mock.timers.tick(120_000);
    await flush();
    assert.deepEqual(result, { delivered: true, devices: 1 });
    assert.deepEqual(n.removed, []);
    assert.equal(h.messages().length, 1);
    assert.deepEqual(h.waits, []);
  });
}

for (const phase of ['OAuth', 'registration read']) {
  test(`the total budget includes ${phase} and cannot send after it finishes late`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const h = harness([], phase === 'OAuth' ? waiting : undefined);
    let result: unknown;
    const sent = h.transport.send('fcm', data, async () => {
      if (phase === 'registration read') await waiting;
      return true;
    }).then((r) => { result = r; });
    try {
      await flush();
      t.mock.timers.tick(15_000);
      await flush();
      assert.deepEqual(result, { accepted: false, invalidToken: false, reason: 'DEADLINE_EXCEEDED' });
    } finally {
      release();
      await sent;
    }
    await flush();
    assert.equal(h.messages().length, 0);
    assert.deepEqual(h.waits, []);
  });
}

test('OAuth time is deducted from the send budget instead of starting another full timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let authReady!: () => void;
  let responseReady!: () => void;
  const authWait = new Promise<void>((resolve) => { authReady = resolve; });
  const responseWait = new Promise<void>((resolve) => { responseReady = resolve; });
  const h = harness([async () => { await responseWait; return ok(); }], authWait);
  let result: unknown;
  const sent = h.transport.send('fcm', data, async () => true).then((r) => { result = r; });
  try {
    await flush();
    t.mock.timers.tick(8_000);
    authReady();
    await flush();
    assert.equal(h.messages().length, 1);
    t.mock.timers.tick(6_999);
    await flush();
    assert.equal(result, undefined);
    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(result, { accepted: false, invalidToken: false, reason: 'DEADLINE_EXCEEDED' });
    assert.equal(h.messages()[0].init.signal?.aborted, true);
  } finally {
    authReady();
    responseReady();
    await sent;
  }
  await flush();
  assert.equal(h.messages().length, 1);
});

test('401 refreshes OAuth once; sender mismatch, invalid payload and generic 404 never delete tokens', async () => {
  const refresh = harness([error(401), ok()]);
  assert.equal((await refresh.transport.send('fcm', data, async () => true)).accepted, true);
  assert.equal(refresh.calls.filter((c) => c.url.includes('/token')).length, 2);
  assert.equal((refresh.messages()[1].init.headers as any).authorization, 'Bearer oauth-2');
  for (const [status, code] of [[403, 'SENDER_ID_MISMATCH'], [400, 'INVALID_ARGUMENT'], [404, undefined]] as const) {
    const h = harness([error(status, code)]);
    assert.deepEqual(await h.transport.send('fcm', data, async () => true),
      { accepted: false, invalidToken: false, reason: `HTTP_${status}` });
    assert.equal(h.messages().length, 1);
  }
});

test('only typed FCM UNREGISTERED is a dead registration', async () => {
  const h = harness([error(404, 'UNREGISTERED')]);
  assert.deepEqual(await h.transport.send('fcm', data, async () => true),
    { accepted: false, invalidToken: true, reason: 'UNREGISTERED' });
});

test('network retries are bounded and carry one event; exceptions do not expose tokens', async () => {
  const h = harness([new Error('secret-token'), new Error('secret-token'), new Error('secret-token')]);
  assert.deepEqual(await h.transport.send('fcm', data, async () => true),
    { accepted: false, invalidToken: false, reason: 'TRANSPORT_ERROR' });
  assert.equal(h.messages().length, 3);
  assert.equal(new Set(h.messages().map((c) => c.init.body)).size, 1);
  assert.ok(h.waits[0] >= 1000 && h.waits[1] >= 2000);
});

test('account switch during retry cancels the pending old-account message', async () => {
  const h = harness([error(503)]);
  let checks = 0;
  const result = await h.transport.send('fcm', data, async () => ++checks === 1);
  assert.equal(result.reason, 'REGISTRATION_CHANGED');
  assert.equal(h.messages().length, 1);
});

test('missing configuration, stale bindings and oversized payloads cannot initiate a send', async () => {
  const disabled = new FcmTransport({ get: () => undefined } as any, async () => { throw new Error('must not send'); });
  assert.equal(disabled.enabled, false);
  assert.equal((await disabled.send('fcm', data, async () => true)).reason, 'NOT_CONFIGURED');
  const h = harness([]);
  assert.equal((await h.transport.send('fcm', { ...data, payload: 'x'.repeat(4097) }, async () => true)).reason, 'PAYLOAD_TOO_LARGE');
  assert.equal(h.calls.length, 0);
  assert.equal((await h.transport.send('fcm', data, async () => false)).reason, 'REGISTRATION_CHANGED');
  assert.equal(h.messages().length, 0);
});

test('contract preserves routing, categories, zero badge and semantic notification identity', () => {
  const routing = { kind: 'owner-question', sessionID: 'coordinator', projectID: 'project', openItemID: 'item' };
  const wire = fcmData(JSON.stringify({ aps: { alert: { title: 'Question', body: 'Proceed?' },
    category: 'ORBIT_OWNER_ITEM', 'thread-id': 'project' }, ...routing }), 'alert', 'event', data.sentAt, 'owner-item-item');
  assert.equal(wire.notificationKey, 'owner-item-item');
  assert.deepEqual(JSON.parse(wire.payload), { ...routing, title: 'Question', body: 'Proceed?',
    category: 'ORBIT_OWNER_ITEM', threadId: 'project' });
  assert.equal(data.notificationKey, 'approval-session-1');
});

test('the shared Android wire fixture matches the real payload conversion', () => {
  const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../../../shared/src/android-push.fixture.json'), 'utf8'));
  for (const sample of fixture.samples) {
    const actual = { ...fcmData(JSON.stringify(sample.source), sample.pushType,
      sample.data.eventId, sample.data.sentAt), registrationKey: fixture.registered.registrationKey };
    assert.deepEqual(actual, sample.data, sample.name);
    assert.ok(Object.values(actual).every((v) => typeof v === 'string'));
  }
});
