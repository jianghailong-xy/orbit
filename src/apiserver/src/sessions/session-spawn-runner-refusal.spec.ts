import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpException, HttpStatus } from '@nestjs/common';
import { RunStatus } from '@orbit/shared';
import { SessionsService } from './sessions.service';

const MB = 1024n * 1024n;

/** The runner a spawn would land on, as spawnFromSession reads it. */
interface Target {
  status?: string;
  lastHeartbeatAt?: Date | null;
  minFreeDiskMb?: number | null;
  workDirFreeBytes?: bigint | null;
}

/**
 * A parent on `workspace-1`, and the workspace a spawn targets answering with `target`. Which workspace the
 * spawn read is recorded, so a test can tell the parent's own from a named one.
 */
function makeService(target: Target | null) {
  const created: string[] = [];
  const asked: string[] = [];
  const prisma = {
    session: {
      findFirst: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        rootSessionId: 'root',
        spawnDepth: 0,
        workspaceId: 'workspace-1',
        owner: { preferences: {} },
      }),
      update: async () => ({}),
      findMany: async () => [],
      count: async () => 0,
    },
    user: { findUnique: async () => null },
    workspace: {
      findFirst: async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
        if (select?.runnerId) return { runnerId: 'runner-1' };
        if (!select?.runner) return null;
        asked.push(where.id);
        if (!target) return null;
        return {
          workDirFreeBytes: target.workDirFreeBytes ?? null,
          runner: {
            id: 'runner-1',
            name: 'wikova',
            displayName: null,
            status: target.status ?? 'ONLINE',
            minFreeDiskMb: target.minFreeDiskMb === undefined ? 10240 : target.minFreeDiskMb,
            lastHeartbeatAt: target.lastHeartbeatAt === undefined ? new Date() : target.lastHeartbeatAt,
            presence: null,
          },
        };
      },
    },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);
  const internals = service as unknown as Record<string, unknown>;
  internals.wakeManagedRunner = async () => ({ managed: false });
  internals.create = async () => {
    created.push('spawned');
    return { id: 'spawned', status: RunStatus.PENDING, title: 'spawned', workspaceId: null };
  };
  return { service, created, asked };
}

function refusedWith(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof HttpException);
    assert.equal(error.getStatus(), HttpStatus.CONFLICT);
    const body = error.getResponse() as { code: string; message: string };
    assert.equal(body.code, code);
    assert.match(body.message, /runner "wikova"/);
    assert.match(body.message, /nothing was created/);
    return true;
  };
}

test('a spawn onto an offline runner is refused with the reason, and nothing is created', async () => {
  const { service, created } = makeService({ lastHeartbeatAt: new Date(Date.now() - 60 * 60_000) });
  await assert.rejects(
    () => service.spawnFromSession('owner', 'parent', { prompt: 'work', workspaceId: 'workspace-2' }),
    refusedWith('SESSION_RUNNER_OFFLINE'),
  );
  assert.deepEqual(created, []);
});

test('a runner that signed off is offline whatever its last beat', async () => {
  const { service, created } = makeService({ status: 'OFFLINE' });
  await assert.rejects(
    () => service.spawnFromSession('owner', 'parent', { prompt: 'work', workspaceId: 'workspace-2' }),
    refusedWith('SESSION_RUNNER_OFFLINE'),
  );
  assert.deepEqual(created, []);
});

test('a spawn onto a runner below its Keep Free is refused with the reason, and nothing is created', async () => {
  const { service, created } = makeService({ minFreeDiskMb: 10240, workDirFreeBytes: 512n * MB });
  await assert.rejects(
    () => service.spawnFromSession('owner', 'parent', { prompt: 'work', workspaceId: 'workspace-2' }),
    refusedWith('RUNNER_DISK_BELOW_FLOOR'),
  );
  assert.deepEqual(created, []);
});

test('an online runner above its Keep Free takes the spawn', async () => {
  const { service, created } = makeService({ minFreeDiskMb: 10240, workDirFreeBytes: 20480n * MB });
  await service.spawnFromSession('owner', 'parent', { prompt: 'work', workspaceId: 'workspace-2' });
  assert.deepEqual(created, ['spawned']);
});

test('no disk reading, or no Keep Free, holds nothing, as the claim gate', async () => {
  for (const target of [{ workDirFreeBytes: null }, { minFreeDiskMb: 0, workDirFreeBytes: 1n }, { minFreeDiskMb: null, workDirFreeBytes: 1n }]) {
    const { service, created } = makeService(target);
    await service.spawnFromSession('owner', 'parent', { prompt: 'work', workspaceId: 'workspace-2' });
    assert.deepEqual(created, ['spawned'], JSON.stringify(target, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
  }
});

test('a spawn that names no workspace is judged on the parent\'s own', async () => {
  const { service, created, asked } = makeService({ minFreeDiskMb: 10240, workDirFreeBytes: 1n });
  await assert.rejects(() => service.spawnFromSession('owner', 'parent', { prompt: 'work' }), refusedWith('RUNNER_DISK_BELOW_FLOOR'));
  assert.deepEqual(asked, ['workspace-1']);
  assert.deepEqual(created, []);
});

test('a workspace that is not found is left to create(), which says so', async () => {
  const { service, created } = makeService(null);
  await service.spawnFromSession('owner', 'parent', { prompt: 'work', workspaceId: 'workspace-2' });
  assert.deepEqual(created, ['spawned']);
});
