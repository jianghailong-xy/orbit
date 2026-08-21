/**
 * §13.6's supersession rules, as pure functions.
 *
 * The pg spec beside this one proves the database refuses what these refuse. This one exists for
 * the half a database cannot answer: WHICH rule was broken, and what a client should show. The
 * whole point of the unit is that a cancelled attempt somebody replaced and a cancelled attempt
 * somebody dropped stop reading the same, so "they read differently" has to be a test.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TASK_SUPERSESSION_MAX_HOPS,
  successorChain,
  supersededByAbsentReason,
  supersessionRefusal,
  taskOutcome,
} from './task-supersession';

const OWNER = 'owner-1';
const PROJECT = 'project-1';

function link(over: Partial<Parameters<typeof supersessionRefusal>[0]> = {}) {
  return supersessionRefusal({
    taskId: 'old',
    status: 'CANCELLED',
    successor: { id: 'new', ownerId: OWNER, projectId: PROJECT },
    ownerId: OWNER,
    projectId: PROJECT,
    ...over,
  });
}

test('a cancelled attempt may name a later attempt in the same project', () => {
  assert.equal(link(), null);
});

test('a FAILED attempt may too — supersession preserves the failure, it does not clean it up', () => {
  assert.equal(link({ status: 'FAILED' }), null);
});

test('a task that has not stopped cannot name a successor', () => {
  for (const status of ['OPEN', 'IN_PROGRESS', 'DONE']) {
    const refusal = link({ status });
    assert.match(String(refusal), /Only a CANCELLED or FAILED task/);
    assert.match(String(refusal), new RegExp(status));
  }
});

test('a task cannot supersede itself', () => {
  assert.match(
    String(link({ successor: { id: 'old', ownerId: OWNER, projectId: PROJECT } })),
    /cannot supersede itself/,
  );
});

test("a successor in another tenant is refused, whatever the project column says", () => {
  assert.match(
    String(link({ successor: { id: 'new', ownerId: 'someone-else', projectId: PROJECT } })),
    /different owner/,
  );
});

test('a successor in another project is refused — nobody could count it', () => {
  assert.match(
    String(link({ successor: { id: 'new', ownerId: OWNER, projectId: 'project-2' } })),
    /same project/,
  );
});

test('two tasks in no project at all are still the same project as each other', () => {
  assert.equal(
    link({ projectId: null, successor: { id: 'new', ownerId: OWNER, projectId: null } }),
    null,
  );
  // ...and one of each is not.
  assert.match(
    String(link({ projectId: null, successor: { id: 'new', ownerId: OWNER, projectId: PROJECT } })),
    /same project/,
  );
});

test('unlinking is never refused: null successor is always allowed', () => {
  assert.equal(link({ successor: null, status: 'OPEN' }), null);
});

// ---------------------------------------------------------------------------------------------
// What a client shows
// ---------------------------------------------------------------------------------------------

test('failed, cancelled and superseded are three different words', () => {
  assert.equal(taskOutcome({ status: 'FAILED', terminalReason: null }), 'FAILED');
  assert.equal(taskOutcome({ status: 'CANCELLED', terminalReason: null }), 'CANCELLED');
  assert.equal(taskOutcome({ status: 'CANCELLED', terminalReason: 'SUPERSEDED' }), 'SUPERSEDED');
  assert.equal(taskOutcome({ status: 'CANCELLED', terminalReason: 'ABANDONED' }), 'ABANDONED');
  // The one that matters most: a FAILED attempt that was re-run reads as superseded WITHOUT the
  // failure being rewritten anywhere — `status` still says FAILED.
  assert.equal(taskOutcome({ status: 'FAILED', terminalReason: 'SUPERSEDED' }), 'SUPERSEDED');
});

test('an unrecognised status reads as itself, never as a healthy default', () => {
  assert.equal(taskOutcome({ status: 'PARKED', terminalReason: null }), 'PARKED');
});

test('"superseded but the successor is gone" is not "never superseded"', () => {
  assert.equal(
    supersededByAbsentReason({ supersededByTaskId: 'new', terminalReason: 'SUPERSEDED' }),
    null,
  );
  assert.equal(
    supersededByAbsentReason({ supersededByTaskId: null, terminalReason: 'SUPERSEDED' }),
    'SUCCESSOR_DELETED',
  );
  assert.equal(
    supersededByAbsentReason({ supersededByTaskId: null, terminalReason: null }),
    'NOT_SUPERSEDED',
  );
  assert.equal(
    supersededByAbsentReason({ supersededByTaskId: null, terminalReason: 'ABANDONED' }),
    'NOT_SUPERSEDED',
  );
});

// ---------------------------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------------------------

test('the chain runs from an attempt to the one that is actually live', () => {
  const edges = new Map<string, string | null>([
    ['r1', 'r4'],
    ['r2', 'r4'],
    ['r3', 'r4'],
    ['r4', null],
  ]);
  assert.deepEqual(successorChain('r1', edges), { chain: ['r4'], truncated: false });
  // Three attempts, one successor: each of them answers "so who ended up doing this" with r4.
  assert.deepEqual(successorChain('r3', edges).chain, ['r4']);
  // The live one has nothing after it.
  assert.deepEqual(successorChain('r4', edges), { chain: [], truncated: false });
});

test('a chain of chains is followed all the way down', () => {
  const edges = new Map<string, string | null>([
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
  ]);
  assert.deepEqual(successorChain('a', edges).chain, ['b', 'c', 'd']);
});

test('a cycle reports a truncation instead of hanging', () => {
  // The database refuses to write one (0128's trigger walks it). A reader that loops forever on
  // data it was told is impossible is worse than one that says what it found.
  const edges = new Map<string, string | null>([
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'a'],
  ]);
  const { chain, truncated } = successorChain('a', edges);
  assert.equal(truncated, true);
  assert.deepEqual(chain, ['b', 'c']);
});

test('a chain longer than the database allows is truncated, not walked forever', () => {
  const edges = new Map<string, string | null>();
  for (let i = 0; i < TASK_SUPERSESSION_MAX_HOPS + 10; i += 1) edges.set(`t${i}`, `t${i + 1}`);
  const { chain, truncated } = successorChain('t0', edges);
  assert.equal(truncated, true);
  assert.equal(chain.length, TASK_SUPERSESSION_MAX_HOPS);
});
