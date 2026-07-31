import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

const now = new Date();

function makeService(overrides: Record<string, unknown> = {}) {
  const session = {
    id: 'session-1',
    status: RunStatus.FAILED,
    startedAt: now,
    numTurns: 0,
    runtimeSessionId: null,
    claudeSessionId: null,
    assignedRunnerId: 'runner-1',
    cancelRequestedAt: null,
    archivedAt: null,
    provider: 'codex',
    mergeStatus: null,
    commitStatus: null,
    ...overrides,
  };
  const updates: unknown[] = [];
  let notified = 0;
  const prisma = {
    session: {
      findFirst: async () => session,
      update: async (args: unknown) => {
        updates.push(args);
        return session;
      },
    },
    runner: {
      findUnique: async () => ({ status: 'ONLINE', lastHeartbeatAt: now }),
    },
    conversationTurn: {
      findUnique: async () => null,
      findFirst: async () => ({ seq: 1 }),
      create: async ({ data }: { data: { seq: number } }) => ({ id: 'retry-turn', ...data }),
    },
  } as never;
  const queue = {
    notifySessionQueued: () => {
      notified++;
    },
  } as never;
  const service = new SessionsService(prisma, queue, {} as never);
  return { service, updates, notified: () => notified };
}

const retry = { clientTurnId: 'retry-1', content: 'send after signing in' };

test('a claimed zero-turn Codex session can restart after sign-in without a runtime id', async () => {
  const { service, updates, notified } = makeService();

  const accepted = await service.resume('owner-1', 'session-1', retry);

  assert.equal(accepted.turnId, 'retry-turn');
  assert.equal(accepted.seq, 2);
  assert.equal(notified(), 1);
  assert.equal((updates[0] as { data: { status: RunStatus } }).data.status, RunStatus.PENDING);
});

test('a session that was never claimed still cannot restart', async () => {
  const { service } = makeService({ startedAt: null });

  await assert.rejects(
    () => service.resume('owner-1', 'session-1', retry),
    (error: unknown) =>
      error instanceof ConflictException && error.message === 'this session never ran and cannot be resumed',
  );
});

test('completed context without a runtime id still cannot restart', async () => {
  const { service } = makeService({ numTurns: 1 });

  await assert.rejects(
    () => service.resume('owner-1', 'session-1', retry),
    (error: unknown) =>
      error instanceof ConflictException && error.message === 'this session never ran and cannot be resumed',
  );
});
