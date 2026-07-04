import Foundation

/// The lifecycle views a session list filters to (the `?view=` query param), mirroring the web
/// Agent console's segmented switcher. "Completed" is the server's `archived` view; "System" is
/// auto-created (source=system, e.g. task-execution) sessions.
public enum SessionView: String, CaseIterable, Sendable, Identifiable {
    case active, completed, system
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .active:    return "Active"
        case .completed: return "Completed"
        case .system:    return "System"
        }
    }
    /// The value sent to `GET /sessions?view=` (completed maps to the server's "archived").
    public var queryValue: String {
        switch self {
        case .active:    return "active"
        case .completed: return "archived"
        case .system:    return "system"
        }
    }
}

public enum SessionFilter {
    /// Sessions belonging to one agent. The list payload nests the agent as `agent.id` (the flat
    /// `agentId` is absent there), so filter on that. Server order (lastTurnAt desc) is preserved.
    public static func forAgent(_ sessions: [Session], agentID: String) -> [Session] {
        sessions.filter { $0.agent?.id == agentID }
    }

    /// Sessions belonging to one agent, scoped for a specific Agent-console tab — mirrors the web
    /// Agent console. The `active` query returns auto-created (`source == "system"`) sessions for
    /// slot accounting and deep-link resolution, but they get their own System tab, so they're
    /// hidden from the Active list. Completed/System views keep what the server returned (the
    /// System query is already `source == "system"` server-side).
    ///
    /// The result is re-sorted client-side to match web's Agent console exactly — the server orders
    /// never-run (queued) sessions last (`last_turn_at DESC NULLS LAST`), but web ranks them by
    /// `createdAt` instead, so a freshly queued session sits among recent activity rather than
    /// pinned to the bottom. Without this pass the two clients disagree on queued-session order.
    public static func forAgent(_ sessions: [Session], agentID: String, view: SessionView) -> [Session] {
        let scoped = forAgent(sessions, agentID: agentID)
        let visible = view == .active ? scoped.filter { $0.source != "system" } : scoped
        return consoleSorted(visible)
    }

    /// Order a per-agent console list as web's `AgentView` does: pinned sessions first, then
    /// most-recent activity first (`lastTurnAt`, falling back to `createdAt`). ISO-8601 timestamps
    /// compare correctly as strings, matching web's `a.lastTurnAt ?? a.createdAt` comparison.
    static func consoleSorted(_ sessions: [Session]) -> [Session] {
        sessions.sorted { a, b in
            if (a.pinnedAt != nil) != (b.pinnedAt != nil) { return a.pinnedAt != nil }
            let ta = a.lastTurnAt ?? a.createdAt ?? ""
            let tb = b.lastTurnAt ?? b.createdAt ?? ""
            return ta > tb
        }
    }
}
