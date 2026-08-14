import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

/** What a session carries about the spawn tree it belongs to: which tree, and how deep in it. */
type SessionRow = { rootSessionId: string | null; spawnDepth: number };

function makeService(
  rows: Record<string, SessionRow>,
  defaults?: { workspaceEffort?: string | null; accountEffort?: string },
) {
  const createdFrom: string[] = [];
  const createdDtos: Array<{ effort?: string }> = [];
  const createdTrees: Array<{ rootSessionId: string; depth: number } | undefined> = [];
  const rootWrites: Array<{ id: string; rootSessionId: string | null }> = [];
  const prisma = {
    session: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        rows[where.id]
          ? { id: where.id, ...rows[where.id], workspace: { enableOrchestration: true } }
          : null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { rootSessionId?: string | null };
      }) => {
        rootWrites.push({ id: where.id, rootSessionId: data.rootSessionId ?? null });
        return {};
      },
      // Outstanding-work admission control has its own spec; keep every tree here admissible.
      count: async () => 0,
    },
    user: {
      findUnique: async () =>
        defaults?.accountEffort
          ? { preferences: { defaultEffort: defaults.accountEffort } }
          : null,
    },
    workspace: {
      findFirst: async () =>
        defaults && 'workspaceEffort' in defaults ? { effort: defaults.workspaceEffort } : null,
    },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);
  // Keep this test focused on the orchestration guard; create() has its own persistence path.
  (service as unknown as { create: SessionsService['create'] }).create = (async (
    _ownerId: string,
    dto: unknown,
    opts: { parentSessionId?: string; tree?: { rootSessionId: string; depth: number } },
  ) => {
    createdFrom.push(opts.parentSessionId ?? '');
    createdDtos.push(dto as { effort?: string });
    createdTrees.push(opts.tree);
    return { id: 'spawned', status: RunStatus.PENDING, title: 'spawned', workspaceId: null };
  }) as SessionsService['create'];
  return { service, createdFrom, createdDtos, createdTrees, rootWrites };
}

test('a root session may spawn a child at depth 1', async () => {
  const { service, createdFrom, createdTrees } = makeService({
    root: { rootSessionId: null, spawnDepth: 0 },
  });

  await service.spawnFromSession('owner', 'root', { prompt: 'work' });

  assert.deepEqual(createdFrom, ['root']);
  assert.deepEqual(createdTrees, [{ rootSessionId: 'root', depth: 1 }]);
});

// A session that has never spawned belongs to no tree, so nothing counts it against one.
// Its first spawn is what creates the tree, and it has to be in the tree it just created —
// otherwise the session doing the orchestrating is the one member the cap cannot see.
test('a root joins its own tree at its first spawn', async () => {
  const { service, rootWrites } = makeService({ root: { rootSessionId: null, spawnDepth: 0 } });

  await service.spawnFromSession('owner', 'root', { prompt: 'work' });

  assert.deepEqual(rootWrites, [{ id: 'root', rootSessionId: 'root' }]);
});

test('a dispatcher-created session may spawn a sub-session at depth 2', async () => {
  const { service, createdFrom, createdTrees, rootWrites } = makeService({
    root: { rootSessionId: 'root', spawnDepth: 0 },
    work: { rootSessionId: 'root', spawnDepth: 1 },
  });

  await service.spawnFromSession('owner', 'work', { prompt: 'read-only diagnosis' });

  assert.deepEqual(createdFrom, ['work']);
  // The whole tree keeps one id. Per-parent grouping would multiply the cap level by level.
  assert.deepEqual(createdTrees, [{ rootSessionId: 'root', depth: 2 }]);
  assert.deepEqual(rootWrites, [], 'already in a tree, so nothing to claim');
});

// Depth is a context-fidelity budget, not a resource one — every level re-encodes the
// original intent into a fresh self-contained brief, and the loss compounds. Resource
// containment is the outstanding cap and the tree concurrency cap, which is what lets this
// sit at 5 rather than 2 without letting a runaway orchestrator storm the queue.
test('a session at the depth limit cannot delegate further', async () => {
  const { service, createdFrom } = makeService({
    deep: { rootSessionId: 'root', spawnDepth: 5 },
  });

  await assert.rejects(
    () => service.spawnFromSession('owner', 'deep', { prompt: 'too deep' }),
    (error: unknown) =>
      error instanceof ForbiddenException && error.message === 'spawn depth limit (5) reached',
  );
  assert.deepEqual(createdFrom, []);
});

// The level that used to be refused. A dispatcher-created work session delegating one real
// sub-task is the ordinary shape, and depth 2 was the wall it kept hitting.
test('a tree may now decompose past the old two-level wall', async () => {
  const { service, createdTrees } = makeService({
    deeper: { rootSessionId: 'root', spawnDepth: 2 },
  });

  await service.spawnFromSession('owner', 'deeper', { prompt: 'sub-sub-task' });

  assert.deepEqual(createdTrees, [{ rootSessionId: 'root', depth: 3 }]);
});

test('an explicit empty workspace effort wins over the account default for a spawned session', async () => {
  const { service, createdDtos } = makeService(
    { root: { rootSessionId: null, spawnDepth: 0 } },
    { workspaceEffort: '', accountEffort: 'high' },
  );

  await service.spawnFromSession('owner', 'root', {
    prompt: 'work',
    workspaceId: 'workspace-1',
  });

  assert.equal(createdDtos[0].effort, '');
});
