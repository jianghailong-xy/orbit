import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { RunnerApiController } from './runner-api.controller';

const SESSION = '11111111-1111-4111-8111-111111111111';
const RUNNER = '22222222-2222-4222-8222-222222222222';
const GENERATION = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';

function harness(generation: string | null = GENERATION, liveTurn = false) {
  const until = new Date(Date.now() + 3600_000).toISOString();
  let state = {
    id: SESSION, provider: 'codex', providerBuiltin: true, ownerId: OWNER,
    inboxLeaseGeneration: generation, inboxLeaseOwner: generation ? OWNER : null,
    status: RunStatus.RUNNING as RunStatus, codexAccount: 'default', engineTurnActive: liveTurn,
  };
  let retired = false;
  let committed = false;
  let delivered = 0;
  const announcements: boolean[] = [];
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      const sql = renderRawQuery(args).text;
      if (/SELECT id, "inbox_lease_generation"/.test(sql)) return [{ ...state }];
      if (/FROM "inbox_lease_generation"/.test(sql)) return retired ? [] : [{ generation }];
      if (/SELECT s.id FROM "session" s JOIN "runner"/.test(sql)) return liveTurn ? [] : [{ id: SESSION }];
      if (/UPDATE "conversation_turn"/.test(sql)) delivered++;
      return [];
    },
    $executeRaw: async (...args: unknown[]) => {
      if (/INSERT INTO "inbox_lease_generation"/.test(renderRawQuery(args).text)) retired = true;
      return 1;
    },
    session: {
      findUniqueOrThrow: async () => ({
        ...state, workspace: {},
        assignedRunner: {
          engines: [{ engine: 'codex', auth: 'yes', accounts: [{ id: 'default', auth: 'yes' }] }],
          accountPauses: { codex: { default: until } },
        },
      }),
      update: async ({ data }: { data: object }) => { state = { ...state, ...data }; return state; },
    },
    conversationTurn: { updateMany: async () => ({ count: 0 }) },
  };
  const prisma = {
    $transaction: async (body: (client: typeof tx) => Promise<unknown>) => {
      const before = { ...state }, wasRetired = retired;
      try {
        const result = await body(tx);
        committed = true;
        return result;
      } catch (error) {
        state = before;
        retired = wasRetired;
        throw error;
      }
    },
  };
  const realtime = { publishSessionUpdated: () => announcements.push(committed) };
  const queue = { notifySessionQueued: () => announcements.push(committed) };
  const controller = new RunnerApiController(prisma as never, queue as never, realtime as never,
    {} as never, {} as never, {} as never);
  return {
    dequeue: () => (controller as unknown as {
      dequeueTurn(id: string, runner: string, generation: string | null): Promise<unknown>;
    }).dequeueTurn(SESSION, RUNNER, generation),
    snapshot: () => ({ state, retired, committed, delivered, announcements }),
  };
}

test('pause commits its waiting state before telling a warm runner to release ownership', async () => {
  const h = harness();
  await assert.rejects(h.dequeue(), ConflictException);
  const result = h.snapshot();
  assert.equal(result.committed, true, '409 must not roll back the pause');
  assert.equal(result.state.status, RunStatus.PENDING);
  assert.equal(result.state.inboxLeaseOwner, null, 'heartbeat must also detach the old supervisor');
  assert.equal(result.state.inboxLeaseGeneration, GENERATION, 'retain the retired generation as an activation fence');
  assert.equal(result.retired, true);
  assert.equal(result.delivered, 0, 'no message or control frame is consumed by the retiring poller');
  assert.deepEqual(result.announcements, [true, true]);
  await assert.rejects(h.dequeue(), ConflictException, 'an old poller cannot keep its local permit alive');
});

test('a legacy NULL generation also gets a committed ownership-loss response and a fence', async () => {
  const h = harness(null);
  await assert.rejects(h.dequeue(), ConflictException);
  const result = h.snapshot();
  assert.equal(result.state.status, RunStatus.PENDING);
  assert.match(result.state.inboxLeaseGeneration!, /^[0-9a-f-]{36}$/);
  assert.equal(result.retired, true);
  assert.equal(result.committed, true);
});

test('a live turn keeps ownership and its permit until it finishes', async () => {
  const h = harness(GENERATION, true);
  assert.equal(await h.dequeue(), null);
  const result = h.snapshot();
  assert.equal(result.state.status, RunStatus.RUNNING);
  assert.equal(result.state.inboxLeaseOwner, OWNER);
  assert.equal(result.retired, false);
  assert.deepEqual(result.announcements, []);
});
