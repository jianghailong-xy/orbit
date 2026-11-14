/**
 * A real apiserver stops by itself on SIGTERM (graceful-stop.ts): `node build/main.js` as the container starts it
 * (with `exec`, node is PID 1 and gets the signal), with the runner link on, over a disposable PostgreSQL, beside a
 * second apiserver on the same database.
 *
 * When the stop begins, the first apiserver has: a session stream open; a connection busy with a request whose body is
 * only half sent; an idle connection on each listener. Then:
 *   - both listeners refuse new connections;
 *   - the idle connections are closed, and the session stream ends cleanly (a whole chunked answer, not a reset);
 *   - the busy request, its body finished after the stop began, is answered with `Connection: close`, and its
 *     connection closes after the answer rather than keepAliveTimeout (120 s) later;
 *   - the process exits 0 by itself within STOP_MS, its shutdown hooks run, no sooner than LINGER_MS;
 *   - the stream, opened again on the second apiserver from the last seq it had, gets the event stored meanwhile.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/common/graceful-stop.pg.spec.ts
 *
 * Needs COORDINATOR_PG_URL (the script provides a disposable one).
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import { connect, createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import { RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { KeptAliveConnection } from '../test-support/kept-alive';
import { LINGER_MS, STOP_MS } from './graceful-stop';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const GATEWAY_TOKEN = `the-link-gateway-secret:${randomUUID()}`;
const REVOCATIONS = '/api/runner/link-token/revocations';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  for (const start = Date.now(); !(await check()); await sleep(25)) {
    assert.ok(Date.now() - start < ms, `${what}: not within ${ms} ms`);
  }
}

/** A session stream as a client reads it: the seqs of its stored events, and how it ended. */
function openStream(port: number, sessionId: string, sinceSeq: number, token: string) {
  const seqs: number[] = [];
  let ended: 'complete' | 'cut' | null = null;
  let buffer = '';
  const req = http.get({
    host: '127.0.0.1', port, path: `/api/sessions/${sessionId}/events?sinceSeq=${sinceSeq}`,
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
  }, (res) => {
    assert.equal(res.statusCode, 200);
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        const event = data ? (JSON.parse(data.slice(6)) as { seq?: number; type: string }) : null;
        if (event?.seq) seqs.push(event.seq);
      }
    });
    res.on('end', () => (ended ??= res.complete ? 'complete' : 'cut'));
    res.on('aborted', () => (ended ??= 'cut'));
  });
  req.on('error', () => (ended ??= 'cut'));
  return { seqs, ended: () => ended, close: () => req.destroy() };
}

test('SIGTERM: a real apiserver refuses new connections, ends its streams, answers what is in flight and exits 0 within STOP_MS; the stream reopens on another apiserver with nothing missed', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const servers: Apiserver[] = [];
  t.after(async () => {
    for (const s of servers) await s.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  // A person, a runner, a workspace and a session with three stored events.
  const ownerId = randomUUID();
  const email = `graceful-stop-${RUN}@graceful-stop.invalid`;
  await db.user.create({ data: { id: ownerId, email, name: 'stopper', role: 'MEMBER', passwordHash: 'x' } });
  const runnerId = randomUUID();
  await db.runner.create({ data: { id: runnerId, ownerId, name: 'a runner', tokenHash: `graceful-stop-${runnerId}` } });
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `orbit ${RUN}`, enabled: true } });
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: 'a stopping apiserver',
      prompt: 'stop', provider: 'claude', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER, numTurns: 1,
      engineTurnActive: false, runtimeSessionId: randomUUID(), startedAt: new Date(), status: RunStatus.RUNNING,
    },
  });
  const store = (seq: number) =>
    db.runEvent.create({ data: { sessionId, seq, type: 'assistant', payload: { text: `event ${seq}` } as never } });
  for (const seq of [1, 2, 3]) await store(seq);

  const jwtSecret = `graceful-stop-${randomUUID()}`;
  const token = await new JwtService({ secret: jwtSecret }).signAsync({ sub: ownerId, email });
  const { privateKey } = generateKeyPairSync('ed25519');
  const link = (port: number) => ({
    RUNNER_LINK_SIGNING_KEY: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64'),
    RUNNER_LINK_URL: 'wss://link.graceful-stop.invalid',
    RUNNER_LINK_GATEWAY_TOKEN: GATEWAY_TOKEN,
    RUNNER_LINK_INTERNAL_PORT: String(port),
    RUNNER_LINK_INTERNAL_HOST: '127.0.0.1',
  });
  const linkPort = await freePort();
  const stopping = await startApiserver(url, jwtSecret, link(linkPort));
  servers.push(stopping);
  const other = await startApiserver(url, jwtSecret, link(await freePort()));
  servers.push(other);
  await until('the link listener opened', () => stopping.output().includes(`runner link calls are served on 127.0.0.1:${linkPort}`), 30_000);

  // The stream, caught up to seq 1..3 and following.
  const stream = openStream(stopping.port, sessionId, 0, token);
  await until('the stream replayed the stored events', () => stream.seqs.length === 3);
  // A connection busy with a request: its headers sent, its body not yet.
  const busy = await KeptAliveConnection.open(stopping.port);
  assert.equal((await busy.request('GET', '/api/auth/setup-status')).status, 200, 'it served a request before');
  const body = JSON.stringify({ email, password: 'not the password' });
  busy.send(`POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0, 10)}`);
  // An idle connection on each listener.
  const idle = await KeptAliveConnection.open(stopping.port);
  assert.equal((await idle.request('GET', '/api/auth/setup-status')).status, 200);
  const idleLink = await KeptAliveConnection.open(linkPort);
  assert.equal((await idleLink.request('GET', REVOCATIONS, { Authorization: `Bearer ${GATEWAY_TOKEN}` })).status, 200);
  await sleep(300);

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) =>
    stopping.child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
  const began = Date.now();
  stopping.child.kill('SIGTERM');

  await until('the public listener refuses new connections', () => refused(stopping.port));
  await until('the link listener refuses new connections', () => refused(linkPort));
  await until('the idle connection is closed', () => idle.gone !== null);
  await until('the idle link connection is closed', () => idleLink.gone !== null);
  await until('the stream ended', () => stream.ended() !== null);
  assert.equal(stream.ended(), 'complete', 'the stream ended as a whole answer, which a client reads as "open it again"');
  assert.equal(busy.gone, null, 'the busy connection is still open for its answer');

  // The rest of the body, after the stop began: the request is answered, and its connection closed after it.
  busy.send(body.slice(10));
  const answer = await busy.answer(5_000);
  assert.ok(answer.status < 500, `the busy request was answered: ${answer.status} ${answer.body}`);
  assert.equal(answer.headers.connection, 'close');
  await until('the busy connection closed after its answer', () => busy.gone !== null, 3_000);

  const { code, signal, at } = await exited;
  const took = at - began;
  assert.equal(signal, null, `the apiserver was ended by ${signal}:\n${stopping.output().slice(-4_000)}`);
  assert.equal(code, 0, `the apiserver exited ${code}:\n${stopping.output().slice(-4_000)}`);
  assert.ok(took < STOP_MS, `the stop took ${took} ms`);
  // It stayed, refusing connections, rather than vanish while callers still had its address (graceful-stop.ts, step 6).
  assert.ok(took >= LINGER_MS - 100, `the apiserver exited ${took} ms after SIGTERM, before LINGER_MS (${LINGER_MS} ms)`);
  assert.match(stopping.output(), /SIGTERM: stopping; no new connections, \d+ request\(s\) in flight, streams ending/);
  assert.match(stopping.output(), /every request answered/);
  assert.match(stopping.output(), /stopped in \d+ ms/);

  // Stored while no stream was open; the client opens it again on the other apiserver from the last seq it had.
  await store(4);
  const reopened = openStream(other.port, sessionId, Math.max(...stream.seqs), token);
  t.after(() => reopened.close());
  await until('the reopened stream got the event stored meanwhile', () => reopened.seqs.length === 1);
  assert.deepEqual([...stream.seqs, ...reopened.seqs], [1, 2, 3, 4], 'every stored event once, none missed');
});
