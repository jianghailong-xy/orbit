import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerPresenceService } from '../runners/runner-presence';
import { ReaperService } from './reaper.service';

/**
 * When a runner's silence is not evidence that it died (docs/runner-link-design.md §6.5).
 *
 * The reaper calls a runner offline on 90 s without a beat in `runner_presence`, an UNLOGGED table a
 * crash or a failover of the primary empties. So it reaps nothing as `runner offline`
 *  - for three minutes after it starts,
 *  - while a fifth or more of the cell's runners have gone quiet at once — each missed a beat, 45 s
 *    without one, whether or not it is past the 90 s line yet — and for a window after,
 *  - while heartbeat writes have been failing in this process,
 * and each of those holds only verdicts read from silence: a cancel nobody honored is still finalized,
 * and the run of a runner that signed off (OFFLINE) is reaped as it always was. Which runners count
 * toward "a fifth" — only those that can lose contact — and by which lines is a query, pinned on a
 * real PostgreSQL in runners/runner-presence.pg.spec.ts; the cases here that model the cell runner by
 * runner answer it by the lines it is handed.
 *
 * Every case runs one RUNNING session whose runner was last heard from five minutes ago — offline
 * by any reading — unless the case says otherwise, on a clock the test moves.
 */

const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const T0 = Date.parse('2026-10-25T06:00:00.000Z');
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
/** How often a connected runner beats: runner-go's heartbeat ticker. */
const BEAT_EVERY = 30 * SECOND;

let clock = T0;
afterEach(() => mock.restoreAll());
function onTheClock(): void {
  clock = T0;
  mock.method(Date, 'now', () => clock);
}

interface Fleet {
  heard: number;
  silent: number;
}

/** A runner still connected, beating every BEAT_EVERY from `phase` on: when it was last heard, at the clock. */
function connected(phase: number): () => number {
  return () => clock - ((((clock - phase) % BEAT_EVERY) + BEAT_EVERY) % BEAT_EVERY);
}

/**
 * fleetSilence's query answered from the cell runner by runner, by the two lines the query is handed, in order: how
 * long without a beat a runner has to be to count as silent, and how long ago it may have been heard and still count.
 */
function readCell(lastBeats: number[], query: { values?: unknown[] }): Fleet {
  const [silentAfterMs, heardWithinMs, ...rest] = query.values ?? [];
  assert.ok(
    typeof silentAfterMs === 'number' && typeof heardWithinMs === 'number' && rest.length === 0,
    `the cell's query is handed its two lines: ${JSON.stringify(query.values)}`,
  );
  const heard = lastBeats.filter((at) => at >= clock - heardWithinMs);
  return { heard: heard.length, silent: heard.filter((at) => at < clock - silentAfterMs).length };
}

function world(opts: {
  fleet?: Fleet | (() => Fleet);
  /**
   * The cell runner by runner instead of in totals: when each of its runners that can lose contact was last heard
   * from. fleetSilence's query is answered from it (`readCell`).
   */
  cell?: () => number[];
  fleetFails?: unknown;
  cancelRequestedAgoMs?: number;
  /** What the runner row says: OFFLINE is a runner that signed off. */
  runnerStatus?: string;
  /** When this session's runner was last heard from: five minutes before the clock unless a case says. */
  lastBeatAt?: number;
} = {}) {
  const runnerStatus = opts.runnerStatus ?? 'ONLINE';
  const finalized: Array<Record<string, unknown>> = [];
  const warns: string[] = [];
  const fleetReads: number[] = [];
  const lastBeat = () => new Date(opts.lastBeatAt ?? clock - 5 * MINUTE);
  const tx = {
    session: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        finalized.push(data);
        return { count: 1 };
      },
      count: async () => 0,
    },
    runner: { findUnique: async () => ({ status: runnerStatus, lastHeartbeatAt: lastBeat(), presence: { lastBeatAt: lastBeat() } }) },
    task: { updateMany: async () => ({ count: 1 }), findUnique: async () => null },
    $executeRaw: async () => 1,
    conversationTurn: { updateMany: async () => ({ count: 1 }), findFirst: async () => null, findMany: async () => [] },
    projectOpenItemDelivery: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    projectOpenItem: { updateMany: async () => ({ count: 0 }) },
  };
  const prisma = {
    session: {
      findMany: async () => [{
        id: SESSION_ID,
        taskId: null,
        assignedRunnerId: RUNNER_ID,
        status: RunStatus.RUNNING,
        provider: 'claude',
        providerBuiltin: true,
        engine: 'claude',
        ownerId: '33333333-3333-4333-8333-333333333333',
        runtimeSessionId: 'runtime-1',
        lastTurnAt: new Date(clock - 6 * MINUTE),
        runClaimedAt: new Date(clock - 6 * MINUTE),
        cancelRequestedAt: opts.cancelRequestedAgoMs === undefined ? null : new Date(clock - opts.cancelRequestedAgoMs),
        endReason: null,
        startsTaskWork: true,
        task: null,
        // Its own record of its beats ten minutes old; its presence row five.
        assignedRunner: { status: runnerStatus, lastHeartbeatAt: new Date(clock - 10 * MINUTE), presence: { lastBeatAt: lastBeat() } },
      }],
    },
    runEvent: { findFirst: async () => null },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const presence = new RunnerPresenceService({
    $queryRaw: async (query: { values?: unknown[] }) => {
      fleetReads.push(clock);
      if (opts.fleetFails) throw opts.fleetFails;
      if (opts.cell) return [readCell(opts.cell(), query)];
      const fleet = typeof opts.fleet === 'function' ? opts.fleet() : (opts.fleet ?? { heard: 10, silent: 1 });
      return [fleet];
    },
  } as never);
  const realtime = {
    requestCancel: () => undefined,
    publish: () => undefined,
    publishTaskChanged: () => undefined,
    publishQueuedTurnsChanged: () => undefined,
  } as never;
  const reaper = new ReaperService(prisma, realtime, undefined, presence);
  (reaper as unknown as { log: unknown }).log = {
    warn: (message: string) => warns.push(message),
    log: () => undefined,
    error: (message: string) => warns.push(`ERROR ${message}`),
  };
  return {
    reaper,
    presence,
    sweep: () => (reaper as unknown as { sweep(): Promise<void> }).sweep(),
    finalized,
    warns,
    fleetReads,
  };
}

test('the control: a runner silent for five minutes in a quiet cell is reaped as offline', async () => {
  onTheClock();
  const w = world({ fleet: { heard: 10, silent: 1 } });
  await w.sweep();
  assert.equal(w.finalized.length, 1);
  assert.equal(w.finalized[0]?.error, 'runner offline');
  assert.deepEqual(w.fleetReads, [T0], 'the cell was read once, for the one session it would reap');
});

test('nothing is reaped as offline inside the three-minute startup grace', async () => {
  onTheClock();
  const w = world();
  w.reaper.onModuleInit();
  try {
    await w.sweep();
    clock = T0 + 2 * MINUTE + 59 * SECOND;
    await w.sweep();
    assert.equal(w.finalized.length, 0, 'a reaper that just started has not had the time to hear the fleet again');
    assert.match(w.warns.join('\n'), /not reaping 1 session\(s\) whose runner looks offline \(1{8}-.*startup grace/);
    assert.deepEqual(w.fleetReads, [], 'the grace holds before the cell is read at all');

    clock = T0 + 3 * MINUTE;
    await w.sweep();
    assert.equal(w.finalized.length, 1, 'the grace ends; the same silence is evidence again');
    assert.equal(w.finalized[0]?.error, 'runner offline');
  } finally {
    w.reaper.onModuleDestroy();
  }
});

test('a fifth of the cell gone quiet at once holds the reaping; a tenth does not', async () => {
  onTheClock();
  const fifth = world({ fleet: { heard: 10, silent: 2 } });
  await fifth.sweep();
  assert.deepEqual(fifth.finalized, []);
  assert.match(
    fifth.warns.join('\n'),
    /2 of the 10 runners heard from in the last 645s have been silent for over 45s at once \(each missed a heartbeat\)/,
  );

  // Exactly a fifth, where a float product would land a hair above it (35 * 0.2 > 7).
  const exactly = world({ fleet: { heard: 35, silent: 7 } });
  await exactly.sweep();
  assert.deepEqual(exactly.finalized, []);

  const tenth = world({ fleet: { heard: 10, silent: 1 } });
  await tenth.sweep();
  assert.equal(tenth.finalized.length, 1);

  // A single-runner cell: its one runner going quiet is all of the cell going quiet at once.
  const alone = world({ fleet: { heard: 1, silent: 1 } });
  await alone.sweep();
  assert.deepEqual(alone.finalized, []);
});

test('runners cut off together cross the 90 s line one by one: a sweep between the first crossing and the second holds', async () => {
  onTheClock();
  // The C1b drill (2026-10-26): ten runners beating every 30 s, their beats spread across the period, and two of them
  // cut off at the same moment. Their last beats were 25 s apart, so one crossed the 90 s line 25 s before the other;
  // the sweep in between counted one runner of ten past it — a tenth — and reaped its run.
  const firstLastBeat = T0 - 95 * SECOND; // this session's runner: past the line 5 s ago
  const secondLastBeat = firstLastBeat + 25 * SECOND; // quiet for 70 s: past the line 20 s from now
  const stillConnected = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => connected(T0 + i * 3_700));
  const w = world({
    lastBeatAt: firstLastBeat,
    cell: () => [...stillConnected.map((lastBeat) => lastBeat()), firstLastBeat, secondLastBeat],
  });
  await w.sweep();
  assert.deepEqual(w.finalized, [], 'both have missed a beat: a fifth of the cell went quiet at once');
  assert.match(w.warns.join('\n'), /2 of the 10 runners heard from in the last \d+s have been silent for over \d+s at once/);

  // The second is past the line too: still the same two of ten.
  clock = T0 + 30 * SECOND;
  await w.sweep();
  assert.deepEqual(w.finalized, []);
});

test('one runner lost in a cell otherwise heard is reaped once it is past the 90 s line, as it always was', async () => {
  onTheClock();
  // Nine runners beating every 30 s, and this session's runner last heard at T0: a machine that died, not an outage.
  const stillConnected = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => connected(T0 + i * 3_300));
  const w = world({ lastBeatAt: T0, cell: () => [...stillConnected.map((lastBeat) => lastBeat()), T0] });
  clock = T0 + 90 * SECOND;
  await w.sweep();
  assert.equal(w.finalized.length, 0, 'ninety seconds is not past the line');
  assert.deepEqual(w.fleetReads, [], 'so nothing is reaped for silence, and the cell is not read');

  clock = T0 + 90 * SECOND + 1;
  await w.sweep();
  assert.equal(w.finalized.length, 1, 'one runner of ten silent is no outage');
  assert.equal(w.finalized[0]?.error, 'runner offline');
  assert.deepEqual(w.fleetReads, [T0 + 90 * SECOND + 1]);
});

test('the hold outlives the mass silence by a window, then lifts', async () => {
  onTheClock();
  let fleet: Fleet = { heard: 10, silent: 3 };
  const w = world({ fleet: () => fleet });
  await w.sweep();
  assert.deepEqual(w.finalized, []);

  // Thirty seconds later most of the cell is back: the runners whose beats were lost in it get a whole
  // window of their own before their silence counts.
  clock = T0 + 30 * SECOND;
  fleet = { heard: 10, silent: 1 };
  await w.sweep();
  assert.deepEqual(w.finalized, []);
  assert.match(w.warns.at(-1) ?? '', /went silent together less than 90s ago/);

  clock = T0 + 90 * SECOND;
  await w.sweep();
  assert.equal(w.finalized.length, 1, 'ninety seconds after the last sweep that saw it, the hold is gone');
});

test('a silence older than the window is no mass silence: its runners leave the count', async () => {
  onTheClock();
  // Nothing heard from within the window at all — the cell's runners have been gone for longer.
  const w = world({ fleet: { heard: 0, silent: 0 } });
  await w.sweep();
  assert.equal(w.finalized.length, 1);
});

test('a heartbeat write that failed holds the reaping for the window silence is read from', async () => {
  onTheClock();
  const w = world({ fleet: { heard: 10, silent: 1 } });
  w.presence.beatNotRecorded(Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' }));
  clock = T0 + 30 * SECOND;
  await w.sweep();
  assert.deepEqual(w.finalized, []);
  assert.match(w.warns.join('\n'), /a heartbeat write failed 30s ago/);

  clock = T0 + 91 * SECOND;
  await w.sweep();
  assert.equal(w.finalized.length, 1, 'a failed write ages out; it is not a latch');
});

test('a write the data refused (the runner deleted under it) says nothing about the database', async () => {
  onTheClock();
  const w = world({ fleet: { heard: 10, silent: 1 } });
  w.presence.beatNotRecorded(Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' }));
  assert.equal(w.presence.lastBeatNotRecordedAt(), null);
  await w.sweep();
  assert.equal(w.finalized.length, 1);
});

test('a heartbeat whose presence row cannot be written tells the reaper, which then holds', async () => {
  onTheClock();
  const w = world({ fleet: { heard: 10, silent: 1 } });
  const prisma = {
    runner: { update: async () => ({ maxConcurrent: 4 }), findUnique: async () => null },
    runnerPresence: {
      upsert: async () => {
        throw Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { code: 'P2024' });
      },
    },
    session: { findMany: async () => [] },
  } as never;
  const controller = new RunnerApiController(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  (controller as unknown as { presence: RunnerPresenceService }).presence = w.presence;
  await assert.rejects(
    controller.heartbeat({ id: RUNNER_ID, version: null }, { status: 'ONLINE', idleCapacity: 1 } as never),
    /connection pool/,
    'the runner is told its beat did not land, and sends the next one',
  );
  assert.equal(w.presence.lastBeatNotRecordedAt(), T0);

  clock = T0 + 30 * SECOND;
  await w.sweep();
  assert.deepEqual(w.finalized, [], 'the silence that beat left behind is not read as the runner dying');
});

test('a cell that cannot be read is no evidence either', async () => {
  onTheClock();
  const w = world({ fleetFails: Object.assign(new Error('Timed out fetching a new connection'), { code: 'P2024' }) });
  await w.sweep();
  assert.deepEqual(w.finalized, []);
  assert.match(w.warns.join('\n'), /the cell's presence could not be read/);
});

test('a hold covers only what silence decides: a cancel nobody honored is still finalized', async () => {
  onTheClock();
  const w = world({ cancelRequestedAgoMs: 3 * MINUTE });
  w.reaper.onModuleInit();
  try {
    await w.sweep();
    assert.equal(w.finalized.length, 1);
    assert.equal(w.finalized[0]?.error, 'cancel not honored');
  } finally {
    w.reaper.onModuleDestroy();
  }
});

test('a runner that signed off is reaped as it always was, whatever holds silence', async () => {
  onTheClock();
  // A fifth of the cell silent and a reaper that has only just started: both hold a silent runner's run.
  const w = world({ runnerStatus: 'OFFLINE', fleet: { heard: 10, silent: 5 } });
  w.reaper.onModuleInit();
  try {
    await w.sweep();
    assert.equal(w.finalized.length, 1, 'OFFLINE is the runner saying it left: no silence to hold');
    assert.equal(w.finalized[0]?.error, 'runner offline');
    assert.deepEqual(w.fleetReads, [], 'and the cell is not asked about it');
  } finally {
    w.reaper.onModuleDestroy();
  }

  const silent = world({ fleet: { heard: 10, silent: 5 } });
  await silent.sweep();
  assert.deepEqual(silent.finalized, [], 'the control: the same cell holds a runner that only went quiet');
});
