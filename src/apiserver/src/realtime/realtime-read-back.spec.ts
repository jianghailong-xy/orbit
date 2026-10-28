import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunEventType, type NormalizedRunEvent } from '@orbit/shared';
import type { Subject } from 'rxjs';

import { RealtimeService } from './realtime.service';

/**
 * Events another replica stored, read back here because their notification carried only where they are (a big batch's
 * seq range, an oversized event's seq), when the read fails (RealtimeService.readBack; docs/runner-link-design.md §15.3,
 * prerequisite (f)). The read is tried again at most three times over at most ten seconds, and the session's later
 * events wait behind it, so its streams here receive them in seq order. Given up, the session's streams here are told to
 * re-fetch (`resync`) and its owner's lists here to re-read its row (session_updated). Each failure is logged with the
 * session, the seqs and the error, never the events. The two-process twin is relay-read-back.pg.spec.ts.
 */

const SESSION = '0190a0b0-0000-7000-8000-0000000000c1';
const OTHER_REPLICA = '0190a0b0-0000-7000-8000-0000000000d1';
const TURN = '0190a0b0-0000-7000-8000-0000000000e1';
const TS = '2026-10-28T10:00:00.000Z';
/** In every event's text, so a log line that quoted an event would be found out. */
const CONTENT = 'the-reply-text';

function ev(seq: number, type: string = RunEventType.ASSISTANT): NormalizedRunEvent {
  return { seq, type: type as RunEventType, payload: { text: `${CONTENT} #${seq}` }, turnId: TURN, ts: TS };
}

const PRISMA_FAILURE = Object.assign(
  new Error('\nInvalid `prisma.runEvent.findMany()` invocation:\n\n\nServer has closed the connection.'),
  { code: 'P1017' },
);

/**
 * run_event as the other replica left it, read through the two queries a read-back makes. `fails` is how many reads fail
 * before they answer, or 'always', or 'never-answers' for reads that hang.
 */
function database(seqs: number[], fails: number | 'always' | 'never-answers') {
  const createdAt = new Date(TS);
  const rows = seqs.map((seq) => ({ ...ev(seq), type: RunEventType.ASSISTANT as string, createdAt }));
  const reads: string[] = [];
  const notified: string[] = [];
  const answer = <T>(rowsFor: () => T): Promise<T> => {
    if (fails === 'never-answers') return new Promise<T>(() => undefined);
    if (fails === 'always' || reads.length <= fails) return Promise.reject(PRISMA_FAILURE);
    return Promise.resolve(rowsFor());
  };
  const prisma = {
    $executeRawUnsafe: async (_sql: string, _channel: string, payload: string) => {
      notified.push(payload);
      return 0;
    },
    runEvent: {
      findMany: (query: { where: { seq: { gte: number; lte: number } } }) => {
        const { gte, lte } = query.where.seq;
        reads.push(`${gte}-${lte}`);
        return answer(() => rows.filter((r) => r.seq >= gte && r.seq <= lte));
      },
      findUnique: (query: { where: { sessionId_seq: { seq: number } } }) => {
        const { seq } = query.where.sessionId_seq;
        reads.push(`${seq}`);
        return answer(() => rows.find((r) => r.seq === seq) ?? null);
      },
    },
  };
  return { prisma, reads, notified };
}

/** A replica whose log lines, and whatever reaches its hub and its streams of the session, are collected. */
function replica(db: ReturnType<typeof database>) {
  const realtime = new RealtimeService(db.prisma as never, {} as never);
  const lines: string[] = [];
  (realtime as unknown as { log: unknown }).log = {
    log: (line: string) => lines.push(`LOG ${line}`),
    warn: (line: string) => lines.push(`WARN ${line}`),
    error: (line: string) => lines.push(`ERROR ${line}`),
  };
  const streamed: NormalizedRunEvent[] = [];
  realtime.streamForRun(SESSION).subscribe((event) => streamed.push(event));
  const hub: string[] = [];
  (realtime as unknown as { hub: Subject<{ runId: string; event: NormalizedRunEvent }> }).hub.subscribe(({ runId, event }) => {
    if (runId === SESSION) hub.push(`${event.seq}:${event.type}`);
  });
  const hear = (notice: Record<string, unknown>, from = OTHER_REPLICA): void =>
    (realtime as unknown as { onNotify(channel: string, payload: string): void }).onNotify(
      'orbit_event',
      JSON.stringify({ i: from, r: SESSION, ...notice }),
    );
  return { realtime, lines, streamed, hub, hear };
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const seqsOf = (events: NormalizedRunEvent[]): Array<number | string> =>
  events.map((e) => (e.type === RunEventType.ASSISTANT ? e.seq : `${e.seq}:${e.type}`));
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a read that fails twice is answered on the third, and what arrived behind it follows it in seq order', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const db = database([...range(20, 31), 36], 2);
  const { realtime, lines, streamed, hear } = replica(db);

  hear({ f: 20, t: 31 }); // a big batch, read back
  hear({ b: [ev(32), ev(33)] }); // the next batch, whole
  realtime.publishBatchHere(SESSION, [ev(34), ev(35)]); // one this replica stored itself
  hear({ s: 36 }); // an oversized event, read back
  await settle();
  assert.deepEqual(streamed, [], 'nothing overtakes the batch being read back');
  assert.equal(lines.length, 1);

  t.mock.timers.tick(249);
  await settle();
  assert.deepEqual(db.reads, ['20-31'], 'the second read waits 250 ms');
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(db.reads, ['20-31', '20-31']);
  t.mock.timers.tick(1_000);
  await settle();

  assert.deepEqual(seqsOf(streamed), range(20, 36), 'every seq once, in order');
  assert.deepEqual(db.reads, ['20-31', '20-31', '20-31', '36']);
  assert.deepEqual(lines, [
    `WARN session ${SESSION}: could not read back seq 20-31, stored by another apiserver (attempt 1 of 4: P1017 Server has closed the connection.); trying again in 250 ms`,
    `WARN session ${SESSION}: could not read back seq 20-31, stored by another apiserver (attempt 2 of 4: P1017 Server has closed the connection.); trying again in 1000 ms`,
    `LOG session ${SESSION}: read back seq 20-31, stored by another apiserver, on attempt 3 of 4`,
  ]);

  // Done: the session's events reach its streams at once again.
  realtime.publishBatchHere(SESSION, [ev(37)]);
  assert.deepEqual(seqsOf(streamed).at(-1), 37);
});

test('a read that keeps failing is given up: the streams here re-fetch, the lists re-read the row, and what waited follows', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const db = database([...range(20, 31), ...range(40, 45)], 'always');
  const { realtime, lines, streamed, hub, hear } = replica(db);

  hear({ f: 20, t: 31 });
  hear({ b: [ev(32), ev(33)] });
  hear({ f: 40, t: 45 }); // a second read-back, behind the first
  realtime.publishBatchHere(SESSION, [ev(46)]);
  await settle();
  for (const wait of [250, 1_000, 3_000]) {
    assert.deepEqual(streamed, []);
    t.mock.timers.tick(wait);
    await settle();
  }

  assert.deepEqual(db.reads, ['20-31', '20-31', '20-31', '20-31'],
    'four reads of the first; the second is not read, the re-fetch brings its events');
  assert.deepEqual(seqsOf(streamed), ['0:resync', 32, 33, 46], 'the order to re-fetch, in the batch\'s place');
  assert.deepEqual(hub, ['0:resync', '0:session_updated', '32:assistant', '33:assistant', '46:assistant'],
    'and a session_updated for the owner\'s lists here, which the transcript stream leaves out');
  assert.equal(lines.length, 4);
  assert.match(lines[2], /^WARN .*attempt 3 of 4: P1017 Server has closed the connection\.\); trying again in 3000 ms$/);
  assert.equal(
    lines[3],
    `ERROR session ${SESSION}: gave up reading back seq 20-31, stored by another apiserver, after 4 attempt(s) in 4250 ms (P1017 Server has closed the connection.); told this apiserver's streams of the session to re-fetch`,
  );
  for (const line of lines) assert.equal(line.includes(CONTENT), false, `no event in the log: ${line}`);

  realtime.publishBatchHere(SESSION, [ev(47)]);
  assert.deepEqual(seqsOf(streamed).at(-1), 47, 'nothing waits any more');
});

test('a read that never answers is given up ten seconds after its notice arrived', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const db = database(range(20, 31), 'never-answers');
  const { lines, streamed, hear } = replica(db);

  hear({ f: 20, t: 31 });
  hear({ b: [ev(32)] });
  t.mock.timers.tick(9_999);
  await settle();
  assert.deepEqual([streamed, lines], [[], []]);
  t.mock.timers.tick(1);
  await settle();

  assert.deepEqual(db.reads, ['20-31'], 'no time is left for a second read');
  assert.deepEqual(seqsOf(streamed), ['0:resync', 32]);
  assert.deepEqual(lines, [
    `ERROR session ${SESSION}: gave up reading back seq 20-31, stored by another apiserver, after 1 attempt(s) in 10000 ms (no answer in 10000 ms); told this apiserver's streams of the session to re-fetch`,
  ]);
});

test('with one replica nothing is read back and nothing waits', async () => {
  const db = database([], 'always'); // a read would fail, and be logged
  const { realtime, lines, streamed, hear } = replica(db);
  const big = range(20, 31).map((seq) => ({ ...ev(seq), payload: { text: `${CONTENT} ${'x'.repeat(1_000)}` } }));

  realtime.publishBatch(SESSION, big);
  realtime.publish(SESSION, { ...ev(32), payload: { text: 'y'.repeat(8_000) } });
  assert.deepEqual(seqsOf(streamed), range(20, 32), 'at once, as they were published');
  assert.equal(db.notified.length, 2);
  for (const payload of db.notified) {
    const { i, ...notice } = JSON.parse(payload) as Record<string, unknown>;
    assert.ok('f' in notice || 's' in notice, 'announced by where they are stored');
    hear(notice, i as string); // its own notification, back from PostgreSQL
  }
  await settle();
  assert.deepEqual(db.reads, []);
  assert.deepEqual(lines, []);
  assert.deepEqual(seqsOf(streamed), range(20, 32));
});
