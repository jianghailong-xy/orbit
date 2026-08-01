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
      agent: { findMany: async () => [] },
    } as never,
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
