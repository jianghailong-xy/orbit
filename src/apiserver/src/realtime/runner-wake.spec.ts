import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { RunnerStatus } from '@orbit/shared';
import { RunnersService } from '../runners/runners.service';
import { CLAUDE_ACCOUNT_REMOVE_V1 } from '../runner-api/runner-api.controller';
import { notifyRunnerWakeOnCommit } from './runner-wake';

/**
 * A sign-in from the web reaches the runner on its heartbeat, which used to mean up to thirty seconds
 * after the press — twice over for Claude, whose pasted code takes a second heartbeat. The runner now
 * beats the moment one of those is waiting, on a hint (runner-hints.spec.ts).
 */

const RUNNER = 'runner-1';

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

