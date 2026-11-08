import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Prisma } from '@prisma/client';
import type { ModelUsage, TurnCompleteRequest } from '@orbit/shared';

import {
  bookedAfter,
  ownCost,
  ownModelUsage,
  reportsRunningTotals,
  runningTotalsBase,
  type RunningTotalsBase,
} from './running-totals';

/**
 * What a Claude turn's own cost and tokens are measured from, and how (running-totals.ts). The
 * database's part — the booking, the re-post, the rows a session had before — is in
 * turn-complete-running-totals.pg.spec.ts.
 */

const counts = (input: number, output: number, cacheWrite: number, cacheRead: number, cost: number): ModelUsage => ({
  inputTokens: input, outputTokens: output, cacheCreationInputTokens: cacheWrite, cacheReadInputTokens: cacheRead, costUSD: cost,
});
const completion = (report: Partial<TurnCompleteRequest> = {}): TurnCompleteRequest => ({
  turnId: 't', status: 'SUCCEEDED' as TurnCompleteRequest['status'], ...report,
});
/** A transaction whose only read is the usage rows a session had before this rule. */
const txWithRows = (rows: unknown[]) => ({ $queryRaw: async () => rows }) as unknown as Prisma.TransactionClient;
const noRows = txWithRows([]);
/** What session.engine_usage_totals holds, as Prisma reads it. */
const stored = (value: unknown) => value as Prisma.JsonValue;

test('only a completion that reports running totals is measured', () => {
  assert.equal(reportsRunningTotals(completion({ modelUsage: {} })), true, 'a Claude completion from any runner');
  assert.equal(reportsRunningTotals(completion({
    runningTotals: { process: 'p', restored: { costUsd: 0, modelUsage: {} } },
  })), true, 'a Claude completion of a process that has used no model yet');
  assert.equal(reportsRunningTotals(completion({ costUsd: 0.5 })), false, 'OpenCode: its turn\'s own cost');
  assert.equal(reportsRunningTotals(completion({
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  })), false, 'Codex: its latest request\'s tokens');
});

test('a turn is measured from its own process: the completion before it, or what the process restored', async () => {
  const booked = { process: 'p1', costUsd: 0.75, modelUsage: { m: counts(10, 1, 0, 0, 0.75) } };
  const restored = { costUsd: 0.25, modelUsage: { m: counts(4, 1, 0, 0, 0.25) } };
  const sameProcess = completion({ modelUsage: {}, runningTotals: { process: 'p1', restored } });
  const newProcess = completion({ modelUsage: {}, runningTotals: { process: 'p2', restored } });
  assert.deepEqual(await runningTotalsBase(noRows, 's', sameProcess, stored(booked)), booked);
  assert.deepEqual(await runningTotalsBase(noRows, 's', newProcess, stored(booked)), restored);
  assert.deepEqual(await runningTotalsBase(noRows, 's', newProcess, null), restored, 'nothing booked yet');
  assert.deepEqual(await runningTotalsBase(noRows, 's', newProcess, stored({ ...booked, process: null })), restored,
    'totals an older runner reported belong to no process this one is');
});

test('an older runner\'s totals are measured from what was booked last', async () => {
  const legacy = completion({ modelUsage: {} });
  const booked = { process: null, costUsd: 0.5, modelUsage: { m: counts(10, 1, 0, 0, 0.5) } };
  assert.deepEqual(await runningTotalsBase(noRows, 's', legacy, stored(booked)), booked);
  assert.deepEqual(await runningTotalsBase(noRows, 's', legacy, null), { costUsd: 0, modelUsage: {} },
    'a session with nothing booked at all starts from nothing, as its conversation did');
  // A session booked before this rule: each model's latest row, which held the totals as reported.
  const before = txWithRows([
    { model: 'm', inputTokens: 100n, outputTokens: 5n, cacheCreationInputTokens: 1n, cacheReadInputTokens: 2n, costUsd: 0.5 },
    { model: 'h', inputTokens: 7n, outputTokens: 1n, cacheCreationInputTokens: 0n, cacheReadInputTokens: 0n, costUsd: 0.25 },
  ]);
  assert.deepEqual(await runningTotalsBase(before, 's', legacy, null), {
    costUsd: 0.75,
    modelUsage: { m: counts(100, 5, 1, 2, 0.5), h: counts(7, 1, 0, 0, 0.25) },
  });
  assert.deepEqual(await runningTotalsBase(before, 's', legacy, stored('not totals')), {
    costUsd: 0.75,
    modelUsage: { m: counts(100, 5, 1, 2, 0.5), h: counts(7, 1, 0, 0, 0.25) },
  }, 'what the column holds is read only when it is totals');
});

test('a turn\'s own share is the difference, never below zero', () => {
  const base: RunningTotalsBase = {
    costUsd: 0.5,
    modelUsage: { m: counts(100, 10, 5, 50, 0.5), gone: counts(1, 1, 1, 1, 0.25) },
  };
  assert.equal(ownCost(0.75, base), 0.25);
  assert.equal(ownCost(0.25, base), 0, 'a count below its base books nothing rather than a negative');
  assert.equal(ownCost(undefined, base), 0);
  assert.equal(ownCost(0.75, { costUsd: 'x', modelUsage: {} }), 0.75, 'a base that is not a number is nothing');
  assert.deepEqual(ownModelUsage({
    m: counts(150, 10, 5, 80, 0.75),
    // A model that joined this turn (a subagent's) is all its own.
    h: counts(7, 1, 0, 0, 0.125),
    // One the turn did not use writes no row.
    idle: counts(0, 0, 0, 0, 0),
  }, { ...base, modelUsage: { ...base.modelUsage, idle: counts(0, 0, 0, 0, 0) } }), {
    m: counts(50, 0, 0, 30, 0.25),
    h: counts(7, 1, 0, 0, 0.125),
  });
  assert.deepEqual(ownModelUsage({ m: counts(10, 10, 5, 10, 0.25) }, base), {}, 'a count that went back books nothing');
});

test('what a row would refuse is refused as it always was', () => {
  // turn-complete-usage-overflow.pg.spec.ts settles these without their reports: a count that is not a
  // number reaches the row's write unchanged, and an empty model entry fails on its first count.
  const base: RunningTotalsBase = { costUsd: 0, modelUsage: {} };
  assert.deepEqual(
    ownModelUsage({ m: { inputTokens: 'many' } as unknown as ModelUsage }, base),
    { m: { inputTokens: 'many', outputTokens: undefined, cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined, costUSD: undefined } },
  );
  assert.throws(() => ownModelUsage({ m: null } as unknown as Record<string, ModelUsage>, base),
    /TypeError|inputTokens/);
  assert.throws(() => bookedAfter(completion({ modelUsage: { m: null } as unknown as Record<string, ModelUsage> })),
    (error: Error) => error instanceof TypeError && /inputTokens/.test(error.message));
});

test('what a session holds after a completion: its totals, and whose', () => {
  assert.deepEqual(bookedAfter(completion({
    costUsd: 0.75,
    modelUsage: { m: { ...counts(1, 2, 3, 4, 0.75), thinkingTokens: 9 } as ModelUsage },
    runningTotals: { process: 'p', restored: { costUsd: 0, modelUsage: {} } },
  })), { process: 'p', costUsd: 0.75, modelUsage: { m: counts(1, 2, 3, 4, 0.75) } });
  assert.deepEqual(bookedAfter(completion({ costUsd: 0.5, modelUsage: {} })),
    { process: null, costUsd: 0.5, modelUsage: {} }, 'an older runner names no process');
});
