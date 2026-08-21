import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from './workspaces.service';

/** Records what reached the database; `$queryRaw` stands in for the derived-provider lookup. */
function prismaStub(writes: Record<string, unknown>[], preferences: Record<string, unknown> = {}) {
  return {
    workspace: {
      create: async (args: { data: Record<string, unknown> }) => {
        writes.push(args.data);
        return { id: 'workspace-1', ...args.data };
      },
      findFirst: async () => ({ id: 'workspace-1' }),
      update: async (args: { data: Record<string, unknown> }) => {
        writes.push(args.data);
        return { id: 'workspace-1', ...args.data };
      },
    },
    user: { findUnique: async () => ({ preferences }) },
    $queryRaw: async () => [],
  } as unknown as PrismaService;
}

test('a provider named on workspace create is accepted but never stored', async () => {
  const writes: Record<string, unknown>[] = [];

  const workspace = await new WorkspacesService(prismaStub(writes)).create('owner-1', {
    name: 'Kimi workspace',
    provider: AgentProvider.KIMI,
  });

  // A workspace holds no provider: it names a machine and a directory. The provider is the
  // session's, and its default is derived from what the project last ran.
  assert.equal('provider' in writes[0], false);
  assert.equal('providerBuiltin' in writes[0], false);
  assert.equal(writes[0].model, null);
  // The read payload still answers the question — from history, not from the write.
  assert.equal(workspace.lastProvider, AgentProvider.CLAUDE);
});

test('a provider named on workspace update is accepted but never stored', async () => {
  const writes: Record<string, unknown>[] = [];

  await new WorkspacesService(prismaStub(writes)).update('owner-1', 'workspace-1', {
    provider: AgentProvider.CODEX,
  });

  assert.equal('provider' in writes[0], false);
  assert.equal('providerBuiltin' in writes[0], false);
});

test('legacy model input is accepted but never written on create or update', async () => {
  const writes: Record<string, unknown>[] = [];
  const service = new WorkspacesService(prismaStub(writes));

  await service.create('owner-1', { name: 'legacy', model: 'claude-haiku-4-5' });
  await service.update('owner-1', 'workspace-1', { model: 'claude-opus-5' });

  assert.equal(writes[0].model, null);
  assert.equal('model' in writes[1], false);
});

// Orchestration is granted per workspace and read live by the authorizer, so the account-level
// preference may only ever be a seed for the row a create writes.
test('a new workspace inherits the account default for orchestration', async () => {
  const writes: Record<string, unknown>[] = [];
  const prisma = prismaStub(writes, { defaultEnableOrchestration: true });

  await new WorkspacesService(prisma).create('owner-1', { name: 'worker' });

  assert.equal(writes[0].enableOrchestration, true);
});

test('an explicit choice on create beats the account default', async () => {
  const writes: Record<string, unknown>[] = [];
  const prisma = prismaStub(writes, { defaultEnableOrchestration: true });

  // What the web form and the MCP create path both send: a stated `false`. A default of on must
  // not be able to grant the capability to a workspace whose request said no.
  await new WorkspacesService(prisma).create('owner-1', {
    name: 'worker',
    enableOrchestration: false,
  });

  assert.equal(writes[0].enableOrchestration, false);
});

test('without the preference set, a new workspace still starts without the grant', async () => {
  const writes: Record<string, unknown>[] = [];

  await new WorkspacesService(prismaStub(writes)).create('owner-1', { name: 'worker' });

  assert.equal(writes[0].enableOrchestration, false);
});

// The bulk switch writes each workspace's own row — it must not reach another tenant's, and it
// must not resurrect the grant on soft-deleted ones (a restore would come back armed).
test('applying orchestration to all touches only this owner’s live workspaces', async () => {
  let where: Record<string, unknown> | undefined;
  let data: Record<string, unknown> | undefined;
  const prisma = {
    workspace: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        where = args.where;
        data = args.data;
        return { count: 3 };
      },
    },
  } as unknown as PrismaService;

  const result = await new WorkspacesService(prisma).setOrchestrationForAll('owner-1', true);

  assert.deepEqual(where, { ownerId: 'owner-1', deletedAt: null });
  assert.deepEqual(data, { enableOrchestration: true });
  assert.deepEqual(result, { updated: 3 });
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
    workspace: {
      findFirst: async () => ({
        id: 'workspace-1',
        runnerId: 'runner-1',
        runner: {
          id: 'runner-1',
          repoHealth: [{ root: '/root/orbit', state: 'unmerged', agentIds: ['workspace-1'] }],
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

  await new WorkspacesService(prisma).requestRepoCleanup('owner-1', 'workspace-1');

  const branches = (where?.OR ?? []) as Array<Record<string, unknown>>;
  assert.ok(
    branches.some((b) => b.repoCleanupStatus === null),
    'the filter must accept a runner whose repoCleanupStatus is still NULL',
  );
  assert.equal(where?.ownerId, 'owner-1'); // still owner-scoped: the runner is a separate row
});

/**
 * The delete path's own stub: a row that can be locked, a membership count, and a record of
 * whether the soft delete actually ran. `$queryRaw` answers the lock, so a service that stopped
 * taking it would read as "already deleted" here rather than quietly working.
 */
function deleteStub(coordinating: number, locked = true) {
  const deleted: Record<string, unknown>[] = [];
  const prisma = {
    workspace: {
      findFirst: async () => ({ id: 'workspace-1' }),
      update: async (args: { data: Record<string, unknown> }) => {
        deleted.push(args.data);
        return { id: 'workspace-1' };
      },
    },
    projectMember: { count: async () => coordinating },
    $queryRaw: async () => (locked ? [{ id: 'workspace-1' }] : []),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  } as unknown as PrismaService;
  return { prisma, deleted };
}

test('an agent that coordinates a project is not soft-deleted either', async () => {
  // The foreign key's RESTRICT only refuses a HARD delete; Orbit deletes agents by stamping
  // `deleted_at`, which the key cannot see. Without this the project keeps naming an agent that is
  // gone, and the identity behind its coordinator is a deleted row (validation 04, P1-03).
  const { prisma, deleted } = deleteStub(1);

  await assert.rejects(
    () => new WorkspacesService(prisma).remove('owner-1', 'workspace-1'),
    (e: { status?: number }) => e.status === 409,
  );
  assert.deepEqual(deleted, []);
});

test('an agent no project coordinates with is deleted as before', async () => {
  const { prisma, deleted } = deleteStub(0);

  const result = await new WorkspacesService(prisma).remove('owner-1', 'workspace-1');

  assert.deepEqual(result, { ok: true });
  assert.equal(deleted.length, 1);
  assert.ok(deleted[0].deletedAt instanceof Date);
});

test('deleting an agent that is already deleted is a no-op, not a second stamp', async () => {
  // The lock found no live row: another request got here first, and the caller asked for a state
  // this row is already in.
  const { prisma, deleted } = deleteStub(0, false);

  assert.deepEqual(await new WorkspacesService(prisma).remove('owner-1', 'workspace-1'), {
    ok: true,
  });
  assert.deepEqual(deleted, []);
});
