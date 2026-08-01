import { CloseOutlined, FullscreenOutlined } from '@ant-design/icons';
import dagre from '@dagrejs/dagre';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
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
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getFocusPathSets,
  getTaskDependencyEdgeState,
  getTaskDependencyVisualState,
  normalizeTaskDependencyGraph,
  taskDependencyEdgeKey,
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

const NODE_TYPES = { taskDependency: DependencyNode };

function pathFromNodeToFocus(
  graph: NormalizedTaskDependencyGraph,
  startId: string | null,
): { nodeIds: Set<string>; edgeKeys: Set<string> } | null {
  if (!startId || !graph.nodeById.has(startId)) return null;
  if (startId === graph.focusTaskId) {
    const all = getFocusPathSets(graph);
    return { nodeIds: new Set(all.nodeIds), edgeKeys: new Set(all.edgeKeys) };
  }
  const nodeIds = new Set<string>([startId]);
  const edgeKeys = new Set<string>();
  const pending = [startId];
  while (pending.length > 0) {
    const sourceTaskId = pending.pop()!;
    for (const targetTaskId of graph.outgoingByTaskId.get(sourceTaskId) ?? []) {
      edgeKeys.add(taskDependencyEdgeKey({ sourceTaskId, targetTaskId }));
      if (nodeIds.has(targetTaskId)) continue;
      nodeIds.add(targetTaskId);
      if (targetTaskId !== graph.focusTaskId) pending.push(targetTaskId);
    }
  }
  return { nodeIds, edgeKeys };
}

function layoutPositions(
  graph: NormalizedTaskDependencyGraph,
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
  for (const edge of graph.edges) layout.setEdge(edge.sourceTaskId, edge.targetTaskId);
  dagre.layout(layout);
  return new Map(
    graph.nodes.map((task) => {
      const position = layout.node(task.id) as { x: number; y: number };
      return [task.id, { x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 }];
    }),
  );
}

function flowElements(
  graph: NormalizedTaskDependencyGraph,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  vertical: boolean,
  directPrerequisiteIds: ReadonlySet<string>,
  highlighted: ReturnType<typeof pathFromNodeToFocus>,
  onOpenTask: (taskId: string) => void,
  onRemoveDependency: ((taskId: string) => void) | undefined,
  removingTaskId: string | null,
  onHighlight: (taskId: string | null) => void,
): { nodes: DependencyFlowNode[]; edges: Edge[] } {
  const nodes: DependencyFlowNode[] = graph.nodes.map((task) => {
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

  const edges: Edge[] = graph.edges.map((edge) => {
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
  return { nodes, edges };
}

function DependencyFlow({
  graph,
  fullScreen,
  vertical,
  onOpenTask,
  onRemoveDependency,
  removingTaskId,
}: {
  graph: TaskDependencyGraphResponse;
  fullScreen: boolean;
  vertical: boolean;
  onOpenTask: (taskId: string) => void;
  onRemoveDependency?: (taskId: string) => void;
  removingTaskId: string | null;
}) {
  const normalized = useMemo(() => normalizeTaskDependencyGraph(graph), [graph]);
  const direct = useMemo(() => getFocusPathSets(normalized).directPrerequisiteIds, [normalized]);
  const { fitBounds } = useReactFlow();
  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const structureKey = useMemo(
    () =>
      `${vertical ? 'TB' : 'LR'}|${normalized.topologicalNodeIds.join(',')}|${normalized.edges
        .map(taskDependencyEdgeKey)
        .join(',')}`,
    [normalized, vertical],
  );
  // Dagre is the expensive part. Status/path hover only changes presentation, so keep positions
  // stable and avoid recomputing the layout as the pointer moves between nodes.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- structureKey captures every layout input
  const positions = useMemo(() => layoutPositions(normalized, vertical), [structureKey]);
  const graphBounds = useMemo(() => {
    const points = [...positions.values()];
    if (points.length === 0) return { x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT };
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x + NODE_WIDTH));
    const maxY = Math.max(...points.map((point) => point.y + NODE_HEIGHT));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }, [positions]);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlighted = useMemo(
    () => pathFromNodeToFocus(normalized, highlightedId),
    [normalized, highlightedId],
  );
  const elements = useMemo(
    () =>
      flowElements(
        normalized,
        positions,
        vertical,
        direct,
        highlighted,
        onOpenTask,
        onRemoveDependency,
        removingTaskId,
        setHighlightedId,
      ),
    [normalized, positions, vertical, direct, highlighted, onOpenTask, onRemoveDependency, removingTaskId],
  );
  useEffect(() => {
    // Fit once after a structural add/remove. Status-only realtime refreshes keep the same key,
    // so the user's pan/zoom position does not jump while tasks progress.
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
  }, [fitBounds, fullScreen, graphBounds, reduceMotion, structureKey]);

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
      <Controls showInteractive={false} orientation="horizontal" position="bottom-left" />
      {fullScreen && normalized.nodes.length > 20 && (
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          ariaLabel="Dependency graph mini map"
          nodeColor={(node) => {
            const task = (node.data as DependencyNodeData).task;
            return EDGE_COLORS[getTaskDependencyVisualState(task)];
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
  removingTaskId = null,
}: {
  graph: TaskDependencyGraphResponse;
  title: string;
  onOpenTask: (taskId: string) => void;
  onRemoveDependency?: (taskId: string) => void;
  removingTaskId?: string | null;
}) {
  const [fullScreen, setFullScreen] = useState(false);
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
