import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RUNNER_REAP_AFTER_MS, ReaperService } from './reaper.service';

/**
 * A managed runner's manager marks its runner row OFFLINE when it records a proven stop of the instance
 * (managed-runner-manager.ts `terminated`), then starts the next generation on the same volume, which reclaims the
 * runner's RUNNING sessions. That OFFLINE is no sign-off: its sessions are reaped by the heartbeat's age, as for a
 * crash, and not at the next sweep. A self-managed runner's OFFLINE is still a sign-off, reaped at once.
 */

const RUNNER_ID = '22222222-2222-4222-8222-222222222223';
const SESSION_ID = '11111111-1111-4111-8111-111111111112';

function reaperFor(runner: { managed: boolean; beatAgoMs: number }) {
  const finalized: Array<Record<string, unknown>> = [];
  const row = () => ({
    status: 'OFFLINE',
    lastHeartbeatAt: new Date(Date.now() - runner.beatAgoMs),
    managedRunner: runner.managed ? { id: 'mapping' } : null,
  });
  const tx = {
    session: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        finalized.push(data);
        return { count: 1 };
      },
      count: async () => 0,
      // The released row, read back for the STATUS event's word; the event is not asserted here.
      findUnique: async () => null,
    },
    runner: { findUnique: async () => row() },
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
        provider: 'deepseek',
        providerBuiltin: false,
        runtimeSessionId: null,
        lastTurnAt: new Date(Date.now() - RUNNER_REAP_AFTER_MS - 60_000),
        runClaimedAt: new Date(Date.now() - RUNNER_REAP_AFTER_MS - 60_000),
        cancelRequestedAt: null,
        endReason: null,
        startsTaskWork: true,
        task: null,
        assignedRunner: row(),
      }],
    },
    runEvent: { findFirst: async () => null },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const realtime = {
    requestCancel: () => undefined,
    publish: () => undefined,
    publishTaskChanged: () => undefined,
    publishQueuedTurnsChanged: () => undefined,
  } as never;
  const service = new ReaperService(prisma, realtime);
  return { sweep: () => (service as unknown as { sweep(): Promise<void> }).sweep(), finalized };
}

test('a managed runner its manager just marked OFFLINE keeps its RUNNING session for the next generation to reclaim', async () => {
  const reaper = reaperFor({ managed: true, beatAgoMs: 10_000 });
  await reaper.sweep();
  assert.deepEqual(reaper.finalized, [], 'heard from 10 s ago: not reaped for the OFFLINE its manager wrote');
});

test('a managed runner silent past the reap line is reaped, OFFLINE or not', async () => {
  const reaper = reaperFor({ managed: true, beatAgoMs: RUNNER_REAP_AFTER_MS + 60_000 });
  await reaper.sweep();
  assert.equal(reaper.finalized[0]?.error, 'runner offline');
});

test('a self-managed runner that signed off OFFLINE is reaped at once, as before', async () => {
  const reaper = reaperFor({ managed: false, beatAgoMs: 10_000 });
  await reaper.sweep();
  assert.equal(reaper.finalized[0]?.error, 'runner offline');
});
