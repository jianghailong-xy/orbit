/**
 * A project's dependency graph, drawn — the picture `ProjectTasksGraph` puts under the project's
 * panorama header.
 *
 * ## The structural decision this component is built on
 *
 * A project page carries TWO structures at once: a parent/child task tree, and dependency edges
 * that cut across it. They are unrelated questions — subtask-of says nothing about ordering,
 * waits-on says nothing about membership — so drawing both as lines produces a hairball at the
 * size real projects already reach (a 24-task / 49-edge project is not unusual here).
 *
 * So, decided once and stated here rather than rediscovered per bug report:
 *
 *   **Only dependency edges are drawn as edges. Parent/child is folded into a group box.**
 *
 * A task with subtasks on this canvas is not a node — it IS the box its subtasks sit in, carrying
 * its own title and status in the box header, and its own dependency edges attach to the box. No
 * line on this canvas ever means "is part of"; every line means "waits on". A reader who wants the
 * tree reads the task list further down the page, which holds both structures without having to
 * draw either.
 *
 * Nesting stops at one level: a parent that is itself a subtask is lifted to the canvas as a box
 * of its own (see `groupIdOf` in `lib/projectDependencyGraph.ts`). Boxes inside boxes buy nothing
 * at the only sizes this view is willing to draw.
 *
 * ## Weight
 *
 * React Flow and dagre are imported HERE and nowhere on the path to the project page. This module
 * is reached only through the `lazy()` boundary in `ProjectTasksGraph`, and the node-count
 * threshold is checked on the far side of that boundary — an oversized project never downloads
 * this chunk at all.
 */
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Alert, Button, Empty, Spin } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  layoutProjectDependencyGraph,
  PROJECT_GRAPH_NODE_HEIGHT,
  PROJECT_GRAPH_NODE_WIDTH,
  type ProjectDependencyGraphNode,
} from '../lib/projectDependencyGraph';
import { projectDependencyGraphQuery } from '../lib/queries';
import {
  getTaskDependencyVisualState,
  type TaskDependencyVisualState,
} from '../lib/taskDependencyGraph';
// The one palette, imported rather than restated: these two graphs must not disagree about what
// a released prerequisite looks like, and the values there are the ones measured against
// deuteranopia/protanopia simulation in `lib/statusPalette.test.ts`.
import { EDGE_COLORS } from './TaskDependencyGraph';
import { TaskStatusPill, taskStatusLabel } from './TaskStatusPill';

/**
 * The colour-independent second channel for a failed prerequisite.
 *
 * Under deuteranopia the safe green/red pair still lands near the discrimination floor, so state
 * on an edge — a bare line with no label or icon — cannot rest on hue alone. Deliberately not the
 * task graph's aggregate-branch dash, so a failed dependency never reads as a collapsed branch.
 */
const FAILED_EDGE_DASH = '7 4';

interface TaskNodeData extends Record<string, unknown> {
  task: ProjectDependencyGraphNode;
  hasIncoming: boolean;
  hasOutgoing: boolean;
}

interface GroupNodeData extends Record<string, unknown> {
  task: ProjectDependencyGraphNode;
  memberCount: number;
  hasIncoming: boolean;
  hasOutgoing: boolean;
}

type TaskFlowNode = Node<TaskNodeData, 'projectDependencyTask'>;
type GroupFlowNode = Node<GroupNodeData, 'projectDependencyGroup'>;

/** React Flow disables pointer events on non-interactive node wrappers; these contain links. */
const INTERACTIVE_NODE_STYLE = { pointerEvents: 'all' } as const;

function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const state = getTaskDependencyVisualState(data.task);
  return (
    <div className={`tdg-node state-${state}`}>
      {data.hasIncoming && <Handle type="target" position={Position.Left} isConnectable={false} />}
      <Link
        className="tdg-node-main nodrag nopan"
        to={`/tasks/${data.task.id}`}
        aria-label={`${data.task.title}, ${taskStatusLabel(data.task.status)}`}
      >
        <span className="tdg-node-title-row">
          <span className="tdg-node-title">{data.task.title}</span>
        </span>
        <TaskStatusPill status={data.task.status} />
      </Link>
      {data.hasOutgoing && <Handle type="source" position={Position.Right} isConnectable={false} />}
    </div>
  );
}

/** A parent task. Its subtasks are separate React Flow children positioned inside this frame. */
function GroupNode({ data }: NodeProps<GroupFlowNode>) {
  const state = getTaskDependencyVisualState(data.task);
  return (
    <div className={`pdg-group state-${state}`}>
      {data.hasIncoming && <Handle type="target" position={Position.Left} isConnectable={false} />}
      <Link
        className="pdg-group-header nodrag nopan"
        to={`/tasks/${data.task.id}`}
        aria-label={`${data.task.title}, ${taskStatusLabel(data.task.status)}, ${data.memberCount} subtask${data.memberCount === 1 ? '' : 's'}`}
      >
        <span className="pdg-group-title">{data.task.title}</span>
        <TaskStatusPill status={data.task.status} />
      </Link>
      {data.hasOutgoing && <Handle type="source" position={Position.Right} isConnectable={false} />}
    </div>
  );
}

const NODE_TYPES = { projectDependencyTask: TaskNode, projectDependencyGroup: GroupNode };

/**
 * Positioned React Flow elements for one project graph.
 *
 * Parents come before their members in the node array — React Flow requires a child's frame to
 * exist by the time the child is read.
 *
 * Exported for tests: the placement rules are the whole point of the view, and a canvas cannot be
 * asserted on the way an array of positions can.
 */
export function buildProjectFlowElements(
  layout: ReturnType<typeof layoutProjectDependencyGraph>,
): { nodes: Array<TaskFlowNode | GroupFlowNode>; edges: Edge[] } {
  const incoming = new Set(layout.edges.map((edge) => edge.targetTaskId));
  const outgoing = new Set(layout.edges.map((edge) => edge.sourceTaskId));
  const stateById = new Map<string, TaskDependencyVisualState>();
  for (const group of layout.groups) {
    stateById.set(group.task.id, getTaskDependencyVisualState(group.task));
  }
  for (const placement of layout.placements) {
    stateById.set(placement.task.id, getTaskDependencyVisualState(placement.task));
  }

  const groupNodes: GroupFlowNode[] = layout.groups.map((group) => ({
    id: group.task.id,
    type: 'projectDependencyGroup',
    position: { x: group.x, y: group.y },
    style: { ...INTERACTIVE_NODE_STYLE, width: group.width, height: group.height },
    draggable: false,
    selectable: false,
    connectable: false,
    data: {
      task: group.task,
      memberCount: group.members.length,
      hasIncoming: incoming.has(group.task.id),
      hasOutgoing: outgoing.has(group.task.id),
    },
  }));
  const taskNodes: TaskFlowNode[] = layout.placements.map((placement) => ({
    id: placement.task.id,
    type: 'projectDependencyTask',
    position: { x: placement.x, y: placement.y },
    style: {
      ...INTERACTIVE_NODE_STYLE,
      width: PROJECT_GRAPH_NODE_WIDTH,
      height: PROJECT_GRAPH_NODE_HEIGHT,
    },
    draggable: false,
    selectable: false,
    connectable: false,
    ...(placement.groupId ? { parentId: placement.groupId, extent: 'parent' as const } : {}),
    data: {
      task: placement.task,
      hasIncoming: incoming.has(placement.task.id),
      hasOutgoing: outgoing.has(placement.task.id),
    },
  }));

  const edges: Edge[] = layout.edges.map((edge) => {
    // An edge's state is its PREREQUISITE's, never its dependent's: what the line reports is
    // whether the thing at its tail has released the thing at its head.
    const state = stateById.get(edge.sourceTaskId) ?? 'pending';
    return {
      id: `${edge.sourceTaskId}->${edge.targetTaskId}`,
      source: edge.sourceTaskId,
      target: edge.targetTaskId,
      type: 'smoothstep',
      style: {
        stroke: EDGE_COLORS[state],
        strokeWidth: 1.5,
        opacity: state === 'complete' ? 0.55 : 0.9,
        ...(state === 'failed' ? { strokeDasharray: FAILED_EDGE_DASH } : {}),
      },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: EDGE_COLORS[state] },
    };
  });

  return { nodes: [...groupNodes, ...taskNodes], edges };
}

export function ProjectDependencyGraph({ projectId }: { projectId: string }) {
  const graph = useQuery(projectDependencyGraphQuery(projectId));
  const elements = useMemo(
    () => (graph.data ? buildProjectFlowElements(layoutProjectDependencyGraph(graph.data)) : null),
    [graph.data],
  );

  if (graph.isLoading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }
  if (graph.isError) {
    return (
      <Alert
        type="error"
        showIcon
        message="Dependency graph could not be loaded"
        description={graph.error instanceof Error ? graph.error.message : undefined}
        action={
          <Button size="small" danger onClick={() => graph.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }
  if (!elements || elements.nodes.length === 0) {
    return <Empty description="No tasks to draw yet" />;
  }

  return (
    <>
      <div className="tdg-canvas" data-testid="project-dependency-graph">
        <ReactFlowProvider>
          <ReactFlow
            nodes={elements.nodes}
            edges={elements.edges}
            nodeTypes={NODE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
            fitView
            minZoom={0.2}
            maxZoom={1}
          >
            <Background gap={18} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
        <div className="tdg-direction">Prerequisite → dependent · boxes are parent tasks</div>
      </div>
      {graph.data?.truncated ? (
        <Alert
          style={{ marginTop: 8 }}
          type="warning"
          showIcon
          message={`Only the first ${graph.data.limits.maxNodes} tasks are drawn.`}
        />
      ) : null}
    </>
  );
}
