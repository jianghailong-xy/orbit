import { describe, expect, it } from 'vitest';
import {
  getFocusPathSets,
  getTaskDependencyEdgeState,
  getTaskDependencyVisualState,
  normalizeTaskDependencyGraph,
  taskDependencyEdgeKey,
  type TaskDependencyGraphEdge,
  type TaskDependencyGraphNode,
} from './taskDependencyGraph';

const node = (
  id: string,
  status = 'OPEN',
  extra: Partial<TaskDependencyGraphNode> = {},
): TaskDependencyGraphNode => ({ id, title: `Task ${id}`, status, ...extra });

const edge = (sourceTaskId: string, targetTaskId: string): TaskDependencyGraphEdge => ({
  sourceTaskId,
  targetTaskId,
});

describe('normalizeTaskDependencyGraph', () => {
  it('orders a diamond from shared prerequisite to the focused dependent', () => {
    // D depends on B and C; both B and C depend on A. API/render edges point A -> B/C -> D.
    const graph = normalizeTaskDependencyGraph({
      focusTaskId: 'D',
      nodes: [node('D'), node('C'), node('A'), node('B')],
      edges: [edge('C', 'D'), edge('A', 'C'), edge('B', 'D'), edge('A', 'B')],
    });

    expect(graph.topologicalNodeIds).toEqual(['A', 'B', 'C', 'D']);
    expect(graph.focusNode?.id).toBe('D');
    expect(graph.incomingByTaskId.get('D')).toEqual(['B', 'C']);
    expect(graph.outgoingByTaskId.get('A')).toEqual(['B', 'C']);
    expect(graph.hasCycle).toBe(false);

    const path = getFocusPathSets(graph);
    expect([...path.nodeIds].sort()).toEqual(['A', 'B', 'C', 'D']);
    expect([...path.directPrerequisiteIds].sort()).toEqual(['B', 'C']);
    expect(path.edgeKeys).toEqual(
      new Set([
        taskDependencyEdgeKey(edge('A', 'B')),
        taskDependencyEdgeKey(edge('A', 'C')),
        taskDependencyEdgeKey(edge('B', 'D')),
        taskDependencyEdgeKey(edge('C', 'D')),
      ]),
    );
  });

  it('handles a long chain iteratively and keeps every prerequisite before its dependent', () => {
    const length = 250;
    const ids = Array.from({ length }, (_, index) => `task-${String(index).padStart(3, '0')}`);
    const graph = normalizeTaskDependencyGraph({
      focusTaskId: ids.at(-1)!,
      nodes: [...ids].reverse().map((id) => node(id)),
      edges: ids.slice(1).map((id, index) => edge(ids[index], id)),
    });

    expect(graph.topologicalNodeIds).toEqual(ids);
    expect(getFocusPathSets(graph).nodeIds.size).toBe(length);
    expect(getFocusPathSets(graph).edgeKeys.size).toBe(length - 1);
  });

  it('deduplicates nodes and edges, drops dangling edges, and isolates the focus path', () => {
    const graph = normalizeTaskDependencyGraph({
      focusTaskId: 'current',
      nodes: [node('current'), node('prerequisite'), node('unrelated'), node('prerequisite')],
      edges: [
        edge('prerequisite', 'current'),
        edge('prerequisite', 'current'),
        edge('missing', 'current'),
      ],
    });

    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toEqual([edge('prerequisite', 'current')]);
    expect(graph.discardedEdgeCount).toBe(1);
    expect(getFocusPathSets(graph).nodeIds).toEqual(new Set(['current', 'prerequisite']));
    expect(getFocusPathSets(graph).directPrerequisiteIds).toEqual(new Set(['prerequisite']));
  });

  it('reports malformed cyclic input while preserving nodes for fallback rendering', () => {
    const graph = normalizeTaskDependencyGraph({
      focusTaskId: 'B',
      nodes: [node('B'), node('A')],
      edges: [edge('A', 'B'), edge('B', 'A')],
    });

    expect(graph.hasCycle).toBe(true);
    expect(graph.unresolvedNodeIds).toEqual(['A', 'B']);
    expect(graph.nodes.map((item) => item.id)).toEqual(['A', 'B']);
  });
});

describe('dependency path status semantics', () => {
  it.each([
    [node('done', 'DONE', { running: true }), 'complete'],
    [node('failed', 'FAILED', { running: true }), 'failed'],
    [node('cancelled', 'CANCELLED'), 'failed'],
    [node('running', 'OPEN', { running: true }), 'active'],
    [node('in-progress', 'IN_PROGRESS'), 'active'],
    [node('queued', 'OPEN', { queued: true }), 'queued'],
    [node('open', 'OPEN'), 'pending'],
  ] as const)('maps $0.id to %s', (task, expected) => {
    expect(getTaskDependencyVisualState(task)).toBe(expected);
  });

  it('derives an edge state from its prerequisite source, not its dependent target', () => {
    const dependency = edge('prerequisite', 'current');
    const graph = normalizeTaskDependencyGraph({
      focusTaskId: 'current',
      nodes: [node('current', 'FAILED'), node('prerequisite', 'DONE')],
      edges: [dependency],
    });

    expect(getTaskDependencyEdgeState(graph, dependency)).toBe('complete');
    expect(graph.incomingByTaskId.get('current')).toEqual(['prerequisite']);
    expect(graph.outgoingByTaskId.get('prerequisite')).toEqual(['current']);
  });
});
