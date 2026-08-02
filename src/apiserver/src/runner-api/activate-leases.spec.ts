import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
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
}

function harness({
  current,
  owned = true,
  currentRetired = false,
  candidateRetired = false,
}: HarnessOptions) {
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
    $transaction: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
  return {
    controller: new RunnerApiController(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ),
    executeCalls,
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

test('activate-leases is idempotent for the current live generation', async () => {
  const h = harness({ current: GENERATION });

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
  const h = harness({ current: GENERATION });

  await h.controller.activateLeases(
    { id: RUNNER_ID },
    SESSION_ID,
    {
      leaseGeneration: GENERATION.toUpperCase(),
      leaseOwner: LEASE_OWNER.toUpperCase(),
    },
  );

  assert.equal(h.executeCalls.length, 3);
});
