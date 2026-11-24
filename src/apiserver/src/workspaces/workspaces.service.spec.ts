import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { SessionsService as SessionsServiceClass, type SessionsService } from '../sessions/sessions.service';
import { WorkspacesService } from './workspaces.service';
import { renderRawQuery } from '../test-support/prisma-transaction-double';

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

test('GET /workspaces/:id says when the workspace was last used and how many conversations it holds', async () => {
  const lastActive = new Date('2026-11-11T10:00:00.000Z');
  const counted: unknown[] = [];
  const prisma = {
    runner: { findMany: async () => [] },
    workspace: { findFirst: async () => ({ id: 'workspace-1', name: 'orbit', runner: null }) },
    // The landing view asks whether the owner holds a live GitHub connection; none here.
    githubConnection: { findFirst: async () => null },
    session: {
      count: async (args: unknown) => {
        counted.push(args);
        return 37;
      },
    },
    // The usage read is the one that names last_turn_at; the provider read answers nothing here.
    $queryRaw: async (...args: unknown[]) =>
      renderRawQuery(args).text.includes('last_turn_at')
        ? [{ workspace_id: 'workspace-1', last_active_at: lastActive }]
        : [],
  } as unknown as PrismaService;
  const service = new WorkspacesService(prisma);

  const read = await service.getWithUsage('owner-1', 'workspace-1');
  assert.equal(read.sessionCount, 37);
  assert.deepEqual(read.lastActiveAt, lastActive);
  // Conversations only: not the sessions spawned from another, and not the trashed ones.
  assert.deepEqual(counted, [
    { where: { workspaceId: 'workspace-1', sessionKind: 'CONVERSATION', parentSessionId: null, deletedAt: null, runSource: { not: 'SCHEDULE' } } },
  ]);

  // A save reads the workspace back without counting.
  counted.length = 0;
  await service.get('owner-1', 'workspace-1');
  assert.deepEqual(counted, []);
});

test('the workspace list carries when each was last used, and never counts sessions', async () => {
  const lastActive = new Date('2026-11-11T10:00:00.000Z');
  const prisma = {
    runner: { findMany: async () => [] },
    workspace: {
      findMany: async () => [
        { id: 'workspace-1', name: 'orbit', runner: null },
        { id: 'workspace-2', name: 'never-used', runner: null },
      ],
    },
    $queryRaw: async (...args: unknown[]) =>
      renderRawQuery(args).text.includes('last_turn_at')
        ? [{ workspace_id: 'workspace-1', last_active_at: lastActive }]
        : [],
  } as unknown as PrismaService;

  const rows = await new WorkspacesService(prisma).list('owner-1');
  assert.deepEqual(
    rows.map((row) => [row.id, row.lastActiveAt, 'sessionCount' in row]),
    [
      ['workspace-1', lastActive, false],
      ['workspace-2', null, false],
    ],
  );
});

// The setup card's Create workspace (docs/first-workspace-contract.md §3, outside a session): a new folder under
// the runner's reposRoot, made by the runner at the first session's claim, as POST /sessions `newWorkspace` makes one.
function newFolderStub(writes: Record<string, unknown>[], runner: Record<string, unknown>) {
  const prisma = prismaStub(writes) as unknown as Record<string, Record<string, unknown>>;
  prisma.runner = {
    ...prisma.runner,
    findFirst: async () => ({ id: 'runner-1' }),
    findFirstOrThrow: async () => runner,
  };
  return new WorkspacesService(prisma as unknown as PrismaService);
}
const MAKES_FOLDERS = { reposRoot: '/root/orbit-repos/', capabilities: ['create-workdir/v1'], capabilitiesReportedAt: new Date() };

test('newFolder makes the workspace in a folder under reposRoot that its first session creates', async () => {
  const writes: Record<string, unknown>[] = [];
  await newFolderStub(writes, MAKES_FOLDERS).create('owner-1', { name: 'app', runnerId: 'runner-1', newFolder: 'app' });
  assert.equal(writes[0].workDir, '/root/orbit-repos/app');
  assert.equal(writes[0].autoCreateWorkDir, true);
  assert.equal('newFolder' in writes[0], false);
});

test('a workDir workspace never has its folder made', async () => {
  const writes: Record<string, unknown>[] = [];
  await newFolderStub(writes, MAKES_FOLDERS).create('owner-1', { name: 'app', runnerId: 'runner-1', workDir: '/srv/app' });
  assert.equal(writes[0].workDir, '/srv/app');
  assert.equal(writes[0].autoCreateWorkDir, false);
});

test('newFolder is refused without a runner, beside a workDir, with a bad name, or on a runner that cannot make one', async () => {
  const writes: Record<string, unknown>[] = [];
  const service = newFolderStub(writes, MAKES_FOLDERS);
  await assert.rejects(service.create('owner-1', { name: 'a', newFolder: 'a' }), /needs runnerId/);
  await assert.rejects(service.create('owner-1', { name: 'a', runnerId: 'runner-1', newFolder: 'a', workDir: '/a' }), /one of workDir and newFolder/);
  await assert.rejects(service.create('owner-1', { name: 'a', runnerId: 'runner-1', newFolder: '../a' }), /one folder name/);
  const old = newFolderStub(writes, { ...MAKES_FOLDERS, capabilities: [] });
  await assert.rejects(old.create('owner-1', { name: 'a', runnerId: 'runner-1', newFolder: 'a' }), (e: { response?: { code?: string } }) => e.response?.code === 'NEW_FOLDER_UNSUPPORTED');
  assert.equal(writes.length, 0);
});

// From GitHub on the setup card's Create workspace (docs/mocks/github-workspace board 04): POST /workspaces `github`
// makes the workspace that POST /sessions `newWorkspace.github` makes, through the same SessionsService.githubWorkspaceFor
// and so the same refusals, and the runner's next reconcile clones it (cloneRequestsFor reads PENDING).
const REPO = { id: 4242, fullName: 'orbit-labs/orbit-web', installationId: 77, private: true, defaultBranch: 'main' };
const CLONES = { id: 'runner-1', reposRoot: '/Users/austin/orbit-repos', capabilities: ['clone-workdir/v1'], capabilitiesReportedAt: new Date() };
function githubStub(
  writes: Record<string, unknown>[],
  runner: Record<string, unknown>,
  connections: { reachableRepository: (ownerId: string, repoId: string) => Promise<unknown> } | undefined,
  asked: string[] = [],
) {
  const prisma = prismaStub(writes) as unknown as Record<string, Record<string, unknown>>;
  prisma.runner = {
    ...prisma.runner,
    findFirst: async () => ({ id: 'runner-1' }),
    findFirstOrThrow: async () => runner,
  };
  // The real door, on a stand-in for the GitHub connection it asks.
  const githubConnections = connections && {
    reachableRepository: async (ownerId: string, repoId: string) => {
      asked.push(repoId);
      return connections.reachableRepository(ownerId, repoId);
    },
  };
  const sessions = {
    githubWorkspaceFor: SessionsServiceClass.prototype.githubWorkspaceFor.bind({ githubConnections } as unknown as SessionsService),
  } as unknown as SessionsService;
  return new WorkspacesService(prisma as unknown as PrismaService, sessions);
}
const reaches = { reachableRepository: async (_o: string, id: string) => (id === String(REPO.id) ? REPO : null) };
const codeOf = (code: string) => (e: { response?: { code?: string } }) => e.response?.code === code;

test('github makes a worktree workspace under reposRoot whose clone is PENDING, with no folder of its own to make', async () => {
  const writes: Record<string, unknown>[] = [];
  const asked: string[] = [];
  await githubStub(writes, CLONES, reaches, asked).create('owner-1', {
    name: 'orbit-web',
    runnerId: 'runner-1',
    github: { repoId: 4242, ref: 'release/2', folder: 'web' },
  });
  assert.deepEqual(asked, ['4242']);
  assert.equal(writes[0].workDir, '/Users/austin/orbit-repos/web');
  assert.equal(writes[0].autoCreateWorkDir, false);
  assert.equal(writes[0].enableWorktree, true);
  assert.equal(writes[0].cloneState, 'PENDING');
  assert.equal(writes[0].cloneRef, 'release/2');
  assert.equal(writes[0].githubRepoId, 4242n);
  assert.equal(writes[0].githubInstallationId, 77n);
  assert.equal(writes[0].repoUrl, 'https://github.com/orbit-labs/orbit-web.git');
  assert.equal('github' in writes[0], false);
});

test('github without a folder takes the repository name, and the default branch when no ref is named', async () => {
  const writes: Record<string, unknown>[] = [];
  await githubStub(writes, CLONES, reaches).create('owner-1', { name: 'orbit-web', runnerId: 'runner-1', github: { repoId: '4242' } });
  assert.equal(writes[0].workDir, '/Users/austin/orbit-repos/orbit-web');
  assert.equal(writes[0].cloneRef, null);
});

test('github is refused as newWorkspace.github is: its 400s, then not connected, then not reachable, then a runner that cannot clone', async () => {
  const writes: Record<string, unknown>[] = [];
  const service = githubStub(writes, CLONES, reaches);
  // 400s, named by the field this body carries.
  await assert.rejects(service.create('owner-1', { name: 'a', github: { repoId: 4242 } }), /github needs runnerId/);
  await assert.rejects(
    service.create('owner-1', { name: 'a', runnerId: 'runner-1', github: { repoId: 4242 }, workDir: '/a' }),
    /one of workDir, newFolder and github/,
  );
  await assert.rejects(
    service.create('owner-1', { name: 'a', runnerId: 'runner-1', github: { repoId: 4242 }, newFolder: 'a' }),
    /one of workDir, newFolder and github/,
  );
  await assert.rejects(service.create('owner-1', { name: 'a', runnerId: 'runner-1', github: { repoId: 'x' } }), /^BadRequestException: github\.repoId must be/);
  await assert.rejects(service.create('owner-1', { name: 'a', runnerId: 'runner-1', github: { repoId: 1, ref: '-x' } }), /github\.ref must be a branch/);
  await assert.rejects(service.create('owner-1', { name: 'a', runnerId: 'runner-1', github: { repoId: 1, folder: '..' } }), /github\.folder must be one folder name/);
  await assert.rejects(service.create('owner-1', { name: 'a', runnerId: 'runner-1', github: { repoId: 1, url: 'x' } }), /github takes repoId, ref and folder, not url/);
  // 409 GITHUB_NOT_CONNECTED: this Orbit has no GitHub connection to ask.
  await assert.rejects(
    githubStub(writes, CLONES, undefined).create('owner-1', { name: 'a', runnerId: 'runner-1', github: { repoId: 4242 } }),
    codeOf('GITHUB_NOT_CONNECTED'),
  );
  // 403 GITHUB_REPO_FORBIDDEN: GitHub does not show the caller that repository, even on a runner that cannot clone.
  await assert.rejects(
    githubStub(writes, { ...CLONES, capabilities: [] }, reaches).create('owner-1', { name: 'a', runnerId: 'runner-1', github: { repoId: 9 } }),
    codeOf('GITHUB_REPO_FORBIDDEN'),
  );
  // 409 CLONE_UNSUPPORTED: a runner without clone-workdir/v1, and one that has not reported its reposRoot.
  await assert.rejects(
    githubStub(writes, { ...CLONES, capabilities: [] }, reaches).create('owner-1', { name: 'a', runnerId: 'runner-1', github: { repoId: 4242 } }),
    codeOf('CLONE_UNSUPPORTED'),
  );
  await assert.rejects(
    githubStub(writes, { ...CLONES, reposRoot: null }, reaches).create('owner-1', { name: 'a', runnerId: 'runner-1', github: { repoId: 4242 } }),
    codeOf('CLONE_UNSUPPORTED'),
  );
  assert.equal(writes.length, 0);
});
