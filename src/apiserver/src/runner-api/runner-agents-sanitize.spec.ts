import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RunnerAgentsController } from './runner-agents.controller';

// A runner whose calling session passes the shared orchestration authorizer, so every case below
// exercises the field whitelist rather than the gate.
const RUNNER = { id: 'r1', ownerId: 'o1' } as never;
const orchestration = {
  assert: async (_runner: unknown, sessionId: string | undefined) => sessionId!,
} as never;

/** Builds a controller whose AgentsService just captures the sanitized DTO, plus the
 *  control-plane push each write fires (see `published`). */
function makeController() {
  const seen: {
    create?: Record<string, unknown>;
    update?: Record<string, unknown>;
    published?: [string, string];
  } = {};
  const agents = {
    create: async (_ownerId: string, dto: Record<string, unknown>) => (seen.create = dto),
    update: async (_ownerId: string, _id: string, dto: Record<string, unknown>) => (seen.update = dto),
  } as never;
  const realtime = {
    publishAgentChanged: (sessionId: string, agentId: string) => {
      seen.published = [sessionId, agentId];
    },
  } as never;
  return { controller: new RunnerAgentsController(agents, orchestration, realtime), seen };
}

test('create forwards the agent config fields an orchestrator may set', async () => {
  const { controller, seen } = makeController();
  await controller.createAgent(RUNNER, 's1', {
    name: 'child',
    env: { FOO: 'bar' },
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
});

test('update forwards them too', async () => {
  const { controller, seen } = makeController();
  await controller.updateAgent(RUNNER, 's1', 'a1', {
    env: { A: '1' },
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
});

test('enableOrchestration and enabled are still dropped (human-only, web UI)', async () => {
  const { controller, seen } = makeController();
  await controller.createAgent(RUNNER, 's1', {
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
    () => controller.createAgent(RUNNER, 's1', { name: 'child', permissionMode: 'yolo' }),
    BadRequestException,
  );
});

test('rejects a non-string env value — the runner decodes env as map[string]string', async () => {
  const { controller } = makeController();
  await assert.rejects(
    () => controller.createAgent(RUNNER, 's1', { name: 'child', env: { NESTED: { a: 1 } } }),
    BadRequestException,
  );
  await assert.rejects(
    () => controller.createAgent(RUNNER, 's1', { name: 'child', env: ['FOO=bar'] }),
    BadRequestException,
  );
});

test('an omitted env leaves the stored map untouched', async () => {
  const { controller, seen } = makeController();
  await controller.updateAgent(RUNNER, 's1', 'a1', { model: 'claude-opus-5' });
  assert.equal(seen.update?.env, undefined);
});
