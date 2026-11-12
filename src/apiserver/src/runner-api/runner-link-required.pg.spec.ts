/**
 * The HTTPS door of RunnerApiController (runner-link-required.ts) held against the production apiserver — `build/main.js`,
 * the whole AppModule, over one real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty — with the plain HTTP
 * requests curl, a runner and the link gateway send:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-link-required.pg.spec.ts
 *
 *   1. Nothing switches it: the administrators' route is gone, and what 0446 made is still there for a server rolled back
 *      to a build that reads it, holding what it held.
 *   2. Each of the 50 daemon routes, read off the controller, answers an HTTPS call that names no caller 426
 *      UPGRADE_REQUIRED, saying to run `orbit upgrade`, with no row in the switch's table and with one that says off, and
 *      the 42 no other process calls answer the same to a call that names one. A token the runner guard refuses is still
 *      answered 401.
 *   3. A runner of 0.1.246 as it starts: its wake is 426 on HTTPS and over the link, never the 404 that ends its wake loop;
 *      `/complete` is gone on both doors, and its calls on the link are served.
 *   4. What is never refused: the 7 routes kept on HTTPS (registration, the device flow, the attachments and the file
 *      upload, D14, and the Claude region check); the 8 routes `orbit mcp`, the Antigravity hook and the CLI share, naming
 *      themselves; a link call through the internal listener; and the other controllers under /runner (the agent tool
 *      API, the link token, the release check, the welcome route).
 *   5. The gateway's route says required, to the gateway's secret only, whatever the switch's row says.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

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
import { calledByNamedCallers, staysOnHttps } from './runner-link-required';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const GATEWAY_TOKEN = `runner-link-required-gateway-${randomUUID()}`;
const CALLERS = ['mcp', 'antigravity-hook', 'cli'];

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
  return [{ route: `${RequestMethod[method]} /runner/${sub}`, method: RequestMethod[method], sub, kept: staysOnHttps(handler), named: calledByNamedCallers(handler) }];
});
const DAEMON_ROUTES = ROUTES.filter((r) => !r.kept);

/** A route's path under /api with every parameter filled by an id that names nothing. */
const pathOf = (sub: string) => `/api/runner/${sub.replace(/:[A-Za-z]+/g, () => randomUUID())}`;

test('the daemon routes refuse HTTPS, and serve the link and the callers that name themselves', {
  skip: !URL_, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await sql.query(`DELETE FROM "runner_link_switch" WHERE "id" = 1`).catch(() => undefined);
    await server?.stop();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  assert.equal(ROUTES.length, 57, `RunnerApiController has ${ROUTES.length} routes; runner-link-required.spec.ts holds the census`);
  assert.equal(DAEMON_ROUTES.length, 50);
  assert.equal(DAEMON_ROUTES.filter((r) => r.named).length, 8);

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
  // RUNNING, not PENDING: a claim must find nothing to take.
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

  // ── the production apiserver, with the link's internal listener ───────────────────────────────────────────────
  const { privateKey } = generateKeyPairSync('ed25519');
  const signingKey = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64');
  const internal = await freePort();
  server = await startApiserver(url, `runner-link-required-${randomUUID()}`, {
    RUNNER_LINK_SIGNING_KEY: signingKey,
    RUNNER_LINK_URL: 'wss://link.runner-link-required.invalid',
    RUNNER_LINK_GATEWAY_TOKEN: GATEWAY_TOKEN,
    RUNNER_LINK_INTERNAL_PORT: String(internal),
    RUNNER_LINK_INTERNAL_HOST: '127.0.0.1',
  });
  const a = server;
  const bearer = (token?: string | null): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await send(a.port, 'POST', '/api/auth/login', {}, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const adminToken = await signIn(admin);
  const ownerToken = await signIn(owner);
  // null is a request with no bearer at all.
  const gatewayRead = (token: string | null = GATEWAY_TOKEN) => send(a.port, 'GET', '/api/runner/link/mode', bearer(token));

  /** One HTTPS call of a route, as the daemon makes it: the runner's token, no caller named. */
  const daemonCall = async (route: (typeof ROUTES)[number], headers: Record<string, string> = {}) => {
    const token = route.route === 'POST /runner/deregister' ? (await newRunner('deregistered')).token : machine.token;
    return send(a.port, route.method, pathOf(route.sub), { ...bearer(token), ...headers }, route.method === 'GET' ? undefined : {});
  };
  const isUpgradeRequired = (reply: Answer) =>
    reply.status === 426 && reply.json?.code === 'UPGRADE_REQUIRED' && /Run `orbit upgrade`/.test(reply.json?.message ?? '');

  // The link token the gateway presents for this runner, on every call it forwards through the internal listener.
  const leaseOwner = randomUUID();
  const minted = await send(a.port, 'POST', '/api/runner/link-token', bearer(machine.token), { leaseOwner });
  assert.equal(minted.status, 200, `the link token is minted over HTTPS: ${minted.text}`);
  const linkHeaders = (request: string) => ({
    authorization: `Bearer ${GATEWAY_TOKEN}`, 'x-orbit-runner-link-token': minted.json.token, 'x-orbit-link-request-id': `r:${leaseOwner}:${request}`,
  });

  await t.test('(1) nothing switches it, and what 0446 made stays for a server rolled back to a build that reads it', async () => {
    for (const method of ['GET', 'PUT']) {
      const gone = await send(a.port, method, '/api/admin/runner-link-required', bearer(adminToken), method === 'PUT' ? { required: false } : undefined);
      assert.equal(gone.status, 404, `${method} answered ${gone.status}: ${gone.text}`);
    }
    const applied = await sql.query(`SELECT finished_at IS NOT NULL AS done FROM _prisma_migrations WHERE migration_name = '0446_runner_link_switch'`);
    assert.deepEqual(applied.rows, [{ done: true }]);
    const columns = await sql.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'runner_link_switch' ORDER BY ordinal_position`,
    );
    assert.deepEqual(columns.rows.map((c) => c.column_name), ['id', 'required', 'updated_at', 'updated_by_id']);
    assert.equal((await sql.query(`SELECT count(*)::int AS n FROM "runner_link_switch"`)).rows[0].n, 0, 'nothing wrote it');
  });

  await t.test('(2) each daemon route answers HTTPS 426 UPGRADE_REQUIRED, whatever the switch\'s row says', async () => {
    for (const row of ['no row', 'a row that says off']) {
      if (row === 'a row that says off') {
        await sql.query(`INSERT INTO "runner_link_switch" ("id", "required", "updated_at") VALUES (1, false, now())`);
      }
      for (const route of DAEMON_ROUTES) {
        const reply = await daemonCall(route);
        assert.ok(isUpgradeRequired(reply), `${row}: ${route.route} answered ${reply.status} ${reply.text}`);
        assert.equal(reply.json.retryable, false);
      }
    }
    await sql.query(`DELETE FROM "runner_link_switch" WHERE "id" = 1`);
    // Naming a caller changes nothing on a route no other process calls.
    for (const route of DAEMON_ROUTES.filter((r) => !r.named)) {
      const reply = await daemonCall(route, { 'x-orbit-runner-caller': 'mcp' });
      assert.ok(isUpgradeRequired(reply), `naming a caller: ${route.route} answered ${reply.status} ${reply.text}`);
    }
    // The runner guard first: a token it refuses is answered as before.
    const stranger = await send(a.port, 'GET', '/api/runner/me', bearer('not-a-runner-token'));
    assert.equal(stranger.status, 401, stranger.text);
  });

  await t.test('(3) a runner of 0.1.246 as it starts: its wake is 426 on both doors, and its link calls are served', async () => {
    const overHttps = await send(a.port, 'GET', '/api/runner/wake', bearer(machine.token));
    assert.ok(isUpgradeRequired(overHttps), `the wake over HTTPS: ${overHttps.status} ${overHttps.text}`);
    const overLink = await send(internal, 'GET', '/api/runner/wake', linkHeaders('wake'));
    assert.equal(overLink.status, 426, `the wake over the link: ${overLink.status} ${overLink.text}`);
    assert.equal(overLink.json.code, 'UPGRADE_REQUIRED', overLink.text);
    // What a process of that age sends: the write contract's three headers among those Hello declared.
    const declared = {
      'x-orbit-runner-capabilities': 'session-terminal-handoff-v1,source-pin/v1',
      'x-orbit-runner-capability-revision': '2', 'x-orbit-runner-schema-revision': '2',
      'x-orbit-runner-contract-digest': 'bbdd980c70dc56bfd09dfc311c41b3fdff8727912642ee4f529d8ddf36d3a696',
      'x-orbit-cli-version': '0.1.246',
    };
    const beat = await send(internal, 'POST', '/api/runner/heartbeat', { ...linkHeaders('beat'), ...declared }, { leaseOwner, status: 'ONLINE' });
    assert.ok(beat.status === 200 || beat.status === 201, `its heartbeat: ${beat.status} ${beat.text}`);
    const claim = await send(internal, 'GET', '/api/runner/sessions/claim', { ...linkHeaders('claim'), ...declared }, undefined, 10_000);
    assert.ok(!claim.waited && claim.status === 200, `its claim answers at once: ${claim.status} ${claim.text}`);
    const fetched = await send(internal, 'GET', `/api/runner/sessions/${sessionId}/inbox?acceptsSteer=1&leaseGeneration=${randomUUID()}`, { ...linkHeaders('inbox'), ...declared });
    assert.equal(fetched.status, 409, `an inbox fetch under a generation that is not current: ${fetched.text}`);
    // /finalize answers it, so it never falls back to /complete, which is gone on both doors.
    for (const [port, headers] of [[a.port, bearer(machine.token)], [internal, linkHeaders('complete')]] as const) {
      const complete = await send(port, 'POST', `/api/runner/sessions/${sessionId}/complete`, headers, {});
      assert.equal(complete.status, 404, `/complete: ${complete.status} ${complete.text}`);
    }
    // An inbox fetch with no generation is the old poll this server no longer serves.
    const noGeneration = await send(internal, 'GET', `/api/runner/sessions/${sessionId}/inbox?acceptsSteer=1`, linkHeaders('old-poll'));
    assert.equal(noGeneration.status, 400, noGeneration.text);
  });

  await t.test('(4) what is never refused', async () => {
    // The routes kept on HTTPS, each served: registration and the device flow end to end, the attachments.
    const enrollment = await send(a.port, 'POST', '/api/runners/enrollment-tokens', bearer(ownerToken), { label: `kept ${RUN}` });
    assert.equal(enrollment.status, 201, enrollment.text);
    const registered = await send(a.port, 'POST', '/api/runner/register', {},
      { enrollmentToken: enrollment.json.token, name: `registered ${RUN}`, hostname: 'kept', version: '0.1.240' });
    assert.equal(registered.status, 201, registered.text);
    assert.ok(registered.json.runnerToken);
    const device = await send(a.port, 'POST', '/api/runner/device/start', {}, { name: `device ${RUN}` });
    assert.equal(device.status, 201, device.text);
    const polled = await send(a.port, 'POST', '/api/runner/device/poll', {}, { deviceCode: device.json.deviceCode });
    assert.equal(polled.status, 200, polled.text);
    const image = await send(a.port, 'GET', `/api/runner/sessions/${uuidToBase62(sessionId)}/attachments/${uuidToBase62(attachment.id)}`, bearer(machine.token));
    assert.deepEqual([image.status, image.text], [200, 'PNG!'], 'the attachment, as its bytes');
    const upload = await send(a.port, 'POST', `/api/runner/sessions/${uuidToBase62(sessionId)}/attachments`, bearer(machine.token), {});
    assert.equal(upload.status, 400, `an upload with no file is the route's own refusal: ${upload.text}`);
    const kept = await send(a.port, 'POST', `/api/runner/sessions/${uuidToBase62(sessionId)}/files`, bearer(machine.token), {});
    assert.equal(kept.status, 400, `a file_upload with no file is the route's own refusal: ${kept.text}`);
    // The Claude region check, which leaves through Claude's proxy and so never over the link: answered, and kept.
    const region = await send(a.port, 'GET', '/api/runner/region-check?viaProxy=1', bearer(machine.token));
    assert.equal(region.status, 200, region.text);
    assert.deepEqual({ verdict: region.json.verdict, viaProxy: region.json.viaProxy }, { verdict: 'unknown', viaProxy: true },
      'no proxy this deployment trusts passed it on, so where it came from is unknown');

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
      const me = await send(a.port, 'GET', '/api/runner/me', as);
      assert.equal(me.status, 200, `${caller}: ${me.text}`);
      const meta = await send(a.port, 'GET', route('meta'), as);
      assert.deepEqual([meta.status, meta.json.engine], [200, 'claude'], `${caller}: ${meta.text}`);
      const transcript = await send(a.port, 'GET', route('events?after=0&limit=5'), as);
      assert.equal(transcript.status, 200, `${caller}: ${transcript.text}`);
      // Their own refusals, not the door's: the wakeup and the credential are for a session this request does not prove.
      const wakeup = await send(a.port, 'POST', route('scheduled-wakeup'), as, {});
      assert.notEqual(wakeup.status, 426, `${caller}: ${wakeup.text}`);
      const credential = await send(a.port, 'POST', route('orchestration-credential'), as, {});
      assert.notEqual(credential.status, 426, `${caller}: ${credential.text}`);
      const unmarked = await send(a.port, 'POST', route('approvals'), bearer(machine.token), { toolName: 'Bash', input: {}, toolUseId: `toolu_daemon_${RUN}` });
      assert.ok(isUpgradeRequired(unmarked), `the same route called as the daemon: ${unmarked.status}`);
    }
    // `orbit mcp`'s read of an approval nobody decided is still held for it, over HTTPS: 25 s, then PENDING.
    const mcp = { ...bearer(machine.token), 'x-orbit-runner-caller': 'mcp' };
    const pending = await send(a.port, 'POST', route('approvals'), mcp, { toolName: 'Bash', input: { command: 'held' }, toolUseId: `toolu_held_${RUN}` });
    assert.equal(pending.status, 201, pending.text);
    const held = await send(a.port, 'GET', route(`approvals/${pending.json.id}`), mcp, undefined, 2_000);
    assert.equal(held.waited, true, `the read was answered at once: ${held.status} ${held.text}`);
    const leaving = await newRunner('leaving');
    const deregistered = await send(a.port, 'POST', '/api/runner/deregister', { ...bearer(leaving.token), 'x-orbit-runner-caller': 'cli' });
    assert.ok(deregistered.status >= 200 && deregistered.status < 300, deregistered.text);
    assert.equal((await sql.query(`SELECT count(*)::int AS n FROM "runner" WHERE "id" = $1::uuid`, [leaving.id])).rows[0].n, 0,
      '`orbit deregister` removed its runner');

    // The link itself: a call the gateway forwards through the internal listener, with the runner's link token.
    const me = await send(internal, 'GET', '/api/runner/me', linkHeaders('me'));
    assert.equal(me.status, 200, `a link call: ${me.text}`);

    // The other controllers under /runner: the agent tool API, the release check, the welcome route.
    const providers = await send(a.port, 'GET', '/api/runner/providers', bearer(machine.token));
    assert.equal(providers.status, 200, providers.text);
    const files = await send(a.port, 'GET', `/api/runner/files?sessionId=${uuidToBase62(sessionId)}`, bearer(machine.token));
    assert.equal(files.status, 200, files.text);
    const release = await send(a.port, 'GET', '/api/runner/release?latest=0.1.240', bearer(machine.token));
    assert.equal(release.status, 200, release.text);
    const welcome = await send(a.port, 'POST', '/api/runner/link/welcome', bearer(machine.token), { sessionIds: [sessionId], leaseOwner });
    assert.equal(welcome.status, 200, welcome.text);
    assert.equal(welcome.json.sessions.length, 1);
  });

  await t.test('(5) the gateway reads that the link is required, with its own secret, and nobody else does', async () => {
    const door = await gatewayRead();
    assert.deepEqual([door.status, door.json], [200, { required: true }], door.text);
    await sql.query(`INSERT INTO "runner_link_switch" ("id", "required", "updated_at") VALUES (1, false, now())`);
    const stillRequired = await gatewayRead();
    assert.deepEqual([stillRequired.status, stillRequired.json], [200, { required: true }], 'the row is not read');
    await sql.query(`DELETE FROM "runner_link_switch" WHERE "id" = 1`);
    for (const token of [null, 'not-the-secret', machine.token, adminToken]) {
      const refused = await gatewayRead(token);
      assert.equal(refused.status, 401, `${token ? 'a wrong bearer' : 'no bearer'}: ${refused.text}`);
      assert.equal(refused.json.code, 'RUNNER_LINK_GATEWAY_UNAUTHORIZED');
    }
  });
});
