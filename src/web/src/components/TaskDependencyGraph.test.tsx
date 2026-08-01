import { describe, expect, it } from 'vitest';
import {
  normalizeTaskDependencyGraph,
  taskDependencyBranchKey,
  type TaskDependencyBranchAggregate,
} from '../lib/taskDependencyGraph';
import {
  buildDependencyFlowElements,
  dependencyGraphNodeIsVisible,
  viewportForFocusedDependencyGraph,
} from './TaskDependencyGraph';

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
  it('fits the whole graph when it remains readable', () => {
    const plan = viewportForFocusedDependencyGraph(
      { x: 100, y: 80, width: 500, height: 240 },
      { x: 100, y: 80 },
      { width: 1000, height: 600 },
      0.2,
    );

    expect(plan?.requiresPanning).toBe(false);
    expect(plan?.viewport.zoom).toBe(1);
    expect(plan?.viewport.x).toBe(150);
    expect(plan?.viewport.y).toBe(100);
  });

  it('centers the current task at a readable zoom when the graph is too large', () => {
    const plan = viewportForFocusedDependencyGraph(
      { x: 0, y: 0, width: 5000, height: 3000 },
      { x: 4200, y: 2400 },
      { width: 1000, height: 600 },
      0.2,
    );

    expect(plan?.requiresPanning).toBe(true);
    expect(plan?.viewport.zoom).toBe(0.75);
    expect(plan && plan.viewport.x + (4200 + 204 / 2) * plan.viewport.zoom).toBe(500);
    expect(plan && plan.viewport.y + (2400 + 76 / 2) * plan.viewport.zoom).toBe(300);
  });

  it('waits for a measurable canvas before positioning the graph', () => {
    expect(
      viewportForFocusedDependencyGraph(
        { x: 0, y: 0, width: 5000, height: 3000 },
        { x: 0, y: 0 },
        { width: 0, height: 600 },
        0.2,
      ),
    ).toBeNull();
  });

  it('detects when a keyboard-focused node needs to be brought into view', () => {
    const viewport = { x: 100, y: 80, zoom: 0.75 };
    const canvas = { width: 1000, height: 600 };

    expect(dependencyGraphNodeIsVisible(viewport, { x: 100, y: 100 }, canvas, 24)).toBe(true);
    expect(dependencyGraphNodeIsVisible(viewport, { x: 1200, y: 100 }, canvas, 24)).toBe(false);
  });

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
