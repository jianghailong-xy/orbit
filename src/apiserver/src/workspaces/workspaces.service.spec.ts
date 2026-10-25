import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { SessionsService } from '../sessions/sessions.service';
import { WorkspacesService } from './workspaces.service';

/** Records what reached the database; `$queryRaw` stands in for the derived-provider lookup. */
function prismaStub(writes: Record<string, unknown>[]) {
  return {
    runner: { findMany: async () => [] },
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

// Orchestration is the account's switch (common/orchestration-switch.ts), not a workspace field:
// what an older client still sends about it on create or update is never written.
test('orchestration named on workspace create or update is never written', async () => {
  const writes: Record<string, unknown>[] = [];
  const service = new WorkspacesService(prismaStub(writes));

  await service.create('owner-1', { name: 'worker', enableOrchestration: true } as never);
  await service.update('owner-1', 'workspace-1', { enableOrchestration: true } as never);

  assert.equal('enableOrchestration' in writes[0], false);
  assert.equal('enableOrchestration' in writes[1], false);
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
      findMany: async () => [],
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
 * taking it would read as "already deleted" here rather than quietly working. `coordinators` are
 * the projects whose coordinator conversation runs in the workspace; `ended` records which of
 * those the delete ended, and `failing` names one whose ending fails.
 */
function deleteStub(
  coordinating: number,
  locked = true,
  coordinators: Array<{ id: string; coordinatorSessionId: string }> = [],
  failing?: string,
) {
  const deleted: Record<string, unknown>[] = [];
  const counted: unknown[] = [];
  const asked: unknown[] = [];
  const ended: string[] = [];
  const prisma = {
    runner: { findMany: async () => [] },
    workspace: {
      findFirst: async () => ({ id: 'workspace-1' }),
      update: async (args: { data: Record<string, unknown> }) => {
        deleted.push(args.data);
        return { id: 'workspace-1' };
      },
    },
    projectMember: {
      count: async (args: { where: unknown }) => {
        counted.push(args.where);
        return coordinating;
      },
    },
    project: {
      findMany: async (args: { where: unknown }) => {
        asked.push(args.where);
        return coordinators;
      },
    },
    $queryRaw: async () => (locked ? [{ id: 'workspace-1' }] : []),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  } as unknown as PrismaService;
  const sessions = {
    complete: async (ownerId: string, id: string) => {
      assert.equal(ownerId, 'owner-1');
      if (id === failing) throw new Error('the runner went away');
      ended.push(id);
      return { ok: true };
    },
  } as unknown as SessionsService;
  return { prisma, sessions, deleted, counted, asked, ended };
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

test('only an open project, or one whose owner chose this agent, holds it back', async () => {
  // A settled project (DONE, CANCELLED) no longer does: a workspace that once coordinated a finished
  // project could otherwise never be deleted. An owner's explicit choice still does, whatever the
  // status — migration 0114 refuses to keep a chosen coordinator that is no longer a live agent.
  const { prisma, counted } = deleteStub(0);

  await new WorkspacesService(prisma).remove('owner-1', 'workspace-1');

  assert.deepEqual(counted, [
    {
      agentId: 'workspace-1',
      project: {
        OR: [
          { status: 'OPEN' },
          { runtime: { is: { coordinatorIdentitySource: 'EXPLICIT' } } },
        ],
      },
    },
  ]);
});

test('deleting a workspace ends every coordinator conversation that ran in it', async () => {
  // From a deleted workspace a coordinator cannot act (the runner refuses it orchestration), so it
  // is ended, and a project that comes back reads its coordinator as unavailable and is rebound.
  const { prisma, sessions, deleted, asked, ended } = deleteStub(0, true, [
    { id: 'project-done', coordinatorSessionId: 'coordinator-done' },
    { id: 'project-cancelled', coordinatorSessionId: 'coordinator-cancelled' },
  ]);

  assert.deepEqual(await new WorkspacesService(prisma, sessions).remove('owner-1', 'workspace-1'), {
    ok: true,
  });

  assert.equal(deleted.length, 1);
  assert.deepEqual(asked, [
    {
      ownerId: 'owner-1',
      coordinatorSession: { workspaceId: 'workspace-1', deletedAt: null, completedAt: null },
    },
  ]);
  assert.deepEqual(ended, ['coordinator-done', 'coordinator-cancelled']);
});

test('a coordinator that will not end leaves the delete standing and the others ended', async () => {
  const { prisma, sessions, deleted, ended } = deleteStub(
    0,
    true,
    [
      { id: 'project-a', coordinatorSessionId: 'coordinator-a' },
      { id: 'project-b', coordinatorSessionId: 'coordinator-b' },
    ],
    'coordinator-a',
  );

  assert.deepEqual(await new WorkspacesService(prisma, sessions).remove('owner-1', 'workspace-1'), {
    ok: true,
  });
  assert.equal(deleted.length, 1);
  assert.deepEqual(ended, ['coordinator-b']);
});

test('a refused delete ends no coordinator', async () => {
  const { prisma, sessions, asked, ended } = deleteStub(1, true, [
    { id: 'project-open', coordinatorSessionId: 'coordinator-open' },
  ]);

  await assert.rejects(
    () => new WorkspacesService(prisma, sessions).remove('owner-1', 'workspace-1'),
    (e: { status?: number }) => e.status === 409,
  );
  assert.deepEqual(asked, []);
  assert.deepEqual(ended, []);
});

test('an agent no project coordinates with is deleted as before', async () => {
  const { prisma, deleted } = deleteStub(0);

  const result = await new WorkspacesService(prisma).remove('owner-1', 'workspace-1');

  assert.deepEqual(result, { ok: true });
  assert.equal(deleted.length, 1);
  assert.ok(deleted[0].deletedAt instanceof Date);
});

/**
 * An explicit URL is stored exactly as the person typed it; project integration normalizes it
 * when binding. Runner detection only fills an empty URL and must leave this choice alone.
 */
test('a repository URL stated on the workspace is stored as stated', async () => {
  const writes: Record<string, unknown>[] = [];
  const service = new WorkspacesService(prismaStub(writes));

  await service.create('owner-1', { name: 'checkout', repoUrl: 'https://GitHub.com/Example/Repo.git' });
  await service.update('owner-1', 'workspace-1', { repoUrl: 'https://github.com/example/other' });

  assert.equal(writes[0].repoUrl, 'https://GitHub.com/Example/Repo.git');
  assert.equal(writes[1].repoUrl, 'https://github.com/example/other');
});

// Prisma reads an absent field as "leave the column alone" and an explicit null as "clear it", so
// the difference between the two is the whole of "a PATCH that edits the name does not silently
// unbind every project coordinated from this workspace". The web editor PATCHes its whole body on
// every save, and most of those bodies say nothing about the remote.
test('a workspace patch that names no repository URL does not touch the column', async () => {
  const writes: Record<string, unknown>[] = [];
  const service = new WorkspacesService(prismaStub(writes));

  await service.update('owner-1', 'workspace-1', { name: 'renamed' });
  await service.update('owner-1', 'workspace-1', { workDir: '/srv/other' });

  for (const write of writes) {
    assert.equal(write.repoUrl, undefined,
      'a patch that named no remote wrote the column — undefined leaves it, null clears it');
  }
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
