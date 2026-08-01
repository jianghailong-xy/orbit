import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

function makeService(
  overrides: Record<string, unknown> = {},
  updateCount = 1,
  rereadOverrides?: Record<string, unknown>,
) {
  const session = {
    id: 'session-1',
    ownerId: 'owner-1',
    status: RunStatus.AWAITING_INPUT,
    cancelRequestedAt: null,
    isolationStatus: 'worktree',
    branch: 'orbit/work',
    assignedRunnerId: 'runner-1',
    commitStatus: null,
    runningSubagents: [],
    runningBgShells: [],
    ...overrides,
  };
  const updates: unknown[] = [];
  let reads = 0;
  const prisma = {
    session: {
      findFirst: async () => {
        reads++;
        return reads > 1 && rereadOverrides ? { ...session, ...rereadOverrides } : session;
      },
      updateMany: async (args: unknown) => {
        updates.push(args);
        return { count: updateCount };
      },
    },
  } as never;
  return {
    service: new SessionsService(prisma, {} as never, {} as never),
    updates,
  };
}

test('commit queues atomically only while a session is truly idle', async () => {
  const { service, updates } = makeService();

  await assert.doesNotReject(() => service.commitWorktree('owner-1', 'session-1'));

  assert.equal(updates.length, 1);
  const update = updates[0] as {
    where: {
      status: RunStatus;
      cancelRequestedAt: null;
      runningSubagents: { isEmpty: boolean };
      runningBgShells: { isEmpty: boolean };
    };
    data: { commitStatus: string };
  };
  assert.equal(update.where.status, RunStatus.AWAITING_INPUT);
  assert.equal(update.where.cancelRequestedAt, null);
  assert.deepEqual(update.where.runningSubagents, { isEmpty: true });
  assert.deepEqual(update.where.runningBgShells, { isEmpty: true });
  assert.equal(update.data.commitStatus, 'pending');
});

test('commit rejects a RUNNING turn before touching commit state', async () => {
  const { service, updates } = makeService({ status: RunStatus.RUNNING });

  await assert.rejects(
    () => service.commitWorktree('owner-1', 'session-1'),
    (error: unknown) =>
      error instanceof ConflictException &&
      error.message === 'wait for the current turn to finish before committing',
  );
  assert.deepEqual(updates, []);
});

test('commit rejects an interrupted session that is not at a settled turn boundary', async () => {
  const { service, updates } = makeService({ status: RunStatus.INTERRUPTED });

  await assert.rejects(
    () => service.commitWorktree('owner-1', 'session-1'),
    (error: unknown) => error instanceof ConflictException,
  );
  assert.deepEqual(updates, []);
});

for (const [name, activity] of [
  ['sub-agent', { runningSubagents: ['agent-call-1'] }],
  ['background shell', { runningBgShells: ['shell-call-1'] }],
] as const) {
  test(`commit rejects an AWAITING_INPUT session with a running ${name}`, async () => {
    const { service, updates } = makeService(activity);

    await assert.rejects(
      () => service.commitWorktree('owner-1', 'session-1'),
      (error: unknown) =>
        error instanceof ConflictException &&
        error.message === 'wait for background work to finish before committing',
    );
    assert.deepEqual(updates, []);
  });
}

test('a lost idle-state compare-and-set is rejected', async () => {
  const { service } = makeService({}, 0);

  await assert.rejects(
    () => service.commitWorktree('owner-1', 'session-1'),
    (error: unknown) =>
      error instanceof ConflictException &&
      error.message === 'the session is no longer idle — wait for its current work to finish',
  );
});

test('a concurrent identical commit request remains idempotent', async () => {
  const { service, updates } = makeService({}, 0, { commitStatus: 'pending' });

  await assert.doesNotReject(() => service.commitWorktree('owner-1', 'session-1'));
  assert.equal(updates.length, 1);
});

test('a pending commit does not hide a turn that started after the compare-and-set lost', async () => {
  const { service } = makeService({}, 0, {
    commitStatus: 'pending',
    status: RunStatus.RUNNING,
  });

  await assert.rejects(
    () => service.commitWorktree('owner-1', 'session-1'),
    (error: unknown) =>
      error instanceof ConflictException &&
      error.message === 'the session is no longer idle — wait for its current work to finish',
  );
});
