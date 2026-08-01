import { CloseOutlined, FullscreenOutlined } from '@ant-design/icons';
import dagre from '@dagrejs/dagre';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Modal, Popconfirm, Tooltip } from 'antd';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  getFocusPathSets,
  getTaskDependencyEdgeState,
  getTaskDependencyVisualState,
  normalizeTaskDependencyGraph,
  projectTaskDependencyGraph,
  taskDependencyEdgeKey,
  type TaskDependencyBranchAggregate,
  type NormalizedTaskDependencyGraph,
  type TaskDependencyGraphNode,
  type TaskDependencyGraphResponse,
  type TaskDependencyVisualState,
} from '../lib/taskDependencyGraph';
import { TaskStatusPill, taskStatusLabel } from './TaskStatusPill';

const NODE_WIDTH = 204;
const NODE_HEIGHT = 76;

interface DependencyNodeData extends Record<string, unknown> {
  task: TaskDependencyGraphNode;
  isFocus: boolean;
  isDirect: boolean;
  hasIncoming: boolean;
  hasOutgoing: boolean;
  dimmed: boolean;
  vertical: boolean;
  removing: boolean;
  onOpenTask: (taskId: string) => void;
  onRemoveDependency?: (taskId: string) => void;
  onHighlight: (taskId: string | null) => void;
}

type DependencyFlowNode = Node<DependencyNodeData, 'taskDependency'>;

interface DependencyAggregateNodeData extends Record<string, unknown> {
  aggregate: TaskDependencyBranchAggregate;
  vertical: boolean;
  expanding: boolean;
  busy: boolean;
  onExpand: (aggregate: TaskDependencyBranchAggregate) => void;
}

type DependencyAggregateFlowNode = Node<DependencyAggregateNodeData, 'taskDependencyAggregate'>;

const EDGE_COLORS: Record<TaskDependencyVisualState, string> = {
  complete: 'var(--success-solid)',
  active: 'var(--brand)',
  queued: 'var(--brand-border)',
  failed: 'var(--error-solid)',
  pending: 'var(--text-4)',
};

function DependencyNode({ data }: NodeProps<DependencyFlowNode>) {
  const state = getTaskDependencyVisualState(data.task);
  const label = taskStatusLabel(data.task.status, data.task.running, data.task.queued);
  return (
    <div
      className={`tdg-node state-${state}${data.isFocus ? ' is-focus' : ''}${data.dimmed ? ' is-dimmed' : ''}`}
      onMouseEnter={() => data.onHighlight(data.task.id)}
      onMouseLeave={() => data.onHighlight(null)}
    >
      {data.hasIncoming && (
        <Handle type="target" position={data.vertical ? Position.Top : Position.Left} isConnectable={false} />
      )}
      <button
        type="button"
        className="tdg-node-main nodrag"
        onClick={() => data.onOpenTask(data.task.id)}
        onFocus={() => data.onHighlight(data.task.id)}
        onBlur={() => data.onHighlight(null)}
        aria-label={`${data.task.title}, ${label}${data.isFocus ? ', current task' : ''}`}
        title={`Open task: ${data.task.title}`}
      >
        <span className="tdg-node-title-row">
          <span className="tdg-node-title">{data.task.title}</span>
          {data.isFocus && <span className="tdg-current-tag">Current</span>}
        </span>
        <TaskStatusPill
          status={data.task.status}
          running={data.task.running}
          queued={data.task.queued}
        />
      </button>
      {data.isDirect && !data.isFocus && data.onRemoveDependency && (
        <Popconfirm
          title="Remove prerequisite?"
          description="This task will no longer wait for this prerequisite."
          okText="Remove"
          okButtonProps={{ danger: true }}
          onConfirm={() => data.onRemoveDependency?.(data.task.id)}
        >
          <button
            type="button"
            className="tdg-node-remove nodrag nopan"
            disabled={data.removing}
            aria-label={`Remove ${data.task.title} as a prerequisite`}
            title="Remove direct prerequisite"
          >
            <CloseOutlined />
          </button>
        </Popconfirm>
      )}
      {data.hasOutgoing && (
        <Handle type="source" position={data.vertical ? Position.Bottom : Position.Right} isConnectable={false} />
      )}
    </div>
  );
}

function DependencyAggregateNode({ data }: NodeProps<DependencyAggregateFlowNode>) {
  const { aggregate } = data;
  const noun = aggregate.direction === 'prerequisites' ? 'prerequisites' : 'dependents';
  const isPrerequisiteGroup = aggregate.direction === 'prerequisites';
  const atServerLimit = aggregate.remote && aggregate.loadedRemainingCount === 0 && !aggregate.cursor;
  const actionLabel = data.expanding
    ? 'Loading…'
    : data.busy
      ? 'Wait for current batch…'
      : atServerLimit
        ? 'Graph limit reached'
        : `Show next ${aggregate.nextBatchCount}`;
  return (
    <div className="tdg-aggregate-node">
      {!isPrerequisiteGroup && (
        <Handle type="target" position={data.vertical ? Position.Top : Position.Left} isConnectable={false} />
      )}
      <button
        type="button"
        className="tdg-aggregate-main nodrag nopan"
        onClick={() => data.onExpand(aggregate)}
        disabled={data.busy || atServerLimit}
        aria-label={
          atServerLimit
            ? `${aggregate.remainingCount} hidden ${noun}; graph limit reached`
            : `Show next ${aggregate.nextBatchCount} of ${aggregate.remainingCount} hidden ${noun}`
        }
      >
        <span className="tdg-aggregate-count">+{aggregate.remainingCount} {noun}</span>
        <span className="tdg-aggregate-action">{actionLabel}</span>
      </button>
      {isPrerequisiteGroup && (
        <Handle type="source" position={data.vertical ? Position.Bottom : Position.Right} isConnectable={false} />
      )}
    </div>
  );
}

const NODE_TYPES = {
  taskDependency: DependencyNode,
  taskDependencyAggregate: DependencyAggregateNode,
};

/** Highlight the shortest weak (direction-agnostic) path to the focused task. In a `both`
 * snapshot a hovered node may be downstream or lateral, so walking only outgoing edges would
 * never reach the focus. Edge arrows still retain their prerequisite -> dependent direction. */
function pathBetweenNodeAndFocus(
  graph: NormalizedTaskDependencyGraph,
  startId: string | null,
): { nodeIds: Set<string>; edgeKeys: Set<string> } | null {
  if (!startId || !graph.nodeById.has(startId)) return null;
  if (startId === graph.focusTaskId) {
    return {
      nodeIds: new Set(graph.nodeById.keys()),
      edgeKeys: new Set(graph.edges.map(taskDependencyEdgeKey)),
    };
  }

  const visited = new Set<string>([startId]);
  const previous = new Map<string, { from: string; edgeKey: string }>();
  const pending = [startId];
  for (let index = 0; index < pending.length && !visited.has(graph.focusTaskId); index += 1) {
    const currentId = pending[index];
    const adjacent = [
      ...(graph.incomingByTaskId.get(currentId) ?? []).map((sourceTaskId) => ({
        id: sourceTaskId,
        edgeKey: taskDependencyEdgeKey({ sourceTaskId, targetTaskId: currentId }),
      })),
      ...(graph.outgoingByTaskId.get(currentId) ?? []).map((targetTaskId) => ({
        id: targetTaskId,
        edgeKey: taskDependencyEdgeKey({ sourceTaskId: currentId, targetTaskId }),
      })),
    ];
    for (const neighbor of adjacent) {
      if (visited.has(neighbor.id)) continue;
      visited.add(neighbor.id);
      previous.set(neighbor.id, { from: currentId, edgeKey: neighbor.edgeKey });
      pending.push(neighbor.id);
    }
  }

  const nodeIds = new Set<string>([startId]);
  const edgeKeys = new Set<string>();
  let cursor = graph.focusTaskId;
  while (cursor !== startId) {
    const step = previous.get(cursor);
    if (!step) return { nodeIds, edgeKeys };
    nodeIds.add(cursor);
    edgeKeys.add(step.edgeKey);
    cursor = step.from;
  }
  return { nodeIds, edgeKeys };
}

function layoutPositions(
  graph: NormalizedTaskDependencyGraph,
  aggregates: readonly TaskDependencyBranchAggregate[],
  vertical: boolean,
): ReadonlyMap<string, { x: number; y: number }> {
  const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  layout.setGraph({
    rankdir: vertical ? 'TB' : 'LR',
    ranksep: vertical ? 46 : 52,
    nodesep: 24,
    marginx: 24,
    marginy: 24,
  });
  for (const task of graph.nodes) layout.setNode(task.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const aggregate of aggregates) {
    layout.setNode(aggregate.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of graph.edges) layout.setEdge(edge.sourceTaskId, edge.targetTaskId);
  for (const aggregate of aggregates) {
    if (aggregate.direction === 'prerequisites') {
      layout.setEdge(aggregate.id, aggregate.parentTaskId);
    } else {
      layout.setEdge(aggregate.parentTaskId, aggregate.id);
    }
  }
  dagre.layout(layout);
  return new Map(
    [...graph.nodes.map((task) => task.id), ...aggregates.map((aggregate) => aggregate.id)].map(
      (id) => {
        const position = layout.node(id) as { x: number; y: number };
        return [id, { x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 }];
      },
    ),
  );
}

function flowElements(
  graph: NormalizedTaskDependencyGraph,
  aggregates: readonly TaskDependencyBranchAggregate[],
  positions: ReadonlyMap<string, { x: number; y: number }>,
  vertical: boolean,
  directPrerequisiteIds: ReadonlySet<string>,
  highlighted: ReturnType<typeof pathBetweenNodeAndFocus>,
  onOpenTask: (taskId: string) => void,
  onRemoveDependency: ((taskId: string) => void) | undefined,
  removingTaskId: string | null,
  onHighlight: (taskId: string | null) => void,
  onExpand: (aggregate: TaskDependencyBranchAggregate) => void,
  expandingBranchKey: string | null,
): { nodes: Array<DependencyFlowNode | DependencyAggregateFlowNode>; edges: Edge[] } {
  const taskNodes: DependencyFlowNode[] = graph.nodes.map((task) => {
    const isFocus = task.id === graph.focusTaskId;
    return {
      id: task.id,
      type: 'taskDependency',
      position: positions.get(task.id) ?? { x: 0, y: 0 },
      sourcePosition: vertical ? Position.Bottom : Position.Right,
      targetPosition: vertical ? Position.Top : Position.Left,
      draggable: false,
      selectable: false,
      focusable: false,
      data: {
        task,
        isFocus,
        isDirect: directPrerequisiteIds.has(task.id),
        hasIncoming: (graph.incomingByTaskId.get(task.id)?.length ?? 0) > 0,
        hasOutgoing: (graph.outgoingByTaskId.get(task.id)?.length ?? 0) > 0,
        dimmed: !!highlighted && !highlighted.nodeIds.has(task.id),
        vertical,
        removing: removingTaskId === task.id,
        onOpenTask,
        onRemoveDependency,
        onHighlight,
      },
    };
  });

  const aggregateNodes: DependencyAggregateFlowNode[] = aggregates.map((aggregate) => ({
    id: aggregate.id,
    type: 'taskDependencyAggregate',
    position: positions.get(aggregate.id) ?? { x: 0, y: 0 },
    sourcePosition: vertical ? Position.Bottom : Position.Right,
    targetPosition: vertical ? Position.Top : Position.Left,
    draggable: false,
    selectable: false,
    focusable: false,
    data: {
      aggregate,
      vertical,
      expanding: expandingBranchKey === aggregate.branchKey,
      busy: expandingBranchKey !== null,
      onExpand,
    },
  }));

  const taskEdges: Edge[] = graph.edges.map((edge) => {
    const key = taskDependencyEdgeKey(edge);
    const state = getTaskDependencyEdgeState(graph, edge);
    const highlightedEdge = !!highlighted?.edgeKeys.has(key);
    const dimmed = !!highlighted && !highlightedEdge;
    const stroke = EDGE_COLORS[state];
    return {
      id: key,
      source: edge.sourceTaskId,
      target: edge.targetTaskId,
      type: 'smoothstep',
      animated: state === 'active' && !dimmed,
      focusable: false,
      selectable: false,
      style: {
        stroke,
        strokeWidth: highlightedEdge ? 2.5 : directPrerequisiteIds.has(edge.sourceTaskId) && edge.targetTaskId === graph.focusTaskId ? 2 : 1.5,
        opacity: dimmed ? 0.16 : state === 'complete' ? 0.55 : 0.9,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: stroke,
      },
    };
  });
  const aggregateEdges: Edge[] = aggregates.map((aggregate) => {
    const prerequisiteGroup = aggregate.direction === 'prerequisites';
    return {
      id: `aggregate-edge:${aggregate.id}`,
      source: prerequisiteGroup ? aggregate.id : aggregate.parentTaskId,
      target: prerequisiteGroup ? aggregate.parentTaskId : aggregate.id,
      type: 'smoothstep',
      focusable: false,
      selectable: false,
      style: {
        stroke: 'var(--text-4)',
        strokeWidth: 1.5,
        strokeDasharray: '5 4',
        opacity: 0.75,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: 'var(--text-4)',
      },
    };
  });
  return { nodes: [...taskNodes, ...aggregateNodes], edges: [...taskEdges, ...aggregateEdges] };
}

function DependencyFlow({
  graph,
  fullScreen,
  vertical,
  expandedByBranch,
  onExpand,
  expandingBranchKey,
  onOpenTask,
  onRemoveDependency,
  removingTaskId,
}: {
  graph: TaskDependencyGraphResponse;
  fullScreen: boolean;
  vertical: boolean;
  expandedByBranch: ReadonlyMap<string, number>;
  onExpand: (aggregate: TaskDependencyBranchAggregate) => void;
  expandingBranchKey: string | null;
  onOpenTask: (taskId: string) => void;
  onRemoveDependency?: (taskId: string) => void;
  removingTaskId: string | null;
}) {
  const normalized = useMemo(() => normalizeTaskDependencyGraph(graph), [graph]);
  const projection = useMemo(
    () => projectTaskDependencyGraph(normalized, expandedByBranch, { collapsedGroups: graph.collapsedGroups }),
    [normalized, expandedByBranch, graph.collapsedGroups],
  );
  const visibleGraph = projection.graph;
  const direct = useMemo(() => getFocusPathSets(normalized).directPrerequisiteIds, [normalized]);
  const { fitBounds, getViewport, setViewport } = useReactFlow();
  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const structureKey = useMemo(
    () =>
      `${vertical ? 'TB' : 'LR'}|${visibleGraph.topologicalNodeIds.join(',')}|${visibleGraph.edges
        .map(taskDependencyEdgeKey)
        .join(',')}|${projection.aggregates.map((aggregate) => aggregate.id).join(',')}`,
    [projection.aggregates, visibleGraph, vertical],
  );
  // Dagre is the expensive part. Status/path hover only changes presentation, so keep positions
  // stable and avoid recomputing the layout as the pointer moves between nodes.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- structureKey captures every layout input
  const positions = useMemo(
    () => layoutPositions(visibleGraph, projection.aggregates, vertical),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- structureKey captures every layout input
    [structureKey],
  );
  const graphBounds = useMemo(() => {
    const points = [...positions.values()];
    if (points.length === 0) return { x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT };
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x + NODE_WIDTH));
    const maxY = Math.max(...points.map((point) => point.y + NODE_HEIGHT));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }, [positions]);
  const pendingAnchorRef = useRef<{
    id: string;
    position: { x: number; y: number };
    viewport: { x: number; y: number; zoom: number };
  } | null>(null);
  const expandKeepingAnchor = useCallback(
    (aggregate: TaskDependencyBranchAggregate) => {
      const position = positions.get(aggregate.parentTaskId);
      if (position) {
        pendingAnchorRef.current = {
          id: aggregate.parentTaskId,
          position,
          viewport: getViewport(),
        };
      }
      onExpand(aggregate);
    },
    [getViewport, onExpand, positions],
  );
  const fitContextKey = `${graph.focusTaskId}|${vertical ? 'TB' : 'LR'}|${fullScreen ? 'full' : 'inline'}`;
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlighted = useMemo(
    () => pathBetweenNodeAndFocus(visibleGraph, highlightedId),
    [visibleGraph, highlightedId],
  );
  const elements = useMemo(
    () =>
      flowElements(
        visibleGraph,
        projection.aggregates,
        positions,
        vertical,
        direct,
        highlighted,
        onOpenTask,
        onRemoveDependency,
        removingTaskId,
        setHighlightedId,
        expandKeepingAnchor,
        expandingBranchKey,
      ),
    [
      visibleGraph,
      projection.aggregates,
      positions,
      vertical,
      direct,
      highlighted,
      onOpenTask,
      onRemoveDependency,
      removingTaskId,
      expandKeepingAnchor,
      expandingBranchKey,
    ],
  );
  useLayoutEffect(() => {
    const pendingAnchor = pendingAnchorRef.current;
    if (!pendingAnchor) return;
    const nextPosition = positions.get(pendingAnchor.id);
    if (!nextPosition) {
      pendingAnchorRef.current = null;
      return;
    }
    const { viewport } = pendingAnchor;
    void setViewport(
      {
        ...viewport,
        x: viewport.x + (pendingAnchor.position.x - nextPosition.x) * viewport.zoom,
        y: viewport.y + (pendingAnchor.position.y - nextPosition.y) * viewport.zoom,
      },
      { duration: 0 },
    );
    pendingAnchorRef.current = null;
  }, [positions, setViewport, structureKey]);
  useEffect(() => {
    // Fit when this canvas/focus/orientation first appears. Progressive branch expansion keeps
    // the user's viewport intact instead of zooming the whole canvas after every batch.
    let fitFrame = 0;
    const layoutFrame = requestAnimationFrame(() => {
      // React Flow commits controlled node positions to its internal store after this effect.
      // A second frame ensures the viewport exists after a responsive LR/TB layout flip.
      fitFrame = requestAnimationFrame(() => {
        // Use our known dagre bounds rather than measured visible nodes: after a responsive
        // direction flip React Flow may not have measured the newly off-screen final rank yet.
        void fitBounds(graphBounds, {
          padding: fullScreen ? 0.2 : 0.12,
          duration: reduceMotion ? 0 : 180,
        });
      });
    });
    return () => {
      cancelAnimationFrame(layoutFrame);
      cancelAnimationFrame(fitFrame);
    };
    // graphBounds intentionally belongs to the context's first layout only. Expansion changes
    // it without changing fitContextKey, which must not trigger another automatic fit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitBounds, fitContextKey, fullScreen, reduceMotion]);

  if (!normalized.focusNode || normalized.hasCycle) {
    return (
      <div className="tdg-error" role="alert">
        The dependency graph could not be rendered. Switch to list view and try again.
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={elements.nodes}
      edges={elements.edges}
      nodeTypes={NODE_TYPES}
      fitView
      fitViewOptions={{ padding: fullScreen ? 0.2 : 0.12, maxZoom: 1 }}
      minZoom={0.25}
      maxZoom={1.5}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      edgesFocusable={false}
      zoomOnScroll={false}
      zoomOnDoubleClick={false}
      panOnScroll={false}
      // Inline narrow graphs prioritize scrolling the detail panel. Full-screen and wide
      // layouts retain canvas panning; zoom/fit controls remain available in every mode.
      panOnDrag={!vertical || fullScreen}
      preventScrolling={false}
      proOptions={{ hideAttribution: true }}
      ariaLabelConfig={{
        'controls.ariaLabel': 'Dependency graph controls',
        'controls.zoomIn.ariaLabel': 'Zoom in dependency graph',
        'controls.zoomOut.ariaLabel': 'Zoom out dependency graph',
        'controls.fitView.ariaLabel': 'Fit dependency graph to view',
      }}
    >
      <Background gap={18} size={1} color="var(--border-subtle)" />
      {projection.collapsed && (
        <Panel position="top-left" className="tdg-visible-count">
          Showing {projection.visibleNodeCount} tasks ·{' '}
          {projection.aggregates.reduce((sum, aggregate) => sum + aggregate.remainingCount, 0)} connections collapsed
        </Panel>
      )}
      <Controls showInteractive={false} orientation="horizontal" position="bottom-left" />
      {fullScreen && visibleGraph.nodes.length > 20 && (
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          ariaLabel="Dependency graph mini map"
          nodeColor={(node) => {
            const task = (node.data as DependencyNodeData).task;
            return task ? EDGE_COLORS[getTaskDependencyVisualState(task)] : 'var(--brand-border)';
          }}
        />
      )}
    </ReactFlow>
  );
}

export function TaskDependencyGraph({
  graph,
  title,
  onOpenTask,
  onRemoveDependency,
  onExpandBranch,
  expandingBranchKey = null,
  removingTaskId = null,
}: {
  graph: TaskDependencyGraphResponse;
  title: string;
  onOpenTask: (taskId: string) => void;
  onRemoveDependency?: (taskId: string) => void;
  onExpandBranch?: (aggregate: TaskDependencyBranchAggregate) => void | Promise<void>;
  expandingBranchKey?: string | null;
  removingTaskId?: string | null;
}) {
  const [fullScreen, setFullScreen] = useState(false);
  const [expansionState, setExpansionState] = useState<{
    focusTaskId: string;
    counts: ReadonlyMap<string, number>;
  }>(() => ({ focusTaskId: graph.focusTaskId, counts: new Map() }));
  const expandedByBranch =
    expansionState.focusTaskId === graph.focusTaskId ? expansionState.counts : new Map<string, number>();
  const handleExpand = useCallback(
    (aggregate: TaskDependencyBranchAggregate) => {
      const revealNextBatch = () => {
        setExpansionState((previous) => {
          const counts = new Map(
            previous.focusTaskId === graph.focusTaskId ? previous.counts : undefined,
          );
          const revealed = Math.max(aggregate.revealedCount, counts.get(aggregate.branchKey) ?? 0);
          counts.set(aggregate.branchKey, revealed + aggregate.nextBatchCount);
          return { focusTaskId: graph.focusTaskId, counts };
        });
      };
      if (aggregate.remote && aggregate.loadedRemainingCount === 0 && onExpandBranch) {
        void Promise.resolve(onExpandBranch(aggregate)).then(revealNextBatch).catch(() => undefined);
        return;
      }
      revealNextBatch();
    },
    [graph.focusTaskId, onExpandBranch],
  );
  const inlineCanvasRef = useRef<HTMLDivElement>(null);
  // The default detail width is 600px, so start in the narrow TB layout and avoid a visible
  // first-paint LR→TB flip for the common case. ResizeObserver corrects wider saved panels.
  const [inlineVertical, setInlineVertical] = useState(true);
  useEffect(() => {
    const element = inlineCanvasRef.current;
    if (!element) return;
    const update = (width: number) => setInlineVertical(width < 640);
    update(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => update(entries[0]?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div
        ref={inlineCanvasRef}
        className={`tdg-canvas${inlineVertical ? ' is-vertical' : ''}`}
        aria-label={`Dependency graph for ${title}`}
      >
        <Tooltip title="Open full-screen graph">
          <button
            type="button"
            className="tdg-maximize"
            onClick={() => setFullScreen(true)}
            aria-label="Open dependency graph full screen"
          >
            <FullscreenOutlined />
          </button>
        </Tooltip>
        {!fullScreen && (
          <ReactFlowProvider>
            <DependencyFlow
              graph={graph}
              fullScreen={false}
              vertical={inlineVertical}
              expandedByBranch={expandedByBranch}
              onExpand={handleExpand}
              expandingBranchKey={expandingBranchKey}
              onOpenTask={onOpenTask}
              onRemoveDependency={onRemoveDependency}
              removingTaskId={removingTaskId}
            />
          </ReactFlowProvider>
        )}
        <div className="tdg-direction">Prerequisite → dependent</div>
      </div>
      <Modal
        className="tdg-modal"
        open={fullScreen}
        onCancel={() => setFullScreen(false)}
        footer={null}
        width="calc(100vw - 48px)"
        title={`Dependency graph · ${title}`}
        destroyOnClose
      >
        <div className="tdg-full-canvas">
          <ReactFlowProvider>
            <DependencyFlow
              graph={graph}
              fullScreen
              vertical={false}
              expandedByBranch={expandedByBranch}
              onExpand={handleExpand}
              expandingBranchKey={expandingBranchKey}
              onOpenTask={onOpenTask}
              onRemoveDependency={onRemoveDependency}
              removingTaskId={removingTaskId}
            />
          </ReactFlowProvider>
        </div>
      </Modal>
    </>
  );
}
