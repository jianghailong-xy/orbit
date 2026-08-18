import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { ProjectStatus } from '@orbit/shared';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { PublicIdPipe } from '../common/public-id';
import { CreateProjectDto, UpdateProjectDto } from '../projects/dto';
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
// ProjectsController puts on the same id. Both id-bearing routes, not just the read: a write that
// skipped it would hand Prisma a base62 string and answer a legitimate id with a 500.
for (const method of ['getProject', 'updateProject'] as const) {
  test(`the project id is resolved through PublicIdPipe on ${method}`, () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, RunnerProjectsController, method) as
      | Record<string, { data?: unknown; pipes?: unknown[] }>
      | undefined;
    const idArg = Object.values(args ?? {}).find((arg) => arg.data === 'id');
    assert.ok(idArg, `no id param on ${method}`);
    assert.ok(
      (idArg.pipes ?? []).some((pipe) => pipe === PublicIdPipe || pipe instanceof PublicIdPipe),
      'id does not resolve through PublicIdPipe',
    );
  });
}

test('createProject is exposed as POST projects', () => {
  const handler = RunnerProjectsController.prototype.createProject;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'projects');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.POST);
});

test('updateProject is exposed as PATCH projects/:id', () => {
  const handler = RunnerProjectsController.prototype.updateProject;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'projects/:id');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.PATCH);
});

// An agent's project write is the runner owner's project, exactly as its task writes are — the
// credential names a machine, and the only tenant a machine can write into is the one that owns
// it. If this ever reads an id off the body instead, a runner becomes able to file work into
// somebody else's account.
test('createProject writes into the runner owner, with the body untouched', async () => {
  const seen: { ownerId?: string; dto?: CreateProjectDto } = {};
  const created = { id: 'project-1', title: 'Crawl' };
  const projects = {
    create: async (ownerId: string, dto: CreateProjectDto) => {
      seen.ownerId = ownerId;
      seen.dto = dto;
      return created;
    },
  } as never;
  const controller = new RunnerProjectsController(projects);
  const dto: CreateProjectDto = {
    title: 'Crawl',
    goal: 'Index the corpus',
    acceptanceCriteria: 'Every shard reported',
    instructions: 'Work shard by shard',
  };

  const result = await controller.createProject(RUNNER, dto);

  assert.equal(seen.ownerId, 'owner-1');
  // The same object, not a copy: a runner door that rebuilt the payload could drop a field the
  // canonical DTO grows later, and the two doors would quietly accept different projects.
  assert.equal(seen.dto, dto);
  assert.equal(result, created);
});

test('updateProject writes into the runner owner, with the id and body untouched', async () => {
  const seen: { ownerId?: string; projectId?: string; dto?: UpdateProjectDto } = {};
  const updated = { id: 'project-1', title: 'Crawl the archive' };
  const projects = {
    update: async (ownerId: string, projectId: string, dto: UpdateProjectDto) => {
      seen.ownerId = ownerId;
      seen.projectId = projectId;
      seen.dto = dto;
      return updated;
    },
  } as never;
  const controller = new RunnerProjectsController(projects);
  const dto: UpdateProjectDto = { title: 'Crawl the archive', status: ProjectStatus.DONE };

  const result = await controller.updateProject(RUNNER, 'project-1', dto);

  assert.deepEqual({ ownerId: seen.ownerId, projectId: seen.projectId }, {
    ownerId: 'owner-1',
    projectId: 'project-1',
  });
  assert.equal(seen.dto, dto);
  assert.equal(result, updated);
});

// A null is an instruction to clear, and it is the one value a "clean up the body" helper would
// throw away. Forwarding the object verbatim is what keeps `goal: null` meaning "there is no
// stated goal any more" rather than "leave the goal alone".
test('updateProject forwards an explicit null clear rather than dropping it', async () => {
  let seen: UpdateProjectDto | undefined;
  const projects = {
    update: async (_ownerId: string, _id: string, dto: UpdateProjectDto) => {
      seen = dto;
      return {};
    },
  } as never;
  const controller = new RunnerProjectsController(projects);

  await controller.updateProject(RUNNER, 'project-1', {
    goal: null,
    acceptanceCriteria: null,
    instructions: null,
  });

  assert.deepEqual(seen, { goal: null, acceptanceCriteria: null, instructions: null });
  assert.ok(seen && 'goal' in seen, 'the null clear was dropped on the way through');
});

// An update on somebody else's project is the service's 404 — the same `assertOwned` the user door
// goes through. The bridge must not turn that into a write against an unscoped id.
test("updating another owner's project stays a 404 from the service", async () => {
  const projects = {
    update: async () => {
      throw new Error('project not found');
    },
  } as never;
  const controller = new RunnerProjectsController(projects);

  await assert.rejects(
    () => controller.updateProject(RUNNER, 'someone-elses-project', { status: ProjectStatus.DONE }),
    /not found/,
  );
});

// The whole surface, named. Growing a list or a delete here is a decision, not a side effect of
// adding a route — and `getProject` staying a GET is what keeps the read working for the
// coordinators that already depend on it.
test('the runner project bridge exposes exactly create, read and update', () => {
  const handlers = Object.getOwnPropertyNames(RunnerProjectsController.prototype).filter(
    (name) => name !== 'constructor',
  );
  assert.deepEqual(handlers.slice().sort(), ['createProject', 'getProject', 'updateProject']);
  const verbs = Object.fromEntries(
    handlers.map((name) => [
      name,
      Reflect.getMetadata(METHOD_METADATA, (RunnerProjectsController.prototype as never)[name]),
    ]),
  );
  assert.deepEqual(verbs, {
    createProject: RequestMethod.POST,
    getProject: RequestMethod.GET,
    updateProject: RequestMethod.PATCH,
  });
});
