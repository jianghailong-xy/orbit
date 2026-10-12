import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { RunnerStatus } from '@orbit/shared';
import { RunnersService } from '../runners/runners.service';
import { CLAUDE_ACCOUNT_REMOVE_V1 } from '../runner-api/runner-api.controller';
import { RealtimeService } from './realtime.service';
import { notifyRunnerWakeOnCommit } from './runner-wake';

/**
 * A sign-in from the web reaches the runner on its heartbeat, which used to mean up to thirty seconds
 * after the press — twice over for Claude, whose pasted code takes a second heartbeat. The runner now
 * parks in GET /runner/wake and beats the moment one of those is waiting.
 */

const RUNNER = 'runner-1';

/** Deliver a payload the way the LISTEN connection does (RealtimeService.onNotify is private). */
function deliver(realtime: RealtimeService, payload: unknown): void {
  (realtime as unknown as { onNotify: (channel: string, payload: string) => void })
    .onNotify('orbit_runner_wake', JSON.stringify(payload));
}

/** The instance id the service stamps on the payloads it emits locally. */
function instanceIdOf(realtime: RealtimeService): string {
  return (realtime as unknown as { instanceId: string }).instanceId;
}

function hub(): { realtime: RealtimeService; notified: string[] } {
  const notified: string[] = [];
  const prisma = {
    $executeRawUnsafe: async (_sql: string, channel: string) => {
      notified.push(channel);
      return 0;
    },
  };
  return { realtime: new RealtimeService(prisma as never, {} as never), notified };
}

test('a parked poll wakes the moment its runner is asked, and tells other replicas', async () => {
  const { realtime, notified } = hub();
  const parked = realtime.waitForRunnerWake(RUNNER, 5_000);
  realtime.notifyRunnerWake(RUNNER);
  assert.equal(await parked, true);
  assert.deepEqual(notified, ['orbit_runner_wake']);
});

test('a wake asked for between two polls is held for the next one, once', async () => {
  const { realtime } = hub();
  realtime.notifyRunnerWake(RUNNER);
  assert.equal(await realtime.waitForRunnerWake(RUNNER, 5_000), true);
  assert.equal(await realtime.waitForRunnerWake(RUNNER, 20), false, 'the held wake was taken already');
});

test('another runner is not woken, and a poll that hangs up leaves the wake for the next', async () => {
  const { realtime } = hub();
  assert.equal(await (async () => {
    const other = realtime.waitForRunnerWake('runner-2', 50);
    realtime.notifyRunnerWake(RUNNER);
    return other;
  })(), false);
  // The wake above found nobody parked for RUNNER, so it is owed; take it.
  assert.equal(await realtime.waitForRunnerWake(RUNNER, 5_000), true);

  const hangUp = new AbortController();
  const gone = realtime.waitForRunnerWake(RUNNER, 5_000, hangUp.signal);
  hangUp.abort();
  assert.equal(await gone, false);
  realtime.notifyRunnerWake(RUNNER);
  assert.equal(await realtime.waitForRunnerWake(RUNNER, 5_000), true);
});

test('starting a sign-in, pasting its code and stopping an Antigravity one each wake the runner', async () => {
  let row: Record<string, unknown> = {
    id: RUNNER,
    ownerId: 'owner-1',
    status: RunnerStatus.ONLINE,
    capabilities: [],
  };
  const prisma = {
    runner: {
      findFirst: async () => row,
      update: async ({ data }: { data: Record<string, unknown> }) => (row = { ...row, ...data }),
    },
  };
  const woken: string[] = [];
  const realtime = { notifyRunnerWake: (id: string) => woken.push(id) };
  const runners = new RunnersService(prisma as never, realtime as never);

  await runners.startLogin('owner-1', RUNNER, { engine: 'claude' });
  assert.deepEqual(woken, [RUNNER]);

  row = { ...row, loginStatus: 'awaiting_code' };
  await runners.submitLoginCode('owner-1', RUNNER, 'abc#def');
  assert.deepEqual(woken, [RUNNER, RUNNER]);

  // Cancelling a Claude sign-in hands the runner nothing, so there is nothing to wake it for.
  await runners.cancelLogin('owner-1', RUNNER);
  assert.deepEqual(woken, [RUNNER, RUNNER]);
});

test('asking to remove an account wakes the runner, so the account goes now rather than at the next tick', async () => {
  let row: Record<string, unknown> = {
    id: RUNNER,
    ownerId: 'owner-1',
    status: RunnerStatus.ONLINE,
    capabilities: [CLAUDE_ACCOUNT_REMOVE_V1],
    capabilitiesReportedAt: new Date(),
  };
  const prisma = {
    runner: {
      findFirst: async () => row,
      update: async ({ data }: { data: Record<string, unknown> }) => (row = { ...row, ...data }),
    },
  };
  const woken: string[] = [];
  const realtime = { notifyRunnerWake: (id: string) => woken.push(id) };
  const runners = new RunnersService(prisma as never, realtime as never);

  const state = await runners.removeAccount('owner-1', RUNNER, 'claude', 'a1b2c3d4');
  assert.equal(state.status, 'pending');
  assert.deepEqual(woken, [RUNNER]);
});

test('a wake a queue writes in its own transaction names the runner that will run the job', async () => {
  const calls: unknown[][] = [];
  const tx = {
    $executeRawUnsafe: async (...args: unknown[]) => {
      calls.push(args);
      return 0;
    },
  } as unknown as Prisma.TransactionClient;

  await notifyRunnerWakeOnCommit(tx, RUNNER);
  assert.equal(calls.length, 1, 'one notification per queued job');
  assert.match(String(calls[0][0]), /pg_notify/);
  assert.equal(calls[0][1], 'orbit_runner_wake');
  assert.deepEqual(JSON.parse(String(calls[0][2])), { r: RUNNER, c: true });

  // A job whose session names no runner (a workspace removed under it) wakes nobody, and must not
  // emit a notification that would wake the wrong thing.
  await notifyRunnerWakeOnCommit(tx, null);
  await notifyRunnerWakeOnCommit(tx, undefined);
  assert.equal(calls.length, 1);
});

test('a committed wake is delivered to the replica that wrote it, unlike the one it already emitted', async () => {
  const { realtime } = hub();
  const mine = instanceIdOf(realtime);

  // A payload from our own instance is one this replica emitted locally a moment ago: delivering it
  // again would be the second wake of the same fact.
  const alreadyEmitted = realtime.waitForRunnerWake(RUNNER, 60);
  deliver(realtime, { i: mine, r: RUNNER });
  assert.equal(await alreadyEmitted, false);

  // A committed wake has had no local emission — nobody has been woken yet — so this replica takes
  // its own delivery. That is the whole reason the payload carries `c`.
  const committed = realtime.waitForRunnerWake(RUNNER, 5_000);
  deliver(realtime, { r: RUNNER, c: true });
  assert.equal(await committed, true);
});
