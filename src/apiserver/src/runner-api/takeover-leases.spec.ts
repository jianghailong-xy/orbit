import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { newTerminalResumeHandoffOwner } from '../common/session-inbox-fence';
import { RunnerApiController, SESSION_TERMINAL_HANDOFF_V1 } from './runner-api.controller';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const OLD_OWNER = '33333333-3333-4333-8333-333333333333';
const NEW_OWNER = '44444444-4444-4444-8444-444444444444';
const GENERATION = '55555555-5555-4555-8555-555555555555';

function sql(call: unknown[] | undefined): string {
  return ((call?.[0] as readonly string[] | undefined) ?? []).join('?');
}

function harness(
  currentOwner: string | null,
  currentGeneration: string | null,
  owned = true,
  status: RunStatus = RunStatus.AWAITING_INPUT,
  operationState: Record<string, unknown> = {},
) {
  const executeCalls: unknown[][] = [];
  let queryCalls = 0;
  let notified: string | undefined;
  const tx = {
    $queryRaw: async () => {
      queryCalls += 1;
      return owned
        ? [
            {
              id: SESSION_ID,
              inboxLeaseGeneration: currentGeneration,
              inboxLeaseOwner: currentOwner,
              status,
              mergeStatus: null,
              mergeOperationId: null,
              mergeOperationOwner: null,
              commitStatus: null,
              commitOperationId: null,
              commitOperationOwner: null,
              ...operationState,
            },
          ]
        : [];
    },
    $executeRaw: async (...args: unknown[]) => {
      executeCalls.push(args);
      return 1;
    },
  };
  const prisma = {
    $transaction: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
  const realtime = {
    notifyInbox: (sessionId: string) => {
      notified = sessionId;
    },
  } as never;
  return {
    controller: new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never),
    executeCalls,
    notified: () => notified,
    queryCalls: () => queryCalls,
  };
}

test('takeover CAS retires the observed process generation and installs the new owner', async () => {
  const h = harness(OLD_OWNER, GENERATION);

  assert.deepEqual(
    await h.controller.takeoverLeases({ id: RUNNER_ID }, SESSION_ID, {
      leaseOwner: NEW_OWNER,
      expectedLeaseOwner: OLD_OWNER,
    }),
    { ok: true, status: RunStatus.AWAITING_INPUT },
  );

  assert.equal(h.queryCalls(), 1);
  assert.equal(h.executeCalls.length, 3);
  assert.match(sql(h.executeCalls[0]), /INSERT INTO "inbox_lease_generation"/);
  assert.match(sql(h.executeCalls[0]), /"retired_at"/);
  assert.deepEqual(h.executeCalls[0].slice(1), [GENERATION, SESSION_ID, OLD_OWNER]);
  assert.match(sql(h.executeCalls[1]), /"inbox_lease_owner" = \?::uuid/);
  assert.deepEqual(h.executeCalls[1].slice(1), [GENERATION, NEW_OWNER, SESSION_ID]);
  assert.match(sql(h.executeCalls[2]), /UPDATE "conversation_turn"/);
  assert.equal(h.notified(), SESSION_ID);
});

test('takeover clears background work left behind by the process it replaces', async () => {
  // The predecessor's shells and sub-workspaces are its children, so the handoff is the moment
  // they stop existing. Without this a session that parks and is never resumed keeps a stale
  // "N background processes running" forever: no `init`/`resumed` handshake ever follows.
  const h = harness(OLD_OWNER, GENERATION);

  await h.controller.takeoverLeases({ id: RUNNER_ID }, SESSION_ID, {
    leaseOwner: NEW_OWNER,
    expectedLeaseOwner: OLD_OWNER,
  });

  const rotation = sql(h.executeCalls[1]);
  assert.match(rotation, /"running_bg_shells" = '\{\}'::text\[\]/);
  assert.match(rotation, /"running_subagents" = '\{\}'::text\[\]/);
});

test('takeover clears the mid-turn engine flag the replaced process left set', async () => {
  // A runner killed mid-turn emits no turn_end, so engineTurnActive stays true and the parked
  // session keeps reading as generating — inflating the running set — until it is resumed.
  const h = harness(OLD_OWNER, GENERATION);

  await h.controller.takeoverLeases({ id: RUNNER_ID }, SESSION_ID, {
    leaseOwner: NEW_OWNER,
    expectedLeaseOwner: OLD_OWNER,
  });

  assert.match(sql(h.executeCalls[1]), /"engine_turn_active" = false/);
});

test('an idempotent takeover leaves a live process its running background work', async () => {
  // Same owner means no handoff — the process that launched those shells is still supervising,
  // so clearing here would erase work that is genuinely running.
  const h = harness(NEW_OWNER, GENERATION);

  await h.controller.takeoverLeases({ id: RUNNER_ID }, SESSION_ID, {
    leaseOwner: NEW_OWNER,
    expectedLeaseOwner: NEW_OWNER,
  });

  assert.equal(h.executeCalls.length, 0);
});

test('takeover from legacy NULL state creates a retired barrier before returning', async () => {
  const h = harness(null, null);

  await h.controller.takeoverLeases({ id: RUNNER_ID }, SESSION_ID, {
    leaseOwner: NEW_OWNER,
    expectedLeaseOwner: null,
  });

  assert.equal(h.executeCalls.length, 3);
  const generatedFence = h.executeCalls[0].slice(1)[0];
  assert.equal(typeof generatedFence, 'string');
  assert.match(generatedFence as string, /^[0-9a-f-]{36}$/);
  assert.equal(h.executeCalls[1].slice(1)[0], generatedFence);
});

test('takeover is idempotent for the process that already owns the session', async () => {
  const h = harness(NEW_OWNER, GENERATION, true, RunStatus.PENDING);

  assert.deepEqual(
    await h.controller.takeoverLeases({ id: RUNNER_ID }, SESSION_ID, {
      leaseOwner: NEW_OWNER,
      expectedLeaseOwner: OLD_OWNER,
    }),
    { ok: true, status: RunStatus.PENDING },
  );

  assert.equal(h.executeCalls.length, 0);
  assert.equal(h.notified(), SESSION_ID);
});

test('terminal-resume sentinel takeover requires the handoff capability', async () => {
  const handoffOwner = newTerminalResumeHandoffOwner();
  const legacy = harness(handoffOwner, GENERATION, true, RunStatus.RUNNING);
  await assert.rejects(
    legacy.controller.takeoverLeases({ id: RUNNER_ID }, SESSION_ID, {
      leaseOwner: NEW_OWNER,
      expectedLeaseOwner: handoffOwner,
    }),
    ConflictException,
  );
  assert.equal(legacy.executeCalls.length, 0);

  const capable = harness(handoffOwner, GENERATION, true, RunStatus.RUNNING);
  assert.deepEqual(
    await capable.controller.takeoverLeases(
      { id: RUNNER_ID },
      SESSION_ID,
      {
        leaseOwner: NEW_OWNER,
        expectedLeaseOwner: handoffOwner,
      },
      SESSION_TERMINAL_HANDOFF_V1,
    ),
    { ok: true, status: RunStatus.RUNNING },
  );
  assert.equal(capable.executeCalls.length, 3);
});

test('a delayed predecessor takeover cannot overwrite a newer process owner', async () => {
  const h = harness(NEW_OWNER, GENERATION);

  await assert.rejects(
    h.controller.takeoverLeases({ id: RUNNER_ID }, SESSION_ID, {
      leaseOwner: OLD_OWNER,
      expectedLeaseOwner: null,
    }),
    ConflictException,
  );

  assert.equal(h.executeCalls.length, 0);
  assert.equal(h.notified(), undefined);
});

for (const tc of [
  {
    name: 'merge',
    operationState: {
      mergeStatus: 'pending',
      mergeOperationId: '66666666-6666-4666-8666-666666666666',
      mergeOperationOwner: '66666666-6666-4666-8666-666666666666',
    },
  },
  {
    name: 'commit',
    operationState: {
      commitStatus: 'pending',
      commitOperationId: '66666666-6666-4666-8666-666666666666',
      commitOperationOwner: '66666666-6666-4666-8666-666666666666',
    },
  },
] as const) {
  test(`takeover cannot rotate the process owner during a claimed ${tc.name}`, async () => {
    const h = harness(
      OLD_OWNER,
      GENERATION,
      true,
      RunStatus.AWAITING_INPUT,
      tc.operationState,
    );

    await assert.rejects(
      () =>
        h.controller.takeoverLeases({ id: RUNNER_ID }, SESSION_ID, {
          leaseOwner: NEW_OWNER,
          expectedLeaseOwner: OLD_OWNER,
        }),
      (error: unknown) =>
        error instanceof ConflictException &&
        error.message === 'wait for the pending worktree operation to finish',
    );

    assert.equal(h.executeCalls.length, 0);
    assert.equal(h.notified(), undefined);
  });
}

for (const tc of [
  {
    name: 'a modern unclaimed merge',
    operationState: {
      mergeStatus: 'pending',
      mergeOperationId: '66666666-6666-4666-8666-666666666666',
      mergeOperationOwner: null,
    },
  },
  {
    name: 'a modern unclaimed commit',
    operationState: {
      commitStatus: 'pending',
      commitOperationId: '66666666-6666-4666-8666-666666666666',
      commitOperationOwner: null,
    },
  },
  // An orphaned NULL/NULL row has no runner process behind it; blocking on one
  // 409s every takeover forever, so the runner never reaches the claim loop.
  {
    name: 'an orphaned NULL/NULL merge',
    operationState: {
      mergeStatus: 'pending',
      mergeOperationId: null,
      mergeOperationOwner: null,
    },
  },
  {
    name: 'an orphaned NULL/NULL commit',
    operationState: {
      commitStatus: 'pending',
      commitOperationId: null,
      commitOperationOwner: null,
    },
  },
] as const) {
  test(`takeover may rotate past ${tc.name}`, async () => {
    const h = harness(
      OLD_OWNER,
      GENERATION,
      true,
      RunStatus.AWAITING_INPUT,
      tc.operationState,
    );

    assert.deepEqual(
      await h.controller.takeoverLeases({ id: RUNNER_ID }, SESSION_ID, {
        leaseOwner: NEW_OWNER,
        expectedLeaseOwner: OLD_OWNER,
      }),
      { ok: true, status: RunStatus.AWAITING_INPUT },
    );

    assert.equal(h.executeCalls.length, 3);
    assert.equal(h.notified(), SESSION_ID);
  });
}

test('takeover refuses a row that became terminal after the reclaim snapshot', async () => {
  for (const status of [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED]) {
    const h = harness(OLD_OWNER, GENERATION, true, status);
    await assert.rejects(
      h.controller.takeoverLeases({ id: RUNNER_ID }, SESSION_ID, {
        leaseOwner: NEW_OWNER,
        expectedLeaseOwner: OLD_OWNER,
      }),
      ConflictException,
    );
    assert.equal(h.executeCalls.length, 0);
    assert.equal(h.notified(), undefined);
  }
});

test('takeover rejects non-owners and malformed process identities', async () => {
  const notOwned = harness(OLD_OWNER, GENERATION, false);
  await assert.rejects(
    notOwned.controller.takeoverLeases({ id: RUNNER_ID }, SESSION_ID, {
      leaseOwner: NEW_OWNER,
      expectedLeaseOwner: OLD_OWNER,
    }),
    ForbiddenException,
  );

  for (const request of [
    { leaseOwner: '', expectedLeaseOwner: OLD_OWNER },
    { leaseOwner: 'bad', expectedLeaseOwner: OLD_OWNER },
    { leaseOwner: NEW_OWNER, expectedLeaseOwner: 'bad' },
  ]) {
    const malformed = harness(OLD_OWNER, GENERATION);
    await assert.rejects(
      malformed.controller.takeoverLeases({ id: RUNNER_ID }, SESSION_ID, request),
      BadRequestException,
    );
    assert.equal(malformed.queryCalls(), 0);
  }
});
