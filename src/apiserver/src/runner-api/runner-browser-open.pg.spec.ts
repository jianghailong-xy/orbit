/**
 * browser_open and `orbit browser open [--url]` (runner-api/runner-browser.controller.ts, managed-runners/browser-state.ts
 * #open; board docs/mocks/runner-browser/03-agent-tools.html ②): `POST /api/runner/browser/open`, on the production
 * apiserver — `build/main.js`, the whole AppModule, run as a child process — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty. The spec plays the managed runner's instance on POST /api/runner/heartbeat,
 * as the status spec does, and the runners' `orbit mcp` on the open route, with the runner token and X-Orbit-Session-Id.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-browser-open.pg.spec.ts
 *
 * Account A owns a managed runner R with a session SR on it, and a self-managed runner M with a session SM on it.
 * Account B is a stranger with a self-managed runner N and a session SN on it.
 *
 *   1. With the browser switch off (managed runners on), the route is 404 to A's session, and nothing is written.
 *   2. With it on, any session of the account (SR on R, SM on M; Q3 = A) opens R's browser: refused 409 while R does not
 *      declare browser-open/v1; then 202 with the tab's address on this server (PUBLIC_ORIGIN/runners/:id/browser) and
 *      the page asked for; R's next declaring beat is handed `openBrowser` ({sessionId, url}) exactly once, and a beat
 *      that does not declare it is not. A url that is not http(s), or too long, is 400 and writes nothing. While another
 *      session holds the browser a url is refused 409 (its page is not taken from it) and an open without one is not;
 *      the holder itself may ask for a page.
 *   3. Another account's session is refused (P4 = A): B's runner naming A's session is 403, A's runner naming B's session
 *      is 403, no session is 400, no runner token is 401; B's own session finds no Orbit Cloud runner (409), and nothing
 *      is written on R.
 *
 * Not destructive: every row belongs to the accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { toUuid, uuidToBase62 } from '@orbit/shared';
import { RunnerStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
// The heartbeat is called over plain HTTP, as the link gateway's forwarded call reaches the same handler.
import '../test-support/daemon-routes-over-http';
import { turnStateOfWord } from '../sessions/session-turn-state';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const INSTANCE_CAPABILITY = 'managed-runner-instance-v1';
const BROWSER_CLEAR = 'browser-clear/v1';
const BROWSER_OPEN = 'browser-open/v1';
const ORIGIN = 'https://orbit.browser-open.invalid';
const OPEN_FIELDS = ['runnerId', 'tabUrl', 'url', 'requestedAt'];
/** The answer's fields, less the second spelling every public id goes out in (`runnerPublicId`, main.ts). */
const fieldsOf = (answer: Record<string, unknown>) => Object.keys(answer).filter((k) => !k.endsWith('PublicId')).sort();

test('browser_open: starts the account\'s Orbit Cloud browser for any session of it and answers its tab, another account\'s refused, absent when off', {
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
    const user = { id: randomUUID(), email: `${name}-${RUN}@browser-open.invalid`, password: `pw-${name}-${RUN}` };
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [user.id, user.email, name, hashPassword(user.password)]);
    return user;
  };
  const a = await account('owner');
  const b = await account('stranger');
  const runner = async (ownerId: string, name: string) => {
    const id = randomUUID();
    const token = `browser-open-${name}-${randomUUID()}`;
    await prisma.runner.create({
      data: { id, ownerId, name: `machine ${name}`, tokenHash: sha256(token), status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
    });
    return { id, token };
  };
  const session = async (ownerId: string, runnerId: string, title: string, status: RunStatus = RunStatus.AWAITING_INPUT) =>
    (await prisma.session.create({
      data: {
        ownerId, creatorId: ownerId, assignedRunnerId: runnerId, provider: 'claude', engine: 'claude', model: 'claude-opus-5-5',
        title, prompt: 'browse', turnState: turnStateOfWord(status), dispatchOrigin: SessionDispatchOrigin.USER,
      },
      select: { id: true },
    })).id;
  const r = await runner(a.id, 'managed');
  const m = await runner(a.id, 'self-managed');
  const n = await runner(b.id, 'stranger');
  const podUid = randomUUID();
  await prisma.managedRunner.create({
    data: {
      ownerId: a.id, runnerId: r.id, clusterKey: 'browser-open-spec', namespace: 'orbit', pvcName: `mr-data-${r.id}`,
      desiredState: 'SLEEPING', managementState: 'SLEEPING', generation: 1, podUid,
    },
  });
  await prisma.runner.update({ where: { id: r.id }, data: { capabilities: [INSTANCE_CAPABILITY, BROWSER_CLEAR] } });
  const sr = await session(a.id, r.id, 'a session on the Orbit Cloud runner');
  const sm = await session(a.id, m.id, 'a session on a machine of the owner');
  const sn = await session(b.id, n.id, 'the stranger\'s session');

  const JWT_SECRET = `browser-open-${randomUUID()}`;
  const boot = async (browser: string) => {
    const server = await startApiserver(url, JWT_SECRET, {
      ORBIT_MANAGED_RUNNERS_ENABLED: 'true', ORBIT_MANAGED_RUNNERS_PROFILE: '', ORBIT_MANAGED_RUNNER_BROWSER_ENABLED: browser, PUBLIC_ORIGIN: ORIGIN,
    });
    servers.push(server);
    return server;
  };
  /** R's own credential is a managed runner's: its calls name the instance, as `orbit mcp` in R's Pod does. */
  const instance = (declares = true) => ({
    'x-orbit-runner-capabilities': declares ? `${INSTANCE_CAPABILITY},${BROWSER_CLEAR},${BROWSER_OPEN}` : `${INSTANCE_CAPABILITY},${BROWSER_CLEAR}`,
    'x-orbit-cloud-runner-generation': '1',
    'x-orbit-cloud-runner-pod-uid': podUid,
  });
  const open = (server: Apiserver, runnerToken: string | undefined, sessionId?: string, body: object = {}) =>
    call(server, 'POST', '/api/runner/browser/open', runnerToken, body, {
      ...(runnerToken === r.token ? instance() : {}),
      ...(sessionId ? { 'x-orbit-session-id': sessionId } : {}),
    });
  const beat = async (server: Apiserver, body: object, declares = true) => {
    const reply = await call(server, 'POST', '/api/runner/heartbeat', r.token, { version: '0.1.0', ...body }, instance(declares));
    assert.equal(reply.status, 201, `R's heartbeat: ${reply.text}`);
    return reply.json as Record<string, unknown>;
  };
  const row = () => prisma.runner.findUniqueOrThrow({
    where: { id: r.id }, select: { browserOpenRequestedAt: true, browserOpenRequest: true },
  });
  const handedOpen = (answer: Record<string, unknown>) => answer.openBrowser as { sessionId: string; url?: string } | undefined;
  const tab = `${ORIGIN}/runners/${uuidToBase62(r.id)}/browser`;

  await t.test('1. with the browser switch off, the route is absent and nothing is written', async () => {
    const off = await boot('');
    const asked = await open(off, r.token, sr, { url: 'https://example.test/login' });
    assert.equal(asked.status, 404, asked.text);
    assert.match(asked.text, /Cannot POST \/api\/runner\/browser\/open/);
    assert.equal((await row()).browserOpenRequestedAt, null);
    await off.stop();
  });

  const on = await boot('true');

  await t.test('2. on: any session of the account opens the browser and gets its tab; the next beat is handed it once', async () => {
    const old = await open(on, r.token, sr);
    assert.equal(old.status, 409, old.text);
    assert.match(old.text, /too old to open its browser/);
    assert.equal((await row()).browserOpenRequestedAt, null, 'a refused open wrote nothing');

    // R's beat declares browser-open/v1, with the browser stopped.
    assert.equal(handedOpen(await beat(on, { browser: { running: false, viewers: 0 } })), undefined);

    const asked = await open(on, m.token, sm, { url: 'https://example.test/login?next=/home' });
    assert.equal(asked.status, 202, asked.text);
    assert.deepEqual(fieldsOf(asked.json), [...OPEN_FIELDS].sort());
    assert.equal(toUuid(asked.json.runnerId as string), r.id, 'the account\'s Orbit Cloud runner');
    assert.equal(asked.json.tabUrl, tab, 'the browser tab on this server');
    assert.equal(asked.json.url, 'https://example.test/login?next=/home');
    const stored = await row();
    assert.equal(stored.browserOpenRequestedAt?.toISOString(), asked.json.requestedAt);
    assert.deepEqual(stored.browserOpenRequest, { sessionId: sm, url: 'https://example.test/login?next=/home' });

    const undeclared = await beat(on, { browser: { running: false, viewers: 0 } }, false);
    assert.equal(handedOpen(undeclared), undefined, 'a beat that does not declare browser-open/v1 is not handed it');
    assert.ok((await row()).browserOpenRequestedAt, 'and leaves it for one that does');

    const handed = handedOpen(await beat(on, { browser: { running: false, viewers: 0 } }));
    assert.ok(handed, 'the next beat is handed the open');
    assert.equal(toUuid(handed.sessionId), sm);
    assert.equal(handed.url, 'https://example.test/login?next=/home');
    const claimed = await row();
    assert.equal(claimed.browserOpenRequestedAt, null, 'the beat that handed it over claimed it');
    assert.equal(claimed.browserOpenRequest, null);
    assert.equal(handedOpen(await beat(on, { browser: { running: true, viewers: 0 } })), undefined, 'exactly once');

    // Without a url, from the session on R: the browser is only started.
    const plain = await open(on, r.token, sr);
    assert.equal(plain.status, 202, plain.text);
    assert.equal(plain.json.url, null);
    assert.equal(plain.json.tabUrl, tab);
    const started = handedOpen(await beat(on, { browser: { running: true, viewers: 0 } }));
    assert.ok(started);
    assert.equal(toUuid(started.sessionId), sr);
    assert.equal(started.url, undefined);

    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'not a url', `https://example.test/${'a'.repeat(2100)}`, 42]) {
      const refused = await open(on, r.token, sr, { url: bad });
      assert.equal(refused.status, 400, `${String(bad).slice(0, 40)}: ${refused.text}`);
      assert.equal((await row()).browserOpenRequestedAt, null, 'a refused url wrote nothing');
    }

    // Another session holds the browser: a page is refused, an open without one is not; the holder may ask for a page.
    await beat(on, { browser: { running: true, holderSessionId: 'sess-holder-1', holderTitle: 'Export the monthly report', viewers: 0 } });
    const taken = await open(on, m.token, sm, { url: 'https://example.test/other' });
    assert.equal(taken.status, 409, taken.text);
    assert.match(taken.text, /in use by session sess-holder-1/);
    assert.equal((await row()).browserOpenRequestedAt, null);
    const watch = await open(on, m.token, sm);
    assert.equal(watch.status, 202, watch.text);
    handedOpen(await beat(on, { browser: { running: true, holderSessionId: uuidToBase62(sm), viewers: 0 } }));
    const own = await open(on, m.token, sm, { url: 'https://example.test/mine' });
    assert.equal(own.status, 202, own.text);
    assert.equal(handedOpen(await beat(on, { browser: { running: true, viewers: 0 } }))?.url, 'https://example.test/mine');
  });

  await t.test('3. another account\'s session is refused, and a stranger opens nothing of A\'s', async () => {
    for (const [who, token, sessionId, code] of [
      ['B\'s runner naming A\'s session on R', n.token, sr, 403],
      ['B\'s runner naming A\'s session on M', n.token, sm, 403],
      ['A\'s runner naming B\'s session', r.token, sn, 403],
      ['A\'s managed runner naming A\'s session on M', r.token, sm, 403],
      ['a session id that is not one', r.token, 'not-a-session', 403],
      ['no session', r.token, undefined, 400],
      ['no runner token', undefined, sr, 401],
    ] as const) {
      const asked = await open(on, token, sessionId, { url: 'https://example.test/login' });
      assert.equal(asked.status, code, `${who}: ${asked.text}`);
      assert.doesNotMatch(asked.text, new RegExp(`${uuidToBase62(r.id)}|${r.id}`), `${who}: the refusal names A's runner`);
      assert.equal((await row()).browserOpenRequestedAt, null, `${who}: something was written on R`);
    }
    const stranger = await open(on, n.token, sn, { url: 'https://example.test/login' });
    assert.equal(stranger.status, 409, stranger.text);
    assert.match(stranger.text, /no Orbit Cloud runner/);
    assert.equal((await row()).browserOpenRequestedAt, null);
  });
});
