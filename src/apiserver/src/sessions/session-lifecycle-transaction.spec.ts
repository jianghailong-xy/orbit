import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SessionEndReason, SessionLifecycleState } from '@orbit/shared';
import { SessionsService } from './sessions.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const RUNNER_ID = '33333333-3333-4333-8333-333333333333';

test('complete atomically persists live end intent and completedAt before side effects', async () => {
  let committed = false;
  let updateData: Record<string, unknown> | undefined;
  let publishedLifecycleState: SessionLifecycleState | undefined;
  const effects: string[] = [];
  const session = {
    id: SESSION_ID,
    status: RunStatus.AWAITING_INPUT,
    cancelRequestedAt: null,
    assignedRunnerId: RUNNER_ID,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
  };
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => session,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updateData = data;
        return { ...session, ...data };
      },
    },
    conversationTurn: {
      deleteMany: async () => ({ count: 1 }),
      findUnique: async () => null,
      findFirst: async () => ({ seq: 2 }),
      create: async ({ data }: { data: Record<string, unknown> }) => data,
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => {
      const result = await fn(tx);
      committed = true;
      return result;
    },
  } as never;
  const realtime = {
    requestCancel: () => {
      assert.equal(committed, true);
      effects.push('cancel');
    },
    notifyInbox: () => {
      assert.equal(committed, true);
      effects.push('inbox');
    },
    publishSessionLifecycleChanged: (
      _id: string,
      _status: RunStatus,
      _reason: SessionEndReason,
      lifecycleState: SessionLifecycleState,
    ) => {
      assert.equal(committed, true);
      publishedLifecycleState = lifecycleState;
      effects.push('ended');
    },
  } as never;
  const service = new SessionsService(prisma, {} as never, realtime);

  assert.deepEqual(await service.complete(OWNER_ID, SESSION_ID), { ok: true });
  assert.ok(updateData?.completedAt instanceof Date);
  // The old field remains a rolling-deploy compatibility mirror.
  assert.ok(updateData?.archivedAt instanceof Date);
  assert.ok(updateData?.cancelRequestedAt instanceof Date);
  assert.equal(updateData?.endReason, SessionEndReason.COMPLETED);
  assert.equal(publishedLifecycleState, SessionLifecycleState.COMPLETED);
  assert.deepEqual(effects, ['cancel', 'inbox', 'ended']);
});

test('remove atomically finalizes PENDING and stamps deletedAt', async () => {
  let updateData: Record<string, unknown> | undefined;
  let drained = 0;
  let publishedStatus: RunStatus | undefined;
  let publishedLifecycleState: SessionLifecycleState | undefined;
  const session = {
    id: SESSION_ID,
    status: RunStatus.PENDING,
    cancelRequestedAt: null,
    assignedRunnerId: RUNNER_ID,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
  };
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => session,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updateData = data;
        return { ...session, ...data };
      },
    },
    conversationTurn: {
      updateMany: async () => {
        drained++;
        return { count: 1 };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const realtime = {
    requestCancel: () => undefined,
    notifyInbox: () => undefined,
    publishSessionLifecycleChanged: (
      _id: string,
      status: RunStatus,
      _reason: SessionEndReason,
      lifecycleState: SessionLifecycleState,
    ) => {
      publishedStatus = status;
      publishedLifecycleState = lifecycleState;
    },
  } as never;
  const service = new SessionsService(prisma, {} as never, realtime);

  assert.deepEqual(await service.remove(OWNER_ID, SESSION_ID), { ok: true });
  assert.equal(updateData?.status, RunStatus.CANCELLED);
  assert.equal(updateData?.endReason, SessionEndReason.DELETED);
  assert.ok(updateData?.deletedAt instanceof Date);
  assert.equal(drained, 1);
  assert.equal(publishedStatus, RunStatus.CANCELLED);
  assert.equal(publishedLifecycleState, SessionLifecycleState.TRASH);
});

test('completing a dormant terminal session publishes its actual end reason', async () => {
  let published:
    | { reason: SessionEndReason | null; lifecycleState: SessionLifecycleState }
    | undefined;
  const session = {
    id: SESSION_ID,
    status: RunStatus.CANCELLED,
    endReason: SessionEndReason.ENDED,
    cancelRequestedAt: new Date('2026-08-01T00:00:00.000Z'),
    assignedRunnerId: RUNNER_ID,
    completedAt: null as Date | null,
    archivedAt: null,
    deletedAt: null,
  };
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => session,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(session, data);
        return session;
      },
    },
  };
  const prisma = { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) } as never;
  const realtime = {
    publishSessionLifecycleChanged: (
      _id: string,
      _status: RunStatus,
      reason: SessionEndReason | null,
      lifecycleState: SessionLifecycleState,
    ) => {
      published = { reason, lifecycleState };
    },
  } as never;
  const service = new SessionsService(prisma, {} as never, realtime);

  await service.complete(OWNER_ID, SESSION_ID);

  assert.deepEqual(published, {
    reason: SessionEndReason.ENDED,
    lifecycleState: SessionLifecycleState.COMPLETED,
  });
});

test('complete rejects Trash under the Session row lock without side effects', async () => {
  let updates = 0;
  let effects = 0;
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => ({
        id: SESSION_ID,
        status: RunStatus.CANCELLED,
        endReason: SessionEndReason.DELETED,
        cancelRequestedAt: new Date(),
        assignedRunnerId: RUNNER_ID,
        completedAt: null,
        archivedAt: null,
        deletedAt: new Date(),
      }),
      update: async () => {
        updates++;
      },
    },
  };
  const prisma = { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) } as never;
  const realtime = {
    requestCancel: () => effects++,
    notifyInbox: () => effects++,
    publishSessionLifecycleChanged: () => effects++,
  } as never;
  const service = new SessionsService(prisma, {} as never, realtime);

  await assert.rejects(
    service.complete(OWNER_ID, SESSION_ID),
    (error: unknown) => error instanceof ConflictException,
  );
  assert.equal(updates, 0);
  assert.equal(effects, 0);
});

test('when remove wins the lifecycle lock, a racing complete cannot overwrite Trash', async () => {
  const session = {
    id: SESSION_ID,
    status: RunStatus.CANCELLED,
    endReason: SessionEndReason.ENDED,
    cancelRequestedAt: new Date(),
    assignedRunnerId: RUNNER_ID,
    completedAt: null as Date | null,
    archivedAt: null as Date | null,
    deletedAt: null as Date | null,
  };
  const lifecycleChanges: SessionLifecycleState[] = [];
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => ({ ...session }),
      update: async ({ data }: { data: { completedAt?: Date; archivedAt?: Date; deletedAt?: Date } }) => {
        if (data.completedAt) session.completedAt = data.completedAt;
        if (data.archivedAt) session.archivedAt = data.archivedAt;
        if (data.deletedAt) session.deletedAt = data.deletedAt;
        return { ...session };
      },
    },
  };
  let tail: Promise<void> = Promise.resolve();
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn(tx);
      } finally {
        release();
      }
    },
  } as never;
  const realtime = {
    publishSessionLifecycleChanged: (
      _id: string,
      _status: RunStatus,
      _reason: SessionEndReason | null,
      lifecycleState: SessionLifecycleState,
    ) => lifecycleChanges.push(lifecycleState),
  } as never;
  const service = new SessionsService(prisma, {} as never, realtime);

  const [removed, completed] = await Promise.allSettled([
    service.remove(OWNER_ID, SESSION_ID),
    service.complete(OWNER_ID, SESSION_ID),
  ]);

  assert.equal(removed.status, 'fulfilled');
  assert.equal(completed.status, 'rejected');
  assert.ok(session.deletedAt);
  assert.equal(session.archivedAt, null);
  assert.deepEqual(lifecycleChanges, [SessionLifecycleState.TRASH]);
});

test('complete emits no side effects when the atomic end transaction fails', async () => {
  let effects = 0;
  const session = {
    id: SESSION_ID,
    status: RunStatus.AWAITING_INPUT,
    cancelRequestedAt: null,
    assignedRunnerId: RUNNER_ID,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
  };
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => session,
      update: async () => session,
    },
    conversationTurn: {
      deleteMany: async () => ({ count: 0 }),
      findUnique: async () => null,
      findFirst: async () => ({ seq: 1 }),
      create: async () => {
        throw new Error('turn insert failed');
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const realtime = {
    requestCancel: () => effects++,
    notifyInbox: () => effects++,
    publishSessionLifecycleChanged: () => effects++,
  } as never;
  const service = new SessionsService(prisma, {} as never, realtime);

  await assert.rejects(service.complete(OWNER_ID, SESSION_ID), /turn insert failed/);
  assert.equal(effects, 0);
});

test('repeated remove keeps the original Trash retention timestamp', async () => {
  const original = new Date('2026-08-01T00:00:00.000Z');
  let updates = 0;
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => ({
        id: SESSION_ID,
        status: RunStatus.CANCELLED,
        cancelRequestedAt: original,
        assignedRunnerId: RUNNER_ID,
        completedAt: null,
        archivedAt: null,
        deletedAt: original,
      }),
      update: async () => {
        updates++;
      },
    },
  };
  const prisma = { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) } as never;
  const realtime = {
    publishSessionLifecycleChanged: () => undefined,
  } as never;
  const service = new SessionsService(prisma, {} as never, realtime);

  assert.deepEqual(await service.remove(OWNER_ID, SESSION_ID), { ok: true });
  assert.equal(updates, 0);
});
