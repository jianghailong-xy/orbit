export const DEFAULT_TASK_FILTER = 'RUNNABLE';

export interface FilterableTask {
  status: string;
  running?: boolean;
  queued?: boolean;
  blocked?: boolean;
  assignee?: { runner?: { id?: string | null } | null } | null;
}

/** Keep the default task filter and the row-level Run action on one definition. */
export function canStartTask(task: FilterableTask): boolean {
  return (
    task.status !== 'DONE' &&
    !!task.assignee?.runner?.id &&
    !task.running &&
    !task.queued &&
    !task.blocked
  );
}

export function matchesTaskFilter(task: FilterableTask, filter: string): boolean {
  if (filter === 'RUNNABLE') return canStartTask(task);
  if (filter === 'RUNNING') return !!task.running;
  if (filter === 'ONGOING') return ['OPEN', 'IN_PROGRESS'].includes(task.status);
  if (filter === 'FAILED') return task.status === 'FAILED';
  if (filter === 'DONE') return task.status === 'DONE';
  if (filter === 'CANCELLED') return task.status === 'CANCELLED';
  return true;
}
