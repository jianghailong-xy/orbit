import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CreatorType } from '@prisma/client';
import { postRunFailureComment } from './reclaim-stalled-task';

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
