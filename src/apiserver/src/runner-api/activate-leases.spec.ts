import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { RunnerApiController } from './runner-api.controller';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const GENERATION = '33333333-3333-4333-8333-333333333333';
const OTHER_GENERATION = '44444444-4444-4444-8444-444444444444';
const LEASE_OWNER = '55555555-5555-4555-8555-555555555555';
const UUID_V7 = '019fc086-c7c7-7c92-8215-778ad8a6280a';

function sql(call: unknown[] | undefined): string {
  return ((call?.[0] as readonly string[] | undefined) ?? []).join('?');
}

interface HarnessOptions {
  current: string | null;
  owned?: boolean;
  currentRetired?: boolean;
  candidateRetired?: boolean;
  status?: RunStatus;
  /**
   * What the unlocked preflight read observes, when it must differ from the row the
   * `FOR UPDATE` read then returns — i.e. a concurrent activate landed in between.
   */
  preflight?: {
    inboxLeaseOwner: string | null;
    inboxLeaseGeneration: string | null;
    status: RunStatus;
  } | null;
}

function harness({
  current,
  owned = true,
  currentRetired = false,
  candidateRetired = false,
  status = RunStatus.AWAITING_INPUT,
  preflight,
}: HarnessOptions) {
  const preflightCalls: unknown[] = [];
  const queryCalls: unknown[][] = [];
  const executeCalls: unknown[][] = [];
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      queryCalls.push(args);
      const text = sql(args);
      if (/FROM "session"/.test(text)) {
        return owned
          ? [{
              id: SESSION_ID,
              inboxLeaseGeneration: current,
              inboxLeaseOwner: LEASE_OWNER,
              status,
            }]
          : [];
      }
      if (/SELECT "retired_at" AS "retiredAt"/.test(text)) {
        return [{ retiredAt: currentRetired ? new Date() : null }];
      }
      if (/SELECT "session_id" AS "sessionId"/.test(text)) {
        return [{
          sessionId: SESSION_ID,
          leaseOwner: LEASE_OWNER,
          retiredAt: candidateRetired ? new Date() : null,
        }];
      }
      return [];
    },
    $executeRaw: async (...args: unknown[]) => {
      executeCalls.push(args);
      return 1;
    },
  };
  const prisma = {
    // The unlocked idempotency preflight. It reads the same row the transaction locks,
    // so it mirrors the harness state unless a test overrides it to simulate a race.
    session: {
      findUnique: async (args: unknown) => {
        preflightCalls.push(args);
        if (preflight !== undefined) return preflight;
        return { inboxLeaseOwner: LEASE_OWNER, inboxLeaseGeneration: current, status };
      },
    },
    $transaction: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
  return {
    controller: new RunnerApiController(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
    ),
    executeCalls,
    preflightCalls,
    queryCalls,
  };
}

const request = { leaseGeneration: GENERATION, leaseOwner: LEASE_OWNER };

test('activate-leases registers and installs a generation under the owned Session row lock', async () => {
  const h = harness({ current: null });

  assert.deepEqual(
    await h.controller.activateLeases({ id: RUNNER_ID }, SESSION_ID, request),
    { ok: true },
  );
  assert.match(sql(h.queryCalls[0]), /"assigned_runner_id" = \?::uuid[\s\S]*FOR UPDATE/);
  assert.deepEqual(h.queryCalls[0].slice(1), [SESSION_ID, RUNNER_ID]);
  assert.equal(h.executeCalls.length, 3);
  assert.match(sql(h.executeCalls[0]), /INSERT INTO "inbox_lease_generation"/);
  assert.deepEqual(h.executeCalls[0].slice(1), [GENERATION, SESSION_ID, LEASE_OWNER]);
  assert.match(sql(h.executeCalls[1]), /SET "inbox_lease_generation" = \?::uuid/);
  assert.deepEqual(h.executeCalls[1].slice(1), [GENERATION, SESSION_ID]);
  assert.match(sql(h.executeCalls[2]), /"lease_generation" IS DISTINCT FROM \?::uuid/);
});

test('an already-installed generation returns without taking the Session row lock', async () => {
  // A reclaim storm re-activates the same generation hundreds of times a minute; each
  // FOR UPDATE would starve the claim queue, so the installed case must not lock.
  const h = harness({ current: GENERATION });

  assert.deepEqual(
    await h.controller.activateLeases({ id: RUNNER_ID }, SESSION_ID, request),
    { ok: true },
  );
  assert.equal(h.preflightCalls.length, 1);
  assert.equal(h.queryCalls.length, 0);
  assert.equal(h.executeCalls.length, 0);
});

test('a terminal session is not short-circuited by an installed generation', async () => {
  for (const status of [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED]) {
    const h = harness({ current: GENERATION, status });

    await assert.rejects(
      h.controller.activateLeases({ id: RUNNER_ID }, SESSION_ID, request),
      ConflictException,
    );
    assert.equal(h.executeCalls.length, 0);
  }
});

test('activate-leases is idempotent for the current live generation', async () => {
  // The preflight missed it: a concurrent activate installed this exact generation
  // between the unlocked read and the lock. Re-installing under the lock is a no-op.
  const h = harness({
    current: GENERATION,
    preflight: {
      inboxLeaseOwner: LEASE_OWNER,
      inboxLeaseGeneration: null,
      status: RunStatus.AWAITING_INPUT,
    },
  });

  await h.controller.activateLeases({ id: RUNNER_ID }, SESSION_ID, request);

  assert.equal(h.executeCalls.length, 3);
});

test('activate-leases cannot replace a still-active generation', async () => {
  const h = harness({ current: OTHER_GENERATION });

  await assert.rejects(
    h.controller.activateLeases({ id: RUNNER_ID }, SESSION_ID, request),
    ConflictException,
  );
  assert.equal(h.executeCalls.length, 0);
});

test('a delayed activate cannot install a generation after the session became terminal', async () => {
  for (const status of [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED]) {
    const h = harness({ current: null, status });

    await assert.rejects(
      h.controller.activateLeases({ id: RUNNER_ID }, SESSION_ID, request),
      ConflictException,
    );
    assert.equal(h.queryCalls.length, 1);
    assert.equal(h.executeCalls.length, 0);
  }
});

test('a superseded runner process cannot activate even against a retired generation', async () => {
  const h = harness({ current: OTHER_GENERATION, currentRetired: true });

  await assert.rejects(
    h.controller.activateLeases(
      { id: RUNNER_ID },
      SESSION_ID,
      { leaseGeneration: GENERATION, leaseOwner: OTHER_GENERATION },
    ),
    ConflictException,
  );
  assert.equal(h.executeCalls.length, 0);
});

test('a delayed activate cannot resurrect a generation release already tombstoned', async () => {
  const h = harness({ current: null, candidateRetired: true });

  await assert.rejects(
    h.controller.activateLeases({ id: RUNNER_ID }, SESSION_ID, request),
    ConflictException,
  );
  assert.equal(h.executeCalls.length, 1);
});

test('activate-leases can replace a retired predecessor and expires non-current leases', async () => {
  const h = harness({ current: OTHER_GENERATION, currentRetired: true });

  await h.controller.activateLeases({ id: RUNNER_ID }, SESSION_ID, request);

  assert.equal(h.executeCalls.length, 3);
  assert.match(sql(h.executeCalls[2]), /status = 'IN_FLIGHT'/);
  assert.match(sql(h.executeCalls[2]), /IS DISTINCT FROM \?::uuid/);
});

test('activate-leases rejects a non-owner and malformed or missing identities', async () => {
  const notOwned = harness({ current: null, owned: false });
  await assert.rejects(
    notOwned.controller.activateLeases({ id: RUNNER_ID }, SESSION_ID, request),
    ForbiddenException,
  );

  for (const malformedRequest of [
    { leaseGeneration: '', leaseOwner: LEASE_OWNER },
    { leaseGeneration: 'not-a-uuid', leaseOwner: LEASE_OWNER },
    { leaseGeneration: UUID_V7, leaseOwner: LEASE_OWNER },
    { leaseGeneration: GENERATION, leaseOwner: '' },
    { leaseGeneration: GENERATION, leaseOwner: 'not-a-uuid' },
    { leaseGeneration: GENERATION, leaseOwner: UUID_V7 },
  ]) {
    const malformed = harness({ current: null });
    await assert.rejects(
      malformed.controller.activateLeases(
        { id: RUNNER_ID },
        SESSION_ID,
        malformedRequest,
      ),
      BadRequestException,
    );
    assert.equal(malformed.queryCalls.length, 0);
  }
});

test('activate-leases normalizes uppercase UUIDs before comparing database values', async () => {
  const uppercase = {
    leaseGeneration: GENERATION.toUpperCase(),
    leaseOwner: LEASE_OWNER.toUpperCase(),
  };

  // Both comparisons against stored values must normalize: the unlocked preflight...
  const fastPath = harness({ current: GENERATION });
  await fastPath.controller.activateLeases({ id: RUNNER_ID }, SESSION_ID, uppercase);
  assert.equal(fastPath.queryCalls.length, 0);
  assert.equal(fastPath.executeCalls.length, 0);

  // ...and the locked read, reached here because the preflight raced a concurrent activate.
  const lockedPath = harness({
    current: GENERATION,
    preflight: {
      inboxLeaseOwner: LEASE_OWNER,
      inboxLeaseGeneration: null,
      status: RunStatus.AWAITING_INPUT,
    },
  });
  await lockedPath.controller.activateLeases({ id: RUNNER_ID }, SESSION_ID, uppercase);
  assert.equal(lockedPath.executeCalls.length, 3);
});
