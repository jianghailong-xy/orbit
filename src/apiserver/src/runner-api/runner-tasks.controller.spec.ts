import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RunnerTasksController } from './runner-tasks.controller';

const RUNNER = { id: 'runner-1', ownerId: 'owner-1' } as never;

test('executeTask starts the owned task through TasksService', async () => {
  const seen: { ownerId?: string; taskId?: string } = {};
  const expected = { ok: true, sessionId: 'session-1' };
  const tasks = {
    execute: async (ownerId: string, taskId: string) => {
      seen.ownerId = ownerId;
      seen.taskId = taskId;
      return expected;
    },
  } as never;
  const controller = new RunnerTasksController(tasks, {} as never);

  const result = await controller.executeTask(RUNNER, 'task-1');

  assert.deepEqual(seen, { ownerId: 'owner-1', taskId: 'task-1' });
  assert.equal(result, expected);
});

test('executeTask is exposed as POST tasks/:id/execute', () => {
  const handler = RunnerTasksController.prototype.executeTask;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'tasks/:id/execute');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.POST);
});
