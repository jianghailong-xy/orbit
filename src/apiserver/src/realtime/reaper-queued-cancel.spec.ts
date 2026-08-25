import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus, TaskStatus } from '@prisma/client';
import { ReaperService } from './reaper.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';

/**
 * A cancel that lands while the session is still queued. claim requires
 * `cancel_requested_at IS NULL`, so the row leaves the queue for good the moment the
 * cancel is stamped — nothing will ever pick it up, and before PENDING was swept
 * nothing would ever finalize it either. It sat at "Waiting for a free slot" forever.
 */
function sweepWithCancelledSession(status: RunStatus, taskId: string | null) {
  let finalized: Record<string, unknown> | undefined;
  let expected: unknown;
  const taskChanges: string[] = [];
  const tx = {
    session: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { status?: { in?: RunStatus[] } };
        data: Record<string, unknown>;
      }) => {
        finalized = data;
        expected = where.status?.in;
        return { count: 1 };
      },
      count: async () => 0,
    },
    task: { updateMany: async () => ({ count: 1 }) },
    taskComment: { create: async () => ({}) },
    $executeRaw: async () => 1,
    conversationTurn: { updateMany: async () => ({ count: 1 }),
      findFirst: async () => null,
    },
  };
  const prisma = {
    session: {
      findMany: async ({ where }: { where: { status: { in: RunStatus[] } } }) => {
        // The sweep must actually ask for this status, or the row is never even read.
        if (!where.status.in.includes(status)) return [];
        return [
          {
            id: SESSION_ID,
            taskId,
            assignedRunnerId: RUNNER_ID,
            status,
            provider: 'claude',
            providerBuiltin: true,
            runtimeSessionId: null,
            lastTurnAt: new Date(),
            // Well past CANCEL_GRACE_MS: nobody honored it.
            cancelRequestedAt: new Date(Date.now() - 10 * 60_000),
            endReason: null,
            task: taskId ? { status: TaskStatus.IN_PROGRESS } : null,
            assignedRunner: { status: 'ONLINE', lastHeartbeatAt: new Date() },
          },
        ];
      },
    },
    runEvent: { findFirst: async () => null },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const realtime = {
    requestCancel: () => undefined,
    publish: () => undefined,
    publishTaskChanged: (_sessionId: string, changedTaskId: string) =>
      void taskChanges.push(changedTaskId),
  } as never;
  const service = new ReaperService(prisma, realtime);
  return (service as unknown as { sweep(): Promise<void> })
    .sweep()
    .then(() => ({ finalized, expected, taskChanges }));
}

test('finalizes a cancel that was never honored on a queued session', async () => {
  const { finalized, expected } = await sweepWithCancelledSession(RunStatus.PENDING, null);
  assert.ok(finalized, 'a PENDING row must be swept, not just LIVE ones');
  assert.equal(finalized?.status, RunStatus.CANCELLED);
  assert.deepEqual(expected, [RunStatus.PENDING], 'the CAS is scoped to the status the sweep read');
});

// The session never reached a runner, so there is no failed work to report and no runner
// that failed to honor anything — writing an error would blame a machine never handed it.
test('a queued cancel settles clean, with no error recorded', async () => {
  const { finalized, taskChanges } = await sweepWithCancelledSession(RunStatus.PENDING, TASK_ID);
  assert.equal(finalized?.status, RunStatus.CANCELLED);
  assert.equal(finalized?.error, undefined);
  assert.deepEqual(taskChanges, [TASK_ID]);
});

// Widening the scan must not change what happens to the states that were already swept.
test('an unhonored cancel on a live session still fails as before', async () => {
  const { finalized } = await sweepWithCancelledSession(RunStatus.RUNNING, null);
  assert.equal(finalized?.status, RunStatus.FAILED);
  assert.equal(finalized?.error, 'cancel not honored');
});
