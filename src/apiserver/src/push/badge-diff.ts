/** Per-owner "needs you" badge state = the count plus which sessions it covers, so a later
 *  recompute can tell which sessions dropped out and clear their delivered banners. */
export interface BadgeState {
  badge: number;
  sessions: Set<string>;
}

export interface BadgeDelta {
  badge: number;
  sessions: Set<string>;
  /** Sessions that were needing a reply but no longer are — their banners should be cleared. */
  clearSessions: string[];
  /** Whether anything changed vs. `prev` (the count moved, or a session dropped out). */
  changed: boolean;
}

/** Diff freshly-computed "needs you" session ids against the last state pushed to an owner.
 *  Pure, so the edge cases (a session with several approvals counted once, a session dying with an
 *  orphan approval, no-op status churn, a net-zero swap) are unit-testable without Prisma or APNs.
 *  See docs/cross-platform-badge-sync.md. */
export function badgeDiff(prev: BadgeState | undefined, currentIds: string[]): BadgeDelta {
  const sessions = new Set(currentIds);
  const badge = sessions.size;
  const prevSessions = prev?.sessions ?? new Set<string>();
  const clearSessions = [...prevSessions].filter((id) => !sessions.has(id));
  // No prior state is an implied badge of 0 — so a status event for an owner with nothing pending
  // (the common case) computes 0 → 0 and pushes nothing, instead of a spurious silent badge=0.
  const changed = (prev?.badge ?? 0) !== badge || clearSessions.length > 0;
  return { badge, sessions, clearSessions, changed };
}
