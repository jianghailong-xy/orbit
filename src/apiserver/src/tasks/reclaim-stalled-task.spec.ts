import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CreatorType, TaskStatus } from '@prisma/client';
import { postRunFailureComment, reclaimStalledTask } from './reclaim-stalled-task';

// Minimal fake of the bits of Prisma.TransactionClient postRunFailureComment touches:
// it reads the task, then creates one comment. We capture the created comment.
function fakeTx(task: unknown) {
  const created: any[] = [];
  const tx = {
    task: { findUnique: async () => task },
    taskComment: {
      create: async ({ data }: { data: any }) => {
        created.push(data);
        return data;
      },
    },
  };
  return { tx: tx as any, created };
}

test('failure comment is attributed to the assignee workspace when set', async () => {
  const { tx, created } = fakeTx({
    assigneeId: 'workspace-1',
    creatorType: CreatorType.USER,
    creatorId: 'user-1',
  });
  await postRunFailureComment(tx, 'task-1', 'API Error: blocked');
  assert.equal(created.length, 1);
  assert.equal(created[0].authorType, CreatorType.AGENT);
  assert.equal(created[0].authorId, 'workspace-1');
  assert.equal(created[0].taskId, 'task-1');
  assert.match(created[0].body, /API Error: blocked/);
});

test('falls back to the task creator when there is no assignee', async () => {
  const { tx, created } = fakeTx({
    assigneeId: null,
    creatorType: CreatorType.USER,
    creatorId: 'user-1',
  });
  await postRunFailureComment(tx, 'task-1', 'run failed');
  assert.equal(created[0].authorType, CreatorType.USER);
  assert.equal(created[0].authorId, 'user-1');
});

test('no-op when the task no longer exists', async () => {
  const { tx, created } = fakeTx(null);
  await postRunFailureComment(tx, 'gone', 'run failed');
  assert.equal(created.length, 0);
});

const TASK = '550e8400-e29b-41d4-a716-446655440000';

function fixture(occupied: number, changed: number) {
  const writes: unknown[] = [];
  const tx = {
    session: { count: async () => occupied },
    task: {
      updateMany: async (args: unknown) => {
        writes.push(args);
        return { count: changed };
      },
    },
  };
  return { tx, writes };
}

test('reclaim reports the exact IN_PROGRESS status transition', async () => {
  const f = fixture(0, 1);

  assert.equal(await reclaimStalledTask(f.tx as never, TASK, TaskStatus.FAILED), true);
  assert.deepEqual(f.writes, [{
    where: { id: TASK, status: 'IN_PROGRESS' },
    data: { status: TaskStatus.FAILED },
  }]);
});

test('reclaim reports false when another session still occupies the task', async () => {
  const f = fixture(1, 1);

  assert.equal(await reclaimStalledTask(f.tx as never, TASK), false);
  assert.deepEqual(f.writes, []);
});

test('reclaim reports false when the task no longer has IN_PROGRESS status', async () => {
  const f = fixture(0, 0);

  assert.equal(await reclaimStalledTask(f.tx as never, TASK), false);
  assert.equal(f.writes.length, 1, 'the conditional update was attempted once');
});
