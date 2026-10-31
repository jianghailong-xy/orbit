/**
 * RUNNER_LINK_REQUIRED (runner-link-required.ts) held against the production apiserver — `build/main.js`, the whole
 * AppModule, two replicas run as child processes over one real PostgreSQL that `scripts/run-pg-spec.sh` migrates from
 * empty — with the plain HTTP requests curl, a runner and the link gateway send:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-link-required.pg.spec.ts
 *
 *   1. 0446 made the one table it describes.
 *   2. Never switched, it reads off on the administrators' route and on the gateway's, and every one of
 *      RunnerApiController's 53 routes serves an HTTPS call as it always has: none answers 426.
 *   3. Only a signed-in administrator reads or switches it: not a member, not an access token, not the gateway's secret,
 *      not anybody unsigned; a body that is not a boolean is refused, and turning it off while it is off writes nothing.
 *   4. Switched on — on the replica that took the PUT at once, on the other within a second — each of the 48 daemon
 *      routes, read off the controller, answers an HTTPS call that names no caller 426 UPGRADE_REQUIRED, saying why and
 *      to run `orbit upgrade`. A token the runner guard refuses is still answered 401. Asking for it again writes nothing.
 *   5. Switched on, what is never refused: the 5 routes kept on HTTPS (registration, the device flow, the attachments,
 *      D14); the shared routes as `orbit mcp`, the Antigravity hook and the CLI call them, naming themselves; a link call
 *      through the internal listener; and the other controllers under /runner (the agent tool API, the link token, the
 *      release check, the welcome route).
 *   6. The gateway's route answers the switch to the gateway's secret only.
 *   7. The switch's row cannot be read: both replicas keep answering 426, and the gateway's route answers an error,
 *      never off.
 *   8. Switched off again: each daemon route serves HTTPS again on both replicas, and the gateway's route says off.
 *
 * Not destructive: every row belongs to accounts this run creates, and the switch is left off.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from './runner-api.controller';
import { RUNNER_LINK_SWITCH_TTL_MS, staysOnHttps } from './runner-link-required';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const GATEWAY_TOKEN = `runner-link-required-gateway-${randomUUID()}`;
const CALLERS = ['mcp', 'antigravity-hook', 'cli'];
/** The routes that long-poll over HTTPS while nothing waits for the runner: served, they answer after 25 s. */
const LONG_POLLS = new Set(['GET /runner/sessions/claim', 'GET /runner/wake']);
/** How long another replica may go on answering by the state it read before (the TTL, and room for a loaded host). */
const OTHER_REPLICA_MS = RUNNER_LINK_SWITCH_TTL_MS + 2_000;

interface Answer {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  text: string;
  /** No answer within the wait: the route's handler is still at work (a long poll). */
  waited: boolean;
}

/** One request on a connection of its own; with no answer within `waitMs` it is dropped and answered `waited`. */
function send(
  port: number,
  method: string,
  route: string,
  headers: Record<string, string>,
  body?: unknown,
  waitMs = 30_000,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: route, agent: false,
      headers: {
        ...headers,
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
      },
    }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => parts.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(parts).toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, json, text, waited: false });
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      resolve({ status: 0, json: null, text: '', waited: true });
    }, waitMs);
    req.on('error', (error) => {
      clearTimeout(timer);
      if (!req.destroyed || (error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** RunnerApiController's routes as Nest mounts them, read off the controller: a route added to it is driven here too. */
const ROUTES = Object.getOwnPropertyNames(RunnerApiController.prototype).flatMap((name) => {
  const handler = Object.getOwnPropertyDescriptor(RunnerApiController.prototype, name)?.value as object | undefined;
  if (name === 'constructor' || typeof handler !== 'function') return [];
  const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
  if (method === undefined) return [];
  const sub = String(Reflect.getMetadata(PATH_METADATA, handler));
  return [{ route: `${RequestMethod[method]} /runner/${sub}`, method: RequestMethod[method], sub, kept: staysOnHttps(handler) }];
});
const DAEMON_ROUTES = ROUTES.filter((r) => !r.kept);

/** A route's path under /api with every parameter filled by an id that names nothing. */
const pathOf = (sub: string) => `/api/runner/${sub.replace(/:[A-Za-z]+/g, () => randomUUID())}`;

test('RUNNER_LINK_REQUIRED: the daemon routes refuse HTTPS while it is on, and serve it again once it is off', {
  skip: !URL_, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  const servers: Apiserver[] = [];
  t.after(async () => {
    await sql.query(`ALTER TABLE IF EXISTS "runner_link_switch_away" RENAME TO "runner_link_switch"`).catch(() => undefined);
    await sql.query(`UPDATE "runner_link_switch" SET "required" = false WHERE "id" = 1`).catch(() => undefined);
    for (const server of servers) await server.stop();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  assert.equal(ROUTES.length, 53, `RunnerApiController has ${ROUTES.length} routes; runner-link-required.spec.ts holds the census`);
  assert.equal(DAEMON_ROUTES.length, 48);

  // ── accounts, the machine, its checkout and a session on it ──────────────────────────────────────────────────────
  const account = async (name: string, role: 'ADMIN' | 'MEMBER') => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    const email = `${name}-${RUN}@runner-link-required.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5)`,
      [id, email, name, hashPassword(password), role]);
    return { id, email, password };
  };
  const admin = await account('admin', 'ADMIN');
  const owner = await account('owner', 'MEMBER');
  /** A runner of the owner's with a credential of its own; `deregister` takes one each time it is served. */
  const newRunner = async (name: string) => {
    const id = randomUUID();
    const token = `runner-link-required-${name}-${randomUUID()}`;
    await prisma.runner.create({
      data: { id, ownerId: owner.id, name: `${name} ${RUN}`, tokenHash: sha256(token), maxConcurrent: 8, status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
    });
    return { id, token };
  };
  const machine = await newRunner('machine');
  const workspaceId = randomUUID();
  await prisma.workspace.create({
    data: {
      id: workspaceId, ownerId: owner.id, runnerId: machine.id, name: 'the checkout', enabled: true,
      workDir: mkdtempSync(path.join(tmpdir(), 'runner-link-required-')),
    },
  });
  // RUNNING, not PENDING: a claim served in step 2 or 8 must find nothing to take.
  const sessionId = randomUUID();
  await prisma.session.create({
    data: {
      id: sessionId, ownerId: owner.id, creatorId: owner.id, workspaceId, assignedRunnerId: machine.id,
      title: 'a session the CLI resumes', prompt: 'the work', provider: 'claude', engine: 'claude',
      status: RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false,
      runtimeSessionId: randomUUID(),
    },
  });
  const attachment = await prisma.attachment.create({
    data: { ownerId: owner.id, sessionId, mimeType: 'image/png', sizeBytes: 4, data: Buffer.from('PNG!') },
  });

  // ── two replicas of the production apiserver, each with the link's internal listener ────────────────────────────
  const { privateKey } = generateKeyPairSync('ed25519');
  const signingKey = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64');
  const jwtSecret = `runner-link-required-${randomUUID()}`;
  const internal: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    internal.push(await freePort());
    servers.push(await startApiserver(url, jwtSecret, {
      RUNNER_LINK_SIGNING_KEY: signingKey,
      RUNNER_LINK_URL: 'wss://link.runner-link-required.invalid',
      RUNNER_LINK_GATEWAY_TOKEN: GATEWAY_TOKEN,
      RUNNER_LINK_INTERNAL_PORT: String(internal[i]),
      RUNNER_LINK_INTERNAL_HOST: '127.0.0.1',
    }));
  }
  const [a, b] = servers;
  const bearer = (token?: string | null): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await send(a.port, 'POST', '/api/auth/login', {}, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const adminToken = await signIn(admin);
  const ownerToken = await signIn(owner);
  // null is a request with no bearer at all.
  const read = (token: string | null = adminToken, server = a) =>
    send(server.port, 'GET', '/api/admin/runner-link-required', bearer(token));
  const switchTo = (required: unknown, token: string | null = adminToken, server = a) =>
    send(server.port, 'PUT', '/api/admin/runner-link-required', bearer(token), { required });
  const gatewayRead = (token: string | null = GATEWAY_TOKEN, server = a) =>
    send(server.port, 'GET', '/api/runner/link/mode', bearer(token));

  /** One HTTPS call of a route, as the daemon makes it: the runner's token, no caller named. */
  const daemonCall = async (server: Apiserver, route: (typeof ROUTES)[number], headers: Record<string, string> = {}, waitMs = 30_000) => {
    const token = route.route === 'POST /runner/deregister' ? (await newRunner('deregistered')).token : machine.token;
    return send(server.port, route.method, pathOf(route.sub), { ...bearer(token), ...headers }, route.method === 'GET' ? undefined : {}, waitMs);
  };
  const isUpgradeRequired = (reply: Answer) =>
    reply.status === 426 && reply.json?.code === 'UPGRADE_REQUIRED' && /Run `orbit upgrade`/.test(reply.json?.message ?? '');
  /** Every route served as before: an answer that is not the switch's, or a long poll still waiting. */
  const assertServedAsBefore = async (server: Apiserver, label: string) => {
    for (const route of ROUTES) {
      const longPoll = LONG_POLLS.has(route.route);
      const reply = await daemonCall(server, route, {}, longPoll ? 3_000 : 30_000);
      assert.ok(longPoll ? reply.waited || reply.status !== 426 : !reply.waited, `${label}: ${route.route} gave no answer`);
      assert.notEqual(reply.status, 426, `${label}: ${route.route} answered ${reply.text}`);
      assert.notEqual(reply.json?.code, 'UPGRADE_REQUIRED', `${label}: ${route.route}`);
    }
  };
  /** The first moment `server` answers `route` as `refused` says, polled every 100 ms; its delay in ms. */
  const until = async (server: Apiserver, refused: boolean, boundMs: number): Promise<number> => {
    const started = Date.now();
    const me = ROUTES.find((r) => r.route === 'GET /runner/me')!;
    for (;;) {
      const reply = await daemonCall(server, me);
      if (isUpgradeRequired(reply) === refused) return Date.now() - started;
      assert.ok(Date.now() - started < boundMs, `replica on ${server.port} still answers ${reply.status} after ${boundMs} ms`);
      await sleep(100);
    }
  };

  await t.test('(1) 0446 made the one table it describes', async () => {
    const applied = await sql.query(`SELECT finished_at IS NOT NULL AS done FROM _prisma_migrations WHERE migration_name = '0446_runner_link_switch'`);
    assert.deepEqual(applied.rows, [{ done: true }]);
    const columns = await sql.query(
      `SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'runner_link_switch' ORDER BY ordinal_position`,
    );
    assert.deepEqual(columns.rows.map((c) => `${c.column_name} ${c.udt_name} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`), [
      'id int2 NOT NULL',
      'required bool NOT NULL',
      'updated_at timestamptz NOT NULL',
      'updated_by_id uuid NULL',
    ]);
    const constraints = await sql.query(
      `SELECT conname, contype FROM pg_constraint WHERE conrelid = 'runner_link_switch'::regclass ORDER BY conname`,
    );
    assert.deepEqual(constraints.rows.map((c) => `${c.conname} ${c.contype}`), [
      'runner_link_switch_one_row_chk c',
      'runner_link_switch_pkey p',
    ], 'one row, and no foreign key: deleting the administrator writes nothing here');
    const triggers = await sql.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'runner_link_switch'::regclass AND NOT tgisinternal`);
    assert.deepEqual(triggers.rows, []);
    await assert.rejects(sql.query(`INSERT INTO "runner_link_switch" ("id", "required") VALUES (2, true)`), /runner_link_switch_one_row_chk/);
    assert.equal((await sql.query(`SELECT count(*)::int AS n FROM "runner_link_switch"`)).rows[0].n, 0);
  });

  await t.test('(2) never switched, it reads off, and every route of the controller serves HTTPS as before', async () => {
    const off = await read();
    assert.equal(off.status, 200, off.text);
    assert.deepEqual([off.json.required, off.json.updatedAt, off.json.updatedById], [false, null, null]);
    const door = await gatewayRead();
    assert.deepEqual([door.status, door.json], [200, { required: false }]);
    for (const server of servers) await assertServedAsBefore(server, `never switched, replica ${server.port}`);
  });

  await t.test('(3) only a signed-in administrator reads or switches it, with a boolean', async () => {
    for (const token of [null, GATEWAY_TOKEN, machine.token]) {
      assert.equal((await read(token)).status, 401);
      assert.equal((await switchTo(true, token)).status, 401);
    }
    assert.equal((await read(ownerToken)).status, 403, 'a member read it');
    assert.equal((await switchTo(true, ownerToken)).status, 403, 'a member switched it');
    const issued = await send(a.port, 'POST', '/api/access-tokens', bearer(adminToken),
      { name: `runner link required ${RUN}`, scopes: ['tasks:read'], expiresInDays: 30 });
    assert.equal(issued.status, 201, issued.text);
    for (const reply of [await read(issued.json.token), await switchTo(true, issued.json.token)]) {
      assert.equal(reply.status, 403, reply.text);
      assert.deepEqual([reply.json.code, reply.json.reason], ['PAT_FORBIDDEN', 'ADMIN'], reply.text);
    }
    for (const body of [{}, { required: 'true' }, { required: 1 }, { required: null }]) {
      const refused = await send(a.port, 'PUT', '/api/admin/runner-link-required', bearer(adminToken), body);
      assert.equal(refused.status, 400, `${JSON.stringify(body)} answered ${refused.status}: ${refused.text}`);
    }
    const stillOff = await switchTo(false);
    assert.equal(stillOff.status, 200, stillOff.text);
    assert.deepEqual([stillOff.json.required, stillOff.json.updatedAt], [false, null]);
    assert.equal((await sql.query(`SELECT count(*)::int AS n FROM "runner_link_switch"`)).rows[0].n, 0,
      'turning off a switch that is off wrote a row');
  });

  let switchedAt = '';
  await t.test('(4) switched on, each daemon route answers HTTPS 426 UPGRADE_REQUIRED, at once here and within a second there', async () => {
    const on = await switchTo(true);
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.required, true);
    assert.equal(toUuid(on.json.updatedById), admin.id);
    switchedAt = on.json.updatedAt;
    assert.ok(switchedAt);
    // The replica that took the PUT: its very next call, with no wait.
    const me = await daemonCall(a, ROUTES.find((r) => r.route === 'GET /runner/me')!);
    assert.ok(isUpgradeRequired(me), `the replica that switched it served ${me.status} ${me.text}`);
    assert.equal(me.json.retryable, false);
    assert.match(me.json.message, /RUNNER_LINK_REQUIRED is on/);
    // The other one: within its interval.
    const lag = await until(b, true, OTHER_REPLICA_MS);
    t.diagnostic(`the other replica refused HTTPS ${lag} ms after the switch`);

    for (const server of servers) {
      for (const route of DAEMON_ROUTES) {
        const reply = await daemonCall(server, route);
        assert.ok(isUpgradeRequired(reply), `replica ${server.port}: ${route.route} answered ${reply.status} ${reply.text}`);
      }
    }
    // The runner guard first: a token it refuses is answered as before.
    const stranger = await send(a.port, 'GET', '/api/runner/me', bearer('not-a-runner-token'));
    assert.equal(stranger.status, 401, stranger.text);
    // Asked for again, it writes nothing: it was switched when it was switched.
    const again = await switchTo(true, adminToken, b);
    assert.deepEqual([again.status, again.json.required, again.json.updatedAt], [200, true, switchedAt]);
  });

  await t.test('(5) switched on, what is never refused', async () => {
    // The routes kept on HTTPS, each served: registration and the device flow end to end, the attachments.
    const enrollment = await send(a.port, 'POST', '/api/runners/enrollment-tokens', bearer(ownerToken), { label: `kept ${RUN}` });
    assert.equal(enrollment.status, 201, enrollment.text);
    const registered = await send(a.port, 'POST', '/api/runner/register', {},
      { enrollmentToken: enrollment.json.token, name: `registered while required ${RUN}`, hostname: 'kept', version: '0.1.240' });
    assert.equal(registered.status, 201, registered.text);
    assert.ok(registered.json.runnerToken);
    const device = await send(a.port, 'POST', '/api/runner/device/start', {}, { name: `device ${RUN}` });
    assert.equal(device.status, 201, device.text);
    const polled = await send(a.port, 'POST', '/api/runner/device/poll', {}, { deviceCode: device.json.deviceCode });
    assert.equal(polled.status, 200, polled.text);
    const image = await send(a.port, 'GET', `/api/runner/sessions/${uuidToBase62(sessionId)}/attachments/${uuidToBase62(attachment.id)}`, bearer(machine.token));
    assert.deepEqual([image.status, image.text], [200, 'PNG!'], 'the attachment, as its bytes');
    const upload = await send(a.port, 'POST', `/api/runner/sessions/${uuidToBase62(sessionId)}/attachments`, bearer(machine.token), {});
    assert.equal(upload.status, 400, `an upload with no file is the route's own refusal, not the switch's: ${upload.text}`);

    // The routes the daemon shares with processes that name themselves: served for them, refused for the daemon.
    const route = (rest: string) => `/api/runner/sessions/${uuidToBase62(sessionId)}/${rest}`;
    for (const caller of CALLERS) {
      const as = { ...bearer(machine.token), 'x-orbit-runner-caller': caller };
      const asked = await send(a.port, 'POST', route('approvals'), as, { toolName: 'Bash', input: { command: `echo ${caller}` }, toolUseId: `toolu_${caller}_${RUN}` });
      assert.equal(asked.status, 201, `${caller}: ${asked.text}`);
      assert.equal(asked.json.status, 'PENDING');
      await sql.query(`UPDATE "approval" SET "status" = 'ALLOWED', "decided_at" = now() WHERE "id" = $1::uuid`, [toUuid(asked.json.id)]);
      const decided = await send(a.port, 'GET', route(`approvals/${asked.json.id}`), as);
      assert.deepEqual([decided.status, decided.json.status, decided.json.behavior], [200, 'ALLOWED', 'allow'], `${caller}: ${decided.text}`);
      const me = await send(b.port, 'GET', '/api/runner/me', as);
      assert.equal(me.status, 200, `${caller}: ${me.text}`);
      const meta = await send(b.port, 'GET', route('meta'), as);
      assert.deepEqual([meta.status, meta.json.engine], [200, 'claude'], `${caller}: ${meta.text}`);
      const unmarked = await send(a.port, 'POST', route('approvals'), bearer(machine.token), { toolName: 'Bash', input: {}, toolUseId: `toolu_daemon_${RUN}` });
      assert.ok(isUpgradeRequired(unmarked), `the same route called as the daemon: ${unmarked.status}`);
    }
    const leaving = await newRunner('leaving');
    const deregistered = await send(a.port, 'POST', '/api/runner/deregister', { ...bearer(leaving.token), 'x-orbit-runner-caller': 'cli' });
    assert.ok(deregistered.status >= 200 && deregistered.status < 300, deregistered.text);
    assert.equal((await sql.query(`SELECT count(*)::int AS n FROM "runner" WHERE "id" = $1::uuid`, [leaving.id])).rows[0].n, 0,
      '`orbit deregister` removed its runner');

    // The link itself: a call the gateway forwards through the internal listener, with the runner's link token.
    const leaseOwner = randomUUID();
    const minted = await send(a.port, 'POST', '/api/runner/link-token', bearer(machine.token), { leaseOwner });
    assert.equal(minted.status, 200, `the link token is minted over HTTPS: ${minted.text}`);
    for (const [i, port] of internal.entries()) {
      const link = { authorization: `Bearer ${GATEWAY_TOKEN}`, 'x-orbit-runner-link-token': minted.json.token, 'x-orbit-link-request-id': `r:${leaseOwner}:${i}` };
      const me = await send(port, 'GET', '/api/runner/me', link);
      assert.equal(me.status, 200, `a link call to replica ${i}: ${me.text}`);
      const beat = await send(port, 'POST', '/api/runner/heartbeat', link, { leaseOwner, status: 'ONLINE' });
      assert.ok(beat.status === 200 || beat.status === 201, `a link heartbeat to replica ${i}: ${beat.text}`);
      const claim = await send(port, 'GET', '/api/runner/sessions/claim', { ...link, 'x-orbit-link-request-id': `r:${leaseOwner}:claim${i}` }, undefined, 10_000);
      assert.ok(!claim.waited && claim.status === 200, `a link claim answers at once: ${claim.status} ${claim.text}`);
    }

    // The other controllers under /runner: the agent tool API, the release check, the welcome route.
    const providers = await send(a.port, 'GET', '/api/runner/providers', bearer(machine.token));
    assert.equal(providers.status, 200, providers.text);
    const release = await send(a.port, 'GET', '/api/runner/release?latest=0.1.240', bearer(machine.token));
    assert.equal(release.status, 200, release.text);
    const welcome = await send(a.port, 'POST', '/api/runner/link/welcome', bearer(machine.token), { sessionIds: [sessionId], leaseOwner });
    assert.equal(welcome.status, 200, welcome.text);
    assert.equal(welcome.json.sessions.length, 1);
  });

  await t.test('(6) the gateway reads the switch with its own secret, and nobody else does', async () => {
    for (const server of servers) {
      const door = await gatewayRead(GATEWAY_TOKEN, server);
      assert.deepEqual([door.status, door.json], [200, { required: true }], door.text);
    }
    for (const token of [null, 'not-the-secret', machine.token, adminToken]) {
      const refused = await gatewayRead(token);
      assert.equal(refused.status, 401, `${token ? 'a wrong bearer' : 'no bearer'}: ${refused.text}`);
      assert.equal(refused.json.code, 'RUNNER_LINK_GATEWAY_UNAUTHORIZED');
    }
  });

  await t.test('(7) a switch that cannot be read switches nothing: 426 on both replicas, and an error to the gateway', async () => {
    await sql.query(`ALTER TABLE "runner_link_switch" RENAME TO "runner_link_switch_away"`);
    try {
      const me = ROUTES.find((r) => r.route === 'GET /runner/me')!;
      // Two rounds more than an interval apart: each replica has tried to read it again, and failed.
      for (let round = 0; round < 2; round += 1) {
        await sleep(RUNNER_LINK_SWITCH_TTL_MS + 200);
        for (const server of servers) {
          const reply = await daemonCall(server, me);
          assert.ok(isUpgradeRequired(reply), `round ${round}, replica ${server.port}: ${reply.status} ${reply.text}`);
        }
      }
      for (const server of servers) {
        const door = await gatewayRead(GATEWAY_TOKEN, server);
        assert.ok(door.status >= 500, `the gateway was answered ${door.status} ${door.text}, not an error`);
        assert.notDeepEqual(door.json, { required: false });
        assert.match(server.output(), /RUNNER_LINK_REQUIRED could not be read; this replica keeps answering as it last read it \(on\)/);
      }
    } finally {
      await sql.query(`ALTER TABLE "runner_link_switch_away" RENAME TO "runner_link_switch"`);
    }
    const door = await gatewayRead();
    assert.deepEqual([door.status, door.json], [200, { required: true }], door.text);
  });

  await t.test('(8) switched off again, each daemon route serves HTTPS again on both replicas', async () => {
    const off = await switchTo(false, adminToken, b);
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.required, false);
    assert.notEqual(off.json.updatedAt, switchedAt);
    const lag = await until(a, false, OTHER_REPLICA_MS);
    t.diagnostic(`the other replica served HTTPS again ${lag} ms after the switch`);
    for (const server of servers) await assertServedAsBefore(server, `switched off again, replica ${server.port}`);
    for (const server of servers) {
      const door = await gatewayRead(GATEWAY_TOKEN, server);
      assert.deepEqual([door.status, door.json], [200, { required: false }]);
    }
    const unmarked = await send(a.port, 'GET', `/api/runner/sessions/${uuidToBase62(sessionId)}/meta`, bearer(machine.token));
    assert.equal(unmarked.status, 200, `the daemon's own call is served again: ${unmarked.text}`);
  });
});
