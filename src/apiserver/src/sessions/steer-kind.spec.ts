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

process.env.ORBIT_SESSION_CURRENT_WORK_ROUTING_ENABLED = '1';

interface HarnessOptions {
  status?: RunStatus;
  numTurns?: number;
  liveLeaseChecks?: boolean[];
  expiredLease?: boolean;
  provider?: string;
  capabilities?: string[];
  earlierExecutable?: boolean;
  existingTurn?: Record<string, unknown> | null;
  existingFragment?: Record<string, unknown> | null;
  startingTurn?: Record<string, unknown> | null;
  startupFragmentContents?: string[];
  startupAttachmentCount?: number;
  startupAttachmentBytes?: number;
}

function harness(options: HarnessOptions = {}) {
  const created: Record<string, unknown>[] = [];
  const fragments: Record<string, unknown>[] = [];
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
    conversationTurnStartupFragment: {
      findUnique: async () => options.existingFragment ?? null,
      findMany: async () => (options.startupFragmentContents ?? []).map((content) => ({ content })),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        fragments.push(data);
        return { id: 'fragment-new', ...data };
      },
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
      aggregate: async () => ({
        _count: { _all: options.startupAttachmentCount ?? 0 },
        _sum: { sizeBytes: options.startupAttachmentBytes ?? null },
      }),
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
  return { service, created, fragments, queueChanges };
}

const send = (
  h: ReturnType<typeof harness>,
  intent?: 'CURRENT_WORK' | 'NEXT_TURN',
  clientTurnId = CLIENT_ID,
  participateCurrentWorkTransaction?: (tx: Prisma.TransactionClient) => Promise<void>,
) => h.service.createTurn(OWNER_ID, SESSION_ID, {
  clientTurnId,
  content: 'actually, call it gadget',
  ...(intent ? { intent } : {}),
}, { participateCurrentWorkTransaction });

test('legacy omission retains N-1 auto-routing and its nullable protocol row', async () => {
  const h = harness();
  const result = await send(h);
  assert.equal(result.kind, 'steer');
  assert.equal(result.placement, 'steer');
  assert.equal(h.created[0].sendIntent, undefined);
  assert.equal(h.created[0].targetTurnId, undefined);
});

test('gate-off rejects explicit routing without writes while legacy omission remains compatible', async () => {
  const previous = process.env.ORBIT_SESSION_CURRENT_WORK_ROUTING_ENABLED;
  delete process.env.ORBIT_SESSION_CURRENT_WORK_ROUTING_ENABLED;
  try {
    const legacy = harness();
    const accepted = await send(legacy);
    assert.equal(accepted.kind, 'steer', 'gate-off new API matches an N-1 API replica');
    assert.equal(legacy.created[0].sendIntent, undefined);
    assert.equal(legacy.created.length, 1);

    for (const intent of ['CURRENT_WORK', 'NEXT_TURN'] as const) {
      const explicit = harness();
      await assert.rejects(
        send(explicit, intent),
        (error: unknown) =>
          (error as { response?: { code?: string } }).response?.code
            === 'SESSION_TURN_PROTOCOL_DISABLED',
      );
      assert.equal(explicit.created.length, 0);
    }
  } finally {
    if (previous === undefined) delete process.env.ORBIT_SESSION_CURRENT_WORK_ROUTING_ENABLED;
    else process.env.ORBIT_SESSION_CURRENT_WORK_ROUTING_ENABLED = previous;
  }
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

test('startup CURRENT_WORK binds an append-only fragment to the seeded executable', async () => {
  const h = harness({
    status: RunStatus.PENDING,
    numTurns: 0,
    startingTurn: {
      id: TARGET_ID,
      seq: 1,
      kind: 'message',
      status: 'PENDING',
      deliveredAt: null,
      content: 'opening prompt',
    },
  });
  const result = await send(h, 'CURRENT_WORK');
  assert.equal(result.kind, 'startup_context');
  assert.equal(result.placement, 'startup');
  assert.equal(result.targetTurnId, TARGET_ID);
  assert.equal(h.fragments.length, 1);
  assert.equal(h.fragments[0].targetTurnId, TARGET_ID);
  assert.equal(h.created.length, 0, 'startup context created a second executable turn');
});

test('startup envelope aggregate limits are enforced under the Session lock', async () => {
  const startingTurn = {
    id: TARGET_ID,
    seq: 1,
    kind: 'message',
    status: 'PENDING',
    deliveredAt: null,
    content: 'opening prompt',
  };
  const fragments = harness({
    status: RunStatus.PENDING,
    numTurns: 0,
    startingTurn,
    startupFragmentContents: Array.from({ length: 32 }, (_, i) => `context ${i}`),
  });
  await assert.rejects(send(fragments, 'CURRENT_WORK'), (error: unknown) =>
    (error as { response?: { reason?: string } }).response?.reason === 'STARTUP_ENVELOPE_LIMIT');
  assert.equal(fragments.fragments.length, 0);

  const attachments = harness({
    status: RunStatus.PENDING,
    numTurns: 0,
    startingTurn,
    startupAttachmentCount: 21,
  });
  await assert.rejects(send(attachments, 'CURRENT_WORK'), (error: unknown) =>
    (error as { response?: { reason?: string } }).response?.reason === 'STARTUP_ENVELOPE_LIMIT');
  assert.equal(attachments.fragments.length, 0);
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
