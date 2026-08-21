import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { RunnerApiController } from './runner-api.controller';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const GENERATION = '33333333-3333-4333-8333-333333333333';

type Dequeue = (sessionId: string, runnerId: string, leaseGeneration: string | null) => Promise<unknown>;

function harness(
  owned: boolean,
  activeGeneration: string | null = GENERATION,
  registered = true,
  status: RunStatus = RunStatus.RUNNING,
  generationOwnerMatches = true,
) {
  const rawCalls: unknown[][] = [];
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      rawCalls.push(args);
      const sql = (args[0] as readonly string[]).join('?');
      if (/SELECT id, "inbox_lease_generation"[\s\S]*FROM "session"/.test(sql)) {
        return owned
          ? [{
              id: SESSION_ID,
              inboxLeaseGeneration: activeGeneration,
              inboxLeaseOwner: GENERATION,
              status,
            }]
          : [];
      }
      if (/FROM "inbox_lease_generation"/.test(sql)) {
        return registered && generationOwnerMatches ? [{ generation: GENERATION }] : [];
      }
      return [];
    },
  };
  const prisma = {
    $transaction: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
  const controller = new RunnerApiController(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);
  return {
    dequeue: (controller as unknown as { dequeueTurn: Dequeue }).dequeueTurn.bind(controller),
    rawCalls,
  };
}

test('dequeue row-locks runner ownership and stamps the engine generation with the lease', async () => {
  const h = harness(true);

  assert.equal(await h.dequeue(SESSION_ID, RUNNER_ID, GENERATION), null);
  assert.equal(h.rawCalls.length, 3);

  const lockSQL = (h.rawCalls[0][0] as readonly string[]).join('?');
  assert.match(lockSQL, /"assigned_runner_id" = \?::uuid[\s\S]*FOR UPDATE/);
  assert.match(lockSQL, /"inbox_lease_owner" AS "inboxLeaseOwner", status/);
  assert.deepEqual(h.rawCalls[0].slice(1), [SESSION_ID, RUNNER_ID]);

  const activeSQL = (h.rawCalls[1][0] as readonly string[]).join('?');
  assert.match(activeSQL, /FROM "inbox_lease_generation"/);
  assert.match(activeSQL, /"lease_owner" IS NOT DISTINCT FROM \?::uuid/);
  assert.match(activeSQL, /"retired_at" IS NULL/);

  const leaseSQL = (h.rawCalls[2][0] as readonly string[]).join('?');
  assert.match(leaseSQL, /"lease_deadline_at" = now\(\) \+ \(\? \* interval '1 millisecond'\)/);
  assert.match(leaseSQL, /"lease_generation" = \?::uuid/);
  assert.ok(h.rawCalls[2].slice(1).includes(GENERATION));
});

test('an old long-poll generation cannot dequeue after release or replacement', async () => {
  const h = harness(true, '44444444-4444-4444-8444-444444444444');

  await assert.rejects(h.dequeue(SESSION_ID, RUNNER_ID, GENERATION), ConflictException);
  assert.equal(h.rawCalls.length, 1);
});

test('a non-current generation cannot self-activate through dequeue', async () => {
  const h = harness(true, null);

  await assert.rejects(h.dequeue(SESSION_ID, RUNNER_ID, GENERATION), ConflictException);
  assert.equal(h.rawCalls.length, 1);
});

test('a retired current generation cannot dequeue even while its tombstone remains current', async () => {
  const h = harness(true, GENERATION, false);

  await assert.rejects(h.dequeue(SESSION_ID, RUNNER_ID, GENERATION), ConflictException);
  assert.equal(h.rawCalls.length, 2);
});

test('a generation registered to another process owner cannot dequeue', async () => {
  const h = harness(true, GENERATION, true, RunStatus.RUNNING, false);

  await assert.rejects(h.dequeue(SESSION_ID, RUNNER_ID, GENERATION), ConflictException);
  assert.equal(h.rawCalls.length, 2);
});

test('terminal sessions fence modern and legacy inbox pollers before generation checks', async () => {
  for (const status of [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED]) {
    for (const generation of [GENERATION, null]) {
      const h = harness(true, GENERATION, true, status);
      await assert.rejects(h.dequeue(SESSION_ID, RUNNER_ID, generation), ConflictException);
      assert.equal(h.rawCalls.length, 1);
    }
  }
});

test('a legacy NULL poll keeps the empty-poll compatibility path after modern activation', async () => {
  const h = harness(true, GENERATION);

  assert.equal(await h.dequeue(SESSION_ID, RUNNER_ID, null), null);
  assert.equal(h.rawCalls.length, 1);
});

test('dequeue cannot lease a turn after runner ownership changes', async () => {
  const h = harness(false);

  await assert.rejects(h.dequeue(SESSION_ID, RUNNER_ID, GENERATION), ForbiddenException);
  assert.equal(h.rawCalls.length, 1);
});
