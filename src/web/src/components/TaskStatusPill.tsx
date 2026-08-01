import { LoadingOutlined } from '@ant-design/icons';

const STATUS_PILL: Record<string, { cls: string; label: string }> = {
  DONE: { cls: 'done', label: 'Done' },
  IN_PROGRESS: { cls: 'ongoing', label: 'In progress' },
  OPEN: { cls: 'todo', label: 'Open' },
  FAILED: { cls: 'failed', label: 'Failed' },
  CANCELLED: { cls: 'cancelled', label: 'Cancelled' },
};

export function taskStatusLabel(status: string, running?: boolean, queued?: boolean): string {
  if (running) return 'Running';
  if (queued) return 'Queued';
  return STATUS_PILL[status]?.label ?? status;
}

/**
 * Shared task lifecycle pill. Live session state wins over the stored task lifecycle so the
 * dependency graph and the task list describe a running/queued task in the same way.
 */
export function TaskStatusPill({
  status,
  running,
  queued,
}: {
  status: string;
  running?: boolean;
  queued?: boolean;
}) {
  if (running) {
    return (
      <span className="status-pill running">
        <LoadingOutlined spin />
        Running
      </span>
    );
  }
  if (queued) {
    return (
      <span className="status-pill queued">
        <span className="status-dot" />
        Queued
      </span>
    );
  }
  const s = STATUS_PILL[status] ?? { cls: 'todo', label: status };
  return (
    <span className={`status-pill ${s.cls}`}>
      <span className="status-dot" />
      {s.label}
    </span>
  );
}
