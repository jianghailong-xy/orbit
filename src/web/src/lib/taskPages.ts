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
  q?: string;
  /**
   * `'none'` asks the server to skip the aggregate block. The counts are scope-wide, so every
   * page past the first would recompute numbers the client already read off page 1 — and on a
   * large account that block is the most expensive part of the request.
   */
  counts?: 'none';
}

export function taskPagePath(params: TaskPageParams = {}): string {
  const search = new URLSearchParams();
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.status && params.status !== 'ALL') search.set('status', params.status);
  if (params.listId) search.set('listId', params.listId);
  if (params.assigneeId) search.set('assigneeId', params.assigneeId);
  if (params.q?.trim()) search.set('q', params.q.trim());
  if (params.counts) search.set('counts', params.counts);
  const suffix = search.toString();
  return `/tasks/page${suffix ? `?${suffix}` : ''}`;
}
