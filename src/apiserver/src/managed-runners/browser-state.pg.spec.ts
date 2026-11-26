/**
 * The managed runner browser's state and Clear saved logins (managed-runners/browser-state.ts; docs/runner-browser-design.md
 * §5, §6): `GET /api/runners/:id/browser` and `POST /api/runners/:id/browser/clear`, on the production apiserver —
 * `build/main.js`, the whole AppModule, run as a child process — over a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty. The spec plays the managed runner's instance on POST /api/runner/heartbeat, with the generation
 * and Pod UID its mapping records, as the link gateway forwards the runner's beats to that handler
 * (test-support/daemon-routes-over-http.ts lifts the HTTPS refusal for this spec's apiservers).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/browser-state.pg.spec.ts
 *
 * Account A owns a managed runner R and a self-managed runner S, and a session on R that account G is a guest of.
 * Account B is a stranger.
 *
 *   1. With the browser switch off (managed runners on), both routes are 404 to everyone, signed in or not, before
 *      anything is read or written; the runner's beat is handed no clear.
 *   2. With it on: no login is 401; B, G, A on S and A on a runner that does not exist are 404 on both routes; nothing
 *      is written.
 *   3. The state: UNKNOWN before any report; R's beat reporting the browser makes it RUNNING with the lease holder and
 *      the viewers, at the beat's time; a beat with no report makes it UNKNOWN again.
 *   4. The clear: refused 409 while R does not declare browser-clear/v1, and then written nowhere; once it does, 202,
 *      the state shows it pending, R's next beat is handed `clearBrowserProfile` exactly once, and R's report of the
 *      clear (IDLE, profileClearedAt) is what the state then says.
 *
 * Not destructive: every row belongs to the accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RunnerStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
// The heartbeat is called over plain HTTP, as the link gateway's forwarded call reaches the same handler.
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const INSTANCE_CAPABILITY = 'managed-runner-instance-v1';
const BROWSER_CLEAR = 'browser-clear/v1';

test('the browser state and Clear saved logins: owner only, 404 when off, the clear handed to one heartbeat', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  const servers: Apiserver[] = [];
  t.after(async () => {
    for (const server of servers) await server.stop();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // ── the accounts, A's two runners, A's session with G as its guest ─────────────────────────────────────────
  const account = async (name: string) => {
    const user = { id: randomUUID(), email: `${name}-${RUN}@browser-state.invalid`, password: `pw-${name}-${RUN}` };
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [user.id, user.email, name, hashPassword(user.password)]);
    return user;
  };
  const a = await account('owner');
  const b = await account('stranger');
  const g = await account('guest');
  const runner = async (name: string) => {
    const id = randomUUID();
    const token = `browser-state-${name}-${randomUUID()}`;
    await prisma.runner.create({
      data: { id, ownerId: a.id, name: `machine ${name}`, tokenHash: sha256(token), status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
    });
    return { id, token };
  };
  const managed = await runner('managed');
  const selfManaged = await runner('self-managed');
  const podUid = randomUUID();
  // The account's managed runner, asleep as its manager left it, so that no manager acts on it while the spec runs, with
  // the instance its heartbeats come from recorded.
  await prisma.managedRunner.create({
    data: {
      ownerId: a.id, runnerId: managed.id, clusterKey: 'browser-state-spec', namespace: 'orbit', pvcName: `mr-data-${managed.id}`,
      desiredState: 'SLEEPING', managementState: 'SLEEPING', generation: 1, podUid,
    },
  });
  const session = await prisma.session.create({
    data: {
      ownerId: a.id, creatorId: a.id, assignedRunnerId: managed.id, provider: 'claude', engine: 'claude', model: 'claude-opus-5-5',
      title: 'a session on the managed runner', prompt: 'browse', turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
    },
    select: { id: true },
  });
  await prisma.sessionGuest.create({ data: { sessionId: session.id, ownerId: a.id, userId: g.id } });

  const JWT_SECRET = `browser-state-${randomUUID()}`;
  const boot = async (browser: string) => {
    const server = await startApiserver(url, JWT_SECRET, {
      ORBIT_MANAGED_RUNNERS_ENABLED: 'true', ORBIT_MANAGED_RUNNERS_PROFILE: '', ORBIT_MANAGED_RUNNER_BROWSER_ENABLED: browser,
    });
    servers.push(server);
    return server;
  };
  const login = async (server: Apiserver, user: { email: string; password: string }) => {
    const reply = await call(server, 'POST', '/api/auth/login', undefined, { email: user.email, password: user.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  /** One heartbeat of R's authorized instance, declaring browser-clear/v1 or not. */
  const beat = async (server: Apiserver, body: object, declares = true) => {
    const reply = await call(server, 'POST', '/api/runner/heartbeat', managed.token, { version: '0.1.0', ...body }, {
      'x-orbit-runner-capabilities': declares ? `${INSTANCE_CAPABILITY},${BROWSER_CLEAR}` : INSTANCE_CAPABILITY,
      'x-orbit-cloud-runner-generation': '1',
      'x-orbit-cloud-runner-pod-uid': podUid,
    });
    assert.equal(reply.status, 201, `R's heartbeat: ${reply.text}`);
    return reply.json as Record<string, unknown>;
  };
  const row = () => prisma.runner.findUniqueOrThrow({ where: { id: managed.id }, select: { browserState: true, browserClearRequestedAt: true } });
  const state = (server: Apiserver, token: string | undefined, runnerId: string = managed.id) => call(server, 'GET', `/api/runners/${runnerId}/browser`, token);
  const clear = (server: Apiserver, token: string | undefined, runnerId: string = managed.id) => call(server, 'POST', `/api/runners/${runnerId}/browser/clear`, token, {});

  await t.test('1. with the browser switch off, both routes are absent to everyone, and nothing is written', async () => {
    const off = await boot('');
    const token = await login(off, a);
    for (const who of [token, undefined]) {
      const read = await state(off, who);
      assert.equal(read.status, 404, read.text);
      assert.match(read.text, /Cannot GET \/api\/runners\/[^/]+\/browser/);
      const press = await clear(off, who);
      assert.equal(press.status, 404, press.text);
      assert.match(press.text, /Cannot POST \/api\/runners\/[^/]+\/browser\/clear/);
    }
    assert.equal((await row()).browserClearRequestedAt, null);
    const answer = await beat(off, {});
    assert.equal(answer.clearBrowserProfile, undefined);
    await off.stop();
  });

  const on = await boot('true');
  const tokenA = await login(on, a);
  const tokenB = await login(on, b);
  const tokenG = await login(on, g);

  await t.test('2. only the runner\'s owner, and only on the managed runner: everyone else is refused and nothing is written', async () => {
    await prisma.runner.update({ where: { id: managed.id }, data: { capabilities: [INSTANCE_CAPABILITY, BROWSER_CLEAR] } });
    assert.equal((await state(on, undefined)).status, 401);
    assert.equal((await clear(on, undefined)).status, 401);
    for (const [who, token, runnerId] of [
      ['another account on the managed runner', tokenB, managed.id],
      ['the guest of a session on the runner', tokenG, managed.id],
      ['the owner on a self-managed runner', tokenA, selfManaged.id],
      ['the owner on a runner that does not exist', tokenA, randomUUID()],
      ['the owner on an id that is not one', tokenA, 'not-an-id'],
    ] as const) {
      const read = await state(on, token, runnerId);
      assert.equal(read.status, 404, `${who}, GET: ${read.text}`);
      assert.match(read.text, /No managed runner of yours has this id/);
      const press = await clear(on, token, runnerId);
      assert.equal(press.status, 404, `${who}, POST: ${press.text}`);
    }
    assert.equal((await row()).browserClearRequestedAt, null, 'no refused clear was written');
    const s = await prisma.runner.findUniqueOrThrow({ where: { id: selfManaged.id }, select: { browserClearRequestedAt: true } });
    assert.equal(s.browserClearRequestedAt, null);
  });

  await t.test('3. the state is what R\'s last beat reported: UNKNOWN, then RUNNING with its holder, then UNKNOWN', async () => {
    const before = await state(on, tokenA);
    assert.equal(before.status, 200, before.text);
    assert.equal(before.json.state, 'UNKNOWN');
    assert.equal(before.json.reportedAt, null);

    const sent = Date.now();
    await beat(on, { browser: { running: true, holderSessionId: 'sess-public-1', holderTitle: 'Sign in to the shop', viewers: 1 } });
    const running = await state(on, tokenA);
    assert.equal(running.status, 200, running.text);
    assert.equal(running.json.state, 'RUNNING');
    assert.equal(running.json.holderSessionId, 'sess-public-1');
    assert.equal(running.json.holderTitle, 'Sign in to the shop');
    assert.equal(running.json.viewers, 1);
    assert.equal(running.json.clearRequestedAt, null);
    assert.equal(running.json.profileClearedAt, null);
    assert.ok(Date.parse(running.json.reportedAt) >= sent - 1000, `reportedAt ${running.json.reportedAt}`);

    await beat(on, {});
    assert.equal((await state(on, tokenA)).json.state, 'UNKNOWN', 'a beat with no report is a runner with no browser');
  });

  await t.test('4. the clear: refused to a runner that does not declare it; else handed to exactly one beat, and answered by the report', async () => {
    // R's process declares nothing of the browser: its capabilities are replaced by this beat's.
    await beat(on, { browser: { running: true, viewers: 0 } }, false);
    const old = await clear(on, tokenA);
    assert.equal(old.status, 409, old.text);
    assert.match(old.text, /too old to clear saved logins/);
    assert.equal((await row()).browserClearRequestedAt, null);

    await beat(on, { browser: { running: true, viewers: 0 } });
    const pressed = await clear(on, tokenA);
    assert.equal(pressed.status, 202, pressed.text);
    const requestedAt = pressed.json.requestedAt as string;
    assert.ok(!Number.isNaN(Date.parse(requestedAt)));
    assert.equal((await row()).browserClearRequestedAt?.toISOString(), requestedAt);
    assert.equal((await state(on, tokenA)).json.clearRequestedAt, requestedAt);

    // A beat that does not declare browser-clear/v1 is not handed it, and leaves it for one that does.
    const undeclared = await beat(on, { browser: { running: true, viewers: 0 } }, false);
    assert.equal(undeclared.clearBrowserProfile, undefined);
    assert.equal((await row()).browserClearRequestedAt?.toISOString(), requestedAt);

    const handed = await beat(on, { browser: { running: true, viewers: 0 } });
    assert.equal(handed.clearBrowserProfile, true, 'the next beat is handed the clear');
    assert.equal((await row()).browserClearRequestedAt, null, 'the beat that handed it over claimed it');
    const again = await beat(on, { browser: { running: true, viewers: 0 } });
    assert.equal(again.clearBrowserProfile, undefined, 'exactly once');

    const clearedAt = new Date().toISOString();
    await beat(on, { browser: { running: false, viewers: 0, profileClearedAt: clearedAt } });
    const after = await state(on, tokenA);
    assert.equal(after.json.state, 'IDLE');
    assert.equal(after.json.holderSessionId, null);
    assert.equal(after.json.clearRequestedAt, null);
    assert.equal(after.json.profileClearedAt, clearedAt);
  });
});
