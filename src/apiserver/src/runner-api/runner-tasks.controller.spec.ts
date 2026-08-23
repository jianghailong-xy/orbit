import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RunnerTasksController } from './runner-tasks.controller';

const RUNNER = { id: 'runner-1', ownerId: 'owner-1' } as never;

test('executeTask starts the owned task through TasksService', async () => {
  const seen: { ownerId?: string; taskId?: string; triggerId?: string } = {};
  const expected = { ok: true, sessionId: 'session-1' };
  const tasks = {
    execute: async (ownerId: string, taskId: string, _auto: unknown, triggerId?: string) => {
      seen.ownerId = ownerId;
      seen.taskId = taskId;
      seen.triggerId = triggerId;
      return expected;
    },
  } as never;
  const controller = new RunnerTasksController(tasks, {} as never, {} as never);

  // The id of THIS `task_start`, which the runner reuses across every transport retry of it: two
  // deliveries of one tool call must be one run, and that is only decidable from a carried token.
  const result = await controller.executeTask(RUNNER, 'task-1', { triggerId: 'press-1' });

  assert.deepEqual(seen, { ownerId: 'owner-1', taskId: 'task-1', triggerId: 'press-1' });
  assert.equal(result, expected);
});

test('executeTask still starts the task for a runner that names no press', async () => {
  // Every runner predating the field sends no body at all, and Nest hands the handler `{}`.
  const seen: { triggerId?: string } = { triggerId: 'unset' };
  const tasks = {
    execute: async (_o: string, _t: string, _auto: unknown, triggerId?: string) => {
      seen.triggerId = triggerId;
      return { ok: true };
    },
  } as never;
  const controller = new RunnerTasksController(tasks, {} as never, {} as never);

  await controller.executeTask(RUNNER, 'task-1', {});

  assert.equal(seen.triggerId, undefined);
});

test('executeTask is exposed as POST tasks/:id/execute', () => {
  const handler = RunnerTasksController.prototype.executeTask;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'tasks/:id/execute');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.POST);
});

test('deleteTask removes the owned task through TasksService', async () => {
  const seen: { ownerId?: string; taskId?: string } = {};
  const expected = { ok: true };
  const tasks = {
    remove: async (ownerId: string, taskId: string) => {
      seen.ownerId = ownerId;
      seen.taskId = taskId;
      return expected;
    },
  } as never;
  const controller = new RunnerTasksController(tasks, {} as never, {} as never);

  const result = await controller.deleteTask(RUNNER, 'task-1');

  assert.deepEqual(seen, { ownerId: 'owner-1', taskId: 'task-1' });
  assert.equal(result, expected);
});

test('deleteTask is exposed as DELETE tasks/:id', () => {
  const handler = RunnerTasksController.prototype.deleteTask;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'tasks/:id');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.DELETE);
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
  const controller = new RunnerTasksController(tasks, {} as never, {} as never);

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

test('createTasks batches through TasksService with the acting workspace as creator', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const created = [{ id: 'task-1', ref: 's0' }];
  const tasks = {
    resolveAgentCreator: async (...args: unknown[]) => {
      calls.push({ method: 'resolveAgentCreator', args });
      return { type: 'AGENT', id: 'workspace-1' };
    },
    createMany: async (...args: unknown[]) => {
      calls.push({ method: 'createMany', args });
      return created;
    },
  } as never;
  const controller = new RunnerTasksController(tasks, {} as never, {} as never);
  const dto = { tasks: [{ title: 'S0', ref: 's0' }] } as never;

  const result = await controller.createTasks(RUNNER, 'workspace-1', undefined, 'session-1', dto);

  assert.equal(result, created);
  assert.deepEqual(calls[0], { method: 'resolveAgentCreator', args: ['owner-1', 'workspace-1'] });
  assert.deepEqual(calls[1], {
    method: 'createMany',
    args: ['owner-1', dto, { type: 'AGENT', id: 'workspace-1' }, 'session-1'],
  });
});

test('createTasks is exposed as POST tasks/batch-create', () => {
  const handler = RunnerTasksController.prototype.createTasks;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'tasks/batch-create');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.POST);
});

test('the acting workspace is read from either spelling of the header', async () => {
  // Migration 0094 renamed the server's header with the entity, but deployed runners still send
  // X-Orbit-Agent-Id — so every in-session write was arriving unattributed and being recorded
  // against the runner owner. Both spellings must resolve until those binaries are replaced.
  const seen: unknown[] = [];
  const tasks = {
    resolveAgentCreator: async (_owner: string, workspaceId?: string) => {
      seen.push(workspaceId);
      return workspaceId ? { type: 'AGENT', id: workspaceId } : undefined;
    },
    addComment: async () => ({ ok: true }),
  } as never;
  const controller = new RunnerTasksController(tasks, {} as never, {} as never);
  const dto = { body: 'x' } as never;

  await controller.addComment(RUNNER, undefined, 'legacy-workspace', 'task-1', dto);
  await controller.addComment(RUNNER, 'new-workspace', undefined, 'task-1', dto);
  // A runner sending both is mid-upgrade; the new name is the one it means.
  await controller.addComment(RUNNER, 'new-workspace', 'legacy-workspace', 'task-1', dto);

  assert.deepEqual(seen, ['legacy-workspace', 'new-workspace', 'new-workspace']);
});

test('updateList attributes the policy change to the acting workspace and session', async () => {
  const calls: unknown[][] = [];
  const tasks = {
    resolveAgentCreator: async () => ({ type: 'AGENT', id: 'workspace-1' }),
  } as never;
  const taskLists = {
    update: async (...args: unknown[]) => {
      calls.push(args);
      return { id: 'list-1' };
    },
  } as never;
  const controller = new RunnerTasksController(tasks, taskLists, {} as never);
  const dto = { paused: true, note: 'disk below floor' } as never;

  await controller.updateList(RUNNER, 'workspace-1', undefined, 'session-9', 'list-1', dto);

  assert.deepEqual(calls[0], [
    'owner-1',
    'list-1',
    dto,
    { type: 'AGENT', id: 'workspace-1', sessionId: 'session-9' },
  ]);
});

test('a headless runner update carries no agent author', async () => {
  // No workspace header at all: the change is the runner owner's, and claiming an agent made it
  // would put a fabricated author on a restorable revision.
  const calls: unknown[][] = [];
  const tasks = { resolveAgentCreator: async () => undefined } as never;
  const taskLists = {
    update: async (...args: unknown[]) => {
      calls.push(args);
      return { id: 'list-1' };
    },
  } as never;
  const controller = new RunnerTasksController(tasks, taskLists, {} as never);

  await controller.updateList(RUNNER, undefined, undefined, undefined, 'list-1', {} as never);

  assert.equal(calls[0][3], undefined);
});

test('deleteList removes the owned list through TaskListsService', async () => {
  const seen: { ownerId?: string; listId?: string } = {};
  const expected = { ok: true };
  const taskLists = {
    remove: async (ownerId: string, listId: string) => {
      seen.ownerId = ownerId;
      seen.listId = listId;
      return expected;
    },
  } as never;
  const controller = new RunnerTasksController({} as never, taskLists, {} as never);

  const result = await controller.deleteList(RUNNER, 'list-1');

  assert.deepEqual(seen, { ownerId: 'owner-1', listId: 'list-1' });
  assert.equal(result, expected);
});

test('deleteList is exposed as DELETE task-lists/:id', () => {
  const handler = RunnerTasksController.prototype.deleteList;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'task-lists/:id');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.DELETE);
});
