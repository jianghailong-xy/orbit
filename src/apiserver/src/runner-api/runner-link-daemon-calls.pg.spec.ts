/**
 * The runner daemon's three calls that went beside the agent tool API until 2026-10-28 (docs/runner-link-design.md
 * §15.9) — a Cursor key check's answer, a session's own key check and a background job's alert — held against the
 * production apiserver: `build/main.js`, the whole AppModule, as a child process over one real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty, with the requests a runner, a person and the link gateway send.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-link-daemon-calls.pg.spec.ts
 *
 *   1. Never switched, over HTTPS as a runner has always sent them: the answer settles the check the owner waits on and
 *      is kept on the key, and a session's own key check is kept on the key.
 *   2. The same for the alert, on the daemon's own route: answered by the push channel exactly as the agents' door
 *      (POST /runner/notify) answers the same alert, and refused for another machine's session.
 *   3. Over the link — the internal listener, the gateway's secret and the runner's link token — the same three calls
 *      are served and take effect the same way, where the two Cursor calls were refused 404
 *      RUNNER_LINK_ROUTE_NOT_ON_LINK before; the agent tool API beside them still is.
 *   4. Switched on, the three answer an HTTPS call 426 UPGRADE_REQUIRED and change nothing, over the link they are
 *      served and take effect, and the agents' door is still served to `orbit mcp` over HTTPS.
 *
 * Not destructive: every row belongs to accounts this run creates, and the switch is left off.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { CURSOR_KEY_CHECK_V1 } from '../providers/cursor-key-check-relay';

const URL_ = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'runner-link-daemon-calls-pg-spec';
const RUN = randomUUID().slice(0, 8);
const GATEWAY_TOKEN = `runner-link-daemon-calls-gateway-${randomUUID()}`;

/** Cursor CLI as a runner reports it: the pinned build, installed. */
const PINNED = [{ engine: 'cursor', installed: true, version: '2026.10.14-941492e', auth: 'unknown' }];
/** What a runner of this release declares on its heartbeat (the gateway forwards what its Hello declared). */
const DECLARES = { 'x-orbit-runner-capabilities': `session-worktree-ops-v1,${CURSOR_KEY_CHECK_V1}`, 'x-orbit-supported-providers': 'claude,cursor' };
const newKey = () => `key_lnk${randomUUID().replace(/-/g, '')}`;
const fingerprint = (key: string) => createHash('sha256').update(key.trim()).digest('hex').slice(0, 16);
/** What the push channel answers on a server with no push configured, whichever door asked it. */
const NO_PUSH = { delivered: false, reason: 'push is not configured on this server' };

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

const isUpgradeRequired = (reply: Reply) => reply.status === 426 && reply.json?.code === 'UPGRADE_REQUIRED';

test('the daemon\'s Cursor key checks and job alerts: on the link, and over HTTPS as before while the switch is off', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await sql.query(`UPDATE "runner_link_switch" SET "required" = false WHERE "id" = 1`).catch(() => undefined);
    await server?.stop();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // ── the owner, an administrator, the owner's machine with a checkout, and another machine of theirs ─────────────
  const account = async (name: string, role: 'ADMIN' | 'MEMBER') => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    const email = `${name}-${RUN}@runner-link-daemon-calls.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5)`,
      [id, email, name, hashPassword(password), role]);
    return { id, email, password };
  };
  const admin = await account('admin', 'ADMIN');
  const owner = await account('owner', 'MEMBER');
  /**
   * A runner of the owner's as its last heartbeat left it: online, able to run Cursor CLI, and to check Cursor keys
   * unless `checks` is false — the owner's checks then always go to the machine this spec answers them from.
   */
  const newRunner = async (name: string, checks = true) => {
    const id = randomUUID();
    const token = `runner-link-daemon-calls-${name}-${randomUUID()}`;
    await prisma.runner.create({
      data: {
        id, ownerId: owner.id, name: `${name} ${RUN}`, tokenHash: sha256(token), maxConcurrent: 8, status: RunnerStatus.ONLINE,
        lastHeartbeatAt: new Date(),
        capabilities: ['session-worktree-ops-v1', ...(checks ? [CURSOR_KEY_CHECK_V1] : []), 'provider:cursor'],
        capabilitiesReportedAt: new Date(), engines: PINNED as never,
      },
    });
    const workspaceId = randomUUID();
    await prisma.workspace.create({
      data: {
        id: workspaceId, ownerId: owner.id, runnerId: id, name: `${name} checkout`, enabled: true,
        workDir: mkdtempSync(path.join(tmpdir(), 'runner-link-daemon-calls-')),
      },
    });
    return { id, token, workspaceId };
  };
  const machine = await newRunner('machine');
  const other = await newRunner('other', false);
  // A session the other machine runs: not this machine's to raise an alert about.
  const othersSession = randomUUID();
  await prisma.session.create({
    data: {
      id: othersSession, ownerId: owner.id, creatorId: owner.id, workspaceId: other.workspaceId, assignedRunnerId: other.id,
      title: 'the other machine\'s session', prompt: 'the work', provider: 'claude', engine: 'claude',
      status: RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false,
    },
  });

  // ── the production apiserver, with the link's internal listener ───────────────────────────────────────────────
  const { privateKey } = generateKeyPairSync('ed25519');
  const internalPort = await freePort();
  const jwtSecret = `runner-link-daemon-calls-${randomUUID()}`;
  server = await startApiserver(url, jwtSecret, {
    RUNNER_LINK_SIGNING_KEY: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64'),
    RUNNER_LINK_URL: 'wss://link.runner-link-daemon-calls.invalid',
    RUNNER_LINK_GATEWAY_TOKEN: GATEWAY_TOKEN,
    RUNNER_LINK_INTERNAL_PORT: String(internalPort),
    RUNNER_LINK_INTERNAL_HOST: '127.0.0.1',
  });
  const api = server;
  const internal = { port: internalPort } as Apiserver;
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await call(api, 'POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const ownerToken = await signIn(owner);
  const adminToken = await signIn(admin);

  // The owner's Cursor key, connected through the door a person uses, and a session that runs Cursor CLI on it.
  const apiKey = newKey();
  const connected = await call(api, 'POST', '/api/providers/mine', ownerToken,
    { label: 'Cursor', presetSlug: 'cursor-api', baseUrl: 'https://api2.cursor.sh', apiKey });
  assert.equal(connected.status, 201, connected.text);
  const keyId = connected.json.id as string;
  const created = await call(api, 'POST', '/api/sessions', ownerToken, {
    workspaceId: uuidToBase62(machine.workspaceId), prompt: 'the work', engine: 'cursor', provider: connected.json.slug,
    permissionMode: 'acceptEdits',
  });
  assert.equal(created.status, 201, created.text);
  // The runner keys a session by its UUID, as a claim hands it over.
  const sessionId = toUuid(created.json.id);
  const assigned = await sql.query(`SELECT "assigned_runner_id"::text AS runner, "engine" FROM "session" WHERE "id" = $1::uuid`, [sessionId]);
  assert.deepEqual(assigned.rows[0], { runner: machine.id, engine: 'cursor' }, 'the session runs Cursor CLI on this machine');

  /** The key's last check as the owner reads it on the key. */
  const keyCheckState = async () => {
    const mine = await call(api, 'GET', '/api/providers/mine', ownerToken);
    assert.equal(mine.status, 200, mine.text);
    return (mine.json as Array<{ id: string; keyCheckState: string | null }>).find((row) => row.id === keyId)?.keyCheckState;
  };

  // ── the two ways a call comes: HTTPS with the runner's token, and the link ──────────────────────────────────────
  const leaseOwner = randomUUID();
  const minted = await call(api, 'POST', '/api/runner/link-token', machine.token, { leaseOwner });
  assert.equal(minted.status, 200, `the link token is minted over HTTPS: ${minted.text}`);
  let requests = 0;
  /** A call the link gateway forwards to the internal listener, with the runner's link token. */
  const overLink = (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) =>
    call(internal, method, route, undefined, body, {
      authorization: `Bearer ${GATEWAY_TOKEN}`,
      'x-orbit-runner-link-token': minted.json.token,
      'x-orbit-link-request-id': `r:${leaseOwner}:${(requests += 1)}`,
      ...headers,
    });
  /** The same call as the daemon makes it over HTTPS: the runner's token, no caller named. */
  const overHttps = (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) =>
    call(api, method, route, machine.token, body, headers);
  type Way = typeof overLink;

  /**
   * The owner checks the key again (POST /providers/mine/:id/key-check), which waits for the machine's answer: a
   * heartbeat sent `beatWay` hands the key over, and `answer` says what Cursor said. What the owner's check answered.
   */
  const checkAgain = async (beatWay: Way, answer: (result: object) => Promise<Reply>, state: string) => {
    const asked = call(api, 'POST', `/api/providers/mine/${keyId}/key-check`, ownerToken);
    let handed: { checkId: string; apiKey: string } | undefined;
    for (let i = 0; i < 100 && !handed; i += 1) {
      const beat = await beatWay('POST', '/api/runner/heartbeat', { leaseOwner, status: 'ONLINE', idleCapacity: 1, engines: PINNED }, DECLARES);
      assert.ok(beat.status === 200 || beat.status === 201, `the heartbeat: ${beat.status} ${beat.text}`);
      handed = beat.json.cursorKeyChecks?.[0];
      if (!handed) await sleep(100);
    }
    assert.ok(handed, 'no heartbeat was handed the key to check');
    assert.equal(handed.apiKey, apiKey, 'the key handed over is the key checked');
    const reply = await answer({ checkId: handed.checkId, state, keyFingerprint: fingerprint(apiKey) });
    assert.deepEqual([reply.status, reply.json], [200, { accepted: true }], `the answer: ${reply.text}`);
    const checked = await asked;
    assert.ok(checked.status === 200 || checked.status === 201, `the owner's check: ${checked.status} ${checked.text}`);
    return checked.json as { recorded: boolean; keyCheckState: string | null };
  };

  const sessionRoute = (rest: string) => `/api/runner/sessions/${sessionId}/${rest}`;
  const alertText = `Background shell job-${RUN} ended (exit code 0): make`;
  /** The same alert as `orbit mcp` sends it for the session, through the agents' door. */
  const agentsAlert = () => call(api, 'POST', '/api/runner/notify', machine.token, { message: alertText },
    { 'x-orbit-session-id': sessionId, 'x-orbit-runner-caller': 'mcp' });

  await t.test('(1) never switched, over HTTPS as a runner has always sent them: the Cursor key checks', async () => {
    const answered = await checkAgain(overHttps,
      (result) => overHttps('POST', '/api/runner/cursor-key-check-result', result), 'INVALID');
    assert.deepEqual([answered.recorded, answered.keyCheckState], [true, 'INVALID'], 'the owner\'s check answers what the machine said');
    assert.equal(await keyCheckState(), 'INVALID');

    const reported = await overHttps('POST', sessionRoute('cursor-key-check'), { state: 'VALID', keyFingerprint: fingerprint(apiKey) });
    assert.deepEqual([reported.status, reported.json], [200, { recorded: true }], reported.text);
    assert.equal(await keyCheckState(), 'VALID', 'the session\'s check is kept on the key');
    const replaced = await overHttps('POST', sessionRoute('cursor-key-check'), { state: 'INVALID', keyFingerprint: fingerprint(newKey()) });
    assert.deepEqual([replaced.status, replaced.json], [200, { recorded: false }], 'a check of another key is kept on nothing');
    assert.equal(await keyCheckState(), 'VALID');
  });

  await t.test('(2) never switched, over HTTPS: the job alert, answered as the agents\' door answers it', async () => {
    const alert = await overHttps('POST', sessionRoute('notify'), { message: alertText });
    assert.deepEqual([alert.status, alert.json], [200, NO_PUSH], alert.text);
    const asAgent = await agentsAlert();
    assert.deepEqual([asAgent.status, asAgent.json], [201, NO_PUSH], `the agents' door answers the same: ${asAgent.text}`);
    const notMine = await overHttps('POST', `/api/runner/sessions/${othersSession}/notify`, { message: alertText });
    assert.equal(notMine.status, 403, `another machine's session: ${notMine.text}`);
  });

  await t.test('(3) over the link: served, and taken as over HTTPS; the agent tool API is still not on the link', async () => {
    const answered = await checkAgain(overLink,
      (result) => overLink('POST', '/api/runner/cursor-key-check-result', result), 'INVALID');
    assert.deepEqual([answered.recorded, answered.keyCheckState], [true, 'INVALID'], 'the owner\'s check answers what the machine said');
    assert.equal(await keyCheckState(), 'INVALID');

    const reported = await overLink('POST', sessionRoute('cursor-key-check'), { state: 'VALID', keyFingerprint: fingerprint(apiKey) });
    assert.deepEqual([reported.status, reported.json], [200, { recorded: true }], reported.text);
    assert.equal(await keyCheckState(), 'VALID', 'the session\'s check is kept on the key');

    const alert = await overLink('POST', sessionRoute('notify'), { message: alertText });
    assert.deepEqual([alert.status, alert.json], [200, NO_PUSH], alert.text);
    const notMine = await overLink('POST', `/api/runner/sessions/${othersSession}/notify`, { message: alertText });
    assert.equal(notMine.status, 403, `another machine's session: ${notMine.text}`);

    // The doors beside them that are the agents', not the daemon's: still refused over the link (D14).
    for (const [method, route, body] of [['POST', '/api/runner/notify', { message: alertText }], ['GET', '/api/runner/providers', undefined]] as const) {
      const refused = await overLink(method, route, body);
      assert.deepEqual([refused.status, refused.json?.code], [404, 'RUNNER_LINK_ROUTE_NOT_ON_LINK'], `${method} ${route}: ${refused.text}`);
    }
  });

  await t.test('(4) switched on: HTTPS is refused 426 and changes nothing, the link serves them, `orbit mcp` keeps its door', async () => {
    const on = await call(api, 'PUT', '/api/admin/runner-link-required', adminToken, { required: true });
    assert.deepEqual([on.status, on.json?.required], [200, true], on.text);
    const beat = await overHttps('POST', '/api/runner/heartbeat', { leaseOwner, status: 'ONLINE', idleCapacity: 1, engines: PINNED }, DECLARES);
    assert.ok(isUpgradeRequired(beat), `the switch is on: ${beat.status} ${beat.text}`);

    // The answer over HTTPS is refused and settles nothing; the same answer over the link then does.
    let refused: Reply | undefined;
    const answered = await checkAgain(overLink, async (result) => {
      refused = await overHttps('POST', '/api/runner/cursor-key-check-result', result);
      return overLink('POST', '/api/runner/cursor-key-check-result', result);
    }, 'UNREACHABLE');
    assert.ok(refused && isUpgradeRequired(refused), `the answer over HTTPS: ${refused?.status} ${refused?.text}`);
    assert.deepEqual([answered.recorded, answered.keyCheckState], [true, 'UNREACHABLE'], 'the answer over the link settled the check');

    const httpsReport = await overHttps('POST', sessionRoute('cursor-key-check'), { state: 'INVALID', keyFingerprint: fingerprint(apiKey) });
    assert.ok(isUpgradeRequired(httpsReport), `the session's check over HTTPS: ${httpsReport.status} ${httpsReport.text}`);
    assert.equal(await keyCheckState(), 'UNREACHABLE', 'a refused report changed nothing');
    const linkReport = await overLink('POST', sessionRoute('cursor-key-check'), { state: 'VALID', keyFingerprint: fingerprint(apiKey) });
    assert.deepEqual([linkReport.status, linkReport.json], [200, { recorded: true }], linkReport.text);
    assert.equal(await keyCheckState(), 'VALID');

    const httpsAlert = await overHttps('POST', sessionRoute('notify'), { message: alertText });
    assert.ok(isUpgradeRequired(httpsAlert), `the alert over HTTPS: ${httpsAlert.status} ${httpsAlert.text}`);
    const linkAlert = await overLink('POST', sessionRoute('notify'), { message: alertText });
    assert.deepEqual([linkAlert.status, linkAlert.json], [200, NO_PUSH], linkAlert.text);
    const asAgent = await agentsAlert();
    assert.deepEqual([asAgent.status, asAgent.json], [201, NO_PUSH], `the agents' door is not the daemon's: ${asAgent.text}`);

    const off = await call(api, 'PUT', '/api/admin/runner-link-required', adminToken, { required: false });
    assert.deepEqual([off.status, off.json?.required], [200, false], off.text);
  });
});
