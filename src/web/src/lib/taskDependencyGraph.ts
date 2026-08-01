/**
 * A node returned by the task dependency-graph endpoint.
 *
 * `depth` is measured upstream from the focused task: the focus is 0, its direct
 * prerequisites are 1, and so on. It is a display hint only; graph relationships
 * always come from `edges`.
 */
export interface TaskDependencyGraphNode {
  id: string;
  title: string;
  status: string;
  dependencyState?: string;
  running?: boolean;
  queued?: boolean;
  autoRunWhenReady?: boolean;
  depth?: number;
  isDirect?: boolean;
}

/**
 * A display-oriented dependency edge. The prerequisite is always the source and
 * the task waiting for it is always the target, so arrows flow toward the focus.
 */
export interface TaskDependencyGraphEdge {
  sourceTaskId: string;
  targetTaskId: string;
}

export interface TaskDependencyGraphResponse {
  focusTaskId: string;
  nodes: TaskDependencyGraphNode[];
  edges: TaskDependencyGraphEdge[];
  maxDepth?: number;
  truncated?: boolean;
  direction?: 'upstream';
  counts?: {
    upstream: number;
    total: number;
    done: number;
    remaining: number;
    failed: number;
  };
  limits?: {
    maxDepth: number;
    maxNodes: number;
    maxEdges?: number;
  };
}

export type TaskDependencyVisualState =
  | 'complete'
  | 'active'
  | 'queued'
  | 'failed'
  | 'pending';

export interface NormalizedTaskDependencyGraph {
  focusTaskId: string;
  focusNode?: TaskDependencyGraphNode;
  /** Nodes in deterministic prerequisite-before-dependent order. */
  nodes: TaskDependencyGraphNode[];
  /** Deduplicated edges whose two endpoints are present in `nodes`. */
  edges: TaskDependencyGraphEdge[];
  nodeById: ReadonlyMap<string, TaskDependencyGraphNode>;
  /** Incoming source ids are this task's prerequisites. */
  incomingByTaskId: ReadonlyMap<string, readonly string[]>;
  /** Outgoing target ids are the tasks waiting for this task. */
  outgoingByTaskId: ReadonlyMap<string, readonly string[]>;
  topologicalNodeIds: string[];
  /** True only for malformed/non-DAG input; valid API responses always return false. */
  hasCycle: boolean;
  /** Nodes Kahn's algorithm could not resolve because a cycle is present upstream. */
  unresolvedNodeIds: string[];
  discardedEdgeCount: number;
}

export interface FocusPathSets {
  /** The focus and every node with a directed path into it. */
  nodeIds: ReadonlySet<string>;
  /** Keys for every edge on a directed path into the focus. */
  edgeKeys: ReadonlySet<string>;
  /** Sources of edges that terminate immediately at the focus. */
  directPrerequisiteIds: ReadonlySet<string>;
}

/** A collision-safe, deterministic key for React/SVG edge elements and path sets. */
export function taskDependencyEdgeKey(edge: TaskDependencyGraphEdge): string {
  return JSON.stringify([edge.sourceTaskId, edge.targetTaskId]);
}

const compareIds = (a: string, b: string): number => a.localeCompare(b);

/**
 * Defensive normalization at the API/UI boundary. Besides making graph rendering
 * deterministic, this prevents a partial response from creating phantom dagre nodes:
 * duplicate edges are collapsed and edges with a missing endpoint are discarded.
 */
export function normalizeTaskDependencyGraph(
  graph: Pick<TaskDependencyGraphResponse, 'focusTaskId' | 'nodes' | 'edges'>,
): NormalizedTaskDependencyGraph {
  const nodeById = new Map<string, TaskDependencyGraphNode>();
  for (const node of graph.nodes) {
    if (!nodeById.has(node.id)) nodeById.set(node.id, node);
  }

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeById.keys()) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }

  const edgeKeys = new Set<string>();
  const edges: TaskDependencyGraphEdge[] = [];
  let discardedEdgeCount = 0;
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.sourceTaskId) || !nodeById.has(edge.targetTaskId)) {
      discardedEdgeCount += 1;
      continue;
    }
    const key = taskDependencyEdgeKey(edge);
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push(edge);
    outgoing.get(edge.sourceTaskId)!.push(edge.targetTaskId);
    incoming.get(edge.targetTaskId)!.push(edge.sourceTaskId);
  }

  edges.sort(
    (a, b) =>
      compareIds(a.sourceTaskId, b.sourceTaskId) ||
      compareIds(a.targetTaskId, b.targetTaskId),
  );
  for (const adjacent of incoming.values()) adjacent.sort(compareIds);
  for (const adjacent of outgoing.values()) adjacent.sort(compareIds);

  // Kahn's algorithm follows the API's display orientation. A prerequisite source
  // therefore always appears before the dependent target in valid DAG input.
  const remainingIncoming = new Map<string, number>();
  for (const [id, sources] of incoming) remainingIncoming.set(id, sources.length);
  const ready = [...nodeById.keys()]
    .filter((id) => remainingIncoming.get(id) === 0)
    .sort(compareIds);
  const topologicalNodeIds: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    topologicalNodeIds.push(id);
    for (const targetId of outgoing.get(id) ?? []) {
      const next = remainingIncoming.get(targetId)! - 1;
      remainingIncoming.set(targetId, next);
      if (next === 0) {
        ready.push(targetId);
        ready.sort(compareIds);
      }
    }
  }

  const resolved = new Set(topologicalNodeIds);
  const unresolvedNodeIds = [...nodeById.keys()]
    .filter((id) => !resolved.has(id))
    .sort(compareIds);
  // Preserve every node for an error/fallback rendering even if malformed input has a cycle.
  topologicalNodeIds.push(...unresolvedNodeIds);

  return {
    focusTaskId: graph.focusTaskId,
    focusNode: nodeById.get(graph.focusTaskId),
    nodes: topologicalNodeIds.map((id) => nodeById.get(id)!),
    edges,
    nodeById,
    incomingByTaskId: incoming,
    outgoingByTaskId: outgoing,
    topologicalNodeIds,
    hasCycle: unresolvedNodeIds.length > 0,
    unresolvedNodeIds,
    discardedEdgeCount,
  };
}

/**
 * Find all nodes and edges that can reach the focused task. Walking incoming edges
 * makes this work even when a response later includes downstream or unrelated nodes.
 */
export function getFocusPathSets(graph: NormalizedTaskDependencyGraph): FocusPathSets {
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const directPrerequisiteIds = new Set<string>();
  if (!graph.nodeById.has(graph.focusTaskId)) {
    return { nodeIds, edgeKeys, directPrerequisiteIds };
  }

  nodeIds.add(graph.focusTaskId);
  const pending = [graph.focusTaskId];
  while (pending.length > 0) {
    const targetTaskId = pending.pop()!;
    for (const sourceTaskId of graph.incomingByTaskId.get(targetTaskId) ?? []) {
      edgeKeys.add(taskDependencyEdgeKey({ sourceTaskId, targetTaskId }));
      if (targetTaskId === graph.focusTaskId) directPrerequisiteIds.add(sourceTaskId);
      if (nodeIds.has(sourceTaskId)) continue;
      nodeIds.add(sourceTaskId);
      pending.push(sourceTaskId);
    }
  }

  return { nodeIds, edgeKeys, directPrerequisiteIds };
}

/**
 * Reduce task/runtime status to the five visual states used by both nodes and edges.
 * Terminal task status is authoritative; runtime flags refine non-terminal tasks.
 */
export function getTaskDependencyVisualState(
  node?: Pick<TaskDependencyGraphNode, 'status' | 'running' | 'queued'>,
): TaskDependencyVisualState {
  if (!node) return 'pending';
  if (node.status === 'FAILED' || node.status === 'CANCELLED') return 'failed';
  if (node.status === 'DONE') return 'complete';
  if (node.running || node.status === 'IN_PROGRESS') return 'active';
  if (node.queued) return 'queued';
  return 'pending';
}

/**
 * An edge describes whether its prerequisite has released the dependent. Its state
 * is intentionally derived from the source, never the target.
 */
export function getTaskDependencyEdgeState(
  graph: Pick<NormalizedTaskDependencyGraph, 'nodeById'>,
  edge: TaskDependencyGraphEdge,
): TaskDependencyVisualState {
  return getTaskDependencyVisualState(graph.nodeById.get(edge.sourceTaskId));
}
