/**
 * Use the runner's browser on an engine's sign-in (docs/runner-browser-engine-sign-in-design.md): `POST
 * /api/runners/:id/browser/sign-in` (managed-runners/browser-state.ts), the heartbeat's LoginCommand `browser`
 * (RunnerApiController.drainLoginRequest) and the runner's answer on `POST /api/runner/login-result`, on the production
 * apiserver — `build/main.js` as a child process — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from
 * empty. The spec plays the managed runner's instance on the heartbeat, as browser-state.pg.spec.ts does.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/login-runner-browser.pg.spec.ts
 *
 * Account A owns a managed runner R and a self-managed runner S. Account B is a stranger.
 *
 *   1. With the browser switch off, the route is 404, and nothing is written.
 *   2. With it on: no login is 401; B, and A on S, are 404; R not declaring login-runner-browser/v1 is 409; no sign-in
 *      waiting on its link is 409. Nothing is written by any of them.
 *   3. A Claude Code sign-in waiting on its code: the press is 202 and the card reads `requested`; a beat that does not
 *      declare the capability is handed nothing; one that does is handed `browser` for that attempt and account, again
 *      on every beat until the runner answers; its `opened` keeps the link and is what the card reads, and no more
 *      `browser` goes out; a waiting report that says nothing of it (a rejected code's) leaves it; `code-taken` replaces
 *      it; `done` clears it.
 *   4. An answer about an attempt the row has moved past changes nothing, and a new sign-in starts with none.
 *
 * Not destructive: every row belongs to the accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RunnerStatus, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const INSTANCE_CAPABILITY = 'managed-runner-instance-v1';
const LOGIN_RUNNER_BROWSER = 'login-runner-browser/v1';
const LINK = 'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=S1';

test('Use the runner\'s browser: owner only, 404 when off, handed to beats until the runner answers', {
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

  const account = async (name: string) => {
    const user = { id: randomUUID(), email: `${name}-${RUN}@login-runner-browser.invalid`, password: `pw-${name}-${RUN}` };
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [user.id, user.email, name, hashPassword(user.password)]);
    return user;
  };
  const a = await account('owner');
  const b = await account('stranger');
  const runner = async (name: string) => {
    const id = randomUUID();
    const token = `login-runner-browser-${name}-${randomUUID()}`;
    await prisma.runner.create({
      data: { id, ownerId: a.id, name: `machine ${name}`, tokenHash: sha256(token), status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
    });
    return { id, token };
  };
  const managed = await runner('managed');
  const selfManaged = await runner('self-managed');
  const podUid = randomUUID();
  await prisma.managedRunner.create({
    data: {
      ownerId: a.id, runnerId: managed.id, clusterKey: 'login-runner-browser-spec', namespace: 'orbit', pvcName: `mr-data-${managed.id}`,
      desiredState: 'SLEEPING', managementState: 'SLEEPING', generation: 1, podUid,
    },
  });

  const JWT_SECRET = `login-runner-browser-${randomUUID()}`;
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
  /** One heartbeat of R's authorized instance, declaring login-runner-browser/v1 or not. */
  const beat = async (server: Apiserver, declares = true) => {
    const reply = await call(server, 'POST', '/api/runner/heartbeat', managed.token, { version: '0.1.0' }, {
      'x-orbit-runner-capabilities': declares ? `${INSTANCE_CAPABILITY},${LOGIN_RUNNER_BROWSER}` : INSTANCE_CAPABILITY,
      'x-orbit-cloud-runner-generation': '1',
      'x-orbit-cloud-runner-pod-uid': podUid,
    });
    assert.equal(reply.status, 201, `R's heartbeat: ${reply.text}`);
    return reply.json as Record<string, unknown>;
  };
  const report = async (server: Apiserver, body: object) => {
    const reply = await call(server, 'POST', '/api/runner/login-result', managed.token, body, {
      'x-orbit-runner-capabilities': `${INSTANCE_CAPABILITY},${LOGIN_RUNNER_BROWSER}`,
      'x-orbit-cloud-runner-generation': '1',
      'x-orbit-cloud-runner-pod-uid': podUid,
    });
    assert.equal(reply.status, 200, reply.text);
    return reply.json as { applied: boolean };
  };
  const press = (server: Apiserver, token: string | undefined, runnerId: string = managed.id) =>
    call(server, 'POST', `/api/runners/${runnerId}/browser/sign-in`, token, {});
  const card = async (server: Apiserver, token: string) => {
    const reply = await call(server, 'GET', `/api/runners/${managed.id}/login`, token);
    assert.equal(reply.status, 200, reply.text);
    return reply.json as Record<string, unknown>;
  };
  const stored = async () =>
    (await prisma.runner.findUniqueOrThrow({ where: { id: managed.id }, select: { loginBrowser: true } })).loginBrowser;
  /** A Claude Code sign-in of R's account `acc` waiting on its code, as the runner's first report leaves it. */
  const waitingSignIn = async (at: Date) => {
    await prisma.runner.update({
      where: { id: managed.id },
      data: {
        loginStatus: 'awaiting_code', loginEngine: 'claude', loginAccount: 'a1b2c3d4', loginUrl: LINK, loginAt: at,
        loginCode: null, loginMessage: null, loginBrowser: null,
      },
    });
    return at.toISOString();
  };

  await t.test('1. with the browser switch off, the route is absent, and nothing is written', async () => {
    const off = await boot('');
    const token = await login(off, a);
    await waitingSignIn(new Date());
    const reply = await press(off, token);
    assert.equal(reply.status, 404, reply.text);
    assert.match(reply.text, /Cannot POST \/api\/runners\/[^/]+\/browser\/sign-in/);
    assert.equal(await stored(), null);
    await off.stop();
  });

  const on = await boot('true');
  const tokenA = await login(on, a);
  const tokenB = await login(on, b);

  await t.test('2. refused to everyone but the owner, to a runner that does not declare it, and with no link waiting', async () => {
    await prisma.runner.update({ where: { id: managed.id }, data: { capabilities: [INSTANCE_CAPABILITY, LOGIN_RUNNER_BROWSER] } });
    await waitingSignIn(new Date());
    assert.equal((await press(on, undefined)).status, 401);
    for (const [who, token, runnerId] of [
      ['another account', tokenB, managed.id],
      ['the owner on a self-managed runner', tokenA, selfManaged.id],
    ] as const) {
      const reply = await press(on, token, runnerId);
      assert.equal(reply.status, 404, `${who}: ${reply.text}`);
    }
    await prisma.runner.update({ where: { id: managed.id }, data: { capabilities: [INSTANCE_CAPABILITY] } });
    const old = await press(on, tokenA);
    assert.equal(old.status, 409, old.text);
    assert.match(old.text, /too old to open a sign-in in its browser/);

    await prisma.runner.update({ where: { id: managed.id }, data: { capabilities: [INSTANCE_CAPABILITY, LOGIN_RUNNER_BROWSER], loginStatus: 'pending', loginUrl: null } });
    const early = await press(on, tokenA);
    assert.equal(early.status, 409, early.text);
    assert.match(early.text, /No sign-in on this runner is waiting on its link/);
    assert.equal(await stored(), null, 'nothing refused was written');
  });

  await t.test('3. handed to every beat that declares it until the runner answers; the answer is what the card reads', async () => {
    const attempt = await waitingSignIn(new Date());
    const pressed = await press(on, tokenA);
    assert.equal(pressed.status, 202, pressed.text);
    assert.equal(pressed.json.browser, 'requested');
    assert.equal((await card(on, tokenA)).browser, 'requested');

    const undeclared = await beat(on, false);
    assert.equal(undeclared.loginRequest, undefined, 'a process that does not declare it is handed nothing');
    for (let i = 0; i < 2; i++) {
      const handed = await beat(on);
      assert.deepEqual(handed.loginRequest, { action: 'browser', engine: 'claude', attempt, account: 'a1b2c3d4' }, `beat ${i + 1}`);
    }

    assert.equal((await report(on, { status: 'awaiting_code', url: LINK, attempt, browser: 'opened' })).applied, true);
    const opened = await card(on, tokenA);
    assert.equal(opened.browser, 'opened');
    assert.equal(opened.url, LINK, 'the link is kept');
    assert.equal(opened.status, 'awaiting_code');
    assert.equal((await beat(on)).loginRequest, undefined, 'answered: no more browser goes out');

    await report(on, { status: 'awaiting_code', url: LINK, attempt, message: 'That code wasn\'t accepted' });
    assert.equal(await stored(), 'opened', 'a report that says nothing of the browser leaves it');

    await report(on, { status: 'awaiting_code', url: LINK, attempt, browser: 'code-taken' });
    assert.equal((await card(on, tokenA)).browser, 'code-taken');

    await report(on, { status: 'done', attempt });
    assert.equal(await stored(), null, 'gone with the link');
    assert.equal((await card(on, tokenA)).browser, undefined);
  });

  await t.test('4. an answer about another attempt changes nothing, and a new sign-in starts with none', async () => {
    const old = await waitingSignIn(new Date(Date.now() - 60_000));
    assert.equal((await press(on, tokenA)).status, 202);
    const now = await waitingSignIn(new Date());
    assert.notEqual(old, now);
    assert.equal(await stored(), null, 'a new sign-in starts with nothing asked');
    assert.equal((await report(on, { status: 'awaiting_code', url: LINK, attempt: old, browser: 'opened' })).applied, false);
    assert.equal(await stored(), null);

    const started = await call(on, 'POST', `/api/runners/${managed.id}/login`, tokenA, { engine: 'claude' });
    assert.ok(started.status === 201 || started.status === 200, started.text);
    assert.equal(await stored(), null, 'a start clears it');
  });
});
