import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

type SessionRow = { parentSessionId: string | null };

function makeService(rows: Record<string, SessionRow>) {
  const createdFrom: string[] = [];
  const prisma = {
    session: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        rows[where.id]
          ? { id: where.id, batchId: null, agent: { enableOrchestration: true } }
          : null,
      findUnique: async ({ where }: { where: { id: string } }) => rows[where.id] ?? null,
    },
    user: { findUnique: async () => null },
    agent: { findFirst: async () => null },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);
  // Keep this test focused on the orchestration guard; create() has its own persistence path.
  (service as unknown as { create: SessionsService['create'] }).create = (async (
    _ownerId: string,
    _dto: unknown,
    opts: { parentSessionId?: string },
  ) => {
    createdFrom.push(opts.parentSessionId ?? '');
    return { id: 'spawned', status: RunStatus.PENDING, title: 'spawned', agentId: null };
  }) as SessionsService['create'];
  return { service, createdFrom };
}

test('a root session may spawn a child at depth 1', async () => {
  const { service, createdFrom } = makeService({ root: { parentSessionId: null } });

  await service.spawnFromSession('owner', 'root', { prompt: 'work' });

  assert.deepEqual(createdFrom, ['root']);
});

test('a dispatcher-created session may spawn a sub-session at depth 2', async () => {
  const { service, createdFrom } = makeService({
    root: { parentSessionId: null },
    work: { parentSessionId: 'root' },
  });

  await service.spawnFromSession('owner', 'work', { prompt: 'read-only diagnosis' });

  assert.deepEqual(createdFrom, ['work']);
});

test('a session already at depth 2 cannot recurse further', async () => {
  const { service, createdFrom } = makeService({
    root: { parentSessionId: null },
    work: { parentSessionId: 'root' },
    diagnosis: { parentSessionId: 'work' },
  });

  await assert.rejects(
    () => service.spawnFromSession('owner', 'diagnosis', { prompt: 'too deep' }),
    (error: unknown) =>
      error instanceof ForbiddenException && error.message === 'spawn depth limit (2) reached',
  );
  assert.deepEqual(createdFrom, []);
});
