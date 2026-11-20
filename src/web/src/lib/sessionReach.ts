/**
 * Which sessions' events can move a read that declares the `session` entity (`meta.sessionReach` beside
 * `meta.entities`). The control-plane stream reads a view again for a `session.*`, `approval.*` or
 * `background.task` event only when the session the event is about can be in it (useControlPlane).
 *
 * - `{ session: id }`: one session's own reads, the cards of its page. Only that session's events reach it.
 * - `{ workspace: id }`: a list of one workspace's sessions (`null`: of every workspace). An event of a session in
 *   that workspace reaches it, and so does one of a session the list holds, which may have moved out of it.
 * - `{ scheduledRuns: id }`: a workspace's Scheduled runs folder, which the server builds whole on every read. A
 *   scheduled run is in no other list and its creation publishes nothing (scheduled-tasks-design.md §7.4), so an
 *   event reaches the folder when the folder holds its session, or when its session is in that workspace and no
 *   list on hand holds it. `session.created` alone never does.
 * - `'none'`: an owner-wide read no single session's event can be said to move (owner requests, schedules, the
 *   sessions shared with this reader). It keeps its own safety read.
 *
 * A read that says nothing is reached by every session event, as it always was.
 */
export type SessionReach =
  | { session: string }
  | { workspace: string | null }
  | { scheduledRuns: string | null }
  | 'none';

/** What the stream knows of the session an event is about. */
export interface SessionSubject {
  id: string;
  /** The session's workspace, as the event's envelope names it; '' when it names none. */
  workspaceId: string;
  /** Every event of this session in the window was a `session.created`. */
  createdOnly: boolean;
}

/** The ids of the rows a list read holds; none for anything that is not a list of rows. */
export const heldIds = (data: unknown): string[] =>
  Array.isArray(data)
    ? data.flatMap((row) => (row && typeof (row as { id?: unknown }).id === 'string' ? [(row as { id: string }).id] : []))
    : [];

/**
 * Whether an event about `subject` can move a read that declares `reach`. `held` is what the read holds now;
 * `listedElsewhere` says whether a list other than the Scheduled runs folder holds the session.
 */
export function sessionReaches(
  reach: SessionReach | undefined,
  subject: SessionSubject,
  held: readonly string[],
  listedElsewhere: (id: string) => boolean,
): boolean {
  if (reach === undefined) return true;
  if (reach === 'none') return false;
  if ('session' in reach) return reach.session === subject.id;
  const inWorkspace = (id: string | null): boolean => id === null || !subject.workspaceId || id === subject.workspaceId;
  if ('workspace' in reach) return inWorkspace(reach.workspace) || held.includes(subject.id);
  if (held.includes(subject.id)) return true;
  if (subject.createdOnly || !inWorkspace(reach.scheduledRuns)) return false;
  return !listedElsewhere(subject.id);
}
