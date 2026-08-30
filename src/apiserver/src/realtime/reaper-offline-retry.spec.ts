import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus, TaskStatus } from '@prisma/client';
import { ReaperService } from './reaper.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';

/**
 * A RUNNING session whose runner stopped answering heartbeats — a restart, a self-update's
 * drain, a deploy. `taskId` decides who owns getting the work moving again.
 */
function sweepWithOfflineRunner(taskId: string | null) {
  let claimData: Record<string, unknown> | undefined;
  const taskChanges: string[] = [];
  const tx = {
    session: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        claimData = data;
        return { count: 1 };
      },
      count: async () => 0,
    },
    task: { updateMany: async () => ({ count: 1 }) },
    $executeRaw: async () => 1,
    conversationTurn: { updateMany: async () => ({ count: 1 }),
      findFirst: async () => null,
      findMany: async () => [],
    },
    conversationTurnStartupFragment: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
  };
  const prisma = {
    session: {
      findMany: async () => [
        {
          id: SESSION_ID,
          taskId,
          assignedRunnerId: RUNNER_ID,
          status: RunStatus.RUNNING,
          provider: 'claude',
          providerBuiltin: true,
          runtimeSessionId: 'runtime-1',
          lastTurnAt: new Date(),
          cancelRequestedAt: null,
          endReason: null,
          task: taskId ? { status: TaskStatus.IN_PROGRESS } : null,
          workspace: { provider: 'claude', providerBuiltin: true },
          // Three missed heartbeats: what the reaper reads as gone.
          assignedRunner: { status: 'ONLINE', lastHeartbeatAt: new Date(Date.now() - 120_000) },
        },
      ],
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
    .then(() => ({ data: claimData as Record<string, unknown> | undefined, taskChanges }));
}

// Losing the runner says nothing about the work, so this is the one finalize the reaper does
// that AutoRetryService can undo by itself once the machine is back.
test('hands a runner-offline session to auto-retry', async () => {
  const { data } = await sweepWithOfflineRunner(null);
  assert.equal(data?.status, RunStatus.FAILED);
  assert.ok(data?.retryAt instanceof Date, 'armed, so a returning runner resumes it with no one asked');
});

// reclaimStalledTask just put this task back in the actionable pool — the scheduler picking it
// up again IS its retry. Arming here too would run the same work from two mechanisms.
test('leaves a task-bound session to the task scheduler', async () => {
  const { data, taskChanges } = await sweepWithOfflineRunner(TASK_ID);
  assert.equal(data?.status, RunStatus.FAILED);
  assert.equal(data?.retryAt, undefined, 'the task going back to OPEN is already the retry');
  assert.deepEqual(taskChanges, [TASK_ID], 'dependents receive the coarse post-commit invalidation');
});
