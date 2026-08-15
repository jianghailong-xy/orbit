import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RunnerAgentsController } from './runner-agents.controller';

// A runner whose calling session passes the shared orchestration authorizer, so every case below
// exercises the field whitelist rather than the gate.
const RUNNER = { id: 'r1', ownerId: 'o1' } as never;
const ORCHESTRATION_TOKEN = 'signed-session-credential';

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
