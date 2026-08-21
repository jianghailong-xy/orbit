import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RunnerApiController } from './runner-api.controller';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const GENERATION = '33333333-3333-4333-8333-333333333333';
const LEASE_OWNER = '44444444-4444-4444-8444-444444444444';

type RawCall = unknown[];

function rawSQL(call: RawCall | undefined): string {
  const strings = call?.[0] as readonly string[] | undefined;
  return strings ? strings.join('?') : '';
}

function rawValues(call: RawCall | undefined): unknown[] {
  return call?.slice(1) ?? [];
}

function makeController(
  assignedRunnerId: string | null = RUNNER_ID,
  currentGeneration: string | null = GENERATION,
  currentOwner: string | null = LEASE_OWNER,
) {
  const calls: string[] = [];
  let lockCall: RawCall | undefined;
  const updateCalls: RawCall[] = [];
  let notifiedSessionId: string | undefined;
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      calls.push('lock');
      lockCall = args;
      return assignedRunnerId === RUNNER_ID
        ? [{
            id: SESSION_ID,
            inboxLeaseGeneration: currentGeneration,
            inboxLeaseOwner: currentOwner,
          }]
        : [];
    },
    $executeRaw: async (...args: unknown[]) => {
      calls.push('update');
      updateCalls.push(args);
      return 1;
    },
  };
  const prisma = {
    $transaction: async (fn: (transaction: typeof tx) => Promise<unknown>) => {
      calls.push('transaction');
      return fn(tx);
    },
  } as never;
  const realtime = {
    notifyInbox: (sessionId: string) => {
      calls.push('notify');
      notifiedSessionId = sessionId;
    },
  } as never;

  return {
    calls,
    controller: new RunnerApiController(
      prisma,
      {} as never,
      realtime,
      {} as never,
      {} as never,
      {} as never,
      { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
    ),
    lockCall: () => lockCall,
    notifiedSessionId: () => notifiedSessionId,
    updateCalls,
  };
}

test('release-leases row-locks ownership and expires only the matching engine generation', async () => {
  const h = makeController();

  const result = await h.controller.releaseLeases(
    { id: RUNNER_ID },
    SESSION_ID,
    { leaseGeneration: GENERATION, leaseOwner: LEASE_OWNER },
  );

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(h.calls, ['transaction', 'lock', 'update', 'update', 'notify']);
  assert.equal(h.notifiedSessionId(), SESSION_ID);
  assert.deepEqual(rawValues(h.lockCall()), [SESSION_ID, RUNNER_ID]);
  assert.deepEqual(rawValues(h.updateCalls[0]), [GENERATION, SESSION_ID, LEASE_OWNER]);
  assert.match(rawSQL(h.updateCalls[0]), /INSERT INTO "inbox_lease_generation"/);
  assert.match(rawSQL(h.updateCalls[0]), /"retired_at"/);
  assert.match(rawSQL(h.updateCalls[0]), /ON CONFLICT \("generation"\) DO UPDATE/);
  assert.deepEqual(rawValues(h.updateCalls[1]), [SESSION_ID, GENERATION]);
  assert.match(rawSQL(h.updateCalls[1]), /kind IN \('message', 'shell'\)/);
  assert.match(rawSQL(h.updateCalls[1]), /status = 'IN_FLIGHT'/);
  assert.match(
    rawSQL(h.updateCalls[1]),
    /"lease_generation" IS NOT DISTINCT FROM \?::uuid/,
  );
  assert.match(rawSQL(h.updateCalls[1]), /now\(\) - interval '1 second'/);
});

test('legacy release keeps the NULL session generation so a replacement legacy engine can poll', async () => {
  const h = makeController(RUNNER_ID, null, null);

  await h.controller.releaseLeases({ id: RUNNER_ID }, SESSION_ID);

  assert.equal(h.updateCalls.length, 1);
  assert.doesNotMatch(rawSQL(h.updateCalls[0]), /UPDATE "session"/);
  assert.doesNotMatch(rawSQL(h.updateCalls[0]), /INSERT INTO "inbox_lease_generation"/);
  assert.deepEqual(rawValues(h.updateCalls[0]), [SESSION_ID, null]);
  assert.match(
    rawSQL(h.updateCalls[0]),
    /"lease_generation" IS NOT DISTINCT FROM \?::uuid/,
  );
});

test('a delayed legacy release cannot clear a generation-aware current consumer', async () => {
  const h = makeController(RUNNER_ID, GENERATION);

  await h.controller.releaseLeases({ id: RUNNER_ID }, SESSION_ID);

  assert.equal(h.updateCalls.length, 1);
  assert.match(rawSQL(h.updateCalls[0]), /UPDATE "conversation_turn"/);
  assert.deepEqual(rawValues(h.updateCalls[0]), [SESSION_ID, null]);
});

test('release-leases does not mutate or notify when the runner does not own the session', async () => {
  const h = makeController('another-runner');

  await assert.rejects(
    h.controller.releaseLeases(
      { id: RUNNER_ID },
      SESSION_ID,
      { leaseGeneration: GENERATION, leaseOwner: LEASE_OWNER },
    ),
    ForbiddenException,
  );

  assert.deepEqual(h.calls, ['transaction', 'lock']);
  assert.equal(h.updateCalls.length, 0);
  assert.equal(h.notifiedSessionId(), undefined);
});

test('release-leases rejects a malformed generation before opening a transaction', async () => {
  const h = makeController();

  await assert.rejects(
    h.controller.releaseLeases(
      { id: RUNNER_ID },
      SESSION_ID,
      { leaseGeneration: 'not-a-uuid' },
    ),
    BadRequestException,
  );

  assert.deepEqual(h.calls, []);
});

test('release-leases rejects a malformed lease owner before opening a transaction', async () => {
  const h = makeController();

  await assert.rejects(
    h.controller.releaseLeases(
      { id: RUNNER_ID },
      SESSION_ID,
      { leaseGeneration: GENERATION, leaseOwner: 'not-a-uuid' },
    ),
    BadRequestException,
  );

  assert.deepEqual(h.calls, []);
});
