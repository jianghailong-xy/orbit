import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
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
 * A watch target's name and live status. A watch row carries ids only, so both are read from the
 * target itself: the session's detail (the entry the console already caches) or the task's list row.
 * A target that no longer reads back is reported missing rather than retried. Both arguments may be
 * null, which disables the reads — the strip calls it unconditionally and only names a target when
 * its line has one to name.
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
      missing: session.isError,
    };
  }
  return {
    name: task.data?.title ?? null,
    status: task.data?.status ?? null,
    // The list row's own chip, so one task reads the same word and colour wherever it is shown.
    // `terminalReason` rides along in the same row, so a replaced attempt says Superseded here too.
    chip: task.data?.status ? taskOutcomeChip(task.data) : null,
    missing: task.isError,
  };
}

const TARGET_NOUN: Record<string, string> = { SESSION: 'Session', TASK: 'Task' };
const TARGET_STATE_WORD: Record<string, string> = {
  SATISFIED: 'met',
  OBSERVED: 'waiting',
  GONE: 'deleted',
};

/**
 * One target by name, linked to its own page, with one word after it.
 *
 * Which word, when `showsStatus` is set: the target's own status rather than what the watch last
 * recorded about it. Two words would need a rule — `met` is the watch's verdict and `Done` is the
 * task's state, and a reader asked to hold both has to be told which governs — so the row carries
 * the one a reader came for and `met` is said once, in the Progress row above. A session target
 * has no chip and keeps the recorded word.
 */
export function WatchTargetLink({
  kind,
  id,
  state,
  showsStatus = false,
}: {
  kind: string;
  id: string;
  state?: string;
  showsStatus?: boolean;
}) {
  const { name, chip, missing } = useTargetName(kind, id);
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
        {name ?? (missing ? `Deleted ${noun.toLowerCase()}` : `${shown.slice(0, 8)}…`)}
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
