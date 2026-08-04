import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { SessionsService } from './sessions.service';

test('creating an OpenCode session does not preseed a Claude runtime id', async () => {
  const previousNamingKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  let createdData: Record<string, unknown> | undefined;
  const agent = {
    id: 'agent-1',
    provider: AgentProvider.OPENCODE,
    enableWorktree: false,
    permissionMode: 'acceptEdits',
  };
  const prisma = {
    agent: { findFirst: async () => agent },
    runner: { findFirst: async () => ({ id: 'runner-1' }) },
    // The agent carries no providerBuiltin, i.e. a row written before that column existed. That
    // is the case worth keeping here — it is the one create() resolves by looking the slug up in
    // modelProvider — so the stub has to answer that lookup. No row matches "opencode", so no
    // runtime is borrowed and the built-in OpenCode runtime stands.
    modelProvider: { findFirst: async () => null },
    session: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdData = data;
        return {
          id: 'session-1',
          ...data,
          endReason: null,
          completedAt: null,
          archivedAt: null,
          deletedAt: null,
        };
      },
    },
  } as never;
  const queue = { notifySessionQueued: () => undefined } as never;
  const realtime = { publishSessionCreated: () => undefined } as never;
  const service = new SessionsService(prisma, queue, realtime);

  try {
    await service.create('owner-1', {
      title: 'OpenCode session',
      prompt: 'Use OpenCode',
      assignedRunnerId: 'runner-1',
      agentId: 'agent-1',
      model: 'anthropic/claude-sonnet-4-5',
      effort: 'max',
    });
  } finally {
    if (previousNamingKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousNamingKey;
  }

  assert.equal(createdData?.provider, AgentProvider.OPENCODE);
  assert.equal(createdData?.runtimeSessionId, null);
  assert.equal(createdData?.model, 'anthropic/claude-sonnet-4-5');
  assert.equal(createdData?.effort, 'max');
});
