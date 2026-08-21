import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArgumentMetadata, BadRequestException, Body, PipeTransform } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { uuidToBase62 } from '@orbit/shared';
import { RunnerAgentsController } from './runner-agents.controller';

// A runner whose calling session passes the shared orchestration authorizer, so every case below
// exercises the field whitelist rather than the gate.
const RUNNER = { id: 'r1', ownerId: 'o1' } as never;
const ORCHESTRATION_TOKEN = 'signed-session-credential';

// A *different* runner, named the way a caller actually holds it. This controller is agent-facing,
// so PublicIdInterceptor hands the CLI and `orbit mcp` the base62 spelling — and that is what they
// hand back when an orchestrator binds an agent to some other machine.
const OTHER_RUNNER_UUID = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const OTHER_RUNNER_B62 = uuidToBase62(OTHER_RUNNER_UUID);

// Nest keys `__routeArguments__` by `paramtype:index`; read the body's number off a probe rather
// than hardcode it, so a renumbering inside Nest fails here instead of silently piping nothing.
class BodyProbe {
  probe(@Body() _b: unknown) {}
}
const BODY = Number(
  Object.keys(Reflect.getMetadata(ROUTE_ARGS_METADATA, BodyProbe, 'probe') as object)[0].split(
    ':',
  )[0],
);

/** The body as the handler receives it: run through the pipes the route itself declares, which is
 *  the only place the decode lives. Calling the handler with a raw object — as every other test
 *  here does — skips them, so a test that wants the decode has to go through this. */
function asRouteReceivesIt(method: 'createWorkspace' | 'updateWorkspace', body: unknown): unknown {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, RunnerAgentsController, method) as Record<
    string,
    { pipes?: unknown[] }
  >;
  const entry = Object.entries(args).find(([key]) => Number(key.split(':')[0]) === BODY);
  assert.ok(entry, `${method} declares no @Body()`);
  const pipes = (entry[1].pipes ?? []) as PipeTransform[];
  assert.ok(pipes.length > 0, `${method}'s @Body() binds no pipe, so no id it carries is decoded`);
  return pipes.reduce(
    (value, pipe) => pipe.transform(value, { type: 'body' } as ArgumentMetadata),
    body,
  );
}

/** Builds a controller whose WorkspacesService just captures the sanitized DTO, plus the
 *  control-plane push each write fires (see `published`). */
function makeController() {
  const seen: {
    listOwner?: string;
    create?: Record<string, unknown>;
    update?: Record<string, unknown>;
    published?: [string, string];
    authorizations: Array<[unknown, string | undefined, string | undefined]>;
  } = { authorizations: [] };
  const rawWorkspace = {
    id: 'a1',
    name: 'workspace',
    description: 'safe description',
    // Derived, not stored — what this project last ran on (workspaces/workspace-provider.ts).
    lastProvider: 'codex',
    model: 'gpt-safe',
    workDir: '/work/repo',
    runnerId: 'r1',
    enableWorktree: true,
    permissionMode: 'plan',
    defaultMergeTarget: 'main',
    runner: { id: 'r1', name: 'runner', displayName: 'Build host', tokenHash: 'runner-secret' },
    env: { API_KEY: 'workspace-secret' },
    mcpConfig: { authorization: 'mcp-secret' },
    systemPrompt: 'private system prompt',
    appendSystemPrompt: 'private appended prompt',
    agentKey: 'private-workspace-key',
    allowedTools: ['private-tool-policy'],
    disallowedTools: [],
  };
  const mergeDefined = (dto: Record<string, unknown>) => ({
    ...rawWorkspace,
    ...Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined)),
  });
  const workspaces = {
    list: async (ownerId: string) => {
      seen.listOwner = ownerId;
      return [rawWorkspace];
    },
    create: async (_ownerId: string, dto: Record<string, unknown>) => {
      seen.create = dto;
      return mergeDefined(dto);
    },
    update: async (_ownerId: string, _id: string, dto: Record<string, unknown>) => {
      seen.update = dto;
      return mergeDefined(dto);
    },
  } as never;
  const orchestration = {
    assert: async (
      runner: unknown,
      sessionId: string | undefined,
      credential: string | undefined,
    ) => {
      seen.authorizations.push([runner, sessionId, credential]);
      return sessionId!;
    },
  } as never;
  const realtime = {
    publishWorkspaceChanged: (sessionId: string, workspaceId: string) => {
      seen.published = [sessionId, workspaceId];
    },
  } as never;
  return { controller: new RunnerAgentsController(workspaces, orchestration, realtime), seen };
}

test('list forwards the session credential to the orchestration authorizer', async () => {
  const { controller, seen } = makeController();
  const result = await controller.listWorkspaces(RUNNER, 's1', ORCHESTRATION_TOKEN);
  assert.deepEqual(result, [
    {
      id: 'a1',
      name: 'workspace',
      description: 'safe description',
      lastProvider: 'codex',
      workDir: '/work/repo',
      runnerId: 'r1',
      enableWorktree: true,
      defaultMergeTarget: 'main',
      runner: { id: 'r1', name: 'runner', displayName: 'Build host' },
    },
  ]);
  assertSensitiveWorkspaceFieldsRedacted(result[0]);
  assert.equal(seen.listOwner, 'o1');
  assert.deepEqual(seen.authorizations, [[RUNNER, 's1', ORCHESTRATION_TOKEN]]);
});

test('create forwards the workspace config fields an orchestrator may set', async () => {
  const { controller, seen } = makeController();
  const result = await controller.createWorkspace(RUNNER, 's1', ORCHESTRATION_TOKEN, {
    name: 'child',
    env: { FOO: 'bar' },
    systemPrompt: 'new private prompt',
    permissionMode: 'acceptEdits',
    defaultMergeTarget: 'develop',
  });
  assert.deepEqual(seen.create?.env, { FOO: 'bar' });
  assert.equal(seen.create?.defaultMergeTarget, 'develop');
  // Unset fields stay undefined so Prisma leaves the column alone.
  assert.equal(seen.create?.workDir, undefined);
  // Bound to the calling runner by default.
  assert.equal(seen.create?.runnerId, 'r1');
  assert.equal(result.name, 'child');
  assertSensitiveWorkspaceFieldsRedacted(result);
  assert.deepEqual(seen.authorizations, [[RUNNER, 's1', ORCHESTRATION_TOKEN]]);
});

test('update forwards them too', async () => {
  const { controller, seen } = makeController();
  const result = await controller.updateWorkspace(RUNNER, 's1', ORCHESTRATION_TOKEN, 'a1', {
    env: { A: '1' },
    appendSystemPrompt: 'updated private prompt',
    permissionMode: 'plan',
    defaultMergeTarget: 'main',
  });
  assert.deepEqual(seen.update?.env, { A: '1' });
  assert.equal(seen.update?.defaultMergeTarget, 'main');
  // No runner rebind unless the caller asked for one.
  assert.equal(seen.update?.runnerId, undefined);
  // The workspace list refresh is scoped to the CALLING session, and names the updated workspace.
  assert.deepEqual(seen.published, ['s1', 'a1']);
  assertSensitiveWorkspaceFieldsRedacted(result);
  assert.deepEqual(seen.authorizations, [[RUNNER, 's1', ORCHESTRATION_TOKEN]]);
});

test('enableOrchestration and enabled are still dropped (human-only, web UI)', async () => {
  const { controller, seen } = makeController();
  await controller.createWorkspace(RUNNER, 's1', ORCHESTRATION_TOKEN, {
    name: 'child',
    enableOrchestration: true,
    enabled: false,
  } as never);
  // Pinned off, not merely dropped: an absent field now means "seed from the account default",
  // so leaving it out would hand an orchestrator that ticked the box a second orchestrator.
  assert.equal(seen.create?.enableOrchestration, false);
  assert.equal('enabled' in (seen.create ?? {}), false);
});

test('authorization posture and provider fallback remain human-only', async () => {
  const { controller, seen } = makeController();
  await controller.createWorkspace(RUNNER, 's1', ORCHESTRATION_TOKEN, {
    name: 'child',
    providerFallbacks: [{ provider: 'codex' }],
    canCreateTasks: true,
    canDelegate: true,
    maxConcurrentTasks: 99,
  } as never);
  for (const field of [
    'providerFallbacks',
    'canCreateTasks',
    'canDelegate',
    'maxConcurrentTasks',
  ]) {
    assert.equal(field in (seen.create ?? {}), false, `${field} escaped the runner whitelist`);
  }
});

test('an orchestrator that names no value still cannot inherit the account default', async () => {
  const { controller, seen } = makeController();
  await controller.createWorkspace(RUNNER, 's1', ORCHESTRATION_TOKEN, { name: 'child' });
  assert.equal(seen.create?.enableOrchestration, false);
});

test('updating a workspace leaves its existing grant alone', async () => {
  const { controller, seen } = makeController();
  await controller.updateWorkspace(RUNNER, 's1', ORCHESTRATION_TOKEN, 'a1', {
    name: 'renamed',
    enableOrchestration: true,
  } as never);
  // Absent is the right answer here — Prisma leaves the column untouched, so an orchestrator can
  // neither grant the capability nor strip it from a workspace a human already decided about.
  assert.equal('enableOrchestration' in (seen.update ?? {}), false);
});

test('drops permissionMode — a workspace has no permission posture to set', async () => {
  const { controller, seen } = makeController();
  await controller.createWorkspace(RUNNER, 's1', ORCHESTRATION_TOKEN, {
    name: 'child',
    permissionMode: 'acceptEdits',
  });
  // Not rejected, just not forwarded: the mode lives on the session (and the account default),
  // so a value arriving here is stale client input, not an error worth failing the spawn over.
  assert.equal('permissionMode' in (seen.create ?? {}), false);
});

test('rejects a non-string env value — the runner decodes env as map[string]string', async () => {
  const { controller } = makeController();
  await assert.rejects(
    () =>
      controller.createWorkspace(RUNNER, 's1', ORCHESTRATION_TOKEN, {
        name: 'child',
        env: { NESTED: { a: 1 } },
      }),
    BadRequestException,
  );
  await assert.rejects(
    () =>
      controller.createWorkspace(RUNNER, 's1', ORCHESTRATION_TOKEN, {
        name: 'child',
        env: ['FOO=bar'],
      }),
    BadRequestException,
  );
});

test('an omitted env leaves the stored map untouched', async () => {
  const { controller, seen } = makeController();
  await controller.updateWorkspace(RUNNER, 's1', ORCHESTRATION_TOKEN, 'a1', {
    name: 'renamed',
  });
  assert.equal(seen.update?.env, undefined);
});

test('rejects malformed bodies and typed fields before the WorkspacesService', async () => {
  const invalidBodies: unknown[] = [
    null,
    [],
    { name: 7 },
    { provider: false },
    { enableWorktree: 'yes' },
    { defaultMergeTarget: 42 },
  ];
  for (const body of invalidBodies) {
    const { controller, seen } = makeController();
    await assert.rejects(
      () => controller.createWorkspace(RUNNER, 's1', ORCHESTRATION_TOKEN, body),
      BadRequestException,
    );
    assert.equal(seen.create, undefined);
  }
});

function assertSensitiveWorkspaceFieldsRedacted(workspace: Record<string, unknown>) {
  for (const field of [
    'env',
    'mcpConfig',
    'systemPrompt',
    'appendSystemPrompt',
    'agentKey',
    'allowedTools',
    'disallowedTools',
  ]) {
    assert.equal(field in workspace, false, `${field} leaked in orchestration response`);
  }
  const runner = workspace.runner as Record<string, unknown> | undefined;
  assert.equal(runner ? 'tokenHash' in runner : false, false, 'runner token hash leaked');
}

// The regression. `orbit agent create --runner-id 349tsNoHC7biW3WXF1ddp` (and the identical MCP
// call) is how you bind a new agent to a machine that isn't the one you're running on. The id is
// the base62 one this same API returned; unconverted it reached `prisma.runner.findFirst` inside
// WorkspacesService.assertOwnedRunner as a P2023 `Inconsistent column data` — a bare 500 with
// nothing for the caller to act on, and no raw-UUID spelling they could have used instead.
test('create binds to a runner named in base62', async () => {
  const { controller, seen } = makeController();
  await controller.createWorkspace(
    RUNNER,
    's1',
    ORCHESTRATION_TOKEN,
    asRouteReceivesIt('createWorkspace', { name: 'ux', runnerId: OTHER_RUNNER_B62 }),
  );
  assert.equal(seen.create?.runnerId, OTHER_RUNNER_UUID);
});

test('create still accepts the raw UUID spelling', async () => {
  const { controller, seen } = makeController();
  await controller.createWorkspace(
    RUNNER,
    's1',
    ORCHESTRATION_TOKEN,
    asRouteReceivesIt('createWorkspace', { name: 'ux', runnerId: OTHER_RUNNER_UUID }),
  );
  assert.equal(seen.create?.runnerId, OTHER_RUNNER_UUID);
});

test('create with no runnerId still defaults to the calling runner', async () => {
  const { controller, seen } = makeController();
  await controller.createWorkspace(
    RUNNER,
    's1',
    ORCHESTRATION_TOKEN,
    asRouteReceivesIt('createWorkspace', { name: 'ux' }),
  );
  assert.equal(seen.create?.runnerId, 'r1');
});

test('update rebinds to a runner named in base62', async () => {
  const { controller, seen } = makeController();
  await controller.updateWorkspace(
    RUNNER,
    's1',
    ORCHESTRATION_TOKEN,
    'a1',
    asRouteReceivesIt('updateWorkspace', { runnerId: OTHER_RUNNER_B62 }),
  );
  assert.equal(seen.update?.runnerId, OTHER_RUNNER_UUID);
});

// An id that is neither spelling is the caller's mistake, and it has to be named as one: this is
// the other half of "no Prisma 500 on this path". A runner that decodes but isn't this owner's
// stays WorkspacesService.assertOwnedRunner's 403 — also a 4xx, and deliberately not a 404, so
// the answer doesn't reveal whether another tenant's runner exists.
test('an id in neither spelling is a 400 that names the field', () => {
  for (const method of ['createWorkspace', 'updateWorkspace'] as const) {
    assert.throws(
      () => asRouteReceivesIt(method, { name: 'ux', runnerId: 'not a runner id' }),
      { message: 'invalid runnerId' },
      method,
    );
  }
});

// The second half of that, and the one the pipe cannot reach: a runnerId that is present but
// BLANK. `PublicIdPipe` only decodes values that pass its trim test, so `""` and `"   "` are
// skipped and arrive at the controller verbatim — and there they became two different bugs.
// On create the blank went into `workspace.create`'s `@db.Uuid` column as a bare P2023 500
// (`"   "` didn't even get that far: `assertOwnedRunner` queried `runner.findFirst` with it).
// On PATCH `""` is falsy, so WorkspacesService.update read it as `{ disconnect: true }` and
// answered 200 having quietly unbound the runner the caller was trying to name.
const BLANK_SPELLINGS = { 'empty string': '', spaces: '   ', 'tab and newline': '\t\n' };

test('a blank runnerId is a 400 on both routes, not a 500 and not an unbind', async () => {
  for (const [label, runnerId] of Object.entries(BLANK_SPELLINGS)) {
    const create = makeController();
    await assert.rejects(
      () =>
        create.controller.createWorkspace(
          RUNNER,
          's1',
          ORCHESTRATION_TOKEN,
          asRouteReceivesIt('createWorkspace', { name: 'ux', runnerId }),
        ),
      { message: 'invalid runnerId' },
      `create ${label}`,
    );
    // The point of the check is WHERE it fires: nothing reached the service, so no uuid column
    // and no `runner.findFirst` ever saw the blank.
    assert.equal(create.seen.create, undefined, `create ${label} reached WorkspacesService`);

    const update = makeController();
    await assert.rejects(
      () =>
        update.controller.updateWorkspace(
          RUNNER,
          's1',
          ORCHESTRATION_TOKEN,
          'a1',
          asRouteReceivesIt('updateWorkspace', { runnerId }),
        ),
      { message: 'invalid runnerId' },
      `update ${label}`,
    );
    assert.equal(update.seen.update, undefined, `update ${label} reached WorkspacesService`);
    assert.equal(update.seen.published, undefined, `update ${label} published a phantom change`);
  }
});

// Not a blank, and deliberately kept apart from one: `null` is already refused by the body's own
// type check, and that is this route's whole contract for it — there is no in-band way to unbind
// a runner here, which is exactly why `""` must not become one by accident.
test('an explicit null runnerId stays the typed 400 it already was', async () => {
  for (const [label, call] of [
    [
      'create',
      (c: RunnerAgentsController) =>
        c.createWorkspace(
          RUNNER,
          's1',
          ORCHESTRATION_TOKEN,
          asRouteReceivesIt('createWorkspace', { name: 'ux', runnerId: null }),
        ),
    ],
    [
      'update',
      (c: RunnerAgentsController) =>
        c.updateWorkspace(
          RUNNER,
          's1',
          ORCHESTRATION_TOKEN,
          'a1',
          asRouteReceivesIt('updateWorkspace', { runnerId: null }),
        ),
    ],
  ] as const) {
    const { controller, seen } = makeController();
    await assert.rejects(() => call(controller), { message: 'runnerId must be a string' }, label);
    assert.equal(seen.create ?? seen.update, undefined, `${label} reached WorkspacesService`);
  }
});

// Whatever a blank does, the spellings that work have to go on working — and identically on both
// routes, since "create and update agree" is the property the blank case broke.
test('the spellings that bind a runner are unchanged, and agree across create and update', async () => {
  for (const [label, runnerId, expected] of [
    ['base62', OTHER_RUNNER_B62, OTHER_RUNNER_UUID],
    ['raw uuid', OTHER_RUNNER_UUID, OTHER_RUNNER_UUID],
  ] as const) {
    const create = makeController();
    await create.controller.createWorkspace(
      RUNNER,
      's1',
      ORCHESTRATION_TOKEN,
      asRouteReceivesIt('createWorkspace', { name: 'ux', runnerId }),
    );
    assert.equal(create.seen.create?.runnerId, expected, `create ${label}`);

    const update = makeController();
    await update.controller.updateWorkspace(
      RUNNER,
      's1',
      ORCHESTRATION_TOKEN,
      'a1',
      asRouteReceivesIt('updateWorkspace', { runnerId }),
    );
    assert.equal(update.seen.update?.runnerId, expected, `update ${label}`);
  }
  // And an omitted field still means what it meant: bind the caller's own runner on create,
  // touch nothing on update.
  const create = makeController();
  await create.controller.createWorkspace(
    RUNNER,
    's1',
    ORCHESTRATION_TOKEN,
    asRouteReceivesIt('createWorkspace', { name: 'ux' }),
  );
  assert.equal(create.seen.create?.runnerId, 'r1');
  const update = makeController();
  await update.controller.updateWorkspace(
    RUNNER,
    's1',
    ORCHESTRATION_TOKEN,
    'a1',
    asRouteReceivesIt('updateWorkspace', { name: 'renamed' }),
  );
  assert.equal(update.seen.update?.runnerId, undefined);
});
