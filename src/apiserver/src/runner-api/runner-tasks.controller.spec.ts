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

test('dependency graph and edge edits stay owner-scoped through TasksService', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const tasks = {
    dependencyGraph: async (...args: unknown[]) => {
      calls.push({ method: 'dependencyGraph', args });
      return { focusTaskId: args[1] };
    },
    addDependency: async (...args: unknown[]) => {
      calls.push({ method: 'addDependency', args });
      return { added: true };
    },
    removeDependency: async (...args: unknown[]) => {
      calls.push({ method: 'removeDependency', args });
      return { removed: true };
    },
  } as never;
  const controller = new RunnerTasksController(tasks, {} as never);

  await controller.getTaskDependencyGraph(RUNNER, 'task-1', '12', '300');
  await controller.addTaskDependency(RUNNER, 'task-1', { dependsOnTaskId: 'task-0' });
  await controller.removeTaskDependency(RUNNER, 'task-1', 'task-0');

  assert.deepEqual(calls, [
    { method: 'dependencyGraph', args: ['owner-1', 'task-1', { maxDepth: '12', maxNodes: '300' }] },
    { method: 'addDependency', args: ['owner-1', 'task-1', 'task-0'] },
    { method: 'removeDependency', args: ['owner-1', 'task-1', 'task-0'] },
  ]);
});

test('runner dependency routes expose bounded read and granular writes', () => {
  const routes: Array<[keyof RunnerTasksController, string, RequestMethod]> = [
    ['getTaskDependencyGraph', 'tasks/:id/dependency-graph', RequestMethod.GET],
    ['addTaskDependency', 'tasks/:id/dependencies', RequestMethod.POST],
    ['removeTaskDependency', 'tasks/:id/dependencies/:dependsOnTaskId', RequestMethod.DELETE],
  ];
  for (const [name, path, method] of routes) {
    const handler = RunnerTasksController.prototype[name];
    assert.equal(Reflect.getMetadata(PATH_METADATA, handler), path);
    assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), method);
  }
});
