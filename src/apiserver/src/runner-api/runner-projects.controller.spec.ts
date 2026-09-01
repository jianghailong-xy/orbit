import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException, RequestMethod } from '@nestjs/common';
import { ProjectStatus } from '@orbit/shared';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { PublicIdPipe } from '../common/public-id';
import { CreateProjectDto, OpenAcceptanceRunDto, UpdateProjectDto } from '../projects/dto';
import { RunnerProjectsController } from './runner-projects.controller';

/** The acceptance service this controller also takes. A double rather than a real one: every
 *  scenario in this file is about the project routes, and a scenario that reached acceptance would
 *  say so by failing here. */
function acceptanceDouble(): never {
  return {
    overview: async () => assert.fail('this scenario does not read acceptance'),
    openRun: async () => assert.fail('this scenario does not open an acceptance run'),
    finalizeRun: async () => assert.fail('this scenario does not conclude an acceptance run'),
    recordMergeEvidence: async () => assert.fail('this scenario does not record merge evidence'),
    proposeCriteriaChange: async () => assert.fail('this scenario does not propose criteria'),
    machineCriteriaProposal: async () => assert.fail('this scenario does not read a proposal'),
  } as never;
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
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never);

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
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never);

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
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never);
  const dto: CreateProjectDto = {
    title: 'Crawl',
    goal: 'Index the corpus',
    acceptanceCriteriaItems: [{
      text: 'Every shard reported',
      verificationMethod: 'Compare the shard manifest with durable completion receipts.',
      completionCriterion: 'VERIFICATION',
      evidenceTaskId: 'verifier-1',
    }],
    instructions: 'Work shard by shard',
  };

  const result = await controller.createProject(RUNNER, undefined, dto);

  assert.equal(seen.ownerId, 'owner-1');
  // The same object, not a copy: a runner door that rebuilt the payload could drop a field the
  // canonical DTO grows later, and the two doors would quietly accept different projects.
  assert.equal(seen.dto, dto);
  assert.equal(result, created);
});

test('createProject refuses legacy acceptanceCriteria before either runner create path', async () => {
  const projects = {
    create: async () => assert.fail('legacy criteria must not reach the headless write'),
    createInSession: async () => assert.fail('legacy criteria must not reach the session write'),
  } as never;
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never);

  for (const sessionId of [undefined, SESSION_ID]) {
    assert.throws(
      () => controller.createProject(RUNNER, sessionId, {
        title: 'Crawl',
        acceptanceCriteria: 'Every shard reported',
      }),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        const message = error.message;
        assert.match(message, /acceptanceCriteriaItems/);
        assert.match(message, /completionCriterion/);
        assert.match(message, /HUMAN_SIGNOFF/);
        return true;
      },
    );
  }
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
  return { calls, controller: new RunnerProjectsController(projects, acceptanceDouble(), {} as never) };
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
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never);

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
// header buys is the opposite, an authorization boundary that has to know WHO is writing, since a
// proposal about acceptance criteria is a person's rather than a judgment session's to author.
// Asserted rather than left implicit because a typo in the header name is
// silent: the parameter would be `undefined` on every request and the boundary would never bite.
for (const method of [
  'updateProject',
  'proposeCriteriaChange',
  'openAcceptanceRun',
  'finalizeAcceptanceRun',
] as const) {
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

test('openAcceptanceRun attributes the run to the calling judgment session, not the body', async () => {
  const seen: {
    ownerId?: string;
    projectId?: string;
    input?: OpenAcceptanceRunDto & { decidedBy: string };
  } = {};
  const acceptance = {
    openRun: async (
      ownerId: string,
      projectId: string,
      input: OpenAcceptanceRunDto & { decidedBy: string },
    ) => {
      Object.assign(seen, { ownerId, projectId, input });
      return { id: 'run-1' };
    },
  } as never;
  const controller = new RunnerProjectsController({} as never, acceptance, {} as never);
  const body = {
    decidedBy: 'USER',
    coordinatorSessionId: '00000000-0000-7000-8000-0000000000ff',
  } as OpenAcceptanceRunDto;

  await controller.openAcceptanceRun(RUNNER, 'project-1', SESSION_ID, body);

  assert.equal(seen.ownerId, 'owner-1');
  assert.equal(seen.projectId, 'project-1');
  assert.equal(seen.input?.decidedBy, 'COORDINATOR_AGENT');
  assert.equal(seen.input?.coordinatorSessionId, SESSION_ID);
});

test('finalizeAcceptanceRun identifies a headless runner as a machine principal', async () => {
  let received: unknown[] = [];
  const criteria = [{ ordinal: 1, verdict: 'FAIL' }];
  const acceptance = {
    finalizeRun: async (...args: unknown[]) => {
      received = args;
      return { verdict: 'FAIL' };
    },
  } as never;
  const controller = new RunnerProjectsController({} as never, acceptance, {} as never);

  await controller.finalizeAcceptanceRun(
    RUNNER,
    'project-1',
    'run-1',
    undefined,
    { criteria } as never,
  );

  assert.deepEqual(received, [
    'owner-1',
    'project-1',
    'run-1',
    criteria,
    undefined,
    'runner-1',
  ]);
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
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never);
  const dto: UpdateProjectDto = { title: 'Crawl the archive', status: ProjectStatus.DONE };

  const result = await controller.updateProject(RUNNER, 'project-1', undefined, dto);

  assert.deepEqual({ ownerId: seen.ownerId, projectId: seen.projectId }, {
    ownerId: 'owner-1',
    projectId: 'project-1',
  });
  // Field-for-field rather than the same object: acceptance criteria now leave this body at the
  // door and become a proposal, so the rest is forwarded as a rest-spread copy. A field the
  // canonical DTO grows later still rides along — `{ acceptanceCriteriaItems, ...rest }` names
  // only the one property it removes — which is what the identity check used to protect.
  assert.deepEqual(seen.dto, dto);
  assert.deepEqual(Object.keys(seen.dto ?? {}).sort(), Object.keys(dto).sort());
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
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never);

  await controller.updateProject(RUNNER, 'project-1', undefined, {
    goal: null,
    instructions: null,
  });

  assert.deepEqual(seen, { goal: null, instructions: null });
  assert.ok(seen && 'goal' in seen, 'the null clear was dropped on the way through');
});

// The one clear this door no longer performs. Emptying the set is not a proposal an owner could
// ever sensibly approve — a project measured by nothing has no standard — so it is refused with a
// sentence that says what to send instead, rather than parked on the project's one pending slot.
test('updateProject refuses an empty structured criteria set instead of proposing nothing', async () => {
  const projects = {
    update: async () => assert.fail('an empty criteria set must not reach the project write'),
  } as never;
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never);

  await assert.rejects(
    () => controller.updateProject(RUNNER, 'project-1', undefined, { acceptanceCriteriaItems: [] }),
    (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.match(error.message, /no longer a way to clear/);
      assert.match(error.message, /at least one criterion/);
      return true;
    },
  );
});

test('updateProject refuses legacy acceptanceCriteria replacement and clear before the write', async () => {
  const projects = {
    update: async () => assert.fail('legacy criteria must not reach the runner update'),
  } as never;
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never);

  for (const acceptanceCriteria of ['Every shard reported', null] as const) {
    await assert.rejects(
      () => controller.updateProject(RUNNER, 'project-1', undefined, { acceptanceCriteria }),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        assert.match(error.message, /acceptanceCriteriaItems/);
        assert.match(error.message, /completionCriterion/);
        assert.match(error.message, acceptanceCriteria === null ? /send \[\] to clear/i : /HUMAN_SIGNOFF/);
        return true;
      },
    );
  }
});

// An update on somebody else's project is the service's 404 — the same `assertOwned` the user door
// goes through. The bridge must not turn that into a write against an unscoped id.
test("updating another owner's project stays a 404 from the service", async () => {
  const projects = {
    update: async () => {
      throw new Error('project not found');
    },
  } as never;
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never);

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
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never);

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
  const controller = new RunnerProjectsController(projects, acceptanceDouble(), {} as never);

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
    // The proposal channel: an agent may say what it thinks the acceptance criteria should be
    // (`proposeCriteriaChange`) and read what the owner was asked (`criteriaProposal`). Both are
    // deliberately here while the DECISION is not — a machine that could answer its own proposal
    // would be moving the standard it is measured against, which is the whole line this holds.
    'criteriaProposal',
    // §13.4's acceptance, through the machine door: a coordinator runs the acceptance, so the
    // three writes are here. Listing, opening a coordinator and the manual trigger are still
    // absent, which is the line this test exists to hold.
    'finalizeAcceptanceRun',
    'getProject',
    // Unit L7's two, and both are GETs on purpose. §7 RB2 puts the ANSWER to a cross-project
    // crossing with the user and §7 puts a settled project's reopen with the user too, so this
    // door carries the question and what the reopen would cost, and neither of the two writes:
    // an agent that could sign a crossing for another goal, or reopen a project it wanted to
    // write into, is the incident this whole unit exists for wearing a different hat.
    'getProjectReopenImpact',
    'listProjectHandoffs',
    'openAcceptanceRun',
    'projectAcceptance',
    // Failure Continuation's canonical agent-queue view is also read-only. It gives a runner
    // the same obligation revision/binding/reason tuple that owner-facing clients receive.
    'projectFailureCoordination',
    // Read-only canonical projection. The actor is fixed to AGENT by the controller, so this
    // reveals the standing obligation/CTA without turning the runner into its owner.
    'projectOutcome',
    // See `criteriaProposal` above: proposing is not deciding.
    'proposeCriteriaChange',
    'recordMergeEvidence',
    'removeProject',
    // A machine may file the exact owner-only question its current authenticated delivery calls
    // for; PostgreSQL binds runner + Session + delivery revision. It cannot answer that question.
    'requestCompletionAckOwnerDecision',
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
    // The proposal channel's two verbs are the assertion: a machine POSTs what it PROPOSES and
    // GETs what the owner was asked. There is no verb here that decides one.
    criteriaProposal: RequestMethod.GET,
    finalizeAcceptanceRun: RequestMethod.POST,
    getProject: RequestMethod.GET,
    // Unit L7: GET, both of them. The verbs are the assertion — a POST appearing on either would
    // be a coordinator answering a crossing or reopening a settled project on a person's behalf.
    getProjectReopenImpact: RequestMethod.GET,
    listProjectHandoffs: RequestMethod.GET,
    openAcceptanceRun: RequestMethod.POST,
    projectAcceptance: RequestMethod.GET,
    projectFailureCoordination: RequestMethod.GET,
    projectOutcome: RequestMethod.GET,
    proposeCriteriaChange: RequestMethod.POST,
    recordMergeEvidence: RequestMethod.POST,
    removeProject: RequestMethod.DELETE,
    requestCompletionAckOwnerDecision: RequestMethod.POST,
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
