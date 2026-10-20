import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LAND_TASK_ROUNDS_PER_CLAIM } from '@orbit/shared';

import { roundText } from './project-integration-event';

/**
 * The timeline's ROUND line (§2.9, §7.2 V6), without a database in the way: the M of "Round N of M"
 * is the most rounds one claim of the job's kind can run, never the check's count. The pg spec
 * beside this one proves the line is written; this one holds what it says.
 */

test('a task landing names its round out of the three one claim can run', () => {
  assert.equal(LAND_TASK_ROUNDS_PER_CLAIM, 3);
  assert.equal(roundText(1, 'LAND_TASK'), 'Round 1 of 3');
  assert.equal(roundText(2, 'LAND_TASK'), 'Round 2 of 3');
});

test('a merge check and a merge into main have one round per claim and name no M', () => {
  assert.equal(roundText(1, 'CHECK_PROMOTION'), 'Round 1');
  assert.equal(roundText(1, 'LAND_PROMOTION'), 'Round 1');
});

test('a kind this build does not know names no M', () => {
  assert.equal(roundText(2, 'SOMETHING_NEW'), 'Round 2');
});
