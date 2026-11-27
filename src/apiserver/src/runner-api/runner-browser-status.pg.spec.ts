/**
 * browser_status and `orbit browser status` (runner-api/runner-browser.controller.ts; board
 * docs/mocks/runner-browser/03-agent-tools.html ②): `GET /api/runner/browser`, on the production apiserver —
 * `build/main.js`, the whole AppModule, run as a child process — over a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty. The spec plays the managed runner's instance on POST /api/runner/heartbeat, as the browser
 * state spec does, and the runners' `orbit mcp` on the status route, with the runner token and X-Orbit-Session-Id.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-browser-status.pg.spec.ts
 *
 * Account A owns a managed runner R with a session SR on it, and a self-managed runner M with a session SM on it.
 * Account B is a stranger with a self-managed runner N and a session SN on it.
 *
 *   1. With the browser switch off (managed runners on), the route is 404 to A's session, as a path the apiserver does
 *      not have. (What a claim says of the switch is browserClaimFields, managed-runner-browser-gate.spec.ts.)
 *   2. With it on, the route answers A's sessions, on R and on M alike (Q3 = A): UNKNOWN
 *      before any report, then, once R's beat reports the browser, running, the session holding the lease, the viewers
 *      and whether saved logins exist — exactly those fields, and nothing that names a site even when the beat sends
 *      one.
 *   3. Another account's session is refused (P4 = A): B's runner naming A's session is 403, A's runner naming B's session
 *      is 403, no session is 400, no runner token is 401; B's own session reads B's account, which has no Orbit Cloud
 *      runner, and so nothing of A's.
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
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
// The heartbeat is called over plain HTTP, as the link gateway's forwarded call reaches the same handler.
import '../test-support/daemon-routes-over-http';
import { turnStateOfWord } from '../sessions/session-turn-state';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const INSTANCE_CAPABILITY = 'managed-runner-instance-v1';
const BROWSER_CLEAR = 'browser-clear/v1';
const STATUS_FIELDS = ['enabled', 'runnerId', 'state', 'running', 'holderSessionId', 'holderTitle', 'viewers', 'savedLogins', 'reportedAt'];
/** The answer's fields, less the second spelling every public id goes out in (`runnerPublicId`, main.ts). */
const fieldsOf = (answer: Record<string, unknown>) => Object.keys(answer).filter((k) => !k.endsWith('PublicId')).sort();

test('browser_status: the account\'s Orbit Cloud browser for any session of it, another account\'s refused, absent when off', {
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
    const user = { id: randomUUID(), email: `${name}-${RUN}@browser-status.invalid`, password: `pw-${name}-${RUN}` };
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [user.id, user.email, name, hashPassword(user.password)]);
    return user;
  };
  const a = await account('owner');
  const b = await account('stranger');
  const runner = async (ownerId: string, name: string) => {
    const id = randomUUID();
    const token = `browser-status-${name}-${randomUUID()}`;
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
      ownerId: a.id, runnerId: r.id, clusterKey: 'browser-status-spec', namespace: 'orbit', pvcName: `mr-data-${r.id}`,
      desiredState: 'SLEEPING', managementState: 'SLEEPING', generation: 1, podUid,
    },
  });
  await prisma.runner.update({ where: { id: r.id }, data: { capabilities: [INSTANCE_CAPABILITY, BROWSER_CLEAR] } });
  const sr = await session(a.id, r.id, 'a session on the Orbit Cloud runner');
  const sm = await session(a.id, m.id, 'a session on a machine of the owner');
  const sn = await session(b.id, n.id, 'the stranger\'s session');

  const JWT_SECRET = `browser-status-${randomUUID()}`;
  const boot = async (browser: string) => {
    const server = await startApiserver(url, JWT_SECRET, {
      ORBIT_MANAGED_RUNNERS_ENABLED: 'true', ORBIT_MANAGED_RUNNERS_PROFILE: '', ORBIT_MANAGED_RUNNER_BROWSER_ENABLED: browser,
    });
    servers.push(server);
    return server;
  };
  /** R's own credential is a managed runner's: its calls name the instance, as `orbit mcp` in R's Pod does. */
  const instance = () => ({
    'x-orbit-runner-capabilities': `${INSTANCE_CAPABILITY},${BROWSER_CLEAR}`,
    'x-orbit-cloud-runner-generation': '1',
    'x-orbit-cloud-runner-pod-uid': podUid,
  });
  const status = (server: Apiserver, runnerToken: string | undefined, sessionId?: string) =>
    call(server, 'GET', '/api/runner/browser', runnerToken, undefined, {
      ...(runnerToken === r.token ? instance() : {}),
      ...(sessionId ? { 'x-orbit-session-id': sessionId } : {}),
    });
  const beat = async (server: Apiserver, body: object) => {
    const reply = await call(server, 'POST', '/api/runner/heartbeat', r.token, { version: '0.1.0', ...body }, instance());
    assert.equal(reply.status, 201, `R's heartbeat: ${reply.text}`);
  };
  await t.test('1. with the browser switch off, the route is absent', async () => {
    const off = await boot('');
    const read = await status(off, r.token, sr);
    assert.equal(read.status, 404, read.text);
    assert.match(read.text, /Cannot GET \/api\/runner\/browser/);
    await off.stop();
  });

  const on = await boot('true');

  await t.test('2. on: any session of the account reads the fields', async () => {
    for (const [who, token, sessionId] of [['SR on R', r.token, sr], ['SM on M', m.token, sm]] as const) {
      const before = await status(on, token, sessionId);
      assert.equal(before.status, 200, `${who}: ${before.text}`);
      assert.deepEqual(fieldsOf(before.json), [...STATUS_FIELDS].sort(), who);
      assert.equal(before.json.enabled, true);
      assert.equal(before.json.state, 'UNKNOWN');
      assert.equal(before.json.running, false);
      assert.equal(before.json.holderSessionId, null);
      assert.equal(before.json.viewers, 0);
      assert.equal(before.json.savedLogins, null);
    }

    await beat(on, {
      browser: {
        running: true, holderSessionId: 'sess-holder-1', holderTitle: 'Export the monthly report', viewers: 2, savedLogins: true,
        // What no runner sends, and nothing may keep or answer: the sites behind the saved logins.
        sites: ['github.com'], cookies: [{ name: 'user_session', domain: 'github.com' }],
      },
    });
    for (const [who, token, sessionId] of [['SR on R', r.token, sr], ['SM on M', m.token, sm]] as const) {
      const held = await status(on, token, sessionId);
      assert.equal(held.status, 200, `${who}: ${held.text}`);
      assert.deepEqual(fieldsOf(held.json), [...STATUS_FIELDS].sort(), who);
      assert.equal(held.json.enabled, true);
      assert.equal(toUuid(held.json.runnerId as string), r.id, 'the account\'s Orbit Cloud runner');
      assert.equal(held.json.state, 'RUNNING');
      assert.equal(held.json.running, true);
      assert.equal(held.json.holderSessionId, 'sess-holder-1');
      assert.equal(held.json.holderTitle, 'Export the monthly report');
      assert.equal(held.json.viewers, 2);
      assert.equal(held.json.savedLogins, true);
      assert.ok(held.json.reportedAt, 'reportedAt');
      assert.doesNotMatch(held.text, /github\.com|user_session/, `${who}: the answer names a site`);
    }
    const stored = await prisma.runner.findUniqueOrThrow({ where: { id: r.id }, select: { browserState: true } });
    assert.doesNotMatch(JSON.stringify(stored.browserState), /github\.com|user_session/, 'the row keeps a site');

    await beat(on, { browser: { running: false, viewers: 0, savedLogins: false } });
    const idle = await status(on, r.token, sr);
    assert.equal(idle.json.state, 'IDLE');
    assert.equal(idle.json.running, false);
    assert.equal(idle.json.holderSessionId, null);
    assert.equal(idle.json.savedLogins, false);
  });

  await t.test('3. another account\'s session is refused, and a stranger reads only their own account', async () => {
    for (const [who, token, sessionId, code] of [
      ['B\'s runner naming A\'s session on R', n.token, sr, 403],
      ['B\'s runner naming A\'s session on M', n.token, sm, 403],
      ['A\'s runner naming B\'s session', r.token, sn, 403],
      ['A\'s managed runner naming A\'s session on M', r.token, sm, 403],
      ['a session id that is not one', r.token, 'not-a-session', 403],
      ['no session', r.token, undefined, 400],
      ['no runner token', undefined, sr, 401],
    ] as const) {
      const read = await status(on, token, sessionId);
      assert.equal(read.status, code, `${who}: ${read.text}`);
      assert.doesNotMatch(read.text, /sess-holder-1|Export the monthly report/, `${who}: the refusal says something of A's browser`);
    }
    const own = await status(on, n.token, sn);
    assert.equal(own.status, 200, own.text);
    assert.equal(own.json.runnerId, null, 'B has no Orbit Cloud runner');
    assert.equal(own.json.state, 'UNKNOWN');
    assert.equal(own.json.holderSessionId, null);
    assert.equal(own.json.savedLogins, null);
  });
});
