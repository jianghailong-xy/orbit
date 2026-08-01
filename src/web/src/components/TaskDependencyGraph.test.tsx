import { describe, expect, it } from 'vitest';
import {
  normalizeTaskDependencyGraph,
  taskDependencyBranchKey,
  type TaskDependencyBranchAggregate,
} from '../lib/taskDependencyGraph';
import { buildDependencyFlowElements } from './TaskDependencyGraph';

const graph = normalizeTaskDependencyGraph({
  focusTaskId: 'prerequisite',
  nodes: [
    { id: 'prerequisite', title: 'Prerequisite task', status: 'OPEN' },
    { id: 'dependent', title: 'Dependent task', status: 'OPEN' },
  ],
  edges: [{ sourceTaskId: 'prerequisite', targetTaskId: 'dependent' }],
});

const branchKey = taskDependencyBranchKey('dependent', 'dependents');
const aggregate: TaskDependencyBranchAggregate = {
  id: branchKey,
  branchKey,
  parentTaskId: 'dependent',
  direction: 'dependents',
  remainingCount: 8,
  loadedRemainingCount: 8,
  revealedCount: 0,
  nextBatchCount: 8,
};

describe('TaskDependencyGraph', () => {
  it('keeps task and aggregate wrappers pointer-interactive', () => {
    const { nodes } = buildDependencyFlowElements(
      graph,
      [aggregate],
      new Map([
        ['prerequisite', { x: 0, y: 0 }],
        ['dependent', { x: 0, y: 100 }],
        [branchKey, { x: 0, y: 200 }],
      ]),
      true,
      new Set(),
      null,
      () => undefined,
      undefined,
      null,
      () => undefined,
      () => undefined,
      null,
    );

    expect(nodes.filter((node) => node.type === 'taskDependency')).toHaveLength(2);
    expect(nodes.filter((node) => node.type === 'taskDependencyAggregate')).toHaveLength(1);
    expect(nodes.every((node) => node.style?.pointerEvents === 'all')).toBe(true);
  });
});
