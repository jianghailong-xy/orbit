import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus, TaskStatus } from '@prisma/client';
import { ReaperService } from './reaper.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';

/**
 * A RUNNING session whose runner stopped answering heartbeats — a restart, a self-update's
 * drain, a deploy. `task` decides who owns getting the work moving again: nobody at all for a
 * session with no task, the task scheduler for a task that opted into auto-run, and — because
 * that scheduler will not select a task that did not — auto-retry for one that did not.
 */
function sweepWithOfflineRunner(task: { autoRunWhenReady: boolean } | null) {
  let claimData: Record<string, unknown> | undefined;
  const taskChanges: string[] = [];
  let taskColumns: Record<string, unknown> = {};
  const tx = {
    session: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        claimData = data;
        return { count: 1 };
      },
      count: async () => 0,
    },
    // Still silent when the finalize runs, which is what the sweep's snapshot said too. The
    // reaper re-asks here before writing, so this row is what decides these two cases; a runner
    // that had answered by now is reaper-live-runner-fence.spec.ts.
    runner: {
      findUnique: async () => ({
        status: 'ONLINE',
        lastHeartbeatAt: new Date(Date.now() - 120_000),
      }),
    },
    task: { updateMany: async () => ({ count: 1 }) },
    $executeRaw: async () => 1,
    conversationTurn: { updateMany: async () => ({ count: 1 }),
      findFirst: async () => null,
      findMany: async () => [],
    },
  };
  const prisma = {
    session: {
      findMany: async (args?: { select?: { task?: { select?: Record<string, unknown> } } }) => {
        taskColumns = args?.select?.task?.select ?? {};
        // The joined row carries EXACTLY the columns the sweep asked for, and no others. A
        // decision read off a column nobody selected is a decision read off `undefined`, which
        // in this branch happens to spell the same answer as the rule below — so a fixture that
        // handed over the whole task would let "arms nothing task-bound" pass as "consults the
        // opt-in and finds it set". The two are not the same behaviour and this is where they
        // are told apart.
        const taskRow = task
          ? Object.fromEntries(
              Object.entries({
                status: TaskStatus.IN_PROGRESS,
                autoRunWhenReady: task.autoRunWhenReady,
              }).filter(([column]) => taskColumns[column]),
            )
          : null;
        return [
          {
            id: SESSION_ID,
            taskId: task ? TASK_ID : null,
            assignedRunnerId: RUNNER_ID,
            status: RunStatus.RUNNING,
            provider: 'claude',
            providerBuiltin: true,
            runtimeSessionId: 'runtime-1',
            lastTurnAt: new Date(),
            cancelRequestedAt: null,
            endReason: null,
            task: taskRow,
            workspace: { provider: 'claude', providerBuiltin: true },
            // Three missed heartbeats: what the reaper reads as gone.
            assignedRunner: { status: 'ONLINE', lastHeartbeatAt: new Date(Date.now() - 120_000) },
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
    .then(() => ({
      data: claimData as Record<string, unknown> | undefined,
      taskChanges,
      /** Whether the sweep read the opt-in at all — see the fixture's note above. */
      readsAutoRunOptIn: taskColumns.autoRunWhenReady === true,
    }));
}

// Losing the runner says nothing about the work, so this is the one finalize the reaper does
// that AutoRetryService can undo by itself once the machine is back.
test('hands a runner-offline session to auto-retry', async () => {
  const { data } = await sweepWithOfflineRunner(null);
  assert.equal(data?.status, RunStatus.FAILED);
  assert.ok(data?.retryAt instanceof Date, 'armed, so a returning runner resumes it with no one asked');
});

// reclaimStalledTask just put this task back in the actionable pool, and because the task opted
// into auto-run the scheduler will select it from there — that IS its retry. Arming here too
// would run the same work from two mechanisms.
test('leaves an auto-running task\'s session to the task scheduler', async () => {
  const { data, taskChanges, readsAutoRunOptIn } = await sweepWithOfflineRunner({
    autoRunWhenReady: true,
  });
  assert.equal(data?.status, RunStatus.FAILED);
  assert.ok(readsAutoRunOptIn, 'the standing-down is decided from the opt-in, not from having a task');
  assert.equal(data?.retryAt, undefined, 'the task going back to OPEN is already the retry');
  assert.deepEqual(taskChanges, [TASK_ID], 'dependents receive the coarse post-commit invalidation');
});

// ...and the same reclaim releases NOTHING when the task did not opt in: all three auto-run
// candidate scans require `t.auto_run_when_ready = true` (tasks.service.ts AUTO_RUN_READY_SQL,
// PROJECT_INDEPENDENT_READY_SQL, AUTO_RUN_RETRY_CANDIDATE_SQL), so standing down here hands the
// session to a scheduler that will never select it. Two of the four sessions reaped on
// 2026-09-15 were left that way, one of them holding 88 uncommitted lines that only a manual
// patch export saved — the retry the reaper is standing aside FOR has to exist.
test('arms a task-bound session whose task will not auto-run', async () => {
  const { data, taskChanges } = await sweepWithOfflineRunner({ autoRunWhenReady: false });
  assert.equal(data?.status, RunStatus.FAILED);
  assert.ok(
    data?.retryAt instanceof Date,
    'no substitute retry exists, so this session keeps its own — with its worktree and branch',
  );
  assert.deepEqual(taskChanges, [TASK_ID], 'dependents receive the coarse post-commit invalidation');
});
