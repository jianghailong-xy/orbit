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

// A live repair request queued nothing on a runner that had never been asked, while the endpoint
// still answered 200 and the UI waited on "Cleaning up…" forever. Prisma compiles a bare
// `NOT: { repoCleanupStatus: 'pending' }` to `NOT (status = 'pending')`, which is NULL — not true
// — when the column is NULL. That is every runner's initial state, so the filter has to name null
// itself. A stubbed prisma can't reproduce SQL's three-valued logic, so assert the filter shape:
// the point is that "never asked" is spelled out rather than left to NOT.
test('the repair queue matches a runner that has never been asked', async () => {
  let where: Record<string, unknown> | undefined;
  const prisma = {
    agent: {
      findFirst: async () => ({
        id: 'agent-1',
        runnerId: 'runner-1',
        runner: {
          id: 'runner-1',
          repoHealth: [{ root: '/root/orbit', state: 'unmerged', agentIds: ['agent-1'] }],
        },
      }),
    },
    runner: {
      updateMany: async (args: { where: Record<string, unknown> }) => {
        where = args.where;
        return { count: 1 };
      },
    },
    $queryRaw: async () => [],
  } as unknown as PrismaService;

  await new AgentsService(prisma).requestRepoCleanup('owner-1', 'agent-1');

  const branches = (where?.OR ?? []) as Array<Record<string, unknown>>;
  assert.ok(
    branches.some((b) => b.repoCleanupStatus === null),
    'the filter must accept a runner whose repoCleanupStatus is still NULL',
  );
  assert.equal(where?.ownerId, 'owner-1'); // still owner-scoped: the runner is a separate row
});
