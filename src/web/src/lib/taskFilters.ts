/**
 * The tab a task page opens on when nothing else says otherwise.
 *
 * `ALL` rather than `RUNNABLE`: Ready counts only what could be dispatched *right now* — no
 * unmet prerequisite, a workspace bound to a live runner, nothing already in flight. In a
 * dependency-ordered campaign that is almost always zero, so the page opened on an empty table
 * reading "No tasks are ready to run" while holding 27,468 tasks. A landing tab that hides the
 * whole list to report a transient scheduling fact is answering a question nobody asked on
 * arrival.
 */
export const DEFAULT_TASK_FILTER = 'ALL';

/** Where the last tab the user picked is remembered, so the choice outlives one page view. */
export const TASK_FILTER_STORAGE_KEY = 'orbit-task-filter';

/**
 * The tab to open on: an explicit `?filter=` wins (a shared link means what it says), then
 * whatever the user last picked, then the default. Storage is read defensively — Safari's
 * private mode throws on access rather than returning null, and a task list that will not
 * render is a worse outcome than a forgotten preference.
 */
export function initialTaskFilter(fromUrl: string | null): string {
  if (fromUrl) return fromUrl;
  try {
    return localStorage.getItem(TASK_FILTER_STORAGE_KEY) ?? DEFAULT_TASK_FILTER;
  } catch {
    return DEFAULT_TASK_FILTER;
  }
}

export function rememberTaskFilter(filter: string): void {
  try {
    localStorage.setItem(TASK_FILTER_STORAGE_KEY, filter);
  } catch {
    /* preference is a convenience; losing it must never break the view */
  }
}

export interface FilterableTask {
  status: string;
  running?: boolean;
  queued?: boolean;
  blocked?: boolean;
  assignee?: { runner?: { id?: string | null } | null } | null;
}

/**
 * The run conditions available on a list row: a responsible workspace bound to a runner,
 * satisfied prerequisites, and no run already in flight. The server remains authoritative for
 * facts this payload does not carry, including a paused task, a disabled workspace, an
 * aggregate-only parent, or superseded work. Neither execute endpoint refuses a DONE task, so
 * this low-level dispatch check does not either.
 */
export function canDispatchTask(task: FilterableTask): boolean {
  return !!task.assignee?.runner?.id && !task.running && !task.queued && !task.blocked;
}

/** Keep the default task filter and the row-level Run action on one definition. */
export function canStartTask(task: FilterableTask): boolean {
  return task.status !== 'DONE' && canDispatchTask(task);
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
