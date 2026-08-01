import { describe, expect, it } from 'vitest';
import {
  applyTaskDependencyGraphExpansionLedger,
  buildDirectTaskDependencyGraph,
  getFocusPathSets,
  getTaskDependencyMainPathNodeIds,
  getTaskDependencyEdgeState,
  getTaskDependencyVisualState,
  mergeTaskDependencyGraphExpansion,
  normalizeTaskDependencyGraph,
  projectTaskDependencyGraph,
  refreshTaskDependencyGraphNodes,
  taskDependencyBranchKey,
  taskDependencyGraphStructureKey,
  taskDependencyGraphTruncationState,
  taskDependencyEdgeKey,
  viewportAfterDependencyGraphLayout,
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

  it('keeps downstream nodes while limiting removable prerequisites to incoming focus edges', () => {
    const graph = normalizeTaskDependencyGraph({
      focusTaskId: 'middle',
      nodes: [node('root'), node('middle'), node('leaf')],
      edges: [edge('root', 'middle'), edge('middle', 'leaf')],
    });

    expect(graph.topologicalNodeIds).toEqual(['root', 'middle', 'leaf']);
    expect(graph.outgoingByTaskId.get('middle')).toEqual(['leaf']);
    expect(getFocusPathSets(graph).directPrerequisiteIds).toEqual(new Set(['root']));
    expect(getFocusPathSets(graph).directPrerequisiteIds.has('leaf')).toBe(false);
  });
});

describe('buildDirectTaskDependencyGraph', () => {
  it('shows a root task and its direct dependents when there are no prerequisites', () => {
    const graph = buildDirectTaskDependencyGraph(
      'root',
      node('root'),
      [],
      [node('branch-a'), node('branch-b')],
    );

    expect(graph.direction).toBe('both');
    expect(graph.nodes.map((item) => item.id)).toEqual(['root', 'branch-a', 'branch-b']);
    expect(graph.edges).toEqual([edge('root', 'branch-a'), edge('root', 'branch-b')]);
    expect(graph.counts).toMatchObject({ upstream: 0, downstream: 2, connected: 2, total: 3 });
    expect(graph.maxDepth).toBe(1);
  });

  it('shows both direct directions around a middle task', () => {
    const graph = buildDirectTaskDependencyGraph(
      'middle',
      node('middle'),
      [node('root', 'DONE')],
      [node('leaf')],
    );

    expect(graph.edges).toEqual([edge('root', 'middle'), edge('middle', 'leaf')]);
    expect(graph.counts).toEqual({
      upstream: 1,
      downstream: 1,
      connected: 2,
      total: 3,
      done: 1,
      remaining: 0,
      failed: 0,
    });
  });
});

describe('progressive dependency graph projection', () => {
  it('keeps a deterministic longest path through a middle focus task', () => {
    const graph = normalizeTaskDependencyGraph({
      focusTaskId: 'focus',
      nodes: ['root', 'middle', 'side-up', 'focus', 'child', 'leaf', 'side-down'].map((id) => node(id)),
      edges: [
        edge('root', 'middle'),
        edge('middle', 'focus'),
        edge('side-up', 'focus'),
        edge('focus', 'child'),
        edge('child', 'leaf'),
        edge('focus', 'side-down'),
      ],
    });

    expect(getTaskDependencyMainPathNodeIds(graph)).toEqual([
      'root',
      'middle',
      'focus',
      'child',
      'leaf',
    ]);
  });

  it('collapses a wide loaded branch and reveals it in stable batches', () => {
    const dependentIds = Array.from({ length: 20 }, (_, index) => `dependent-${String(index).padStart(2, '0')}`);
    const graph = normalizeTaskDependencyGraph({
      focusTaskId: 'root',
      nodes: [node('root'), ...dependentIds.map((id) => node(id))],
      edges: dependentIds.map((id) => edge('root', id)),
    });
    const branchKey = taskDependencyBranchKey('root', 'dependents');

    const initial = projectTaskDependencyGraph(graph, new Map(), {
      batchSize: 3,
      collapseThreshold: 5,
    });
    expect(initial.visibleNodeCount).toBe(5); // focus + main-path child + one batch
    expect(initial.mainPathNodeIds).toEqual(new Set(['root', 'dependent-00']));
    expect(initial.aggregates).toEqual([
      expect.objectContaining({
        branchKey,
        parentTaskId: 'root',
        direction: 'dependents',
        remainingCount: 16,
        loadedRemainingCount: 16,
        nextBatchCount: 3,
      }),
    ]);

    const expanded = projectTaskDependencyGraph(graph, new Map([[branchKey, 6]]), {
      batchSize: 3,
      collapseThreshold: 5,
    });
    expect(expanded.visibleNodeCount).toBe(8);
    expect(expanded.aggregates[0]).toMatchObject({ remainingCount: 13, nextBatchCount: 3 });
  });

  it('combines loaded and remote hidden neighbors at the same anchored side', () => {
    const dependentIds = Array.from({ length: 20 }, (_, index) => `dependent-${String(index).padStart(2, '0')}`);
    const graph = normalizeTaskDependencyGraph({
      focusTaskId: 'root',
      nodes: [node('root'), ...dependentIds.map((id) => node(id))],
      edges: dependentIds.map((id) => edge('root', id)),
    });
    const branchKey = taskDependencyBranchKey('root', 'dependents');
    const projection = projectTaskDependencyGraph(graph, new Map(), {
      batchSize: 3,
      collapseThreshold: 5,
      collapsedGroups: [
        { anchorTaskId: 'root', direction: 'dependents', hiddenCount: 230, cursor: 'next-page' },
      ],
    });

    expect(projection.aggregates).toEqual([
      expect.objectContaining({
        branchKey,
        remainingCount: 246,
        loadedRemainingCount: 16,
        remote: true,
        cursor: 'next-page',
      }),
    ]);
  });

  it('reveals each selected wide-branch root with its unambiguous continuation', () => {
    const branchIds = Array.from({ length: 5 }, (_, index) => String(index + 1));
    const graph = normalizeTaskDependencyGraph({
      focusTaskId: 'P0',
      nodes: [
        node('P0'),
        node('W0'),
        node('CHECK'),
        ...branchIds.flatMap((id) => [node(`P${id}`), node(`W${id}`)]),
      ],
      edges: [
        edge('P0', 'W0'),
        edge('W0', 'CHECK'),
        ...branchIds.flatMap((id) => [edge(`P${id}`, `W${id}`), edge(`W${id}`, 'CHECK')]),
      ],
    });
    const branchKey = taskDependencyBranchKey('CHECK', 'prerequisites');

    const initial = projectTaskDependencyGraph(graph, new Map(), {
      batchSize: 2,
      collapseThreshold: 3,
    });
    expect(initial.graph.nodes.map((item) => item.id)).toEqual(['P0', 'W0', 'CHECK']);
    expect(initial.aggregates[0]).toMatchObject({ branchKey, remainingCount: 5 });

    const expanded = projectTaskDependencyGraph(graph, new Map([[branchKey, 2]]), {
      batchSize: 2,
      collapseThreshold: 3,
    });
    expect(new Set(expanded.graph.nodes.map((item) => item.id))).toEqual(
      new Set(['P0', 'W0', 'CHECK', 'P1', 'W1', 'P2', 'W2']),
    );
    expect(expanded.aggregates).toEqual([
      expect.objectContaining({ branchKey, remainingCount: 3, nextBatchCount: 2 }),
    ]);
  });

  it('renders a server-only group on the prerequisite side of its anchor', () => {
    const graph = normalizeTaskDependencyGraph({
      focusTaskId: 'P250',
      nodes: [node('P250'), node('W250'), node('CHECK')],
      edges: [edge('P250', 'W250'), edge('W250', 'CHECK')],
    });
    const projection = projectTaskDependencyGraph(graph, new Map(), {
      collapsedGroups: [
        { anchorTaskId: 'CHECK', direction: 'prerequisites', hiddenCount: 249 },
      ],
    });

    expect(projection.visibleNodeCount).toBe(3);
    expect(projection.aggregates).toEqual([
      expect.objectContaining({
        parentTaskId: 'CHECK',
        direction: 'prerequisites',
        remainingCount: 249,
        loadedRemainingCount: 0,
        remote: true,
      }),
    ]);
  });

  it('merges an expansion delta without duplicating shared nodes or edges', () => {
    const current = {
      focusTaskId: 'A',
      nodes: [node('A'), node('B')],
      edges: [edge('A', 'B')],
      collapsedGroups: [
        { anchorTaskId: 'B', direction: 'dependents' as const, hiddenCount: 2, cursor: 'one' },
      ],
    };
    const merged = mergeTaskDependencyGraphExpansion(
      current,
      {
        nodes: [node('B', 'DONE'), node('C')],
        edges: [edge('A', 'B'), edge('B', 'C')],
        remainingCount: 1,
        nextCursor: 'two',
      },
      { anchorTaskId: 'B', direction: 'dependents' },
    );

    expect(merged.nodes.map((item) => item.id)).toEqual(['A', 'B', 'C']);
    expect(merged.nodes.find((item) => item.id === 'B')?.status).toBe('DONE');
    expect(merged.edges).toEqual([edge('A', 'B'), edge('B', 'C')]);
    expect(merged.collapsedGroups).toEqual([
      { anchorTaskId: 'B', direction: 'dependents', hiddenCount: 1, cursor: 'two' },
    ]);
  });

  it('removes stale sibling aggregates when a diamond expansion supplies their shared edge', () => {
    const current = {
      focusTaskId: 'focus',
      nodes: [
        node('focus'),
        node('B', 'OPEN', { prerequisiteCount: 1 }),
        node('C', 'OPEN', { prerequisiteCount: 1 }),
      ],
      edges: [edge('B', 'focus'), edge('C', 'focus')],
      collapsedGroups: [
        { anchorTaskId: 'B', direction: 'prerequisites' as const, hiddenCount: 1 },
        { anchorTaskId: 'C', direction: 'prerequisites' as const, hiddenCount: 1 },
      ],
    };
    const merged = mergeTaskDependencyGraphExpansion(
      current,
      {
        nodes: [node('D')],
        edges: [edge('D', 'B'), edge('D', 'C')],
        remainingCount: 0,
        collapsedGroups: [
          { anchorTaskId: 'B', direction: 'prerequisites', hiddenCount: 0 },
        ],
      },
      { anchorTaskId: 'B', direction: 'prerequisites' },
    );

    expect(merged.edges).toContainEqual(edge('D', 'C'));
    expect(merged.collapsedGroups).toEqual([]);
  });

  it('replays expansion nodes after a base refetch while fresh base status wins', () => {
    const base = {
      focusTaskId: 'focus',
      direction: 'both' as const,
      nodes: [node('focus'), node('B', 'OPEN', { dependentCount: 1 })],
      edges: [edge('focus', 'B')],
      collapsedGroups: [
        { anchorTaskId: 'B', direction: 'dependents' as const, hiddenCount: 1, cursor: 'cursor' },
      ],
    };
    const ledger = [
      {
        expansion: {
          nodes: [node('B', 'FAILED', { dependentCount: 1 }), node('C')],
          edges: [edge('B', 'C')],
          remainingCount: 0,
          collapsedGroups: [],
        },
        requestedGroup: { anchorTaskId: 'B', direction: 'dependents' as const },
      },
    ];
    const refreshedBase = {
      ...base,
      nodes: [node('focus'), node('B', 'DONE', { dependentCount: 1 })],
    };

    const graph = applyTaskDependencyGraphExpansionLedger(refreshedBase, ledger);
    expect(graph.nodes.map((item) => item.id)).toEqual(['focus', 'B', 'C']);
    expect(graph.nodes.find((item) => item.id === 'B')?.status).toBe('DONE');
    expect(graph.nodes.find((item) => item.id === 'C')?.status).toBe('OPEN');
    expect(graph.edges).toContainEqual(edge('B', 'C'));
  });

  it('invalidates expansion ledgers only when the base dependency structure changes', () => {
    const base = {
      focusTaskId: 'focus',
      direction: 'both' as const,
      nodes: [node('focus'), node('B', 'OPEN', { dependentCount: 1 })],
      edges: [edge('focus', 'B')],
    };
    expect(
      taskDependencyGraphStructureKey({
        ...base,
        nodes: [node('focus', 'DONE'), node('B', 'FAILED', { dependentCount: 1 })],
      }),
    ).toBe(taskDependencyGraphStructureKey(base));
    expect(
      taskDependencyGraphStructureKey({
        ...base,
        nodes: [...base.nodes, node('C')],
        edges: [...base.edges, edge('B', 'C')],
      }),
    ).not.toBe(taskDependencyGraphStructureKey(base));
  });

  it('preserves a user pan made after clicking while compensating anchor movement', () => {
    expect(
      viewportAfterDependencyGraphLayout(
        { x: 70, y: -20, zoom: 1.5 },
        { x: 100, y: 40 },
        { x: 120, y: 10 },
      ),
    ).toEqual({ x: 40, y: 25, zoom: 1.5 });
  });

  it('refreshes remote node payloads and reconciles existing boundary counts', () => {
    const graph = {
      focusTaskId: 'C',
      nodes: [
        node('P'),
        node('B', 'OPEN', {
          title: 'Old title',
          depth: 2,
          prerequisiteCount: 3,
          dependentCount: 5,
        }),
        node('C'),
      ],
      edges: [edge('P', 'B'), edge('B', 'C')],
      collapsedGroups: [
        { anchorTaskId: 'B', direction: 'prerequisites' as const, hiddenCount: 2, cursor: 'up' },
        { anchorTaskId: 'B', direction: 'dependents' as const, hiddenCount: 4, cursor: 'down' },
      ],
      counts: {
        upstream: 2,
        downstream: 0,
        connected: 2,
        lateral: 0,
        total: 3,
        done: 0,
        remaining: 2,
        failed: 0,
      },
    };

    const refreshed = refreshTaskDependencyGraphNodes(graph, [
      node('B', 'DONE', {
        title: 'Fresh title',
        prerequisiteCount: 1,
        dependentCount: 3,
        running: false,
      }),
    ]);

    expect(refreshed.nodes.find((item) => item.id === 'B')).toMatchObject({
      title: 'Fresh title',
      status: 'DONE',
      depth: 2,
    });
    expect(refreshed.collapsedGroups).toEqual([
      { anchorTaskId: 'B', direction: 'dependents', hiddenCount: 2, cursor: 'down' },
    ]);
    expect(refreshed.counts).toMatchObject({ done: 1, remaining: 1, failed: 0 });
  });

  it('shows expansion guidance only while a server-backed branch remains', () => {
    expect(taskDependencyGraphTruncationState({ collapsedGroups: [] })).toBeNull();
    expect(
      taskDependencyGraphTruncationState({
        collapsedGroups: [
          { anchorTaskId: 'B', direction: 'dependents', hiddenCount: 3, cursor: 'next' },
        ],
      }),
    ).toBe('expandable');
    expect(
      taskDependencyGraphTruncationState({
        collapsedGroups: [
          { anchorTaskId: 'B', direction: 'dependents', hiddenCount: 3, cursor: null },
        ],
      }),
    ).toBe('limit');
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
