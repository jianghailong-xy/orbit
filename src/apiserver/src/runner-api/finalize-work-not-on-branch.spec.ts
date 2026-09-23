import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunStatus as SharedRunStatus, type RunFinalizeRequest } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

/**
 * What finalize records when the runner could not put the session's work on its branch.
 *
 * The combination this exists for: a task reaches DONE, its EXECUTABLE acceptance command passed,
 * and its branch has no commits at all. All three are true together because the acceptance command
 * runs against the WORKING TREE — where the work is — and the commit that would capture it happens
 * afterwards, at finalization, where a stale `index.lock` in the checkout's git dir is enough to
 * refuse it. The refusal used to be a line in one runner process's log; the control plane recorded
 * `worktreeDirty: false` on top of it, which is not something it had observed but something it
 * assumed, and that assumption also hid the one action that could have rescued the work.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const BRANCH = 'orbit/verification-manual-completion-policy-1ef173';
const LOCK_REFUSAL =
  "staging the work of session 1fb00a1b failed: fatal: Unable to create " +
  "'/root/orbit/.git/worktrees/1fb00a1b/index.lock': File exists.";

function makeController({
  taskId = TASK_ID as string | null,
  commitStatus = null as string | null,
} = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const comments: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID, leaseOwnerMatches: true }],
    $executeRaw: async () => 1,
    session: {
      findUniqueOrThrow: async () => ({
        id: SESSION_ID,
        assignedRunnerId: RUNNER_ID,
        status: RunStatus.RUNNING,
        taskId,
        branch: BRANCH,
        cancelRequestedAt: null,
        endReason: null,
        completedAt: null,
        archivedAt: null,
        deletedAt: null,
        provider: 'claude',
        retryAt: null,
        numTurns: 6,
        commitStatus,
      }),
      // What the reaper reads to decide whether a card raised by a runner-hosted job is still a
      // live question (see `sessions/abandoned-approvals.ts`). No job is up here, so every card in
      // this fixture is the turn's and goes with it.
      findUnique: async () => ({ runningBgShells: [] }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { count: 1 };
      },
      count: async () => 0,
    },
    conversationTurn: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      findMany: async () => [],
    },
    approval: { updateMany: async () => ({ count: 0 }), findMany: async () => [] },
    runner: { findUnique: async () => ({ planUsage: null }) },
    sessionDiff: { upsert: async () => ({}) },
    // The task side of the same transaction: reclaimStalledTask's nudge, and the timeline the
    // stranded-work signal is written to.
    task: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => ({ assigneeId: null, creatorType: 'AGENT', creatorId: 'agent-1' }),
    },
    taskComment: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        comments.push(data);
        return data;
      },
    },
  };
  const prisma = { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) } as never;
  const realtime = {
    publish: () => undefined,
    publishQueuedTurnsChanged: () => undefined,
    publishTaskChanged: () => undefined,
  } as never;
  return {
    controller: new RunnerApiController(
      prisma,
      {} as never,
      realtime,
      {} as never,
      {} as never,
      {} as never,
      { appendFor: async (_tx: unknown, _s: unknown, content?: string) => content } as never,
    ),
    updates,
    comments,
  };
}

function finalize(
  controller: RunnerApiController,
  dto: Partial<RunFinalizeRequest> & { status: SharedRunStatus },
) {
  return controller.finalize({ id: RUNNER_ID }, SESSION_ID, dto as RunFinalizeRequest);
}

test('a finalize that could not capture the work records the checkout as still dirty', async () => {
  const h = makeController();

  await finalize(h.controller, {
    status: SharedRunStatus.SUCCEEDED,
    branch: BRANCH,
    changedFiles: [],
    captureError: LOCK_REFUSAL,
    worktreeDirty: true,
  });

  assert.equal(
    h.updates[0].worktreeDirty,
    true,
    'the runner measured the checkout; the control plane must not overwrite that with its own assumption',
  );
  assert.equal(h.updates[0].commitStatus, 'error');
  assert.match(String(h.updates[0].commitError), /index\.lock/);
});

test('a finalize that captured the work leaves the session clean and says nothing about commits', async () => {
  const h = makeController();

  await finalize(h.controller, {
    status: SharedRunStatus.SUCCEEDED,
    branch: BRANCH,
    changedFiles: [{ path: 'src/main.ts', additions: 3, deletions: 1, status: 'modified' }],
    worktreeDirty: false,
  });

  assert.equal(h.updates[0].worktreeDirty, false);
  assert.equal(h.updates[0].commitStatus, undefined, 'a successful finalize is not a commit failure');
  assert.equal(h.comments.length, 0);
});

test('a runner too old to report keeps the historical answer', async () => {
  const h = makeController();

  await finalize(h.controller, { status: SharedRunStatus.SUCCEEDED, branch: BRANCH });

  assert.equal(h.updates[0].worktreeDirty, false);
});

/**
 * The one that makes "DONE, acceptance passed, zero commits" impossible to hold quietly. The run
 * SUCCEEDED and the task is already DONE by the time this is written — nothing else about that
 * task will ever mention that its branch is empty.
 */
test('a successful run whose work never reached its branch says so on the task', async () => {
  const h = makeController();

  await finalize(h.controller, {
    status: SharedRunStatus.SUCCEEDED,
    branch: BRANCH,
    captureError: LOCK_REFUSAL,
    worktreeDirty: true,
  });

  assert.equal(h.comments.length, 1, 'one stranded run, one comment');
  const body = String(h.comments[0].body);
  assert.equal(h.comments[0].taskId, TASK_ID);
  assert.match(body, /WORK_NOT_ON_BRANCH/, 'the signal is machine-findable on the timeline');
  assert.match(body, new RegExp(BRANCH), 'it names the branch that does not have the work');
  assert.match(body, /index\.lock/, "and carries git's own words for why");
  assert.match(body, /Commit/, 'and says how to get the work onto the branch without a new run');
});

test('a commit still in flight keeps its own outcome — finalize does not answer for it', async () => {
  const h = makeController({ commitStatus: 'pending' });

  await finalize(h.controller, {
    status: SharedRunStatus.SUCCEEDED,
    branch: BRANCH,
    captureError: LOCK_REFUSAL,
    worktreeDirty: true,
  });

  assert.equal(h.updates[0].commitStatus, undefined, 'the pending operation is still owed a result');
  assert.equal(h.updates[0].commitError, undefined);
  assert.equal(h.updates[0].worktreeDirty, true, 'the checkout is still reported as it was measured');
  assert.equal(h.comments.length, 1, 'and the task is told either way');
});

test('a stranded run with no task writes no comment and still records the dirty checkout', async () => {
  const h = makeController({ taskId: null });

  await finalize(h.controller, {
    status: SharedRunStatus.SUCCEEDED,
    branch: BRANCH,
    captureError: LOCK_REFUSAL,
    worktreeDirty: true,
  });

  assert.equal(h.comments.length, 0);
  assert.equal(h.updates[0].worktreeDirty, true);
});
