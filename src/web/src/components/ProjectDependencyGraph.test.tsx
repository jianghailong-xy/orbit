// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { planProjectGraphViewport } from './ProjectDependencyGraph';
import {
  expandRunMarks,
  layoutProjectDependencyGraph,
  markStatus,
  projectGraphOverview,
  PROJECT_GRAPH_FOLD_WIDTH,
  PROJECT_GRAPH_NODE_WIDTH,
  type ProjectDependencyGraphResponse,
  type ProjectRunMark,
} from '../lib/projectDependencyGraph';

// jsdom because the module imports React Flow, which reaches for a document as it loads. Nothing
// here renders: what is under test is the arithmetic that decides where a canvas opens.

/** A project shaped like the one that used to be refused: one task after another, N long. */
const chain = (length: number, done: number): ProjectDependencyGraphResponse => ({
  marks: Array.from({ length }, (_, i) => ({
    kind: 'TASK' as const,
    id: `t${i}`,
    taskId: `t${i}`,
    title: `Step ${i + 1}`,
    status: i < done ? 'DONE' : 'OPEN',
    parentTaskId: null,
  })),
  edges: Array.from({ length: Math.max(length - 1, 0) }, (_, i) => ({
    sourceMarkId: `t${i}`,
    targetMarkId: `t${i + 1}`,
  })),
  taskCount: length,
  folded: false,
  truncated: false,
  limits: { maxTasks: 50_000, maxMarks: 500 },
});

const overviewOf = (graph: ProjectDependencyGraphResponse) =>
  projectGraphOverview(layoutProjectDependencyGraph(graph));

/** The project page's own strip, at a typical content width. */
const STRIP = { width: 1100, height: 420 };

describe('projectGraphOverview', () => {
  it('bounds every unit and points at the first one still unfinished', () => {
    const overview = overviewOf(chain(118, 12));

    expect(overview.unitCount).toBe(118);
    // 118 nodes laid out left to right: thousands of pixels wide, one node tall.
    expect(overview.bounds.width).toBeGreaterThan(118 * PROJECT_GRAPH_NODE_WIDTH);
    expect(overview.bounds.height).toBeLessThan(200);

    const placements = layoutProjectDependencyGraph(chain(118, 12)).placements;
    const thirteenth = placements.find((placement) => placement.task.id === 't12')!;
    expect(overview.frontier).toEqual({ x: thirteenth.x, y: thirteenth.y });
  });

  it('points at the end when there is nothing left to do', () => {
    const overview = overviewOf(chain(5, 5));
    const last = layoutProjectDependencyGraph(chain(5, 5)).placements.find(
      (placement) => placement.task.id === 't4',
    )!;

    expect(overview.frontier).toEqual({ x: last.x, y: last.y });
  });

  it('measures a parent as the box it is drawn as, and can point at one', () => {
    const graph: ProjectDependencyGraphResponse = {
      marks: [
        { kind: 'TASK', id: 'parent', taskId: 'parent', title: 'Toolchain', status: 'OPEN', parentTaskId: null },
        { kind: 'TASK', id: 'child-a', taskId: 'child-a', title: 'binutils', status: 'OPEN', parentTaskId: 'parent' },
        { kind: 'TASK', id: 'child-b', taskId: 'child-b', title: 'gcc', status: 'OPEN', parentTaskId: 'parent' },
      ],
      edges: [{ sourceMarkId: 'child-a', targetMarkId: 'child-b' }],
      taskCount: 3,
      folded: false,
      truncated: false,
      limits: { maxTasks: 50_000, maxMarks: 500 },
    };
    const layout = layoutProjectDependencyGraph(graph);
    const overview = projectGraphOverview(layout);
    const box = layout.groups[0];

    // One unit, not three: the subtasks are inside the box and cannot push the bounds out.
    expect(overview.unitCount).toBe(1);
    expect(overview.bounds.width).toBe(box.width);
    expect(overview.bounds.height).toBe(box.height);
    expect(overview.frontier).toEqual({ x: box.x, y: box.y });
  });

  it('has nothing to bound when the project has no tasks', () => {
    expect(overviewOf(chain(0, 0))).toEqual({
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      frontier: null,
      unitCount: 0,
    });
  });
});

describe('planProjectGraphViewport', () => {
  it('fits a project small enough to stay legible fitted', () => {
    const plan = planProjectGraphViewport(overviewOf(chain(6, 2)), STRIP, 0.12)!;

    expect(plan.fitted).toBe(true);
    expect(plan.viewport.zoom).toBeGreaterThanOrEqual(0.3);
  });

  it('opens a 118-task chain on its frontier rather than fitting it to a dashed line', () => {
    const overview = overviewOf(chain(118, 12));
    const plan = planProjectGraphViewport(overview, STRIP, 0.12)!;

    expect(plan.fitted).toBe(false);
    // Readable, and with the frontier in the middle of the canvas rather than off the side of it.
    expect(plan.viewport.zoom).toBe(0.75);
    const frontierOnScreen = plan.viewport.x + overview.frontier!.x * plan.viewport.zoom;
    expect(frontierOnScreen).toBeGreaterThan(0);
    expect(frontierOnScreen).toBeLessThan(STRIP.width);
  });

  it('makes no plan against a canvas that has not been measured yet', () => {
    const unmeasured = { width: 0, height: 0 };
    expect(planProjectGraphViewport(overviewOf(chain(6, 2)), unmeasured, 0.12)).toBeNull();
    expect(planProjectGraphViewport(overviewOf(chain(0, 0)), STRIP, 0.12)).toBeNull();
  });
});

/**
 * The folded half of the canvas: what a mark standing for many tasks reports, how big it is drawn,
 * and what opening one does. The server decides WHAT folds (`project-graph-fold.spec.ts`); this is
 * what the picture does with the answer.
 */
describe('folded marks', () => {
  const run = (over: Partial<ProjectRunMark> = {}): ProjectRunMark => ({
    kind: 'RUN',
    id: 'run:1',
    title: '3 steps',
    taskCount: 3,
    statusCounts: { DONE: 3, IN_PROGRESS: 0, FAILED: 0, CANCELLED: 0, OPEN: 0 },
    parentTaskId: null,
    members: [
      { taskId: 'm1', title: 'Step 2', status: 'DONE' },
      { taskId: 'm2', title: 'Step 3', status: 'DONE' },
      { taskId: 'm3', title: 'Step 4', status: 'DONE' },
    ],
    expandable: true,
    ...over,
  });

  const folded = (mark: ProjectRunMark): ProjectDependencyGraphResponse => ({
    marks: [
      { kind: 'TASK', id: 'head', taskId: 'head', title: 'Step 1', status: 'DONE', parentTaskId: null },
      mark,
      { kind: 'TASK', id: 'tail', taskId: 'tail', title: 'Step 5', status: 'OPEN', parentTaskId: null },
    ],
    edges: [
      { sourceMarkId: 'head', targetMarkId: mark.id },
      { sourceMarkId: mark.id, targetMarkId: 'tail' },
    ],
    taskCount: 5,
    folded: true,
    truncated: false,
    limits: { maxTasks: 50_000, maxMarks: 500 },
  });

  it('reports a fold as done only when nothing is left in it', () => {
    assertStatus({ DONE: 9, OPEN: 1 }, 'OPEN');
    assertStatus({ DONE: 9, IN_PROGRESS: 1, OPEN: 40 }, 'IN_PROGRESS');
    // Failure outranks running work: it is the reason a reader opens a folded batch at all.
    assertStatus({ DONE: 9, IN_PROGRESS: 1, FAILED: 1, OPEN: 40 }, 'FAILED');
    assertStatus({ DONE: 9, CANCELLED: 1 }, 'DONE');

    function assertStatus(counts: Record<string, number>, expected: string) {
      expect(markStatus(run({ statusCounts: { ...zero, ...counts } }))).toBe(expected);
    }
  });

  it('is drawn wider than a task, because it says more than a task does', () => {
    const layout = layoutProjectDependencyGraph(folded(run()));
    const overview = projectGraphOverview(layout);

    expect(overview.unitCount).toBe(3);
    // The fold's own width is in the bounds: a canvas fitted to task-sized marks would clip it.
    expect(overview.bounds.width).toBeGreaterThanOrEqual(
      PROJECT_GRAPH_FOLD_WIDTH + 2 * PROJECT_GRAPH_NODE_WIDTH,
    );
  });

  it('opens a run in place, with the run\'s own edges moved to its ends', () => {
    const graph = folded(run());

    const opened = expandRunMarks(graph, new Set(['run:1']));

    expect(opened.marks.map((mark) => mark.id)).toEqual(['head', 'm1', 'm2', 'm3', 'tail']);
    expect(opened.marks.every((mark) => mark.kind === 'TASK')).toBe(true);
    expect(opened.edges).toEqual([
      // What waited on the run now waits on its last task; what it waited on feeds its first.
      { sourceMarkId: 'head', targetMarkId: 'm1' },
      { sourceMarkId: 'm3', targetMarkId: 'tail' },
      { sourceMarkId: 'm1', targetMarkId: 'm2' },
      { sourceMarkId: 'm2', targetMarkId: 'm3' },
    ]);
  });

  it('leaves a run alone when it is not the one being opened, or cannot be', () => {
    const graph = folded(run());

    expect(expandRunMarks(graph, new Set())).toBe(graph);
    expect(expandRunMarks(graph, new Set(['run:other']))).toBe(graph);
    // A run longer than the response carries members for has nothing to open into.
    const long = folded(run({ expandable: false, taskCount: 4_000 }));
    expect(expandRunMarks(long, new Set(['run:1']))).toBe(long);
  });
});

const zero = { DONE: 0, IN_PROGRESS: 0, FAILED: 0, CANCELLED: 0, OPEN: 0 };
