import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { RunnerApiController } from './runner-api.controller';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const OLD_OWNER = '33333333-3333-4333-8333-333333333333';
const NEW_OWNER = '44444444-4444-4444-8444-444444444444';
const OLD_OPERATION = '55555555-5555-4555-8555-555555555555';
const NEW_OPERATION = '66666666-6666-4666-8666-666666666666';

function harness(row: Record<string, unknown>) {
  const writes: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  let transactionCalls = 0;
  const tx = {
    $queryRaw: async () => [row],
    session: {
      update: async (args: (typeof writes)[number]) => {
        writes.push(args);
        return row;
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => {
      transactionCalls++;
      return fn(tx);
    },
  };
  return {
    api: new RunnerApiController(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ),
    writes,
    transactionCalls: () => transactionCalls,
  };
}

function mergeRow(overrides: Record<string, unknown> = {}) {
  return {
    status: RunStatus.SUCCEEDED,
    inboxLeaseOwner: OLD_OWNER,
    mergeStatus: 'pending',
    mergeOperationId: NEW_OPERATION,
    mergeOperationOwner: NEW_OWNER,
    ...overrides,
  };
}

function commitRow(overrides: Record<string, unknown> = {}) {
  return {
    status: RunStatus.AWAITING_INPUT,
    inboxLeaseOwner: NEW_OWNER,
    commitStatus: 'pending',
    commitOperationId: NEW_OPERATION,
    commitOperationOwner: NEW_OWNER,
    ...overrides,
  };
}

test('terminal merge result is fenced by operation id and operation owner, not stale inbox owner', async () => {
  const h = harness(mergeRow());

  await h.api.mergeResult({ id: RUNNER_ID }, SESSION_ID, {
    operationId: NEW_OPERATION,
    leaseOwner: NEW_OWNER,
    status: 'merged',
  });

  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]?.data.mergeStatus, 'merged');
});

test('merge result rejects stale operation ABA, stale process owner, and open-session owner loss', async (t) => {
  const cases = [
    {
      name: 'old operation id after a new attempt was queued',
      row: mergeRow(),
      operationId: OLD_OPERATION,
      leaseOwner: NEW_OWNER,
    },
    {
      name: 'old process owner for the current operation id',
      row: mergeRow(),
      operationId: NEW_OPERATION,
      leaseOwner: OLD_OWNER,
    },
    {
      name: 'open session whose inbox owner moved after dispatch',
      row: mergeRow({
        status: RunStatus.AWAITING_INPUT,
        inboxLeaseOwner: OLD_OWNER,
      }),
      operationId: NEW_OPERATION,
      leaseOwner: NEW_OWNER,
    },
  ];

  for (const tc of cases) {
    await t.test(tc.name, async () => {
      const h = harness(tc.row);
      await assert.rejects(
        () =>
          h.api.mergeResult({ id: RUNNER_ID }, SESSION_ID, {
            operationId: tc.operationId,
            leaseOwner: tc.leaseOwner,
            status: 'error',
          }),
        (error: unknown) =>
          error instanceof ConflictException &&
          error.message === 'merge operation is no longer current',
      );
      assert.deepEqual(h.writes, []);
    });
  }
});

test('legacy merge result is accepted only while both persisted fence columns are NULL', async () => {
  const legacy = harness(
    mergeRow({
      mergeOperationId: null,
      mergeOperationOwner: null,
    }),
  );
  await legacy.api.mergeResult({ id: RUNNER_ID }, SESSION_ID, { status: 'error' });
  assert.equal(legacy.writes.length, 1);

  const modern = harness(mergeRow());
  await assert.rejects(
    () => modern.api.mergeResult({ id: RUNNER_ID }, SESSION_ID, { status: 'error' }),
    ConflictException,
  );
  assert.deepEqual(modern.writes, []);
});

test('live commit result requires the current operation, claimed owner, and idle session owner', async () => {
  const h = harness(commitRow());

  await h.api.commitResult({ id: RUNNER_ID }, SESSION_ID, {
    operationId: NEW_OPERATION,
    leaseOwner: NEW_OWNER,
    status: 'committed',
  });

  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]?.data.commitStatus, 'committed');
  assert.equal(h.writes[0]?.data.worktreeDirty, false);
});

for (const status of [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED]) {
  test(`an exact modern commit result can settle after the session becomes ${status}`, async () => {
    const h = harness(
      commitRow({
        status,
        // Terminalization may retire or replace the live Session owner. The exact
        // operation identity remains the receipt fence in this state.
        inboxLeaseOwner: OLD_OWNER,
      }),
    );

    await h.api.commitResult({ id: RUNNER_ID }, SESSION_ID, {
      operationId: NEW_OPERATION,
      leaseOwner: NEW_OWNER,
      status: 'committed',
    });

    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0]?.data.commitStatus, 'committed');
  });
}

test('commit result rejects stale operation ABA and stale process ownership', async (t) => {
  const cases = [
    {
      name: 'old operation id after a new attempt was queued',
      row: commitRow(),
      operationId: OLD_OPERATION,
      leaseOwner: NEW_OWNER,
    },
    {
      name: 'old operation owner',
      row: commitRow(),
      operationId: NEW_OPERATION,
      leaseOwner: OLD_OWNER,
    },
    {
      name: 'session owner changed after dispatch',
      row: commitRow({ inboxLeaseOwner: OLD_OWNER }),
      operationId: NEW_OPERATION,
      leaseOwner: NEW_OWNER,
    },
    {
      name: 'session left the idle boundary',
      row: commitRow({ status: RunStatus.RUNNING }),
      operationId: NEW_OPERATION,
      leaseOwner: NEW_OWNER,
    },
  ];

  for (const tc of cases) {
    await t.test(tc.name, async () => {
      const h = harness(tc.row);
      await assert.rejects(
        () =>
          h.api.commitResult({ id: RUNNER_ID }, SESSION_ID, {
            operationId: tc.operationId,
            leaseOwner: tc.leaseOwner,
            status: 'error',
          }),
        (error: unknown) =>
          error instanceof ConflictException &&
          error.message === 'commit operation is no longer current',
      );
      assert.deepEqual(h.writes, []);
    });
  }
});

test('legacy commit result is accepted only at the idle boundary with NULL fence columns', async () => {
  const legacy = harness(
    commitRow({
      commitOperationId: null,
      commitOperationOwner: null,
    }),
  );
  await legacy.api.commitResult({ id: RUNNER_ID }, SESSION_ID, { status: 'nochange' });
  assert.equal(legacy.writes.length, 1);

  const modern = harness(commitRow());
  await assert.rejects(
    () => modern.api.commitResult({ id: RUNNER_ID }, SESSION_ID, { status: 'nochange' }),
    ConflictException,
  );
  assert.deepEqual(modern.writes, []);
});

for (const status of [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED]) {
  test(`legacy NULL commit result remains fenced after the session becomes ${status}`, async () => {
    const h = harness(
      commitRow({
        status,
        commitOperationId: null,
        commitOperationOwner: null,
      }),
    );

    await assert.rejects(
      () => h.api.commitResult({ id: RUNNER_ID }, SESSION_ID, { status: 'committed' }),
      (error: unknown) =>
        error instanceof ConflictException &&
        error.message === 'commit operation is no longer current',
    );
    assert.deepEqual(h.writes, []);
  });
}

test('result identities must provide operation id and owner as one capability pair', async (t) => {
  await t.test('merge', async () => {
    const h = harness(mergeRow());
    await assert.rejects(
      () =>
        h.api.mergeResult({ id: RUNNER_ID }, SESSION_ID, {
          operationId: NEW_OPERATION,
          status: 'error',
        }),
      BadRequestException,
    );
    assert.deepEqual(h.writes, []);
  });

  await t.test('commit', async () => {
    const h = harness(commitRow());
    await assert.rejects(
      () =>
        h.api.commitResult({ id: RUNNER_ID }, SESSION_ID, {
          leaseOwner: NEW_OWNER,
          status: 'error',
        }),
      BadRequestException,
    );
    assert.deepEqual(h.writes, []);
  });
});

test('merge result status is allowlisted before opening a transaction', async (t) => {
  for (const status of ['pending', 'malformed-result']) {
    await t.test(status, async () => {
      const h = harness(mergeRow());

      await assert.rejects(
        () =>
          h.api.mergeResult(
            { id: RUNNER_ID },
            SESSION_ID,
            {
              operationId: NEW_OPERATION,
              leaseOwner: NEW_OWNER,
              status,
            } as never,
          ),
        BadRequestException,
      );

      assert.equal(h.transactionCalls(), 0);
      assert.deepEqual(h.writes, []);
    });
  }
});

test('commit result status is allowlisted before opening a transaction', async (t) => {
  for (const status of ['pending', 'malformed-result']) {
    await t.test(status, async () => {
      const h = harness(commitRow());

      await assert.rejects(
        () =>
          h.api.commitResult(
            { id: RUNNER_ID },
            SESSION_ID,
            {
              operationId: NEW_OPERATION,
              leaseOwner: NEW_OWNER,
              status,
            } as never,
          ),
        BadRequestException,
      );

      assert.equal(h.transactionCalls(), 0);
      assert.deepEqual(h.writes, []);
    });
  }
});
