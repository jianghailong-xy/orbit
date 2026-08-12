import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RunnerAgentsController } from './runner-agents.controller';

// A runner whose calling session passes the shared orchestration authorizer, so every case below
// exercises the field whitelist rather than the gate.
const RUNNER = { id: 'r1', ownerId: 'o1' } as never;
const ORCHESTRATION_TOKEN = 'signed-session-credential';

/** Builds a controller whose AgentsService just captures the sanitized DTO, plus the
 *  control-plane push each write fires (see `published`). */
function makeController() {
  const seen: {
    listOwner?: string;
    create?: Record<string, unknown>;
    update?: Record<string, unknown>;
    published?: [string, string];
    authorizations: Array<[unknown, string | undefined, string | undefined]>;
  } = { authorizations: [] };
  const rawAgent = {
    id: 'a1',
    name: 'agent',
    description: 'safe description',
    // Derived, not stored — what this project last ran on (agents/agent-provider.ts).
    lastProvider: 'codex',
    model: 'gpt-safe',
    workDir: '/work/repo',
    runnerId: 'r1',
    enableWorktree: true,
    permissionMode: 'plan',
    defaultMergeTarget: 'main',
    runner: { id: 'r1', name: 'runner', displayName: 'Build host', tokenHash: 'runner-secret' },
    env: { API_KEY: 'agent-secret' },
    mcpConfig: { authorization: 'mcp-secret' },
    systemPrompt: 'private system prompt',
    appendSystemPrompt: 'private appended prompt',
    agentKey: 'private-agent-key',
    allowedTools: ['private-tool-policy'],
    disallowedTools: [],
  };
  const mergeDefined = (dto: Record<string, unknown>) => ({
    ...rawAgent,
    ...Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined)),
  });
  const agents = {
    list: async (ownerId: string) => {
      seen.listOwner = ownerId;
      return [rawAgent];
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
    publishAgentChanged: (sessionId: string, agentId: string) => {
      seen.published = [sessionId, agentId];
    },
  } as never;
  return { controller: new RunnerAgentsController(agents, orchestration, realtime), seen };
}

test('list forwards the session credential to the orchestration authorizer', async () => {
  const { controller, seen } = makeController();
  const result = await controller.listAgents(RUNNER, 's1', ORCHESTRATION_TOKEN);
  assert.deepEqual(result, [
    {
      id: 'a1',
      name: 'agent',
      description: 'safe description',
      lastProvider: 'codex',
      workDir: '/work/repo',
      runnerId: 'r1',
      enableWorktree: true,
      permissionMode: 'plan',
      defaultMergeTarget: 'main',
      runner: { id: 'r1', name: 'runner', displayName: 'Build host' },
    },
  ]);
  assertSensitiveAgentFieldsRedacted(result[0]);
  assert.equal(seen.listOwner, 'o1');
  assert.deepEqual(seen.authorizations, [[RUNNER, 's1', ORCHESTRATION_TOKEN]]);
});

test('create forwards the agent config fields an orchestrator may set', async () => {
  const { controller, seen } = makeController();
  const result = await controller.createAgent(RUNNER, 's1', ORCHESTRATION_TOKEN, {
    name: 'child',
    env: { FOO: 'bar' },
    systemPrompt: 'new private prompt',
    permissionMode: 'acceptEdits',
    defaultMergeTarget: 'develop',
  });
  assert.deepEqual(seen.create?.env, { FOO: 'bar' });
  assert.equal(seen.create?.permissionMode, 'acceptEdits');
  assert.equal(seen.create?.defaultMergeTarget, 'develop');
  // Unset fields stay undefined so Prisma leaves the column alone.
  assert.equal(seen.create?.workDir, undefined);
  // Bound to the calling runner by default.
  assert.equal(seen.create?.runnerId, 'r1');
  assert.equal(result.name, 'child');
  assertSensitiveAgentFieldsRedacted(result);
  assert.deepEqual(seen.authorizations, [[RUNNER, 's1', ORCHESTRATION_TOKEN]]);
});

test('update forwards them too', async () => {
  const { controller, seen } = makeController();
  const result = await controller.updateAgent(RUNNER, 's1', ORCHESTRATION_TOKEN, 'a1', {
    env: { A: '1' },
    appendSystemPrompt: 'updated private prompt',
    permissionMode: 'plan',
    defaultMergeTarget: 'main',
  });
  assert.deepEqual(seen.update?.env, { A: '1' });
  assert.equal(seen.update?.permissionMode, 'plan');
  assert.equal(seen.update?.defaultMergeTarget, 'main');
  // No runner rebind unless the caller asked for one.
  assert.equal(seen.update?.runnerId, undefined);
  // The agent list refresh is scoped to the CALLING session, and names the updated agent.
  assert.deepEqual(seen.published, ['s1', 'a1']);
  assertSensitiveAgentFieldsRedacted(result);
  assert.deepEqual(seen.authorizations, [[RUNNER, 's1', ORCHESTRATION_TOKEN]]);
});

test('enableOrchestration and enabled are still dropped (human-only, web UI)', async () => {
  const { controller, seen } = makeController();
  await controller.createAgent(RUNNER, 's1', ORCHESTRATION_TOKEN, {
    name: 'child',
    enableOrchestration: true,
    enabled: false,
  } as never);
  assert.equal('enableOrchestration' in (seen.create ?? {}), false);
  assert.equal('enabled' in (seen.create ?? {}), false);
});

test('rejects an unknown permissionMode', async () => {
  const { controller } = makeController();
  await assert.rejects(
    () =>
      controller.createAgent(RUNNER, 's1', ORCHESTRATION_TOKEN, {
        name: 'child',
        permissionMode: 'yolo',
      }),
    BadRequestException,
  );
});

test('rejects a non-string env value — the runner decodes env as map[string]string', async () => {
  const { controller } = makeController();
  await assert.rejects(
    () =>
      controller.createAgent(RUNNER, 's1', ORCHESTRATION_TOKEN, {
        name: 'child',
        env: { NESTED: { a: 1 } },
      }),
    BadRequestException,
  );
  await assert.rejects(
    () =>
      controller.createAgent(RUNNER, 's1', ORCHESTRATION_TOKEN, {
        name: 'child',
        env: ['FOO=bar'],
      }),
    BadRequestException,
  );
});

test('an omitted env leaves the stored map untouched', async () => {
  const { controller, seen } = makeController();
  await controller.updateAgent(RUNNER, 's1', ORCHESTRATION_TOKEN, 'a1', {
    name: 'renamed',
  });
  assert.equal(seen.update?.env, undefined);
});

test('rejects malformed bodies and typed fields before the AgentsService', async () => {
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
      () => controller.createAgent(RUNNER, 's1', ORCHESTRATION_TOKEN, body),
      BadRequestException,
    );
    assert.equal(seen.create, undefined);
  }
});

function assertSensitiveAgentFieldsRedacted(agent: Record<string, unknown>) {
  for (const field of [
    'env',
    'mcpConfig',
    'systemPrompt',
    'appendSystemPrompt',
    'agentKey',
    'allowedTools',
    'disallowedTools',
  ]) {
    assert.equal(field in agent, false, `${field} leaked in orchestration response`);
  }
  const runner = agent.runner as Record<string, unknown> | undefined;
  assert.equal(runner ? 'tokenHash' in runner : false, false, 'runner token hash leaked');
}
