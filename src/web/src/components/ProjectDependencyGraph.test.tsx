// @vitest-environment jsdom
import { Position, ReactFlowProvider } from '@xyflow/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import {
  buildProjectFlowElements,
  highlightThrough,
  NODE_TYPES,
  planProjectGraphViewport,
  planStripHeight,
  type ProjectFlowNode,
} from './ProjectDependencyGraph';
import { EDGE_COLORS } from './TaskDependencyGraph';
import {
  expandRunMarks,
  foldSettledMarks,
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

const overviewOf = (graph: ProjectDependencyGraphResponse, direction: 'LR' | 'TB' = 'LR') =>
  projectGraphOverview(layoutProjectDependencyGraph(graph, direction));

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

  it('will not call a plan fitted at a zoom its titles do not survive', () => {
    // Ten ranks in a 1,100px strip fit — at about half size, which is where a 12.5px title lands
    // near six pixels. Fitting is only worth having while the thing fitted can still be read, so
    // this opens on the frontier at a readable zoom instead and leaves the whole shape one press
    // of fit-view away. Under the old 0.3 floor this was answered "yes, fitted".
    const overview = overviewOf(chain(10, 0));
    const plan = planProjectGraphViewport(overview, STRIP, 0.12)!;

    expect(plan.fitted).toBe(false);
    expect(plan.viewport.zoom).toBe(0.75);
  });

  it('makes no plan against a canvas that has not been measured yet', () => {
    const unmeasured = { width: 0, height: 0 };
    expect(planProjectGraphViewport(overviewOf(chain(6, 2)), unmeasured, 0.12)).toBeNull();
    expect(planProjectGraphViewport(overviewOf(chain(0, 0)), STRIP, 0.12)).toBeNull();
  });

  it('uses a phone modal as a tall canvas instead of shrinking a horizontal ribbon into it', () => {
    const phoneCanvas = { width: 369, height: 680 };
    const horizontal = planProjectGraphViewport(overviewOf(chain(6, 2), 'LR'), phoneCanvas, 0.2)!;
    const vertical = planProjectGraphViewport(overviewOf(chain(6, 2), 'TB'), phoneCanvas, 0.2)!;

    // Six horizontal ranks cannot fit a phone at a legible zoom, so that reading has to open on
    // one task. The same dependencies fit down its long axis with their titles intact.
    expect(horizontal.fitted).toBe(false);
    expect(vertical.fitted).toBe(true);
    expect(vertical.viewport.zoom).toBeGreaterThanOrEqual(0.7);
  });
});

describe('phone graph direction', () => {
  it('lays dependency ranks top-to-bottom and moves their handles with them', () => {
    const layout = layoutProjectDependencyGraph(chain(4, 1), 'TB');
    const elements = buildProjectFlowElements(layout);

    expect(layout.direction).toBe('TB');
    expect(new Set(layout.placements.map((placement) => placement.y)).size).toBe(4);
    expect(new Set(layout.placements.map((placement) => placement.x)).size).toBe(1);
    expect(elements.nodes.every((node) => node.data.vertical === true)).toBe(true);
    for (const node of elements.nodes) {
      expect(node.sourcePosition).toBe(node.data.hasOutgoing ? Position.Bottom : undefined);
      expect(node.targetPosition).toBe(node.data.hasIncoming ? Position.Top : undefined);
    }
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
    // Not the shared palette's `pending` value: a prerequisite that has NOT released its dependent
    // is the one relation on a plan still constraining anything, so it is drawn at the weight of
    // text rather than as the hairline a five-node canvas can afford. Still a neutral — the two
    // graphs never disagree about a hue, only about how loud a satisfied edge should be.
    expect(edge.style?.stroke).toBe('var(--text-3)');
    expect(edge.style?.opacity).toBeGreaterThan(0.9);
  });

  it('fades the line a finished prerequisite leaves behind', () => {
    const { edge } = drawFirst({ status: 'DONE' });

    // The hue stays the shared palette's, so the two graphs agree about what released looks like.
    expect(edge.style?.stroke).toBe(EDGE_COLORS.complete);
    // But it is a satisfied constraint: it no longer holds anything up, and on a plan where most
    // edges are satisfied, drawing them all at full weight makes the settled past the loudest
    // thing on the canvas.
    expect(Number(edge.style?.opacity)).toBeLessThan(0.4);
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

describe('planStripHeight', () => {
  it('is as tall as the drawing needs once it has been fitted to the width available', () => {
    // A wide, shallow plan: one row of 64px nodes fitted to about half size. The strip that used
    // to be 420px tall for this is now the floor, because there is nothing to put in the rest.
    expect(planStripHeight({ width: 2000, height: 96 }, 1100)).toBe(240);
    // A plan with real depth gets the room it needs: 400 units at the 0.88 it fits at, plus the
    // margin the fit itself leaves.
    expect(planStripHeight({ width: 1100, height: 400 }, 1100)).toBe(400);
  });

  it('stops short of pushing the task list off the page', () => {
    expect(planStripHeight({ width: 800, height: 2000 }, 1100)).toBe(520);
  });

  it('has no answer before the strip has been measured', () => {
    expect(planStripHeight({ width: 2000, height: 96 }, 0)).toBeUndefined();
    expect(planStripHeight({ width: 0, height: 0 }, 1100)).toBeUndefined();
  });
});

/**
 * The client's own fold: a connected block of finished tasks drawn as one mark.
 *
 * The server folds by shape and cannot see which project is open; what it therefore never folds is
 * the thing that makes most real plans too wide to read — their settled prefix. These are the
 * rules that decide what counts as one block, and the reason each rule is that narrow.
 */
describe('foldSettledMarks', () => {
  const settled = (graph: ProjectDependencyGraphResponse, open: string[] = []) =>
    foldSettledMarks(graph, new Set(open));

  it('folds a connected block of finished tasks into one mark, and hands the ranks back', () => {
    const before = projectGraphOverview(layoutProjectDependencyGraph(chain(9, 5)));
    const after = projectGraphOverview(layoutProjectDependencyGraph(settled(chain(9, 5))));

    // Five done steps joined to each other become one mark: nine ranks become five.
    expect(after.unitCount).toBe(5);
    expect(after.bounds.width).toBeLessThan(before.bounds.width);
    // Which is the entire point, and it is a threshold rather than a nicety: the same plan goes
    // from too wide to fit at a legible zoom, to fitting at very nearly full size.
    expect(planProjectGraphViewport(before, STRIP, 0.12)!.fitted).toBe(false);
    const fitted = planProjectGraphViewport(after, STRIP, 0.12)!;
    expect(fitted.fitted).toBe(true);
    expect(fitted.viewport.zoom).toBeGreaterThan(0.9);
  });

  it('leaves a lone finished task as itself', () => {
    // A box saying "1 done" is bigger than the task it replaced, and says less.
    const graph = chain(4, 1);
    expect(settled(graph)).toBe(graph);
  });

  it('is two blocks when unfinished work sits between them', () => {
    const graph: ProjectDependencyGraphResponse = {
      ...chain(5, 0),
      marks: ['DONE', 'DONE', 'OPEN', 'DONE', 'DONE'].map((status, i) => ({
        kind: 'TASK' as const,
        id: `t${i}`,
        taskId: `t${i}`,
        title: `Step ${i + 1}`,
        status,
        parentTaskId: null,
      })),
    };

    const kinds = settled(graph).marks.map((mark) => mark.kind);
    // Not one fold of four: folding across the open step would claim an ordering the plan does
    // not have, and would draw work as finished that is waiting on work that is not.
    expect(kinds).toEqual(['SETTLED', 'TASK', 'SETTLED']);
  });

  it('does not fold a block the reader has opened', () => {
    const graph = chain(6, 3);
    const id = settled(graph).marks.find((mark) => mark.kind === 'SETTLED')!.id;

    expect(settled(graph, [id]).marks.every((mark) => mark.kind === 'TASK')).toBe(true);
    // Opening one is simply not folding it — there is no second function to undo this, and so
    // nothing that can fall out of step with what it produced.
    expect(settled(graph, [id])).toEqual(graph);
  });

  it('keeps a block\'s id when a status somewhere else changes', () => {
    const before = settled(chain(6, 3)).marks.find((mark) => mark.kind === 'SETTLED')!.id;
    const after = settled(chain(6, 4)).marks.find((mark) => mark.kind === 'SETTLED')!.id;

    // Named after its smallest member, so a fourth step finishing and joining the block does not
    // close the fold under a reader who had it open.
    expect(after).toBe(before);
  });

  it('leaves a plan alone rather than draw an arrow that points backwards', () => {
    // A task marked done ahead of a prerequisite that is not. Contracting {d1, d2} would close a
    // cycle with x, and dagre would break it by reversing an edge — a picture that reports a
    // dependency the plan does not have.
    const graph: ProjectDependencyGraphResponse = {
      ...chain(3, 0),
      marks: [
        { kind: 'TASK', id: 'd1', taskId: 'd1', title: 'First', status: 'DONE', parentTaskId: null },
        { kind: 'TASK', id: 'x', taskId: 'x', title: 'Middle', status: 'OPEN', parentTaskId: null },
        { kind: 'TASK', id: 'd2', taskId: 'd2', title: 'Last', status: 'DONE', parentTaskId: null },
      ],
      edges: [
        { sourceMarkId: 'd1', targetMarkId: 'x' },
        { sourceMarkId: 'x', targetMarkId: 'd2' },
        { sourceMarkId: 'd1', targetMarkId: 'd2' },
      ],
    };

    expect(settled(graph)).toBe(graph);
  });

  it('says what it stands for, and that it opens', () => {
    const elements = buildProjectFlowElements(layoutProjectDependencyGraph(settled(chain(6, 3))));
    const fold = elements.nodes.find((node) => node.id.startsWith('settled:'))!;

    const html = drawNode(fold);
    expect(html).toContain('3 done');
    expect(html).toContain('click to open');
    expect(html).not.toContain('disabled');
  });
});

/**
 * What a node says about whether it can be started, which is the question a plan is opened with.
 *
 * Status alone cannot answer it: every task in the middle of a plan says Open, and Open is true of
 * both the one somebody could pick up now and the one that is waiting on four other things.
 */
describe('readiness', () => {
  const twoPrerequisites = (first: string, second: string): ProjectDependencyGraphResponse => ({
    ...chain(3, 0),
    marks: [
      { kind: 'TASK', id: 'a', taskId: 'a', title: 'A', status: first, parentTaskId: null },
      { kind: 'TASK', id: 'b', taskId: 'b', title: 'B', status: second, parentTaskId: null },
      { kind: 'TASK', id: 'c', taskId: 'c', title: 'C', status: 'OPEN', parentTaskId: null },
    ],
    edges: [
      { sourceMarkId: 'a', targetMarkId: 'c' },
      { sourceMarkId: 'b', targetMarkId: 'c' },
    ],
  });
  const drawC = (graph: ProjectDependencyGraphResponse) => {
    const elements = buildProjectFlowElements(layoutProjectDependencyGraph(graph));
    return {
      html: drawNode(elements.nodes.find((node) => node.id === 'c')!),
      tally: elements.tally,
    };
  };

  it('says a task whose prerequisites have all released it is ready to run', () => {
    const { html, tally } = drawC(twoPrerequisites('DONE', 'DONE'));

    expect(html).toContain('Ready to run');
    // And the reading is available in words too, for the panel over the canvas: a and b are done,
    // c is the one thing anybody could start.
    expect(tally).toEqual({ ready: 1, done: 2 });
  });

  it('says how many prerequisites a blocked task is still waiting on', () => {
    const { html, tally } = drawC(twoPrerequisites('OPEN', 'OPEN'));

    expect(html).toContain('Waiting on 2');
    expect(html).not.toContain('Ready to run');
    // a and b have nothing in front of them, so they are what a reader can start.
    expect(tally).toEqual({ ready: 2, done: 0 });
  });

  it('keeps the status in the label a screen reader gets, and adds the readiness to it', () => {
    const { html } = drawC(twoPrerequisites('DONE', 'OPEN'));

    expect(html).toContain('aria-label="C, Open, Waiting on 1"');
  });
});

/**
 * Hovering a mark: the paths that run through it, and nothing else.
 *
 * Tracing one dependency across six ranks of orthogonal edges by eye is the most tiring thing this
 * view asks of a reader, and the only one an interaction can remove outright.
 */
describe('highlightThrough', () => {
  const elementsOf = (graph: ProjectDependencyGraphResponse) =>
    buildProjectFlowElements(layoutProjectDependencyGraph(graph));
  const branched: ProjectDependencyGraphResponse = {
    ...chain(4, 0),
    marks: ['a', 'b', 'c', 'x'].map((id) => ({
      kind: 'TASK' as const,
      id,
      taskId: id,
      title: id.toUpperCase(),
      status: 'OPEN',
      parentTaskId: null,
    })),
    edges: [
      { sourceMarkId: 'a', targetMarkId: 'b' },
      { sourceMarkId: 'b', targetMarkId: 'c' },
      { sourceMarkId: 'x', targetMarkId: 'c' },
    ],
  };

  it('keeps what has to happen first and what this releases, and fades the rest', () => {
    const lit = highlightThrough(elementsOf(branched), 'b');
    const faded = (id: string) =>
      (lit.nodes.find((node) => node.id === id)!.className ?? '').includes('is-faded');

    // a is upstream of b, c is downstream of it: both are the answer to "and then what".
    expect(faded('a')).toBe(false);
    expect(faded('b')).toBe(false);
    expect(faded('c')).toBe(false);
    // x also feeds c, but no path through b reaches it — it is a different story on the same page.
    expect(faded('x')).toBe(true);
    expect(lit.edges.find((edge) => edge.id === 'x->c')!.style?.opacity).toBeLessThan(0.2);
    expect(lit.edges.find((edge) => edge.id === 'a->b')!.style?.stroke).toBe('var(--brand)');
  });

  it('is the same elements when nothing is hovered, so the canvas does not redraw', () => {
    const elements = elementsOf(branched);

    expect(highlightThrough(elements, null)).toBe(elements);
    expect(highlightThrough(elements, 'gone')).toBe(elements);
  });

  it('keeps controlled group, task and fold nodes measured across hover updates', () => {
    const groupedAndFolded: ProjectDependencyGraphResponse = {
      marks: [
        {
          kind: 'TASK',
          id: 'parent',
          taskId: 'parent',
          title: 'Toolchain',
          status: 'OPEN',
          parentTaskId: null,
        },
        {
          kind: 'TASK',
          id: 'child-a',
          taskId: 'child-a',
          title: 'binutils',
          status: 'OPEN',
          parentTaskId: 'parent',
        },
        {
          kind: 'TASK',
          id: 'child-b',
          taskId: 'child-b',
          title: 'gcc',
          status: 'OPEN',
          parentTaskId: 'parent',
        },
        {
          kind: 'RUN',
          id: 'run:elsewhere',
          title: '3 other steps',
          taskCount: 3,
          statusCounts: { DONE: 0, IN_PROGRESS: 0, FAILED: 0, CANCELLED: 0, OPEN: 3 },
          parentTaskId: null,
          members: [
            { taskId: 'm1', title: 'Other step 1', status: 'OPEN' },
            { taskId: 'm2', title: 'Other step 2', status: 'OPEN' },
            { taskId: 'm3', title: 'Other step 3', status: 'OPEN' },
          ],
          expandable: true,
        },
        {
          kind: 'TASK',
          id: 'task:elsewhere',
          taskId: 'task:elsewhere',
          title: 'Independent task',
          status: 'OPEN',
          parentTaskId: null,
        },
      ],
      edges: [{ sourceMarkId: 'child-a', targetMarkId: 'child-b' }],
      taskCount: 7,
      folded: true,
      truncated: false,
      limits: { maxTasks: 50_000, maxMarks: 500 },
    };
    const idle = elementsOf(groupedAndFolded);
    const hovered = highlightThrough(idle, 'child-a');

    // The unrelated group, task and fold are the exact objects hover clones to fade. If their
    // measurements disappear, React Flow briefly hides them and the pointer can bounce between
    // parent and child nodes, producing the visible enter/leave flicker.
    expect(hovered.nodes.find((node) => node.id === 'parent')?.className).toContain('is-faded');
    expect(hovered.nodes.find((node) => node.id === 'run:elsewhere')?.className).toContain('is-faded');
    expect(hovered.nodes.find((node) => node.id === 'task:elsewhere')?.className).toContain('is-faded');
    for (const node of [...idle.nodes, ...hovered.nodes]) {
      expect(node.measured).toEqual({
        width: Number(node.style?.width),
        height: Number(node.style?.height),
      });
    }
  });
});
