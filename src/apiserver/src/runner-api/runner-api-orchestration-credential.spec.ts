import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunnerApiController } from './runner-api.controller';

const RUNNER = { id: 'runner-1' };

function makeController(options: {
  claimed?: Record<string, unknown> | null;
  reclaimed?: Array<Record<string, unknown>>;
}) {
  const issueCalls: Array<[string, string]> = [];
  const prisma = {
    session: {
      findMany: async () => options.reclaimed ?? [],
    },
    user: {
      findUnique: async () => null,
    },
    runEvent: {
      aggregate: async () => ({ _max: { seq: 3 } }),
    },
    conversationTurn: {
      updateMany: async () => ({ count: 0 }),
    },
  };
  const queue = {
    claimSessionForRunner: async () => options.claimed ?? null,
  };
  const orchestration = {
    issue: async (runnerId: string, sessionId: string) => {
      issueCalls.push([runnerId, sessionId]);
      return `credential-for-${sessionId}`;
    },
  };
  return {
    controller: new RunnerApiController(
      prisma as never,
      queue as never,
      {} as never,
      {} as never,
      orchestration as never,
    ),
    issueCalls,
  };
}

test('claim attaches a session credential only to an orchestration-enabled job', async () => {
  const enabled = makeController({
    claimed: {
      sessionId: 'enabled-session',
      allowOrchestration: true,
    },
  });
  const enabledJob = await enabled.controller.claim(RUNNER);
  assert.equal(enabledJob?.orchestrationToken, 'credential-for-enabled-session');
  assert.deepEqual(enabled.issueCalls, [['runner-1', 'enabled-session']]);

  const disabled = makeController({
    claimed: {
      sessionId: 'disabled-session',
      allowOrchestration: false,
    },
  });
  const disabledJob = await disabled.controller.claim(RUNNER);
  assert.equal(disabledJob?.orchestrationToken, undefined);
  assert.deepEqual(disabled.issueCalls, []);

  const idle = makeController({ claimed: null });
  assert.equal(await idle.controller.claim(RUNNER), null);
  assert.deepEqual(idle.issueCalls, []);
});

test('reclaim mints fresh credentials only for orchestration-enabled sessions', async () => {
  const session = (id: string, enableOrchestration: boolean) => ({
    id,
    ownerId: 'owner-1',
    title: id,
    provider: 'codex',
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
    },
  });
  const { controller, issueCalls } = makeController({
    reclaimed: [session('enabled-session', true), session('disabled-session', false)],
  });

  const result = await controller.reclaim(RUNNER);
  const enabled = result.sessions.find((item) => item.sessionId === 'enabled-session');
  const disabled = result.sessions.find((item) => item.sessionId === 'disabled-session');
  assert.equal(enabled?.allowOrchestration, true);
  assert.equal(enabled?.orchestrationToken, 'credential-for-enabled-session');
  assert.equal(disabled?.allowOrchestration, false);
  assert.equal(disabled?.orchestrationToken, undefined);
  assert.deepEqual(issueCalls, [['runner-1', 'enabled-session']]);
});
