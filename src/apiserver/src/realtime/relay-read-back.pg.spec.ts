/**
 * A BATCH ONE APISERVER STORED, READ BACK BY THE APISERVER A PERSON WATCHES IT FROM, WHEN THAT READ FAILS.
 *
 * `build/main.js` twice — the whole AppModule, as the container starts it — over one database that
 * `scripts/run-pg-spec.sh` migrates from empty. With several apiservers a runner's event batches are stored by whichever
 * apiserver its call reaches, while all of a session's streams are on one (docs/self-hosting.md, "Several apiservers").
 * A batch too big for its notification is announced by its seq range, and the apiserver holding the streams reads it
 * back from run_event (realtime.service.ts, readBack). That apiserver, the holder, loads a preload
 * (NODE_OPTIONS=--require) that fails the read-back's statements, and no others, for the sessions it is told to, as a
 * dropped connection fails them:
 *
 *   1. One apiserver: a session's batches stored and watched on it are never read back, though every read of them would
 *      fail, and its stream receives every seq in order, as before.
 *   2. Two: the read fails once. The stream on the holder receives every seq in order.
 *   3. It fails twice, each failure taking two seconds. What arrives meanwhile, from the other apiserver or stored by the
 *      holder itself, waits behind it; then the stream receives every seq in order.
 *   4. It fails every time. The holder logs each failure with the session, the seqs and the error, never the events,
 *      gives up, and tells the stream to re-fetch (`resync`) and the owner's lists to re-read the row: the owner's control
 *      stream there gets the session's summary rebuilt from the database. The client's re-fetch (a tail page, then the
 *      stream from its newest seq) has every seq.
 *
 * The batches go in over HTTPS (POST /runner/sessions/:id/events). Over the runner link the merged call's transaction
 * sends the same notification (runEventBatchNotice), and the holder reads it back the same way.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/realtime/relay-read-back.pg.spec.ts
 *
 * Not destructive: every row belongs to an account this run creates. The unit twin is realtime-read-back.spec.ts.
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
/** About a kilobyte an event: twelve of them do not fit a notification (MAX_NOTIFY_BYTES, 7000), so they are read back. */
const BULK = 'x'.repeat(1_000);

/**
 * Loaded into the holder. The two statements its read-back sends (relayStoredBatch's range, and the oversized event's
 * one seq), for the sessions in RELAY_READ_BACK_FAULTS, fail as a dropped connection does: the first `fails` times
 * (every time when negative), each after `holdMs`. Every such read is written to RELAY_READ_BACK_JOURNAL. Nothing else
 * is touched: an ingest runs in a transaction, and the stream's replay and the tail page read run_event by other SQL.
 */
const FAULT_PRELOAD = `'use strict';
const fs = require('node:fs');
const pg = require(require.resolve('pg', { paths: [process.cwd()] }));
const plan = JSON.parse(process.env.RELAY_READ_BACK_FAULTS);
const journal = process.env.RELAY_READ_BACK_JOURNAL;
const RANGE = '"run_event"."seq" >= $2 AND "public"."run_event"."seq" <= $3 AND "public"."run_event"."type" NOT IN (';
const ONE = '"run_event"."seq" = $2) AND 1=1) LIMIT';
const reads = new Map();
const query = pg.Pool.prototype.query;
pg.Pool.prototype.query = function (config, ...rest) {
  const text = config && typeof config === 'object' ? config.text : config;
  const values = config && typeof config === 'object' ? config.values : rest[0];
  const sessionId = Array.isArray(values) ? values[0] : undefined;
  const readBack = typeof text === 'string' && (text.includes(RANGE) || text.includes(ONE));
  if (!readBack || !Object.prototype.hasOwnProperty.call(plan, sessionId)) return query.call(this, config, ...rest);
  const read = (reads.get(sessionId) || 0) + 1;
  reads.set(sessionId, read);
  const { fails, holdMs = 0 } = plan[sessionId];
  const failed = fails < 0 || read <= fails;
  const seqs = text.includes(RANGE) ? [values[1], values[2]] : [values[1]];
  fs.appendFileSync(journal, JSON.stringify({ sessionId, read, seqs, failed }) + '\\n');
  if (!failed) return query.call(this, config, ...rest);
  const dropped = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -104, syscall: 'read' });
  return new Promise((_, reject) => setTimeout(() => reject(dropped), holdMs));
};
`;

interface Journaled {
  sessionId: string;
  read: number;
  seqs: number[];
  failed: boolean;
}

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

test('a batch another apiserver stored reaches the streams on this one in seq order, read again when the read fails', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-read-back-'));
  const preload = path.join(dir, 'fault-preload.js');
  writeFileSync(preload, FAULT_PRELOAD);
  const journalPath = path.join(dir, 'journal.jsonl');
  writeFileSync(journalPath, '');
  const servers: Apiserver[] = [];
  const streams: Stream[] = [];
  // What PostgreSQL delivers on the channel the apiservers announce stored batches on, as the holder hears it.
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
  const owner = { email: `owner-${RUN}@relay-read-back.invalid`, password: `pw-${RUN}` };
  await prisma.user.create({
    data: { id: ownerId, email: owner.email, name: 'The owner', passwordHash: hashPassword(owner.password) },
  });
  const runnerId = randomUUID();
  const runnerToken = `relay-read-back-${randomUUID()}`;
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
  const once = await session('fails once');
  const twice = await session('fails twice');
  const always = await session('fails always');

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
  const journal = (sessionId: string): Journaled[] => readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Journaled).filter((read) => read.sessionId === sessionId);
  /** The holder's lines about reading back this session's events, as `LEVEL text`. */
  const readBackLines = (server: Apiserver, sessionId: string): string[] => server.output().split('\n')
    .map((line) => /\s(LOG|WARN|ERROR) \[Realtime\] (session \S+: .*read(?:ing)? back.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null && m[2].startsWith(`session ${sessionId}: `))
    .map((m) => `${m[1]} ${m[2]}`);

  // ── the holder: the apiserver the person's streams reach, whose read-backs fail as planned ─────────────────────────────
  const jwtSecret = `relay-read-back-${randomUUID()}`;
  const holder = await startApiserver(url, jwtSecret, {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${preload}`.trim(),
    RELAY_READ_BACK_FAULTS: JSON.stringify({
      [lone]: { fails: -1 },
      [once]: { fails: 1 },
      [twice]: { fails: 2, holdMs: 2_000 },
      [always]: { fails: -1 },
    }),
    RELAY_READ_BACK_JOURNAL: journalPath,
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

  await t.test('(1) one apiserver: nothing is read back, and the stream receives every seq in order', async () => {
    const stream = await watch(holder, `/api/sessions/${lone}/events`);
    await store(holder, lone, [1, 2]);
    await store(holder, lone, range(3, 14), { big: true });
    await store(holder, lone, [15, 16]);
    await store(holder, lone, range(17, 28), { big: true });
    await until(() => (seqsOf(stream).length >= 28 ? true : null), 20_000);
    await sleep(500);
    assert.deepEqual(seqsOf(stream), range(1, 28), 'every seq once, in order');
    assert.equal(resyncsOf(stream), 0);
    assert.ok(await heard(lone, 3) && await heard(lone, 17), 'the big batches were announced by their seq range');
    assert.deepEqual(journal(lone), [], 'and never read back, though every read of them would have failed');
    assert.deepEqual(readBackLines(holder, lone), []);
  });

  // ── the other apiserver, which stores the batches ───────────────────────────────────────────────────────────────────
  const storer = await startApiserver(url, jwtSecret);
  servers.push(storer);

  await t.test('(2) the read fails once: the stream on the holder receives every seq in order', async (st) => {
    const stream = await watch(holder, `/api/sessions/${once}/events`);
    await store(storer, once, range(1, 12), { big: true });
    await store(storer, once, [13, 14]);
    await store(storer, once, range(15, 26), { big: true });
    await until(() => (seqsOf(stream).length >= 26 ? true : null), 20_000);
    await sleep(500);
    assert.deepEqual(seqsOf(stream), range(1, 26), 'every seq once, in order');
    assert.equal(resyncsOf(stream), 0);
    assert.deepEqual(journal(once).map((r) => [r.seqs, r.failed]), [[[1, 12], true], [[1, 12], false], [[15, 26], false]]);
    const lines = readBackLines(holder, once);
    st.diagnostic(`the holder's reads: ${JSON.stringify(journal(once))}\nits log:\n${lines.join('\n')}`);
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0], new RegExp(`^WARN session ${once}: could not read back seq 1-12, stored by another apiserver \\(attempt 1 of 4: .+\\); trying again in 250 ms$`));
    assert.equal(lines[1], `LOG session ${once}: read back seq 1-12, stored by another apiserver, on attempt 2 of 4`);
  });

  await t.test('(3) the read fails twice, two seconds each: what arrives meanwhile waits, then every seq in order', async (st) => {
    const stream = await watch(holder, `/api/sessions/${twice}/events`);
    await store(storer, twice, range(1, 12), { big: true });
    assert.ok(await until(() => (journal(twice).length > 0 ? true : null), 10_000), 'the holder reads the batch back');
    await store(storer, twice, [13, 14]); // from the other apiserver, whole
    assert.ok(await heard(twice, 13));
    await sleep(200);
    await store(holder, twice, [15, 16]); // stored by the holder itself
    await store(storer, twice, range(17, 28), { big: true }); // another batch to read back
    assert.ok(await heard(twice, 17));
    await sleep(200);
    assert.deepEqual(journal(twice).map((r) => r.failed), [true], 'the read is still failing');
    assert.deepEqual(seqsOf(stream), [], 'and nothing has overtaken the batch it reads');
    await until(() => (seqsOf(stream).length >= 28 ? true : null), 20_000);
    await sleep(500);
    assert.deepEqual(seqsOf(stream), range(1, 28), 'every seq once, in order');
    assert.equal(resyncsOf(stream), 0);
    assert.deepEqual(journal(twice).map((r) => [r.seqs, r.failed]),
      [[[1, 12], true], [[1, 12], true], [[1, 12], false], [[17, 28], false]]);
    const lines = readBackLines(holder, twice);
    st.diagnostic(`the holder's reads: ${JSON.stringify(journal(twice))}\nits log:\n${lines.join('\n')}`);
    assert.equal(lines.length, 3, lines.join('\n'));
    assert.match(lines[0], /\(attempt 1 of 4: .+\); trying again in 250 ms$/);
    assert.match(lines[1], /\(attempt 2 of 4: .+\); trying again in 1000 ms$/);
    assert.equal(lines[2], `LOG session ${twice}: read back seq 1-12, stored by another apiserver, on attempt 3 of 4`);
  });

  await t.test('(4) the read fails every time: logged, given up, the stream re-fetches and the owner\'s list row is rebuilt', async (st) => {
    const control = await watch(holder, '/api/events');
    const stream = await watch(holder, `/api/sessions/${always}/events`);
    await store(storer, always, [1, 2]);
    await until(() => (seqsOf(stream).length >= 2 ? true : null), 10_000);
    const before = control.frames.length;
    const last = `The last reply of the batch (${RUN})`;
    await store(storer, always, range(3, 14), { big: true, last });

    const resynced = await until(() => (resyncsOf(stream) > 0 ? true : null), 20_000);
    assert.ok(resynced, 'the stream is told to re-fetch');
    assert.deepEqual(seqsOf(stream), [1, 2], 'the batch itself never reached it');
    assert.deepEqual(journal(always).map((r) => [r.seqs, r.failed]), Array(4).fill([[3, 14], true]), 'after four reads');
    const lines = readBackLines(holder, always);
    st.diagnostic(`the holder's reads: ${JSON.stringify(journal(always))}\nits log:\n${lines.join('\n')}`);
    assert.equal(lines.length, 4, lines.join('\n'));
    for (const [i, wait] of [250, 1000, 3000].entries()) {
      assert.match(lines[i], new RegExp(`^WARN session ${always}: could not read back seq 3-14, stored by another apiserver \\(attempt ${i + 1} of 4: .+\\); trying again in ${wait} ms$`));
    }
    assert.match(lines[3], new RegExp(`^ERROR session ${always}: gave up reading back seq 3-14, stored by another apiserver, after 4 attempt\\(s\\) in \\d+ ms \\(.+\\); told this apiserver's streams of the session to re-fetch$`));
    assert.equal(holder.output().includes(CONTENT), false, 'no event reached the log');
    assert.equal(holder.output().includes(last), false);

    // The owner's lists on the holder: the session's row, rebuilt from the database, whose preview only the batch carried.
    const names = [always, uuidToBase62(always)];
    const updated = await until(() => control.frames.slice(before).find((f) => f.type === 'session.updated'
      && (names.includes(f.sessionId) || names.includes(f.data?.id))) ?? null, 10_000);
    assert.ok(updated, `a session.updated after the give-up: ${JSON.stringify(control.frames.slice(before))}`);
    assert.equal(updated.data.lastAssistantText, last);
    st.diagnostic(`the stream: ${JSON.stringify(stream.frames.map((f) => `${f.seq}:${f.type}`))}; the owner's lists: ${updated.type} `
      + `with lastAssistantText ${JSON.stringify(updated.data.lastAssistantText)}`);

    // The client's re-fetch, as each client does on `resync`: a tail page, then the stream again from its newest seq.
    const page = await call(holder, 'GET', `/api/sessions/${always}/events/page?tail=200`, token);
    assert.equal(page.status, 200, page.text);
    const paged = (page.json.events as Array<{ seq: number }>).map((e) => e.seq);
    assert.deepEqual(paged, range(1, 14), 'the tail page has the batch the stream missed');
    const again = await watch(holder, `/api/sessions/${always}/events?sinceSeq=${paged.at(-1)}`);
    await store(storer, always, [15, 16]);
    await until(() => (seqsOf(again).length >= 2 ? true : null), 10_000);
    await sleep(500);
    assert.deepEqual(seqsOf(again), [15, 16], 'and the stream goes on from there');
    assert.equal(resyncsOf(again), 0);
  });
});
