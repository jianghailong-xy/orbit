import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { PublicIdPipe } from '../common/public-id';
import { RunnerProjectsController } from './runner-projects.controller';

const RUNNER = { id: 'runner-1', ownerId: 'owner-1' } as never;

test('getProject reads the project through ProjectsService, scoped to the runner owner', async () => {
  const seen: { ownerId?: string; projectId?: string } = {};
  const expected = {
    id: 'project-1',
    title: 'Crawl',
    goal: 'Index the corpus',
    acceptanceCriteria: 'Every shard reported',
    instructions: 'Work shard by shard',
    status: 'OPEN',
    coordinatorSessionId: 'session-1',
    coordinatorWorkspaceId: 'workspace-1',
    _count: { tasks: 3 },
    tasksByStatus: { OPEN: 2, DONE: 1 },
  };
  const projects = {
    get: async (ownerId: string, projectId: string) => {
      seen.ownerId = ownerId;
      seen.projectId = projectId;
      return expected;
    },
  } as never;
  const controller = new RunnerProjectsController(projects);

  const result = await controller.getProject(RUNNER, 'project-1');

  assert.deepEqual(seen, { ownerId: 'owner-1', projectId: 'project-1' });
  // Returned verbatim: the runner door must not reshape a payload the user door already defines,
  // or the two drift and an agent reads a different project than a person does.
  assert.equal(result, expected);
});

test('a project belonging to another owner stays a 404 from the service', async () => {
  const projects = {
    get: async () => {
      throw new Error('project not found');
    },
  } as never;
  const controller = new RunnerProjectsController(projects);

  await assert.rejects(() => controller.getProject(RUNNER, 'someone-elses-project'), /not found/);
});

test('getProject is exposed as GET projects/:id', () => {
  const handler = RunnerProjectsController.prototype.getProject;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'projects/:id');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.GET);
});

// The id an agent holds is the base62 short form (that is what every payload encodes ids as), so
// the param has to decode before it reaches a `@db.Uuid` column — the same gate the user-facing
// ProjectsController puts on the same id.
test('the project id is resolved through PublicIdPipe', () => {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, RunnerProjectsController, 'getProject') as
    | Record<string, { data?: unknown; pipes?: unknown[] }>
    | undefined;
  const idArg = Object.values(args ?? {}).find((arg) => arg.data === 'id');
  assert.ok(idArg, 'no id param on getProject');
  assert.ok(
    (idArg.pipes ?? []).some((pipe) => pipe === PublicIdPipe || pipe instanceof PublicIdPipe),
    'id does not resolve through PublicIdPipe',
  );
});

// This controller is a read bridge and nothing else. A project's goal, acceptance criteria and
// instructions say what the work is for and when it is finished; a coordinator that could rewrite
// them through its own runner credential could declare itself done.
test('the runner project bridge exposes exactly one route, and it only reads', () => {
  const handlers = Object.getOwnPropertyNames(RunnerProjectsController.prototype).filter(
    (name) => name !== 'constructor',
  );
  assert.deepEqual(handlers, ['getProject']);
  for (const name of handlers) {
    const handler = (RunnerProjectsController.prototype as never)[name];
    assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.GET);
  }
});
