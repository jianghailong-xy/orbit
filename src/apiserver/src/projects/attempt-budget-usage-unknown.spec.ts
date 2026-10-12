import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateAttemptBudget, ZERO_ATTEMPT_SPEND } from './attempt-budget';
import { DEFAULT_ATTEMPT_BUDGET } from './convergence-contract';

/**
 * F1: a runtime that reports no cost (DeepSeek Harness) leaves the attempt's cost unknown. The budget
 * reads that as BD3's UNMEASURED, never as $0 spent, and a known cost reads exactly as before.
 */
const BUDGET = { ...DEFAULT_ATTEMPT_BUDGET, maxCostMicros: 5_000_000 };
const cost = (costMicros: number | null) =>
  evaluateAttemptBudget(BUDGET, { ...ZERO_ATTEMPT_SPEND, costMicros }).readings.find((reading) => reading.dimension === 'COST');

test('F1 attempt budget reads an unknown cost as unmeasured, not as zero spent', () => {
  assert.deepEqual(cost(null), { dimension: 'COST', state: 'UNMEASURED', limit: 5_000_000, spent: null, remaining: null });
  const report = evaluateAttemptBudget(BUDGET, { ...ZERO_ATTEMPT_SPEND, costMicros: null, turns: BUDGET.maxTurns as number });
  assert.equal(report.exhausted, 'TURNS', 'an unknown cost hides no other dimension');
});

test('F1 attempt budget keeps a measured cost, zero included', () => {
  assert.deepEqual(cost(0), { dimension: 'COST', state: 'WITHIN', limit: 5_000_000, spent: 0, remaining: 5_000_000 });
  assert.deepEqual(cost(5_000_000), { dimension: 'COST', state: 'EXHAUSTED', limit: 5_000_000, spent: 5_000_000, remaining: 0 });
});
