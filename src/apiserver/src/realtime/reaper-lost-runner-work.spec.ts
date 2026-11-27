import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { RunStatus } from '@orbit/shared';

import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { RUNNER_SILENT_AFTER_MS, RunnerPresenceService, type CellLosses } from '../runners/runner-presence';
import { MASS_SILENCE_WINDOW_MS, ReaperService } from './reaper.service';

/**
 * A lost runner and the idle-looking sessions that were executing on it (plan step 1.7, design §11.3 item 4).
 *
 * The reaper fails a RUNNING session whose runner it judges lost and leaves every other open session alone. Now, a
 * session that is not RUNNING but has something executing — here a runner-hosted job, the case the task names — has
 * that work settled (realtime/lost-runner-work.ts): its sets emptied and a wake filed for the job. What this file pins,
 * on a fake database, is WHEN: under exactly the verdict and the holds the RUNNING path has, and never for a session
 * with nothing executing. What the settle writes, and what the task reads afterwards, is pinned on a real PostgreSQL in
 * reaper-lost-runner-work.pg.spec.ts.
 *
 * Each world holds two AWAITING_INPUT sessions on a runner last heard from six minutes ago — past the reap line — in a
 * cell of nine runners beating: one with job `bgj_lost` running, one with nothing executing.
 */

const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const WITH_JOB = '11111111-1111-4111-8111-111111111111';
const IDLE = '44444444-4444-4444-8444-444444444444';
const T0 = Date.parse('2026-11-19T06:00:00.000Z');
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

let clock = T0;
afterEach(() => mock.restoreAll());
function onTheClock(): void {
  clock = T0;
  mock.method(Date, 'now', () => clock);
}

function world(opts: {
  /** Runners of the cell besides this one, each by when it was last heard. Nine beating unless a case says. */
  others?: () => number[];
  cellFails?: unknown;
} = {}) {
  const lastBeat = () => new Date(clock - 6 * MINUTE);
  const others = opts.others ?? (() => Array.from({ length: 9 }, () => clock - 10 * SECOND));
  /** Every session the settle locked, and what it wrote to each. */
  const locked: string[] = [];
  const cleared: Array<{ id: string; data: Record<string, unknown> }> = [];
  const finalized: unknown[] = [];
  const createdTurns: Array<{ sessionId: string; clientTurnId: string }> = [];
  const warns: string[] = [];
  const row = (id: string, jobs: string[]) => ({
    id,
    taskId: null,
    assignedRunnerId: RUNNER_ID,
    status: RunStatus.AWAITING_INPUT,
    provider: 'claude',
    providerBuiltin: true,
    engine: 'claude',
    ownerId: OWNER_ID,
    runtimeSessionId: 'runtime-1',
    lastTurnAt: new Date(clock - 20 * MINUTE),
    runClaimedAt: new Date(clock - 20 * MINUTE),
    cancelRequestedAt: null,
    endReason: null,
    startsTaskWork: true,
    task: null,
    engineTurnActive: false,
    runningSubagents: [],
    runningBgJobs: jobs,
    assignedRunner: { status: 'ONLINE', lastHeartbeatAt: lastBeat(), presence: { lastBeatAt: lastBeat() } },
  });
  const tx = {
    runner: { findUnique: async () => ({ status: 'ONLINE', lastHeartbeatAt: lastBeat(), presence: { lastBeatAt: lastBeat() } }) },
    $queryRaw: async (...args: unknown[]) => {
      const { text, values } = renderRawQuery(args);
      if (text.includes('FOR UPDATE')) {
        const id = values[0] as string;
        locked.push(id);
        const r = row(id, id === WITH_JOB ? ['bgj_lost'] : []);
        return [{ ownerId: OWNER_ID, status: r.status, assignedRunnerId: RUNNER_ID, cancelRequestedAt: null,
          runClaimedAt: r.runClaimedAt, engineTurnActive: false, runningSubagents: [], runningBgJobs: r.runningBgJobs }];
      }
      if (text.includes('"run_event"')) {
        return [{ jobId: 'bgj_lost', payload: { kind: 'job', command: 'npm test', outputPath: '/runs/bgj_lost.output' } }];
      }
      return [];
    },
    session: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        cleared.push({ id: where.id, data });
        return { id: where.id };
      },
      updateMany: async (args: unknown) => {
        finalized.push(args);
        return { count: 1 };
      },
    },
  };
  const prisma = {
    session: { findMany: async () => [row(WITH_JOB, ['bgj_lost']), row(IDLE, [])] },
    runEvent: { findFirst: async () => null },
    runnerMassDisconnect: { findMany: async () => [], create: async ({ data }: { data: object }) => ({ id: 1n, ...data }), update: async () => ({}) },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const presence = new RunnerPresenceService({
    $queryRaw: async () => {
      if (opts.cellFails) throw opts.cellFails;
      const heard = [...others(), lastBeat().getTime()];
      const window = RUNNER_SILENT_AFTER_MS + MASS_SILENCE_WINDOW_MS;
      const inWindow = heard.filter((b) => b >= clock - window);
      const silent = inWindow.filter((b) => b < clock - RUNNER_SILENT_AFTER_MS);
      const seconds = new Map<number, number>();
      for (const b of silent) seconds.set(Math.floor(b / 1000), (seconds.get(Math.floor(b / 1000)) ?? 0) + 1);
      const cell: CellLosses = {
        heard: inWindow.length,
        silent: silent.length,
        silentFrom: silent.length > 0 ? Math.min(...silent) : null,
        silentTo: silent.length > 0 ? Math.max(...silent) : null,
        losses: [...seconds].sort((a, b) => a[0] - b[0]),
      };
      return [cell];
    },
  } as never);
  const realtime = new Proxy({}, { get: () => () => undefined }) as never;
  const sessions = {
    createTurn: async (_owner: string, sessionId: string, dto: { clientTurnId: string }) => {
      createdTurns.push({ sessionId, clientTurnId: dto.clientTurnId });
      return { turnId: 'turn-1' };
    },
  };
  const moduleRef = { get: () => sessions } as never;
  const reaper = new ReaperService(prisma, realtime, undefined, presence, undefined, undefined, moduleRef);
  (reaper as unknown as { log: unknown }).log = {
    warn: (message: string) => warns.push(message),
    log: () => undefined,
    error: (message: string) => warns.push(`ERROR ${message}`),
  };
  return {
    reaper,
    presence,
    sweep: () => (reaper as unknown as { sweep(): Promise<void> }).sweep(),
    locked,
    cleared,
    finalized,
    createdTurns,
    warns,
  };
}

/** Nothing of either session was settled, and nothing was failed. */
function untouched(w: ReturnType<typeof world>, why: string): void {
  assert.deepEqual(w.locked, [], `${why}: no session was locked to be settled`);
  assert.deepEqual(w.cleared, [], `${why}: no sets were cleared`);
  assert.deepEqual(w.createdTurns, [], `${why}: no wake was filed`);
  assert.deepEqual(w.finalized, [], `${why}: nothing was failed`);
}

test('a lost runner: the idle-looking session with a job has its sets cleared and is woken; the idle one is untouched', async () => {
  onTheClock();
  const w = world();
  await w.sweep();
  assert.deepEqual(w.locked, [WITH_JOB], 'only the session with something executing is settled');
  assert.equal(w.cleared.length, 1);
  assert.equal(w.cleared[0].id, WITH_JOB);
  assert.deepEqual(w.cleared[0].data, {
    runningBgShells: [], runningBgJobs: [], runningBgJobActivity: {}, runningSubagents: [], engineTurnActive: false,
  });
  assert.deepEqual(w.createdTurns, [{ sessionId: WITH_JOB, clientTurnId: 'bg-wake:bgj_lost:lost' }],
    'the job is reported ended, on its own wake key, to the session that waited for it');
  assert.deepEqual(w.finalized, [], 'neither session is failed: nothing it was asked to do failed');
});

test('inside the startup grace neither is touched', async () => {
  onTheClock();
  const w = world();
  w.reaper.onModuleInit();
  try {
    await w.sweep();
    untouched(w, 'startup grace');
    assert.match(w.warns.join('\n'), /not reaping 1 session\(s\) whose runner looks offline \(1{8}-.*startup grace/);
  } finally {
    w.reaper.onModuleDestroy();
  }
});

test('a heartbeat write that failed holds both', async () => {
  onTheClock();
  const w = world();
  w.presence.beatNotRecorded(Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' }), clock - 30 * SECOND);
  await w.sweep();
  untouched(w, 'heartbeat write failed');
  assert.match(w.warns.join('\n'), /a heartbeat write failed 30s ago/);
});

test('a mass disconnection the runner lost contact in holds both', async () => {
  onTheClock();
  // This runner and two more silent, seven beating: three of ten lost contact at once.
  const w = world({ others: () => [...Array.from({ length: 7 }, () => clock - 10 * SECOND), clock - 6 * MINUTE, clock - 6 * MINUTE] });
  await w.sweep();
  untouched(w, 'mass disconnection');
  assert.match(w.warns.join('\n'), /mass disconnection/);
});

test('a cell that could not be read holds both', async () => {
  onTheClock();
  const w = world({ cellFails: Object.assign(new Error('Timed out fetching a new connection'), { code: 'P2024' }) });
  await w.sweep();
  untouched(w, 'cell unread');
  assert.match(w.warns.join('\n'), /the cell's presence could not be read/);
});

test('a control plane that could not reach its own database last sweep holds both', async () => {
  onTheClock();
  const w = world();
  (w.reaper as unknown as { databaseRefusedWorkLastSweep: boolean }).databaseRefusedWorkLastSweep = true;
  await w.sweep();
  untouched(w, 'database refused work');
  assert.match(w.warns.join('\n'), new RegExp(`not settling ${WITH_JOB}'s work: this control plane could not reach its own database`));
});

test('a runner heard from again between the sweep\'s read and the settle settles nothing', async () => {
  onTheClock();
  const w = world();
  // The re-ask inside the transaction reads a fresh beat.
  const tx = (w.reaper as unknown as { prisma: { $transaction(fn: (tx: unknown) => unknown): unknown } }).prisma;
  const original = tx.$transaction;
  tx.$transaction = (fn) => original.call(tx, (client: unknown) => {
    (client as { runner: { findUnique: () => unknown } }).runner.findUnique = async () =>
      ({ status: 'ONLINE', lastHeartbeatAt: new Date(clock), presence: { lastBeatAt: new Date(clock) } });
    return fn(client);
  });
  await w.sweep();
  untouched(w, 'runner back');
});
