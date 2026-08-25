/**
 * A project's dependency graph, drawn — the picture `ProjectTasksGraph` puts under the project's
 * panorama header.
 *
 * ## The structural decision this component is built on
 *
 * A project page carries TWO structures at once: a parent/child task tree, and dependency edges
 * that cut across it. They are unrelated questions — subtask-of says nothing about ordering,
 * waits-on says nothing about membership — so drawing both as lines produces a hairball at the
 * size real projects already reach (a 24-task / 49-edge project is not unusual here).
 *
 * So, decided once and stated here rather than rediscovered per bug report:
 *
 *   **Only dependency edges are drawn as edges. Parent/child is folded into a group box.**
 *
 * A task with subtasks on this canvas is not a node — it IS the box its subtasks sit in, carrying
 * its own title and status in the box header, and its own dependency edges attach to the box. No
 * line on this canvas ever means "is part of"; every line means "waits on". A reader who wants the
 * tree reads the task list further down the page, which holds both structures without having to
 * draw either.
 *
 * Nesting stops at one level: a parent that is itself a subtask is lifted to the canvas as a box
 * of its own (see `groupIdOf` in `lib/projectDependencyGraph.ts`). Boxes inside boxes buy nothing
 * at the only sizes this view is willing to draw.
 *
 * ## Size
 *
 * There is no node count at which this view refuses to draw. A plan small enough to read fitted is
 * fitted; a bigger one opens on its frontier at a zoom that keeps titles, and the whole shape is a
 * fit-view button away (`planProjectGraphViewport` decides which, and says so on the canvas). Full
 * screen and its mini map are how a reader gets around one too big for either reading to be the
 * only one. The single ceiling left is the server's `truncated`, reported under the canvas.
 *
 * ## Weight
 *
 * React Flow and dagre are imported HERE and nowhere on the path to the project page. This module
 * is reached only through the `lazy()` boundary in `ProjectTasksGraph`, so the project page pays
 * for the chunk when it draws a graph and never merely to lay the page out.
 */
import { FullscreenOutlined } from '@ant-design/icons';
import {
  Background,
  Controls,
  getViewportForBounds,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeProps,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Alert, Button, Empty, Modal, Popover, Spin, Tooltip } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  expandRunMarks,
  foldSettledMarks,
  layoutProjectDependencyGraph,
  markHeight,
  markLiveState,
  markTaskCount,
  markWidth,
  projectGraphOverview,
  PROJECT_GRAPH_NODE_HEIGHT,
  PROJECT_GRAPH_NODE_WIDTH,
  type MarkStatusCounts,
  type ProjectGraphMark,
  type ProjectMotifMark,
  type ProjectRunMark,
  type ProjectSettledMark,
  type ProjectTaskMark,
} from '../lib/projectDependencyGraph';
import type { ProjectGraphOverview } from '../lib/projectDependencyGraph';
import { projectDependencyGraphQuery } from '../lib/queries';
import {
  getTaskDependencyVisualState,
  type TaskDependencyVisualState,
} from '../lib/taskDependencyGraph';
// The one palette, imported rather than restated: these two graphs must not disagree about what
// a released prerequisite looks like, and the values there are the ones measured against
// deuteranopia/protanopia simulation in `lib/statusPalette.test.ts`.
import { EDGE_COLORS } from './TaskDependencyGraph';
import { TaskStatusPill, taskStatusLabel } from './TaskStatusPill';

/**
 * The colour-independent second channel for a failed prerequisite.
 *
 * Under deuteranopia the safe green/red pair still lands near the discrimination floor, so state
 * on an edge — a bare line with no label or icon — cannot rest on hue alone. Deliberately not the
 * task graph's aggregate-branch dash, so a failed dependency never reads as a collapsed branch.
 */
const FAILED_EDGE_DASH = '7 4';

interface TaskNodeData extends Record<string, unknown> {
  task: ProjectTaskMark;
  hasIncoming: boolean;
  hasOutgoing: boolean;
  /** Prerequisites of this task that have not released it yet. Zero means it can start now. */
  waitingOn: number;
}

interface GroupNodeData extends Record<string, unknown> {
  task: ProjectGraphMark;
  memberCount: number;
  hasIncoming: boolean;
  hasOutgoing: boolean;
}

interface FoldNodeData extends Record<string, unknown> {
  mark: ProjectRunMark | ProjectMotifMark | ProjectSettledMark;
  hasIncoming: boolean;
  hasOutgoing: boolean;
  expanded: boolean;
  onToggle: (markId: string, firstMemberId: string | null) => void;
}

type TaskFlowNode = Node<TaskNodeData, 'projectDependencyTask'>;
type GroupFlowNode = Node<GroupNodeData, 'projectDependencyGroup'>;
type FoldFlowNode = Node<FoldNodeData, 'projectDependencyFold'>;
export type ProjectFlowNode = TaskFlowNode | GroupFlowNode | FoldFlowNode;

/** React Flow disables pointer events on non-interactive node wrappers; these contain links. */
const INTERACTIVE_NODE_STYLE = { pointerEvents: 'all' } as const;

/**
 * One task, drawn.
 *
 * Deliberately NOT the task-rooted graph's `.tdg-node`, which this used to borrow. That node is
 * drawn a handful at a time around one task a reader already chose, so it can afford a pill, a
 * shadow and a single line of title. A project draws a plan: the same chrome repeated forty times
 * is forty shadows and forty repetitions of the word "Open", which is one bit of information read
 * forty times. So status moves into the card itself — a rail down its edge and one line of small
 * text — and the room that buys goes to a title long enough to identify the task without hovering.
 *
 * The one thing said loudly is the thing worth acting on: a task whose prerequisites have all
 * released it. Finished work recedes to the weight of background, because it is background — the
 * reading it supports is "how far has this got", which the shape of the plan already gives.
 *
 * Colour is never the only channel (`lib/statusPalette.test.ts` measures why): every tone carries
 * its own word in the meta line, and the two that colour cannot separate under deuteranopia —
 * ready and blocked — are the two that say the most different things there.
 */
function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const state = getTaskDependencyVisualState(data.task);
  const status = taskStatusLabel(data.task.status, data.task.running, data.task.queued);
  // 'pending' is the palette's word for a plain open task; whether it can START is not a status,
  // it is a fact about its prerequisites, which is what this canvas is drawn to report.
  const tone = state === 'pending' ? (data.waitingOn > 0 ? 'blocked' : 'ready') : state;
  const meta =
    tone === 'ready'
      ? 'Ready to run'
      : tone === 'blocked'
        ? `Waiting on ${data.waitingOn}`
        : status;
  return (
    <div className={`pdg-task is-${tone}`}>
      {data.hasIncoming && <Handle type="target" position={Position.Left} isConnectable={false} />}
      <Link
        className="pdg-task-main nodrag nopan"
        to={`/tasks/${data.task.id}`}
        aria-label={
          tone === 'ready' || tone === 'blocked'
            ? `${data.task.title}, ${status}, ${meta}`
            : `${data.task.title}, ${status}`
        }
      >
        <span className="pdg-task-title">{data.task.title}</span>
        <span className="pdg-task-meta">{meta}</span>
      </Link>
      {data.hasOutgoing && <Handle type="source" position={Position.Right} isConnectable={false} />}
    </div>
  );
}

/**
 * The bar a folded mark carries instead of a status pill.
 *
 * One pill cannot say what a mark standing for six thousand tasks is: those tasks are in several
 * states at once, and which states and in what proportion IS the reading. Failed gets a floor
 * width because it is the segment worth opening the picture for and 24 failures in 6,118 tasks is
 * 0.4% of the bar — a truthful width that nobody can see is not a truthful bar.
 */
function StatusBar({ counts, total }: { counts: MarkStatusCounts; total: number }) {
  const segments = [
    { key: 'DONE', className: 'is-done' },
    { key: 'IN_PROGRESS', className: 'is-active' },
    { key: 'FAILED', className: 'is-failed' },
    { key: 'CANCELLED', className: 'is-cancelled' },
    { key: 'OPEN', className: 'is-open' },
  ].filter((segment) => (counts[segment.key] ?? 0) > 0);
  return (
    <span className="pdg-fold-bar" aria-hidden="true">
      {segments.map((segment) => (
        <span
          key={segment.key}
          className={`pdg-fold-seg ${segment.className}`}
          style={{ flexGrow: counts[segment.key] ?? 0, flexBasis: 0 }}
        />
      ))}
      {segments.length === 0 && <span className="pdg-fold-seg is-open" style={{ flexGrow: total }} />}
    </span>
  );
}

/** "4,102 done · 12 running · 24 failed · 2,004 open", with the zeroes left out. */
function statusLegend(counts: MarkStatusCounts): Array<{ key: string; text: string; failed: boolean }> {
  return [
    { key: 'DONE', label: 'done' },
    { key: 'IN_PROGRESS', label: 'running' },
    { key: 'FAILED', label: 'failed' },
    { key: 'CANCELLED', label: 'cancelled' },
    { key: 'OPEN', label: 'open' },
  ]
    .filter((entry) => (counts[entry.key] ?? 0) > 0)
    .map((entry) => ({
      key: entry.key,
      text: `${(counts[entry.key] ?? 0).toLocaleString()} ${entry.label}`,
      failed: entry.key === 'FAILED',
    }));
}

/** The tasks a motif mark can name: a handful, failures first, each one openable. */
function MotifSamples({ mark }: { mark: ProjectMotifMark }) {
  return (
    <div className="pdg-fold-samples">
      <div className="pdg-fold-samples-head">
        {mark.instanceCount.toLocaleString()} instances · {mark.taskCount.toLocaleString()} tasks
      </div>
      {mark.samples.map((sample) => (
        <Link key={sample.taskId} className="pdg-fold-sample" to={`/tasks/${sample.taskId}`}>
          <span className="pdg-fold-sample-title">{sample.title}</span>
          <TaskStatusPill status={sample.status} running={sample.running} queued={sample.queued} />
        </Link>
      ))}
    </div>
  );
}

/**
 * A fold, drawn: what it stands for, how much of it, and how it is going.
 *
 * Dashed and tinted, the way the task graph already draws a collapsed branch — a reader who has
 * seen one of those knows without being told that this is not one task.
 */
function FoldNode({ data }: NodeProps<FoldFlowNode>) {
  const mark = data.mark;
  const state = getTaskDependencyVisualState(markLiveState(mark));
  const count = markTaskCount(mark);
  const body = (
    <>
      <span className="pdg-fold-title-row">
        <span className="pdg-fold-title">{mark.title}</span>
        <span className="pdg-fold-count">×{count.toLocaleString()}</span>
      </span>
      <StatusBar counts={mark.statusCounts} total={count} />
      <span className="pdg-fold-legend">
        {statusLegend(mark.statusCounts).map((entry, index) => (
          <span key={entry.key} className={entry.failed ? 'is-failed' : undefined}>
            {index > 0 ? ' · ' : ''}
            {entry.text}
          </span>
        ))}
      </span>
    </>
  );
  // A settled block has one thing to report and it is the count: every task in it is done, so a
  // legend spelling out the split would spell out one number twice.
  const settledBody = (
    <>
      <span className="pdg-fold-title-row">
        <span className="pdg-fold-title">{count.toLocaleString()} done</span>
      </span>
      <StatusBar counts={mark.statusCounts} total={count} />
      <span className="pdg-fold-legend">Finished · click to open</span>
    </>
  );
  const label =
    mark.kind === 'MOTIF'
      ? `${mark.title}, ${mark.instanceCount} instances, ${count} tasks folded`
      : `${mark.title}, ${count} tasks folded${data.expanded ? ', open' : ''}`;

  return (
    <div
      className={`pdg-fold state-${state}${data.expanded ? ' is-open' : ''}${mark.kind === 'SETTLED' ? ' is-settled' : ''}`}
    >
      {data.hasIncoming && <Handle type="target" position={Position.Left} isConnectable={false} />}
      {mark.kind !== 'MOTIF' ? (
        <button
          type="button"
          className="pdg-fold-main nodrag nopan"
          onClick={() => data.onToggle(mark.id, mark.members[0]?.taskId ?? null)}
          disabled={mark.kind === 'RUN' && !mark.expandable}
          aria-label={label}
          title={
            mark.kind === 'SETTLED'
              ? data.expanded
                ? 'Fold this finished work back up'
                : 'Show the finished tasks'
              : mark.expandable
                ? data.expanded
                  ? 'Fold these steps back up'
                  : 'Show these steps'
                : 'Too long to open here — the task list below has all of it'
          }
        >
          {mark.kind === 'SETTLED' ? settledBody : body}
        </button>
      ) : (
        <Popover
          content={<MotifSamples mark={mark} />}
          title={mark.title}
          trigger="click"
          placement="bottom"
        >
          <button type="button" className="pdg-fold-main nodrag nopan" aria-label={label}>
            {body}
          </button>
        </Popover>
      )}
      {data.hasOutgoing && <Handle type="source" position={Position.Right} isConnectable={false} />}
    </div>
  );
}

/** A parent task. Its subtasks are separate React Flow children positioned inside this frame. */
function GroupNode({ data }: NodeProps<GroupFlowNode>) {
  const live = markLiveState(data.task);
  const state = getTaskDependencyVisualState(live);
  return (
    <div className={`pdg-group state-${state}`}>
      {data.hasIncoming && <Handle type="target" position={Position.Left} isConnectable={false} />}
      <Link
        className="pdg-group-header nodrag nopan"
        to={`/tasks/${data.task.id}`}
        aria-label={`${data.task.title}, ${taskStatusLabel(live.status, live.running, live.queued)}, ${data.memberCount} subtask${data.memberCount === 1 ? '' : 's'}`}
      >
        <span className="pdg-group-title">{data.task.title}</span>
        <TaskStatusPill status={live.status} running={live.running} queued={live.queued} />
      </Link>
      {data.hasOutgoing && <Handle type="source" position={Position.Right} isConnectable={false} />}
    </div>
  );
}

/**
 * Exported as well as handed to the canvas: what a mark SAYS is the whole point of this view, and
 * a node component nothing can render is a node component nothing can assert on.
 */
export const NODE_TYPES = {
  projectDependencyTask: TaskNode,
  projectDependencyGroup: GroupNode,
  projectDependencyFold: FoldNode,
};

/**
 * Positioned React Flow elements for one project graph.
 *
 * Parents come before their members in the node array — React Flow requires a child's frame to
 * exist by the time the child is read.
 *
 * Exported for tests: the placement rules are the whole point of the view, and a canvas cannot be
 * asserted on the way an array of positions can.
 */
export function buildProjectFlowElements(
  layout: ReturnType<typeof layoutProjectDependencyGraph>,
  fold: {
    expandedRunIds: ReadonlySet<string>;
    onToggleRun: (markId: string, firstMemberId: string | null) => void;
  } = {
    expandedRunIds: new Set(),
    onToggleRun: () => undefined,
  },
): { nodes: ProjectFlowNode[]; edges: Edge[]; tally: { ready: number; done: number } } {
  const incoming = new Set(layout.edges.map((edge) => edge.targetMarkId));
  const outgoing = new Set(layout.edges.map((edge) => edge.sourceMarkId));
  const stateById = new Map<string, TaskDependencyVisualState>();
  for (const group of layout.groups) {
    stateById.set(group.task.id, getTaskDependencyVisualState(markLiveState(group.task)));
  }
  for (const placement of layout.placements) {
    stateById.set(placement.task.id, getTaskDependencyVisualState(markLiveState(placement.task)));
  }

  // How many of a mark's prerequisites have not released it. A mark absent from this map is one
  // nothing is holding up — which, for an open task, is the only thing on this canvas worth an eye.
  const waitingOn = new Map<string, number>();
  for (const edge of layout.edges) {
    if (stateById.get(edge.sourceMarkId) === 'complete') continue;
    waitingOn.set(edge.targetMarkId, (waitingOn.get(edge.targetMarkId) ?? 0) + 1);
  }

  const groupNodes: GroupFlowNode[] = layout.groups.map((group) => ({
    id: group.task.id,
    type: 'projectDependencyGroup',
    position: { x: group.x, y: group.y },
    style: { ...INTERACTIVE_NODE_STYLE, width: group.width, height: group.height },
    draggable: false,
    selectable: false,
    connectable: false,
    data: {
      task: group.task,
      memberCount: group.members.length,
      hasIncoming: incoming.has(group.task.id),
      hasOutgoing: outgoing.has(group.task.id),
    },
  }));
  const markNodes: ProjectFlowNode[] = layout.placements.map((placement) => {
    const mark = placement.task;
    const common = {
      id: mark.id,
      position: { x: placement.x, y: placement.y },
      style: {
        ...INTERACTIVE_NODE_STYLE,
        width: markWidth(mark),
        height: markHeight(mark),
      },
      draggable: false,
      selectable: false,
      connectable: false,
      ...(placement.groupId ? { parentId: placement.groupId, extent: 'parent' as const } : {}),
    };
    const hasIncoming = incoming.has(mark.id);
    const hasOutgoing = outgoing.has(mark.id);
    if (mark.kind === 'TASK') {
      return {
        ...common,
        type: 'projectDependencyTask',
        data: { task: mark, hasIncoming, hasOutgoing, waitingOn: waitingOn.get(mark.id) ?? 0 },
      } satisfies TaskFlowNode;
    }
    return {
      ...common,
      type: 'projectDependencyFold',
      data: {
        mark,
        hasIncoming,
        hasOutgoing,
        expanded: fold.expandedRunIds.has(mark.id),
        onToggle: fold.onToggleRun,
      },
    } satisfies FoldFlowNode;
  });

  const edges: Edge[] = layout.edges.map((edge) => {
    // An edge's state is its PREREQUISITE's, never its dependent's: what the line reports is
    // whether the thing at its tail has released the thing at its head.
    const state = stateById.get(edge.sourceMarkId) ?? 'pending';
    const ink = PROJECT_EDGE_INK[state];
    return {
      id: `${edge.sourceMarkId}->${edge.targetMarkId}`,
      source: edge.sourceMarkId,
      target: edge.targetMarkId,
      type: 'smoothstep',
      style: {
        stroke: ink?.stroke ?? EDGE_COLORS[state],
        strokeWidth: ink?.width ?? 1.5,
        opacity: ink?.opacity ?? 0.9,
        ...(state === 'failed' ? { strokeDasharray: FAILED_EDGE_DASH } : {}),
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 12,
        height: 12,
        color: ink?.stroke ?? EDGE_COLORS[state],
      },
    };
  });

  const tally = { ready: 0, done: 0 };
  for (const placement of layout.placements) {
    const mark = placement.task;
    const state = stateById.get(mark.id);
    if (state === 'complete') tally.done += markTaskCount(mark);
    else if (mark.kind === 'TASK' && state === 'pending' && !waitingOn.has(mark.id)) {
      tally.ready += 1;
    }
  }

  return { nodes: [...groupNodes, ...markNodes], edges, tally };
}

/**
 * Weight, on top of the shared palette's hue.
 *
 * `EDGE_COLORS` stays the one place that decides what a released prerequisite LOOKS like, so the
 * two graphs cannot drift into disagreeing about it. What a project needs on top is a different
 * emphasis: most of a half-finished plan's edges are satisfied, and drawn at full weight they are
 * the loudest thing on the canvas while being the one relation that no longer constrains anything.
 * So satisfied fades to a hairline and the edges still holding work up are drawn at the weight of
 * text. Nothing here changes a hue — a reader who learned the colours on the task graph still
 * reads them here.
 */
const PROJECT_EDGE_INK: Partial<
  Record<TaskDependencyVisualState, { stroke?: string; opacity: number; width: number }>
> = {
  complete: { opacity: 0.32, width: 1.25 },
  pending: { stroke: 'var(--text-3)', opacity: 0.95, width: 1.5 },
};

/**
 * A hover, answered: the paths that run THROUGH the mark under the pointer, and nothing else.
 *
 * Every other reading of "related" is either useless (its immediate neighbours, which the reader
 * can already see) or the whole graph. Upstream is what has to happen first, downstream is what
 * this releases; together they are the answer to the only question a line on this canvas raises,
 * which is "and then what". Tracing that by eye across six ranks of orthogonal edges is the
 * single most tiring thing this view asks of a reader.
 *
 * Returns the same elements when nothing is hovered, so the canvas re-renders only on a change.
 */
export function highlightThrough<T extends { nodes: ProjectFlowNode[]; edges: Edge[] }>(
  elements: T,
  markId: string | null,
): T {
  if (!markId || !elements.nodes.some((node) => node.id === markId)) return elements;
  const inbound = new Map<string, Edge[]>();
  const outbound = new Map<string, Edge[]>();
  const index = (at: Map<string, Edge[]>, key: string, edge: Edge) => {
    const list = at.get(key);
    if (list) list.push(edge);
    else at.set(key, [edge]);
  };
  for (const edge of elements.edges) {
    index(inbound, edge.target, edge);
    index(outbound, edge.source, edge);
  }
  const lit = new Set<string>([markId]);
  const litEdges = new Set<string>();
  for (const [next, step] of [
    [inbound, (edge: Edge) => edge.source] as const,
    [outbound, (edge: Edge) => edge.target] as const,
  ]) {
    let frontier = [markId];
    while (frontier.length > 0) {
      const onward: string[] = [];
      for (const id of frontier) {
        for (const edge of next.get(id) ?? []) {
          litEdges.add(edge.id);
          const other = step(edge);
          if (lit.has(other)) continue;
          lit.add(other);
          onward.push(other);
        }
      }
      frontier = onward;
    }
  }

  return {
    ...elements,
    nodes: elements.nodes.map((node) => {
      // A member of a faded box is already faded by its box; fading it again makes it vanish.
      if (lit.has(node.id) || (node.parentId && !lit.has(node.parentId))) return node;
      return { ...node, className: `${node.className ?? ''} is-faded`.trim() };
    }),
    edges: elements.edges.map((edge) =>
      litEdges.has(edge.id)
        ? {
            ...edge,
            zIndex: 1,
            style: { ...edge.style, stroke: 'var(--brand)', strokeWidth: 1.8, opacity: 1 },
            markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: 'var(--brand)' },
          }
        : { ...edge, style: { ...edge.style, opacity: 0.12 } },
    ),
  };
}

/**
 * How far out the canvas may zoom, by hand.
 *
 * Far past legibility on purpose: it is the zoom at which a 118-task chain is finally one shape on
 * one screen, and "what does this whole plan look like" is a question worth being able to ask even
 * when the answer is a ribbon with no titles on it. Nothing opens here — see the viewport plan.
 */
const MIN_ZOOM = 0.05;

/**
 * The floor under a fitted opening — legibility, not completeness.
 *
 * This used to be 0.3, which let the view answer "does the whole plan fit" with yes at a zoom
 * where a 12.5px title renders at four pixels. Fitting is only worth having while the thing
 * fitted can still be read: below this the view opens on the frontier instead and the whole shape
 * stays one fit-view button away, which is the reading that was always meant to be one press off.
 */
const MIN_FIT_ZOOM = 0.7;

/** What a 168px card needs for its title to survive. */
const READABLE_ZOOM = 0.75;

/** Below this many units the mini map is a picture of what is already on screen. */
const MINIMAP_MIN_UNITS = 20;

/**
 * Where the canvas opens.
 *
 * Fit the whole plan when the whole plan is worth looking at — that is every project small enough
 * for the fit to land above `MIN_FIT_ZOOM`, which is most of them. Past that size fitting is what
 * produced the old "too large to draw" verdict: technically the entire graph, practically a dashed
 * line. So a big plan opens on its frontier instead, at a zoom that keeps titles, and the whole
 * shape stays one fit-view button (or one scroll) away.
 *
 * Exported for tests: which of the two readings a project gets is the decision this view now makes
 * in place of refusing to draw, and it is decidable on numbers alone.
 */
export function planProjectGraphViewport(
  overview: ProjectGraphOverview,
  canvas: { width: number; height: number },
  padding: number,
): { viewport: Viewport; fitted: boolean } | null {
  // React Flow reports 0x0 until it has measured; a plan made against that would centre on nothing.
  if (canvas.width <= 0 || canvas.height <= 0 || overview.unitCount === 0) return null;

  const fitted = getViewportForBounds(
    overview.bounds,
    canvas.width,
    canvas.height,
    MIN_ZOOM,
    1,
    padding,
  );
  if (fitted.zoom >= MIN_FIT_ZOOM || !overview.frontier) return { viewport: fitted, fitted: true };

  return {
    viewport: {
      x: canvas.width / 2 - (overview.frontier.x + PROJECT_GRAPH_NODE_WIDTH / 2) * READABLE_ZOOM,
      y: canvas.height / 2 - (overview.frontier.y + PROJECT_GRAPH_NODE_HEIGHT / 2) * READABLE_ZOOM,
      zoom: READABLE_ZOOM,
    },
    fitted: false,
  };
}

/**
 * How tall the page's strip should be: as tall as the drawing needs, and no taller.
 *
 * A plan is wide and shallow, so a fitted one is bound by the width available — which left the old
 * fixed 300-420px strip mostly empty underneath a graph that was already too small to read, the
 * worst of both readings. The floor keeps a one-row plan from becoming a letterbox; the ceiling
 * keeps a tall one from pushing the task list off the page, which is what full screen is for.
 *
 * Exported for tests: it is a rule about a number, and a rule about a number is worth asserting on
 * rather than eyeballing at one window size.
 */
export function planStripHeight(
  bounds: { width: number; height: number },
  canvasWidth: number,
): number | undefined {
  if (canvasWidth <= 0 || bounds.width <= 0) return undefined;
  const zoom = Math.min(1, (canvasWidth * 0.88) / bounds.width);
  return Math.round(Math.min(520, Math.max(240, bounds.height * zoom + 48)));
}

/**
 * The canvas: the same elements, drawn either in the page's strip or in the full-screen modal.
 *
 * One component for both so the two never drift into disagreeing about what the graph looks like;
 * `fullScreen` changes only what the extra room is worth — a looser fit, a mini map, and a fit that
 * more projects clear because there is more room to clear it in.
 */
function ProjectCanvas({
  elements,
  overview,
  fullScreen,
  summary,
  focusMarkId,
  onHover,
}: {
  elements: ReturnType<typeof buildProjectFlowElements>;
  overview: ProjectGraphOverview;
  fullScreen: boolean;
  summary: string | null;
  /** A mark to keep under the reader after the canvas re-lays itself out around it. */
  focusMarkId: string | null;
  onHover: (markId: string | null) => void;
}) {
  const { setCenter, setViewport, getZoom } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const padding = fullScreen ? 0.2 : 0.12;
  const plan = useMemo(
    () => planProjectGraphViewport(overview, { width, height }, padding),
    [height, overview, padding, width],
  );
  const panel = plan && !plan.fitted && summary ? `${summary} · zoom out for the whole plan` : summary;
  // Applied once, when the canvas first knows its own size, and never again. Re-running it would
  // haul a reader who had panned somewhere back to the frontier for resizing their window — or,
  // worse, for opening a fold, which makes the graph wider and would therefore re-decide the whole
  // viewport underneath the very thing they clicked.
  const appliedRef = useRef<string | null>(null);
  const planKey = fullScreen ? 'full' : 'inline';
  useLayoutEffect(() => {
    if (!plan || appliedRef.current === planKey) return;
    appliedRef.current = planKey;
    void setViewport(plan.viewport, { duration: 0 });
  }, [plan, planKey, setViewport]);

  // Opening a fold re-lays the whole canvas out around it, so what the reader clicked would
  // otherwise slide off somewhere. Put it back under them, at a zoom its titles survive.
  const focusedRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!focusMarkId || focusedRef.current === focusMarkId) return;
    focusedRef.current = focusMarkId;
    const node = elements.nodes.find((candidate) => candidate.id === focusMarkId);
    if (!node) return;
    // A mark inside a box is positioned relative to that box, which is the frame's own position.
    const parent = node.parentId
      ? elements.nodes.find((candidate) => candidate.id === node.parentId)
      : undefined;
    const x = node.position.x + (parent?.position.x ?? 0);
    const y = node.position.y + (parent?.position.y ?? 0);
    void setCenter(x + PROJECT_GRAPH_NODE_WIDTH / 2, y + PROJECT_GRAPH_NODE_HEIGHT / 2, {
      zoom: Math.max(getZoom(), READABLE_ZOOM),
      duration: 0,
    });
  }, [elements.nodes, focusMarkId, getZoom, setCenter]);

  return (
    <ReactFlow
      nodes={elements.nodes}
      edges={elements.edges}
      nodeTypes={NODE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      onNodeMouseEnter={(_, node) => onHover(node.id)}
      onNodeMouseLeave={() => onHover(null)}
      proOptions={{ hideAttribution: true }}
      // No `fitView`: React Flow's own fit runs after this component's viewport plan and would
      // overrule it, which is how a 118-task chain ends up fitted to a dashed line again. The
      // plan fits the graph itself whenever fitting is the right reading.
      minZoom={MIN_ZOOM}
      maxZoom={1}
      ariaLabelConfig={{
        'controls.ariaLabel': 'Task graph controls',
        'controls.zoomIn.ariaLabel': 'Zoom in task graph',
        'controls.zoomOut.ariaLabel': 'Zoom out task graph',
        'controls.fitView.ariaLabel': 'Fit whole project in view',
      }}
    >
      {/* No dot grid. React Flow's is an editor's texture — it says "this plane has coordinates
          and things snap to them". Nothing here is draggable (`nodesDraggable={false}`), so on a
          canvas this size it is several thousand high-frequency marks encoding nothing, over the
          one drawing they sit behind. */}
      {panel && (
        // Said where the reader is looking. Two different things are worth saying and they are
        // both about scale: that these marks stand for more tasks than they look like, and that
        // what is on screen is a part of something bigger than the canvas.
        <Panel position="top-left" className="tdg-visible-count">
          {panel}
        </Panel>
      )}
      <Controls showInteractive={false} fitViewOptions={{ padding, maxZoom: 1 }} />
      {fullScreen && overview.unitCount > MINIMAP_MIN_UNITS && (
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          ariaLabel="Task graph mini map"
          nodeColor={(node) => {
            const data = node.data as { mark?: ProjectGraphMark; task?: ProjectGraphMark };
            const mark = data.mark ?? data.task;
            if (!mark) return 'var(--brand-border)';
            return EDGE_COLORS[getTaskDependencyVisualState(markLiveState(mark))];
          }}
        />
      )}
    </ReactFlow>
  );
}

/** The provider the canvas's viewport hooks need, and nothing else. */
function ProjectFlow(props: {
  elements: ReturnType<typeof buildProjectFlowElements>;
  overview: ProjectGraphOverview;
  fullScreen: boolean;
  summary: string | null;
  focusMarkId: string | null;
  onHover: (markId: string | null) => void;
}) {
  return (
    <ReactFlowProvider>
      <ProjectCanvas {...props} />
    </ReactFlowProvider>
  );
}

export function ProjectDependencyGraph({ projectId }: { projectId: string }) {
  const [fullScreen, setFullScreen] = useState(false);
  // Which folded runs the reader has opened. Kept here rather than in the marks so that a refetch
  // — a status changing somewhere — does not close what someone was reading.
  const [expandedRunIds, setExpandedRunIds] = useState<ReadonlySet<string>>(new Set());
  // Which mark the last toggle was about, so the canvas can keep it where the reader left it.
  const [focusMarkId, setFocusMarkId] = useState<string | null>(null);
  // The mark under the pointer, if any. Kept out here so both canvases answer a hover the same way.
  const [hoverMarkId, setHoverMarkId] = useState<string | null>(null);
  const graph = useQuery(projectDependencyGraphQuery(projectId));
  // The node hands its own first member over, because a settled fold is made on this side and is
  // therefore not in `graph.data` to be looked up.
  const onToggleRun = useCallback((markId: string, firstMemberId: string | null) => {
    setExpandedRunIds((previous) => {
      const next = new Set(previous);
      const opening = !next.delete(markId);
      if (opening) next.add(markId);
      // Opening: the fold's first task now stands where the fold did. Closing: the fold itself.
      setFocusMarkId(opening && firstMemberId ? firstMemberId : markId);
      return next;
    });
  }, []);

  const view = useMemo(() => {
    if (!graph.data) return null;
    // Settle BEFORE opening runs: a run a reader just opened whose every step is done would
    // otherwise be handed straight to the settled fold and disappear again as they watched.
    const settled = foldSettledMarks(graph.data, expandedRunIds);
    const opened = expandRunMarks(settled, expandedRunIds);
    const layout = layoutProjectDependencyGraph(opened);
    const elements = buildProjectFlowElements(layout, { expandedRunIds, onToggleRun });
    const foldedTasks = opened.marks.reduce(
      (sum, mark) => sum + (mark.kind === 'TASK' ? 0 : markTaskCount(mark)),
      0,
    );
    return {
      elements,
      overview: projectGraphOverview(layout),
      // The reading the picture is for, in words, for a reader who has not traced it yet: how big
      // this plan is, how much of it is behind them, and how much of it they could start today.
      // Also the one thing a folded canvas has to say or its own emptiness reads as an empty
      // project — that these marks stand for more tasks than they look like.
      summary: [
        `${graph.data.taskCount.toLocaleString()} tasks`,
        elements.tally.ready > 0 ? `${elements.tally.ready.toLocaleString()} ready to run` : null,
        elements.tally.done > 0 ? `${elements.tally.done.toLocaleString()} done` : null,
        foldedTasks > 0 ? 'dashed marks are folded' : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · '),
    };
  }, [expandedRunIds, graph.data, onToggleRun]);

  // Hover is a decoration over the same layout, so it must not re-run the layout.
  const elements = useMemo(
    () => (view ? highlightThrough(view.elements, hoverMarkId) : null),
    [hoverMarkId, view],
  );

  // The strip is as tall as the drawing needs and no taller. A plan is wide and shallow, so a
  // fitted one is bound by width — a fixed 420px strip then leaves most of itself empty under a
  // graph that is already too small to read, which is the worst of both.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [stripWidth, setStripWidth] = useState(0);
  useLayoutEffect(() => {
    const node = stripRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => setStripWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [view]);
  const stripHeight = useMemo(
    () => (view ? planStripHeight(view.overview.bounds, stripWidth) : undefined),
    [stripWidth, view],
  );

  if (graph.isLoading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }
  if (graph.isError) {
    return (
      <Alert
        type="error"
        showIcon
        message="Dependency graph could not be loaded"
        description={graph.error instanceof Error ? graph.error.message : undefined}
        action={
          <Button size="small" danger onClick={() => graph.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }
  if (!view || !elements || elements.nodes.length === 0) {
    return <Empty description="No tasks to draw yet" />;
  }

  return (
    <>
      <div
        ref={stripRef}
        className="tdg-canvas pdg-canvas"
        style={stripHeight ? { height: stripHeight } : undefined}
        data-testid="project-dependency-graph"
      >
        <Tooltip title="Open full-screen graph">
          <button
            type="button"
            className="tdg-maximize"
            onClick={() => setFullScreen(true)}
            aria-label="Open project task graph full screen"
          >
            <FullscreenOutlined />
          </button>
        </Tooltip>
        {/* Only one canvas is mounted at a time: two React Flow instances over the same elements
            would both measure and both fit, for a picture the reader cannot see. */}
        {!fullScreen && (
          <ProjectFlow
            elements={elements}
            overview={view.overview}
            summary={view.summary}
            focusMarkId={focusMarkId}
            fullScreen={false}
            onHover={setHoverMarkId}
          />
        )}
      </div>
      <Modal
        className="tdg-modal"
        open={fullScreen}
        onCancel={() => setFullScreen(false)}
        footer={null}
        width="calc(100vw - 48px)"
        title="Task graph"
        destroyOnClose
      >
        <div className="tdg-full-canvas">
          <ProjectFlow
            elements={elements}
            overview={view.overview}
            summary={view.summary}
            focusMarkId={focusMarkId}
            fullScreen
            onHover={setHoverMarkId}
          />
        </div>
      </Modal>
      {graph.data?.truncated ? (
        <Alert
          style={{ marginTop: 8 }}
          type="warning"
          showIcon
          message={`This project is larger than one graph request reads (${graph.data.limits.maxTasks.toLocaleString()} tasks).`}
          description="The task list below has all of them, in dependency order."
        />
      ) : null}
    </>
  );
}
