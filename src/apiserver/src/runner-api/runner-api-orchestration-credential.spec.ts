import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import {
  RunnerApiController,
  SESSION_ORCHESTRATION_CREDENTIAL_V1,
  runnerSupportsCapability,
} from './runner-api.controller';

const RUNNER = { id: 'runner-1', ownerId: 'owner-1' };

function makeController(options: {
  claimed?: Record<string, unknown> | null;
  reclaimed?: Array<Record<string, unknown>>;
}) {
  const issueCalls: Array<[string, string]> = [];
  const reissueCalls: Array<[typeof RUNNER, string]> = [];
  const reclaimLookups: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
  };
  const prisma = {
    session: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        reclaimLookups.push(where);
        return options.reclaimed ?? [];
      },
    },
    user: {
      findUnique: async () => null,
    },
    runEvent: {
      aggregate: async () => ({ _max: { seq: 3 } }),
    },
    $executeRaw: async () => 1,
    $transaction: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const queue = {
    claimSessionForRunner: async () => options.claimed ?? null,
  };
  const orchestration = {
    issue: async (runnerId: string, sessionId: string) => {
      issueCalls.push([runnerId, sessionId]);
      return `credential-for-${sessionId}`;
    },
    reissue: async (runner: typeof RUNNER, sessionId: string) => {
      reissueCalls.push([runner, sessionId]);
      return `refreshed-credential-for-${sessionId}`;
    },
  };
  const realtime = { notifyInbox: () => undefined };
  return {
    controller: new RunnerApiController(
      prisma as never,
      queue as never,
      realtime as never,
      {} as never,
      orchestration as never,
    ),
    issueCalls,
    reissueCalls,
    reclaimLookups,
  };
}

test('runner capability parsing accepts lists without accepting partial names', () => {
  assert.equal(
    runnerSupportsCapability(
      `future-capability, ${SESSION_ORCHESTRATION_CREDENTIAL_V1}`,
      SESSION_ORCHESTRATION_CREDENTIAL_V1,
    ),
    true,
  );
  assert.equal(
    runnerSupportsCapability(
      ['future-capability', SESSION_ORCHESTRATION_CREDENTIAL_V1.toUpperCase()],
      SESSION_ORCHESTRATION_CREDENTIAL_V1,
    ),
    true,
  );
  assert.equal(
    runnerSupportsCapability(
      `${SESSION_ORCHESTRATION_CREDENTIAL_V1}-extra`,
      SESSION_ORCHESTRATION_CREDENTIAL_V1,
    ),
    false,
  );
  assert.equal(
    runnerSupportsCapability(undefined, SESSION_ORCHESTRATION_CREDENTIAL_V1),
    false,
  );
});

test('claim enables orchestration only when the runner negotiated credential v1', async () => {
  const enabled = makeController({
    claimed: {
      sessionId: 'enabled-session',
      allowOrchestration: true,
    },
  });
  const enabledJob = await enabled.controller.claim(RUNNER, SESSION_ORCHESTRATION_CREDENTIAL_V1);
  assert.equal(enabledJob?.allowOrchestration, true);
  assert.equal(enabledJob?.orchestrationToken, 'credential-for-enabled-session');
  assert.deepEqual(enabled.issueCalls, [['runner-1', 'enabled-session']]);

  const legacy = makeController({
    claimed: {
      sessionId: 'legacy-session',
      allowOrchestration: true,
    },
  });
  const legacyJob = await legacy.controller.claim(RUNNER);
  assert.equal(legacyJob?.allowOrchestration, false);
  assert.equal(legacyJob?.orchestrationToken, undefined);
  assert.deepEqual(legacy.issueCalls, []);

  const disabled = makeController({
    claimed: {
      sessionId: 'disabled-session',
      allowOrchestration: false,
    },
  });
  const disabledJob = await disabled.controller.claim(
    RUNNER,
    SESSION_ORCHESTRATION_CREDENTIAL_V1,
  );
  assert.equal(disabledJob?.orchestrationToken, undefined);
  assert.deepEqual(disabled.issueCalls, []);

  const idle = makeController({ claimed: null });
  assert.equal(
    await idle.controller.claim(RUNNER, SESSION_ORCHESTRATION_CREDENTIAL_V1),
    null,
  );
  assert.deepEqual(idle.issueCalls, []);
});

test('reclaim enables orchestration only when capability and every live guard match', async () => {
  const session = (
    id: string,
    enableOrchestration: boolean,
    overrides: Record<string, unknown> = {},
    agentOverrides: Record<string, unknown> = {},
  ) => ({
    id,
    ownerId: 'owner-1',
    assignedRunnerId: 'runner-1',
    status: RunStatus.RUNNING,
    deletedAt: null,
    cancelRequestedAt: null,
    title: id,
    provider: 'codex',
    providerBuiltin: true,
    runtimeSessionId: `runtime-${id}`,
    claudeSessionId: null,
    model: null,
    permissionMode: null,
    effort: null,
    branch: null,
    mergeTarget: null,
    agentId: `agent-${id}`,
    taskId: null,
    agent: {
      provider: 'codex',
      model: null,
      env: null,
      appendSystemPrompt: null,
      systemPrompt: null,
      allowedTools: null,
      disallowedTools: null,
      permissionMode: null,
      effort: null,
      maxTurns: null,
      maxBudgetUsd: null,
      mcpConfig: null,
      workDir: null,
      autoInitGit: false,
      defaultMergeTarget: null,
      enableOrchestration,
      deletedAt: null,
      ...agentOverrides,
    },
    ...overrides,
  });
  const { controller, issueCalls, reclaimLookups } = makeController({
    reclaimed: [
      session('enabled-session', true),
      session('disabled-session', false),
      session('cancelled-session', true, { cancelRequestedAt: new Date() }),
      session('deleted-session', true, { deletedAt: new Date() }),
      session('foreign-owner-session', true, { ownerId: 'owner-2' }),
      session('other-runner-session', true, { assignedRunnerId: 'runner-2' }),
      session('finished-session', true, { status: RunStatus.SUCCEEDED }),
      session('deleted-agent-session', true, {}, { deletedAt: new Date() }),
    ],
  });

  const result = await controller.reclaim(RUNNER, SESSION_ORCHESTRATION_CREDENTIAL_V1);
  const enabled = result.sessions.find((item) => item.sessionId === 'enabled-session');
  const disabled = result.sessions.find((item) => item.sessionId === 'disabled-session');
  assert.equal(enabled?.allowOrchestration, true);
  assert.equal(enabled?.orchestrationToken, 'credential-for-enabled-session');
  assert.equal(disabled?.allowOrchestration, false);
  assert.equal(disabled?.orchestrationToken, undefined);
  assert.deepEqual(issueCalls, [['runner-1', 'enabled-session']]);
  for (const item of result.sessions.filter((entry) => entry.sessionId !== 'enabled-session')) {
    assert.equal(item.allowOrchestration, false, `${item.sessionId} unexpectedly enabled`);
    assert.equal(item.orchestrationToken, undefined, `${item.sessionId} unexpectedly got a token`);
  }
  assert.deepEqual(reclaimLookups, [
    {
      assignedRunnerId: 'runner-1',
      ownerId: 'owner-1',
      status: {
        in: [
          RunStatus.PENDING,
          RunStatus.RUNNING,
          RunStatus.AWAITING_INPUT,
          RunStatus.INTERRUPTED,
        ],
      },
    },
  ]);

  const legacy = makeController({
    reclaimed: [session('legacy-enabled-session', true)],
  });
  const legacyResult = await legacy.controller.reclaim(RUNNER);
  assert.equal(legacyResult.sessions[0]?.allowOrchestration, false);
  assert.equal(legacyResult.sessions[0]?.orchestrationToken, undefined);
  assert.deepEqual(legacy.issueCalls, []);
});

test('credential refresh delegates to the runner-bound live-session reissuer', async () => {
  const { controller, reissueCalls } = makeController({});
  assert.deepEqual(
    await controller.refreshOrchestrationCredential(RUNNER, 'caller-session'),
    { orchestrationToken: 'refreshed-credential-for-caller-session' },
  );
  assert.deepEqual(reissueCalls, [[RUNNER, 'caller-session']]);
});
