import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { AgentsService } from './agents.service';

test('creating a Kimi agent persists the runtime but leaves the legacy agent model null', async () => {
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
  assert.equal(data?.model, null);
});

test('legacy model input is accepted but never written on create or update', async () => {
  const writes: Record<string, unknown>[] = [];
  const prisma = {
    agent: {
      create: async (args: { data: Record<string, unknown> }) => {
        writes.push(args.data);
        return args.data;
      },
      findFirst: async () => ({ id: 'agent-1' }),
      update: async (args: { data: Record<string, unknown> }) => {
        writes.push(args.data);
        return args.data;
      },
    },
  } as unknown as PrismaService;
  const service = new AgentsService(prisma);

  await service.create('owner-1', { name: 'legacy', model: 'claude-haiku-4-5' });
  await service.update('owner-1', 'agent-1', { model: 'claude-opus-5' });

  assert.equal(writes[0].model, null);
  assert.equal('model' in writes[1], false);
});
