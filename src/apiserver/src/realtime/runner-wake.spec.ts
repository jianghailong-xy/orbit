import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunnerStatus } from '@orbit/shared';
import { RunnersService } from '../runners/runners.service';
import { RealtimeService } from './realtime.service';

/**
 * A sign-in from the web reaches the runner on its heartbeat, which used to mean up to thirty seconds
 * after the press — twice over for Claude, whose pasted code takes a second heartbeat. The runner now
 * parks in GET /runner/wake and beats the moment one of those is waiting.
 */

const RUNNER = 'runner-1';

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
