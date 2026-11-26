import { listingRows } from './sessionListingData';

/**
 * Which sessions' events can move a read that declares the `session` entity (`meta.sessionReach` beside
 * `meta.entities`). The control-plane stream reads a view again for a `session.*`, `approval.*` or
 * `background.task` event only when the session the event is about can be in it (useControlPlane).
 *
 * - `{ session: id, tasks? }`: one session's own reads, the cards of its page. Only that session's events reach it,
 *   and, with `tasks`, those of a session running one of them (the runs a created-tasks row draws).
 * - `{ sessions: ids, created? }`: reads that show these sessions (a request's two ends, a list of questions);
 *   with `created`, any session.created reaches it too, a session it may list next.
 * - `{ workspace: id }`: a list of one workspace's sessions (`null`: of every workspace). An event of a session in
 *   that workspace reaches it, and so does one of a session the list holds, which may have moved out of it.
 * - `{ scheduledRuns: id, holds? }`: a workspace's Scheduled runs (the folder, which the server builds whole on every
 *   read, and a schedule's inspector). A scheduled run is in no other list and its creation publishes nothing
 *   (scheduled-tasks-design.md §7.4), so an event reaches it when the read holds its session, or when its session
 *   is in that workspace and no list on hand holds it. `session.created` alone never does.
 * - `{ task: id, holds? }`: one task's document, whose Running/Queued comes from its runs: an event of a session
 *   that runs that task, or of a session the document names.
 * - `{ tasks: ids }`: a set of tasks' live run state (a dependency graph): an event of a session running one of them.
 * - `{ taskRuns: projectId }`: task pages that count or list running and queued tasks (`null`: of every project):
 *   an event of any session that runs a task, in that project when the event says which.
 * - `'lifecycle'`: whether any session exists (the welcome card): only a session entering or leaving the lists,
 *   `session.created` or `session.ended`.
 * - `'none'`: a read no session event can be said to move: owner-wide reads (owner requests, schedules, the sessions
 *   shared with this reader), or one drawn where the stream never runs. It keeps its own safety read.
 *
 * It may be a function of what the read holds, for a read whose key does not name its sessions. A read that says
 * nothing is reached by every session event, as it always was.
 */
export type SessionReach =
  | { session: string; tasks?: readonly string[] }
  | { sessions: readonly string[]; created?: boolean }
  | { workspace: string | null }
  | { scheduledRuns: string | null; holds?: readonly string[] }
  | { task: string; holds?: readonly string[] }
  | { tasks: readonly string[] }
  | { taskRuns: string | null }
  | 'lifecycle'
  | 'none';

/** What `meta.sessionReach` holds: a reach, or one computed from the read's data. */
export type SessionReachDeclaration = SessionReach | ((data: unknown) => SessionReach);

/** What the stream knows of the session an event is about. */
export interface SessionSubject {
  id: string;
  /** The session's workspace, as the event's envelope names it; '' when it names none. */
  workspaceId: string;
  /** The task the session runs; '' when it runs none, or none is known. */
  taskId: string;
  /** The project the session belongs to; '' when none is known. */
  projectId: string;
  /** Every event of this session in the window was a `session.created`. */
  createdOnly: boolean;
  /** One of its events in the window was a `session.created`. */
  created: boolean;
  /** One of its events in the window was a `session.created` or `session.ended`. */
  lifecycle: boolean;
}

/** The ids of the rows a list read holds — a listing's (lib/sessionListingData) included; none for anything that is
 *  not a list of rows. */
export const heldIds = (data: unknown): string[] =>
  Array.isArray(data)
    ? data.flatMap((row) => (row && typeof (row as { id?: unknown }).id === 'string' ? [(row as { id: string }).id] : []))
    : listingRows(data).map((row) => row.id);

const strings = (values: readonly unknown[]): string[] =>
  values.filter((value): value is string => typeof value === 'string' && value !== '');

/** A task document (`GET /tasks/:id`): its runs and its creator are the sessions it draws. */
export const taskDocumentReach = (taskId: string) => (data: unknown): SessionReach => {
  const doc = data as { sessions?: { id?: unknown }[] | null; creatorSession?: { id?: unknown } | null; creatorSessionId?: unknown } | undefined;
  return {
    task: taskId,
    holds: strings([...(doc?.sessions ?? []).map((session) => session?.id), doc?.creatorSession?.id, doc?.creatorSessionId]),
  };
};

/** A dependency graph (or its expanded nodes): the tasks whose run state its nodes draw. */
export const taskGraphReach = (data: unknown): SessionReach => ({
  tasks: strings(((data as { nodes?: { id?: unknown }[] } | undefined)?.nodes ?? []).map((node) => node?.id)),
});

/**
 * Whether an event about `subject` can move a read that declares `reach`. `held` is what the read holds now (its
 * rows); `listedElsewhere` says whether a list other than a Scheduled runs folder holds the session.
 */
export function sessionReaches(
  reach: SessionReach | undefined,
  subject: SessionSubject,
  held: readonly string[],
  listedElsewhere: (id: string) => boolean,
): boolean {
  if (reach === undefined) return true;
  if (reach === 'none') return false;
  if (reach === 'lifecycle') return subject.lifecycle;
  if ('session' in reach) {
    return reach.session === subject.id || (subject.taskId !== '' && (reach.tasks ?? []).includes(subject.taskId));
  }
  if ('sessions' in reach) return reach.sessions.includes(subject.id) || (reach.created === true && subject.created);
  if ('task' in reach) return reach.task === subject.taskId || (reach.holds ?? []).includes(subject.id);
  if ('tasks' in reach) return subject.taskId !== '' && reach.tasks.includes(subject.taskId);
  if ('taskRuns' in reach) {
    return subject.taskId !== '' && (reach.taskRuns === null || !subject.projectId || reach.taskRuns === subject.projectId);
  }
  const inWorkspace = (id: string | null): boolean => id === null || !subject.workspaceId || id === subject.workspaceId;
  if ('workspace' in reach) return inWorkspace(reach.workspace) || held.includes(subject.id);
  if (held.includes(subject.id) || (reach.holds ?? []).includes(subject.id)) return true;
  if (subject.createdOnly || !inWorkspace(reach.scheduledRuns)) return false;
  return !listedElsewhere(subject.id);
}

/**
 * Which `task.changed` events can move a read that declares the `task` entity (`meta.taskReach` beside
 * `meta.entities`): a session's "Tasks created here", whose rows are the tasks that session created and the tasks that
 * took one of them over. A change reaches it when the event names that session among its rows' creators
 * (`creatorSessionIds`), or names one of the rows it holds; and always when it cannot say — a resync, or a server that
 * does not name creators. A read that declares no `taskReach` is reached by every task event, as it always was.
 */
export interface TaskReach {
  creatorSession: string;
  tasks: readonly string[];
}

/** What `meta.taskReach` holds: a reach, or one computed from the read's data. */
export type TaskReachDeclaration = TaskReach | ((data: unknown) => TaskReach);

/** What one `task.changed` says, as the stream reads it. `creatorSessionIds` is null when it does not say. */
export interface TaskChange {
  taskIds: readonly string[];
  creatorSessionIds: readonly string[] | null;
  resync: boolean;
}

/** Whether `change` can move a read that declares `reach`. */
export function taskReaches(reach: TaskReach, change: TaskChange): boolean {
  if (change.resync || change.creatorSessionIds === null) return true;
  return change.creatorSessionIds.includes(reach.creatorSession) || change.taskIds.some((id) => reach.tasks.includes(id));
}
