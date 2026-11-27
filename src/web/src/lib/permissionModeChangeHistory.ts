import { useEffect, useState } from 'react';
import type { SessionPermissionModeChange } from '@orbit/shared';
import { getSessionPermissionModeChanges } from '../api';

/**
 * EVERY MODE CHANGE A TRANSCRIPT HAS LOADED, NOT ONLY THE NEWEST FIFTY
 * ==================================================================
 * The session detail carries the newest SESSION_PERMISSION_MODE_CHANGES_LIMIT changes and says whether older ones are
 * recorded (`permissionModeChangesHasMore`). As the transcript pages back, the changes it reaches are read too
 * (GET /sessions/:id/permission-mode-changes?before=<seq>), until the oldest change held is older than the oldest event
 * loaded, or, once the transcript reaches the session's start, until none are left. Each change is held once, by its
 * `seq`, in the order it was recorded: two can share a time, never a seq.
 *
 * What is held outlives the detail's next read: a change that falls out of the newest fifty stays. When a read of the
 * detail no longer reaches what is held (more than a page recorded since the last), what is held is dropped and read
 * back from the detail, so no change in between is missed.
 */

export interface ModeChangeHistory {
  sessionId: string | null;
  /** Oldest first, each once. */
  changes: SessionPermissionModeChange[];
  /** Whether older changes than `changes[0]` are recorded. */
  hasMore: boolean;
}

const NONE: ModeChangeHistory = { sessionId: null, changes: [], hasMore: false };

/** `older` then `newer`, each change once by its seq, in seq order. */
function joined(older: readonly SessionPermissionModeChange[], newer: readonly SessionPermissionModeChange[]): SessionPermissionModeChange[] {
  const bySeq = new Map<number, SessionPermissionModeChange>();
  for (const change of [...older, ...newer]) bySeq.set(change.seq!, change);
  return [...bySeq.values()].sort((a, b) => a.seq! - b.seq!);
}

/**
 * What is held once the detail's read of the session is taken in. The same object when it adds nothing, so a render
 * can call it with what it holds and keep that. A change with no seq (a server older than migration 1780, which pages
 * none) is held as the detail says, alone.
 */
export function adoptDetailChanges(
  held: ModeChangeHistory,
  sessionId: string | null,
  detail: readonly SessionPermissionModeChange[] | undefined,
  detailHasMore: boolean | undefined,
): ModeChangeHistory {
  if (!sessionId || !detail) {
    return held.sessionId === sessionId && held.changes.length === 0 && !held.hasMore ? held : { ...NONE, sessionId };
  }
  if (detail.some((c) => c.seq === undefined)) {
    return held.sessionId === sessionId && held.changes === detail ? held : { sessionId, changes: detail as SessionPermissionModeChange[], hasMore: false };
  }
  const hasMore = detailHasMore === true;
  if (held.sessionId !== sessionId || held.changes.length === 0) {
    if (held.sessionId === sessionId && detail.length === 0 && held.hasMore === hasMore) return held;
    return { sessionId, changes: [...detail], hasMore };
  }
  if (detail.length === 0) return held;
  const known = new Set(held.changes.map((c) => c.seq));
  // A detail that does not reach what is held, with older changes behind it: start again from it.
  if (hasMore && !known.has(detail[0].seq)) return { sessionId, changes: [...detail], hasMore };
  if (detail.every((c) => known.has(c.seq)) && (hasMore || !held.hasMore)) return held;
  return { sessionId, changes: joined(held.changes, detail), hasMore: hasMore && held.hasMore };
}

/** Whether a page older than what is held should be read for a transcript whose oldest loaded event is `oldestEventTs`
 *  (none loaded yet: not yet), and which reaches the session's start when `reachesStart`. */
export function needsOlderModeChanges(held: ModeChangeHistory, oldestEventTs: string | undefined, reachesStart: boolean): boolean {
  const oldest = held.changes[0];
  if (!held.hasMore || oldest?.seq === undefined || oldestEventTs === undefined) return false;
  if (reachesStart) return true;
  // A change at the same moment as the oldest event may still have older ones beside it.
  return !(Date.parse(oldest.at) < Date.parse(oldestEventTs));
}

/**
 * The session's mode changes as far back as its transcript is loaded: the detail's newest, and the older pages read as
 * the transcript pages back. Undefined while the detail carries none (an older server, or not read yet).
 */
export function usePermissionModeChangeHistory(
  sessionId: string | null,
  detail: { permissionModeChanges?: SessionPermissionModeChange[]; permissionModeChangesHasMore?: boolean } | null | undefined,
  transcript: { oldestEventTs: string | undefined; reachesStart: boolean },
): SessionPermissionModeChange[] | undefined {
  const [held, setHeld] = useState<ModeChangeHistory>(NONE);
  const detailChanges = detail?.permissionModeChanges;
  const adopted = adoptDetailChanges(held, sessionId, detailChanges, detail?.permissionModeChangesHasMore);
  // Taken in during render, as React keeps state derived from props: the render it causes is the one committed.
  if (adopted !== held) setHeld(adopted);

  const need = needsOlderModeChanges(adopted, transcript.oldestEventTs, transcript.reachesStart);
  const before = adopted.changes[0]?.seq;
  useEffect(() => {
    if (!need || !sessionId || before === undefined) return;
    const controller = new AbortController();
    getSessionPermissionModeChanges(sessionId, { before, signal: controller.signal })
      .then((page) => {
        setHeld((current) =>
          // Only onto what it was read for: a session switched away from, or a detail that started again, is not it.
          current.sessionId === sessionId && current.changes[0]?.seq === before
            ? { sessionId, changes: joined(page.changes, current.changes), hasMore: page.hasMore }
            : current,
        );
      })
      // Silent: the next page the transcript loads asks again.
      .catch(() => undefined);
    return () => controller.abort();
  }, [need, sessionId, before, transcript.oldestEventTs]);

  return detailChanges ? adopted.changes : undefined;
}
