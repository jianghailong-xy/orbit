import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { SessionsService } from './sessions.service';

// A disabled agent takes no new work. The guard lives in create(), which every start path
// funnels through — the composer, a task run, an orchestrated spawn — so these cover all of
// them at the one place the decision is made.

type AgentRow = {
  runnerId?: string | null;
  enableWorktree: boolean;
  permissionMode: string;
  enabled: boolean;
};

function makeService(agent: AgentRow | null) {
  const prisma = {
    agent: { findFirst: async () => agent },
    // Reached only if the guard lets the call through; a null user keeps the effort
    // resolution quiet so the failure below is about routing, not about this stub.
    user: { findUnique: async () => null },
  } as never;
  return new SessionsService(prisma, {} as never, {} as never);
}

const disabled: AgentRow = {
  runnerId: 'runner-1',
  enableWorktree: false,
  permissionMode: 'dontAsk',
  enabled: false,
};

test('a disabled agent refuses a new session, and says so', async () => {
  const service = makeService(disabled);

  await assert.rejects(
    () => service.create('owner', { prompt: 'work', agentId: 'agent-1' }),
    (e: unknown) => {
      assert.ok(e instanceof ForbiddenException, `expected ForbiddenException, got ${e}`);
      // Distinct from "agent not found": the agent is there and its config is intact, which is
      // what tells the caller it can simply be switched back on.
      assert.match(String((e as Error).message), /disabled/i);
      return true;
    },
  );
});

test('the guard also covers the pinned-runner path', async () => {
  const service = makeService({ ...disabled, runnerId: null });

  await assert.rejects(
    () =>
      service.create('owner', {
        prompt: 'work',
        agentId: 'agent-1',
        assignedRunnerId: 'runner-1',
      }),
    (e: unknown) => e instanceof ForbiddenException && /disabled/i.test((e as Error).message),
  );
});

test('an enabled agent is not stopped by this guard', async () => {
  const service = makeService({ ...disabled, enabled: true });

  // It still fails further down (this stub has no runner/provider machinery behind it), but
  // it must not fail *here* — otherwise the guard would be refusing every agent.
  await assert.rejects(
    () => service.create('owner', { prompt: 'work', agentId: 'agent-1' }),
    (e: unknown) => !/disabled/i.test(String((e as Error).message)),
  );
});

test('a missing agent still reads as not found, not as disabled', async () => {
  const service = makeService(null);

  await assert.rejects(
    () => service.create('owner', { prompt: 'work', agentId: 'agent-1' }),
    (e: unknown) => /not found/i.test(String((e as Error).message)),
  );
});
