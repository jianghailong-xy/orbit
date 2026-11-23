/**
 * §8.4: the SCHEDULE_OVER_BUDGET refusal names the Run now presses of sessions and tokens started in the past 7 days, then
 * the number the owner allowed, each with its own singular or plural. The pg case in schedule-budget.pg.spec.ts reads it off a real refusal.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scheduleOverBudgetMessage } from './schedule-start-check';

test('over budget: the refusal names the runs started, not the limit (4 started of 1 allowed)', () => {
  assert.equal(
    scheduleOverBudgetMessage(4, 1),
    'Run now by a session or a token has started 4 runs of this schedule in the past 7 days; ' +
      'its owner allowed 1 a week. Only the owner can run it now.',
  );
});

test('over budget: one run started is "1 run"', () => {
  assert.equal(
    scheduleOverBudgetMessage(1, 1),
    'Run now by a session or a token has started 1 run of this schedule in the past 7 days; ' +
      'its owner allowed 1 a week. Only the owner can run it now.',
  );
});

test('over budget: the allowed number is the envelope\'s, whatever was started', () => {
  assert.equal(
    scheduleOverBudgetMessage(7, 7),
    'Run now by a session or a token has started 7 runs of this schedule in the past 7 days; ' +
      'its owner allowed 7 a week. Only the owner can run it now.',
  );
});
