import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskStatus } from '@orbit/shared';
import { DependencyEdge } from './task-dependencies';
import { DagOp, effectiveOps, findCycle, resultingEdges, stateChanges } from './task-dag';

const e = (taskId: string, dependsOnTaskId: string): DependencyEdge => ({ taskId, dependsOnTaskId });
const add = (taskId: string, dependsOnTaskId: string): DagOp => ({ op: 'add', taskId, dependsOnTaskId });
const rm = (taskId: string, dependsOnTaskId: string): DagOp => ({ op: 'remove', taskId, dependsOnTaskId });

const sorted = (edges: DependencyEdge[]) =>
  [...edges].map((x) => `${x.taskId}->${x.dependsOnTaskId}`).sort();

test('removals are applied before additions, so a re-point ends with the edge present', () => {
  // The order the ops arrive in must not decide the outcome; "remove A->B, add A->B" is how an
  // agent naturally writes "keep this edge but change its neighbours".
  const out = resultingEdges([e('a', 'b')], [add('a', 'b'), rm('a', 'b')]);

  assert.deepEqual(sorted(out), ['a->b']);
});

test('the resulting graph is the union of what survived and what was added', () => {
  const out = resultingEdges([e('a', 'b'), e('b', 'c')], [rm('b', 'c'), add('b', 'd')]);

  assert.deepEqual(sorted(out), ['a->b', 'b->d']);
});

test('a duplicate add does not duplicate the edge', () => {
  const out = resultingEdges([e('a', 'b')], [add('a', 'b')]);

  assert.equal(out.length, 1);
});

test('an acyclic graph reports no cycle', () => {
  assert.equal(findCycle([e('a', 'b'), e('b', 'c'), e('a', 'c')]), null);
});

test('a cycle comes back as the path that closes it', () => {
  // The path rather than a boolean: the batch is rejected whole, and a proposer told only "there
  // is a cycle" has to bisect fourteen edges to find it.
  const cycle = findCycle([e('a', 'b'), e('b', 'c'), e('c', 'a')]);

  assert.ok(cycle);
  assert.equal(cycle[0], cycle[cycle.length - 1]);
  assert.deepEqual(new Set(cycle), new Set(['a', 'b', 'c']));
});

test('a self-edge is a cycle', () => {
  assert.deepEqual(findCycle([e('a', 'a')]), ['a', 'a']);
});

test('a diamond is not a cycle, however many times its join is reached', () => {
  // The case a naive "visited on this walk" check gets wrong: `d` is reachable by two paths, and
  // treating the second arrival as a cycle rejects a shape every real DAG contains.
  assert.equal(findCycle([e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')]), null);
});

test('a cycle is found even when the walk starts outside it', () => {
  assert.ok(findCycle([e('x', 'a'), e('a', 'b'), e('b', 'a')]));
});

test('a long chain does not overflow the stack', () => {
  // 250-task lists are this deployment's actual shape; a recursive walk is a frame per edge.
  const chain = Array.from({ length: 5000 }, (_, i) => e(`n${i}`, `n${i + 1}`));

  assert.equal(findCycle(chain), null);
  assert.ok(findCycle([...chain, e('n5000', 'n0')]));
});

test('a batch containing a removal is judged on the graph it produces, not op by op', () => {
  // Per-edge checking against the graph as it stands would reject this: at the moment `add c->a`
  // is considered, `a` still depends on `c`. The removal in the same batch is what makes it legal,
  // and rejecting a legal restructure is as bad as accepting an illegal one.
  const current = [e('a', 'c')];
  const ops = [rm('a', 'c'), add('c', 'a')];

  assert.equal(findCycle(resultingEdges(current, ops)), null);
});

const statuses = (m: Record<string, TaskStatus>) => new Map(Object.entries(m));

test('a task whose last unmet prerequisite is removed becomes READY', () => {
  // The change worth approving: the sweep starts these within the minute.
  const changes = stateChanges(
    [e('a', 'b')],
    [],
    statuses({ a: TaskStatus.OPEN, b: TaskStatus.OPEN }),
  );

  assert.deepEqual(changes, [{ taskId: 'a', from: 'BLOCKED', to: 'NONE' }]);
});

test('a task gaining an unfinished prerequisite stops being runnable', () => {
  const changes = stateChanges(
    [],
    [e('a', 'b')],
    statuses({ a: TaskStatus.OPEN, b: TaskStatus.IN_PROGRESS }),
  );

  assert.deepEqual(changes, [{ taskId: 'a', from: 'NONE', to: 'BLOCKED' }]);
});

test('a task gaining an already-done prerequisite is released, not blocked', () => {
  const changes = stateChanges([], [e('a', 'b')], statuses({ a: TaskStatus.OPEN, b: TaskStatus.DONE }));

  assert.deepEqual(changes, [{ taskId: 'a', from: 'NONE', to: 'READY' }]);
});

test('a task whose prerequisites are merely rearranged is not reported', () => {
  // Only real changes: a preview listing every touched task teaches the reader to skim it.
  const changes = stateChanges(
    [e('a', 'b')],
    [e('a', 'c')],
    statuses({ a: TaskStatus.OPEN, b: TaskStatus.OPEN, c: TaskStatus.OPEN }),
  );

  assert.deepEqual(changes, []);
});

test('a failed prerequisite escalates the dependent rather than merely blocking it', () => {
  const changes = stateChanges([], [e('a', 'b')], statuses({ a: TaskStatus.OPEN, b: TaskStatus.FAILED }));

  assert.deepEqual(changes, [{ taskId: 'a', from: 'NONE', to: 'BLOCKED_FAILED' }]);
});

test('adding an edge that exists and removing one that does not are named as no-ops', () => {
  // A proposal that is entirely no-ops means the agent read a stale graph — which is exactly when
  // a human should not be clicking approve.
  const { effective, noop } = effectiveOps([e('a', 'b')], [add('a', 'b'), rm('a', 'c'), add('b', 'c')]);

  assert.deepEqual(effective, [add('b', 'c')]);
  assert.equal(noop.length, 2);
});
