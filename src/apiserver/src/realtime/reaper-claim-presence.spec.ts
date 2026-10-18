import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { ReaperService } from './reaper.service';

/**
 * A claim is presence. A runner process that has just started claims at once, while its first
 * heartbeat waits for its ticker's first tick, 30 seconds later (runner-go runloop.go); until then
 * the runner row's `lastHeartbeatAt` is whatever its predecessor last wrote. A managed runner woken
 * from sleep is that case every time: its row's heartbeat is as old as the sleep.
 *
 * Field case this pins (task T06 on the lab's real k3s, 2026-10-18): a task's Run Now woke a
 * sleeping managed runner, whose new instance claimed the run at 00:56:34.721; the sweep at
 * 00:56:35.4 read the heartbeat of 00:50:24, from before the sleep, and finalized the run FAILED
 * `runner offline` without one event. A message turn of the same wake had gone through only
 * because it was answered within the second.
 */

const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OFFLINE_AFTER_MS = 90_000;
/** The woken runner's row: the last beat of the instance that went to sleep. */
const SLEPT_MS = 6 * 60_000;

interface Plan {
  /** How long ago the run was claimed, as the sweep's snapshot reads it (null: never). */
  claimedAgoMs: number | null;
  /** …and as the row reads when the finalizing write runs, if it moved in between. */
  claimedAgoAtWriteMs?: number | null;
}

function reaperFor(plan: Plan) {
  const finalized: Array<Record<string, unknown>> = [];
  const wheres: Array<Record<string, unknown>> = [];
  const ago = (ms: number | null | undefined) => (ms == null ? null : new Date(Date.now() - ms));
  const atWrite = plan.claimedAgoAtWriteMs === undefined ? plan.claimedAgoMs : plan.claimedAgoAtWriteMs;
  const tx = {
    session: {
      // The database's half: the row is written only if its own claim is older than the window.
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        wheres.push(where);
        const claimed = ago(atWrite);
        const clause = (where.OR as Array<{ runClaimedAt: null | { lt: Date } }> | undefined) ?? null;
        const matches = !clause || clause.some((c) => (c.runClaimedAt === null ? claimed === null
          : claimed !== null && claimed < c.runClaimedAt.lt));
        if (!matches) return { count: 0 };
        finalized.push(data);
        return { count: 1 };
      },
      count: async () => 0,
    },
    runner: { findUnique: async () => ({ status: 'ONLINE', lastHeartbeatAt: new Date(Date.now() - SLEPT_MS) }) },
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
        lastTurnAt: ago(plan.claimedAgoMs) ?? new Date(Date.now() - SLEPT_MS),
        runClaimedAt: ago(plan.claimedAgoMs),
        cancelRequestedAt: null,
        endReason: null,
        startsTaskWork: true,
        task: null,
        assignedRunner: { status: 'ONLINE', lastHeartbeatAt: new Date(Date.now() - SLEPT_MS) },
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
  return {
    sweep: () => (service as unknown as { sweep(): Promise<void> }).sweep(),
    finalized,
    wheres,
  };
}

test('does not reap the run a just-started runner claimed before its first heartbeat', async () => {
  const reaper = reaperFor({ claimedAgoMs: 700 });
  await reaper.sweep();
  assert.deepEqual(reaper.finalized, [], 'the claim 0.7 s ago is the runner answering, whatever its row last said');
});

// The negative control: a run claimed longer ago than the window, on a runner silent ever since,
// is reaped exactly as before.
test('still reaps a run claimed longer ago than the window on a runner silent since', async () => {
  const reaper = reaperFor({ claimedAgoMs: 3 * 60_000 });
  await reaper.sweep();
  assert.equal(reaper.finalized.length, 1);
  assert.equal(reaper.finalized[0]?.status, RunStatus.FAILED);
  assert.equal(reaper.finalized[0]?.error, 'runner offline');
});

// The verdict is read from the sweep's snapshot and written a transaction later: a run claimed
// again in between (parked, sent a message, claimed by a runner that just started) is not reaped.
test('does not reap a run claimed again between the sweep read and the write', async () => {
  const reaper = reaperFor({ claimedAgoMs: 3 * 60_000, claimedAgoAtWriteMs: 1_000 });
  await reaper.sweep();
  assert.deepEqual(reaper.finalized, [], 'the write asks the row it writes, under its lock');
  assert.ok(reaper.wheres[0]?.OR, 'the finalizing write carries the claim clause');
});

test('reaps a run never claimed, as before, when its runner is silent', async () => {
  const reaper = reaperFor({ claimedAgoMs: null });
  await reaper.sweep();
  assert.equal(reaper.finalized[0]?.error, 'runner offline');
});

// Kept apart from the window on purpose: a claim is presence for as long as a heartbeat would be,
// and no longer.
test('a claim stops counting once it is older than the window', async () => {
  const reaper = reaperFor({ claimedAgoMs: OFFLINE_AFTER_MS + 5_000 });
  await reaper.sweep();
  assert.equal(reaper.finalized.length, 1);
});
