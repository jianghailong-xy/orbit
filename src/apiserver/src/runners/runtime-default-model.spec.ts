import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaService } from '../prisma/prisma.service';
import { RunnersService } from './runners.service';

test('GET runners always returns a sanitized runtimeDefaultModels map', async () => {
  const prisma = {
    runner: {
      findMany: async () => [
        {
          id: 'runner-1',
          name: 'host',
          status: 'ONLINE',
          lastHeartbeatAt: new Date(),
          availableCommands: null,
          availableSkills: null,
          runtimeDefaultModels: null,
        },
        {
          id: 'runner-2',
          name: 'host 2',
          status: 'ONLINE',
          lastHeartbeatAt: new Date(),
          availableCommands: null,
          availableSkills: null,
          runtimeDefaultModels: { claude: ' claude-opus-5 ', custom: 'secret' },
        },
      ],
    },
    session: { groupBy: async () => [] },
  } as unknown as PrismaService;

  const rows = await new RunnersService(prisma).listRunners('owner-1');
  assert.deepEqual(rows[0].runtimeDefaultModels, {});
  assert.deepEqual(rows[1].runtimeDefaultModels, { claude: 'claude-opus-5' });
});
