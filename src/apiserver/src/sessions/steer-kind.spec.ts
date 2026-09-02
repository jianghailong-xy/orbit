import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma, RunStatus } from '@prisma/client';
import { SESSION_CURRENT_WORK_ROUTING_V1 } from '@orbit/shared';
import { SessionsService } from './sessions.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const RUNNER_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '44444444-4444-4444-8444-444444444444';
const TARGET_ID = '55555555-5555-4555-8555-555555555555';

interface HarnessOptions {
  status?: RunStatus;
  numTurns?: number;
  liveLeaseChecks?: boolean[];
  expiredLease?: boolean;
  provider?: string;
  capabilities?: string[];
  earlierExecutable?: boolean;
  existingTurn?: Record<string, unknown> | null;
  startingTurn?: Record<string, unknown> | null;
}

function harness(options: HarnessOptions = {}) {
  const created: Record<string, unknown>[] = [];
  const queueChanges: string[] = [];
  const liveLeaseChecks = [...(options.liveLeaseChecks ?? [true, true, true])];
  let rawCall = 0;
  const session = {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    provider: options.provider ?? 'claude',
    providerBuiltin: true,
    assignedRunnerId: RUNNER_ID,
    status: options.status ?? RunStatus.RUNNING,
    cancelRequestedAt: null,
    deletedAt: null,
    prompt: 'opening prompt',
    numTurns: options.numTurns ?? 1,
    mergeStatus: null,
    mergeOperationId: null,
    mergeOperationOwner: null,
    mergeRequestedAt: null,
    commitStatus: null,
    commitOperationId: null,
    commitOperationOwner: null,
    commitRequestedAt: null,
  };
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) return [{ id: SESSION_ID }];
      return (liveLeaseChecks.shift() ?? false) ? [{ id: TARGET_ID }] : [];
    },
    session: {
      findUniqueOrThrow: async () => ({ ...session }),
      update: async () => ({ ...session }),
    },
    conversationTurn: {
      findUnique: async ({ where }: { where: { sessionId_clientTurnId?: { clientTurnId: string } } }) => {
        const key = where.sessionId_clientTurnId?.clientTurnId;
        if (key === CLIENT_ID) return options.existingTurn ?? null;
        if (key === SessionsService.initialTurnClientId(SESSION_ID)) {
          return options.startingTurn ?? null;
        }
        return null;
      },
      findFirst: async () => ({ seq: 1 }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'turn-new', seq: 2, ...data };
      },
      count: async ({ where }: { where: { kind?: unknown } }) =>
        typeof where.kind === 'string'
          ? (options.expiredLease ? 1 : 0)
          : (options.earlierExecutable === false ? 0 : 1),
    },
    attachment: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    modelProvider: { findFirst: async () => null },
    runner: {
      findUnique: async () => ({
        capabilities: options.capabilities ?? [SESSION_CURRENT_WORK_ROUTING_V1],
      }),
    },
  };
  const prisma = {
    session: { findFirst: async () => ({ ...session }), findUnique: async () => ({ ...session }) },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const service = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as never,
    {
      notifyInbox: () => undefined,
      publishQueuedTurnsChanged: (id: string) => queueChanges.push(id),
    } as never,
  );
  return { service, created, queueChanges };
}

const send = (
  h: ReturnType<typeof harness>,
  intent?: 'CURRENT_WORK' | 'NEXT_TURN',
  clientTurnId = CLIENT_ID,
  participateSendTransaction?: (tx: Prisma.TransactionClient) => Promise<void>,
) => h.service.createTurn(OWNER_ID, SESSION_ID, {
  clientTurnId,
  content: 'actually, call it gadget',
  ...(intent ? { intent } : {}),
}, { participateSendTransaction });

test('legacy omission retains N-1 auto-routing and its nullable protocol row', async () => {
  const h = harness();
  const result = await send(h);
  assert.equal(result.kind, 'steer');
  assert.equal(result.placement, 'steer');
  assert.equal(h.created[0].sendIntent, undefined);
  assert.equal(h.created[0].targetTurnId, undefined);
});

test('explicit NEXT_TURN is accepted when it is the first executable', async () => {
  const h = harness({ status: RunStatus.AWAITING_INPUT, earlierExecutable: false });
  const result = await send(h, 'NEXT_TURN');
  assert.equal(result.placement, 'accepted');
  assert.equal(h.created[0].kind, 'message');
});

test('CURRENT_WORK with a live lease creates an exact-target steer', async () => {
  const h = harness();
  let charged = 0;
  const result = await send(h, 'CURRENT_WORK', CLIENT_ID, async () => { charged += 1; });
  assert.equal(result.kind, 'steer');
  assert.equal(result.placement, 'steer');
  assert.equal(result.targetTurnId, TARGET_ID);
  assert.equal(h.created[0].sendIntent, 'CURRENT_WORK');
  assert.equal(h.created[0].targetTurnId, TARGET_ID);
  assert.equal(charged, 1);
});

test('CURRENT_WORK rejects when there is no live target and never becomes a message', async () => {
  const h = harness({ liveLeaseChecks: [false] });
  await assert.rejects(send(h, 'CURRENT_WORK'), (error: unknown) =>
    (error as { response?: { reason?: string } }).response?.reason === 'NO_CURRENT_WORK');
  assert.equal(h.created.length, 0);
});

test('CURRENT_WORK reports an expired lease instead of silently queueing', async () => {
  const h = harness({ liveLeaseChecks: [false], expiredLease: true });
  await assert.rejects(send(h, 'CURRENT_WORK'), (error: unknown) =>
    (error as { response?: { reason?: string } }).response?.reason === 'TARGET_LEASE_EXPIRED');
  assert.equal(h.created.length, 0);
});

test('unsupported runtime rejects CURRENT_WORK and does not charge or queue', async () => {
  const h = harness({ provider: 'opencode' });
  let charged = 0;
  await assert.rejects(
    send(h, 'CURRENT_WORK', CLIENT_ID, async () => { charged += 1; }),
    (error: unknown) =>
      (error as { response?: { reason?: string } }).response?.reason === 'STEER_UNSUPPORTED',
  );
  assert.equal(charged, 0);
  assert.equal(h.created.length, 0);
});

test('lease is atomically rechecked after capability resolution', async () => {
  const h = harness({ liveLeaseChecks: [true, false] });
  let charged = 0;
  await assert.rejects(
    send(h, 'CURRENT_WORK', CLIENT_ID, async () => { charged += 1; }),
    (error: unknown) =>
      (error as { response?: { reason?: string } }).response?.reason === 'TARGET_LEASE_EXPIRED',
  );
  assert.equal(charged, 0);
  assert.equal(h.created.length, 0);
});

test('a lease expiring during the atomic charge rolls back before the receipt insert', async () => {
  const h = harness({ liveLeaseChecks: [true, true, false] });
  let chargeAttempted = 0;
  await assert.rejects(
    send(h, 'CURRENT_WORK', CLIENT_ID, async () => { chargeAttempted += 1; }),
    (error: unknown) =>
      (error as { response?: { reason?: string } }).response?.reason === 'TARGET_LEASE_EXPIRED',
  );
  assert.equal(chargeAttempted, 1, 'the final assertion is after the transactional charge');
  assert.equal(h.created.length, 0, 'no durable CURRENT_WORK receipt was inserted');
});

test('clientTurnId intent matching is bidirectional while legacy null remains NEXT compatible', async () => {
  const current = harness({ existingTurn: {
    id: 'existing', seq: 2, kind: 'steer', status: 'PENDING', sendIntent: 'CURRENT_WORK',
    targetTurnId: TARGET_ID, content: 'actually, call it gadget', attachments: [],
  } });
  await assert.rejects(send(current, 'NEXT_TURN'), /already used with CURRENT_WORK/);

  const next = harness({ existingTurn: {
    id: 'existing', seq: 2, kind: 'message', status: 'PENDING', sendIntent: 'NEXT_TURN',
    content: 'actually, call it gadget', attachments: [],
  } });
  await assert.rejects(send(next, 'CURRENT_WORK'), /already used with NEXT_TURN/);

  const legacy = harness({ existingTurn: {
    id: 'existing', seq: 2, kind: 'message', status: 'PENDING', sendIntent: null,
    content: 'actually, call it gadget', attachments: [],
  } });
  const result = await send(legacy, 'NEXT_TURN');
  assert.equal(result.turnId, 'existing');
  assert.equal(legacy.created.length, 0);
});

test('idempotent CURRENT_WORK retry returns its original steer without charging again', async () => {
  const h = harness({ existingTurn: {
    id: 'existing', seq: 2, kind: 'steer', status: 'PENDING', sendIntent: 'CURRENT_WORK',
    targetTurnId: TARGET_ID, content: 'actually, call it gadget', attachments: [],
  } });
  let charged = 0;
  const result = await send(h, 'CURRENT_WORK', CLIENT_ID, async () => { charged += 1; });
  assert.equal(result.turnId, 'existing');
  assert.equal(result.placement, 'steer');
  assert.equal(charged, 0);
  assert.equal(h.created.length, 0);
});
