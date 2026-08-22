import dagre from '@dagrejs/dagre';
import type { TaskDependencyGraphEdge, TaskDependencyGraphNode } from './taskDependencyGraph';

/**
 * One task in a project's dependency graph.
 *
 * Deliberately `TaskDependencyGraphNode` plus one field rather than a parallel shape: the same
 * canvas vocabulary reads both this graph and the single-task one, and two words for "a task on a
 * graph" is how two views drift into rendering the same status differently. `parentTaskId` is the
 * addition — a project graph has a task tree to fold away, a task-rooted graph has none.
 */
export interface ProjectDependencyGraphNode extends TaskDependencyGraphNode {
  parentTaskId: string | null;
}

/**
 * `GET /projects/:id/dependency-graph` — the whole project at once, not a page of it.
 *
 * `edges` point prerequisite → dependent, the same direction the task-rooted graph uses. Edges
 * with one end outside the project are not in here at all: the server drops them rather than
 * inventing a stub node this page could not open.
 */
export interface ProjectDependencyGraphResponse {
  nodes: ProjectDependencyGraphNode[];
  edges: TaskDependencyGraphEdge[];
  /** The project has more tasks than one response carries. Never true at a drawable size. */
  truncated: boolean;
  limits: { maxNodes: number };
}

/** Matches `.tdg-node` in index.css — the project graph reuses the task graph's node chrome. */
export const PROJECT_GRAPH_NODE_WIDTH = 204;
export const PROJECT_GRAPH_NODE_HEIGHT = 76;
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
  edges: TaskDependencyGraphEdge[];
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
  graph: ProjectDependencyGraphResponse,
): ProjectDependencyLayout {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  // A parent is only a box when at least one of its children is on this canvas. A task whose
  // subtasks all live outside the project is an ordinary node, not an empty frame.
  const parents = new Set<string>();
  for (const node of graph.nodes) {
    if (node.parentTaskId && byId.has(node.parentTaskId)) parents.add(node.parentTaskId);
  }
  // Edges that name a task this graph does not carry are dropped rather than drawn to nothing.
  const edges = graph.edges.filter(
    (edge) => byId.has(edge.sourceTaskId) && byId.has(edge.targetTaskId),
  );

  const members = new Map<string, ProjectDependencyGraphNode[]>();
  const standalone: ProjectDependencyGraphNode[] = [];
  for (const node of graph.nodes) {
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
      group.map((node) => ({
        id: node.id,
        width: PROJECT_GRAPH_NODE_WIDTH,
        height: PROJECT_GRAPH_NODE_HEIGHT,
      })),
      edges
        .filter((edge) => ids.has(edge.sourceTaskId) && ids.has(edge.targetTaskId))
        .map((edge) => ({ source: edge.sourceTaskId, target: edge.targetTaskId })),
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
      maxX = Math.max(maxX, x + PROJECT_GRAPH_NODE_WIDTH);
      maxY = Math.max(maxY, y + PROJECT_GRAPH_NODE_HEIGHT);
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
    ...standalone.map((node) => ({
      id: node.id,
      width: PROJECT_GRAPH_NODE_WIDTH,
      height: PROJECT_GRAPH_NODE_HEIGHT,
    })),
    ...[...members.keys()].map((groupId) => ({
      id: groupId,
      width: groupSizes.get(groupId)!.width,
      height: groupSizes.get(groupId)!.height,
    })),
  ];
  const unitEdges = new Map<string, { source: string; target: string }>();
  for (const edge of edges) {
    const source = unitOf(edge.sourceTaskId);
    const target = unitOf(edge.targetTaskId);
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
