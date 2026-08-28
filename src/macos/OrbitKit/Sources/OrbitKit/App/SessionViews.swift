import Foundation

/// The lifecycle views a session list filters to (the `?view=` query param). Lifecycle is independent
/// from execution state: Open may contain succeeded sessions and Completed may contain failures.
public enum SessionView: String, CaseIterable, Sendable, Identifiable {
    case open, completed, trash
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .open:      return "Open"
        case .completed: return "Completed"
        case .trash:     return "Trash"
        }
    }
    /// The canonical value sent to `GET /sessions?view=`. ``APIClient`` transparently retries the
    /// legacy transport spelling when talking to a pre-Completed control plane.
    public var queryValue: String {
        switch self {
        case .open:      return "open"
        case .completed: return "completed"
        case .trash:     return "trash"
        }
    }

    var lifecycleState: SessionLifecycleState {
        switch self {
        case .open:      return .open
        case .completed: return .completed
        case .trash:     return .trash
        }
    }

    /// Pre-Completed query spelling, confined to the transport compatibility layer.
    var legacyQueryValue: String {
        switch self {
        case .open:      return "active"
        case .completed: return "archived"
        case .trash:     return "deleted"
        }
    }

    /// The cases offered in the console's switcher, in lifecycle order.
    public static let pickerCases: [SessionView] = [.open, .completed, .trash]
}

/// Shared product wording for the session completion operation.
public enum SessionCompletionPresentation {
    public static let actionTitle = "Complete"
}

/// One width policy for the iOS session column. `nil` size classes reach the regular shell because
/// `OrbitiOSApp.RootView` switches to the compact shell only for an explicit `.compact`; callers map
/// that same fact to `isCompactWidth` so the row density and lifecycle control never disagree.
public enum SessionListPresentation: Equatable, Sendable {
    case compact
    case regular

    public static func resolve(isCompactWidth: Bool) -> SessionListPresentation {
        isCompactWidth ? .compact : .regular
    }

    public var showsPersistentScope: Bool { self == .regular }
}

/// The relative timestamp at the trailing edge of a compact session-list row. While the row's
/// live cue is a spinner, the cue already says the session is active and its continuously fresh
/// `lastTurnAt` would only add a row of identical "just now" labels beside the spinners.
public enum SessionListTime {
    public static func format(for session: Session, now: Date = Date()) -> String? {
        if case .spinner = SessionStatusGlyph.make(for: session, now: now).shape { return nil }
        guard let timestamp = session.lastTurnAt ?? session.createdAt else { return nil }
        return RelativeTime.format(timestamp, now: now)
    }
}

public enum SessionFilter {
    /// Remove an authoritatively missing record from a loaded list. Idempotent so duplicate 404s
    /// from a control nudge and focused-detail poll cannot resurrect or otherwise disturb rows.
    public static func removing(_ id: String, from sessions: [Session]) -> [Session] {
        sessions.filter { $0.id != id }
    }

    /// Sessions belonging to one agent. The list payload nests the agent as `agent.id` (the flat
    /// `agentId` is absent there), so that's the primary key; the flat field is the fallback because
    /// `POST /sessions` answers with the reverse shape — a flat `agentId`, no nested agent — and that
    /// record is registered straight into the loaded lists, where it would otherwise match no agent
    /// and vanish from the list that just created it. Both are the same id (see `AppModel.agentID`).
    /// Server order (lastTurnAt desc) is preserved.
    public static func forAgent(_ sessions: [Session], agentID: String) -> [Session] {
        sessions.filter { ($0.agent?.id ?? $0.agentId) == agentID }
    }

    /// Keep only sessions carrying the given tag — the list's tag filter chip. Order is preserved,
    /// so the result stays console-sorted (pinned-first, then recency).
    public static func withTag(_ sessions: [Session], tagID: String) -> [Session] {
        sessions.filter { ($0.tags ?? []).contains { $0.id == tagID } }
    }

    /// Sessions belonging to one agent, scoped for a specific Agent-console tab — mirrors the web
    /// Agent console. Every non-completed session returned by the Open query stays visible there;
    /// there is no separate System list.
    ///
    /// The activity-ordered views (Open/Trash) are re-sorted client-side to match web's Agent
    /// console exactly — the server orders never-run (queued) sessions last (`last_turn_at DESC
    /// NULLS LAST`), but web ranks them by `createdAt` instead, so a freshly queued session sits
    /// among recent activity rather than pinned to the bottom. Completed is the one
    /// exception: the server orders it by completion time (newest completed first) and deliberately
    /// ignores pinning, and that timestamp isn't in the list payload, so the client can't reproduce
    /// it — the server order is preserved verbatim, exactly as web's AgentView does
    /// (`if view === 'completed' return rows`). Without these two rules the clients disagree on order.
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
