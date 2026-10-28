import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunEventType, type NormalizedRunEvent } from '@orbit/shared';
import type { Subject } from 'rxjs';

import type { ControlPlaneLeader } from './control-plane-leader';
import { RealtimeService } from './realtime.service';

/**
 * The LISTEN connection back after it was lost (RealtimeService.listenerBack; docs/runner-link-design.md §15.3,
 * prerequisite (g)). What other apiservers announced while it was down never reached this one, so when another
 * apiserver ran meanwhile, every session with a stream open here is told to re-fetch (`resync`) and its owner's lists
 * here to re-read its row (session_updated), as a read-back given up does. Alone, nothing is sent. One line is logged
 * either way, never an event. The two-process twin is listener-reconnect.pg.spec.ts.
 */

const PROCESS = '0190a0b0-0000-7000-8000-0000000000a1';
const S1 = '0190a0b0-0000-7000-8000-0000000000c1';
const S2 = '0190a0b0-0000-7000-8000-0000000000c2';
const S3 = '0190a0b0-0000-7000-8000-0000000000c3';
const TS = '2026-10-28T10:00:00.000Z';

const ev = (seq: number): NormalizedRunEvent => ({ seq, type: RunEventType.ASSISTANT, payload: { text: `reply #${seq}` }, ts: TS });

/**
 * A replica whose reads of the other apiservers answer `others` (a count, or an error to throw, or a promise to wait
 * on), and whose log lines and hub are collected. `leader: false` builds it as the specs that build it by hand do.
 */
function replica(others: number | Error | Promise<number>, opts: { leader?: false } = {}) {
  const asked: Array<{ sql: string; values: unknown[] }> = [];
  const prisma = {
    $executeRawUnsafe: async () => 0,
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      asked.push({ sql: strings.join('?'), values });
      if (others instanceof Error) throw others;
      return [{ others: await others }];
    },
  };
  const leader = opts.leader === false ? undefined : ({ processId: PROCESS } as ControlPlaneLeader);
  const realtime = new RealtimeService(prisma as never, {} as never, undefined, leader);
  const lines: string[] = [];
  (realtime as unknown as { log: unknown }).log = {
    log: (line: string) => lines.push(`LOG ${line}`),
    warn: (line: string) => lines.push(`WARN ${line}`),
    error: (line: string) => lines.push(`ERROR ${line}`),
  };
  const hub: string[] = [];
  (realtime as unknown as { hub: Subject<{ runId: string; event: NormalizedRunEvent }> }).hub.subscribe(({ runId, event }) => {
    hub.push(`${runId.slice(-2)} ${event.seq}:${event.type}`);
  });
  /** One stream of the session, as the SSE route opens it: what it receives, and how to close it. */
  const stream = (sessionId: string) => {
    const got: string[] = [];
    const sub = realtime.streamForRun(sessionId).subscribe((event) => got.push(`${event.seq}:${event.type}`));
    return { got, close: () => sub.unsubscribe() };
  };
  const back = (downMs: number) => (realtime as unknown as { listenerBack(ms: number): Promise<void> }).listenerBack(downMs);
  return { realtime, asked, lines, hub, stream, back };
}

test('another apiserver ran while the listener was down: each session streamed here re-fetches, and its row is re-read', async () => {
  const r = replica(1);
  const [s1a, s1b, s2, s3] = [r.stream(S1), r.stream(S1), r.stream(S2), r.stream(S3)];
  s3.close(); // a stream that has closed is no longer counted

  await r.back(2_345);

  assert.deepEqual([s1a.got, s1b.got, s2.got, s3.got], [['0:resync'], ['0:resync'], ['0:resync'], []],
    'every open stream once, whichever session; the session_updated is not the transcript\'s');
  assert.deepEqual(r.hub, ['c1 0:resync', 'c1 0:session_updated', 'c2 0:resync', 'c2 0:session_updated'],
    'once a session, however many streams it has');
  assert.equal(r.asked.length, 1);
  assert.match(r.asked[0].sql, /FROM "apiserver_process"\s+WHERE "id" <> \?::uuid AND "seen_at" >= now\(\) - \(\? \* interval '1 millisecond'\)/);
  assert.deepEqual(r.asked[0].values, [PROCESS, 2_345 + 30_000], 'this process left out; the gap and a quiet spell before it');
  assert.deepEqual(r.lines, [
    "LOG LISTEN/NOTIFY back after 2345 ms without it: 1 other apiserver(s) ran meanwhile and what they announced did not reach this one, so this apiserver's streams of 2 session(s) were told to re-fetch",
  ]);

  // Nothing waits behind the order: the session's next events reach its streams at once.
  r.realtime.publishBatchHere(S1, [ev(7)]);
  assert.deepEqual(s1a.got, ['0:resync', '7:assistant']);
});

test('alone, nothing was missed: no stream is told anything, and the line says so', async () => {
  const r = replica(0);
  const s1 = r.stream(S1);
  r.realtime.publishBatchHere(S1, [ev(1), ev(2)]);

  await r.back(2_001);

  assert.deepEqual(s1.got, ['1:assistant', '2:assistant']);
  assert.deepEqual(r.hub, ['c1 1:assistant', 'c1 2:assistant']);
  assert.deepEqual(r.lines, [
    'LOG LISTEN/NOTIFY back after 2001 ms without it: no other apiserver ran meanwhile, so nothing was missed and no stream was told to re-fetch',
  ]);
});

test('built without a leader, the only apiserver there is: nothing is asked and nothing is sent', async () => {
  const r = replica(5, { leader: false });
  const s1 = r.stream(S1);

  await r.back(2_000);

  assert.deepEqual([r.asked, s1.got, r.hub], [[], [], []]);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /^LOG LISTEN\/NOTIFY back after 2000 ms without it: no other apiserver ran meanwhile/);
});

test('when the other apiservers cannot be read, the streams re-fetch anyway, and the line is a warning', async () => {
  const failure = Object.assign(new Error('\nInvalid `prisma.$queryRaw()` invocation:\n\n\nServer has closed the connection.'), { code: 'P1017' });
  const r = replica(failure);
  const s2 = r.stream(S2);

  await r.back(4_100);

  assert.deepEqual(s2.got, ['0:resync']);
  assert.deepEqual(r.hub, ['c2 0:resync', 'c2 0:session_updated']);
  assert.deepEqual(r.lines, [
    "WARN LISTEN/NOTIFY back after 4100 ms without it: could not read whether another apiserver ran meanwhile (P1017 Server has closed the connection.), so this apiserver's streams of 1 session(s) were told to re-fetch",
  ]);
});

test('with no stream open here, the line says that none was told', async () => {
  const r = replica(2);

  await r.back(2_050);

  assert.deepEqual(r.hub, []);
  assert.deepEqual(r.lines, [
    "LOG LISTEN/NOTIFY back after 2050 ms without it: 2 other apiserver(s) ran meanwhile and what they announced did not reach this one, so this apiserver's streams of 0 session(s) were told to re-fetch",
  ]);
});

test('an apiserver stopping while it asks sends nothing', async () => {
  let answer!: (others: number) => void;
  const r = replica(new Promise<number>((resolve) => (answer = resolve)));
  const s1 = r.stream(S1);

  const pending = r.back(2_000);
  r.realtime.onModuleDestroy();
  answer(1);
  await pending;

  assert.deepEqual([s1.got, r.hub, r.lines], [[], [], []]);
});
