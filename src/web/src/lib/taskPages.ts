export interface TaskCounts {
  total: number;
  open: number;
  inProgress: number;
  done: number;
  failed: number;
  cancelled: number;
  running: number;
  queued: number;
  runnable: number;
  /**
   * Only with `projectId=none`: how many of the owner's tasks that scope leaves on project pages,
   * across how many projects — the one sentence the Tasks page says about the work it doesn't list.
   */
  inProjects?: { tasks: number; projects: number };
}

/** `total`/`counts` describe the scope, not the page, and are omitted when `counts=none`. */
export interface TaskPage<T = any> {
  items: T[];
  nextCursor: string | null;
  total?: number;
  counts?: TaskCounts;
}

export interface TaskPageParams {
  cursor?: string | null;
  limit?: number;
  status?: string;
  listId?: string;
  assigneeId?: string;
  /** Tasks carrying ALL of these labels. Sent as repeated params so a label may contain a comma. */
  labels?: string[];
  q?: string;
  /** Only the tasks this session created (`task.creatorSessionId`). */
  creatorSessionId?: string;
  /** A project's tasks, or `'none'` for the tasks filed under no project — the Tasks page's scope. */
  projectId?: string;
  /**
   * How much of the aggregate block to compute.
   *
   * `'total'` keeps the filtered total — which does move with the tab and the search box — and
   * skips the scope-wide counts, which do not: they are identical for every tab, so asking for
   * them again with each tab's first page recomputes a constant over the whole task table.
   * `'none'` drops both, which is all paging needs. Omitted asks for everything.
   */
  counts?: 'none' | 'total';
}

export function taskPagePath(params: TaskPageParams = {}): string {
  const search = new URLSearchParams();
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.status && params.status !== 'ALL') search.set('status', params.status);
  if (params.listId) search.set('listId', params.listId);
  if (params.assigneeId) search.set('assigneeId', params.assigneeId);
  for (const label of params.labels ?? []) search.append('labels', label);
  if (params.q?.trim()) search.set('q', params.q.trim());
  if (params.creatorSessionId) search.set('creatorSessionId', params.creatorSessionId);
  if (params.projectId) search.set('projectId', params.projectId);
  if (params.counts) search.set('counts', params.counts);
  const suffix = search.toString();
  return `/tasks/page${suffix ? `?${suffix}` : ''}`;
}

/** One label's task counts, as returned by GET /tasks/labels. */
export interface LabelSummaryRow {
  label: string;
  total: number;
  open: number;
  inProgress: number;
  done: number;
  failed: number;
  cancelled: number;
}

export interface LabelSummary {
  items: LabelSummaryRow[];
  /** How many labels exist in scope; larger than items.length when the server capped the answer. */
  labelTotal: number;
  truncated: boolean;
}

export function labelSummaryPath(listId?: string, projectId?: string): string {
  const search = new URLSearchParams();
  if (listId) search.set('listId', listId);
  if (projectId) search.set('projectId', projectId);
  const suffix = search.toString();
  return `/tasks/labels${suffix ? `?${suffix}` : ''}`;
}

/**
 * The tasks that are happening or need somebody, outside the paged list.
 *
 * `total` is the true count in scope; `items` is capped, so a strip full of failures says how
 * many it is standing in for rather than reading as the whole story.
 */
export interface ActiveTasks<T = any> {
  items: T[];
  total: number;
  truncated: boolean;
}

export function activeTasksPath(listId?: string, projectId?: string): string {
  const search = new URLSearchParams();
  if (listId) search.set('listId', listId);
  if (projectId) search.set('projectId', projectId);
  const suffix = search.toString();
  return `/tasks/active${suffix ? `?${suffix}` : ''}`;
}

export function taskCountsPath(
  listId?: string,
  labels: string[] = [],
  creatorSessionId?: string,
  projectId?: string,
): string {
  const search = new URLSearchParams();
  if (listId) search.set('listId', listId);
  for (const label of labels) search.append('labels', label);
  if (creatorSessionId) search.set('creatorSessionId', creatorSessionId);
  if (projectId) search.set('projectId', projectId);
  const suffix = search.toString();
  return `/tasks/counts${suffix ? `?${suffix}` : ''}`;
}
