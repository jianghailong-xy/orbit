import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { CreateProjectDto } from './dto';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * "Coordinated in W" as one decision, through the two doors that take it.
 *
 * The field cannot mean anything narrower than "open the coordinator there". A landing recorded on
 * its own — `coordinator_workspace_id` set beside a null session pointer — is the shape
 * `coordinatorStatus` folds to `TRASHED`, so a project that never had a coordinator would be told
 * one of its conversations had been deleted and offered a replacement it never had.
 * `rebindCoordinator` refuses to write that pair for exactly this reason, and a create that wrote
 * it would reintroduce the same state through a door that refusal does not cover.
 *
 * So what is asserted here is the COMPOSITION: which calls, in which order, with what, and what
 * survives a failure of the second one. The three collaborators are stubbed on the instance
 * because each has its own spec — `create` over a Prisma double, `coordinator` over the lock
 * ordering and its compare-and-swap, `get` over the payload fold — and re-modelling them here
 * would test those instead of this.
 */
const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const WORKSPACE_ID = '00000000-0000-7000-8000-0000000000d1';
const PROJECT_ID = '00000000-0000-7000-8000-0000000000e1';

interface Trace {
  step: 'create' | 'coordinator' | 'get';
  args: unknown[];
}

function service(opts: { openFails?: Error } = {}): { service: ProjectsService; trace: Trace[] } {
  const trace: Trace[] = [];
  const instance = new ProjectsService({} as never, {} as never, {} as never);
  const stubs = instance as unknown as Record<string, unknown>;
  stubs.create = async (...args: unknown[]) => {
    trace.push({ step: 'create', args });
    return { id: PROJECT_ID, title: 'Crawl', coordinatorSessionId: null, coordinatorWorkspaceId: null };
  };
  stubs.coordinator = async (...args: unknown[]) => {
    trace.push({ step: 'coordinator', args });
    if (opts.openFails) throw opts.openFails;
    return { sessionId: 'session-1', created: true, workspaceId: WORKSPACE_ID };
  };
  stubs.get = async (...args: unknown[]) => {
    trace.push({ step: 'get', args });
    return { id: PROJECT_ID, title: 'Crawl', coordinatorSessionId: 'session-1', coordinatorWorkspaceId: WORKSPACE_ID };
  };
  return { service: instance, trace };
}

test('naming a workspace creates the project unbound and then opens its coordinator there', async () => {
  const f = service();
  const dto: CreateProjectDto = { title: 'Crawl' };

  const result = await f.service.createInWorkspace(OWNER_ID, dto, WORKSPACE_ID, {
    type: 'OWNER',
    id: OWNER_ID,
  });

  assert.deepEqual(f.trace.map((entry) => entry.step), ['create', 'coordinator', 'get']);
  // Created with NO seed: the seed binds an EXISTING session as the coordinator, and there is none
  // here. The conversation this project is coordinated from is the one the next call opens.
  assert.equal(f.trace[0].args[2], undefined);
  assert.deepEqual(f.trace[0].args[3], { type: 'OWNER', id: OWNER_ID });
  // ...and the workspace reaches `coordinator`, which is what writes BOTH columns in one statement.
  assert.deepEqual(f.trace[1].args, [OWNER_ID, PROJECT_ID, WORKSPACE_ID]);
  // The response is re-read rather than folded from what was sent. Binding a coordinator also
  // seats the project's COORDINATOR membership, so a payload built from the create's own return
  // would report a project with a coordinator and no coordinator agent.
  assert.deepEqual(f.trace[2].args, [OWNER_ID, PROJECT_ID]);
  assert.equal(result.coordinatorSessionId, 'session-1');
  assert.equal(result.coordinatorWorkspaceId, WORKSPACE_ID);
});

// The order is the failure design. The other order — session first, project second — leaves a live
// conversation in a workspace that no project points at, which is the leak `coordinator` keeps a
// discard path to avoid. This order leaves an ordinary coordinator-less project: visible, and
// openable from the card's own workspace picker.
test('a coordinator that fails to open leaves the project, and the failure is not swallowed', async () => {
  const boom = new Error('the coordinator workspace changed while its conversation was being opened');
  const f = service({ openFails: boom });

  await assert.rejects(
    () => f.service.createInWorkspace(OWNER_ID, { title: 'Crawl' }, WORKSPACE_ID),
    (e: unknown) => e === boom,
  );

  // The project was created before the attempt, and nothing here deletes it: reporting the failure
  // is the caller's answer, and the project it names is the one they can still open by hand.
  assert.deepEqual(f.trace.map((entry) => entry.step), ['create', 'coordinator']);
});

// The owner's own door needs no session and no orchestration credential: the workspace is theirs,
// and this is the same choice `POST :id/coordinator` has always accepted from them.
test('the user door routes a body with a workspaceId to createInWorkspace, and one without to create', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const projects = {
    create: async (...args: unknown[]) => { calls.push({ method: 'create', args }); return { id: PROJECT_ID }; },
    createInWorkspace: async (...args: unknown[]) => {
      calls.push({ method: 'createInWorkspace', args });
      return { id: PROJECT_ID };
    },
  } as never;
  const controller = new ProjectsController(
    projects,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const user = { userId: OWNER_ID } as never;

  await controller.create(user, { title: 'Crawl', workspaceId: WORKSPACE_ID });
  await controller.create(user, { title: 'Nightly sweep' });

  assert.deepEqual(calls.map((call) => call.method), ['createInWorkspace', 'create']);
  assert.deepEqual(calls[0].args.slice(0, 1), [OWNER_ID]);
  assert.equal(calls[0].args[2], WORKSPACE_ID);
  assert.deepEqual(calls[0].args[3], { type: 'OWNER', id: OWNER_ID });
  // Unchanged: the old shape is still four arguments with no seed, so a body without the field
  // reaches exactly the create it always did.
  assert.equal(calls[1].args[2], undefined);
  assert.deepEqual(calls[1].args[3], { type: 'OWNER', id: OWNER_ID });
});

test('the user door create is still POST /projects', () => {
  const handler = ProjectsController.prototype.create;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), '/');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.POST);
});
