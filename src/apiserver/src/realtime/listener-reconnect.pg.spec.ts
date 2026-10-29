/**
 * THE APISERVER A PERSON WATCHES FROM LOSES ITS LISTEN CONNECTION WHILE ANOTHER ONE STORES THE SESSION'S BATCHES.
 *
 * `build/main.js` twice — the whole AppModule, as the container starts it — over one database that
 * `scripts/run-pg-spec.sh` migrates from empty. With several apiservers a runner's event batches are stored by whichever
 * apiserver its call reaches, and each one tells the others on one dedicated LISTEN connection; all of a session's
 * streams are on one apiserver, the holder (docs/self-hosting.md, "Several apiservers"). What is announced while the
 * holder's LISTEN connection is down never reaches it, and PostgreSQL keeps none of it (realtime.service.ts,
 * listenerBack). The spec ends that connection as an administrator would (pg_terminate_backend), and the holder loads a
 * preload (NODE_OPTIONS=--require) that holds its LISTEN after the connect that follows until the spec lets it go: the
 * spec decides what is stored while it is down.
 *
 *   1. One apiserver: batches stored on it while its listener is down reach its streams at once, in order, and no
 *      stream re-fetches, as before. (1b) When the listener is back, it logs how long it was down and that no other
 *      apiserver ran.
 *   2. Two: the other apiserver stores batches of two sessions while the holder's listener is down, and the holder's
 *      streams receive none of them. When it is back, every stream open on the holder, of those sessions and of a third
 *      that missed nothing, is told to re-fetch (`resync`) once; the owner's control stream there gets each session's
 *      row rebuilt from the database; the holder logs how long and how many sessions, never an event. The client's
 *      re-fetch (a tail page, then the stream from its newest seq) has every seq, and later batches arrive as before.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/realtime/listener-reconnect.pg.spec.ts
 *
 * Not destructive: every row belongs to an account this run creates. The unit twin is realtime-listener-back.spec.ts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunEventType, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
/** In every event's text, so that a log line quoting an event would be found out. */
const CONTENT = `reply-text-${RUN}`;
/** About a kilobyte an event: twelve of them do not fit a notification (MAX_NOTIFY_BYTES, 7000), so they are announced
 *  by their seq range and read back. */
const BULK = 'x'.repeat(1_000);
/** Each apiserver's connections are named so (PGAPPNAME), and its listener is the one whose last statement is this. */
const LAST_LISTEN = 'LISTEN orbit_runner_wake';

/**
 * Loaded into the holder. Its listener's first LISTEN goes through; each one after it — the connect after a lost
 * connection — waits while LISTENER_RECONNECT_HOLD exists, and is journaled to LISTENER_RECONNECT_JOURNAL. Nothing else
 * sends `LISTEN orbit_event`, so nothing else is touched.
 */
const HOLD_PRELOAD = `'use strict';
const fs = require('node:fs');
const pg = require(require.resolve('pg', { paths: [process.cwd()] }));
const hold = process.env.LISTENER_RECONNECT_HOLD;
const journal = process.env.LISTENER_RECONNECT_JOURNAL;
let listens = 0;
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (config, ...rest) {
  if (config !== 'LISTEN orbit_event') return query.call(this, config, ...rest);
  listens += 1;
  if (listens === 1) return query.call(this, config, ...rest);
  fs.appendFileSync(journal, JSON.stringify({ listen: listens, held: fs.existsSync(hold) }) + '\\n');
  return new Promise((resolve, reject) => {
    const wait = () => {
      if (fs.existsSync(hold)) return void setTimeout(wait, 50);
      query.call(this, config, ...rest).then(resolve, reject);
    };
    wait();
  });
};
`;

/** An SSE stream's frames as they arrive, the server's keepalives left out. */
interface Stream {
  frames: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  close(): void;
}

function openStream(server: Apiserver, route: string, bearer: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const frames: Stream['frames'] = [];
    const req = http.request(
      { host: '127.0.0.1', port: server.port, path: route, method: 'GET', agent: false,
        headers: { authorization: `Bearer ${bearer}`, accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${route} answered ${res.statusCode}`));
          return;
        }
        let pending = '';
        res.setEncoding('utf8');
        res.on('error', () => undefined);
        res.on('data', (chunk: string) => {
          pending += chunk;
          for (let end = pending.indexOf('\n\n'); end >= 0; end = pending.indexOf('\n\n')) {
            const data = pending.slice(0, end).split('\n').filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim()).join('\n');
            pending = pending.slice(end + 2);
            if (!data) continue;
            const frame = JSON.parse(data) as Record<string, unknown>;
            if (frame.type !== 'ping') frames.push(frame);
          }
        });
        resolve({ frames, close: () => req.destroy() });
      },
    );
    req.on('error', (error) => reject(error));
    req.end();
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

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** The stored events a stream received, by seq, in the order it received them. */
const seqsOf = (stream: Stream): number[] => stream.frames.filter((f) => f.seq > 0).map((f) => f.seq as number);
const resyncsOf = (stream: Stream): number => stream.frames.filter((f) => f.type === RunEventType.RESYNC).length;
/** A server's lines about its listener coming back, as `LEVEL text`. */
const backLines = (server: Apiserver): string[] => server.output().split('\n')
  .map((line) => /\s(LOG|WARN|ERROR) \[Realtime\] (LISTEN\/NOTIFY back after .*)$/.exec(line))
  .filter((m): m is RegExpExecArray => m !== null)
  .map((m) => `${m[1]} ${m[2]}`);
const lostLines = (server: Apiserver): number => server.output().split('\n')
  .filter((line) => line.includes('[Realtime] listener connection error')).length;

test('streams on an apiserver whose LISTEN connection was down re-fetch once it is back, when another apiserver ran', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  const dir = mkdtempSync(path.join(tmpdir(), 'listener-reconnect-'));
  const preload = path.join(dir, 'hold-preload.js');
  writeFileSync(preload, HOLD_PRELOAD);
  const hold = path.join(dir, 'hold');
  const journalPath = path.join(dir, 'journal.jsonl');
  writeFileSync(journalPath, '');
  const servers: Apiserver[] = [];
  const streams: Stream[] = [];
  // What PostgreSQL delivers on the channel the apiservers announce stored batches on: the notices were sent.
  const listener = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await listener.connect();
  const notices: Array<{ r: string; b?: Array<{ seq: number }>; f?: number; t?: number }> = [];
  listener.on('notification', (msg) => notices.push(JSON.parse(msg.payload ?? '{}')));
  await listener.query('LISTEN orbit_event');
  t.after(async () => {
    for (const stream of streams) stream.close();
    for (const server of servers) await server.stop();
    await listener.end().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  // ── the owner and their machine ──────────────────────────────────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  const owner = { email: `owner-${RUN}@listener-reconnect.invalid`, password: `pw-${RUN}` };
  await prisma.user.create({
    data: { id: ownerId, email: owner.email, name: 'The owner', passwordHash: hashPassword(owner.password) },
  });
  const runnerId = randomUUID();
  const runnerToken = `listener-reconnect-${randomUUID()}`;
  await prisma.runner.create({
    data: {
      id: runnerId, ownerId, name: `machine ${RUN}`, tokenHash: sha256(runnerToken), maxConcurrent: 8,
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: ['session-worktree-ops-v1'],
      capabilitiesReportedAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  await prisma.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `checkout ${RUN}`, enabled: true, workDir: dir },
  });
  /** A session on that machine, running a turn: its events are published as they are stored. */
  const session = async (label: string) => {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: label, prompt: 'fix the login flow',
        provider: 'claude', status: RunStatus.RUNNING, engineTurnActive: true, dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(), runtimeSessionId: randomUUID(),
      },
    });
    await prisma.conversationTurn.create({
      data: {
        sessionId: id, seq: 1, clientTurnId: `${label}-${randomUUID()}`, kind: 'message', content: 'fix the login flow',
        status: 'IN_FLIGHT', deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 300_000),
        leaseGeneration: randomUUID(),
      },
    });
    return id;
  };
  const lone = await session('one apiserver');
  const a = await session('missed two batches');
  const b = await session('missed one batch');
  const c = await session('missed nothing');

  /** The runner's batch of replies at these seqs, stored through `server`. `big` makes it too big to ride along. */
  const store = async (server: Apiserver, sessionId: string, seqs: number[], opts: { big?: boolean; last?: string } = {}) => {
    const events = seqs.map((seq, i) => ({
      seq, type: RunEventType.ASSISTANT, ts: new Date().toISOString(),
      payload: { text: i === seqs.length - 1 && opts.last ? opts.last : `${CONTENT} #${seq}${opts.big ? ` ${BULK}` : ''}` },
    }));
    const reply = await call(server, 'POST', `/api/runner/sessions/${sessionId}/events`, runnerToken, { events });
    assert.equal(reply.status, 202, `the batch at ${seqs[0]}-${seqs.at(-1)}: ${reply.text}`);
  };
  /** Once PostgreSQL has delivered the notification of the batch starting at `seq`. */
  const heard = (sessionId: string, seq: number) => until(
    () => (notices.some((n) => n.r === sessionId && (n.f === seq || n.b?.[0]?.seq === seq)) ? true : null), 10_000,
  );
  const journal = () => readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { listen: number; held: boolean });

  // ── the holder: the apiserver the person's streams reach, whose LISTEN connection the spec ends ─────────────────────────
  const jwtSecret = `listener-reconnect-${randomUUID()}`;
  const holderName = `holder-${RUN}`;
  const holder = await startApiserver(url, jwtSecret, {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${preload}`.trim(),
    PGAPPNAME: holderName,
    LISTENER_RECONNECT_HOLD: hold,
    LISTENER_RECONNECT_JOURNAL: journalPath,
  });
  servers.push(holder);
  const signedIn = await call(holder, 'POST', '/api/auth/login', undefined, owner);
  assert.equal(signedIn.status, 201, `the owner signs in: ${signedIn.text}`);
  const token = signedIn.json.accessToken as string;
  const watch = async (server: Apiserver, route: string) => {
    const stream = await openStream(server, route, token);
    streams.push(stream);
    return stream;
  };
  assert.ok(await until(() => (holder.output().includes('LISTEN/NOTIFY active') ? true : null), 10_000), 'the holder listens');

  /** How many times the holder has said it listens: once as it starts, and once each time its listener is back. */
  const listening = () => holder.output().split('\n').filter((line) => line.includes('[Realtime] LISTEN/NOTIFY active')).length;
  /** The holder's line about its listener coming back the `n`th time, counted from 0, once it has written it. */
  const backLine = (n: number, ms = 10_000) => until(() => backLines(holder)[n] ?? null, ms);

  /**
   * End the holder's LISTEN connection, and hold it from listening again until `release`: returns once the holder has
   * seen it go. `release` returns once it listens again, with how long the spec held it.
   */
  const dropListener = async () => {
    const lost = lostLines(holder);
    const listened = listening();
    const listens = journal().length;
    writeFileSync(hold, '');
    const ended = await sql.query<{ pid: number; ended: boolean }>(
      `SELECT pid, pg_terminate_backend(pid) AS ended FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1 AND query = $2`,
      [holderName, LAST_LISTEN],
    );
    assert.deepEqual(ended.rows.map((row) => row.ended), [true], 'exactly the holder\'s listener connection ended');
    assert.ok(await until(() => (lostLines(holder) > lost ? true : null), 10_000), 'the holder saw it go');
    const downSince = Date.now();
    return {
      async release(): Promise<number> {
        assert.ok(await until(() => (journal().length > listens ? true : null), 10_000), 'it connected again, and waits to LISTEN');
        assert.equal(journal().at(-1)!.held, true);
        const heldMs = Date.now() - downSince;
        rmSync(hold);
        assert.ok(await until(() => (listening() > listened ? true : null), 10_000), `it listens again:\n${holder.output().slice(-3_000)}`);
        return heldMs;
      },
    };
  };

  let loneHeldMs = 0;
  await t.test('(1) one apiserver: batches stored meanwhile reach its streams at once, in order, and nothing re-fetches', async () => {
    const stream = await watch(holder, `/api/sessions/${lone}/events`);
    await store(holder, lone, [1, 2]);
    assert.ok(await until(() => (seqsOf(stream).length >= 2 ? true : null), 10_000));

    const drop = await dropListener();
    await store(holder, lone, [3, 4]);
    await store(holder, lone, range(5, 16), { big: true });
    assert.ok(await until(() => (seqsOf(stream).length >= 16 ? true : null), 10_000), 'at once, though nothing listens');
    loneHeldMs = await drop.release();
    await backLine(0, 5_000); // what the listener coming back sends, it has sent once it says so

    await store(holder, lone, [17, 18]);
    await until(() => (seqsOf(stream).length >= 18 ? true : null), 10_000);
    await sleep(500);
    assert.deepEqual(seqsOf(stream), range(1, 18), 'every seq once, in order, as before');
    assert.equal(resyncsOf(stream), 0);
    stream.close();
  });

  await t.test('(1b) once its listener is back, it logs how long it was down and that no other apiserver ran', async (st) => {
    const line = await backLine(0);
    st.diagnostic(`held ${loneHeldMs} ms; the holder: ${line}`);
    assert.ok(line, `the holder says it is back:\n${holder.output().slice(-3_000)}`);
    assert.match(line, /^LOG LISTEN\/NOTIFY back after (\d+) ms without it: no other apiserver ran meanwhile, so nothing was missed and no stream was told to re-fetch$/);
    assert.ok(Number(/after (\d+) ms/.exec(line)![1]) >= loneHeldMs - 100, 'how long it was down, from when it was lost');
  });

  // ── the other apiserver, which stores the batches ───────────────────────────────────────────────────────────────────
  const storer = await startApiserver(url, jwtSecret, { PGAPPNAME: `storer-${RUN}` });
  servers.push(storer);

  await t.test('(2) two: every stream on the holder re-fetches once, the owner\'s rows are rebuilt, and no seq is missing', async (st) => {
    // The storer has written its row in apiserver_process, which is how the holder learns that it runs.
    assert.ok(await until(async () => ((await prisma.apiserverProcess.count()) >= 2 ? true : null), 20_000));
    const control = await watch(holder, '/api/events');
    const views = { a1: await watch(holder, `/api/sessions/${a}/events`), a2: await watch(holder, `/api/sessions/${a}/events`),
      b: await watch(holder, `/api/sessions/${b}/events`), c: await watch(holder, `/api/sessions/${c}/events`) };
    for (const id of [a, b, c]) await store(storer, id, [1, 2]);
    for (const view of Object.values(views)) {
      assert.ok(await until(() => (seqsOf(view).length >= 2 ? true : null), 10_000), 'before: the storer\'s batches arrive');
    }

    const drop = await dropListener();
    const lastOf = { a: `The last reply A stored meanwhile (${RUN})`, b: `The last reply B stored meanwhile (${RUN})` };
    await store(storer, a, [3, 4]);
    await store(storer, a, range(5, 16), { big: true, last: lastOf.a });
    await store(storer, b, [3, 4], { last: lastOf.b });
    assert.ok(await heard(a, 3) && await heard(a, 5) && await heard(b, 3), 'the storer announced every batch');
    await sleep(500);
    for (const [name, view] of Object.entries(views)) {
      assert.deepEqual(seqsOf(view), [1, 2], `${name}: none of them reached the holder's streams`);
    }
    const before = control.frames.length;
    const heldMs = await drop.release();

    for (const view of Object.values(views)) {
      assert.ok(await until(() => (resyncsOf(view) > 0 ? true : null), 10_000), 'every open stream is told to re-fetch');
    }
    await sleep(500);
    const line = await backLine(1);
    st.diagnostic(`held ${heldMs} ms; the holder: ${line}\nthe streams: ${JSON.stringify(Object.fromEntries(
      Object.entries(views).map(([name, view]) => [name, view.frames.map((f) => `${f.seq}:${f.type}`)])))}`);
    for (const [name, view] of Object.entries(views)) {
      assert.equal(resyncsOf(view), 1, `${name}: once`);
      assert.deepEqual(seqsOf(view), [1, 2], `${name}: and nothing else`);
    }
    assert.ok(line, `the holder says it is back:\n${holder.output().slice(-3_000)}`);
    assert.match(line, /^LOG LISTEN\/NOTIFY back after (\d+) ms without it: 1 other apiserver\(s\) ran meanwhile and what they announced did not reach this one, so this apiserver's streams of 3 session\(s\) were told to re-fetch$/);
    assert.ok(Number(/after (\d+) ms/.exec(line)![1]) >= heldMs - 100);
    assert.equal(holder.output().includes(CONTENT), false, 'no event reached the log');
    assert.equal(holder.output().includes(lastOf.a) || holder.output().includes(lastOf.b), false);
    assert.deepEqual(backLines(storer), [], 'the storer\'s listener never went');

    // The owner's lists on the holder: each session's row, rebuilt from the database, whose preview only the missed batch
    // carried.
    const updated = (id: string) => until(() => control.frames.slice(before).find((f) => f.type === 'session.updated'
      && [id, uuidToBase62(id)].some((name) => name === f.sessionId || name === f.data?.id)) ?? null, 10_000);
    const rows = { a: await updated(a), b: await updated(b), c: await updated(c) };
    st.diagnostic(`the owner's lists: ${JSON.stringify(Object.fromEntries(Object.entries(rows)
      .map(([name, row]) => [name, row && `${row.type} lastAssistantText=${JSON.stringify(row.data?.lastAssistantText)}`])))}`);
    assert.equal(rows.a?.data.lastAssistantText, lastOf.a);
    assert.equal(rows.b?.data.lastAssistantText, lastOf.b);
    assert.ok(rows.c, 'and the row of the session that missed nothing');

    // The client's re-fetch, as each client does on `resync`: a tail page, then the stream again from its newest seq.
    const expected = { [a]: range(1, 16), [b]: range(1, 4), [c]: range(1, 2) };
    const again: Record<string, Stream> = {};
    for (const id of [a, b, c]) {
      const page = await call(holder, 'GET', `/api/sessions/${id}/events/page?tail=200`, token);
      assert.equal(page.status, 200, page.text);
      const paged = (page.json.events as Array<{ seq: number }>).map((e) => e.seq);
      assert.deepEqual(paged, expected[id], 'the tail page has every seq, the missed batches among them');
      again[id] = await watch(holder, `/api/sessions/${id}/events?sinceSeq=${paged.at(-1)}`);
    }
    await store(storer, a, [17, 18]);
    await store(storer, b, range(5, 16), { big: true });
    await until(() => (seqsOf(again[a]).length >= 2 && seqsOf(again[b]).length >= 12 ? true : null), 10_000);
    await sleep(500);
    assert.deepEqual(seqsOf(again[a]), [17, 18], 'and the streams go on from there');
    assert.deepEqual(seqsOf(again[b]), range(5, 16));
    for (const stream of Object.values(again)) assert.equal(resyncsOf(stream), 0);
  });
});
