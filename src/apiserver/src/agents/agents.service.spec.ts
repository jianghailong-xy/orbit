import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { AgentsService } from './agents.service';

/** Records what reached the database; `$queryRaw` stands in for the derived-provider lookup. */
function prismaStub(writes: Record<string, unknown>[]) {
  return {
    agent: {
      create: async (args: { data: Record<string, unknown> }) => {
        writes.push(args.data);
        return { id: 'agent-1', ...args.data };
      },
      findFirst: async () => ({ id: 'agent-1' }),
      update: async (args: { data: Record<string, unknown> }) => {
        writes.push(args.data);
        return { id: 'agent-1', ...args.data };
      },
    },
    $queryRaw: async () => [],
  } as unknown as PrismaService;
}

test('a provider named on agent create is accepted but never stored', async () => {
  const writes: Record<string, unknown>[] = [];

  const agent = await new AgentsService(prismaStub(writes)).create('owner-1', {
    name: 'Kimi agent',
    provider: AgentProvider.KIMI,
  });

  // An agent holds no provider: it names a machine and a directory. The provider is the
  // session's, and its default is derived from what the project last ran.
  assert.equal('provider' in writes[0], false);
  assert.equal('providerBuiltin' in writes[0], false);
  assert.equal(writes[0].model, null);
  // The read payload still answers the question — from history, not from the write.
  assert.equal(agent.lastProvider, AgentProvider.CLAUDE);
});

test('a provider named on agent update is accepted but never stored', async () => {
  const writes: Record<string, unknown>[] = [];

  await new AgentsService(prismaStub(writes)).update('owner-1', 'agent-1', {
    provider: AgentProvider.CODEX,
  });

  assert.equal('provider' in writes[0], false);
  assert.equal('providerBuiltin' in writes[0], false);
});

test('legacy model input is accepted but never written on create or update', async () => {
  const writes: Record<string, unknown>[] = [];
  const service = new AgentsService(prismaStub(writes));

  await service.create('owner-1', { name: 'legacy', model: 'claude-haiku-4-5' });
  await service.update('owner-1', 'agent-1', { model: 'claude-opus-5' });

  assert.equal(writes[0].model, null);
  assert.equal('model' in writes[1], false);
});
