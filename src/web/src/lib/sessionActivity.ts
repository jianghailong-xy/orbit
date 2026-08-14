/** The small slice of a session row/detail needed to decide whether work is still happening
 * after the parent turn has parked. Both counters are server-maintained and may be absent when
 * talking to an older control plane. */
export interface SessionActivity {
  runningSubagentCount?: number | null;
  runningBgCount?: number | null;
}

/** A parent turn may be AWAITING_INPUT while async sub-workspaces or background shells keep working.
 * Drives the status label/glyph, so a parked-but-still-working session never reads as "waiting
 * for your reply" — and so the two kinds don't read the same. A sub-workspace is the workspace itself
 * still working; a background shell usually isn't (workspaces leave dev servers and watchers up),
 * so only the former earns the working spinner. Sub-workspace wins when both are live. */
export type OutlivingWork = 'subagent' | 'background';
export const outlivingSessionWork = (
  session: SessionActivity | null | undefined,
): OutlivingWork | null => {
  if ((session?.runningSubagentCount ?? 0) > 0) return 'subagent';
  return (session?.runningBgCount ?? 0) > 0 ? 'background' : null;
};

/** Whether the selected session's worktree is currently transient — i.e. something is still
 * *writing* to it. That's the parent turn (`idle` tracks its boundary) plus async sub-workspaces,
 * which edit files exactly like the parent does.
 *
 * Background shells deliberately don't count, even though they're outliving work for status
 * purposes. Workspaces routinely leave long-lived processes up — a `vite` dev server for visual
 * verification, a watcher, a tail — and those never exit, so their launch id never leaves
 * `runningBgShells` and the worktree gate stayed on *forever*, permanently disabling Commit for
 * that session. The failure modes aren't symmetric: a wrongly-blocked commit is unrecoverable
 * from the UI, while a commit that races a background writer is one more commit away from being
 * right — and the user clicking Commit can see the "Background process running" status. */
export const isSessionTurnActive = (
  session: SessionActivity | null | undefined,
  live: boolean,
  idle: boolean,
): boolean => live && (!idle || (session?.runningSubagentCount ?? 0) > 0);
