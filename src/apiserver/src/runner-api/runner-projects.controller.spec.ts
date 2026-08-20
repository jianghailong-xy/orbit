import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException, RequestMethod } from '@nestjs/common';
import { ProjectStatus } from '@orbit/shared';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { PublicIdPipe } from '../common/public-id';
import { CreateProjectDto, UpdateProjectDto } from '../projects/dto';
import { RunnerProjectsController } from './runner-projects.controller';

const RUNNER = { id: 'runner-1', ownerId: 'owner-1' } as never;

/** The session the runner injects into an in-session call, already decoded by `publicIdHeaders`. */
const SESSION_ID = '00000000-0000-7000-8000-0000000000c1';

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

  const result = await controller.createProject(RUNNER, undefined, dto);

  assert.equal(seen.ownerId, 'owner-1');
  // The same object, not a copy: a runner door that rebuilt the payload could drop a field the
  // canonical DTO grows later, and the two doors would quietly accept different projects.
  assert.equal(seen.dto, dto);
  assert.equal(result, created);
});

/** A controller whose two create paths are told apart by which one was called. */
function createSpy() {
  const calls: Array<{ path: 'headless' | 'in-session'; args: unknown[] }> = [];
  const projects = {
    create: async (...args: unknown[]) => {
      calls.push({ path: 'headless', args });
      return { id: 'project-1' };
    },
    createInSession: async (...args: unknown[]) => {
      calls.push({ path: 'in-session', args });
      return { id: 'project-1' };
    },
  } as never;
  return { calls, controller: new RunnerProjectsController(projects) };
}

// The whole point of the header: a project an agent records while working on it should be
// coordinated from the conversation it was planned in, so opening its coordinator comes back to
// that conversation rather than starting another. The runner id travels with the owner id because
// the header is the caller's own claim about itself — see ProjectsService.coordinatorFromSession.
test('a project created from inside a session is created in that session’s context', async () => {
  const f = createSpy();
  const dto: CreateProjectDto = { title: 'Crawl', goal: 'Index the corpus' };

  await f.controller.createProject(RUNNER, SESSION_ID, dto);

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, 'in-session');
  assert.deepEqual(f.calls[0].args.slice(0, 3), ['owner-1', 'runner-1', SESSION_ID]);
  // Still the same object, exactly as the headless path forwards it: the session decides where the
  // coordinator will open and nothing about what the project IS.
  assert.equal(f.calls[0].args[3], dto);
});

// A cron/launchd bridge belongs to no session and has no workspace to inherit. It must reach the
// plain create — not a session lookup for `undefined`, and not one for the empty string a shell
// exports when ORBIT_SESSION_ID is unset.
for (const [label, header] of [
  ['absent', undefined],
  ['empty', ''],
  ['whitespace', '   '],
] as const) {
  test(`a headless create with an ${label} session header keeps the old behaviour`, async () => {
    const f = createSpy();

    await f.controller.createProject(RUNNER, header, { title: 'Nightly sweep' });

    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].path, 'headless');
    assert.deepEqual(f.calls[0].args.slice(0, 1), ['owner-1']);
  });
}

// The session is context, not content. A door that copied it into the body would be inventing a
// caller-controlled workspace field — which is the thing CreateProjectDto deliberately does not
// have, because a runner that could name any workspace could plant a coordinator in one.
test('the session never becomes part of the project body', async () => {
  const f = createSpy();
  const dto = { title: 'Crawl' } as CreateProjectDto;

  await f.controller.createProject(RUNNER, SESSION_ID, dto);

  assert.deepEqual(Object.keys(dto), ['title']);
  assert.equal('workspaceId' in dto, false);
  assert.equal('coordinatorWorkspaceId' in dto, false);
});

// `workspaceId` is not on CreateProjectDto, so the global ValidationPipe strips it — but a
// controller that read `dto.workspaceId` would still honour it on a direct call. This is the
// assertion that the workspace comes from the session and from nowhere else.
test('a workspaceId smuggled into the body is not what the project is created with', async () => {
  const f = createSpy();

  await f.controller.createProject(RUNNER, SESSION_ID, {
    title: 'Crawl',
    workspaceId: 'workspace-somebody-elses',
  } as never);

  assert.deepEqual(f.calls[0].args.slice(0, 3), ['owner-1', 'runner-1', SESSION_ID]);
});

// A session that is not this runner's, or has no workspace left, is refused by the service. The
// door must let that through rather than falling back to a project with no default — an
// unopenable project reported as success is exactly the outcome this path exists to prevent.
test('a session the service refuses is not quietly downgraded to a headless create', async () => {
  const calls: string[] = [];
  const projects = {
    create: async () => {
      calls.push('headless');
      return { id: 'project-1' };
    },
    createInSession: async () => {
      calls.push('in-session');
      throw new ForbiddenException('no workspace');
    },
  } as never;
  const controller = new RunnerProjectsController(projects);

  await assert.rejects(
    () => controller.createProject(RUNNER, SESSION_ID, { title: 'Crawl' }),
    (e: unknown) => e instanceof ForbiddenException,
  );
  assert.deepEqual(calls, ['in-session']);
});

// The exact header, spelled the way `publicIdHeaders` normalizes and the way every shipped runner
// sends it. A typo here is silent: the parameter is `undefined` on every request and every
// in-session create quietly becomes headless again.
test('createProject reads the session from x-orbit-session-id', () => {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, RunnerProjectsController, 'createProject') as
    | Record<string, { index: number; data?: unknown }>
    | undefined;
  const headers = Object.values(args ?? {}).filter((arg) => typeof arg.data === 'string' && arg.data.includes('-'));
  assert.deepEqual(
    headers.map((arg) => arg.data),
    ['x-orbit-session-id'],
  );
});

// Reading a project and revising one are not "where am I" questions: neither has a coordinator
// default to seed, so neither may grow a dependence on the caller's session.
for (const method of ['getProject', 'updateProject'] as const) {
  test(`${method} takes no session context`, () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, RunnerProjectsController, method) as
      | Record<string, { data?: unknown }>
      | undefined;
    for (const arg of Object.values(args ?? {})) {
      assert.notEqual(arg.data, 'x-orbit-session-id');
    }
  });
}

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
test('the runner project bridge exposes exactly create, read, verifications and update', () => {
  const handlers = Object.getOwnPropertyNames(RunnerProjectsController.prototype).filter(
    (name) => name !== 'constructor',
  );
  assert.deepEqual(handlers.slice().sort(),
    ['createProject', 'getProject', 'projectVerifications', 'updateProject']);
  const verbs = Object.fromEntries(
    handlers.map((name) => [
      name,
      Reflect.getMetadata(METHOD_METADATA, (RunnerProjectsController.prototype as never)[name]),
    ]),
  );
  assert.deepEqual(verbs, {
    createProject: RequestMethod.POST,
    getProject: RequestMethod.GET,
    projectVerifications: RequestMethod.GET,
    updateProject: RequestMethod.PATCH,
  });
});
