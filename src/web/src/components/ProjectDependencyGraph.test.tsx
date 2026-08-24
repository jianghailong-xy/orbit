// @vitest-environment jsdom
import { ReactFlowProvider } from '@xyflow/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import {
  buildProjectFlowElements,
  NODE_TYPES,
  planProjectGraphViewport,
  type ProjectFlowNode,
} from './ProjectDependencyGraph';
import { EDGE_COLORS } from './TaskDependencyGraph';
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

/**
 * One node, drawn — the only way to assert what a mark SAYS rather than what it carries.
 *
 * The rest of this file is arithmetic over positions, which needs no renderer. What a reader is
 * told about a task is not: a flag that reaches `data` and never reaches the pill is exactly the
 * bug this describes, and it is invisible to an assertion on the node array.
 */
function drawNode(node: ProjectFlowNode): string {
  const props = {
    ...node,
    selected: false,
    isConnectable: false,
    zIndex: 0,
    positionAbsoluteX: node.position.x,
    positionAbsoluteY: node.position.y,
    dragging: false,
    deletable: false,
    draggable: false,
    selectable: false,
  };
  const Node = NODE_TYPES[node.type] as (given: typeof props) => ReturnType<typeof MemoryRouter>;
  // A node draws its own connection handles, and a handle reads React Flow's store.
  return renderToStaticMarkup(
    <MemoryRouter>
      <ReactFlowProvider>
        <Node {...props} />
      </ReactFlowProvider>
    </MemoryRouter>,
  );
}

/**
 * The live run on a task, drawn.
 *
 * A dispatched task keeps `OPEN` in its row — nothing writes `IN_PROGRESS` when a session starts —
 * so a graph drawn from the status column alone shows the one task somebody is watching as
 * untouched. These are the two flags that fix it, from the response through to the pill.
 */
describe('a task with a session on it', () => {
  const oneTask = (over: Record<string, unknown>): ProjectDependencyGraphResponse => ({
    marks: [
      { kind: 'TASK', id: 't1', taskId: 't1', title: 'Clone the repo', status: 'OPEN', parentTaskId: null, ...over },
      { kind: 'TASK', id: 't2', taskId: 't2', title: 'Report the result', status: 'OPEN', parentTaskId: null },
    ],
    edges: [{ sourceMarkId: 't1', targetMarkId: 't2' }],
    taskCount: 2,
    folded: false,
    truncated: false,
    limits: { maxTasks: 50_000, maxMarks: 500 },
  });
  const drawFirst = (over: Record<string, unknown>) => {
    const elements = buildProjectFlowElements(layoutProjectDependencyGraph(oneTask(over)));
    return {
      html: drawNode(elements.nodes.find((node) => node.id === 't1')!),
      edge: elements.edges[0],
    };
  };

  it('says Running on the node while the row still says Open', () => {
    const { html, edge } = drawFirst({ running: true });

    expect(html).toContain('Running');
    expect(html).not.toContain('Open');
    // Screen readers read the label, not the pill, so it cannot keep saying Open either.
    expect(html).toContain('aria-label="Clone the repo, Running"');
    // And the line leaving it is the active one: an edge's state is its prerequisite's.
    expect(edge.style?.stroke).toBe(EDGE_COLORS.active);
  });

  it('says Queued for a task waiting on a runner slot', () => {
    const { html, edge } = drawFirst({ queued: true });

    expect(html).toContain('Queued');
    expect(html).not.toContain('Open');
    expect(edge.style?.stroke).toBe(EDGE_COLORS.queued);
  });

  it('says Open when nothing is on it', () => {
    const { html, edge } = drawFirst({});

    expect(html).toContain('Open');
    expect(html).not.toContain('Running');
    expect(edge.style?.stroke).toBe(EDGE_COLORS.pending);
  });

  it('keeps the flags on the tasks a folded run gives way to', () => {
    const graph: ProjectDependencyGraphResponse = {
      marks: [
        {
          kind: 'RUN',
          id: 'run:1',
          title: '3 steps',
          taskCount: 3,
          statusCounts: { DONE: 1, IN_PROGRESS: 0, FAILED: 0, CANCELLED: 0, OPEN: 2 },
          parentTaskId: null,
          members: [
            { taskId: 'm1', title: 'Step 1', status: 'DONE' },
            { taskId: 'm2', title: 'Step 2', status: 'OPEN', queued: true },
            { taskId: 'm3', title: 'Step 3', status: 'OPEN' },
          ],
          expandable: true,
        },
      ],
      edges: [],
      taskCount: 3,
      folded: true,
      truncated: false,
      limits: { maxTasks: 50_000, maxMarks: 500 },
    };

    const opened = expandRunMarks(graph, new Set(['run:1']));
    const queued = opened.marks.find((mark) => mark.id === 'm2');

    expect(queued?.kind === 'TASK' && queued.queued).toBe(true);
  });
});
