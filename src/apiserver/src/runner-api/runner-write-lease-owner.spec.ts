import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { RunEventType, RunStatus as SharedRunStatus } from '@orbit/shared';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { RunnerApiController } from './runner-api.controller';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';

type HarnessOptions = {
  assigned?: boolean;
  leaseOwnerMatches?: boolean;
};

function harness(options: HarnessOptions = {}) {
  const writes: string[] = [];
  const rawCalls: unknown[][] = [];
  let transactions = 0;
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      rawCalls.push(args);
      if (options.assigned === false) return [];
      return [
        {
          id: SESSION_ID,
          leaseOwnerMatches: options.leaseOwnerMatches ?? true,
        },
      ];
    },
    $executeRaw: async () => {
      writes.push('raw');
      return 1;
    },
    runEvent: {
      createMany: async () => {
        writes.push('event');
        return { count: 1 };
      },
    },
    toolCall: {
      createMany: async () => {
        writes.push('tool-call');
        return { count: 1 };
      },
    },
    session: {
      findUniqueOrThrow: async ({ select }: { select?: Record<string, boolean> }) => {
        if (select?.runtimeSessionId) {
          return {
            status: RunStatus.RUNNING,
            runtimeSessionId: 'runtime-1',
            cancelRequestedAt: null,
            runningBgShells: [],
            runningSubagents: [],
          };
        }
        if (select?.taskId) {
          return { status: RunStatus.RUNNING, taskId: null };
        }
        return {
          status: RunStatus.RUNNING,
          taskId: null,
          cancelRequestedAt: null,
          endReason: null,
          completedAt: null,
          archivedAt: null,
          deletedAt: null,
        };
      },
      findUnique: async () => ({ status: RunStatus.RUNNING }),
      update: async () => {
        writes.push('session-update');
        return {};
      },
      updateMany: async () => {
        writes.push('session-update-many');
        return { count: 1 };
      },
    },
    conversationTurn: {
      findMany: async () => [],
      updateMany: async () => {
        writes.push('turn-update');
        return { count: 1 };
      },
      findUnique: async () => ({ kind: 'message' }),
      count: async () => 0,
      findFirst: async () => null,
    },
    conversationTurnStartupFragment: {
      findMany: async () => [],
      updateMany: async () => {
        writes.push('startup-fragment-update');
        return { count: 1 };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
      transactions += 1;
      return fn(tx);
    },
  } as never;
  const realtime = {
    publish: () => undefined,
    notifyInbox: () => undefined,
    publishSessionUpdated: () => undefined,
  } as never;
  return {
    controller: new RunnerApiController(
      prisma,
      { notifySessionQueued: () => undefined } as never,
      realtime,
      {} as never,
      {} as never,
      {} as never,
      { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
    ),
    rawCalls,
    transactions: () => transactions,
    writes,
  };
}

function eventBatch(leaseOwner?: string) {
  return {
    leaseOwner,
    events: [
      {
        seq: 1,
        type: RunEventType.ASSISTANT,
        ts: '2026-08-01T12:00:00.000Z',
        payload: { text: 'done' },
      },
    ],
  };
}

test('a stale process cannot persist events, ack a turn, or finalize a run', async () => {
  for (const invoke of [
    (controller: RunnerApiController) => controller.events({ id: RUNNER_ID }, SESSION_ID, eventBatch(OWNER)),
    (controller: RunnerApiController) =>
      controller.turnComplete({ id: RUNNER_ID }, SESSION_ID, {
        turnId: 'turn-1',
        status: SharedRunStatus.SUCCEEDED,
        leaseOwner: OWNER,
      }),
    (controller: RunnerApiController) =>
      controller.finalize({ id: RUNNER_ID }, SESSION_ID, {
        status: SharedRunStatus.SUCCEEDED,
        leaseOwner: OWNER,
      }),
  ]) {
    const h = harness({ leaseOwnerMatches: false });
    await assert.rejects(invoke(h.controller), ConflictException);
    assert.deepEqual(h.writes, []);
  }
});

test('the same write fences preserve 403 for a session assigned to another runner', async () => {
  for (const invoke of [
    (controller: RunnerApiController) => controller.events({ id: RUNNER_ID }, SESSION_ID, eventBatch(OWNER)),
    (controller: RunnerApiController) =>
      controller.turnComplete({ id: RUNNER_ID }, SESSION_ID, {
        turnId: 'turn-1',
        status: SharedRunStatus.SUCCEEDED,
        leaseOwner: OWNER,
      }),
    (controller: RunnerApiController) =>
      controller.finalize({ id: RUNNER_ID }, SESSION_ID, {
        status: SharedRunStatus.SUCCEEDED,
        leaseOwner: OWNER,
      }),
  ]) {
    const h = harness({ assigned: false });
    await assert.rejects(invoke(h.controller), ForbiddenException);
    assert.deepEqual(h.writes, []);
  }
});

test('legacy omitted owners are accepted only through the SQL NULL-safe fence', async () => {
  const invocations = [
    (controller: RunnerApiController) => controller.events({ id: RUNNER_ID }, SESSION_ID, eventBatch()),
    (controller: RunnerApiController) =>
      controller.turnComplete({ id: RUNNER_ID }, SESSION_ID, {
        turnId: 'turn-1',
        status: SharedRunStatus.SUCCEEDED,
      }),
    (controller: RunnerApiController) =>
      controller.finalize({ id: RUNNER_ID }, SESSION_ID, {
        status: SharedRunStatus.SUCCEEDED,
      }),
  ];

  for (const invoke of invocations) {
    const h = harness();
    await invoke(h.controller);
    assert.ok(h.writes.length > 0);
    // Rendered through the shared renderer rather than joining `args[0]` directly: a composed
    // `Prisma.Sql` reaching this assertion has no `join`, and that TypeError reads as a failure
    // of the controller instead of a stale double.
    const lock = renderRawQuery(h.rawCalls[0]);
    assert.match(lock.text, /"inbox_lease_owner" IS NOT DISTINCT FROM \?::uuid/);
    assert.equal(lock.values[0], null);
  }
});

test('write leaseOwner UUIDs are normalized and malformed values fail before a transaction', async () => {
  const normalized = harness();
  await normalized.controller.events({ id: RUNNER_ID }, SESSION_ID, eventBatch(OWNER.toUpperCase()));
  assert.equal(renderRawQuery(normalized.rawCalls[0]).values[0], OWNER);

  for (const invoke of [
    (controller: RunnerApiController) => controller.events({ id: RUNNER_ID }, SESSION_ID, eventBatch('bad')),
    (controller: RunnerApiController) =>
      controller.turnComplete({ id: RUNNER_ID }, SESSION_ID, {
        turnId: 'turn-1',
        status: SharedRunStatus.SUCCEEDED,
        leaseOwner: 'bad',
      }),
    (controller: RunnerApiController) =>
      controller.finalize({ id: RUNNER_ID }, SESSION_ID, {
        status: SharedRunStatus.SUCCEEDED,
        leaseOwner: 'bad',
      }),
  ]) {
    const h = harness();
    await assert.rejects(invoke(h.controller), BadRequestException);
    assert.equal(h.transactions(), 0);
    assert.deepEqual(h.writes, []);
  }
});
