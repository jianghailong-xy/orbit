/**
 * browser_request_sign_in and `orbit browser request-sign-in` (runner-api/runner-browser.controller.ts,
 * owner-requests/owner-requests.service.ts fileBrowserSignIn; board docs/mocks/runner-browser/03-agent-tools.html ①):
 * `POST /api/runner/browser/sign-in-requests`, on the production apiserver — `build/main.js`, the whole AppModule, run
 * as a child process — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty. The spec plays the
 * runners' `orbit mcp` (runner token, X-Orbit-Session-Id, R's managed instance headers) and the owner's client (JWT).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-browser-sign-in.pg.spec.ts
 *
 * Account A owns a managed (Orbit Cloud) runner R with a session SR on it, and a self-managed runner M with a session SM
 * on it. Account B is a stranger with a self-managed runner N and a session SN.
 *
 *   1. Switch off: the route is 404, as a path the apiserver does not have.
 *   2. On: SR files a card. It is a BROWSER_SIGN_IN owner request in A's Waiting on you (GET /api/owner-requests) with the
 *      server's title "Sign in to github.com", the agent's reason, the site, R as the browser's runner and SR's title;
 *      the stored row keeps the site and nothing else of the browser (a URL is cut to its host). Filing told the
 *      owner like every card does (the push alert's title and category, ownerRequestAlert/ownerRequestPushCategory).
 *   3. Not on the Orbit Cloud runner: SM (A's session on M) is refused 403 BROWSER_SIGN_IN_NOT_ORBIT_CLOUD and nothing is
 *      filed; another account's session is refused 403; request_owner_action's own door refuses the kind (400).
 *   4. The waiting call's read: the runner reads the card PENDING until the owner answers. Not now (decline 'Not now') reads
 *      DECLINED; a second card answered done reads DONE. Neither ending queues a turn to the asking session (no
 *      watch_delivery row): the call that waits returns the answer.
 *
 * Not destructive: every row belongs to the accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { toUuid } from '@orbit/shared';
import { RunnerStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { ownerRequestAlert, ownerRequestPushCategory } from '../owner-requests/owner-request';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const INSTANCE_CAPABILITY = 'managed-runner-instance-v1';
const BROWSER_CLEAR = 'browser-clear/v1';
const REASON = 'Sign in to the account that owns acme/billing, so I can export the report.';

test('browser_request_sign_in: a Waiting-on-you card from the Orbit Cloud runner only, read until the owner answers', {
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
    const user = { id: randomUUID(), email: `${name}-${RUN}@browser-sign-in.invalid`, password: `pw-${name}-${RUN}` };
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [user.id, user.email, name, hashPassword(user.password)]);
    return user;
  };
  const a = await account('owner');
  const b = await account('stranger');
  const runner = async (ownerId: string, name: string) => {
    const id = randomUUID();
    const token = `browser-sign-in-${name}-${randomUUID()}`;
    await prisma.runner.create({
      data: { id, ownerId, name: `machine ${name}`, tokenHash: sha256(token), status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
    });
    return { id, token };
  };
  const session = async (ownerId: string, runnerId: string, title: string) =>
    (await prisma.session.create({
      data: {
        ownerId, creatorId: ownerId, assignedRunnerId: runnerId, provider: 'claude', engine: 'claude', model: 'claude-opus-5-5',
        title, prompt: 'browse', turnState: 'IN_FLIGHT', dispatchOrigin: SessionDispatchOrigin.USER,
      },
      select: { id: true },
    })).id;
  const r = await runner(a.id, 'managed');
  const m = await runner(a.id, 'self-managed');
  const n = await runner(b.id, 'stranger');
  const podUid = randomUUID();
  await prisma.managedRunner.create({
    data: {
      ownerId: a.id, runnerId: r.id, clusterKey: 'browser-sign-in-spec', namespace: 'orbit', pvcName: `mr-data-${r.id}`,
      desiredState: 'SLEEPING', managementState: 'SLEEPING', generation: 1, podUid,
    },
  });
  await prisma.runner.update({ where: { id: r.id }, data: { capabilities: [INSTANCE_CAPABILITY, BROWSER_CLEAR] } });
  const sr = await session(a.id, r.id, 'Export the monthly report from GitHub');
  const sm = await session(a.id, m.id, 'a session on a machine of the owner');
  const sn = await session(b.id, n.id, 'the stranger\'s session');

  const JWT_SECRET = `browser-sign-in-${randomUUID()}`;
  const boot = async (browser: string) => {
    const server = await startApiserver(url, JWT_SECRET, {
      ORBIT_MANAGED_RUNNERS_ENABLED: 'true', ORBIT_MANAGED_RUNNERS_PROFILE: '', ORBIT_MANAGED_RUNNER_BROWSER_ENABLED: browser,
    });
    servers.push(server);
    return server;
  };
  const instance = () => ({
    'x-orbit-runner-capabilities': `${INSTANCE_CAPABILITY},${BROWSER_CLEAR}`,
    'x-orbit-cloud-runner-generation': '1',
    'x-orbit-cloud-runner-pod-uid': podUid,
  });
  const runnerHeaders = (runnerToken: string, sessionId?: string) => ({
    ...(runnerToken === r.token ? instance() : {}),
    ...(sessionId ? { 'x-orbit-session-id': sessionId } : {}),
  });
  const fileSignIn = (server: Apiserver, runnerToken: string, sessionId: string, body: object) =>
    call(server, 'POST', '/api/runner/browser/sign-in-requests', runnerToken, body, runnerHeaders(runnerToken, sessionId));
  const readCard = (server: Apiserver, id: string) =>
    call(server, 'GET', `/api/runner/owner-requests/${id}`, r.token, undefined, runnerHeaders(r.token, sr));
  const deliveries = async (requestId: string) =>
    (await sql.query(`SELECT count(*)::int AS n FROM "watch_delivery" WHERE "owner_request_id" = $1`, [requestId])).rows[0].n as number;

  await t.test('1. with the browser switch off, the route is absent', async () => {
    const off = await boot('');
    const filed = await fileSignIn(off, r.token, sr, { site: 'github.com', reason: REASON });
    assert.equal(filed.status, 404, filed.text);
    assert.match(filed.text, /Cannot POST \/api\/runner\/browser\/sign-in-requests/);
    await off.stop();
  });

  const on = await boot('true');
  const login = await call(on, 'POST', '/api/auth/login', undefined, { email: a.email, password: a.password });
  assert.equal(login.status, 201, login.text);
  const owner = (login.json as { accessToken: string }).accessToken;

  let first = '';
  await t.test('2. a session on the Orbit Cloud runner files a BROWSER_SIGN_IN card in Waiting on you', async () => {
    const filed = await fileSignIn(on, r.token, sr, {
      site: 'https://GitHub.com/login?return_to=%2Facme%2Fbilling%2Fsettings', reason: REASON, clientRequestId: `c-${RUN}`,
    });
    assert.equal(filed.status, 201, filed.text);
    const card = filed.json as Record<string, unknown>;
    first = card.id as string;
    assert.equal(card.kind, 'BROWSER_SIGN_IN');
    assert.equal(card.state, 'PENDING');
    assert.equal(card.title, 'Sign in to github.com', 'the site names the card, cut to its host');
    assert.equal(card.why, REASON, 'the agent\'s reason, quoted on the card');
    assert.equal(card.browserSite, 'github.com');
    assert.equal(toUuid(card.browserRunnerId as string), r.id, 'Open browser opens R\'s browser tab');
    assert.equal(card.askedBySessionTitle, 'Export the monthly report from GitHub', 'From session …');

    // In A's Waiting on you, as every card is: the list web, Mac and phone read.
    const open = await call(on, 'GET', '/api/owner-requests?state=open', owner);
    assert.equal(open.status, 200, open.text);
    const listed = (open.json as { requests: Array<Record<string, unknown>> }).requests.find((x) => x.id === first);
    assert.ok(listed, 'the card is in the owner\'s open list');
    assert.equal(listed.kind, 'BROWSER_SIGN_IN');
    assert.equal(listed.askedBySessionTitle, 'Export the monthly report from GitHub');

    // The push it rang is the one every card rings, with its own kind's title and category.
    assert.deepEqual(ownerRequestAlert('BROWSER_SIGN_IN', 'Sign in to github.com'), { title: 'Sign in needed', body: 'Sign in to github.com' });
    assert.equal(ownerRequestPushCategory('BROWSER_SIGN_IN'), 'ORBIT_OWNER_REQUEST_BROWSER_SIGN_IN');

    // Stored: the site, and nothing of the page the agent was on.
    const row = (await sql.query(`SELECT to_jsonb(r) AS row FROM "owner_request" r WHERE id = $1`, [toUuid(first)])).rows[0].row;
    assert.equal(row.browser_site, 'github.com');
    assert.doesNotMatch(JSON.stringify(row), /return_to|acme%2Fbilling|\/login/, 'the row keeps more of the URL than the site');

    // A retry under the same clientRequestId is the same card, told once.
    const again = await fileSignIn(on, r.token, sr, { site: 'github.com', reason: REASON, clientRequestId: `c-${RUN}` });
    assert.equal(again.status, 201, again.text);
    assert.equal((again.json as { id: string }).id, first);
    assert.equal((again.json as { created: boolean }).created, false);

    for (const bad of [{ site: 'not a host', reason: REASON }, { site: 'github.com', reason: '  ' }, { reason: REASON }]) {
      const refused = await fileSignIn(on, r.token, sr, bad);
      assert.equal(refused.status, 400, `${JSON.stringify(bad)}: ${refused.text}`);
    }
  });

  await t.test('3. refused from any session not on the account\'s Orbit Cloud runner', async () => {
    const before = await prisma.ownerRequest.count({ where: { kind: 'BROWSER_SIGN_IN' } });
    const fromM = await fileSignIn(on, m.token, sm, { site: 'github.com', reason: REASON });
    assert.equal(fromM.status, 403, fromM.text);
    assert.equal((fromM.json as { code: string }).code, 'BROWSER_SIGN_IN_NOT_ORBIT_CLOUD');
    for (const [who, token, sessionId] of [
      ['B\'s runner naming B\'s session', n.token, sn],
      ['B\'s runner naming A\'s session on R', n.token, sr],
      ['R naming B\'s session', r.token, sn],
      ['R naming A\'s session on M', r.token, sm],
    ] as const) {
      const refused = await fileSignIn(on, token, sessionId, { site: 'github.com', reason: REASON });
      assert.equal(refused.status, 403, `${who}: ${refused.text}`);
    }
    // request_owner_action's door does not file the kind.
    const generic = await call(on, 'POST', '/api/runner/owner-requests', r.token,
      { kind: 'BROWSER_SIGN_IN', title: 'Sign in to github.com', why: REASON }, runnerHeaders(r.token, sr));
    assert.equal(generic.status, 400, generic.text);
    assert.match(generic.text, /filed with browser_request_sign_in/);
    assert.equal(await prisma.ownerRequest.count({ where: { kind: 'BROWSER_SIGN_IN' } }), before, 'a refusal filed a card');
  });

  await t.test('4. the waiting call reads PENDING until the owner answers; the answer is not also a turn', async () => {
    const pending = await readCard(on, first);
    assert.equal(pending.status, 200, pending.text);
    assert.equal((pending.json as { state: string }).state, 'PENDING');

    const notNow = await call(on, 'POST', `/api/owner-requests/${first}/decline`, owner, { reason: 'Not now' }, { 'x-orbit-client': 'web/1' });
    assert.equal(notNow.status, 200, notNow.text);
    const declined = await readCard(on, first);
    assert.equal((declined.json as { state: string }).state, 'DECLINED');
    assert.equal((declined.json as { resolutionNote: string }).resolutionNote, 'Not now');
    assert.equal(await deliveries(toUuid(first)), 0, 'Not now queued a turn beside the call that waits for it');

    const second = await fileSignIn(on, r.token, sr, { site: 'github.com', reason: REASON });
    assert.equal(second.status, 201, second.text);
    const id = (second.json as { id: string }).id;
    const done = await call(on, 'POST', `/api/owner-requests/${id}/done`, owner, {}, { 'x-orbit-client': 'web/1' });
    assert.equal(done.status, 200, done.text);
    assert.equal(((await readCard(on, id)).json as { state: string }).state, 'DONE');
    assert.equal(await deliveries(toUuid(id)), 0, 'signed in queued a turn beside the call that waits for it');
  });
});
