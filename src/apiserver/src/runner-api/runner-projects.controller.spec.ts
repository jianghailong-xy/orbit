import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException, RequestMethod } from '@nestjs/common';
import { ProjectStatus } from '@orbit/shared';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { PublicIdPipe } from '../common/public-id';
import { CreateProjectDto, UpdateProjectDto } from '../projects/dto';
import { RunnerProjectsController } from './runner-projects.controller';

/** The acceptance service this controller also takes. A double rather than a real one: every
 *  scenario in this file is about the project routes, and a scenario that reached acceptance would
 *  say so by failing here. */
function acceptanceDouble(): never {
  return {
    recordMergeEvidence: async () => assert.fail('this scenario does not record merge evidence'),
  } as never;
}

/**
 * The orchestration authorizer, which only the `workspaceId` path consults.
 *
 * It FAILS rather than passing when a scenario that should not need it reaches it: the gate is
 * the whole of what naming a workspace costs, and a test that silently authorized would be
 * asserting the routing while proving nothing about the authority.
 */
function orchestrationDouble(calls?: unknown[][]): never {
  return {
    assert: async (...args: unknown[]) => {
      if (!calls) assert.fail('this scenario does not name a workspace, so nothing to authorize');
      calls.push(args);
      return args[1] as string;
    },
  } as never;
}

/** An authorizer that refuses, the way it does for a session without the grant. */
function orchestrationRefuses(reason = 'orchestration is not enabled for this session'): never {
  return { assert: async () => { throw new ForbiddenException(reason); } } as never;
}


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
  const controller = new RunnerProjectsController(
    projects,
    acceptanceDouble(),
    {} as never,
    orchestrationDouble(),
  );

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
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never, {} as never);

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
for (const method of [
  'getProject',
  'updateProject',
  'removeProject',
] as const) {
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

test('removeProject is exposed as DELETE projects/:id', () => {
  const handler = RunnerProjectsController.prototype.removeProject;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'projects/:id');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.DELETE);
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
  const controller = new RunnerProjectsController(
    projects,
    acceptanceDouble(),
    {} as never,
    orchestrationDouble(),
  );
  const dto: CreateProjectDto = {
    title: 'Crawl',
    goal: 'Index the corpus',
    acceptanceCriteriaItems: [{
      text: 'Every shard reported',
      verificationMethod: 'Compare the shard manifest with durable completion receipts.',
    }],
    instructions: 'Work shard by shard',
  };

  const result = await controller.createProject(RUNNER, undefined, undefined, dto);

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
  return {
    calls,
    controller: new RunnerProjectsController(
      projects,
      acceptanceDouble(),
      {} as never,
      orchestrationDouble(),
    ),
  };
}

// The whole point of the header: a project an agent records while working on it should be
// coordinated from the conversation it was planned in, so opening its coordinator comes back to
// that conversation rather than starting another. The runner id travels with the owner id because
// the header is the caller's own claim about itself — see ProjectsService.coordinatorFromSession.
test('a project created from inside a session is created in that session’s context', async () => {
  const f = createSpy();
  const dto: CreateProjectDto = { title: 'Crawl', goal: 'Index the corpus' };

  await f.controller.createProject(RUNNER, SESSION_ID, undefined, dto);

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

    await f.controller.createProject(RUNNER, header, undefined, { title: 'Nightly sweep' });

    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].path, 'headless');
    assert.deepEqual(f.calls[0].args.slice(0, 1), ['owner-1']);
  });
}

// The session is context, not content. `workspaceId` is a field and the session is not, and the
// difference is what each one is: one is a choice the caller makes and pays an orchestration gate
// for, the other is a fact about where the request came from that only the server can establish.
// A door that copied the header into the body would blur them.
test('the session never becomes part of the project body', async () => {
  const f = createSpy();
  const dto = { title: 'Crawl' } as CreateProjectDto;

  await f.controller.createProject(RUNNER, SESSION_ID, undefined, dto);

  assert.deepEqual(Object.keys(dto), ['title']);
  assert.equal('workspaceId' in dto, false);
  assert.equal('coordinatorWorkspaceId' in dto, false);
});

// `workspaceId` used not to exist on CreateProjectDto, and this asserted that a body carrying one
// anyway could not decide where the coordinator went. The field exists now — see "Naming the
// workspace" below — and the half of that claim which survives is the half that matters: it is
// not a body field the door simply honours. Without the credential that proves the caller may
// name one, nothing is created at all, in any workspace.
test('a workspaceId is never honoured on the strength of being in the body', async () => {
  const f = workspaceSpy(orchestrationRefuses());

  await assert.rejects(
    () => f.controller.createProject(RUNNER, SESSION_ID, undefined, {
      title: 'Crawl',
      workspaceId: 'workspace-somebody-elses',
    }),
    (e: unknown) => e instanceof ForbiddenException,
  );

  assert.deepEqual(f.calls, [], 'not created here, and not quietly created in the session’s own');
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
  const controller = new RunnerProjectsController(
    projects,
    acceptanceDouble(),
    {} as never,
    orchestrationDouble(),
  );

  await assert.rejects(
    () => controller.createProject(RUNNER, SESSION_ID, undefined, { title: 'Crawl' }),
    (e: unknown) => e instanceof ForbiddenException,
  );
  assert.deepEqual(calls, ['in-session']);
});

// The exact header, spelled the way `publicIdHeaders` normalizes and the way every shipped runner
// sends it. A typo here is silent: the parameter is `undefined` on every request and every
// in-session create quietly becomes headless again.
test('createProject reads exactly two headers: which session, and the proof it is that session', () => {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, RunnerProjectsController, 'createProject') as
    | Record<string, { index: number; data?: unknown }>
    | undefined;
  const headers = Object.values(args ?? {}).filter((arg) => typeof arg.data === 'string' && arg.data.includes('-'));
  // The pair, and nothing else. The id says which conversation this request came from; the token
  // is what makes that claim worth anything when the body names a workspace, since a session id is
  // discoverable and this door would otherwise let any live runner place a coordinator anywhere.
  assert.deepEqual(
    headers.map((arg) => arg.data).sort(),
    ['x-orbit-session-id', 'x-orbit-session-token'],
  );
});

// Reading a project and deleting one are not "where am I" questions: neither has a coordinator
// default to seed, so neither may grow a dependence on the caller's session.
for (const method of ['getProject', 'removeProject'] as const) {
  test(`${method} takes no session context`, () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, RunnerProjectsController, method) as
      | Record<string, { data?: unknown }>
      | undefined;
    for (const arg of Object.values(args ?? {})) {
      assert.notEqual(arg.data, 'x-orbit-session-id');
    }
  });
}

// `updateProject` used to be in that list, and unit T6 took it out. The rule it was under is about
// SEEDING — a route that quietly derives a default from whichever session happened to call it —
// and that rule still holds here: nothing about the update is defaulted from the session. What the
// header buys is the opposite, an authorization boundary that has to know WHO is writing, since
// editing acceptance criteria is a person's rather than a judgment session's to do.
// Asserted rather than left implicit because a typo in the header name is
// silent: the parameter would be `undefined` on every request and the boundary would never bite.
// The two acceptance-run routes that stood beside it went with the judgment in 0229.
for (const method of ['updateProject'] as const) {
  test(`${method} reads the acting session from x-orbit-session-id`, () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, RunnerProjectsController, method) as
      | Record<string, { data?: unknown }>
      | undefined;
    const headers = Object.values(args ?? {})
      .map((arg) => arg.data)
      .filter((data) => typeof data === 'string' && data.includes('-'));
    assert.deepEqual(headers, ['x-orbit-session-id']);
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
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never, {} as never);
  const dto: UpdateProjectDto = { title: 'Crawl the archive', status: ProjectStatus.DONE };

  const result = await controller.updateProject(RUNNER, 'project-1', undefined, dto);

  assert.deepEqual({ ownerId: seen.ownerId, projectId: seen.projectId }, {
    ownerId: 'owner-1',
    projectId: 'project-1',
  });
  // The same object, not a copy: this door holds no DTO of its own, so a field the canonical DTO
  // grows later reaches the write without anybody remembering to forward it here.
  assert.equal(seen.dto, dto);
  assert.equal(result, updated);
});

// A null is an instruction to clear, and it is the one value a "clean up the body" helper would
// throw away. Forwarding the object verbatim is what keeps `goal: null` meaning "there is no
// stated goal any more" rather than "leave the goal alone".
test('updateProject forwards an explicit structured clear rather than dropping it', async () => {
  let seen: UpdateProjectDto | undefined;
  const projects = {
    update: async (_ownerId: string, _id: string, dto: UpdateProjectDto) => {
      seen = dto;
      return {};
    },
  } as never;
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never, {} as never);

  await controller.updateProject(RUNNER, 'project-1', undefined, {
    goal: null,
    instructions: null,
  });

  assert.deepEqual(seen, { goal: null, instructions: null });
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
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never, {} as never);

  await assert.rejects(
    () => controller.updateProject(RUNNER, 'someone-elses-project', undefined, { status: ProjectStatus.DONE }),
    /not found/,
  );
});

test('removeProject deletes through ProjectsService in the runner owner scope', async () => {
  const seen: { ownerId?: string; projectId?: string } = {};
  const expected = { ok: true };
  const projects = {
    remove: async (ownerId: string, projectId: string) => {
      seen.ownerId = ownerId;
      seen.projectId = projectId;
      return expected;
    },
  } as never;
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never, {} as never);

  const result = await controller.removeProject(RUNNER, 'project-1');

  assert.deepEqual(seen, { ownerId: 'owner-1', projectId: 'project-1' });
  assert.equal(result, expected);
});

test('removeProject preserves the service refusal for a non-empty project', async () => {
  const projects = {
    remove: async () => {
      throw new Error('This project still holds 2 task(s) and cannot be deleted');
    },
  } as never;
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never, {} as never);

  await assert.rejects(() => controller.removeProject(RUNNER, 'project-1'), /still holds 2 task/);
});

// The whole surface, named. Growing a list or another destructive verb here is a decision, not a
// side effect of adding a route — and `getProject` staying a GET is what keeps the read working for the
// coordinators that already depend on it.
//
// `projectCoordinatorStatus` joined it in unit 20 (contract AC10) and is a GET for the reason the
// other two reads are: it answers "why is this project not moving" and changes nothing. The write
// that unit added — the manual trigger — deliberately did NOT join it. Enqueuing a signal
// attributed to USER is how a person drives a MANUAL project, so an agent able to do it would be
// driving its own coordinator; that one stays on the door a person signs in to.
test('the runner project bridge exposes exactly create, the reads, update, and guarded delete', () => {
  const handlers = Object.getOwnPropertyNames(RunnerProjectsController.prototype).filter(
    (name) => name !== 'constructor',
  );
  assert.deepEqual(handlers.slice().sort(), [
    'createProject',
    'getProject',
    // Unit L7's one, and it is a GET on purpose. §7 RB2 puts the ANSWER to a cross-project
    // crossing with the user, so this door carries the question and not the write: an agent that
    // could sign a crossing for another goal is the incident this whole unit exists for wearing a
    // different hat. Migration 0229 took the reopen preview with the acceptance epoch it read, and
    // the three acceptance-judgment routes with the runs and conclusions they wrote.
    'listProjectHandoffs',
    'recordMergeEvidence',
    'removeProject',
    'updateProject',
  ]);
  const verbs = Object.fromEntries(
    handlers.map((name) => [
      name,
      Reflect.getMetadata(METHOD_METADATA, (RunnerProjectsController.prototype as never)[name]),
    ]),
  );
  assert.deepEqual(verbs, {
    createProject: RequestMethod.POST,
    getProject: RequestMethod.GET,
    // Unit L7: GET. The verb is the assertion — a POST appearing here would be a coordinator
    // answering a crossing on a person's behalf.
    listProjectHandoffs: RequestMethod.GET,
    recordMergeEvidence: RequestMethod.POST,
    removeProject: RequestMethod.DELETE,
    updateProject: RequestMethod.PATCH,
  });
});

// No trigger over the machine door, stated as its own assertion rather than left to the list
// above: the list is sorted and a reader skims it, and this is the one absence that is a security
// property rather than a scoping choice.
test('the manual trigger is not reachable with a runner credential', () => {
  assert.equal(
    Object.getOwnPropertyNames(RunnerProjectsController.prototype)
      .some((name) => /trigger/i.test(name)),
    false,
  );
});


// ── Naming the workspace ──────────────────────────────────────────────────────────────────────

/** A controller whose THREE create paths are told apart by which one was called. */
function workspaceSpy(orchestration: never) {
  const calls: Array<{ path: 'headless' | 'in-session' | 'in-workspace'; args: unknown[] }> = [];
  const projects = {
    create: async (...args: unknown[]) => {
      calls.push({ path: 'headless', args });
      return { id: 'project-1' };
    },
    createInSession: async (...args: unknown[]) => {
      calls.push({ path: 'in-session', args });
      return { id: 'project-1' };
    },
    createInWorkspace: async (...args: unknown[]) => {
      calls.push({ path: 'in-workspace', args });
      return { id: 'project-1' };
    },
  } as never;
  return {
    calls,
    controller: new RunnerProjectsController(projects, acceptanceDouble(), {} as never, orchestration),
  };
}

const WORKSPACE_ID = '00000000-0000-7000-8000-0000000000d1';

// The point of sending it: the acting session says WHO is asking, the field says WHERE, and a
// coordinator that must not be this conversation has to be able to be somewhere else.
test('a named workspace is authorized against the acting session, then coordinated there', async () => {
  const authorized: unknown[][] = [];
  const f = workspaceSpy(orchestrationDouble(authorized));
  const dto: CreateProjectDto = { title: 'Crawl', workspaceId: WORKSPACE_ID };

  await f.controller.createProject(RUNNER, SESSION_ID, 'orchestration-token', dto);

  // Authorized with the acting session and the credential that proves the caller IS it — a
  // discovered session id alone is what the token exists to be insufficient against.
  assert.deepEqual(authorized, [[RUNNER, SESSION_ID, 'orchestration-token']]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, 'in-workspace');
  assert.deepEqual(f.calls[0].args.slice(0, 3), ['owner-1', dto, WORKSPACE_ID]);
  assert.deepEqual(f.calls[0].args[3], { type: 'RUNNER', id: 'runner-1' });
});

// Without an acting session there is nothing to check the choice against, and a machine credential
// that could name any workspace could open a conversation in every workspace this account owns.
for (const [label, header] of [['absent', undefined], ['empty', '  ']] as const) {
  test(`a named workspace with an ${label} session header is refused, and creates nothing`, async () => {
    const f = workspaceSpy(orchestrationDouble());

    await assert.rejects(
      () => f.controller.createProject(RUNNER, header, undefined, {
        title: 'Crawl',
        workspaceId: WORKSPACE_ID,
      }),
      (e: unknown) => {
        assert.ok(e instanceof ForbiddenException, `expected a 403, got ${String(e)}`);
        // Named, because a caller told only "no" concludes there is no way to do this at all —
        // and there is: the owner's own door takes the same field without borrowing a session.
        assert.match(String((e as ForbiddenException).message), /X-Orbit-Session-Id|user API/);
        return true;
      },
    );

    // Not "refused after creating it somewhere else": the headless path would have accepted this
    // body and produced a project whose coordinator nobody chose.
    assert.deepEqual(f.calls, []);
  });
}

// The gate is checked BEFORE the write, not reported after it. A refusal that arrived with the
// project already created would be a project this session was not allowed to place.
test('a refused orchestration credential creates nothing at all', async () => {
  const f = workspaceSpy(orchestrationRefuses());

  await assert.rejects(
    () => f.controller.createProject(RUNNER, SESSION_ID, 'stale-token', {
      title: 'Crawl',
      workspaceId: WORKSPACE_ID,
    }),
    (e: unknown) => e instanceof ForbiddenException,
  );

  assert.deepEqual(f.calls, []);
});

// The old two paths are unchanged by the field's existence: a body without it never consults the
// authorizer at all, which is what `orchestrationDouble()` failing proves.
test('a create without a workspaceId still routes on the session header alone', async () => {
  const f = workspaceSpy(orchestrationDouble());

  await f.controller.createProject(RUNNER, SESSION_ID, 'orchestration-token', { title: 'Crawl' });
  await f.controller.createProject(RUNNER, undefined, undefined, { title: 'Nightly sweep' });

  assert.deepEqual(f.calls.map((call) => call.path), ['in-session', 'headless']);
});
