import assert from 'node:assert/strict';
import { test } from 'node:test';
import { takeBudget, type MaterialisationBudget } from './tasks.service';

const R = 'runner-1';
const L = 'list-1';

const budget = (runner: Array<[string, number]>, list: Array<[string, number]> = []): MaterialisationBudget => ({
  runner: new Map(runner),
  list: new Map(list),
});

/**
 * The sweep used to dispatch every ready task in one pass, and the cap only bit when a runner
 * tried to claim. A released campaign therefore became one PENDING session per task — ~10 KB
 * each, indistinguishable from real work in every session-scoped view — all waiting on a cap that
 * permits one at a time. This decides how many are worth creating at all.
 */
test('a cap of one lets exactly one through', () => {
  const b = budget([[R, 1]]);

  assert.equal(takeBudget(b, R, null), true);
  assert.equal(takeBudget(b, R, null), false);
  assert.equal(takeBudget(b, R, null), false);
});

test('an exhausted budget refuses without going negative', () => {
  // It is read again on the next sweep; a negative would take extra passes to climb back.
  const b = budget([[R, 0]]);

  assert.equal(takeBudget(b, R, null), false);
  assert.equal(b.runner.get(R), 0);
});

test('a runner with no cap is unbounded', () => {
  // Absent from the map means no `max_concurrent`, which is not the same as a cap of zero.
  const b = budget([]);

  for (let i = 0; i < 100; i++) assert.equal(takeBudget(b, R, null), true);
});

test("a list's cap holds even when its runner has room", () => {
  const b = budget([[R, 10]], [[L, 2]]);

  assert.deepEqual([takeBudget(b, R, L), takeBudget(b, R, L), takeBudget(b, R, L)], [true, true, false]);
  // The runner spent two, not three: a refused task materialises nothing.
  assert.equal(b.runner.get(R), 8);
});

test("a runner's cap holds even when the list has room", () => {
  const b = budget([[R, 1]], [[L, 10]]);

  assert.deepEqual([takeBudget(b, R, L), takeBudget(b, R, L)], [true, false]);
  assert.equal(b.list.get(L), 9);
});

test('a task in a capped list also spends its runner — it is one session either way', () => {
  // Charging only the list would let several capped lists on one runner overrun the machine.
  const b = budget([[R, 5]], [[L, 5]]);

  takeBudget(b, R, L);

  assert.equal(b.runner.get(R), 4);
  assert.equal(b.list.get(L), 4);
});

test('a task with no list is charged to the runner only', () => {
  const b = budget([[R, 5]], [[L, 5]]);

  takeBudget(b, R, null);

  assert.equal(b.runner.get(R), 4);
  assert.equal(b.list.get(L), 5);
});

test('two runners hold separate budgets', () => {
  const b = budget([[R, 1], ['runner-2', 1]]);

  assert.equal(takeBudget(b, R, null), true);
  assert.equal(takeBudget(b, 'runner-2', null), true);
  assert.equal(takeBudget(b, R, null), false);
});
