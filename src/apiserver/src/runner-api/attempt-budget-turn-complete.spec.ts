import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { AttemptBudgetMeterService } from '../projects/attempt-budget-meter.service';
import { RunnerApiController } from './runner-api.controller';

/**
 * Unit T5's wiring: where the six-dimension budget is actually charged.
 *
 * The budget is charged from the runner's turn-complete and from nowhere else, because that is the
 * moment this turn's numbers, its events and its tool calls are all COMMITTED — and it is the only
 * moment at which a wind-down has somewhere to land, since the worker is between turns. A sweep on
 * a clock would be the removed control loop's shape and is refused by the project's own red line.
 *
 * What is pinned here is that the call happens AFTER the transaction — a spend read inside it would
 * read the numbers this very turn is still writing — and that a steer does not trigger one, because
 * a steer settles only its own row and books no turn, no cost and no tool call. That a metering
 * failure cannot fail this request lives one level down, in `meterQuietly`, and is tested there.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const TURN_ID = '33333333-3333-4333-8333-333333333333';

function harness(options: { kind?: 'steer' | 'message' } = {}) {
  const kind = options.kind ?? 'message';
  /** Every session write the transaction made, in order, so "after the commit" is observable. */
  const sessionWrites: Record<string, unknown>[] = [];
  const metered: string[] = [];
  /** Whether the session numbers were already written when the meter ran. */
  let writesAtMeterTime = -1;
  let committed = false;

  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID, leaseOwnerMatches: true }],
    $executeRaw: async () => 1,
    conversationTurn: {
      findFirst: async ({ where }: { where: { kind?: string } }) =>
        where.kind === 'steer' && kind === 'steer' ? { id: TURN_ID } : null,
      findUnique: async () => ({ kind }),
      updateMany: async () => ({ count: 1 }),
      count: async () => 0,
    },
    session: {
      findUniqueOrThrow: async () => ({
        status: RunStatus.RUNNING,
        taskId: null,
        mergeStatus: null,
        mergedSourceSha: null,
        retryAt: null,
      }),
      findUnique: async () => ({ status: RunStatus.RUNNING }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        sessionWrites.push(data);
        return { count: 1 };
      },
    },
    sessionDiff: { upsert: async () => undefined },
    llmUsage: { createMany: async () => undefined },
    task: { updateMany: async () => ({ count: 1 }), findUnique: async () => null },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => unknown) => {
      const out = await fn(tx);
      committed = true;
      return out;
    },
  } as never;
  const realtime = {
    notifyInbox: () => undefined,
    publish: () => undefined,
    publishQueuedTurnsChanged: () => undefined,
  } as never;
  const budgets = {
    meterQuietly: async (sessionId: string) => {
      assert.equal(committed, true, 'the spend must be metered after the turn commits, not inside it');
      writesAtMeterTime = sessionWrites.length;
      metered.push(sessionId);
    },
  } as unknown as AttemptBudgetMeterService;

  const controller = new RunnerApiController(
    prisma,
    { notifySessionQueued: () => undefined } as never,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
    budgets,
  );
  return { controller, metered, sessionWrites, writesAtMeterTime: () => writesAtMeterTime };
}

const complete = (h: ReturnType<typeof harness>, subtype: string) =>
  h.controller.turnComplete({ id: RUNNER_ID }, SESSION_ID, {
    turnId: TURN_ID,
    status: 'SUCCEEDED',
    subtype,
    numTurns: 1,
    costUsd: 0.25,
  } as never);

test('a completed turn charges the attempt budget once, after the turn is committed', async () => {
  const h = harness();

  const out = await complete(h, 'message');

  assert.deepEqual(out, { ok: true, status: RunStatus.AWAITING_INPUT });
  assert.deepEqual(h.metered, [SESSION_ID]);
  // The turn's own numbers are in the session row by then, which is the whole reason the call is
  // here and not inside the transaction: the meter reads `num_turns` and `cost_usd` back out.
  assert.equal(h.writesAtMeterTime(), 1);
  assert.equal(h.sessionWrites[0].numTurns !== undefined, true);
});

test('a steer completion charges nothing — it settles its own row and no spend', async () => {
  const h = harness({ kind: 'steer' });

  await complete(h, 'steer');

  assert.deepEqual(h.metered, []);
  assert.equal(h.sessionWrites.length, 0);
});
