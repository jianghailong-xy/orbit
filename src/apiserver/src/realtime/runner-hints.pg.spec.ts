/**
 * The runner link's hints (realtime/runner-hints.ts) from the production apiserver — `build/main.js`, the whole
 * AppModule, run as a child process — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, with
 * the runner link configured and RUNNER_LINK_NATS_URL naming a NATS server this spec plays. It speaks NATS's client
 * protocol (INFO, CONNECT, PING/PONG, PUB, SUB) to the apiserver's real client and records every message published.
 * The real nats-server is scripts/runner-link/staging-check.sh's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/realtime/runner-hints.pg.spec.ts
 *
 * Two runners of one account, A and B, each with a workspace of its own. B keeps a claim long poll open throughout, and
 * is never handed a session.
 *
 *   1. a session opened in A's workspace is hinted to A alone: one claim hint on rnr.<A> and nothing on rnr.<B>. B's
 *      long poll stays open, and A's claim takes the session over HTTPS, as before;
 *   2. a message sent to that session while it runs is hinted to A alone, as an inbox hint naming the session;
 *   3. Update Runner Now on B is hinted to B alone, as a commands hint, and B's wake poll returns as before;
 *   4. a message sent to a session of A's that is between turns queues it again: a claim hint for A alone;
 *   5. with NATS gone, a session opened on A is still handed to A's claim long poll at once over HTTPS and nothing is
 *      published; the apiserver logs the disconnect and, a minute later, the number of hints it dropped.
 *
 * Not destructive: every row belongs to the account this run creates.
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

import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

/** One message the apiserver published. */
interface Published {
  subject: string;
  message: string;
}

/**
 * A NATS server as far as a client publishing to it can tell: INFO first, PONG to every PING, and every PUB (or HPUB)
 * recorded with its subject and payload. Nothing is delivered on: the spec reads what was published.
 */
class NatsStandIn {
  readonly published: Published[] = [];
  connections = 0;
  private readonly sockets = new Set<net.Socket>();
  private readonly server = net.createServer((socket) => this.serve(socket));

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as net.AddressInfo).port;
  }

  /** Close the port and every connection, as a NATS server that went away. */
  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private serve(socket: net.Socket): void {
    this.connections += 1;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.write(`INFO ${JSON.stringify({
      server_id: 'NATS-STAND-IN', server_name: 'runner-hints.pg.spec', version: '2.15.1', proto: 1, go: 'go1.27.3',
      host: '127.0.0.1', port: (this.server.address() as net.AddressInfo).port, headers: true, max_payload: 1_048_576,
    })}\r\n`);
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const end = pending.indexOf('\r\n');
        if (end < 0) return;
        const [op, ...args] = pending.subarray(0, end).toString('utf8').split(' ');
        const verb = op.toUpperCase();
        if (verb === 'PUB' || verb === 'HPUB') {
          const total = Number(args[args.length - 1]);
          const headers = verb === 'HPUB' ? Number(args[args.length - 2]) : 0;
          if (pending.length < end + 2 + total + 2) return; // the payload is still arriving
          const payload = pending.subarray(end + 2 + headers, end + 2 + total).toString('utf8');
          this.published.push({ subject: args[0], message: payload });
          pending = pending.subarray(end + 2 + total + 2);
          continue;
        }
        if (verb === 'PING') socket.write('PONG\r\n');
        // CONNECT, PONG, SUB and UNSUB need no answer from a server that is not asked for +OK.
        pending = pending.subarray(end + 2);
      }
    });
  }
}

/** A long poll held open on a connection of its own, which the caller can drop. */
interface Held {
  answer: Promise<Reply>;
  settled(): boolean;
  hangUp(): void;
}

function hold(server: Apiserver, route: string, token: string): Held {
  let done = false;
  const req = http.request({
    host: '127.0.0.1', port: server.port, method: 'GET', path: route, agent: false,
    headers: { authorization: `Bearer ${token}` },
  });
  const answer = new Promise<Reply>((resolve, reject) => {
    req.on('response', (res) => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => parts.push(chunk));
      res.on('end', () => {
        done = true;
        const text = Buffer.concat(parts).toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, json, text, headers: res.headers });
      });
    });
    req.on('error', (error) => {
      done = true;
      reject(error);
    });
  });
  answer.catch(() => undefined);
  req.end();
  return { answer, settled: () => done, hangUp: () => req.destroy() };
}

async function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`${what} did not answer within ${ms} ms`);
    }),
  ]);
}

async function until(ms: number, what: string, done: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) assert.fail(`${what}: not within ${ms} ms`);
    await sleep(50);
  }
}

test('each wake is hinted on NATS to the runner it concerns alone, and HTTPS works as before with NATS gone', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const beats = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await beats.connect();
  const prisma: PrismaClient = prismaClientFor(url);
  const nats = new NatsStandIn();
  const natsPort = await nats.listen();
  let server: Apiserver | undefined;
  let beating: ReturnType<typeof setInterval> | undefined;
  const held: Held[] = [];
  let bWaiting: Promise<void> | undefined;
  let bStops = false;
  t.after(async () => {
    if (beating) clearInterval(beating);
    bStops = true;
    for (const poll of held) poll.hangUp();
    await bWaiting;
    await server?.stop();
    await nats.stop().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await beats.end().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // ── the account, its two machines and a checkout on each ────────────────────────────────────────────────
  const owner = { id: randomUUID(), email: `owner-${RUN}@runner-hints.invalid`, password: `pw-owner-${RUN}` };
  await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
    [owner.id, owner.email, 'owner', hashPassword(owner.password)]);
  const machine = async (name: string) => {
    const id = randomUUID();
    const token = `runner-hints-${name}-${randomUUID()}`;
    await prisma.runner.create({
      data: {
        id, ownerId: owner.id, name: `machine ${name}`, tokenHash: sha256(token), maxConcurrent: 8,
        status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(),
        // A release that reports its self-update state, so Update Runner Now may ask it (test 3).
        selfUpdate: { state: 'enabled' },
      },
    });
    const workspaceId = randomUUID();
    await prisma.workspace.create({
      data: {
        id: workspaceId, ownerId: owner.id, runnerId: id, name: `checkout on ${name}`, enabled: true,
        workDir: mkdtempSync(path.join(tmpdir(), `runner-hints-${name}-`)),
      },
    });
    return { id, token, workspaceId };
  };
  const a = await machine('a');
  const b = await machine('b');
  // The reaper ends a RUNNING session whose runner stopped heartbeating; these two stay online throughout.
  const beat = () =>
    beats.query(`UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" = ANY($1::uuid[])`, [[a.id, b.id]])
      .catch(() => undefined);
  await beat();
  beating = setInterval(() => void beat(), 3_000);

  // ── the apiserver, with the runner link configured and its hints published to the stand-in ───────────────
  const signingKey = Buffer.from(generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }))
    .toString('base64');
  server = await startApiserver(url, `runner-hints-${randomUUID()}`, {
    RUNNER_LINK_SIGNING_KEY: signingKey,
    RUNNER_LINK_URL: 'wss://link.runner-hints.invalid',
    RUNNER_LINK_GATEWAY_TOKEN: `gateway-${randomUUID()}`,
    RUNNER_LINK_NATS_URL: `nats://127.0.0.1:${natsPort}`,
  });
  const api = (method: string, route: string, bearer?: string, body?: unknown) => call(server!, method, route, bearer, body);
  const signedIn = await api('POST', '/api/auth/login', undefined, { email: owner.email, password: owner.password });
  assert.equal(signedIn.status, 201, signedIn.text);
  const ownerToken = signedIn.json.accessToken as string;
  await until(30_000, 'the apiserver connecting to NATS', () => nats.connections > 0);
  await until(10_000, 'the apiserver saying it connected', () => /connected to NATS at /.test(server!.output()));

  const claimHint = '{"hint":{"claim":{}}}';
  const commandsHint = '{"hint":{"commands":{}}}';
  const inboxHint = (sessionId: string) => `{"hint":{"inbox":{"sessionId":"${sessionId}"}}}`;
  /** What was published from `from` on, once nothing more has arrived for a moment. */
  const publishedSince = async (from: number, atLeast: number): Promise<Published[]> => {
    await until(10_000, `${atLeast} hint(s) published`, () => nats.published.length >= from + atLeast);
    await sleep(1_000); // anything published alongside arrives in this time
    return nats.published.slice(from);
  };
  const openSession = async (workspaceId: string, title: string): Promise<string> => {
    const opened = await api('POST', '/api/sessions', ownerToken, { workspaceId, prompt: title, title });
    assert.equal(opened.status, 201, opened.text);
    return toUuid(opened.json.id);
  };
  const statusOf = async (sessionId: string) =>
    (await sql.query<{ status: string }>(`SELECT "status" FROM "session" WHERE "id" = $1::uuid`, [sessionId])).rows[0].status;

  // B waits for work the whole time, one claim long poll after another (each answers empty after 25 s): the polls the
  // in-process signal wakes, every one of them, as it always has. Every session B is ever handed is kept here.
  const bClaimed: string[] = [];
  bWaiting = (async () => {
    while (!bStops) {
      const poll = hold(server!, '/api/runner/sessions/claim', b.token);
      held.push(poll);
      const reply = await poll.answer.catch(() => null);
      if (reply?.json?.sessionId) bClaimed.push(toUuid(reply.json.sessionId));
    }
  })();
  await sleep(500);

  let onA = '';
  await t.test('1. a session opened on A is hinted to A alone, and A claims it over HTTPS', async () => {
    const mark = nats.published.length;
    onA = await openSession(a.workspaceId, 'work for machine A');
    assert.deepEqual(await publishedSince(mark, 1), [{ subject: `rnr.${a.id}`, message: claimHint }],
      'one claim hint, for the runner the session is queued for, and none for B');
    assert.deepEqual(bClaimed, [], "B's claim long poll was handed a session");
    const claimed = await within(10_000, "A's claim", api('GET', '/api/runner/sessions/claim', a.token));
    assert.equal(claimed.status, 200, claimed.text);
    assert.equal(toUuid(claimed.json.sessionId), onA);
    assert.equal(await statusOf(onA), 'RUNNING');
  });

  await t.test('2. a message to that running session is an inbox hint to A alone', async () => {
    const mark = nats.published.length;
    const sent = await api('POST', `/api/sessions/${uuidToBase62(onA)}/turns`, ownerToken,
      { clientTurnId: randomUUID(), content: 'and one more thing' });
    assert.equal(sent.status, 201, sent.text);
    assert.deepEqual(await publishedSince(mark, 1), [{ subject: `rnr.${a.id}`, message: inboxHint(onA) }]);
    assert.deepEqual(bClaimed, []);
  });

  await t.test('3. Update Runner Now on B is a commands hint to B alone, and B\'s wake poll returns as before', async () => {
    const mark = nats.published.length;
    const asked = await api('POST', `/api/runners/${uuidToBase62(b.id)}/self-update`, ownerToken);
    assert.equal(asked.status, 201, asked.text);
    assert.deepEqual(await publishedSince(mark, 1), [{ subject: `rnr.${b.id}`, message: commandsHint }]);
    const woken = await within(5_000, "B's wake poll", api('GET', '/api/runner/wake', b.token));
    assert.equal(woken.status, 200, woken.text);
    assert.equal(woken.json?.wake, true, woken.text);
  });

  await t.test('4. a message to a session of A\'s between turns queues it again, hinted to A alone', async () => {
    const idle = randomUUID();
    await prisma.session.create({
      data: {
        id: idle, ownerId: owner.id, creatorId: owner.id, workspaceId: a.workspaceId, assignedRunnerId: a.id,
        title: 'between turns on A', prompt: 'the first turn', provider: 'claude', engine: 'claude',
        status: RunStatus.AWAITING_INPUT, numTurns: 1, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false,
      },
    });
    const mark = nats.published.length;
    const sent = await api('POST', `/api/sessions/${uuidToBase62(idle)}/turns`, ownerToken,
      { clientTurnId: randomUUID(), content: 'the next turn' });
    assert.equal(sent.status, 201, sent.text);
    assert.equal(await statusOf(idle), 'PENDING');
    assert.deepEqual(await publishedSince(mark, 1), [{ subject: `rnr.${a.id}`, message: claimHint }]);
    assert.deepEqual(bClaimed, []);
    const claimed = await within(10_000, "A's claim", api('GET', '/api/runner/sessions/claim', a.token));
    assert.equal(claimed.status, 200, claimed.text);
    assert.equal(toUuid(claimed.json.sessionId), idle, 'A claims the session it was hinted about');
  });

  await t.test('5. with NATS gone, HTTPS hands A its session at once, nothing is published, and the drop is logged', async () => {
    await nats.stop();
    await until(10_000, 'the apiserver noticing NATS is gone', () => /disconnected from NATS at /.test(server!.output()));
    const published = nats.published.length;
    const aWaits = hold(server!, '/api/runner/sessions/claim', a.token);
    held.push(aWaits);
    await sleep(6_500); // past the claim's own 5 s re-poll, so an answer well inside the next one is the wake's
    assert.equal(aWaits.settled(), false);
    const openedAt = Date.now();
    const offline = await openSession(a.workspaceId, 'work for machine A while NATS is gone');
    const answer = await within(10_000, "A's claim long poll", aWaits.answer);
    const latency = Date.now() - openedAt;
    assert.equal(answer.status, 200, answer.text);
    assert.equal(toUuid(answer.json?.sessionId), offline);
    assert.ok(latency < 2_500, `the claim answered ${latency} ms after the session was opened: it was not woken`);
    assert.equal(nats.published.length, published, 'nothing reached a NATS that is not there');
    assert.deepEqual(bClaimed, []);
    // Counted, and reported once a minute rather than once per hint.
    await until(75_000, 'the report of dropped hints', () => /dropped \d+ runner link hints? since the last report/.test(server!.output()));
    assert.equal(server!.output().match(/dropped \d+ runner link hints? since the last report/g)?.length, 1);
  });
});
