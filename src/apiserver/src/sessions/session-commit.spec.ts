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
      runningBgShells?: { isEmpty: boolean };
    };
    data: { commitStatus: string };
  };
  assert.equal(update.where.status, RunStatus.AWAITING_INPUT);
  assert.equal(update.where.cancelRequestedAt, null);
  assert.deepEqual(update.where.runningSubagents, { isEmpty: true });
  // Background shells are not part of the compare-and-set: a left-up dev server never exits, so
  // requiring an empty set here would make the commit unqueueable for the session's whole life.
  assert.equal(update.where.runningBgShells, undefined);
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

test('commit rejects an AWAITING_INPUT session with a running sub-workspace', async () => {
  const { service, updates } = makeService({ runningSubagents: ['workspace-call-1'] });

  await assert.rejects(
    () => service.commitWorktree('owner-1', 'session-1'),
    (error: unknown) =>
      error instanceof ConflictException &&
      error.message === 'wait for the running sub-workspace to finish before committing',
  );
  assert.deepEqual(updates, []);
});

test('commit is allowed while a background shell is still up', async () => {
  // A dev server or watcher the workspace left running never sends a terminal notification, so its
  // launch id stays in runningBgShells forever. Blocking on it made Commit permanently dead.
  const { service, updates } = makeService({ runningBgShells: ['shell-call-1'] });

  await assert.doesNotReject(() => service.commitWorktree('owner-1', 'session-1'));
  assert.equal(updates.length, 1);
});

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

/**
 * The recovery path for work a finished session left behind. This endpoint used to refuse every
 * ended session with "its work is already committed" — the runner's intention stated as a fact —
 * so the sessions that needed it most, the ones whose finalize commit was refused and whose branch
 * therefore has nothing on it, were the ones it turned away. `worktreeDirty` is the observation
 * that separates the two, and it is the whole precondition: nothing runs in an ended session's
 * checkout, so there is no turn or sub-workspace left for the idle gate to protect.
 */
test('an ended session whose checkout still holds work may commit it', async () => {
  const { service, updates } = makeService({
    status: RunStatus.SUCCEEDED,
    cancelRequestedAt: new Date(),
    worktreeDirty: true,
  });

  await assert.doesNotReject(() => service.commitWorktree('owner-1', 'session-1'));

  assert.equal(updates.length, 1);
  const update = updates[0] as {
    where: { status: { notIn: RunStatus[] }; worktreeDirty: boolean };
    data: { commitStatus: string };
  };
  // Still ended and still holding work is the compare-and-set: the race an ended session has is
  // being RESUMED, which would put a turn back in the checkout.
  assert.ok(update.where.status.notIn.includes(RunStatus.AWAITING_INPUT));
  assert.equal(update.where.worktreeDirty, true);
  assert.equal(update.data.commitStatus, 'pending');
});

test('an ended session that really did commit its work is refused as before', async () => {
  const { service, updates } = makeService({
    status: RunStatus.SUCCEEDED,
    worktreeDirty: false,
  });

  await assert.rejects(
    () => service.commitWorktree('owner-1', 'session-1'),
    (error: unknown) =>
      error instanceof ConflictException &&
      error.message === 'the session has ended — its work is already committed',
  );
  assert.deepEqual(updates, []);
});

test('an ended session on a runner too old to report dirtiness is refused', async () => {
  // Absent is not "clean", but it is not evidence of stranded work either, and queueing a commit
  // against a checkout that may already be gone is the thing the old guard was right about.
  const { service, updates } = makeService({ status: RunStatus.FAILED, worktreeDirty: null });

  await assert.rejects(
    () => service.commitWorktree('owner-1', 'session-1'),
    (error: unknown) => error instanceof ConflictException,
  );
  assert.deepEqual(updates, []);
});

test('an ended session resumed under a lost compare-and-set is rejected', async () => {
  const { service } = makeService(
    { status: RunStatus.SUCCEEDED, worktreeDirty: true },
    0,
    { status: RunStatus.RUNNING, commitStatus: 'pending' },
  );

  await assert.rejects(
    () => service.commitWorktree('owner-1', 'session-1'),
    (error: unknown) =>
      error instanceof ConflictException &&
      error.message === 'the session is no longer idle — wait for its current work to finish',
  );
});
