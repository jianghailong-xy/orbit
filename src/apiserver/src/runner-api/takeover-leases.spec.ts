import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { RunnerApiController } from './runner-api.controller';

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
    controller: new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never),
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
