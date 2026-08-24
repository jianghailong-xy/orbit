import dagre from '@dagrejs/dagre';
import {
  getTaskDependencyVisualState,
  type TaskDependencyGraphNode,
} from './taskDependencyGraph';

/**
 * One task in a project's dependency graph, drawn as itself.
 *
 * Deliberately `TaskDependencyGraphNode` plus two fields rather than a parallel shape: the same
 * canvas vocabulary reads both this graph and the single-task one, and two words for "a task on a
 * graph" is how two views drift into rendering the same status differently. `parentTaskId` is the
 * addition a project needs — it has a task tree to fold into boxes, a task-rooted graph has none.
 */
export interface ProjectTaskMark extends TaskDependencyGraphNode {
  kind: 'TASK';
  taskId: string;
  parentTaskId: string | null;
}

/** How many tasks of each status sit behind one folded mark. */
export type MarkStatusCounts = Record<string, number>;

/** A straight run of tasks the server folded into one mark. `members` is the run, in order. */
export interface ProjectRunMark {
  kind: 'RUN';
  id: string;
  title: string;
  taskCount: number;
  statusCounts: MarkStatusCounts;
  parentTaskId: string | null;
  members: Array<{ taskId: string; title: string; status: string; running?: boolean; queued?: boolean }>;
  /** False when the run is longer than the response carries members for. */
  expandable: boolean;
}

/** One stage of a motif the project repeats — the same task, in every instance of the pattern. */
export interface ProjectMotifMark {
  kind: 'MOTIF';
  id: string;
  title: string;
  instanceCount: number;
  taskCount: number;
  statusCounts: MarkStatusCounts;
  parentTaskId: null;
  /** A few of the real tasks behind it, failures and running work first. */
  samples: Array<{ taskId: string; title: string; status: string; running?: boolean; queued?: boolean }>;
}

/**
 * A mark: the unit this canvas draws.
 *
 * Not a task, because a project of 23,442 tasks has no drawing made of 23,442 anything. The
 * server folds first (`apiserver/src/projects/project-graph-fold.ts`) and what arrives is what
 * survives folding — every task behind exactly one mark, however many tasks there are.
 */
export type ProjectGraphMark = ProjectTaskMark | ProjectRunMark | ProjectMotifMark;

/** Kept as the old name so the rest of the canvas keeps reading "a node on this graph". */
export type ProjectDependencyGraphNode = ProjectGraphMark;

/** Prerequisite → dependent, between marks rather than between tasks. */
export interface ProjectGraphMarkEdge {
  sourceMarkId: string;
  targetMarkId: string;
}

/**
 * `GET /projects/:id/dependency-graph` — the whole project at once, folded, not a page of it.
 *
 * Edges point prerequisite → dependent, the same direction the task-rooted graph uses. Edges with
 * one end outside the project are not in here at all: the server drops them rather than inventing
 * a node this page could not open.
 */
export interface ProjectDependencyGraphResponse {
  marks: ProjectGraphMark[];
  edges: ProjectGraphMarkEdge[];
  /** Tasks behind the marks — the project's own size, not the number of things drawn. */
  taskCount: number;
  /** True when at least one mark stands for more than one task. */
  folded: boolean;
  /** The project is bigger than one request reads, or its fold than one response carries. */
  truncated: boolean;
  limits: { maxTasks: number; maxMarks: number };
}

/** What a mark says it is, for a reader and for a screen reader. */
export function markTaskCount(mark: ProjectGraphMark): number {
  return mark.kind === 'TASK' ? 1 : mark.taskCount;
}

/**
 * The one status a folded mark reports, for the edges leaving it and the colour it carries.
 *
 * A fold is as done as its least done task: anything failed makes it failed, anything running
 * makes it active, and only a mark with nothing left in it reads as complete. Reading it the
 * other way — "mostly done, call it done" — is how a picture tells a reader work has landed that
 * has not.
 */
export function markStatus(mark: ProjectGraphMark): string {
  if (mark.kind === 'TASK') return mark.status;
  const counts = mark.statusCounts;
  if ((counts.FAILED ?? 0) > 0) return 'FAILED';
  if ((counts.IN_PROGRESS ?? 0) > 0) return 'IN_PROGRESS';
  if ((counts.OPEN ?? 0) > 0) return 'OPEN';
  return 'DONE';
}

/**
 * A mark as the palette reads it: its status, plus the live run on it when it stands for one task.
 *
 * A task being worked on right now keeps `OPEN` in its row — nothing writes `IN_PROGRESS` at
 * dispatch — so a node coloured from the status alone draws the one task somebody is watching as
 * untouched. `getTaskDependencyVisualState` already knows what to do with the two live flags; this
 * is what makes sure they reach it, on this canvas as on the task-rooted one.
 *
 * A fold has no single session, and needs none: the server counted its running tasks under
 * `IN_PROGRESS`, so `markStatus` already reports a fold with work in flight as active.
 */
export function markLiveState(
  mark: ProjectGraphMark,
): { status: string; running?: boolean; queued?: boolean } {
  if (mark.kind === 'TASK') return { status: mark.status, running: mark.running, queued: mark.queued };
  return { status: markStatus(mark) };
}

/** Matches `.tdg-node` in index.css — the project graph reuses the task graph's node chrome. */
export const PROJECT_GRAPH_NODE_WIDTH = 204;
export const PROJECT_GRAPH_NODE_HEIGHT = 76;
/** Matches `.pdg-fold`: wider for a normalized title, taller for the bar and the counts. */
export const PROJECT_GRAPH_FOLD_WIDTH = 252;
export const PROJECT_GRAPH_FOLD_HEIGHT = 96;

export const markWidth = (mark: ProjectGraphMark) =>
  mark.kind === 'TASK' ? PROJECT_GRAPH_NODE_WIDTH : PROJECT_GRAPH_FOLD_WIDTH;
export const markHeight = (mark: ProjectGraphMark) =>
  mark.kind === 'TASK' ? PROJECT_GRAPH_NODE_HEIGHT : PROJECT_GRAPH_FOLD_HEIGHT;
const GROUP_PADDING = 14;
/** Room above the members for the box's own title and status. */
const GROUP_HEADER = 40;
const GROUP_MEMBER_GAP = 14;

/**
 * A parent task, drawn as the box its subtasks sit in rather than as a node of its own.
 *
 * `x` / `y` are canvas coordinates; a member's own placement is relative to this box, which is
 * what React Flow expects of a child node.
 */
export interface ProjectGraphGroup {
  task: ProjectDependencyGraphNode;
  members: ProjectDependencyGraphNode[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A task drawn as a node: either standalone, or inside the group box named by `groupId`. */
export interface ProjectGraphPlacement {
  task: ProjectDependencyGraphNode;
  groupId: string | null;
  x: number;
  y: number;
}

export interface ProjectDependencyLayout {
  groups: ProjectGraphGroup[];
  placements: ProjectGraphPlacement[];
  /** Every dependency edge whose two ends are both drawn — which, after grouping, is all of them. */
  edges: ProjectGraphMarkEdge[];
}

/**
 * Which box a task is drawn inside, or null when it is drawn on the canvas itself.
 *
 * A task that has subtasks of its own is never a member, even when it also has a parent: it is
 * already a box, and a box inside a box is a second level of nesting that buys a reader nothing at
 * the size this view is willing to draw. Such a parent is lifted to the canvas and its own
 * membership simply is not drawn — the tree is readable in the List view, which is the default.
 */
function groupIdOf(
  task: ProjectDependencyGraphNode,
  byId: ReadonlyMap<string, ProjectDependencyGraphNode>,
  parents: ReadonlySet<string>,
): string | null {
  if (parents.has(task.id)) return null;
  if (!task.parentTaskId || !byId.has(task.parentTaskId)) return null;
  return task.parentTaskId;
}

/** Lay `nodes` out top-to-bottom by `edges`, and report where each landed plus the extent used. */
function dagreLayout(
  nodes: Array<{ id: string; width: number; height: number }>,
  edges: ReadonlyArray<{ source: string; target: string }>,
  rankdir: 'LR' | 'TB',
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir, nodesep: 26, ranksep: rankdir === 'LR' ? 72 : 40, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) g.setNode(node.id, { width: node.width, height: node.height });
  for (const edge of edges) g.setEdge(edge.source, edge.target);
  dagre.layout(g);
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const laid = g.node(node.id) as { x: number; y: number } | undefined;
    // dagre reports centres; every consumer here wants a top-left corner.
    positions.set(node.id, {
      x: (laid?.x ?? 0) - node.width / 2,
      y: (laid?.y ?? 0) - node.height / 2,
    });
  }
  return positions;
}

/**
 * Turn one project's graph into positioned boxes and nodes.
 *
 * Two passes, because the two structures are laid out by different things: members are placed
 * inside their box by the dependency edges that run BETWEEN THEM, and the boxes themselves are
 * placed on the canvas by the edges that cross box boundaries. An edge from a member to a task
 * outside its box therefore counts, for layout purposes, as an edge from the whole box — which is
 * what "the box is the unit" means. It is still DRAWN between its real endpoints, so the picture
 * never claims a dependency the data does not have.
 *
 * Pure and DOM-free so it can be asserted on directly; the React Flow rendering that consumes it
 * lives in `components/ProjectDependencyGraph.tsx`.
 */
export function layoutProjectDependencyGraph(
  graph: Pick<ProjectDependencyGraphResponse, 'marks' | 'edges'>,
): ProjectDependencyLayout {
  const byId = new Map(graph.marks.map((node) => [node.id, node]));
  // A parent is only a box when at least one of its children is on this canvas. A task whose
  // subtasks all live outside the project is an ordinary node, not an empty frame.
  const parents = new Set<string>();
  for (const node of graph.marks) {
    if (node.parentTaskId && byId.has(node.parentTaskId)) parents.add(node.parentTaskId);
  }
  // Edges that name a task this graph does not carry are dropped rather than drawn to nothing.
  const edges = graph.edges.filter(
    (edge) => byId.has(edge.sourceMarkId) && byId.has(edge.targetMarkId),
  );

  const members = new Map<string, ProjectGraphMark[]>();
  const standalone: ProjectGraphMark[] = [];
  for (const node of graph.marks) {
    const groupId = groupIdOf(node, byId, parents);
    if (groupId === null) {
      if (!parents.has(node.id)) standalone.push(node);
      continue;
    }
    const list = members.get(groupId);
    if (list) list.push(node);
    else members.set(groupId, [node]);
  }

  // Pass 1: inside each box, by the edges that stay inside it.
  const memberPositions = new Map<string, { x: number; y: number }>();
  const groupSizes = new Map<string, { width: number; height: number }>();
  for (const [groupId, group] of members) {
    const ids = new Set(group.map((node) => node.id));
    const inner = dagreLayout(
      group.map((node) => ({ id: node.id, width: markWidth(node), height: markHeight(node) })),
      edges
        .filter((edge) => ids.has(edge.sourceMarkId) && ids.has(edge.targetMarkId))
        .map((edge) => ({ source: edge.sourceMarkId, target: edge.targetMarkId })),
      'TB',
    );
    // dagre's own margin is not the box's padding, so normalize to (0,0) and apply the padding
    // this view uses — otherwise a box with one member is mostly empty space.
    let minX = Infinity;
    let minY = Infinity;
    for (const node of group) {
      const at = inner.get(node.id)!;
      minX = Math.min(minX, at.x);
      minY = Math.min(minY, at.y);
    }
    let maxX = 0;
    let maxY = 0;
    for (const node of group) {
      const at = inner.get(node.id)!;
      const x = at.x - minX + GROUP_PADDING;
      const y = at.y - minY + GROUP_HEADER;
      memberPositions.set(node.id, { x, y });
      maxX = Math.max(maxX, x + markWidth(node));
      maxY = Math.max(maxY, y + markHeight(node));
    }
    groupSizes.set(groupId, {
      width: maxX + GROUP_PADDING,
      height: maxY + GROUP_MEMBER_GAP,
    });
  }

  // Pass 2: the canvas. Every member collapses onto its box, so a box is one unit here however
  // many subtasks it holds — which is the whole reason the 24-task/49-edge shape stays readable.
  const unitOf = (taskId: string): string => {
    const node = byId.get(taskId);
    if (!node) return taskId;
    return groupIdOf(node, byId, parents) ?? taskId;
  };
  const units = [
    ...standalone.map((node) => ({ id: node.id, width: markWidth(node), height: markHeight(node) })),
    ...[...members.keys()].map((groupId) => ({
      id: groupId,
      width: groupSizes.get(groupId)!.width,
      height: groupSizes.get(groupId)!.height,
    })),
  ];
  const unitEdges = new Map<string, { source: string; target: string }>();
  for (const edge of edges) {
    const source = unitOf(edge.sourceMarkId);
    const target = unitOf(edge.targetMarkId);
    // A dependency between two subtasks of one parent is real, but it does not move the box it is
    // inside: as a unit edge it would be a self-loop, which dagre cannot rank.
    if (source === target) continue;
    unitEdges.set(`${source}->${target}`, { source, target });
  }
  const unitPositions = dagreLayout(units, [...unitEdges.values()], 'LR');

  const groups: ProjectGraphGroup[] = [...members.entries()].map(([groupId, group]) => {
    const at = unitPositions.get(groupId)!;
    const size = groupSizes.get(groupId)!;
    return { task: byId.get(groupId)!, members: group, x: at.x, y: at.y, ...size };
  });
  const placements: ProjectGraphPlacement[] = [
    ...standalone.map((node) => ({
      task: node,
      groupId: null,
      ...unitPositions.get(node.id)!,
    })),
    ...[...members.entries()].flatMap(([groupId, group]) =>
      group.map((node) => ({ task: node, groupId, ...memberPositions.get(node.id)! })),
    ),
  ];

  return { groups, placements, edges };
}

/**
 * What the canvas needs to decide where to open: how big the drawing is, and where the work is.
 *
 * A project can be far wider than any screen — a 118-task chain lays out about 32,000px across —
 * and fitting that to a strip 1,100px wide produces a row of dashes rather than a plan. So the
 * view is given a second option: open on the frontier at a zoom that keeps titles, and let the
 * reader zoom out to the whole shape when the shape is what they want.
 *
 * Only top-level units are measured. A subtask's coordinates are relative to the box it sits in,
 * so it is inside its box's rectangle by construction and cannot extend these bounds.
 */
export interface ProjectGraphOverview {
  /** The rectangle every drawn thing sits inside, in canvas coordinates. */
  bounds: { x: number; y: number; width: number; height: number };
  /**
   * Where the work has got to: the leftmost unit that is not finished — the first task a reader
   * scanning the plan left to right still has ahead of them. Null only for an empty canvas; a
   * plan that is entirely done points at its last unit, which is where its story ends.
   */
  frontier: { x: number; y: number } | null;
  /** Units on the canvas: standalone tasks and boxes, not the subtasks inside them. */
  unitCount: number;
}

export function projectGraphOverview(layout: ProjectDependencyLayout): ProjectGraphOverview {
  const units = [
    ...layout.groups.map((group) => ({
      task: group.task,
      x: group.x,
      y: group.y,
      width: group.width,
      height: group.height,
    })),
    ...layout.placements
      .filter((placement) => placement.groupId === null)
      .map((placement) => ({
        task: placement.task,
        x: placement.x,
        y: placement.y,
        width: markWidth(placement.task),
        height: markHeight(placement.task),
      })),
  ].sort((a, b) => a.x - b.x || a.y - b.y);

  if (units.length === 0) {
    return { bounds: { x: 0, y: 0, width: 0, height: 0 }, frontier: null, unitCount: 0 };
  }

  const minX = Math.min(...units.map((unit) => unit.x));
  const minY = Math.min(...units.map((unit) => unit.y));
  const maxX = Math.max(...units.map((unit) => unit.x + unit.width));
  const maxY = Math.max(...units.map((unit) => unit.y + unit.height));
  const unfinished = units.find(
    (unit) => getTaskDependencyVisualState(markLiveState(unit.task)) !== 'complete',
  );
  const frontier = unfinished ?? units[units.length - 1];

  return {
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    frontier: { x: frontier.x, y: frontier.y },
    unitCount: units.length,
  };
}

/**
 * A folded run, opened: the mark gives way to the tasks it stood for.
 *
 * Done here rather than by asking the server again, because the run already arrived with its
 * members — a fold is a way of DRAWING a project, not a way of withholding it. Opening one is
 * therefore instant and offline, and closing it again costs nothing.
 *
 * The run's own edges move to its ends: whatever waited on the run now waits on its last task,
 * and whatever the run waited on is now what its first task waits on. Everything between them is
 * the chain the fold was hiding.
 */
export function expandRunMarks(
  graph: Pick<ProjectDependencyGraphResponse, 'marks' | 'edges'>,
  expandedIds: ReadonlySet<string>,
): Pick<ProjectDependencyGraphResponse, 'marks' | 'edges'> {
  const opened = graph.marks.filter(
    (mark): mark is ProjectRunMark =>
      mark.kind === 'RUN' && mark.expandable && expandedIds.has(mark.id) && mark.members.length > 0,
  );
  if (opened.length === 0) return graph;

  const ends = new Map<string, { first: string; last: string }>();
  const marks: ProjectGraphMark[] = [];
  const edges = [...graph.edges];
  for (const mark of graph.marks) {
    const run = opened.find((candidate) => candidate.id === mark.id);
    if (!run) {
      marks.push(mark);
      continue;
    }
    ends.set(run.id, {
      first: run.members[0].taskId,
      last: run.members[run.members.length - 1].taskId,
    });
    run.members.forEach((member, index) => {
      marks.push({
        kind: 'TASK',
        id: member.taskId,
        taskId: member.taskId,
        title: member.title,
        status: member.status,
        running: member.running,
        queued: member.queued,
        parentTaskId: run.parentTaskId,
      });
      if (index > 0) {
        edges.push({
          sourceMarkId: run.members[index - 1].taskId,
          targetMarkId: member.taskId,
        });
      }
    });
  }

  return {
    marks,
    edges: edges.map((edge) => ({
      sourceMarkId: ends.get(edge.sourceMarkId)?.last ?? edge.sourceMarkId,
      targetMarkId: ends.get(edge.targetMarkId)?.first ?? edge.targetMarkId,
    })),
  };
}
