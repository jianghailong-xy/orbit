import { CloseOutlined } from '@ant-design/icons';
import { Popconfirm } from 'antd';
import { useMemo } from 'react';
import {
  getFocusPathSets,
  normalizeTaskDependencyGraph,
  type TaskDependencyGraphResponse,
} from '../lib/taskDependencyGraph';
import { TaskStatusPill } from './TaskStatusPill';

/** Topologically ordered, keyboard-friendly equivalent of the visual dependency graph. */
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
        .map((node) => {
          const isFocus = node.id === normalized.focusTaskId;
          const prerequisites = (normalized.incomingByTaskId.get(node.id) ?? [])
            .map((id) => normalized.nodeById.get(id)?.title)
            .filter(Boolean)
            .join(', ');
          const targets = (normalized.outgoingByTaskId.get(node.id) ?? [])
            .map((id) => normalized.nodeById.get(id)?.title)
            .filter(Boolean)
            .join(', ');
          const relationships = [
            prerequisites ? `Depends on ${prerequisites}` : '',
            targets ? `Required by ${targets}` : '',
          ].filter(Boolean).join(' · ');
          return (
            <div
              className={`tdg-list-row${isFocus ? ' is-focus' : ''}`}
              role="listitem"
              key={node.id}
            >
              <button type="button" className="tdg-list-open" onClick={() => onOpenTask(node.id)}>
                <TaskStatusPill status={node.status} running={node.running} queued={node.queued} />
                <span className="tdg-list-copy">
                  <span className="tdg-list-title-row">
                    <span className="tdg-list-title" title={node.title}>{node.title}</span>
                    {isFocus && <span className="tdg-current-tag">Current</span>}
                  </span>
                  <span className="tdg-list-relation" title={relationships}>
                    {relationships || 'No adjacent relationships'}
                  </span>
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
