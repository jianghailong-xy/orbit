import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SESSION_MERGE_RECOVERY_V1, type MergeRecovery } from '@orbit/shared';
import { SessionsService } from './sessions.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_OWNER = '33333333-3333-4333-8333-333333333333';

function harness(overrides: Record<string, unknown> = {}, capabilities = [SESSION_MERGE_RECOVERY_V1]) {
  const session = {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    status: RunStatus.AWAITING_INPUT,
    cancelRequestedAt: null,
    isolationStatus: 'worktree',
    branch: 'orbit/session',
    assignedRunnerId: 'runner-1',
    workspaceId: 'workspace-1',
    mergeStatus: null,
    commitStatus: null,
    commitOperationOwner: null,
    ...overrides,
  };
  const lockCalls: unknown[][] = [];
  const writes: unknown[] = [];
  const workspaceWrites: unknown[] = [];
  // Transaction commits and runner wakes, in the order they happened.
  const order: string[] = [];
  const tx = {
    runner: { findUnique: async () => ({ capabilities }) },
    $queryRaw: async (...args: unknown[]) => {
      lockCalls.push(args);
      return [{ id: SESSION_ID }];
    },
    session: {
      findUniqueOrThrow: async () => session,
      update: async (args: unknown) => {
        writes.push(args);
        return session;
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => {
      const result = await fn(tx);
      order.push('commit');
      return result;
    },
    workspace: {
      update: async (args: unknown) => {
        workspaceWrites.push(args);
      },
    },
  } as never;
  const realtime = { notifyRunnerWake: (runnerId: string) => order.push(`wake ${runnerId}`) } as never;
  return {
    service: new SessionsService(prisma, {} as never, realtime),
    lockCalls,
    writes,
    workspaceWrites,
    order,
  };
}

function sql(call: unknown[] | undefined): string {
  const first = call?.[0];
  // A tagged-template call hands the strings array first; `Prisma.sql\`\`` hands a single object
  // carrying `.strings`. `[K6]`'s gate reads through the second form, so both have to be readable
  // here or a query would silently count as "not the lock" because of how it was spelled.
  if (Array.isArray(first)) return (first as readonly string[]).join('?');
  const strings = (first as { strings?: readonly string[] } | undefined)?.strings;
  if (Array.isArray(strings)) return strings.join('?');
  return String((first as { text?: string } | undefined)?.text ?? '');
}

/**
 * The calls that TAKE THE LOCK, which is what these tests are about.
 *
 * Not "every raw query", which is what this used to count. `[K6]`'s merge gate reads committed
 * facts inside the same closure — the accepted checkpoint, the task's revision, a landed receipt —
 * and those are reads, not locks. Counting them as lock calls would make this spec fail for a
 * change that did not touch the fence, and, worse, would pass a change that took a SECOND
 * `FOR UPDATE` as long as it removed a read somewhere else.
 */
function locks(calls: unknown[][]): unknown[][] {
  return calls.filter((call) => /FOR UPDATE/.test(sql(call)));
}

test('merge queueing reads and writes the Session under one owner-scoped FOR UPDATE lock', async () => {
  const h = harness();

  assert.deepEqual(await h.service.mergeToMain(OWNER_ID, SESSION_ID), { ok: true });

  const taken = locks(h.lockCalls);
  assert.equal(taken.length, 1);
  assert.match(sql(taken[0]), /FROM "session"/);
  assert.match(sql(taken[0]), /"owner_id"/);
  assert.deepEqual(taken[0].slice(1), [SESSION_ID, OWNER_ID]);
  assert.equal(h.writes.length, 1);
  const data = (h.writes[0] as { data: Record<string, unknown> }).data;
  assert.equal(data.mergeStatus, 'pending');
  assert.match(
    data.mergeOperationId as string,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(data.mergeOperationOwner, null);
  assert.deepEqual(h.workspaceWrites, []);
});

const candidate: MergeRecovery = {
  code: 'READY', targetBranch: 'develop', previewId: 'reviewed',
  sourceSha: 'a'.repeat(40), localSha: 'b'.repeat(40), remoteSha: 'c'.repeat(40),
  candidateSha: 'd'.repeat(40), candidateTreeSha: 'e'.repeat(40), patch: 'full diff',
  check: { status: 'unconfigured' },
};

test('recovery refuses stale approval, failed checks, and an unsupported runner without queueing', async (t) => {
  for (const tc of [
    { name: 'stale preview', recovery: candidate, previewId: 'older', capabilities: [SESSION_MERGE_RECOVERY_V1] },
    { name: 'failed check', recovery: { ...candidate, code: 'CHECK_FAILED' }, previewId: 'reviewed', capabilities: [SESSION_MERGE_RECOVERY_V1] },
    { name: 'old runner', recovery: candidate, previewId: 'reviewed', capabilities: [] },
  ]) {
    await t.test(tc.name, async () => {
      const h = harness({ mergeRecovery: tc.recovery }, tc.capabilities);
      await assert.rejects(() => h.service.mergeToMain(OWNER_ID, SESSION_ID, 'develop', undefined,
        { recoveryAction: 'apply', previewId: tc.previewId }), ConflictException);
      assert.deepEqual(h.writes, []);
    });
  }
});

test('applying a recovery keeps its frozen checkpoint and exact target under the existing fence', async () => {
  const h = harness({ mergeRecovery: candidate, mergeCheckpointId: 'frozen-checkpoint' });
  await h.service.mergeToMain(OWNER_ID, SESSION_ID, undefined, undefined,
    { recoveryAction: 'apply', previewId: 'reviewed' });
  const data = (h.writes[0] as { data: Record<string, unknown> }).data;
  assert.equal(data.mergeTarget, 'develop');
  assert.equal(data.mergeCheckpointId, 'frozen-checkpoint');
  assert.equal(data.mergeRecoveryAction, 'apply');
  assert.equal(data.mergeOperationOwner, null);
  assert.equal('mergeRecovery' in data, false, 'approved candidate must not be cleared');
});

test('read-only preview keeps the previous landing projections', async () => {
  const h = harness({ branchMerged: true, mergedSourceSha: candidate.sourceSha, mergedAt: new Date() });
  await h.service.mergeToMain(OWNER_ID, SESSION_ID, 'develop', undefined, { recoveryAction: 'preview' });
  const data = (h.writes[0] as { data: Record<string, unknown> }).data;
  for (const field of ['mergedAt', 'mergedSourceSha', 'branchMerged']) assert.equal(field in data, false);
});

test('local sync preserves landed projections and cannot be used for a candidate that never landed', async () => {
  const h = harness({ mergeRecovery: { ...candidate, code: 'LOCAL_SYNC_PENDING' } });
  await h.service.mergeToMain(OWNER_ID, SESSION_ID, undefined, undefined,
    { recoveryAction: 'sync-local', previewId: 'reviewed' });
  const data = (h.writes[0] as { data: Record<string, unknown> }).data;
  for (const field of ['mergedAt', 'mergedSourceSha', 'branchMerged']) assert.equal(field in data, false);
  const unlanded = harness({ mergeRecovery: candidate });
  await assert.rejects(() => unlanded.service.mergeToMain(OWNER_ID, SESSION_ID, undefined, undefined,
    { recoveryAction: 'sync-local', previewId: 'reviewed' }), ConflictException);
  assert.deepEqual(unlanded.writes, []);
});

for (const tc of [
  { name: 'PENDING session', overrides: { status: RunStatus.PENDING } },
  { name: 'RUNNING session', overrides: { status: RunStatus.RUNNING } },
  {
    name: 'ending idle session',
    overrides: { status: RunStatus.AWAITING_INPUT, cancelRequestedAt: new Date() },
  },
] as const) {
  test(`merge queueing rejects ${tc.name}`, async () => {
    const h = harness(tc.overrides);

    await assert.rejects(
      () => h.service.mergeToMain(OWNER_ID, SESSION_ID),
      (error: unknown) =>
        error instanceof ConflictException &&
        error.message === 'wait for the current turn to finish before merging',
    );

    assert.equal(locks(h.lockCalls).length, 1);
    assert.deepEqual(h.writes, []);
  });
}

for (const status of [
  RunStatus.AWAITING_INPUT,
  RunStatus.SUCCEEDED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
]) {
  test(`merge queueing is allowed from ${status}`, async () => {
    const h = harness({
      status,
      // Terminal cancel intent is historical and must not look like a live
      // checkout that is currently ending.
      ...(status === RunStatus.AWAITING_INPUT ? {} : { cancelRequestedAt: new Date() }),
    });

    await assert.doesNotReject(() => h.service.mergeToMain(OWNER_ID, SESSION_ID));

    assert.equal(locks(h.lockCalls).length, 1);
    assert.equal(h.writes.length, 1);
    assert.equal(
      (h.writes[0] as { data: Record<string, unknown> }).data.mergeStatus,
      'pending',
    );
  });
}

test('a queued merge wakes its runner once the queue has committed', async () => {
  const h = harness();

  await h.service.mergeToMain(OWNER_ID, SESSION_ID);

  assert.deepEqual(h.order, ['commit', 'wake runner-1']);
});

test('a merge request that queued nothing wakes no runner', async () => {
  const pending = harness({ mergeStatus: 'pending', mergeOperationId: 'operation-1' });
  await pending.service.mergeToMain(OWNER_ID, SESSION_ID);
  const running = harness({ status: RunStatus.RUNNING });
  await assert.rejects(() => running.service.mergeToMain(OWNER_ID, SESSION_ID));

  assert.deepEqual(pending.order, ['commit']);
  assert.deepEqual(running.order, []);
});

test('merge queueing cannot overlap a runner-claimed commit', async () => {
  const h = harness({
    commitStatus: 'pending',
    commitOperationOwner: OPERATION_OWNER,
  });

  await assert.rejects(
    () => h.service.mergeToMain(OWNER_ID, SESSION_ID),
    (error: unknown) =>
      error instanceof ConflictException &&
      error.message === 'wait for the pending worktree commit to finish',
  );

  assert.equal(locks(h.lockCalls).length, 1);
  assert.deepEqual(h.writes, []);
});
