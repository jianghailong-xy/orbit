import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { AgentsService } from './agents.service';

test('creating a Kimi agent persists the first-class runtime and its managed default model', async () => {
  let data: Record<string, unknown> | undefined;
  const prisma = {
    agent: {
      create: async (args: { data: Record<string, unknown> }) => {
        data = args.data;
        return args.data;
      },
    },
  } as unknown as PrismaService;

  await new AgentsService(prisma).create('owner-1', {
    name: 'Kimi agent',
    provider: AgentProvider.KIMI,
  });

  assert.equal(data?.provider, AgentProvider.KIMI);
  assert.equal(data?.providerBuiltin, true);
  assert.equal(data?.model, 'kimi-code/kimi-for-coding');
});
