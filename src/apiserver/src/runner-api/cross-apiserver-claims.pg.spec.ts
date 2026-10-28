/**
 * THREE THINGS EACH APISERVER KEPT IN ITS OWN MEMORY, HELD AGAINST TWO PRODUCTION APISERVERS ON ONE POSTGRESQL.
 *
 * `build/main.js` twice — the whole AppModule, as the container starts it — over one database that
 * `scripts/run-pg-spec.sh` migrates from empty, with the requests a runner and the link gateway send. The link gateway
 * spreads a runner's calls over every apiserver (docs/self-hosting.md, "Several apiservers"), so the calls of one
 * session reach both, and each apiserver used to answer them from what it alone had seen:
 *
 *   1. The recap's two-minute window (sessions/recap.ts). Two settles of one session inside the window, one on each
 *      apiserver, leave a trailing timer on each, and both fire as the window closes: one model call between them.
 *   2. The same window open: two settles of one session at once, one on each apiserver: one model call.
 *   3. The iOS approval alert (push/push.service.ts). Four approvals of one turn, two through each apiserver at once,
 *      ring the phone once.
 *   4. The owner answers them through the first apiserver, whose badge is reconciled as an answer's apiserver's is;
 *      the next approval, through the second, rings once.
 *   5. Answered again, the next approval through the first rings once: what one apiserver did before.
 *   6. The agent notification limit (push/push.service.ts). An agent's `notify` through POST /runner/notify on one
 *      apiserver, then the runner daemon's alert for the same session through POST /runner/sessions/:id/notify over
 *      the link on the other: the second is refused for the rest of the minute. A `notify` naming no session, once on
 *      each apiserver: the second is refused.
 *
 * The model provider and APNs are this file's, and nothing leaves the host: the apiservers ask a DeepSeek-compatible
 * endpoint here (DEEPSEEK_BASE_URL), which counts what it is asked, and each loads a preload (NODE_OPTIONS=--require)
 * that answers APNs's HTTP/2 itself and hands every request it would have sent to this file.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/cross-apiserver-claims.pg.spec.ts
 *
 * Not destructive: every row belongs to an account this run creates.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RECAP_MIN_INTERVAL_MS } from '../sessions/recap';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const GATEWAY_TOKEN = `cross-apiserver-claims-gateway-${randomUUID()}`;
/** What the model answers every recap with. */
const RECAP = 'Fixed the login redirect; the suite passes.';
/** How long the model holds each answer: long enough that a second pass of one window would be asking meanwhile. */
const MODEL_HOLD_MS = 1_500;
/** How long after one alert a second would have arrived, had either apiserver sent one. */
const QUIET_MS = 2_000;

/**
 * Loaded into each apiserver: APNs's HTTP/2 answered 200 here, every request it would have carried handed to the
 * spec's collector instead (push.service.ts `send` is the only caller of http2.connect in the apiserver).
 */
const APNS_PRELOAD = `'use strict';
const http = require('node:http');
const http2 = require('node:http2');
const { EventEmitter } = require('node:events');
const collector = process.env.CROSS_APISERVER_CLAIMS_APNS;
http2.connect = () => {
  const client = new EventEmitter();
  client.close = () => undefined;
  client.request = (headers) => {
    const stream = new EventEmitter();
    stream.setTimeout = () => stream;
    stream.close = () => undefined;
    stream.end = (body) => {
      const answered = (status) => {
        stream.emit('response', { ':status': status });
        stream.emit('end');
      };
      const handed = http.request(collector, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => answered(200));
      });
      handed.on('error', () => answered(503));
      handed.end(JSON.stringify({ path: headers[':path'], body: String(body ?? ''), pid: process.pid }));
    };
    return stream;
  };
  return client;
};
`;

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

/** Poll `check` until it answers something, or the deadline passes and it answers null. */
async function until<T>(check: () => Promise<T | null> | T | null, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = await check();
    if (hit !== null) return hit;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
}

interface Pushed {
  pid: number;
  kind: string;
  sessionId?: string;
}

/** The model the recap asks and the APNs collector, on one local port: what each was asked, as it was asked. */
async function stubs() {
  const asked: string[] = [];
  const pushed: Pushed[] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8');
      if (req.url === '/apns') {
        const handed = JSON.parse(text) as { body: string; pid: number };
        const payload = JSON.parse(handed.body) as { kind?: string; sessionID?: string };
        pushed.push({ pid: handed.pid, kind: payload.kind ?? 'silent', sessionId: payload.sessionID });
        res.writeHead(200).end();
        return;
      }
      const request = JSON.parse(text) as { messages?: Array<{ content: string }> };
      asked.push(request.messages?.[1]?.content ?? '');
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: RECAP } }] }));
      }, MODEL_HOLD_MS);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    asked,
    pushed,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('the recap window, the approval alert and the notification limit hold across two production apiservers', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  const stub = await stubs();
  const preloadDir = mkdtempSync(path.join(tmpdir(), 'cross-apiserver-claims-'));
  const preload = path.join(preloadDir, 'apns-preload.js');
  writeFileSync(preload, APNS_PRELOAD);
  const servers: Apiserver[] = [];
  t.after(async () => {
    for (const server of servers) await server.stop();
    await stub.close();
    rmSync(preloadDir, { recursive: true, force: true });
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // ── the owner, their iPhone, and their machine ────────────────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  const owner = { email: `owner-${RUN}@cross-apiserver-claims.invalid`, password: `pw-${RUN}` };
  await prisma.user.create({
    data: { id: ownerId, email: owner.email, name: 'The owner', passwordHash: hashPassword(owner.password) },
  });
  await prisma.deviceToken.create({
    data: { userId: ownerId, token: `apns-${RUN}`, platform: 'ios', bundleId: 'io.orbitd.app', environment: 'sandbox' },
  });
  const runnerId = randomUUID();
  const runnerToken = `cross-apiserver-claims-${randomUUID()}`;
  await prisma.runner.create({
    data: {
      id: runnerId, ownerId, name: `machine ${RUN}`, tokenHash: sha256(runnerToken), maxConcurrent: 8,
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: ['session-worktree-ops-v1'],
      capabilitiesReportedAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  await prisma.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `checkout ${RUN}`, enabled: true, workDir: preloadDir },
  });

  /**
   * A session on that machine: RUNNING with a turn out on delivery, as one whose agent asks for permission is; or,
   * `parked`, waiting for input while its engine runs a turn nobody delivered, whose TURN_END is a settle.
   */
  const session = async (
    label: string,
    opts: { parked?: boolean; recap?: { recapText: string; recapAt: Date; recapEventSeq: number } } = {},
  ) => {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: label, prompt: 'fix the login flow',
        provider: 'claude', status: opts.parked ? RunStatus.AWAITING_INPUT : RunStatus.RUNNING, engineTurnActive: true,
        dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(), runtimeSessionId: randomUUID(),
        ...(opts.recap ?? {}),
      },
    });
    if (!opts.parked) {
      await prisma.conversationTurn.create({
        data: {
          sessionId: id, seq: 1, clientTurnId: `${label}-${randomUUID()}`, kind: 'message', content: 'fix the login flow',
          status: 'IN_FLIGHT', deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 300_000),
          leaseGeneration: randomUUID(),
        },
      });
    }
    return id;
  };

  // ── two production apiservers on the one database, each with the link's internal listener ─────────────────────────
  const { privateKey: linkKey } = generateKeyPairSync('ed25519');
  const { privateKey: apnsKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwtSecret = `cross-apiserver-claims-${randomUUID()}`;
  const env = async () => {
    const internalPort = await freePort();
    return {
      internalPort,
      env: {
        DEEPSEEK_API_KEY: 'cross-apiserver-claims',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${stub.port}`,
        APNS_KEY_ID: 'cross-apiserver-claims',
        APNS_TEAM_ID: 'cross-apiserver-claims',
        APNS_KEY: Buffer.from(apnsKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64'),
        CROSS_APISERVER_CLAIMS_APNS: `http://127.0.0.1:${stub.port}/apns`,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${preload}`.trim(),
        RUNNER_LINK_SIGNING_KEY: Buffer.from(linkKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64'),
        RUNNER_LINK_URL: 'wss://link.cross-apiserver-claims.invalid',
        RUNNER_LINK_GATEWAY_TOKEN: GATEWAY_TOKEN,
        RUNNER_LINK_INTERNAL_PORT: String(internalPort),
        RUNNER_LINK_INTERNAL_HOST: '127.0.0.1',
      },
    };
  };
  const first = await env();
  const one = await startApiserver(url, jwtSecret, first.env);
  servers.push(one);
  const second = await env();
  const two = await startApiserver(url, jwtSecret, second.env);
  servers.push(two);
  assert.notEqual(one.child.pid, two.child.pid);

  /** A runner call over HTTPS, as the runner and its agents' tools send it. */
  const overHttps = (server: Apiserver, method: string, route: string, body?: unknown, headers: Record<string, string> = {}) =>
    call(server, method, route, runnerToken, body, headers);
  const leaseOwner = randomUUID();
  const minted = await overHttps(one, 'POST', '/api/runner/link-token', { leaseOwner });
  assert.equal(minted.status, 200, `the link token: ${minted.text}`);
  let requests = 0;
  /** A call the link gateway forwards to this apiserver's internal listener, with the runner's link token. */
  const overLink = (internalPort: number, method: string, route: string, body?: unknown) =>
    call({ port: internalPort } as Apiserver, method, route, undefined, body, {
      authorization: `Bearer ${GATEWAY_TOKEN}`,
      'x-orbit-runner-link-token': minted.json.token,
      'x-orbit-link-request-id': `r:${leaseOwner}:${(requests += 1)}`,
    });

  /** The runner's event batch for a session, through one apiserver. */
  const say = async (server: Apiserver, sessionId: string, events: Array<{ seq: number; type: RunEventType; text?: string }>) => {
    const reply = await overHttps(server, 'POST', `/api/runner/sessions/${sessionId}/events`, {
      events: events.map((e) => ({
        seq: e.seq, type: e.type, ts: new Date().toISOString(), payload: e.text === undefined ? {} : { text: e.text },
      })),
    });
    assert.equal(reply.status, 202, `the events: ${reply.text}`);
  };
  const askedAbout = (marker: string) => stub.asked.filter((task) => task.includes(marker));
  const recapRow = async (sessionId: string) =>
    (await sql.query(`SELECT "recap_text", "recap_event_seq" FROM "session" WHERE "id" = $1::uuid`, [sessionId])).rows[0] as {
      recap_text: string | null;
      recap_event_seq: number | null;
    };

  await t.test('(1) a settle on each apiserver inside the window: both trailing timers fire, one model call', async () => {
    const marker = `trailing-${RUN}`;
    // Recapped just under two minutes ago, through events 1 and 2: the window closes eight seconds from now.
    const s = await session('trailing', {
      parked: true,
      recap: { recapText: 'Earlier: looked at the login flow.', recapAt: new Date(Date.now() - (RECAP_MIN_INTERVAL_MS - 8_000)), recapEventSeq: 2 },
    });
    await say(one, s, [{ seq: 1, type: RunEventType.USER, text: 'fix the login flow' }, { seq: 2, type: RunEventType.ASSISTANT, text: 'Looking.' }]);
    await say(one, s, [{ seq: 3, type: RunEventType.ASSISTANT, text: `${marker}: the redirect lost its cookie.` }, { seq: 4, type: RunEventType.TURN_END }]);
    await say(two, s, [{ seq: 5, type: RunEventType.ASSISTANT, text: `${marker}: the suite passes.` }, { seq: 6, type: RunEventType.TURN_END }]);
    await sleep(500);
    assert.equal(askedAbout(marker).length, 0, 'inside the window neither apiserver asks');

    const written = await until(async () => ((await recapRow(s)).recap_event_seq === 5 ? true : null), 30_000);
    assert.ok(written, 'the window closing brought the recap up to both settles');
    await sleep(MODEL_HOLD_MS + QUIET_MS);
    assert.equal(askedAbout(marker).length, 1, `one model call for the window between both apiservers: ${askedAbout(marker).length}`);
    assert.match(askedAbout(marker)[0], /the redirect lost its cookie[\s\S]*the suite passes/, 'covering both settles');
    assert.equal((await recapRow(s)).recap_text, RECAP);
  });

  await t.test('(2) the window open, a settle on each apiserver at once: one model call', async () => {
    const marker = `due-${RUN}`;
    const s = await session('due', { parked: true });
    await say(one, s, [
      { seq: 1, type: RunEventType.USER, text: 'fix the login flow' },
      { seq: 2, type: RunEventType.ASSISTANT, text: `${marker}: the redirect lost its cookie.` },
      { seq: 3, type: RunEventType.ASSISTANT, text: 'Patched the cookie domain.' },
      { seq: 4, type: RunEventType.ASSISTANT, text: `${marker}: the suite passes.` },
    ]);
    await Promise.all([
      say(one, s, [{ seq: 5, type: RunEventType.TURN_END }]),
      say(two, s, [{ seq: 6, type: RunEventType.TURN_END }]),
    ]);
    const written = await until(async () => ((await recapRow(s)).recap_event_seq === 4 ? true : null), 20_000);
    assert.ok(written, 'the recap is written');
    await sleep(MODEL_HOLD_MS + QUIET_MS);
    assert.equal(askedAbout(marker).length, 1, `one model call between both apiservers: ${askedAbout(marker).length}`);
  });

  const alertsFor = (sessionId: string) => stub.pushed.filter((p) => p.kind === 'approval' && p.sessionId === sessionId);
  /** The alerts of a session once one more has arrived (or none, by the deadline) and the rest have had time to. */
  const settledAlerts = async (sessionId: string, atLeast: number) => {
    await until(() => (alertsFor(sessionId).length >= atLeast ? true : null), 10_000);
    await sleep(QUIET_MS);
    return alertsFor(sessionId);
  };

  // The owner, signed in through the first apiserver, where the web gateway sends people's requests.
  const signedIn = await call(one, 'POST', '/api/auth/login', undefined, owner);
  assert.equal(signedIn.status, 201, `the owner signs in: ${signedIn.text}`);
  const ownerToken = signedIn.json.accessToken as string;
  const asking = await session('asking');
  let asked = 0;
  /** The agent's next tool call asks: an approval, through the apiserver the gateway hands it to. */
  const ask = async (server: Apiserver) => {
    asked += 1;
    const reply = await overHttps(server, 'POST', `/api/runner/sessions/${asking}/approvals`, {
      toolName: 'Bash', input: { command: `make step-${asked}` }, toolUseId: `tu-${RUN}-${asked}`,
    });
    assert.ok(reply.status === 200 || reply.status === 201, `an approval: ${reply.status} ${reply.text}`);
    return reply.json.id as string;
  };
  const pending: string[] = [];
  /** The owner answers every pending approval through the first apiserver, which reconciles its badge after them. */
  const answerAll = async () => {
    for (const id of pending.splice(0)) {
      const answered = await call(one, 'POST', `/api/sessions/${asking}/approvals/${id}/decision`, ownerToken, { behavior: 'allow' });
      assert.ok(answered.status === 200 || answered.status === 201, `the owner's answer: ${answered.status} ${answered.text}`);
    }
    // The badge reconcile the answers asked for runs on the first apiserver, debounced there (SYNC_DEBOUNCE_MS, 300 ms).
    await sleep(1_500);
  };

  await t.test('(3) four approvals of one turn, two through each apiserver at once: one alert', async () => {
    pending.push(...await Promise.all([ask(one), ask(two), ask(one), ask(two)]));
    const alerts = await settledAlerts(asking, 1);
    assert.equal(alerts.length, 1, `one alert for the turn between both apiservers: ${JSON.stringify(alerts)}`);
  });

  await t.test('(4) answered through the first apiserver, the next approval rings once through the second', async () => {
    await answerAll();
    const before = alertsFor(asking).length;
    pending.push(await ask(two));
    const alerts = await settledAlerts(asking, before + 1);
    assert.equal(alerts.length - before, 1, `the next stretch rings once: ${JSON.stringify(alerts)}`);
  });

  await t.test('(5) answered again, the next approval through the first apiserver rings once, as one apiserver did', async () => {
    await answerAll();
    const before = alertsFor(asking).length;
    pending.push(await ask(one));
    const alerts = await settledAlerts(asking, before + 1);
    assert.equal(alerts.length - before, 1, `and the one after it: ${JSON.stringify(alerts)}`);
  });

  await t.test('(6) the agents\' door on one apiserver, the daemon\'s over the link on the other: one ring a minute', async () => {
    const s = await session('notifying');
    const asAgent = await overHttps(one, 'POST', '/api/runner/notify', { message: `Need the staging password (${RUN})` },
      { 'x-orbit-session-id': s });
    assert.deepEqual([asAgent.status, asAgent.json], [201, { delivered: true, devices: 1 }], asAgent.text);
    const asDaemon: Reply = await overLink(second.internalPort, 'POST', `/api/runner/sessions/${s}/notify`,
      { message: `Background shell job-${RUN} ended (exit code 0): make` });
    assert.equal(asDaemon.status, 200, asDaemon.text);
    assert.equal(asDaemon.json.delivered, false, `the daemon's alert on the other apiserver: ${asDaemon.text}`);
    assert.match(asDaemon.json.reason, /^rate limited — try again in \d+s$/);
    const backOnOne = await overLink(first.internalPort, 'POST', `/api/runner/sessions/${s}/notify`, { message: 'again' });
    assert.equal(backOnOne.json.delivered, false, `and on the first apiserver's link listener: ${backOnOne.text}`);

    const headless = await overHttps(one, 'POST', '/api/runner/notify', { message: `Nightly backup finished (${RUN})` });
    assert.deepEqual([headless.status, headless.json], [201, { delivered: true, devices: 1 }], headless.text);
    const headlessAgain = await overHttps(two, 'POST', '/api/runner/notify', { message: 'Nightly backup finished, again' });
    assert.equal(headlessAgain.json.delivered, false, `a notify naming no session on the other apiserver: ${headlessAgain.text}`);
    assert.match(headlessAgain.json.reason, /^rate limited/);
    await sleep(500);
    assert.equal(stub.pushed.filter((p) => p.kind === 'agent-message').length, 2, 'APNs carried exactly the two that rang');
  });
});
