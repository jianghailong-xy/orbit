import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CreatorType } from '@prisma/client';
import { TaskStatus } from '@orbit/shared';
import { TaskListsService } from './task-lists.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const LIST_ID = '00000000-0000-7000-8000-000000000002';
const CREATOR_ID = '00000000-0000-7000-8000-000000000003';

test('named task list rows expose the same dependency lock state as the main task list', async () => {
  const tasks = ['none', 'ready', 'blocked', 'failed'].map((id) => ({
    id,
    creatorType: CreatorType.USER,
    creatorId: CREATOR_ID,
  }));
  let dependencyWhere: unknown;
  const service = new TaskListsService(
    {
      taskList: {
        findFirst: async () => ({ id: LIST_ID, title: 'Pipeline', tasks }),
      },
      session: { groupBy: async () => [] },
      taskDependency: {
        findMany: async (args: any) => {
          dependencyWhere = args.where;
          return [
            { taskId: 'ready', dependsOnTask: { status: TaskStatus.DONE } },
            { taskId: 'blocked', dependsOnTask: { status: TaskStatus.DONE } },
            { taskId: 'blocked', dependsOnTask: { status: TaskStatus.IN_PROGRESS } },
            { taskId: 'failed', dependsOnTask: { status: TaskStatus.CANCELLED } },
          ];
        },
      },
      user: {
        findMany: async () => [{ id: CREATOR_ID, name: 'Owner' }],
      },
      workspace: { findMany: async () => [] },
    } as never,
    {} as never,
    // Only the list console opens sessions; this spec never reaches it.
    {} as never,
  );

  const result = await service.get(OWNER_ID, LIST_ID);
  const stateById = Object.fromEntries(
    result.tasks.map((task) => [
      task.id,
      { dependencyState: task.dependencyState, blocked: task.blocked },
    ]),
  );

  assert.deepEqual(dependencyWhere, { task: { ownerId: OWNER_ID, listId: LIST_ID } });
  assert.deepEqual(stateById, {
    none: { dependencyState: 'NONE', blocked: false },
    ready: { dependencyState: 'READY', blocked: false },
    blocked: { dependencyState: 'BLOCKED', blocked: true },
    failed: { dependencyState: 'BLOCKED_FAILED', blocked: true },
  });
});

test('deleting a list disarms its tasks before tearing down their runs', async () => {
  const calls: string[] = [];
  let updateArgs: any;
  let sessionWhere: unknown;
  const service = new TaskListsService(
    {
      taskList: {
        findFirst: async () => ({ id: LIST_ID, title: 'Pipeline', tasks: [] }),
        delete: async () => {
          calls.push('deleteList');
          return { id: LIST_ID };
        },
      },
      session: {
        groupBy: async () => [],
        findMany: async (args: any) => {
          calls.push('findSessions');
          sessionWhere = args.where;
          return [{ id: 'session-a' }, { id: 'session-b' }];
        },
      },
      task: {
        updateMany: async (args: any) => {
          calls.push('disarm');
          updateArgs = args;
          return { count: 2 };
        },
      },
      taskDependency: { findMany: async () => [] },
      user: { findMany: async () => [] },
      workspace: { findMany: async () => [] },
    } as never,
    { publishForUser: () => undefined } as never,
    {
      cancel: async (_ownerId: string, id: string) => {
        calls.push(`cancel:${id}`);
        return true;
      },
    } as never,
  );

  assert.deepEqual(await service.remove(OWNER_ID, LIST_ID), { ok: true });
  // The sessions have to be read while the tasks still point at the list, and the tasks have to
  // stop being auto-run before anything is cancelled — the other order lets the sweep re-dispatch
  // whatever it catches in between.
  assert.deepEqual(calls, [
    'findSessions',
    'disarm',
    'deleteList',
    'cancel:session-a',
    'cancel:session-b',
  ]);
  assert.deepEqual(sessionWhere, {
    ownerId: OWNER_ID,
    task: { listId: LIST_ID },
    status: { in: ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'] },
  });
  assert.deepEqual(updateArgs, {
    where: { ownerId: OWNER_ID, listId: LIST_ID, autoRunWhenReady: true },
    data: { autoRunWhenReady: false },
  });
});

test('a runner that will not answer does not fail the delete', async () => {
  let deleted = false;
  const service = new TaskListsService(
    {
      taskList: {
        findFirst: async () => ({ id: LIST_ID, title: 'Pipeline', tasks: [] }),
        delete: async () => {
          deleted = true;
          return { id: LIST_ID };
        },
      },
      session: { groupBy: async () => [], findMany: async () => [{ id: 'session-a' }] },
      task: { updateMany: async () => ({ count: 1 }) },
      taskDependency: { findMany: async () => [] },
      user: { findMany: async () => [] },
      workspace: { findMany: async () => [] },
    } as never,
    { publishForUser: () => undefined } as never,
    { cancel: async () => { throw new Error('runner offline'); } } as never,
  );

  assert.deepEqual(await service.remove(OWNER_ID, LIST_ID), { ok: true });
  assert.equal(deleted, true);
});
