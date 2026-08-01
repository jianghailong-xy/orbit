/**
 * A node returned by the task dependency-graph endpoint.
 *
 * `depth` is measured from the focused task. It is a display hint only; graph
 * relationships and their direction always come from `edges`.
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
  /** Total direct edges on each side, including neighbors omitted from this snapshot. */
  prerequisiteCount?: number;
  dependentCount?: number;
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
  direction?: 'upstream' | 'both';
  counts?: {
    upstream: number;
    downstream?: number;
    /** Every related node in the returned weakly connected component, excluding focus. */
    connected?: number;
    /** Connected nodes that are neither ancestors nor descendants of focus. */
    lateral?: number;
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
  /** Server-backed branch boundaries. Omitted by older/all-at-once graph responses. */
  collapsedGroups?: TaskDependencyCollapsedGroup[];
}

export interface TaskDependencyCollapsedGroup {
  anchorTaskId: string;
  direction: TaskDependencyBranchDirection;
  hiddenCount: number;
  cursor?: string | null;
}

export interface TaskDependencyGraphExpansionResponse {
  nodes: TaskDependencyGraphNode[];
  edges: TaskDependencyGraphEdge[];
  remainingCount?: number;
  nextCursor?: string | null;
  collapsedGroups?: TaskDependencyCollapsedGroup[];
}

/**
 * Build the useful one-hop fallback available in task detail responses. The graph API
 * normally replaces this with the complete connected DAG, but keeping both directions
 * here means a temporary graph request failure never hides that other tasks depend on a
 * root task.
 */
export function buildDirectTaskDependencyGraph(
  focusTaskId: string,
  focus: TaskDependencyGraphNode,
  prerequisites: readonly TaskDependencyGraphNode[],
  dependents: readonly TaskDependencyGraphNode[],
): TaskDependencyGraphResponse {
  const nodes = new Map<string, TaskDependencyGraphNode>([[focusTaskId, focus]]);
  for (const prerequisite of prerequisites) {
    if (!nodes.has(prerequisite.id)) nodes.set(prerequisite.id, prerequisite);
  }
  for (const dependent of dependents) {
    if (!nodes.has(dependent.id)) nodes.set(dependent.id, dependent);
  }

  const edges = [
    ...prerequisites.map((task) => ({ sourceTaskId: task.id, targetTaskId: focusTaskId })),
    ...dependents.map((task) => ({ sourceTaskId: focusTaskId, targetTaskId: task.id })),
  ];
  const uniqueEdges = new Map(edges.map((edge) => [taskDependencyEdgeKey(edge), edge]));
  const done = prerequisites.filter((task) => task.status === 'DONE').length;
  const failed = prerequisites.filter(
    (task) => task.status === 'FAILED' || task.status === 'CANCELLED',
  ).length;

  return {
    focusTaskId,
    direction: 'both',
    nodes: [...nodes.values()],
    edges: [...uniqueEdges.values()],
    maxDepth: uniqueEdges.size > 0 ? 1 : 0,
    counts: {
      upstream: prerequisites.length,
      downstream: dependents.length,
      connected: Math.max(nodes.size - 1, 0),
      total: nodes.size,
      done,
      remaining: prerequisites.length - done - failed,
      failed,
    },
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

export type TaskDependencyBranchDirection = 'prerequisites' | 'dependents';

/**
 * A collapsed boundary in the client-side graph projection. The key is stable across
 * status refreshes, and can also be used by a future cursor-based graph endpoint.
 */
export interface TaskDependencyBranchAggregate {
  id: string;
  branchKey: string;
  parentTaskId: string;
  direction: TaskDependencyBranchDirection;
  remainingCount: number;
  /** Hidden neighbors already present in the current response and revealable without I/O. */
  loadedRemainingCount: number;
  revealedCount: number;
  nextBatchCount: number;
  /** True when the next batch must be fetched rather than revealed from the loaded snapshot. */
  remote?: boolean;
  cursor?: string | null;
}

export interface TaskDependencyGraphProjection {
  /** The induced graph containing only real tasks that are currently visible. */
  graph: NormalizedTaskDependencyGraph;
  aggregates: TaskDependencyBranchAggregate[];
  mainPathNodeIds: ReadonlySet<string>;
  totalNodeCount: number;
  visibleNodeCount: number;
  collapsed: boolean;
}

export interface TaskDependencyGraphProjectionOptions {
  batchSize?: number;
  collapseThreshold?: number;
  collapsedGroups?: readonly TaskDependencyCollapsedGroup[];
}

export const DEFAULT_DEPENDENCY_GRAPH_BATCH_SIZE = 8;
export const DEFAULT_DEPENDENCY_GRAPH_COLLAPSE_THRESHOLD = 24;

/** Collision-safe branch identity shared by expansion state and future pagination requests. */
export function taskDependencyBranchKey(
  taskId: string,
  direction: TaskDependencyBranchDirection,
): string {
  return JSON.stringify(['dependency-branch', taskId, direction]);
}

function selectLongestNeighbor(
  neighbors: readonly string[],
  lengths: ReadonlyMap<string, number>,
): string | undefined {
  let selected: string | undefined;
  let selectedLength = -1;
  for (const id of neighbors) {
    const length = lengths.get(id) ?? 0;
    if (length > selectedLength || (length === selectedLength && selected !== undefined && compareIds(id, selected) < 0)) {
      selected = id;
      selectedLength = length;
    }
  }
  return selected;
}

/**
 * Pick one deterministic longest prerequisite -> focus -> dependent chain. Keeping this
 * backbone visible gives a middle task stable context even when wide sibling branches collapse.
 */
export function getTaskDependencyMainPathNodeIds(
  graph: NormalizedTaskDependencyGraph,
): string[] {
  if (!graph.nodeById.has(graph.focusTaskId) || graph.hasCycle) return [graph.focusTaskId];

  const upstreamLength = new Map<string, number>();
  const upstreamPrevious = new Map<string, string>();
  for (const id of graph.topologicalNodeIds) {
    const previous = selectLongestNeighbor(graph.incomingByTaskId.get(id) ?? [], upstreamLength);
    upstreamLength.set(id, previous === undefined ? 0 : (upstreamLength.get(previous) ?? 0) + 1);
    if (previous !== undefined) upstreamPrevious.set(id, previous);
  }

  const downstreamLength = new Map<string, number>();
  const downstreamNext = new Map<string, string>();
  for (let index = graph.topologicalNodeIds.length - 1; index >= 0; index -= 1) {
    const id = graph.topologicalNodeIds[index];
    const next = selectLongestNeighbor(graph.outgoingByTaskId.get(id) ?? [], downstreamLength);
    downstreamLength.set(id, next === undefined ? 0 : (downstreamLength.get(next) ?? 0) + 1);
    if (next !== undefined) downstreamNext.set(id, next);
  }

  const upstream: string[] = [];
  let cursor = graph.focusTaskId;
  while (upstreamPrevious.has(cursor)) {
    cursor = upstreamPrevious.get(cursor)!;
    upstream.unshift(cursor);
  }
  const downstream: string[] = [];
  cursor = graph.focusTaskId;
  while (downstreamNext.has(cursor)) {
    cursor = downstreamNext.get(cursor)!;
    downstream.push(cursor);
  }
  return [...upstream, graph.focusTaskId, ...downstream];
}

function branchNeighbors(
  graph: NormalizedTaskDependencyGraph,
  taskId: string,
  direction: TaskDependencyBranchDirection,
): readonly string[] {
  return direction === 'prerequisites'
    ? (graph.incomingByTaskId.get(taskId) ?? [])
    : (graph.outgoingByTaskId.get(taskId) ?? []);
}

/**
 * Project a large loaded snapshot into a progressively expandable graph. This is deliberately
 * independent of transport: appending nodes/edges from a future paginated API and calling this
 * function again preserves expansion state because branches have stable keys.
 */
export function projectTaskDependencyGraph(
  graph: NormalizedTaskDependencyGraph,
  expandedByBranch: ReadonlyMap<string, number> = new Map(),
  options: TaskDependencyGraphProjectionOptions = {},
): TaskDependencyGraphProjection {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_DEPENDENCY_GRAPH_BATCH_SIZE));
  const collapseThreshold = Math.max(
    1,
    Math.floor(options.collapseThreshold ?? DEFAULT_DEPENDENCY_GRAPH_COLLAPSE_THRESHOLD),
  );
  const mainPath = getTaskDependencyMainPathNodeIds(graph);
  const mainPathNodeIds = new Set(mainPath);

  const remoteGroups = new Map<string, TaskDependencyCollapsedGroup>();
  for (const task of graph.nodes) {
    const countedDirections: Array<{
      direction: TaskDependencyBranchDirection;
      total: number | undefined;
      loaded: number;
    }> = [
      {
        direction: 'prerequisites',
        total: task.prerequisiteCount,
        loaded: graph.incomingByTaskId.get(task.id)?.length ?? 0,
      },
      {
        direction: 'dependents',
        total: task.dependentCount,
        loaded: graph.outgoingByTaskId.get(task.id)?.length ?? 0,
      },
    ];
    for (const counted of countedDirections) {
      if (counted.total === undefined || counted.total <= counted.loaded) continue;
      const group: TaskDependencyCollapsedGroup = {
        anchorTaskId: task.id,
        direction: counted.direction,
        hiddenCount: counted.total - counted.loaded,
      };
      remoteGroups.set(taskDependencyBranchKey(task.id, counted.direction), group);
    }
  }
  for (const group of options.collapsedGroups ?? []) {
    const key = taskDependencyBranchKey(group.anchorTaskId, group.direction);
    if (group.hiddenCount > 0) remoteGroups.set(key, group);
    else remoteGroups.delete(key);
  }

  const mergeRemoteGroups = (
    localAggregates: readonly TaskDependencyBranchAggregate[],
    visibleGraph: NormalizedTaskDependencyGraph,
  ): TaskDependencyBranchAggregate[] => {
    const combined = new Map(localAggregates.map((aggregate) => [aggregate.branchKey, aggregate]));
    for (const [branchKey, group] of remoteGroups) {
      if (!visibleGraph.nodeById.has(group.anchorTaskId)) continue;
      const local = combined.get(branchKey);
      if (local) {
        combined.set(branchKey, {
          ...local,
          remainingCount: local.remainingCount + group.hiddenCount,
          remote: true,
          cursor: group.cursor,
        });
      } else {
        combined.set(branchKey, {
          id: branchKey,
          branchKey,
          parentTaskId: group.anchorTaskId,
          direction: group.direction,
          remainingCount: group.hiddenCount,
          loadedRemainingCount: 0,
          revealedCount: 0,
          nextBatchCount: Math.min(batchSize, group.hiddenCount),
          remote: true,
          cursor: group.cursor,
        });
      }
    }
    return [...combined.values()];
  };

  if (graph.nodes.length <= collapseThreshold || !graph.focusNode || graph.hasCycle) {
    const aggregates = mergeRemoteGroups([], graph);
    return {
      graph,
      aggregates,
      mainPathNodeIds,
      totalNodeCount: graph.nodes.length,
      visibleNodeCount: graph.nodes.length,
      collapsed: aggregates.length > 0,
    };
  }

  const directions: readonly TaskDependencyBranchDirection[] = ['prerequisites', 'dependents'];
  const defaultRevealLimit = (taskId: string, branchSize: number): number => {
    if (taskId === graph.focusTaskId) return batchSize;
    // Once a branch root is revealed, keep walking its unambiguous single-neighbor chain.
    // This shows compact P -> W pairs together without recursively exploding wide branches.
    return branchSize === 1 ? 1 : 0;
  };
  const visibleNodeIds = new Set(mainPath);
  const pending = [...mainPath];
  for (let index = 0; index < pending.length; index += 1) {
    const taskId = pending[index];
    for (const direction of directions) {
      const branchKey = taskDependencyBranchKey(taskId, direction);
      const offMainPath = branchNeighbors(graph, taskId, direction).filter(
        (id) => !mainPathNodeIds.has(id),
      );
      const defaultLimit = defaultRevealLimit(taskId, offMainPath.length);
      const revealLimit = Math.min(
        offMainPath.length,
        Math.max(defaultLimit, Math.floor(expandedByBranch.get(branchKey) ?? 0)),
      );
      for (const id of offMainPath.slice(0, revealLimit)) {
        if (visibleNodeIds.has(id)) continue;
        visibleNodeIds.add(id);
        pending.push(id);
      }
    }
  }

  const visibleNodes = graph.nodes.filter((node) => visibleNodeIds.has(node.id));
  const visibleEdges = graph.edges.filter(
    (edge) => visibleNodeIds.has(edge.sourceTaskId) && visibleNodeIds.has(edge.targetTaskId),
  );
  const visibleGraph = normalizeTaskDependencyGraph({
    focusTaskId: graph.focusTaskId,
    nodes: visibleNodes,
    edges: visibleEdges,
  });

  const aggregates: TaskDependencyBranchAggregate[] = [];
  for (const task of visibleGraph.nodes) {
    for (const direction of directions) {
      const hidden = branchNeighbors(graph, task.id, direction).filter(
        (id) => !visibleNodeIds.has(id),
      );
      if (hidden.length === 0) continue;
      const branchKey = taskDependencyBranchKey(task.id, direction);
      const offMainPathCount = branchNeighbors(graph, task.id, direction).filter(
        (id) => !mainPathNodeIds.has(id),
      ).length;
      const defaultLimit = defaultRevealLimit(task.id, offMainPathCount);
      const revealedCount = Math.min(
        offMainPathCount,
        Math.max(defaultLimit, Math.floor(expandedByBranch.get(branchKey) ?? 0)),
      );
      aggregates.push({
        id: branchKey,
        branchKey,
        parentTaskId: task.id,
        direction,
        remainingCount: hidden.length,
        loadedRemainingCount: hidden.length,
        revealedCount,
        nextBatchCount: Math.min(batchSize, hidden.length),
      });
    }
  }

  const combinedAggregates = mergeRemoteGroups(aggregates, visibleGraph);

  return {
    graph: visibleGraph,
    aggregates: combinedAggregates,
    mainPathNodeIds,
    totalNodeCount: graph.nodes.length,
    visibleNodeCount: visibleGraph.nodes.length,
    collapsed: combinedAggregates.length > 0,
  };
}

/** Merge one paginated branch delta without duplicating shared DAG nodes or edges. */
export function mergeTaskDependencyGraphExpansion(
  current: TaskDependencyGraphResponse,
  expansion: TaskDependencyGraphExpansionResponse,
  requestedGroup: Pick<TaskDependencyCollapsedGroup, 'anchorTaskId' | 'direction'>,
): TaskDependencyGraphResponse {
  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  for (const node of expansion.nodes) nodes.set(node.id, { ...nodes.get(node.id), ...node });

  const edges = new Map(current.edges.map((edge) => [taskDependencyEdgeKey(edge), edge]));
  for (const edge of expansion.edges) edges.set(taskDependencyEdgeKey(edge), edge);

  const groups = new Map<string, TaskDependencyCollapsedGroup>();
  for (const group of current.collapsedGroups ?? []) {
    if (group.hiddenCount > 0) {
      groups.set(taskDependencyBranchKey(group.anchorTaskId, group.direction), group);
    }
  }
  // Expansion groups are an upsert delta: expanding one diamond branch must not erase the
  // untouched boundaries elsewhere in the snapshot.
  for (const group of expansion.collapsedGroups ?? []) {
    const key = taskDependencyBranchKey(group.anchorTaskId, group.direction);
    if (group.hiddenCount > 0) groups.set(key, group);
    else groups.delete(key);
  }
  if (expansion.remainingCount !== undefined) {
    const key = taskDependencyBranchKey(requestedGroup.anchorTaskId, requestedGroup.direction);
    if (expansion.remainingCount > 0) {
      groups.set(key, {
        ...requestedGroup,
        hiddenCount: expansion.remainingCount,
        cursor: expansion.nextCursor,
      });
    } else {
      groups.delete(key);
    }
  }

  // A shared node returned while expanding B may also fill C's missing edge. Recompute every
  // counted boundary from the merged edge set so C's stale aggregate disappears as well.
  const mergedEdges = [...edges.values()];
  for (const task of nodes.values()) {
    const countedDirections: Array<{
      direction: TaskDependencyBranchDirection;
      total: number | undefined;
      loaded: number;
    }> = [
      {
        direction: 'prerequisites',
        total: task.prerequisiteCount,
        loaded: mergedEdges.filter((edge) => edge.targetTaskId === task.id).length,
      },
      {
        direction: 'dependents',
        total: task.dependentCount,
        loaded: mergedEdges.filter((edge) => edge.sourceTaskId === task.id).length,
      },
    ];
    for (const counted of countedDirections) {
      if (counted.total === undefined) continue;
      const key = taskDependencyBranchKey(task.id, counted.direction);
      const hiddenCount = Math.max(0, counted.total - counted.loaded);
      if (hiddenCount === 0) {
        groups.delete(key);
      } else {
        const existing = groups.get(key);
        groups.set(key, {
          anchorTaskId: task.id,
          direction: counted.direction,
          hiddenCount,
          cursor: existing?.cursor,
        });
      }
    }
  }

  const collapsedGroups =
    current.collapsedGroups !== undefined || expansion.collapsedGroups !== undefined || groups.size > 0
      ? [...groups.values()]
      : undefined;

  let counts = current.counts;
  if (counts) {
    const normalized = normalizeTaskDependencyGraph({
      focusTaskId: current.focusTaskId,
      nodes: [...nodes.values()],
      edges: mergedEdges,
    });
    const reachable = (adjacency: ReadonlyMap<string, readonly string[]>): Set<string> => {
      const reached = new Set<string>();
      const pending = [...(adjacency.get(current.focusTaskId) ?? [])];
      while (pending.length > 0) {
        const id = pending.pop()!;
        if (reached.has(id) || id === current.focusTaskId) continue;
        reached.add(id);
        pending.push(...(adjacency.get(id) ?? []));
      }
      return reached;
    };
    const upstreamIds = reachable(normalized.incomingByTaskId);
    const downstreamIds = reachable(normalized.outgoingByTaskId);
    const upstreamNodes = [...upstreamIds].map((id) => normalized.nodeById.get(id)!);
    const done = upstreamNodes.filter((node) => node.status === 'DONE').length;
    const failed = upstreamNodes.filter(
      (node) => node.status === 'FAILED' || node.status === 'CANCELLED',
    ).length;
    counts = {
      ...counts,
      upstream: upstreamIds.size,
      downstream: downstreamIds.size,
      connected: Math.max(normalized.nodes.length - 1, 0),
      lateral: Math.max(
        normalized.nodes.length - 1 - upstreamIds.size - downstreamIds.size,
        0,
      ),
      total: normalized.nodes.length,
      done,
      remaining: upstreamIds.size - done - failed,
      failed,
    };
  }

  return {
    ...current,
    nodes: [...nodes.values()],
    edges: mergedEdges,
    collapsedGroups,
    counts,
  };
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
