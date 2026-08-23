import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { RunStatus } from '@prisma/client';
import { ReaperService } from './reaper.service';

/**
 * The watchdog half of the claim lease.
 *
 * It covers what the claim's own compensation cannot: a handover the API server never learned had
 * failed. The response was lost, or the process that answered the claim went away — the row is
 * RUNNING, holding a slot, and the runner is perfectly healthy, which is why every other branch of
 * this sweep walks past it.
 *
 * That makes the compatibility rule the load-bearing part. Reclaiming a claim is only safe when
 * "not activated" really means "nothing is driving it", and only a runner that advertised
 * `session-claim-lease-v1` promises that. The absence of a deadline is how the claim recorded that
 * it did not, and a session carrying one must be left alone forever.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const CLAIM_TOKEN = '44444444-4444-4444-8444-444444444444';

interface Swept {
  /** Statements the sweep issued outside a transaction — the claim requeue is the only one. */
  raw: Prisma.Sql[];
  /** Whether anything took the finalize path instead. */
  finalized: boolean;
}

async function sweep(row: {
  claimToken?: string | null;
  claimLeaseExpiresAt?: Date | null;
  status?: RunStatus;
  cancelRequestedAt?: Date | null;
  heartbeatAgoMs?: number;
  flag?: string;
}): Promise<Swept> {
  const previous = process.env.ORBIT_CLAIM_LEASE;
  if (row.flag === undefined) delete process.env.ORBIT_CLAIM_LEASE;
  else process.env.ORBIT_CLAIM_LEASE = row.flag;
  const captured: Swept = { raw: [], finalized: false };
  const tx = {
    session: {
      updateMany: async () => {
        captured.finalized = true;
        return { count: 1 };
      },
      count: async () => 0,
    },
    task: { updateMany: async () => ({ count: 1 }) },
    $executeRaw: async () => 1,
    conversationTurn: { updateMany: async () => ({ count: 1 }), findFirst: async () => null },
  };
  const prisma = {
    session: {
      findMany: async () => [
        {
          id: SESSION_ID,
          taskId: null,
          assignedRunnerId: RUNNER_ID,
          status: row.status ?? RunStatus.RUNNING,
          provider: 'claude',
          providerBuiltin: true,
          runtimeSessionId: 'runtime-1',
          lastTurnAt: new Date(),
          cancelRequestedAt: row.cancelRequestedAt ?? null,
          claimToken: row.claimToken ?? null,
          claimLeaseExpiresAt: row.claimLeaseExpiresAt ?? null,
          endReason: null,
          startsTaskWork: true,
          task: null,
          assignedRunner: {
            status: 'ONLINE',
            lastHeartbeatAt: new Date(Date.now() - (row.heartbeatAgoMs ?? 1_000)),
          },
        },
      ],
    },
    runEvent: { findFirst: async () => null },
    $executeRaw: async (statement: Prisma.Sql) => {
      captured.raw.push(statement);
      return 1;
    },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const realtime = { requestCancel: () => undefined, publish: () => undefined } as never;
  const service = new ReaperService(prisma, realtime);
  try {
    await (service as unknown as { sweep(): Promise<void> }).sweep();
  } finally {
    if (previous === undefined) delete process.env.ORBIT_CLAIM_LEASE;
    else process.env.ORBIT_CLAIM_LEASE = previous;
  }
  return captured;
}

const expired = new Date(Date.now() - 1_000);
const live = new Date(Date.now() + 60_000);

test('an expired, unactivated claim goes back in the queue rather than being finalized', async () => {
  const swept = await sweep({ claimToken: CLAIM_TOKEN, claimLeaseExpiresAt: expired });
  assert.equal(swept.raw.length, 1);
  const sql = swept.raw[0].strings.join('?');
  assert.match(sql, /UPDATE "session" SET\s+status = 'PENDING'/);
  assert.deepEqual(swept.raw[0].values, [SESSION_ID, CLAIM_TOKEN, false]);
  // Nothing ran and nothing failed, so this writes no error, ends no task and arms no retry.
  assert.equal(swept.finalized, false);
});

test('a claim from a runner that cannot activate is never reclaimed', async () => {
  // No deadline is how the claim recorded that this runner never promised to activate. Reclaiming
  // it would pull a session out from under a turn that is really running.
  const swept = await sweep({ claimToken: CLAIM_TOKEN, claimLeaseExpiresAt: null });
  assert.deepEqual(swept.raw, []);
  assert.equal(swept.finalized, false);
});

test('a claim still inside its lease is left alone', async () => {
  const swept = await sweep({ claimToken: CLAIM_TOKEN, claimLeaseExpiresAt: live });
  assert.deepEqual(swept.raw, []);
});

test('an activated claim carries no token, so the sweep has nothing to take back', async () => {
  const swept = await sweep({ claimToken: null, claimLeaseExpiresAt: expired });
  assert.deepEqual(swept.raw, []);
});

test('losing the runner still finalizes, rather than quietly requeueing', async () => {
  // Ordering, deliberately: the offline branch runs first and keeps exactly the behaviour it had.
  // A dead runner is a different fact from a dead handover — it says the turn that WAS running is
  // gone — and it owns the task reclaim and the armed retry that go with that.
  const swept = await sweep({
    claimToken: CLAIM_TOKEN,
    claimLeaseExpiresAt: expired,
    heartbeatAgoMs: 120_000,
  });
  assert.deepEqual(swept.raw, []);
  assert.equal(swept.finalized, true);
});

test('a cancel outranks an expired lease', async () => {
  // The session has to settle CANCELLED; putting it back in a queue whose predicate excludes
  // cancelled rows would strand it at "waiting for a free slot" with nobody coming.
  const swept = await sweep({
    claimToken: CLAIM_TOKEN,
    claimLeaseExpiresAt: expired,
    cancelRequestedAt: new Date(Date.now() - 5 * 60_000),
  });
  assert.deepEqual(swept.raw, []);
  assert.equal(swept.finalized, true);
});

test('an AWAITING_INPUT session is not a claim in flight', async () => {
  const swept = await sweep({
    claimToken: CLAIM_TOKEN,
    claimLeaseExpiresAt: expired,
    status: RunStatus.AWAITING_INPUT,
  });
  assert.deepEqual(swept.raw, []);
});

test('the rollback flag stops the watchdog without stopping the sweep', async () => {
  const swept = await sweep({ claimToken: CLAIM_TOKEN, claimLeaseExpiresAt: expired, flag: 'off' });
  assert.deepEqual(swept.raw, [], 'outstanding leases are left inert for a drain to finish');
  assert.equal(swept.finalized, false);
});
