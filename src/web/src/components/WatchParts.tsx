import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../api';
import { sessionQuery, taskRowQuery } from '../lib/queries';
import { taskOutcomeChip, type OutcomeChip } from '../lib/taskOutcome';
import { linkId, targetHref, watchStateCopy } from '../lib/watches';

/** A clock for the relative times on a watch ("checked 12s ago") that keeps them moving on screen. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function WatchStatePill({ state }: { state: string }) {
  const copy = watchStateCopy(state);
  return <span className={`watch-state tone-${copy.tone}`}>{copy.label}</span>;
}

/**
 * A watch target's name and live status, read from the target itself: the session's detail (the entry
 * the console already caches) or the task's list row. Both arguments may be null, which disables the
 * reads — the strip calls it unconditionally, and a row that already carries its target's name (every
 * watch does since `targetTitle`) asks only for the status beside it.
 *
 * `missing` is a 404 and nothing else: that answer means the row is not there, while a refused or
 * failed read says only that this client could not have it — a target whose owner changed reads back
 * 404 on the list row too, so no client may call any of them deleted on the strength of an error. What
 * a watch knows about that is its target's own `state` (contract §4: a deleted target is recorded
 * GONE), which is what `WatchTargetLink` says "Deleted" from.
 */
export function useTargetName(
  kind: string | null,
  id: string | null,
): { name: string | null; status: string | null; chip: OutcomeChip | null; missing: boolean } {
  const session = useQuery({
    ...sessionQuery(kind === 'SESSION' ? id : null),
    retry: false,
    staleTime: 30_000,
  });
  const task = useQuery({ ...taskRowQuery(id ?? ''), enabled: kind === 'TASK', retry: false });
  if (kind === 'SESSION') {
    return {
      name: session.data?.title ?? null,
      status: session.data?.runState ?? session.data?.status ?? null,
      chip: null,
      missing: notFound(session.error),
    };
  }
  return {
    name: task.data?.title ?? null,
    status: task.data?.status ?? null,
    // The list row's own chip, so one task reads the same word and colour wherever it is shown.
    // `terminalReason` rides along in the same row, so a replaced attempt says Superseded here too.
    chip: task.data?.status ? taskOutcomeChip(task.data) : null,
    missing: notFound(task.error),
  };
}

/** Whether a read failed because the row is not there — the one failure that says anything about it. */
const notFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

const TARGET_NOUN: Record<string, string> = { SESSION: 'Session', TASK: 'Task' };
const TARGET_STATE_WORD: Record<string, string> = {
  SATISFIED: 'met',
  OBSERVED: 'waiting',
  GONE: 'deleted',
};

/**
 * One target by name, linked to its own page, with one word after it.
 *
 * The name comes with the watch (`targetTitle`, read under the same account as the watch itself), so a
 * card names what it watches from the read that drew it rather than a request of its own — a page of
 * watches over hundreds of targets used to ask for a row each, and the names that arrived late, or
 * never, left a truncated id where a title belongs. Without one the id is what there is to show, and
 * only a target the watch itself records as GONE is called deleted: a row this account cannot read is
 * not a row that is gone (contract §4, and `useTargetName`'s note above).
 *
 * Which word after it, when `showsStatus` is set: the target's own status rather than what the watch
 * last recorded about it. Two words would need a rule — `met` is the watch's verdict and `Done` is the
 * task's state, and a reader asked to hold both has to be told which governs — so the row carries
 * the one a reader came for and `met` is said once, in the Progress row above. A session target
 * has no chip and keeps the recorded word.
 */
export function WatchTargetLink({
  kind,
  id,
  title,
  state,
  showsStatus = false,
}: {
  kind: string;
  id: string;
  title?: string | null;
  state?: string;
  showsStatus?: boolean;
}) {
  // Only the rows that show a status ask for one: the name is already here.
  const { chip } = useTargetName(showsStatus ? kind : null, showsStatus ? id : null);
  const noun = TARGET_NOUN[kind] ?? kind;
  const shown = linkId(id);
  const status = showsStatus ? chip : null;
  return (
    <Link
      className={`watch-target${state ? ` is-${state.toLowerCase()}` : ''}`}
      to={targetHref(kind, id)}
      title={`${noun} ${shown}`}
    >
      <span className="watch-target-kind">{noun}</span>
      <span className="watch-target-name">
        {state === 'GONE' ? `Deleted ${noun.toLowerCase()}` : (title ?? `${shown.slice(0, 8)}…`)}
      </span>
      {status ? (
        <span className={`watch-target-status tone-${status.tone}`}>{status.label}</span>
      ) : (
        state && (
          <span className="watch-target-state">{TARGET_STATE_WORD[state] ?? state.toLowerCase()}</span>
        )
      )}
    </Link>
  );
}

/** The session a RESUME_SESSION watch wakes, by name. */
export function ObserverLink({ sessionId }: { sessionId: string }) {
  const { name, missing } = useTargetName('SESSION', sessionId);
  return (
    <Link className="watch-observer" to={targetHref('SESSION', sessionId)}>
      {name ?? (missing ? 'a deleted session' : 'the waiting session')}
    </Link>
  );
}
