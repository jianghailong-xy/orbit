import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TasksService } from './tasks.service';

test('a fresh task run creates an Active-list session', async () => {
  const createCalls: unknown[][] = [];
  const prisma = {
    task: {
      findFirst: async () => ({
        id: 'task-1',
        title: 'Ship it',
        description: null,
        assignee: { id: 'workspace-1', runnerId: 'runner-1' },
      }),
    },
    taskDependency: { findMany: async () => [] },
    session: { findFirst: async () => null },
  } as never;
  const sessions = {
    create: async (...args: unknown[]) => {
      createCalls.push(args);
      return { id: 'session-1' };
    },
  } as never;
  const service = new TasksService(prisma, sessions, {} as never);

  const result = await service.execute('owner-1', 'task-1');

  assert.deepEqual(result, { ok: true, sessionId: 'session-1' });
  assert.equal(createCalls.length, 1);
  assert.equal((createCalls[0][1] as { taskId?: string }).taskId, 'task-1');
  assert.deepEqual(createCalls[0][2], { source: 'user', batch: undefined });
});
