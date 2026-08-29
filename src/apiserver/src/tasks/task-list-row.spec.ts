import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { TasksController } from './tasks.controller';
import { TASK_LIST_SELECT, TasksService } from './tasks.service';
import { recordingQueryRaw } from './query-raw-test-helper';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';

test('GET tasks/:id/row forwards the authenticated owner to the lightweight read', async () => {
  const seen: { ownerId?: string; taskId?: string } = {};
  const expected = { id: TASK_ID, title: 'row' };
  const tasks = {
    listRow: async (ownerId: string, taskId: string) => {
      seen.ownerId = ownerId;
      seen.taskId = taskId;
      return expected;
    },
  } as never;
  const controller = new TasksController(tasks, {} as never);

  const result = await controller.listRow(
    { userId: OWNER_ID, email: 'owner@example.com' },
    TASK_ID,
  );

  assert.equal(result, expected);
  assert.deepEqual(seen, { ownerId: OWNER_ID, taskId: TASK_ID });
  const handler = TasksController.prototype.listRow;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), ':id/row');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.GET);
});

test('listRow reuses the page select and restricts live overlays to the one owned task', async () => {
  let taskRead: any;
  let busyRead: any;
  const raw = recordingQueryRaw(() => [{ id: TASK_ID }]);
  const stored = {
    id: TASK_ID,
    title: 'incremental row',
    status: 'OPEN',
    createdAt: new Date('2026-08-25T00:00:00.000Z'),
  };
  const prisma = {
    task: {
      findFirst: async (args: any) => {
        taskRead = args;
        return stored;
      },
    },
    session: {
      groupBy: async (args: any) => {
        busyRead = args;
        return [{ taskId: TASK_ID, status: 'PENDING', _count: { _all: 1 } }];
      },
    },
    taskDependency: { findMany: async () => [] },
    $queryRaw: raw.$queryRaw,
  };
  const service = new TasksService(prisma as never, {} as never, {} as never);

  const row = await service.listRow(OWNER_ID, TASK_ID);

  assert.deepEqual(taskRead.where, { id: TASK_ID, ownerId: OWNER_ID });
  assert.equal(taskRead.select, TASK_LIST_SELECT, 'the endpoint must not grow a second list DTO');
  assert.deepEqual(busyRead.where, {
    ownerId: OWNER_ID,
    taskId: { in: [TASK_ID] },
    status: { in: ['PENDING', 'RUNNING'] },
  });
  assert.equal(row.running, false);
  assert.equal(row.queued, true);
  assert.equal(row.dependencyState, 'NONE');
  assert.equal(row.blocked, false);
  assert.equal(row.runnable, true);
  assert.equal(raw.statements.length, 1, 'one shared predicate read covers the row');
  assert.equal(raw.statements[0].invocation, 'sql-object');
  assert.match(raw.statements[0].text, /SELECT t\.id/);
  assert.deepEqual(raw.statements[0].values.slice(0, 2), [OWNER_ID, TASK_ID]);
});

test('listRow returns 404 before reading overlays for an unknown or cross-tenant id', async () => {
  let overlayReads = 0;
  const service = new TasksService(
    {
      task: { findFirst: async () => null },
      session: { groupBy: async () => { overlayReads += 1; return []; } },
      taskDependency: { findMany: async () => { overlayReads += 1; return []; } },
    } as never,
    {} as never,
    {} as never,
  );

  await assert.rejects(service.listRow(OWNER_ID, TASK_ID), /task not found/);
  assert.equal(overlayReads, 0);
});
