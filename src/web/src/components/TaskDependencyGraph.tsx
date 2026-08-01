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
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Modal, Popconfirm, Tooltip } from 'antd';
import { useMemo, useState } from 'react';
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
  dimmed: boolean;
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
      <Handle type="target" position={Position.Left} isConnectable={false} />
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
      <Handle type="source" position={Position.Right} isConnectable={false} />
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

function layoutGraph(
  graph: NormalizedTaskDependencyGraph,
  directPrerequisiteIds: ReadonlySet<string>,
  highlighted: ReturnType<typeof pathFromNodeToFocus>,
  onOpenTask: (taskId: string) => void,
  onRemoveDependency: ((taskId: string) => void) | undefined,
  removingTaskId: string | null,
  onHighlight: (taskId: string | null) => void,
): { nodes: DependencyFlowNode[]; edges: Edge[] } {
  const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  layout.setGraph({ rankdir: 'LR', ranksep: 64, nodesep: 28, marginx: 24, marginy: 24 });
  for (const task of graph.nodes) layout.setNode(task.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of graph.edges) layout.setEdge(edge.sourceTaskId, edge.targetTaskId);
  dagre.layout(layout);

  const nodes: DependencyFlowNode[] = graph.nodes.map((task) => {
    const position = layout.node(task.id) as { x: number; y: number };
    const isFocus = task.id === graph.focusTaskId;
    return {
      id: task.id,
      type: 'taskDependency',
      position: { x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      draggable: false,
      selectable: false,
      focusable: false,
      data: {
        task,
        isFocus,
        isDirect: directPrerequisiteIds.has(task.id),
        dimmed: !!highlighted && !highlighted.nodeIds.has(task.id),
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
  onOpenTask,
  onRemoveDependency,
  removingTaskId,
}: {
  graph: TaskDependencyGraphResponse;
  fullScreen: boolean;
  onOpenTask: (taskId: string) => void;
  onRemoveDependency?: (taskId: string) => void;
  removingTaskId: string | null;
}) {
  const normalized = useMemo(() => normalizeTaskDependencyGraph(graph), [graph]);
  const direct = useMemo(() => getFocusPathSets(normalized).directPrerequisiteIds, [normalized]);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlighted = useMemo(
    () => pathFromNodeToFocus(normalized, highlightedId),
    [normalized, highlightedId],
  );
  const elements = useMemo(
    () =>
      layoutGraph(
        normalized,
        direct,
        highlighted,
        onOpenTask,
        onRemoveDependency,
        removingTaskId,
        setHighlightedId,
      ),
    [normalized, direct, highlighted, onOpenTask, onRemoveDependency, removingTaskId],
  );

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
      panOnDrag
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
  return (
    <>
      <div className="tdg-canvas" aria-label={`Dependency graph for ${title}`}>
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
        <ReactFlowProvider>
          <DependencyFlow
            graph={graph}
            fullScreen={false}
            onOpenTask={onOpenTask}
            onRemoveDependency={onRemoveDependency}
            removingTaskId={removingTaskId}
          />
        </ReactFlowProvider>
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

export function TaskDependencyList({
  graph,
  onOpenTask,
  onRemoveDependency,
  removingTaskId = null,
}: {
  graph: TaskDependencyGraphResponse;
  onOpenTask: (taskId: string) => void;
  onRemoveDependency?: (taskId: string) => void;
  removingTaskId?: string | null;
}) {
  const normalized = useMemo(() => normalizeTaskDependencyGraph(graph), [graph]);
  const direct = useMemo(() => getFocusPathSets(normalized).directPrerequisiteIds, [normalized]);
  return (
    <div className="tdg-list" role="list" aria-label="Dependency graph as a list">
      {normalized.nodes
        .filter((node) => node.id !== normalized.focusTaskId)
        .map((node) => {
          const targets = (normalized.outgoingByTaskId.get(node.id) ?? [])
            .map((id) => normalized.nodeById.get(id)?.title)
            .filter(Boolean)
            .join(', ');
          return (
            <div className="tdg-list-row" role="listitem" key={node.id}>
              <button type="button" className="tdg-list-open" onClick={() => onOpenTask(node.id)}>
                <TaskStatusPill status={node.status} running={node.running} queued={node.queued} />
                <span className="tdg-list-copy">
                  <span className="tdg-list-title" title={node.title}>{node.title}</span>
                  <span className="tdg-list-relation" title={targets}>Required by {targets || 'another task'}</span>
                </span>
              </button>
              {direct.has(node.id) && onRemoveDependency && (
                <Popconfirm
                  title="Remove prerequisite?"
                  description="This task will no longer wait for this prerequisite."
                  okText="Remove"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => onRemoveDependency(node.id)}
                >
                  <button
                    type="button"
                    className="tdg-list-remove"
                    disabled={removingTaskId === node.id}
                    aria-label={`Remove ${node.title} as a prerequisite`}
                  >
                    <CloseOutlined />
                  </button>
                </Popconfirm>
              )}
            </div>
          );
        })}
    </div>
  );
}
