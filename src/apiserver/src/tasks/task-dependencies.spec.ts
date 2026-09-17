import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskStatus } from '@orbit/shared';
import {
  canRun,
  computeDependencyState,
  dependencyStateFromCounts,
  statusPrerequisites,
  wouldCreateCycle,
  wouldReplacementCreateCycle,
  type DependencyEdge,
} from './task-dependencies';

test('no prerequisites -> NONE (and runnable)', () => {
  const state = computeDependencyState([]);
  assert.equal(state, 'NONE');
  assert.equal(canRun(state), true);
});

test('all prerequisites DONE -> READY (and runnable)', () => {
  const state = computeDependencyState(statusPrerequisites([TaskStatus.DONE, TaskStatus.DONE]));
  assert.equal(state, 'READY');
  assert.equal(canRun(state), true);
});

test('any prerequisite still open/in-progress -> BLOCKED (not runnable)', () => {
  assert.equal(computeDependencyState(statusPrerequisites([TaskStatus.DONE, TaskStatus.OPEN])), 'BLOCKED');
  assert.equal(computeDependencyState(statusPrerequisites([TaskStatus.IN_PROGRESS])), 'BLOCKED');
  assert.equal(canRun('BLOCKED'), false);
});

test('a CANCELLED prerequisite escalates to BLOCKED_FAILED even if others are DONE', () => {
  const state = computeDependencyState(statusPrerequisites([TaskStatus.DONE, TaskStatus.CANCELLED]));
  assert.equal(state, 'BLOCKED_FAILED');
  assert.equal(canRun(state), false);
});

test('CANCELLED wins over a still-pending prerequisite', () => {
  assert.equal(
    computeDependencyState(statusPrerequisites([TaskStatus.OPEN, TaskStatus.CANCELLED])),
    'BLOCKED_FAILED',
  );
});

test('a FAILED prerequisite escalates to BLOCKED_FAILED (needs a human, like CANCELLED)', () => {
  const state = computeDependencyState(statusPrerequisites([TaskStatus.DONE, TaskStatus.FAILED]));
  assert.equal(state, 'BLOCKED_FAILED');
  assert.equal(canRun(state), false);
});

/**
 * The tally form is the one the project task page uses, because counting in SQL is what keeps a
 * 118-node project to one query. Two spellings of a rule are two rules unless something holds them
 * together, so this walks every multiset of prerequisite facts up to three long and requires the
 * two to agree on all of them.
 *
 * A fact is a status AND whether that prerequisite's work is on the project's integration line
 * (§2.5 J9): the landing is the second dimension this rule reads, and a sweep over statuses alone
 * agreed on every multiset for months while the graph drew READY on tasks the dispatcher refused.
 */
test('dependencyStateFromCounts agrees with computeDependencyState on every multiset', () => {
  const statuses = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.DONE, TaskStatus.CANCELLED, TaskStatus.FAILED];
  // `undefined` is its own case, not a synonym for `true`: it is what every caller that gathers no
  // landing facts sends, and what the rule promises to read as "nothing to land".
  const landings = [true, false, undefined];
  const facts = statuses.flatMap((status) => landings.map((landed) => ({ status, landed })));
  const multisets: { status: TaskStatus; landed?: boolean }[][] = [[]];
  for (let size = 0; size < 3; size += 1) {
    for (const prefix of multisets.filter((m) => m.length === size)) {
      for (const fact of facts) multisets.push([...prefix, fact]);
    }
  }

  for (const prerequisites of multisets) {
    assert.equal(
      dependencyStateFromCounts({
        prerequisites: prerequisites.length,
        terminal: prerequisites.filter((p) => p.status === TaskStatus.CANCELLED || p.status === TaskStatus.FAILED).length,
        done: prerequisites.filter((p) => p.status === TaskStatus.DONE).length,
        // Exactly what the graph query counts: `landed = false`, over every prerequisite.
        unlanded: prerequisites.filter((p) => p.landed === false).length,
      }),
      // Objects with a `status` key, never a bare status array: this rule reads a verification
      // gate and a landing beside each status, and a plain array reaches it as facts with no
      // `status` at all — which answers BLOCKED for every multiset and would have made this
      // agreement test pass by accident on nothing.
      computeDependencyState(prerequisites),
      prerequisites.map((p) => `${p.status}/${p.landed ?? 'unknown'}`).join(',') || '(no prerequisites)',
    );
  }
});

/** The two spellings are not vacuously equal: the landing dimension moves both of them. */
test('a DONE prerequisite that has not landed is BLOCKED in both spellings', () => {
  assert.equal(
    computeDependencyState([{ status: TaskStatus.DONE, landed: false }]),
    'BLOCKED',
  );
  assert.equal(
    dependencyStateFromCounts({ prerequisites: 1, terminal: 0, done: 1, unlanded: 1 }),
    'BLOCKED',
  );
  assert.equal(
    dependencyStateFromCounts({ prerequisites: 1, terminal: 0, done: 1, unlanded: 0 }),
    'READY',
  );
});

test('self-dependency is a cycle', () => {
  assert.equal(wouldCreateCycle([], 'A', 'A'), true);
});

test('a fresh edge into an empty graph is fine', () => {
  assert.equal(wouldCreateCycle([], 'A', 'B'), false);
});

test('direct back-edge forms a cycle (A->B then B->A)', () => {
  const edges: DependencyEdge[] = [{ taskId: 'A', dependsOnTaskId: 'B' }];
  // B depends on A would close A->B->A.
  assert.equal(wouldCreateCycle(edges, 'B', 'A'), true);
});

test('transitive back-edge forms a cycle (A->B->C then C->A)', () => {
  const edges: DependencyEdge[] = [
    { taskId: 'A', dependsOnTaskId: 'B' },
    { taskId: 'B', dependsOnTaskId: 'C' },
  ];
  assert.equal(wouldCreateCycle(edges, 'C', 'A'), true);
});

test('a diamond (shared prerequisite) is not a cycle', () => {
  // D depends on B and C; B and C both depend on A. Adding D->C must stay acyclic.
  const edges: DependencyEdge[] = [
    { taskId: 'B', dependsOnTaskId: 'A' },
    { taskId: 'C', dependsOnTaskId: 'A' },
    { taskId: 'D', dependsOnTaskId: 'B' },
  ];
  assert.equal(wouldCreateCycle(edges, 'D', 'C'), false);
});

test('an unrelated new edge in a populated graph is fine', () => {
  const edges: DependencyEdge[] = [
    { taskId: 'A', dependsOnTaskId: 'B' },
    { taskId: 'C', dependsOnTaskId: 'D' },
  ];
  assert.equal(wouldCreateCycle(edges, 'A', 'D'), false);
});

test('replacing prerequisites rejects a cycle through any proposed edge', () => {
  const edges: DependencyEdge[] = [
    { taskId: 'B', dependsOnTaskId: 'C' },
    { taskId: 'C', dependsOnTaskId: 'A' },
  ];
  assert.equal(wouldReplacementCreateCycle(edges, 'A', ['D', 'B']), true);
});

test("replacing prerequisites ignores the task's outgoing edges being removed", () => {
  const edges: DependencyEdge[] = [
    { taskId: 'A', dependsOnTaskId: 'B' },
    { taskId: 'C', dependsOnTaskId: 'D' },
  ];
  assert.equal(wouldReplacementCreateCycle(edges, 'A', ['C']), false);
  assert.equal(wouldReplacementCreateCycle(edges, 'A', []), false);
});
