import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';
import { OPENCODE_RUNNER_UPGRADE_ERROR } from './runner-provider-support';

const RUNNER = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
};

test('legacy claim explains the pending OpenCode stall without stranding other work', async () => {
  let claimedFor: { supportedProviders?: readonly AgentProvider[] } | undefined;
  let storedError: string | undefined;
  const published: string[] = [];
  const prisma = {
    session: {
      findMany: async () => [{ id: 'session-1', error: null }],
      updateMany: async ({ data }: { data: { error: string } }) => {
        storedError = data.error;
        return { count: 1 };
      },
    },
  } as never;
  const queue = {
    claimSessionForRunner: async (runner: { supportedProviders?: readonly AgentProvider[] }) => {
      claimedFor = runner;
      return null;
    },
  } as never;
  const realtime = { publishSessionCreated: (id: string) => published.push(id) } as never;
  const controller = new RunnerApiController(prisma, queue, realtime, {} as never, {} as never, {} as never, {} as never);

  assert.equal(await controller.claim(RUNNER, undefined, 'claude,codex'), null);
  // The OpenCode row is marked so the UI can say why it is stuck...
  assert.equal(storedError, OPENCODE_RUNNER_UPGRADE_ERROR);
  assert.deepEqual(published, ['session-1']);
  // ...but this runner still gets to claim its Claude/Codex work. The queue gate (and
  // migration 0080's trigger) is what keeps the OpenCode row away from it.
  assert.deepEqual(claimedFor?.supportedProviders, [AgentProvider.CLAUDE, AgentProvider.CODEX]);
});

test('current claim advertises OpenCode directly to the atomic queue gate', async () => {
  let advertised: readonly AgentProvider[] | undefined;
  const queue = {
    claimSessionForRunner: async (runner: { supportedProviders?: readonly AgentProvider[] }) => {
      advertised = runner.supportedProviders;
      return null;
    },
  } as never;
  const controller = new RunnerApiController(
    { session: { findMany: async () => assert.fail('capable runner should not need a preflight') } } as never,
    queue,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  assert.equal(await controller.claim(RUNNER, undefined, 'claude,codex,opencode'), null);
  assert.deepEqual(advertised, [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.OPENCODE]);
});

/** Enough of a Session row for reclaim to build one ReclaimSession payload. */
function reclaimRow(id: string, provider: AgentProvider, status: string) {
  return {
    id,
    provider,
    providerBuiltin: true,
    status,
    cancelRequestedAt: null,
    error: null,
    workspace: null,
    ownerId: RUNNER.ownerId,
    model: 'pinned-model',
    usesRuntimeDefaultModel: true,
    inboxLeaseOwner: null,
    assignedRunner: null,
    permissionMode: null,
    effort: null,
    allowedTools: [],
    disallowedTools: [],
    // Claude is seeded with its runtime id at creation; reclaim skips a row without one.
    runtimeSessionId: provider === AgentProvider.CLAUDE ? `claude-${id}` : null,
  };
}

function reclaimPrisma(rows: unknown[], onUpdate: () => void) {
  return {
    session: {
      findMany: async () => rows,
      updateMany: async () => {
        onUpdate();
        return { count: 1 };
      },
    },
    user: { findUnique: async () => null },
    modelProvider: { findFirst: async () => null },
    runEvent: { aggregate: async () => ({ _max: { seq: 0 } }) },
    $executeRaw: async () => 0,
  } as never;
}

test('legacy reclaim omits OpenCode rows and keeps every other checkout', async () => {
  let upgradeMarked = false;
  const published: string[] = [];
  const prisma = reclaimPrisma(
    [
      reclaimRow('session-1', AgentProvider.OPENCODE, 'PENDING'),
      reclaimRow('session-2', AgentProvider.CLAUDE, 'AWAITING_INPUT'),
    ],
    () => {
      upgradeMarked = true;
    },
  );
  const realtime = { publishSessionCreated: (id: string) => published.push(id) } as never;
  const controller = new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never, {} as never);

  const res = await controller.reclaim(RUNNER, undefined, 'claude,codex');
  // A 426 here is not retryable on the runner and would stop the whole process, so the
  // undrivable row is dropped from the snapshot instead. Its checkout survives because
  // worktree GC re-asks `sessions/worktrees-removable`, which keeps non-terminal sessions.
  assert.deepEqual(
    res.sessions.map((s) => s.sessionId),
    ['session-2'],
  );
  assert.equal(upgradeMarked, true);
  assert.deepEqual(published, ['session-1']);
});

test('a capable reclaim keeps the OpenCode row in the snapshot', async () => {
  const prisma = reclaimPrisma([reclaimRow('session-1', AgentProvider.OPENCODE, 'AWAITING_INPUT')], () =>
    assert.fail('a capable runner needs no upgrade marking'),
  );
  const controller = new RunnerApiController(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);

  const res = await controller.reclaim(RUNNER, undefined, 'claude,codex,opencode');
  assert.deepEqual(
    res.sessions.map((s) => s.sessionId),
    ['session-1'],
  );
});
