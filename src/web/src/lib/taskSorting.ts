export type TaskSortField = 'status' | 'title' | 'assignee' | 'created';
export type TaskSortDirection = 'asc' | 'desc';

/**
 * Creation order, matching what the server already returns — so by default the rows are in the
 * order they arrived and nothing is silently rearranged.
 *
 * It used to default to `status`, which put running and failed work on top. That reads as "the
 * important ones first" and cannot be: this sort runs in the browser over the pages fetched so
 * far, while tasks execute oldest-first and the list is served newest-first. The active tasks
 * are therefore the *last* rows anyone would page to — 550 pages down on this deployment — so
 * sorting the loaded rows by status reordered a set that never contained them. The pinned strip
 * above the list is what actually surfaces them; status stays available as a manual sort, where
 * it is honest about being a sort of what you are looking at.
 */
export const DEFAULT_TASK_SORT_FIELD: TaskSortField = 'created';
export const DEFAULT_TASK_SORT_DIRECTION: TaskSortDirection = 'desc';

const TASK_SORT_FIELDS = new Set<TaskSortField>(['status', 'title', 'assignee', 'created']);

export function readTaskSort(search: URLSearchParams): {
  field: TaskSortField;
  direction: TaskSortDirection;
} {
  const rawField = search.get('sort');
  const hasExplicitField = TASK_SORT_FIELDS.has(rawField as TaskSortField);
  const field = hasExplicitField ? (rawField as TaskSortField) : DEFAULT_TASK_SORT_FIELD;
  const rawDirection = search.get('dir');
  const direction =
    rawDirection === 'asc' || rawDirection === 'desc'
      ? rawDirection
      : hasExplicitField
        ? 'desc'
        : DEFAULT_TASK_SORT_DIRECTION;
  return { field, direction };
}

export function writeTaskSort(
  current: URLSearchParams,
  field: TaskSortField,
  direction: TaskSortDirection,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (field === DEFAULT_TASK_SORT_FIELD && direction === DEFAULT_TASK_SORT_DIRECTION) {
    next.delete('sort');
    next.delete('dir');
    return next;
  }

  if (field === DEFAULT_TASK_SORT_FIELD) next.delete('sort');
  else next.set('sort', field);
  // Non-default combinations are explicit, so their meaning cannot change when defaults do.
  next.set('dir', direction);
  return next;
}

interface SortableTask {
  status?: string | null;
  running?: boolean;
  queued?: boolean;
  title?: string | null;
  createdAt?: string | null;
  assignee?: { name?: string | null } | null;
}

// Live execution state wins over the persisted lifecycle status. Ascending status order
// therefore keeps work that is happening now at the top of the task list.
const STATUS_ORDER: Record<string, number> = {
  IN_PROGRESS: 1,
  FAILED: 2,
  OPEN: 3,
  DONE: 4,
  CANCELLED: 5,
};

export const taskStatusRank = (task: SortableTask): number =>
  task.running ? 0 : task.queued ? 1 : (STATUS_ORDER[task.status ?? ''] ?? 5) + 1;

// Compare two tasks by the chosen field, ascending. Equal pairs return 0 so the caller's
// stable sort preserves the incoming createdAt-desc order as a tiebreak.
export const compareTasksBy = (
  a: SortableTask,
  b: SortableTask,
  field: TaskSortField,
): number => {
  switch (field) {
    case 'status':
      return taskStatusRank(a) - taskStatusRank(b);
    case 'title':
      // Numeric collation so "Unit 9" sorts before "Unit 73" (not lexicographically).
      return (a.title ?? '').localeCompare(b.title ?? '', 'zh', { numeric: true });
    case 'assignee':
      return (a.assignee?.name ?? '').localeCompare(b.assignee?.name ?? '', 'zh');
    case 'created':
      return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  }
};
