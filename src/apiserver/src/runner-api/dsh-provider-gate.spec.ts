import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, SESSION_SOURCE_PIN_V1 } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';
import {
  DSH_RUNNER_UPGRADE_ERROR,
  advertisedRunnerProviders,
  withProviderDeclarations,
} from './runner-provider-support';

const runner = { id: '11111111-1111-4111-8111-111111111111', ownerId: '22222222-2222-4222-8222-222222222222' };
const header = 'claude,codex,kimi,opencode,antigravity,dsh';
function controller(prisma: unknown, queue: unknown) {
  return new RunnerApiController(prisma as never, queue as never,
    { publishSessionCreated() {}, notifyInbox() {} } as never, {} as never, {} as never, {} as never,
    { appendFor: async (_tx: unknown, _id: unknown, text: string) => text } as never);
}
function row(id: string, provider: string, providerBuiltin = true) {
  return {
    id, provider, providerBuiltin, ownerId: runner.ownerId, status: 'AWAITING_INPUT',
    model: 'pinned-model', usesRuntimeDefaultModel: true, runtimeSessionId: `runtime-${id}`,
    workspace: null, assignedRunner: null, cancelRequestedAt: null, error: null,
    inboxLeaseOwner: null, sourceState: 'UNBOUND', allowedTools: [], disallowedTools: [],
  };
}

test('P1b dsh claim requires request and persisted heartbeat declarations', async () => {
  for (const [request, snapshot, expected] of [
    [header, { capabilities: ['provider:dsh'], capabilitiesReportedAt: new Date() }, true],
    [undefined, { capabilities: ['provider:dsh'], capabilitiesReportedAt: new Date() }, false],
    [header, { capabilities: [], capabilitiesReportedAt: new Date() }, false],
    [header, { capabilities: ['provider:dsh'], capabilitiesReportedAt: null }, false],
    [header, null, false],
  ] as const) {
    let providers: readonly AgentProvider[] = [];
    const prisma = {
      runner: { findUnique: async () => snapshot },
      session: { findMany: async () => [] }, modelProvider: { findMany: async () => [] },
    };
    const queue = { claimSessionForRunner: async (value: { supportedProviders: AgentProvider[] }) => {
      providers = value.supportedProviders;
      return null;
    } };
    await controller(prisma, queue).claim(runner, SESSION_SOURCE_PIN_V1, request);
    assert.equal(providers.includes(AgentProvider.DSH), expected);
    if (request) assert.equal(providers.includes(AgentProvider.CLAUDE), true);
  }
});

test('P1b dsh reclaim withholds unsupported Harness while retaining legacy checkouts', async () => {
  for (const request of [undefined, 'claude,codex,opencode,antigravity', header]) {
    const prisma = {
      runner: { findUnique: async () => ({ capabilities: [], capabilitiesReportedAt: new Date() }) },
      session: { findMany: async () => [row('dsh', 'dsh'), row('claude', 'claude')] },
      modelProvider: { findMany: async () => [] }, user: { findUnique: async () => null },
      runEvent: { aggregate: async () => ({ _max: { seq: 0 } }) },
    };
    const response = await controller(prisma, {}).reclaim(runner, SESSION_SOURCE_PIN_V1, request);
    assert.deepEqual(response.sessions.map((session) => session.sessionId), ['claude']);
  }
});

test('P1b dsh provider notices distinguish native and legacy colliding identities', async () => {
  const marked: Array<{ where: unknown; data: { error: string } }> = [];
  const prisma = {
    runner: { findUnique: async () => null },
    modelProvider: { findMany: async ({ where }: { where: { runtime: string } }) =>
      where.runtime === 'dsh' ? [{ slug: 'harness-key' }] : [] },
    session: {
      findMany: async ({ where }: { where: { OR?: unknown[] } }) => where.OR ? [{ id: 'native', error: null }] : [],
      updateMany: async (args: { where: unknown; data: { error: string } }) => { marked.push(args); return { count: 1 }; },
    },
  };
  await controller(prisma, { claimSessionForRunner: async () => null }).claim(runner, SESSION_SOURCE_PIN_V1, 'claude,codex,opencode,antigravity');
  assert.equal(marked.length, 1);
  assert.equal(marked[0].data.error, DSH_RUNNER_UPGRADE_ERROR);
  assert.deepEqual(marked[0].where, {
    id: { in: ['native'] }, assignedRunnerId: runner.id, status: 'PENDING',
    OR: [{ provider: 'dsh', providerBuiltin: true }, { provider: { in: ['harness-key'] }, providerBuiltin: false }],
    cancelRequestedAt: null,
  });
});

test('P1b dsh heartbeat omission withdraws provider declaration', () => {
  assert.deepEqual(advertisedRunnerProviders('DSH,dsh-preview,unknown'), [AgentProvider.DSH]);
  assert.deepEqual(withProviderDeclarations(['source-pin/v1', 'provider:dsh'], undefined), ['source-pin/v1']);
  assert.deepEqual(withProviderDeclarations(['provider:dsh'], 'claude,codex'), ['provider:claude', 'provider:codex']);
  assert.deepEqual(withProviderDeclarations([], 'DSH'), ['provider:dsh']);
});
