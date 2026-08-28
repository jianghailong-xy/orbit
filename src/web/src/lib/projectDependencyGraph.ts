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
 * A block of finished work, folded into one mark by THIS side rather than the server's.
 *
 * The server folds by shape — a straight run, a repeated motif — because that is what it can see
 * without knowing which project a reader has open. What it cannot fold is the thing that makes
 * most real plans wide: their settled prefix. A plan half-finished spends half its ranks on work
 * nobody is going to act on, and those ranks are what push the whole drawing below the zoom its
 * titles survive (see `MIN_FIT_ZOOM`). So a connected block of done tasks is drawn as one mark,
 * openable, and the ranks it was costing go back to the work that is still ahead.
 *
 * Only whole connected blocks, and only of two or more: a lone finished task folded into a box
 * saying "1 done" is bigger than the task it replaced.
 */
export interface ProjectSettledMark {
  kind: 'SETTLED';
  id: string;
  title: string;
  taskCount: number;
  statusCounts: MarkStatusCounts;
  parentTaskId: string | null;
  members: Array<{ taskId: string; title: string; status: string }>;
}

/**
 * A mark: the unit this canvas draws.
 *
 * Not a task, because a project of 23,442 tasks has no drawing made of 23,442 anything. The
 * server folds first (`apiserver/src/projects/project-graph-fold.ts`) and what arrives is what
 * survives folding — every task behind exactly one mark, however many tasks there are.
 */
export type ProjectGraphMark =
  | ProjectTaskMark
  | ProjectRunMark
  | ProjectMotifMark
  | ProjectSettledMark;

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

/**
 * Matches `.pdg-task` in index.css.
 *
 * Every pixel here is spent six or eight times over — a rank costs a node's width PLUS the gap
 * after it, and the number of ranks is what decides whether the whole plan fits at a zoom its
 * titles survive. The old 204x76 came from the task-rooted graph, which draws a handful of nodes
 * around one; a project draws a plan, and 168x64 with a two-line title says as much per node in
 * four fifths of the width.
 */
export const PROJECT_GRAPH_NODE_WIDTH = 168;
export const PROJECT_GRAPH_NODE_HEIGHT = 64;
/** Matches `.pdg-fold`: a little wider than a task, for the bar and what it counts. */
export const PROJECT_GRAPH_FOLD_WIDTH = 196;
export const PROJECT_GRAPH_FOLD_HEIGHT = 80;

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
  /** The direction dependencies advance across this particular canvas. */
  direction: 'LR' | 'TB';
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
  // The gap after a node is part of what a rank costs, so it is part of what decides the zoom the
  // whole plan fits at. 44 is what the orthogonal edge router needs to make its jog and no more.
  g.setGraph({ rankdir, nodesep: 18, ranksep: rankdir === 'LR' ? 44 : 32, marginx: 16, marginy: 16 });
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
 * `direction` is left-to-right on the desktop and top-to-bottom on a portrait phone. Pure and
 * DOM-free so both readings can be asserted on directly; the React Flow rendering that consumes
 * it lives in `components/ProjectDependencyGraph.tsx`.
 */
export function layoutProjectDependencyGraph(
  graph: Pick<ProjectDependencyGraphResponse, 'marks' | 'edges'>,
  direction: 'LR' | 'TB' = 'LR',
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
  const unitPositions = dagreLayout(units, [...unitEdges.values()], direction);

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

  return { direction, groups, placements, edges };
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
   * Where the work has got to: the first unit in the layout direction that is not finished. Null
   * only for an empty canvas; a plan that is entirely done points at its last unit, which is where
   * its story ends.
   */
  frontier: { x: number; y: number; width: number; height: number } | null;
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
  ].sort((a, b) =>
    layout.direction === 'TB' ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y,
  );

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
    // Keep the unit's real dimensions. A frontier can be a parent-task box or a folded mark,
    // neither of which is the size of an ordinary task card. The viewport uses this rectangle to
    // put the unit's centre — not an assumed card-sized point near its top-left — in the canvas.
    frontier: {
      x: frontier.x,
      y: frontier.y,
      width: frontier.width,
      height: frontier.height,
    },
    unitCount: units.length,
  };
}

/** Below this, a fold is bigger than what it replaced. */
const SETTLED_MIN_MEMBERS = 2;

/**
 * Fold each connected block of finished tasks into one mark — the client's own fold.
 *
 * The rule is deliberately the narrowest one that reduces ranks: a block is a set of DONE tasks
 * joined to each other by dependency edges, all under the same parent, none of them a parent box
 * of their own. Two done tasks with an open task between them are two blocks, not one, because
 * folding them together would claim an ordering the plan does not have.
 *
 * `expandedIds` holds the folds a reader has opened; opening one is simply not folding it, so
 * there is no second function to undo this and nothing to keep in sync with what it produced.
 *
 * Runs and motifs pass through untouched. This runs BEFORE `expandRunMarks` so that opening a run
 * whose steps are all done does not hand those steps straight back to this and fold them again.
 */
export function foldSettledMarks(
  graph: Pick<ProjectDependencyGraphResponse, 'marks' | 'edges'>,
  expandedIds: ReadonlySet<string>,
): Pick<ProjectDependencyGraphResponse, 'marks' | 'edges'> {
  const byId = new Map(graph.marks.map((mark) => [mark.id, mark]));
  const parents = new Set<string>();
  for (const mark of graph.marks) {
    if (mark.parentTaskId && byId.has(mark.parentTaskId)) parents.add(mark.parentTaskId);
  }
  const settleable = new Map<string, ProjectTaskMark>();
  for (const mark of graph.marks) {
    if (mark.kind !== 'TASK') continue;
    if (mark.status !== 'DONE' || mark.running || mark.queued) continue;
    if (parents.has(mark.id)) continue;
    settleable.set(mark.id, mark);
  }
  if (settleable.size < SETTLED_MIN_MEMBERS) return graph;

  // Union-find over the edges that join two settleable marks under the same parent.
  const root = new Map<string, string>([...settleable.keys()].map((id) => [id, id]));
  const find = (id: string): string => {
    let at = id;
    while (root.get(at) !== at) at = root.get(at)!;
    let walk = id;
    while (root.get(walk) !== at) {
      const next = root.get(walk)!;
      root.set(walk, at);
      walk = next;
    }
    return at;
  };
  for (const edge of graph.edges) {
    const source = settleable.get(edge.sourceMarkId);
    const target = settleable.get(edge.targetMarkId);
    if (!source || !target || source.parentTaskId !== target.parentTaskId) continue;
    const a = find(source.id);
    const b = find(target.id);
    if (a !== b) root.set(a, b);
  }

  const blocks = new Map<string, ProjectTaskMark[]>();
  for (const mark of settleable.values()) {
    const key = find(mark.id);
    const block = blocks.get(key);
    if (block) block.push(mark);
    else blocks.set(key, [mark]);
  }

  // Named after the smallest member id so the same block keeps the same id across refetches, and
  // so a fold a reader opened does not close itself when a status somewhere else changes.
  const foldIdOf = new Map<string, string>();
  const folds = new Map<string, ProjectSettledMark>();
  for (const block of blocks.values()) {
    if (block.length < SETTLED_MIN_MEMBERS) continue;
    const members = [...block].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const id = `settled:${members[0].id}`;
    if (expandedIds.has(id)) continue;
    for (const member of members) foldIdOf.set(member.id, id);
    folds.set(id, {
      kind: 'SETTLED',
      id,
      title: `${members.length} done`,
      taskCount: members.length,
      statusCounts: { DONE: members.length },
      parentTaskId: members[0].parentTaskId,
      members: members.map((member) => ({
        taskId: member.taskId,
        title: member.title,
        status: member.status,
      })),
    });
  }
  if (folds.size === 0) return graph;

  const unitOf = (id: string) => foldIdOf.get(id) ?? id;
  const marks: ProjectGraphMark[] = [];
  const emitted = new Set<string>();
  for (const mark of graph.marks) {
    const foldId = foldIdOf.get(mark.id);
    if (!foldId) {
      marks.push(mark);
      continue;
    }
    if (emitted.has(foldId)) continue;
    emitted.add(foldId);
    marks.push(folds.get(foldId)!);
  }
  const edges = new Map<string, ProjectGraphMarkEdge>();
  for (const edge of graph.edges) {
    const sourceMarkId = unitOf(edge.sourceMarkId);
    const targetMarkId = unitOf(edge.targetMarkId);
    // Inside a block the ordering is the block's own business, and as a unit edge it is a
    // self-loop, which dagre cannot rank.
    if (sourceMarkId === targetMarkId) continue;
    edges.set(`${sourceMarkId}->${targetMarkId}`, { sourceMarkId, targetMarkId });
  }

  // Contracting a connected block of a DAG can still close a cycle, when a plan holds a task
  // marked done ahead of a prerequisite that is not. Rather than draw an arrow that points
  // backwards, leave a plan like that unfolded and say what it is by drawing it in full.
  return hasCycle(marks, [...edges.values()]) ? graph : { marks, edges: [...edges.values()] };
}

/** Kahn, only for the yes/no. */
function hasCycle(marks: ProjectGraphMark[], edges: ProjectGraphMarkEdge[]): boolean {
  const indegree = new Map(marks.map((mark) => [mark.id, 0]));
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    if (!indegree.has(edge.sourceMarkId) || !indegree.has(edge.targetMarkId)) continue;
    indegree.set(edge.targetMarkId, indegree.get(edge.targetMarkId)! + 1);
    const list = out.get(edge.sourceMarkId);
    if (list) list.push(edge.targetMarkId);
    else out.set(edge.sourceMarkId, [edge.targetMarkId]);
  }
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  let settled = 0;
  while (ready.length > 0) {
    const id = ready.pop()!;
    settled += 1;
    for (const next of out.get(id) ?? []) {
      const left = indegree.get(next)! - 1;
      indegree.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  return settled !== marks.length;
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
