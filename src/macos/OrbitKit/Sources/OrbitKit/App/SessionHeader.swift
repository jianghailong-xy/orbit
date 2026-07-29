import Foundation

/// The session console's header text — a 1:1 port of the web Agent console header (`AgentView.tsx`):
/// the session's title over a "state · when" subtitle ("Running · 3m ago"). Kept in OrbitKit so
/// macOS + iOS share the exact web wording and it's unit-tested. `statusWord` mirrors web's
/// `statusLabel` (its wording agrees with `SessionStatusGlyph`'s tooltip but stays terse for the
/// subtitle); the time half reuses `RelativeTime`.
public enum SessionHeader {
    /// The header title: the session's own title, else its agent's name, else a neutral default —
    /// mirroring web's `selected?.title ?? headAgentName`.
    public static func title(for session: Session?, fallbackAgent: String?) -> String {
        if let t = session?.title, !t.isEmpty { return t }
        if let a = fallbackAgent, !a.isEmpty { return a }
        return "Session"
    }

    /// The short state word — a port of web `statusLabel`. Uses only the fields the session-list
    /// payload carries on the clients (no `runningSubagentCount`), matching `SessionStatusGlyph`.
    public static func statusWord(for s: Session) -> String {
        switch s.status {
        case .running:
            return (s.pendingApprovals ?? 0) > 0 ? "Waiting for approval" : "Running"
        case .awaitingInput:
            if (s.runningBgCount ?? 0) > 0 { return SessionLine.bgRunningLabel(s.runningBgCount ?? 0) }
            return "Waiting for your reply"
        case .succeeded:
            return "Completed"
        case .failed:
            return (s.error ?? "").lowercased().contains("offline") ? "Disconnected" : "Failed"
        case .cancelled, .interrupted:
            let reason = s.endReason ?? ""
            let terminal =
                reason == "orphaned" || reason == "deleted" || reason == "completed" ||
                reason == "cancelled" || (s.status == .interrupted && reason.isEmpty)
            if !terminal { return "Dormant" }
            return reason == "orphaned" ? "Ended"
                 : s.status == .interrupted ? "Interrupted"
                 : "Cancelled"
        case .pending:
            return "Queued"
        }
    }

    /// The full "state · when" subtitle, mirroring web's `${statusLabel(selected)} · ${headTime}`
    /// where `headTime = fmtTime(lastTurnAt ?? startedAt ?? createdAt)` (the clients' `Session` has
    /// no `startedAt`, so `lastTurnAt ?? createdAt`). `now` is injectable for deterministic tests.
    /// Returns nil when there's no session to describe (a fresh deep link) so the caller can fall
    /// back to the live stream's status.
    public static func subtitle(for session: Session?, now: Date = Date()) -> String? {
        guard let s = session else { return nil }
        let word = statusWord(for: s)
        if let ts = s.lastTurnAt ?? s.createdAt, let rel = RelativeTime.format(ts, now: now) {
            return "\(word) · \(rel)"
        }
        return word
    }
}
