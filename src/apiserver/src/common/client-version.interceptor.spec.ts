import assert from 'node:assert/strict';
import { test } from 'node:test';
import { of } from 'rxjs';
import { ClientVersionInterceptor } from './client-version.interceptor';

const USER = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';

type Upsert = { where: unknown; create: { kind: string; version: string }; update: unknown };

/** A PrismaService stub that records upserts, and can be told to fail them. */
function harness(opts: { fail?: boolean } = {}) {
  const calls: Upsert[] = [];
  const prisma = {
    clientVersion: {
      upsert: (args: Upsert) => {
        calls.push(args);
        return opts.fail ? Promise.reject(new Error('pool exhausted')) : Promise.resolve({});
      },
    },
  };
  const interceptor = new ClientVersionInterceptor(prisma as never);
  // `null`, not `undefined`, is how a caller says "unauthenticated" — a default parameter treats
  // an explicit `undefined` as absent and would hand the test the signed-in user anyway.
  const hit = (header?: string, userId: string | null = USER) => {
    const req = { headers: header ? { 'x-orbit-client': header } : {}, user: userId ? { userId } : undefined };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) };
    return interceptor.intercept(ctx as never, { handle: () => of('body') } as never);
  };
  return { calls, hit };
}

/** The write is fire-and-forget, so let the microtask queue drain before asserting on it. */
const settle = () => new Promise((r) => setImmediate(r));

test('records the client build behind an authenticated request', async () => {
  const { calls, hit } = harness();
  hit('web/0.1.114');
  await settle();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].create, { userId: USER, kind: 'web', version: '0.1.114' });
});

// It is telemetry riding on every request. Anything it does not understand it must drop, because
// the alternative — a 400 — breaks a shipped client over a header it only sends to be helpful.
test('ignores a header it cannot trust, without failing the request', async () => {
  const { calls, hit } = harness();
  for (const bad of [
    undefined,
    'web',                       // no kind/version separator
    'runner/0.1.114',            // runners report via Runner.version; two sources would diverge
    'web/',                      // empty version
    'web/../../etc/passwd',      // not a version
    `web/${'9'.repeat(33)}`,     // unbounded junk
  ]) {
    const result = hit(bad);
    assert.ok(result, `request still served for ${String(bad)}`);
  }
  await settle();
  assert.deepEqual(calls, []);
});

// An unauthenticated route (login, setup) has no user to attribute a build to, and a version
// nobody owns cannot answer "whose client is stale".
test('skips an unauthenticated request', async () => {
  const { calls, hit } = harness();
  hit('web/0.1.114', null);
  await settle();
  assert.deepEqual(calls, []);
});

// A client polls every few seconds; one row per (user, kind) must not mean one write per poll.
test('rewrites at most once per hour while the version is unchanged', async () => {
  const { calls, hit } = harness();
  for (let i = 0; i < 50; i++) hit('web/0.1.114');
  await settle();
  assert.equal(calls.length, 1);
});

// The upgrade itself is the event the table exists to catch, so it must never wait out a throttle.
test('writes immediately when the version changes', async () => {
  const { calls, hit } = harness();
  hit('web/0.1.114');
  hit('web/0.1.115');
  await settle();
  assert.deepEqual(
    calls.map((c) => c.create.version),
    ['0.1.114', '0.1.115'],
  );
});

// Same user, two clients: the stale phone has to stay visible behind the current browser.
test('tracks each client kind separately', async () => {
  const { calls, hit } = harness();
  hit('web/0.1.114');
  hit('ios/0.1.99');
  hit('macos/0.1.100');
  await settle();
  assert.deepEqual(
    calls.map((c) => c.create.kind),
    ['web', 'ios', 'macos'],
  );
});

// Without this, one failed write blinds a client for an hour — and the gaps in this table are
// what a cutover decision reads, so a gap that means "the write failed" is worse than no table.
test('a failed write is retried on the next request instead of being throttled out', async () => {
  const { calls, hit } = harness({ fail: true });
  hit('web/0.1.114');
  await settle();
  hit('web/0.1.114');
  await settle();
  assert.equal(calls.length, 2);
});
