import assert from 'node:assert/strict';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { uuidToBase62 } from '@orbit/shared';
import { encryptWebPush, isPushServiceEndpoint, WebPushTransport, webPushMessage } from './web-push-transport';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { RunnerNotifyController } from '../runner-api/runner-notify.controller';

const b64u = (s: string) => Buffer.from(s.replace(/\s/g, ''), 'base64url');

test('encryption reproduces RFC 8291 Appendix A byte for byte', () => {
  const out = encryptWebPush(
    b64u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    { privateKey: b64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') },
    b64u('DGv6ra1nlYgDCS1FRnbzlw'),
  );
  const header = b64u(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`);
  const ciphertext = b64u('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ');
  assert.equal(out.toString('base64url'), Buffer.concat([header, ciphertext]).toString('base64url'));
});

test('only the browsers\' push services are accepted as endpoints', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://wns2-par02p.notify.windows.com/w/?token=x', 'https://web.push.apple.com/QGx']) assert.equal(isPushServiceEndpoint(ok), true, ok);
  for (const bad of ['http://fcm.googleapis.com/fcm/send/abc', 'https://fcm.googleapis.com:8443/x', 'https://evil.example/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.example/x', 'https://u:p@web.push.apple.com/x', 'https://169.254.169.254/latest', 'not a url'])
    assert.equal(isPushServiceEndpoint(bad), false, bad);
});

const SESSION = '0194f1d2-3c4b-7a8e-9f00-112233445566';

test('an APNs body becomes the message sw.js shows or reconciles with', () => {
  const approval = webPushMessage(JSON.stringify({ aps: { alert: { title: 'Approval needed', body: 'Run tests?' }, badge: 1 },
    kind: 'approval', sessionID: SESSION }), 'alert');
  assert.deepEqual(approval, { v: 1, type: 'alert', title: 'Approval needed', body: 'Run tests?',
    tag: `approval-${SESSION}`, url: `/sessions/${uuidToBase62(SESSION)}` });
  const notify = webPushMessage(JSON.stringify({ aps: { alert: { title: 'Build', body: 'Done' } }, kind: 'notify',
    url: 'https://ci.example/run/1' }), 'alert', 'notify-1');
  assert.deepEqual(notify && { tag: notify.type === 'alert' && notify.tag, url: notify.type === 'alert' && notify.url },
    { tag: 'notify-1', url: 'https://ci.example/run/1' });
  assert.deepEqual(webPushMessage(JSON.stringify({ aps: { 'content-available': 1, badge: 0 }, clearSessions: [SESSION] }), 'background'),
    { v: 1, type: 'sync', clearSessions: [SESSION] });
  // A badge-only sync: a browser has no badge, so nothing is sent.
  assert.equal(webPushMessage(JSON.stringify({ aps: { 'content-available': 1, badge: 2 } }), 'background'), null);
});

function vapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
}

function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') };
}

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/sub-1';
const ALERT = { v: 1, type: 'alert', title: 'T', body: 'B', tag: 't', url: '/' } as const;

test('a decision card opens, in the browser, the conversation its card is drawn in — a project’s too', () => {
  // The send PushService makes for an evidence card (the shared Android fixture's `decision-card` sample).
  const sample = JSON.parse(readFileSync(path.resolve(__dirname, '../../../shared/src/android-push.fixture.json'), 'utf8'))
    .samples.find((candidate: { name: string }) => candidate.name === 'decision-card');
  assert.ok(sample, 'the shared Android fixture has no decision-card sample');
  const evidence = webPushMessage(JSON.stringify(sample.source), 'alert', sample.collapseId);
  assert.deepEqual(evidence, {
    v: 1, type: 'alert', title: 'Archive the August receipts', body: 'Does this evidence settle the task? · Revision 1',
    tag: sample.collapseId, url: `/sessions/${uuidToBase62(sample.source.sessionID)}`,
  });
  // A project's card names its project too; the tap still opens the coordinator conversation, where the card is.
  const project = webPushMessage(JSON.stringify({ ...sample.source, cardKind: 'DONE_REQUEST', projectID: SESSION }), 'alert', 'k');
  assert.equal(project && 'url' in project ? project.url : null, `/sessions/${uuidToBase62(sample.source.sessionID)}`);
});

test('a send carries a VAPID JWT for the push service\'s origin, signed by the configured key', async () => {
  const keys = vapidKeys();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = new WebPushTransport({ get: (k: string) => ({ WEB_PUSH_PUBLIC_KEY: keys.publicKey,
    WEB_PUSH_PRIVATE_KEY: keys.privateKey })[k] } as ConfigService,
  async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(null, { status: 201 }); });
  assert.deepEqual(await transport.send(ENDPOINT, browserKeys(), ALERT, async () => true), { accepted: true, invalidToken: false });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['content-encoding'], 'aes128gcm');
  assert.equal(headers.urgency, 'high');
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(headers.authorization)!;
  assert.equal(k, keys.publicKey);
  const [h, p, sig] = t.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'https://orbitd.io');
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const pub = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
    x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
  assert.equal(verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), true);
});

test('a send to a gone subscription, a foreign host or a stale binding', async () => {
  const keys = vapidKeys();
  let status = 410;
  let fetched = 0;
  const transport = new WebPushTransport({ get: (k: string) => ({ WEB_PUSH_PUBLIC_KEY: keys.publicKey,
    WEB_PUSH_PRIVATE_KEY: keys.privateKey })[k] } as ConfigService,
  async () => { fetched++; return new Response(null, { status }); });
  assert.equal((await transport.send(ENDPOINT, browserKeys(), ALERT, async () => true)).invalidToken, true);
  status = 404;
  assert.equal((await transport.send(ENDPOINT, browserKeys(), ALERT, async () => true)).invalidToken, true);
  status = 429;
  assert.deepEqual(await transport.send(ENDPOINT, browserKeys(), ALERT, async () => true), { accepted: false, invalidToken: false, reason: 'HTTP_429' });
  assert.equal(fetched, 3);
  assert.equal((await transport.send('https://evil.example/x', browserKeys(), ALERT, async () => true)).reason, 'ENDPOINT_NOT_ALLOWED');
  assert.equal((await transport.send(ENDPOINT, browserKeys(), ALERT, async () => false)).reason, 'STALE_BINDING');
  assert.equal(fetched, 3);
  // Unconfigured: off, and web-config answers null.
  assert.equal(new WebPushTransport({ get: () => undefined } as unknown as ConfigService).enabled, false);
});

function makePrisma() {
  const upserts: any[] = [];
  const prisma = {
    $transaction: async (work: (tx: any) => Promise<any>) => work(prisma),
    deviceToken: { findUnique: async () => null, upsert: async (args: any) => { upserts.push(args); return {}; } },
  };
  return { prisma, upserts };
}

test('register: a browser stores its endpoint as the token and its keys; anything else is refused', async () => {
  const keys = vapidKeys();
  const config = { get: (k: string) => ({ WEB_PUSH_PUBLIC_KEY: keys.publicKey, WEB_PUSH_PRIVATE_KEY: keys.privateKey })[k] } as ConfigService;
  const { prisma, upserts } = makePrisma();
  const ctrl = new PushController(prisma as any, config);
  assert.deepEqual(ctrl.webConfig(), { publicKey: keys.publicKey });
  assert.deepEqual(new PushController(prisma as any).webConfig(), { publicKey: null });
  const user = { userId: 'u1', email: 'a@b.c' };
  const webKeys = browserKeys();
  assert.deepEqual(await ctrl.register(user, { platform: 'web', token: ENDPOINT, bundleId: 'web', webKeys } as any), { ok: true });
  assert.equal(upserts[0].create.platform, 'web');
  assert.equal(upserts[0].create.token, ENDPOINT);
  assert.deepEqual(upserts[0].create.webKeys, webKeys);
  assert.deepEqual(upserts[0].update.webKeys, webKeys);
  await assert.rejects(ctrl.register(user, { platform: 'web', token: 'https://evil.example/x', bundleId: 'web', webKeys } as any), /push service/);
  await assert.rejects(ctrl.register(user, { platform: 'web', token: ENDPOINT, bundleId: 'web' } as any), /webKeys/);
  await assert.rejects(ctrl.register(user, { platform: 'web', token: ENDPOINT, bundleId: 'io.orbitd.app', webKeys } as any), /bundleId=web/);
  assert.equal(upserts.length, 1);
});

test('PushService delivers to a browser row and deletes it when the push service says it is gone', async () => {
  const keys = vapidKeys();
  const values: Record<string, string> = { WEB_PUSH_PUBLIC_KEY: keys.publicKey, WEB_PUSH_PRIVATE_KEY: keys.privateKey };
  const web = { id: 'web', userId: 'owner', platform: 'web', bundleId: 'web', token: ENDPOINT, environment: 'production',
    webKeys: browserKeys(), updatedAt: new Date(0), loginSessionId: null };
  const removed: unknown[] = [];
  const queried: any[] = [];
  const service = new PushService({
    user: { findUnique: async () => ({ preferences: {} }), updateMany: async () => ({ count: 1 }) },
    deviceToken: {
      findMany: async (q: unknown) => { queried.push(q); return [web]; }, findFirst: async () => ({ id: 'web' }),
      deleteMany: async (q: unknown) => { removed.push(q); },
    },
  } as any, { get: (k: string) => values[k] } as ConfigService);
  let status = 201;
  const sent: string[] = [];
  (service as any).web = new WebPushTransport({ get: (k: string) => values[k] } as ConfigService,
    async (url) => { sent.push(String(url)); return new Response(null, { status }); });
  const notify = () => new RunnerNotifyController(service).notify({ ownerId: 'owner', name: 'runner' } as any, undefined, { message: 'Ready' });
  assert.deepEqual(await notify(), { delivered: true, devices: 1 });
  assert.deepEqual(sent, [ENDPOINT]);
  assert.ok(JSON.stringify(queried[0]).includes('"platform":"web"'));
  assert.deepEqual(removed, []);
  status = 410;
  await notify();
  assert.equal(removed.length, 1);
});
