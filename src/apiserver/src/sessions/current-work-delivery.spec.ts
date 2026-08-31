import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma, RunStatus } from '@prisma/client';
import {
  acknowledgedRuntimeTurnIds,
  CURRENT_WORK_INTERRUPTED,
  terminalizeUndeliveredCurrentWork,
  terminalizePendingCurrentWorkSteers,
  terminalizePendingStartupContexts,
} from './current-work-delivery';
import {
  currentWorkTerminalizationDouble,
  renderRawQuery,
} from '../test-support/prisma-transaction-double';
import { SessionsService } from './sessions.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';
const STEER_ID = '44444444-4444-4444-8444-444444444444';
const FRAGMENT_ID = '55555555-5555-4555-8555-555555555555';

test('the raw-query double renders a tagged-template call with its separate bindings', () => {
  const renderTag = (strings: TemplateStringsArray, ...values: unknown[]) =>
    renderRawQuery([strings, ...values]);

  const rendered = renderTag`SELECT ${SESSION_ID}::uuid, ${TARGET_ID}::uuid`;

  assert.deepEqual(rendered, {
    shape: 'tagged-template',
    text: 'SELECT ?::uuid, ?::uuid',
    values: [SESSION_ID, TARGET_ID],
  });
});

test('the raw-query double renders a composed Prisma.Sql object with embedded bindings', () => {
  const rendered = renderRawQuery([
    Prisma.sql`SELECT ${SESSION_ID}::uuid, ${TARGET_ID}::uuid`,
  ]);

  assert.deepEqual(rendered, {
    shape: 'prisma-sql',
    text: 'SELECT ?::uuid, ?::uuid',
    values: [SESSION_ID, TARGET_ID],
  });
});

test('zero CURRENT_WORK candidates perform both reads and no receipt writes', async () => {
  const double = currentWorkTerminalizationDouble();
  const tx = {
    conversationTurn: double.conversationTurn,
    conversationTurnStartupFragment: double.conversationTurnStartupFragment,
  } as unknown as Prisma.TransactionClient;

  const result = await terminalizeUndeliveredCurrentWork(tx, SESSION_ID, {
    code: CURRENT_WORK_INTERRUPTED,
    reason: 'interrupted before runtime acknowledgement',
  });

  assert.deepEqual(result, {
    steers: { terminalizedTurnIds: [], targetTurnIds: [] },
    startup: { terminalizedTurnIds: [], targetTurnIds: [] },
    targetTurnIds: [],
  });
  assert.equal(double.calls.steerFinds.length, 1);
  assert.equal(double.calls.startupFinds.length, 1);
  assert.deepEqual(double.calls.steerWrites, []);
  assert.deepEqual(double.calls.startupWrites, []);
});

test('steer and startup candidates receive their exact terminal receipts together', async () => {
  const reason = 'interrupted before runtime acknowledgement';
  const double = currentWorkTerminalizationDouble({
    steers: [{
      id: STEER_ID,
      targetTurnId: TARGET_ID,
      status: 'PENDING',
    }],
    startupFragments: [{
      id: FRAGMENT_ID,
      targetTurnId: TARGET_ID,
      deliveredAt: null,
      targetTurn: { status: 'PENDING' },
    }],
  });
  const tx = {
    conversationTurn: double.conversationTurn,
    conversationTurnStartupFragment: double.conversationTurnStartupFragment,
  } as unknown as Prisma.TransactionClient;

  const result = await terminalizeUndeliveredCurrentWork(tx, SESSION_ID, {
    code: CURRENT_WORK_INTERRUPTED,
    reason,
  });

  assert.deepEqual(result, {
    steers: { terminalizedTurnIds: [STEER_ID], targetTurnIds: [TARGET_ID] },
    startup: { terminalizedTurnIds: [FRAGMENT_ID], targetTurnIds: [TARGET_ID] },
    targetTurnIds: [TARGET_ID],
  });
  assert.equal(double.calls.steerWrites.length, 1);
  const steer = double.calls.steerWrites[0] as {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  };
  assert.deepEqual(steer.where, {
    sessionId: SESSION_ID,
    id: { in: [STEER_ID] },
    kind: 'steer',
    status: { in: ['PENDING'] },
    sendIntent: 'CURRENT_WORK',
    deliveryStatus: null,
  });
  assert.ok(steer.data.answeredAt instanceof Date);
  assert.equal(steer.data.answeredAt, steer.data.deliveryTerminalAt);
  assert.deepEqual(steer.data, {
    status: 'ANSWERED',
    answeredAt: steer.data.answeredAt,
    deliveryStatus: 'FAILED',
    deliveryFailureCode: CURRENT_WORK_INTERRUPTED,
    deliveryFailureReason: reason,
    deliveryTerminalAt: steer.data.answeredAt,
  });

  assert.equal(double.calls.startupWrites.length, 1);
  const startup = double.calls.startupWrites[0] as {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  };
  assert.deepEqual(startup.where, {
    sessionId: SESSION_ID,
    id: { in: [FRAGMENT_ID] },
    deliveryStatus: null,
  });
  assert.ok(startup.data.failedAt instanceof Date);
  assert.deepEqual(startup.data, {
    deliveryStatus: 'FAILED',
    failedAt: startup.data.failedAt,
    failureCode: CURRENT_WORK_INTERRUPTED,
    failureReason: reason,
  });
});

test('only engine-read acknowledged USER receipts enter the durable ACK ledger', () => {
  assert.deepEqual(acknowledgedRuntimeTurnIds([
    { type: 'user', turnId: 'enqueued', payload: { delivery: 'enqueued' } },
    { type: 'user_delivery', payload: { turnId: 'written', delivery: 'written' } },
    { type: 'user', turnId: 'user-ack', payload: { delivery: 'acknowledged' } },
    {
      type: 'user_delivery',
      turnId: 'wrong-attribution',
      payload: { turnId: 'delivery-ack', delivery: 'acknowledged' },
    },
    { type: 'assistant', turnId: 'not-user', payload: { delivery: 'acknowledged' } },
    { type: 'user_delivery', payload: { delivery: 'acknowledged' } },
  ]), ['user-ack', 'delivery-ack']);
});

test('pending and leased CURRENT_WORK steer terminalize in the authored receipt without run_event writes', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const tx = {
    conversationTurn: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        assert.deepEqual((where.status as { in: string[] }).in, ['PENDING', 'IN_FLIGHT']);
        assert.equal(where.deliveryStatus, null);
        return [{ id: STEER_ID, targetTurnId: TARGET_ID, status: 'PENDING' }];
      },
      updateMany: async (write: Record<string, unknown>) => {
        writes.push(write);
        return { count: 1 };
      },
    },
  } as unknown as Prisma.TransactionClient;

  const result = await terminalizePendingCurrentWorkSteers(tx, SESSION_ID, {
    targetTurnIds: [TARGET_ID],
    includeInFlight: true,
    code: 'CURRENT_WORK_TARGET_COMPLETED',
    reason: 'target completed before runtime acknowledgement',
  });

  assert.deepEqual(result, { terminalizedTurnIds: [STEER_ID], targetTurnIds: [TARGET_ID] });
  const data = writes[0].data as Record<string, unknown>;
  assert.equal(data.status, 'ANSWERED');
  assert.equal(data.deliveryStatus, 'FAILED');
  assert.equal(data.deliveryFailureCode, 'CURRENT_WORK_TARGET_COMPLETED');
  assert.equal(data.deliveryFailureReason, 'target completed before runtime acknowledgement');
  assert.ok(data.answeredAt instanceof Date);
  assert.ok(data.deliveryTerminalAt instanceof Date);
  assert.equal('deliveryAcknowledgedAt' in data, false);
  assert.equal('runEvent' in (tx as unknown as object), false);
});

test('undelivered startup context terminalizes in place with mutually-exclusive failure proof', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const tx = {
    conversationTurnStartupFragment: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        assert.equal(where.deliveryStatus, null);
        return [{
          id: FRAGMENT_ID,
          targetTurnId: TARGET_ID,
          deliveredAt: null,
          targetTurn: { status: 'PENDING' },
        }];
      },
      updateMany: async (write: Record<string, unknown>) => {
        writes.push(write);
        return { count: 1 };
      },
    },
  } as unknown as Prisma.TransactionClient;

  const result = await terminalizePendingStartupContexts(tx, SESSION_ID, {
    code: CURRENT_WORK_INTERRUPTED,
    reason: 'interrupted before runtime acknowledgement',
  });

  assert.deepEqual(result, { terminalizedTurnIds: [FRAGMENT_ID], targetTurnIds: [TARGET_ID] });
  const data = writes[0].data as Record<string, unknown>;
  assert.equal(data.deliveryStatus, 'FAILED');
  assert.ok(data.failedAt instanceof Date);
  assert.equal(data.failureCode, CURRENT_WORK_INTERRUPTED);
  assert.equal(data.failureReason, 'interrupted before runtime acknowledgement');
  assert.equal('acknowledgedAt' in data, false);
});

test('runner loss records leased CURRENT_WORK as UNCONFIRMED rather than a false non-delivery', async () => {
  const steerWrites: Array<Record<string, unknown>> = [];
  const startupWrites: Array<Record<string, unknown>> = [];
  const tx = {
    conversationTurn: {
      findMany: async () => [{ id: STEER_ID, targetTurnId: TARGET_ID, status: 'IN_FLIGHT' }],
      updateMany: async (write: Record<string, unknown>) => {
        steerWrites.push(write);
        return { count: 1 };
      },
    },
    conversationTurnStartupFragment: {
      findMany: async () => [{
        id: FRAGMENT_ID,
        targetTurnId: TARGET_ID,
        deliveredAt: new Date(),
        targetTurn: { status: 'IN_FLIGHT' },
      }],
      updateMany: async (write: Record<string, unknown>) => {
        startupWrites.push(write);
        return { count: 1 };
      },
    },
  } as unknown as Prisma.TransactionClient;

  const options = {
    includeInFlight: true,
    inFlightOutcome: 'UNCONFIRMED' as const,
    code: 'CURRENT_WORK_SESSION_REAPED',
    reason: 'Delivery could not be confirmed after runner loss.',
  };
  await terminalizePendingCurrentWorkSteers(tx, SESSION_ID, options);
  await terminalizePendingStartupContexts(tx, SESSION_ID, options);

  assert.equal((steerWrites[0].data as Record<string, unknown>).deliveryStatus, 'UNCONFIRMED');
  assert.equal((startupWrites[0].data as Record<string, unknown>).deliveryStatus, 'UNCONFIRMED');
  assert.match(
    String((steerWrites[0].data as Record<string, unknown>).deliveryFailureReason),
    /could not be confirmed/,
  );
});

test('interrupt terminalizes only pending CURRENT_WORK receipts and never allocates runner event seq', async () => {
  const turnWrites: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const deletes: Record<string, unknown>[] = [];
  const session = {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    status: RunStatus.RUNNING,
    cancelRequestedAt: null,
    deletedAt: null,
    numTurns: 1,
  };
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => session,
      update: async () => session,
    },
    conversationTurn: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.kind === 'steer') {
          assert.deepEqual((where.status as { in: string[] }).in, ['PENDING']);
          return [{ id: STEER_ID, targetTurnId: TARGET_ID }];
        }
        return [];
      },
      findUnique: async () => null,
      findFirst: async () => ({ seq: 2 }),
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'interrupt-turn', seq: 3, ...data,
      }),
      updateMany: async (write: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        turnWrites.push(write);
        return { count: 1 };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        deletes.push(where);
        return { count: 1 };
      },
      count: async () => 1,
    },
    conversationTurnStartupFragment: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    attachment: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
  };
  const prisma = {
    session: { findFirst: async () => session },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const service = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as never,
    {
      notifyInbox: () => undefined,
      publishQueuedTurnsChanged: () => undefined,
      publish: () => undefined,
    } as never,
  );

  await service.interrupt(OWNER_ID, SESSION_ID);

  const receiptWrite = turnWrites.find((write) =>
    (write.where.id as { in?: string[] } | undefined)?.in?.includes(STEER_ID));
  assert.equal(receiptWrite?.data.status, 'ANSWERED');
  assert.equal(receiptWrite?.data.deliveryStatus, 'FAILED');
  assert.equal(receiptWrite?.data.deliveryFailureCode, CURRENT_WORK_INTERRUPTED);
  assert.equal('runEvent' in tx, false);
  assert.equal((deletes[0].status as string), 'PENDING');
  assert.equal(
    (deletes[0].id as { notIn?: string[] }).notIn?.includes(TARGET_ID),
    true,
    'interrupt tried to delete the target protected by durable CURRENT_WORK audit rows',
  );
});
