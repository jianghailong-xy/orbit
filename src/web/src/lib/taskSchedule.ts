import type { QueryClient } from '@tanstack/react-query';

/**
 * A task's scheduled start, converted between the two spellings that matter.
 *
 * `runAt` is one instant, stored and sent as UTC. A `datetime-local` control speaks only the
 * VIEWER's wall clock, which is also the only reading a person can sensibly pick. Every conversion
 * between those two lives here — once — so the New task dialog that creates a schedule and the
 * task panel that edits one cannot drift into disagreeing about what a given wall time means.
 *
 * Nothing here touches the network or React; it is all total functions over strings, so the rules
 * below can be tested in a pinned zone without a browser.
 */

/** How a scheduled start is written on a row, matching the rest of the app's short instants. */
const RUN_AT_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/**
 * A stored `runAt` as the two spellings a row needs at once.
 *
 * `local` is the viewer's own wall clock — an instant shown in UTC is the wrong time for everyone
 * outside it, and the reader is the person deciding whether that start is soon. `iso` is the same
 * instant exactly, normalized through `toISOString` so the machine-readable half is one canonical
 * UTC spelling whatever the payload happened to carry.
 *
 * Null for an absent, cleared or unparseable value alike, so a row renders no schedule at all
 * rather than the words "Invalid Date" — the one thing a stray `new Date(...)` puts on screen.
 */
export function scheduledStart(runAt: string | null | undefined): { iso: string; local: string } | null {
  if (!runAt) return null;
  const at = new Date(runAt);
  if (Number.isNaN(at.getTime())) return null;
  return { iso: at.toISOString(), local: at.toLocaleString([], RUN_AT_FORMAT) };
}

/**
 * A `datetime-local` value as the UTC instant the API stores — the one timezone conversion in the
 * app, kept as a function so it can be tested without a browser.
 *
 * Built from the parsed COMPONENTS rather than from the string. Handing the string to `new Date`
 * would read a date-time with no offset as local but a bare `YYYY-MM-DD` as UTC, so a date-only
 * value would silently shift the schedule by the viewer's own offset; the component constructor
 * has only one reading, and it is the viewer's zone — which is what the control collects.
 *
 * Then read straight back, because that constructor NORMALIZES an impossible wall time instead of
 * refusing it, which would schedule a moment the reader never picked:
 *   - Feb 31st becomes Mar 3rd — a date, silently, three days later.
 *   - 02:30 on a spring-forward day becomes 03:30. That local time does not exist, and worse, it
 *     lands on the very same instant as a deliberate 03:30 — so two different choices would be
 *     indistinguishable afterwards.
 *   - A year under 100 lands in the 1900s, the constructor's own two-digit-year rule.
 * A time that is merely AMBIGUOUS is not impossible and stays accepted: 02:30 on a fall-back day
 * happens twice, and reads back as 02:30, so it survives as the earlier of the two.
 *
 * Everything that fails — nothing chosen, a cleared field, a half-typed or impossible value —
 * comes back undefined, the same absence an unscheduled task has always had. That is what keeps
 * `''`, `Invalid Date` and a quietly-moved schedule off the wire alike.
 */
export function runAtIso(local: string | undefined): string | undefined {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local ?? '');
  if (!parts) return undefined;
  const [year, month, day, hour, minute, second] = [
    parts[1],
    parts[2],
    parts[3],
    parts[4],
    parts[5],
    parts[6] ?? '0',
  ].map(Number);

  const at = new Date(year, month - 1, day, hour, minute, second);
  const survived =
    at.getFullYear() === year &&
    at.getMonth() === month - 1 &&
    at.getDate() === day &&
    at.getHours() === hour &&
    at.getMinutes() === minute &&
    at.getSeconds() === second;
  return survived ? at.toISOString() : undefined;
}

/**
 * The inverse: a stored instant as the value a `datetime-local` control can actually hold.
 *
 * The control accepts one spelling only — `YYYY-MM-DDTHH:mm[:ss]` on the viewer's wall clock — and
 * silently blanks itself when handed anything else, including the `...Z` instant the API returns.
 * So this reads the instant's LOCAL components, the exact reading `runAtIso` inverts, rather than
 * slicing `toISOString()`: the slice would show a reader in Shanghai the UTC hour and call it
 * theirs, an eight-hour lie that looks entirely plausible on screen.
 *
 * Seconds appear only when the instant actually has them, which is the truthful minimum: the
 * control is rendered with `step=1` so a value carrying `:30` round-trips through `runAtIso`
 * unchanged instead of being rounded to the minute behind the reader's back. (Sub-second precision
 * has no spelling in this control at all; it survives untouched as long as nobody saves, which is
 * why an unedited draft is never sent — see `canSaveTaskSchedule`.)
 *
 * '' — an empty control, never the words "Invalid Date" — for an unscheduled task and for a value
 * that cannot be parsed alike. A garbled instant must not become a schedule the reader appears to
 * have picked, and must not block them from clearing it.
 */
export function runAtLocalValue(runAt: string | null | undefined): string {
  if (!runAt) return '';
  const at = new Date(runAt);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const day = `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.getSeconds() ? `${day}T${time}:${pad(at.getSeconds())}` : `${day}T${time}`;
}

/** Said to the reader, and thrown at a caller that tries to send one anyway — one sentence, so the
 *  two can never drift into describing the same refusal differently. */
export const RUN_AT_IMPOSSIBLE =
  'That is not a time that exists. Check the date — and on a daylight-saving change, your clock skips an hour.';

/**
 * What is wrong with the start a control currently holds, or null when nothing is.
 *
 * Nothing chosen is not a problem: an unscheduled task is the normal case, and the whole point of
 * the field being optional. A value that is THERE and cannot be converted is a different state
 * entirely — the reader picked a moment, and every path out of here has to keep saying so rather
 * than quietly treating it as though they had picked nothing.
 *
 * The gap this closes is narrow but real and reachable: a browser's datetime-local knows nothing
 * about the reader's daylight-saving rules, so it will happily offer 02:30 on a spring-forward day
 * — a time their own clock skips.
 */
export function runAtProblem(local: string | undefined): string | null {
  if (!local) return null;
  return runAtIso(local) ? null : RUN_AT_IMPOSSIBLE;
}

/**
 * Whether a "Save schedule" action may fire, given the draft in the control and the value the
 * server's own schedule renders as.
 *
 * Three refusals, each of which would otherwise send a change nobody asked for:
 *   - An EMPTY draft is not a schedule. Clearing the box is how a reader gets to a blank control,
 *     not how they cancel — and PATCHing `runAt: null` off the back of it would delete a schedule
 *     from a keystroke that could equally well be the start of retyping one. Cancelling is its own
 *     visible action, and it says so.
 *   - An IMPOSSIBLE draft is refused rather than normalized, for the reasons `runAtIso` sets out.
 *   - An UNCHANGED draft has nothing to send. This is also the one guard on a genuinely ambiguous
 *     stored instant: on a fall-back day 02:30 happens twice and the control can only spell one of
 *     them, so re-saving an untouched value could move the schedule an hour earlier. Never sending
 *     it is what makes "I didn't touch it" mean the schedule didn't move.
 */
export function canSaveTaskSchedule(draft: string, current: string): boolean {
  if (!draft) return false;
  if (runAtProblem(draft)) return false;
  return draft !== current;
}

/**
 * A task as a refresh has to know it: the task itself, and the project whose cached pages a run
 * or a reschedule makes stale. `projectId` is null or absent for the many tasks filed under no
 * project at all, which is a refresh of nothing rather than a refresh of every project.
 */
export interface TaskRefreshTarget {
  id: string;
  projectId?: string | null;
}

/**
 * Refresh every view that a change to WHEN a set of tasks runs makes stale — a schedule saved, a
 * schedule cancelled, a Run now that consumed one, or a batch run that consumed several.
 *
 * `['task', id]` is the open panel, `['tasks']` the prefix every task list, count and active strip
 * in the app reads under. `['project', projectId]` is a PREFIX of the project page's own keys, so
 * that one entry covers the project document, its root task page and every opened subtask level —
 * which is what keeps a Project row from going on showing a start that is gone.
 *
 * Deliberately no `['projects']`: the list rows carry a task COUNT, and neither running a task nor
 * rescheduling one moves a count. And nothing at all for a task that belongs to no project, so a
 * reader with a project page open in another tab does not have it refetched because of a task it
 * never contained.
 *
 * Every task in the set gets its OWN `['task', id]`, since each one really did change. What is
 * deduplicated is the rest: `['tasks']` is invalidated exactly once however many tasks were given,
 * and each project once however many of its rows were in the set. So a batch of forty rows sharing
 * two projects is 43 invalidations — forty details, one `['tasks']`, two projects — rather than the
 * 120 that calling the single-task form per row would fire, where 77 of them would be redundant
 * refetches of views already being refetched by the call before.
 *
 * An EMPTY set refreshes nothing, not even `['tasks']` — the caller with no tasks to report is one
 * whose write moved nothing, and a refetch on its behalf would redraw rows that never changed.
 *
 * One function rather than a list at each call site, because the panel's Run now, the row's Run
 * and the bulk Run all spend a schedule just as surely as cancelling one does, and they must not
 * drift into refreshing different things. Exported for the same reason
 * `invalidateAfterProjectTaskCreate` is: what a write refreshes has to be assertable against a
 * seeded cache, since the buttons that trigger it are behind a mutation.
 *
 * Returns the refetches rather than firing and forgetting them, and every caller returns it from
 * its `onSuccess` — which is what keeps a mutation PENDING until the views have actually caught
 * up. Dropped on the floor instead, the button leaves its loading state the instant the server
 * answers and before a single query has refetched, so for that window it is enabled and showing
 * the schedule the write just replaced: an invitation to send the same request twice.
 */
export function refreshManyTaskScheduleViews(
  qc: QueryClient,
  tasks: readonly TaskRefreshTarget[],
): Promise<void> {
  const taskIds = new Set(tasks.map((t) => t.id));
  // Nothing at all for a task filed under no project, rather than an invalidation that matches
  // nothing: an `undefined` in the key would make this a prefix of EVERY project's cache.
  const projectIds = new Set(tasks.map((t) => t.projectId).filter((id): id is string => !!id));
  if (taskIds.size === 0) return Promise.resolve();
  return Promise.all([
    ...[...taskIds].map((id) => qc.invalidateQueries({ queryKey: ['task', id] })),
    qc.invalidateQueries({ queryKey: ['tasks'] }),
    ...[...projectIds].map((id) => qc.invalidateQueries({ queryKey: ['project', id] })),
  ]).then(() => undefined);
}

/**
 * The same refresh for a single task — the shape the panel's schedule editor and its Run now have
 * always called, kept so those call sites read as the one-task statements they are.
 */
export function refreshTaskScheduleViews(
  qc: QueryClient,
  taskId: string,
  projectId?: string | null,
): Promise<void> {
  return refreshManyTaskScheduleViews(qc, [{ id: taskId, projectId }]);
}
