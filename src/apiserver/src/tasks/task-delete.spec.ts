import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_OWNER_ID = '00000000-0000-7000-8000-000000000002';
const TASK_A = '550e8400-e29b-41d4-a716-446655440000';
const TASK_B = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_TASK = '550e8400-e29b-41d4-a716-446655440002';

function serviceWith(prisma: unknown): TasksService {
  return new TasksService(prisma as never, {} as never, {} as never);
}

test('batch delete is exposed as POST tasks/batch-delete and forwards the authenticated owner', async () => {
  const seen: { ownerId?: string; taskIds?: string[] } = {};
  const expected = { deleted: 2 };
  const tasks = {
    batchDelete: async (ownerId: string, taskIds: string[]) => {
      seen.ownerId = ownerId;
      seen.taskIds = taskIds;
      return expected;
    },
  } as never;
  const controller = new TasksController(tasks);

  const result = await controller.batchDelete(
    { userId: OWNER_ID, email: 'owner@example.com' },
    { taskIds: [TASK_A, TASK_B] },
  );

  assert.deepEqual(seen, { ownerId: OWNER_ID, taskIds: [TASK_A, TASK_B] });
  assert.equal(result, expected);
  const handler = TasksController.prototype.batchDelete;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'batch-delete');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.POST);
});

test('batch delete deduplicates ids and deletes only rows owned by the caller', async () => {
  const rows = new Map([
    [TASK_A, OWNER_ID],
    [TASK_B, OWNER_ID],
    [OTHER_TASK, OTHER_OWNER_ID],
  ]);
  let deleteWhere: any;
  const service = serviceWith({
    task: {
      deleteMany: async ({ where }: any) => {
        deleteWhere = where;
        let count = 0;
        for (const id of where.id.in) {
          if (rows.get(id) === where.ownerId) {
            rows.delete(id);
            count += 1;
          }
        }
        return { count };
      },
    },
  });

  const result = await service.batchDelete(OWNER_ID, [TASK_A, TASK_A, OTHER_TASK, TASK_B]);

  assert.deepEqual(deleteWhere, {
    ownerId: OWNER_ID,
    id: { in: [TASK_A, OTHER_TASK, TASK_B] },
  });
  assert.deepEqual(result, { deleted: 2 });
  assert.equal(rows.has(TASK_A), false);
  assert.equal(rows.has(TASK_B), false);
  assert.equal(rows.get(OTHER_TASK), OTHER_OWNER_ID);
});

test('empty batch delete is a no-op', async () => {
  let writes = 0;
  const service = serviceWith({
    task: {
      deleteMany: async () => {
        writes += 1;
        return { count: 0 };
      },
    },
  });

  assert.deepEqual(await service.batchDelete(OWNER_ID, []), { deleted: 0 });
  assert.equal(writes, 0);
});

test('single delete rejects malformed and non-owned ids before deleting', async () => {
  let lookups = 0;
  let deletes = 0;
  let lookupWhere: any;
  const service = serviceWith({
    task: {
      findFirst: async ({ where }: any) => {
        lookups += 1;
        lookupWhere = where;
        return null;
      },
      delete: async () => {
        deletes += 1;
      },
    },
  });

  await assert.rejects(service.remove(OWNER_ID, 'not-a-uuid'), /task not found/);
  assert.equal(lookups, 0);

  await assert.rejects(service.remove(OWNER_ID, OTHER_TASK), /task not found/);
  assert.deepEqual(lookupWhere, { id: OTHER_TASK, ownerId: OWNER_ID });
  assert.equal(deletes, 0);
});

test('single delete hard-deletes an owned task', async () => {
  let deletedId: string | undefined;
  const service = serviceWith({
    task: {
      findFirst: async () => ({
        id: TASK_A,
        ownerId: OWNER_ID,
        status: 'CANCELLED',
        creatorSessionId: null,
        comments: [],
        dependsOn: [],
      }),
      delete: async ({ where }: any) => {
        deletedId = where.id;
        return { id: where.id };
      },
    },
  });

  assert.deepEqual(await service.remove(OWNER_ID, TASK_A), { ok: true });
  assert.equal(deletedId, TASK_A);
});
