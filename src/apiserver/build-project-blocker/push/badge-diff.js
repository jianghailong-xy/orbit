"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.badgeDiff = badgeDiff;
/** Diff freshly-computed "needs you" session ids against the last state pushed to an owner.
 *  Pure, so the edge cases (a session with several approvals counted once, a session dying with an
 *  orphan approval, no-op status churn, a net-zero swap) are unit-testable without Prisma or APNs.
 *  See docs/cross-platform-badge-sync.md. */
function badgeDiff(prev, currentIds) {
    const sessions = new Set(currentIds);
    const badge = sessions.size;
    const prevSessions = prev?.sessions ?? new Set();
    const clearSessions = [...prevSessions].filter((id) => !sessions.has(id));
    // No prior state is an implied badge of 0 — so a status event for an owner with nothing pending
    // (the common case) computes 0 → 0 and pushes nothing, instead of a spurious silent badge=0.
    const changed = (prev?.badge ?? 0) !== badge || clearSessions.length > 0;
    return { badge, sessions, clearSessions, changed };
}
//# sourceMappingURL=badge-diff.js.map