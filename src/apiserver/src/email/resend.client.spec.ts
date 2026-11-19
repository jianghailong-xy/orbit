import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { classify, sendViaResend } from './resend.client';

/**
 * The Resend client against a fake HTTP server (docs/welcome-email-design.md §3.2): 200, 422, 429, 5xx,
 * 401/403, 409 and a timeout, each answered by the path the test posts to.
 */
interface Seen {
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}
let server: Server;
let base = '';
const seen: Seen[] = [];

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      const status = Number(req.url!.slice(1));
      if (req.url === '/hang') return; // never answers
      res.writeHead(status, { 'content-type': 'application/json' });
      if (status === 200) res.end(JSON.stringify({ id: '4ef9a417-0000-c33c' }));
      else if (status === 409) res.end(JSON.stringify({ name: 'concurrent_idempotent_requests', message: 'Another request is in progress' }));
      else res.end(JSON.stringify({ statusCode: status, name: 'error', message: `answer ${status}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const mail = { from: 'Orbit <orbit@example.com>', to: 'maya@example.com', replyTo: 'admin@example.com', subject: 'S', html: '<p>h</p>', text: 't' };

test('200: SENT with the id, and the request carries the key, the bearer and the fields', async () => {
  const r = await sendViaResend('re_key', mail, { url: `${base}/200`, idempotencyKey: 'welcome/u1/0/0' });
  assert.deepEqual(r, { outcome: 'SENT', id: '4ef9a417-0000-c33c' });
  const last = seen.at(-1)!;
  assert.equal(last.headers.authorization, 'Bearer re_key');
  assert.equal(last.headers['idempotency-key'], 'welcome/u1/0/0');
  assert.deepEqual(last.body, { from: mail.from, to: ['maya@example.com'], reply_to: 'admin@example.com', subject: 'S', html: '<p>h</p>', text: 't' });
});

test('422: FAILED at once, with the status and Resend message', async () => {
  assert.deepEqual(await sendViaResend('k', mail, { url: `${base}/422` }), { outcome: 'FAILED', status: 422, error: '422 answer 422' });
});

test('429 and 5xx: RETRY, answered', async () => {
  for (const status of [429, 500, 503]) {
    assert.deepEqual(await sendViaResend('k', mail, { url: `${base}/${status}` }), {
      outcome: 'RETRY',
      status,
      error: `${status} answer ${status}`,
      answered: true,
    });
  }
});

test('401 and 403: RETRY, so a fixed key or domain sends it later', async () => {
  for (const status of [401, 403]) assert.equal((await sendViaResend('k', mail, { url: `${base}/${status}` })).outcome, 'RETRY');
});

test('409 concurrent: RETRY; other 4xx: FAILED', async () => {
  assert.equal((await sendViaResend('k', mail, { url: `${base}/409` })).outcome, 'RETRY');
  assert.equal((await sendViaResend('k', mail, { url: `${base}/400` })).outcome, 'FAILED');
  assert.equal(classify(409, '{"name":"invalid_idempotent_request","message":"x"}').outcome, 'FAILED');
});

test('timeout: RETRY, unanswered, so the next try keeps the key', async () => {
  const r = await sendViaResend('k', mail, { url: `${base}/hang`, timeoutMs: 200 });
  assert.deepEqual(r, { outcome: 'RETRY', status: null, error: 'timed out after 0.2s', answered: false });
});

test('network error: RETRY, unanswered', async () => {
  const r = await sendViaResend('k', mail, { url: 'http://127.0.0.1:1/x' });
  assert.equal(r.outcome, 'RETRY');
  assert.equal(r.outcome === 'RETRY' && r.answered, false);
});

test('no reply_to when there is none', async () => {
  await sendViaResend('k', { ...mail, replyTo: null }, { url: `${base}/200` });
  assert.equal('reply_to' in seen.at(-1)!.body, false);
});
