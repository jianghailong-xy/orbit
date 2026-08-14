import Foundation

/// The session console's header text — a 1:1 port of the web Agent console header (`AgentView.tsx`):
/// the session's title over a "run state · lifecycle · when" subtitle
/// ("Running · Open · 3m ago"). Kept in OrbitKit so
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

    /// The short execution-state word. Lifecycle location is deliberately not consulted: a succeeded
    /// session remains "Succeeded" in Open, Completed and Trash alike. The DTO resolves old servers.
    public static func statusWord(for s: Session, now: Date = Date()) -> String {
        switch s.effectiveRunState {
        case .queued:
            return "Queued"
        case .running:
            return (s.pendingApprovals ?? 0) > 0 ? "Waiting for approval" : "Running"
        case .awaitingInput:
            // A turn the runtime started for itself keeps the run state parked for its whole
            // duration, so the parked branch is where it has to be caught (see `isGenerating`).
            if s.isGenerating {
                return (s.pendingApprovals ?? 0) > 0 ? "Waiting for approval" : "Running"
            }
            if (s.runningBgCount ?? 0) > 0 { return SessionLine.bgRunningLabel(s.runningBgCount ?? 0) }
            return "Waiting for your reply"
        case .succeeded:
            return "Succeeded"
        case .failed:
            // Not "Failed" while the server is still going to re-send it — see `retryPending`.
            if s.retryPending(now: now) { return "Retrying" }
            return (s.error ?? "").lowercased().contains("offline") ? "Disconnected" : "Failed"
        case .interrupted:
            return "Interrupted"
        case .ended, .unknown:
            return "Ended"
        }
    }

    /// The full "run state · lifecycle · when" subtitle. Keeping both dimensions visible prevents
    /// "Succeeded" from being mistaken for Completed. `now` is injectable for deterministic tests.
    /// Returns nil when there's no session to describe (a fresh deep link) so the caller can fall
    /// back to the live stream's status.
    public static func subtitle(for session: Session?, now: Date = Date()) -> String? {
        guard let s = session else { return nil }
        let word = statusWord(for: s, now: now)
        let lifecycle = lifecycleWord(for: s)
        // The two axes no longer share any vocabulary — a filed session reads "Ended · Completed",
        // which is exactly the split this subtitle exists to show — so there is nothing to collapse.
        let head = "\(word) · \(lifecycle)"
        if let ts = s.lastTurnAt ?? s.createdAt, let rel = RelativeTime.format(ts, now: now) {
            return "\(head) · \(rel)"
        }
        return head
    }

    public static func lifecycleWord(for s: Session) -> String {
        switch s.effectiveLifecycleState {
        case .open, .unknown: return "Open"
        case .completed: return "Completed"
        case .trash: return "Trash"
        }
    }
}
