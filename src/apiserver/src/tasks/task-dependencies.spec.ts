import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskStatus } from '@orbit/shared';
import {
  canRun,
  computeDependencyState,
  wouldCreateCycle,
  type DependencyEdge,
} from './task-dependencies';

test('no prerequisites -> NONE (and runnable)', () => {
  const state = computeDependencyState([]);
  assert.equal(state, 'NONE');
  assert.equal(canRun(state), true);
});

test('all prerequisites DONE -> READY (and runnable)', () => {
  const state = computeDependencyState([TaskStatus.DONE, TaskStatus.DONE]);
  assert.equal(state, 'READY');
  assert.equal(canRun(state), true);
});

test('any prerequisite still open/in-progress -> BLOCKED (not runnable)', () => {
  assert.equal(computeDependencyState([TaskStatus.DONE, TaskStatus.OPEN]), 'BLOCKED');
  assert.equal(computeDependencyState([TaskStatus.IN_PROGRESS]), 'BLOCKED');
  assert.equal(canRun('BLOCKED'), false);
});

test('a CANCELLED prerequisite escalates to BLOCKED_FAILED even if others are DONE', () => {
  const state = computeDependencyState([TaskStatus.DONE, TaskStatus.CANCELLED]);
  assert.equal(state, 'BLOCKED_FAILED');
  assert.equal(canRun(state), false);
});

test('CANCELLED wins over a still-pending prerequisite', () => {
  assert.equal(
    computeDependencyState([TaskStatus.OPEN, TaskStatus.CANCELLED]),
    'BLOCKED_FAILED',
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
