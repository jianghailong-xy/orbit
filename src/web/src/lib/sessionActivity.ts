/** The small slice of a session row/detail needed to decide whether work is still happening
 * after the parent turn has parked. Both counters are server-maintained and may be absent when
 * talking to an older control plane. */
export interface SessionActivity {
  runningSubagentCount?: number | null;
  runningBgCount?: number | null;
}

/** A parent turn may be AWAITING_INPUT while async sub-agents or background shells keep working.
 * Treat that outliving work as active everywhere that guards a mutable worktree snapshot. */
export const hasOutlivingSessionWork = (session: SessionActivity | null | undefined): boolean =>
  (session?.runningSubagentCount ?? 0) > 0 || (session?.runningBgCount ?? 0) > 0;

/** Whether the selected session's worktree is currently transient. `idle` tracks the parent turn
 * boundary; the server counters cover work that legitimately outlives that boundary. */
export const isSessionTurnActive = (
  session: SessionActivity | null | undefined,
  live: boolean,
  idle: boolean,
): boolean => live && (!idle || hasOutlivingSessionWork(session));
