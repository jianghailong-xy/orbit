import Foundation

/// The lifecycle views a session list filters to (the `?view=` query param), mirroring the web
/// Agent console's switcher. "Completed" is the server's `archived` view.
public enum SessionView: String, CaseIterable, Sendable, Identifiable {
    case active, completed, trash
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .active:    return "Active"
        case .completed: return "Completed"
        case .trash:     return "Trash"
        }
    }
    /// The value sent to `GET /sessions?view=` (completed maps to the server's "archived", trash to
    /// "deleted").
    public var queryValue: String {
        switch self {
        case .active:    return "active"
        case .completed: return "archived"
        case .trash:     return "deleted"
        }
    }

    /// The cases offered in the console's switcher, in the web Agent console's order: Active,
    /// Completed (archived), and Trash (soft-deleted, restorable until the server purges them).
    public static let pickerCases: [SessionView] = [.active, .completed, .trash]
}

public enum SessionFilter {
    /// Sessions belonging to one agent. The list payload nests the agent as `agent.id` (the flat
    /// `agentId` is absent there), so filter on that. Server order (lastTurnAt desc) is preserved.
    public static func forAgent(_ sessions: [Session], agentID: String) -> [Session] {
        sessions.filter { $0.agent?.id == agentID }
    }

    /// Keep only sessions carrying the given tag — the list's tag filter chip. Order is preserved,
    /// so the result stays console-sorted (pinned-first, then recency).
    public static func withTag(_ sessions: [Session], tagID: String) -> [Session] {
        sessions.filter { ($0.tags ?? []).contains { $0.id == tagID } }
    }

    /// Sessions belonging to one agent, scoped for a specific Agent-console tab — mirrors the web
    /// Agent console. Every non-archived session returned by the active query stays visible there;
    /// there is no separate System list.
    ///
    /// The activity-ordered views (Active/Trash) are re-sorted client-side to match web's Agent
    /// console exactly — the server orders never-run (queued) sessions last (`last_turn_at DESC
    /// NULLS LAST`), but web ranks them by `createdAt` instead, so a freshly queued session sits
    /// among recent activity rather than pinned to the bottom. Completed (archived) is the one
    /// exception: the server orders it by `archived_at` (newest filed first) and deliberately
    /// ignores pinning, and that timestamp isn't in the list payload, so the client can't reproduce
    /// it — the server order is preserved verbatim, exactly as web's AgentView does
    /// (`if view === 'archived' return rows`). Without these two rules the clients disagree on order.
    public static func forAgent(_ sessions: [Session], agentID: String, view: SessionView) -> [Session] {
        let scoped = forAgent(sessions, agentID: agentID)
        return view == .completed ? scoped : consoleSorted(scoped)
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
