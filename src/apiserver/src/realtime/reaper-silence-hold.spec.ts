import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import {
  RUNNER_SILENT_AFTER_MS,
  RunnerPresenceService,
  type ApiserverProcessReport,
  type CellLosses,
} from '../runners/runner-presence';
import type { ControlPlaneLeader } from './control-plane-leader';
import { MASS_DISCONNECT_HOLD_MS, MASS_SILENCE_WINDOW_MS, ReaperService, massDisconnectsIn } from './reaper.service';

/**
 * When a runner's silence is not evidence that it died (docs/runner-link-design.md §6.5).
 *
 * The reaper calls a runner offline on 90 s without a beat in `runner_presence`, an UNLOGGED table a
 * crash or a failover of the primary empties. So it reaps nothing as `runner offline`
 *  - for three minutes after it starts,
 *  - while heartbeat writes have been failing in this process or another,
 * and does not reap the run of a runner that lost contact in a mass disconnection — a fifth or more of
 * the cell's runners losing contact within 45 s of each other, those back already counted with those
 * still out, or a fifth silent at once — until that runner has been silent for 10 min 45 s. Every
 * sweep past the grace reads the cell for one and keeps what it finds (`runner_mass_disconnect`), so
 * that a disconnection most runners came back from at once still holds the few that did not.
 *
 * Each of those holds only verdicts read from silence: a cancel nobody honored is still finalized, and
 * the run of a runner that signed off (OFFLINE) is reaped as it always was. Which runners count — only
 * those that can lose contact — and by which lines is a query, pinned on a real PostgreSQL in
 * runners/runner-presence.pg.spec.ts; here the cell is modelled runner by runner and the query answered
 * from it by the same rules.
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

/** A runner of the cell as presence holds it: its last beat, and the last beat it lost contact after (`lost_at`). */
interface Heard {
  beat: number;
  lostAt?: number | null;
}

/** A runner still connected, beating every BEAT_EVERY from `phase` on: when it was last heard, at the clock. */
function connected(phase: number): () => number {
  return () => clock - ((((clock - phase) % BEAT_EVERY) + BEAT_EVERY) % BEAT_EVERY);
}

/** `n` runners connected, their beats spread across the period. */
function beating(n: number): Array<() => Heard> {
  return Array.from({ length: n }, (_, i) => {
    const beat = connected(T0 + Math.floor((i * BEAT_EVERY) / Math.max(n, 1)));
    return () => ({ beat: beat() });
  });
}

/** The cell's query answered from the cell runner by runner, as RunnerPresenceService.cellLosses reads it. */
function readCell(cell: Heard[], query: { values?: unknown[] }): CellLosses {
  const window = RUNNER_SILENT_AFTER_MS + MASS_SILENCE_WINDOW_MS;
  assert.deepEqual(
    query.values,
    [RUNNER_SILENT_AFTER_MS, RUNNER_SILENT_AFTER_MS, window, window],
    'the cell\'s query is handed its silence line twice and its window twice',
  );
  const heard = cell.filter((r) => r.beat >= clock - window);
  const silent = heard.filter((r) => r.beat < clock - RUNNER_SILENT_AFTER_MS);
  const seconds = new Map<number, number>();
  for (const r of heard) {
    const lost = r.beat < clock - RUNNER_SILENT_AFTER_MS ? r.beat : (r.lostAt ?? null);
    if (lost === null || lost < clock - window) continue;
    const second = Math.floor(lost / 1000);
    seconds.set(second, (seconds.get(second) ?? 0) + 1);
  }
  return {
    heard: heard.length,
    silent: silent.length,
    silentFrom: silent.length > 0 ? Math.min(...silent.map((r) => r.beat)) : null,
    silentTo: silent.length > 0 ? Math.max(...silent.map((r) => r.beat)) : null,
    losses: [...seconds].sort((a, b) => a[0] - b[0]),
  };
}

/** `runner_mass_disconnect`, as the reaper reads and writes it. Shared by reapers on two processes of one cell. */
type Kept = Array<{ id: bigint; lostFrom: Date; lostTo: Date; runners: number; heard: number; updatedAt?: Date }>;
function keptTable(kept: Kept) {
  return {
    findMany: async ({ where }: { where: { lostTo: { gte: Date } } }) =>
      kept.filter((k) => k.lostTo >= where.lostTo.gte).sort((a, b) => a.lostFrom.getTime() - b.lostFrom.getTime()).map((k) => ({ ...k })),
    create: async ({ data }: { data: Omit<Kept[number], 'id'> }) => {
      const row = { id: BigInt(kept.length + 1), ...data };
      kept.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: bigint }; data: Partial<Kept[number]> }) => {
      const row = kept.find((k) => k.id === where.id);
      assert.ok(row, `the disconnection updated is one kept: ${where.id}`);
      Object.assign(row, data);
      return { ...row };
    },
  };
}

function world(opts: {
  /** The cell's other runners that can lose contact, runner by runner. The session's own runner is added unless OFFLINE. */
  others?: () => Heard[];
  /** The session's runner's `lost_at`. */
  lostAt?: number | null;
  cellFails?: unknown;
  cancelRequestedAgoMs?: number;
  /** What the runner row says: OFFLINE is a runner that signed off. */
  runnerStatus?: string;
  /** When this session's runner was last heard from: five minutes before the clock unless a case says. */
  lastBeatAt?: number;
  /** The kept disconnections, to share with another world: one cell's table. */
  kept?: Kept;
} = {}) {
  const runnerStatus = opts.runnerStatus ?? 'ONLINE';
  const finalized: Array<Record<string, unknown>> = [];
  const warns: string[] = [];
  const cellReads: number[] = [];
  const kept = opts.kept ?? [];
  const lastBeat = () => new Date(opts.lastBeatAt ?? clock - 5 * MINUTE);
  // Nine runners beating and this session's runner: a quiet cell, unless a case says otherwise.
  const others = opts.others ?? (() => beating(9).map((r) => r()));
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
      findMany: async () => (finalized.length > 0 ? [] : [{
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
        // Its own record of its beats five minutes older than its presence row.
        assignedRunner: {
          status: runnerStatus, lastHeartbeatAt: new Date(lastBeat().getTime() - 5 * MINUTE), presence: { lastBeatAt: lastBeat() },
        },
      }]),
    },
    runEvent: { findFirst: async () => null },
    runnerMassDisconnect: keptTable(kept),
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const presence = new RunnerPresenceService({
    $queryRaw: async (query: { values?: unknown[] }) => {
      cellReads.push(clock);
      if (opts.cellFails) throw opts.cellFails;
      const own = runnerStatus === 'OFFLINE' ? [] : [{ beat: lastBeat().getTime(), lostAt: opts.lostAt ?? null }];
      return [readCell([...others(), ...own], query)];
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
    cellReads,
    kept,
  };
}

const HELD = /not reaping 1 session\(s\) whose runner looks offline \(1{8}-1{4}-4111-8111-1{12}\): /;

test('the control: a runner silent for five minutes in a quiet cell is reaped as offline', async () => {
  onTheClock();
  const w = world();
  await w.sweep();
  assert.equal(w.finalized.length, 1);
  assert.equal(w.finalized[0]?.error, 'runner offline');
  assert.deepEqual(w.cellReads, [T0], 'the cell was read once, at the sweep');
  assert.deepEqual(w.kept, [], 'one runner of ten is no mass disconnection');
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
    assert.deepEqual(w.cellReads, [], 'inside the grace the cell is not read at all: a presence table just emptied is no reading');

    clock = T0 + 3 * MINUTE;
    await w.sweep();
    assert.equal(w.finalized.length, 1, 'the grace ends; the same silence is evidence again');
    assert.equal(w.finalized[0]?.error, 'runner offline');
  } finally {
    w.reaper.onModuleDestroy();
  }
});

test('a fifth of the cell silent at once holds its runners; a tenth does not', async () => {
  onTheClock();
  // This session's runner and one more, silent four minutes; eight beating.
  const fifth = world({ others: () => [...beating(8).map((r) => r()), { beat: clock - 4 * MINUTE }] });
  await fifth.sweep();
  assert.deepEqual(fifth.finalized, []);
  assert.match(fifth.warns.join('\n'), /a mass disconnection: 2 of the 10 runners heard from lost contact, last heard between 2026-10-25T05:55:00\.000Z and 2026-10-25T05:56:00\.000Z/);
  assert.match(fifth.warns.join('\n'), new RegExp(HELD.source + /its runner lost contact in a mass disconnection \(2 of the 10 runners heard from/.source));

  // Exactly a fifth, where a float product would land a hair above it (35 * 0.2 > 7).
  const exactly = world({ others: () => [...beating(28).map((r) => r()), ...[1, 2, 3, 4, 5, 6].map((m) => ({ beat: clock - (m + 1) * MINUTE }))] });
  await exactly.sweep();
  assert.deepEqual(exactly.finalized, []);

  const tenth = world({ others: () => beating(9).map((r) => r()) });
  await tenth.sweep();
  assert.equal(tenth.finalized.length, 1);

  // A single-runner cell: its one runner going quiet is all of the cell going quiet at once.
  const alone = world({ others: () => [] });
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
  const stillConnected = beating(8);
  const w = world({ lastBeatAt: firstLastBeat, others: () => [...stillConnected.map((r) => r()), { beat: secondLastBeat }] });
  await w.sweep();
  assert.deepEqual(w.finalized, [], 'both have missed a beat: a fifth of the cell lost contact at once');
  assert.match(w.warns.join('\n'), HELD);

  // The second is past the line too: still the same two of ten.
  clock = T0 + 30 * SECOND;
  await w.sweep();
  assert.deepEqual(w.finalized, []);
});

test('one runner lost in a cell otherwise heard is reaped once it is past the 90 s line, as it always was', async () => {
  onTheClock();
  // Nine runners beating every 30 s, and this session's runner last heard at T0: a machine that died, not an outage.
  const w = world({ lastBeatAt: T0, others: () => beating(9).map((r) => r()) });
  clock = T0 + 90 * SECOND;
  await w.sweep();
  assert.equal(w.finalized.length, 0, 'ninety seconds is not past the line');

  clock = T0 + 90 * SECOND + 1;
  await w.sweep();
  assert.equal(w.finalized.length, 1, 'one runner of ten silent is no outage');
  assert.equal(w.finalized[0]?.error, 'runner offline');
  assert.deepEqual(w.cellReads, [T0 + 90 * SECOND, T0 + 90 * SECOND + 1], 'the cell is read at every sweep, whatever it finds');
});

/**
 * A link gateway node of three stops 100 s before T0, with ten runners of the thirty on it. Nine connected through the
 * other two within twelve seconds and have beaten on since: none of them missed a beat, and what is left of their loss
 * is the last beat each was heard with before its new connection, in the period before the stop (`lost_at`, which the
 * welcome route keeps). The tenth is this session's runner, still waiting out its reconnection backoff: last heard 5 s
 * before the stop, 105 s ago, past the offline line. No sweep ever saw more than this one runner silent.
 */
const STOP = T0 - 100 * SECOND;
function gatewayNodeStopped(): () => Heard[] {
  const stayed = beating(20);
  const moved = beating(9);
  return () => [...stayed.map((r) => r()), ...moved.map((r, i) => ({ ...r(), lostAt: STOP - 2 * SECOND - i * 3 * SECOND }))];
}

/** The same cell once the nine have connected again one at a time, forty seconds apart from T0 on: losses spread. */
function renewedOneByOne(cell: () => Heard[]): () => Heard[] {
  return () => {
    let renewal = 0;
    return cell().map((r) => (r.lostAt ? { ...r, lostAt: T0 + renewal++ * 40 * SECOND } : r));
  };
}

test('a reconnection most runners are back from within seconds holds the runner still out: a gateway node of three stopping', async () => {
  onTheClock();
  const w = world({ lastBeatAt: STOP - 5 * SECOND, others: gatewayNodeStopped() });
  await w.sweep();
  assert.deepEqual(w.finalized, [], 'ten runners of thirty lost contact within half a minute: a third of the cell');
  assert.match(w.warns.join('\n'), /a mass disconnection: 10 of the 30 runners heard from lost contact, last heard between 2026-10-25T05:57:54\.000Z and 2026-10-25T05:58:18\.999Z/);
  assert.match(w.warns.join('\n'), new RegExp(HELD.source + /its runner lost contact in a mass disconnection \(10 of the 30/.source));
  assert.equal(w.kept.length, 1, 'and kept');

  // The control: the same cell without what the nine left of their loss is one silent runner of thirty.
  const control = world({ lastBeatAt: STOP - 5 * SECOND, others: () => gatewayNodeStopped()().map((r) => ({ beat: r.beat })) });
  await control.sweep();
  assert.equal(control.finalized.length, 1, 'counting the silent alone, the runner still out is reaped');
});

test('a kept mass disconnection holds its runners once the cell shows it no more, until each has been silent past the window', async () => {
  onTheClock();
  let cell = gatewayNodeStopped();
  const w = world({ lastBeatAt: STOP - 5 * SECOND, others: () => cell() });
  await w.sweep();
  assert.equal(w.finalized.length, 0);

  // The nine connect once more, one at a time over the next minutes (a token's renewal, say): their losses are spread
  // now, and the cell no longer shows the disconnection. The reaper has it kept.
  cell = renewedOneByOne(gatewayNodeStopped());
  clock = T0 + 8 * MINUTE;
  await w.sweep();
  assert.equal(w.finalized.length, 0, 'held by the disconnection kept');
  assert.match(w.warns.at(-1) ?? '', /its runner lost contact in a mass disconnection \(10 of the 30 runners heard from/);

  // Silent for the window and a moment past it: not back from that disconnection, reaped as anybody's runner is.
  clock = STOP - 5 * SECOND + MASS_DISCONNECT_HOLD_MS;
  await w.sweep();
  assert.equal(w.finalized.length, 0, `silent for ${MASS_DISCONNECT_HOLD_MS / 1000}s: still inside the window`);
  clock += 1;
  await w.sweep();
  assert.equal(w.finalized.length, 1);
  assert.equal(w.finalized[0]?.error, 'runner offline');
});

test('a mass disconnection one reaper kept holds on the reaper of the process that sweeps after it', async () => {
  onTheClock();
  const kept: Kept = [];
  const a = world({ lastBeatAt: STOP - 5 * SECOND, others: gatewayNodeStopped(), kept });
  await a.sweep();
  assert.equal(kept.length, 1);
  // The process that swept is gone; another, long past its own start, sweeps the same cell, whose runners renewed their
  // connections in the meantime, so that the cell no longer shows the disconnection.
  clock = T0 + 5 * MINUTE;
  const b = world({ lastBeatAt: STOP - 5 * SECOND, others: renewedOneByOne(gatewayNodeStopped()), kept });
  await b.sweep();
  assert.deepEqual(b.finalized, [], 'the disconnection is the cell\'s, not the memory of the process that saw it');
  assert.match(b.warns.join('\n'), /its runner lost contact in a mass disconnection \(10 of the 30/);
});

test('a runner lost on its own while a mass disconnection is held is reaped once past the 90 s line, as it always was', async () => {
  onTheClock();
  const kept: Kept = [];
  const disconnected = world({ lastBeatAt: STOP - 5 * SECOND, others: gatewayNodeStopped(), kept });
  await disconnected.sweep();
  assert.equal(kept.length, 1, 'a disconnection kept, its window running for ten minutes more');
  // A minute later, a runner of the stayed twenty dies on its own: its last beat at T0 + 60 s, well after the span.
  const died = T0 + 60 * SECOND;
  const others = gatewayNodeStopped();
  const w = world({ lastBeatAt: died, others: () => others(), kept });
  clock = died + 90 * SECOND + 1;
  await w.sweep();
  assert.equal(w.finalized.length, 1, 'its silence began alone, past the disconnection: no hold');
  assert.equal(w.finalized[0]?.error, 'runner offline');
});

test('losses spread over minutes are no mass disconnection: connections renewed one by one', async () => {
  onTheClock();
  // Thirty runners; eight of them connected again in the last ten minutes, one every seventy seconds, as an hour's token
  // renewals fall. No 45 s holds two of them.
  const renewed = beating(29);
  const w = world({ others: () => renewed.map((r, i) => (i < 8 ? { ...r(), lostAt: clock - (i + 1) * 70 * SECOND } : r())) });
  await w.sweep();
  assert.equal(w.finalized.length, 1);
  assert.deepEqual(w.kept, []);
});

test('a mass disconnection none of whose runners comes back holds each for the window, then lets it be reaped', async () => {
  onTheClock();
  // All ten runners cut off together, last heard across the period before T0, and never heard again.
  const lastBeats = Array.from({ length: 9 }, (_, i) => T0 - 2 * SECOND - i * 3 * SECOND);
  const w = world({ lastBeatAt: T0 - 29 * SECOND, others: () => lastBeats.map((beat) => ({ beat })) });
  for (clock = T0 + 30 * SECOND; clock <= T0 - 29 * SECOND + MASS_DISCONNECT_HOLD_MS; clock += 30 * SECOND) {
    await w.sweep();
    assert.deepEqual(w.finalized, [], `held ${(clock - T0) / 1000}s after the cut`);
  }
  clock = T0 - 29 * SECOND + MASS_DISCONNECT_HOLD_MS + 1;
  await w.sweep();
  assert.equal(w.finalized.length, 1, 'past the window: no runner back from it is coming');
  assert.equal(w.finalized[0]?.error, 'runner offline');
});

test('massDisconnectsIn: the spans a reading of the cell shows', () => {
  const at = (iso: string) => Date.parse(iso);
  const second = (iso: string) => Math.floor(at(iso) / 1000);
  // Ten runners heard; three lost contact within 45 s of each other, two of those back already.
  assert.deepEqual(massDisconnectsIn({
    heard: 10, silent: 1, silentFrom: at('2026-10-25T06:00:30.250Z'), silentTo: at('2026-10-25T06:00:30.250Z'),
    losses: [[second('2026-10-25T06:00:00Z'), 1], [second('2026-10-25T06:00:30Z'), 1], [second('2026-10-25T06:00:45Z'), 1]],
  }), [{ from: at('2026-10-25T06:00:00Z'), to: at('2026-10-25T06:00:45.999Z'), runners: 3, heard: 10 }]);
  // The same three, 46 s from first to last: two within 45 s are a fifth; the third alone is none.
  assert.deepEqual(massDisconnectsIn({
    heard: 10, silent: 0, silentFrom: null, silentTo: null,
    losses: [[second('2026-10-25T06:00:00Z'), 1], [second('2026-10-25T06:00:01Z'), 1], [second('2026-10-25T06:00:47Z'), 1]],
  }), [{ from: at('2026-10-25T06:00:00Z'), to: at('2026-10-25T06:00:01.999Z'), runners: 2, heard: 10 }]);
  // Silent at once, however spread: one span over every silent runner's last beat, though no 45 s holds two of them.
  assert.deepEqual(massDisconnectsIn({
    heard: 10, silent: 2, silentFrom: at('2026-10-25T05:50:00Z'), silentTo: at('2026-10-25T05:58:00Z'),
    losses: [[second('2026-10-25T05:50:00Z'), 1], [second('2026-10-25T05:58:00Z'), 1]],
  }), [{ from: at('2026-10-25T05:50:00Z'), to: at('2026-10-25T05:58:00Z'), runners: 2, heard: 10 }]);
  assert.deepEqual(massDisconnectsIn({ heard: 0, silent: 0, silentFrom: null, silentTo: null, losses: [] }), []);
});

test('a silence older than the window is no mass silence: its runners leave the count', async () => {
  onTheClock();
  // Nothing heard from within the window at all — the cell's runners have been gone for longer.
  const w = world({ lastBeatAt: T0 - 11 * MINUTE, others: () => Array.from({ length: 9 }, () => ({ beat: T0 - 20 * MINUTE })) });
  await w.sweep();
  assert.equal(w.finalized.length, 1);
});

test('a heartbeat write that failed holds the reaping for the window silence is read from', async () => {
  onTheClock();
  const w = world();
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
  const w = world();
  w.presence.beatNotRecorded(Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' }));
  assert.equal(w.presence.lastBeatNotRecordedAt(), null);
  await w.sweep();
  assert.equal(w.finalized.length, 1);
});

test('a heartbeat whose presence row cannot be written tells the reaper, which then holds', async () => {
  onTheClock();
  const w = world();
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
  const w = world({ cellFails: Object.assign(new Error('Timed out fetching a new connection'), { code: 'P2024' }) });
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
  // Half the cell silent and a reaper that has only just started: both hold a silent runner's run.
  const halfSilent = () => [...beating(5).map((r) => r()), ...[1, 2, 3, 4, 5].map((m) => ({ beat: clock - (m + 1) * MINUTE }))];
  const w = world({ runnerStatus: 'OFFLINE', others: halfSilent });
  w.reaper.onModuleInit();
  try {
    await w.sweep();
    assert.equal(w.finalized.length, 1, 'OFFLINE is the runner saying it left: no silence to hold');
    assert.equal(w.finalized[0]?.error, 'runner offline');
  } finally {
    w.reaper.onModuleDestroy();
  }
  const pastGrace = world({ runnerStatus: 'OFFLINE', others: halfSilent });
  await pastGrace.sweep();
  assert.equal(pastGrace.finalized.length, 1, 'and past the grace, with the half of the cell silent kept as a disconnection');

  const silent = world({ others: halfSilent });
  await silent.sweep();
  assert.deepEqual(silent.finalized, [], 'the control: the same cell holds a runner that only went quiet');
});

/** The leader a reaper is built beside, as the reaper reads it: when its process took the lock, if it holds it. */
function leaderTakenAt(at: () => number | null): ControlPlaneLeader {
  return { leads: () => at() !== null, leadingSince: at } as unknown as ControlPlaneLeader;
}

test('a process that takes the sweeps over starts its reaper again, inside the startup grace', async () => {
  onTheClock();
  const w = world();
  let since: number | null = null;
  (w.reaper as unknown as { leader: ControlPlaneLeader }).leader = leaderTakenAt(() => since);
  // Up for an hour as a follower: its own start long past, and nothing swept while another process held the lock.
  (w.reaper as unknown as { startedAt: number }).startedAt = T0 - 60 * MINUTE;
  await w.reaper.tick();
  assert.deepEqual(w.cellReads, [], 'a process that does not hold the lock does not sweep');
  since = clock;
  await w.reaper.tick();
  assert.equal(w.finalized.length, 0, 'the takeover is a start: nothing is reaped inside its grace');
  assert.match(w.warns.join('\n'), /startup grace/);
  clock = T0 + 3 * MINUTE + SECOND;
  await w.reaper.tick();
  assert.equal(w.finalized.length, 1, 'and past the grace the silent runner\'s run is reaped');
});

test('another apiserver process that lost a beat, or went quiet, holds the reaping; neither forever', async () => {
  onTheClock();
  let others: ApiserverProcessReport[] = [];
  const peer = (over: Partial<ApiserverProcessReport>): ApiserverProcessReport => ({
    id: '33333333-aaaa-4bbb-8ccc-444444444444', beatLostAgoMs: null, seenAgoMs: 5 * SECOND, connected: true, ...over,
  });
  const expect = async (report: ApiserverProcessReport, reaped: boolean, reason?: RegExp) => {
    const w = world();
    others = [report];
    w.presence.otherProcesses = async () => others;
    await w.sweep();
    assert.equal(w.finalized.length, reaped ? 1 : 0, JSON.stringify(report));
    if (reason) assert.match(w.warns.join('\n'), reason);
  };
  await expect(peer({ beatLostAgoMs: 30 * SECOND }), false, /a heartbeat write failed on apiserver process 33333333 30s ago/);
  await expect(peer({ beatLostAgoMs: 91 * SECOND }), true);
  await expect(peer({ seenAgoMs: 40 * SECOND }), false, /apiserver process 33333333 has not reported for 40s though it is still connected/);
  await expect(peer({ seenAgoMs: 9 * MINUTE }), false);
  await expect(peer({ seenAgoMs: 11 * MINUTE }), true);
  await expect(peer({ seenAgoMs: 100 * SECOND, connected: false }), false, /has not reported for 100s, so the heartbeats/);
  await expect(peer({ seenAgoMs: 2 * MINUTE + SECOND, connected: false }), true);
  await expect(peer({ seenAgoMs: 20 * SECOND }), true);
});
