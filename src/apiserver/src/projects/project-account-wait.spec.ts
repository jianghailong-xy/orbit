import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectAccountWait } from './project-open-item.service';

test('held tasks are one Needs you row, with the hold that lifts first', () => {
  assert.equal(projectAccountWait(new Map()), null);
  const one = projectAccountWait(new Map([['t1', { reason: 'Waiting for an account: Cursor said "Add a payment method". Next try at 21:19.', until: '2026-11-22T21:19:00.000Z' }]]));
  assert.equal(one?.title, '1 task waits for an account');
  const two = projectAccountWait(new Map([
    ['t1', { reason: 'later', until: '2026-11-22T23:00:00.000Z' }],
    ['t2', { reason: 'sooner', until: '2026-11-22T21:19:00.000Z' }],
  ]));
  assert.equal(two?.title, '2 tasks wait for an account');
  assert.equal(two?.detailLine, 'sooner');
  assert.deepEqual(two?.taskIds, ['t1', 't2']);
});

import { relaxedRunSentence } from '../tasks/task-route-decision';

test('the relaxed-run sentence is the reason that names the pin, and only that', () => {
  const said = "Pinned to cursor, which can't run now (Cursor said \"Add a payment method\"); runs on codex instead, on the same engine, at tier M";
  assert.equal(relaxedRunSentence(['Tier M', said]), said);
  assert.equal(relaxedRunSentence(['Tier M']), null);
  assert.equal(relaxedRunSentence(null), null);
});
