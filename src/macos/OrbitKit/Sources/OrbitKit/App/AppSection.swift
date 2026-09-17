import Foundation

/// Top-level navigation sections, mirroring the web AppShell nav. Pure data — titles and SF
/// Symbol names are just strings — so it lives in OrbitKit and is unit-tested; the SwiftUI
/// sidebar renders `visible(isAdmin:)`. Admin is role-gated like the web's route guard.
public enum AppSection: String, CaseIterable, Sendable, Identifiable {
    case tasks, following, agents, skills, runners, settings, admin

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .tasks:    return "Tasks"
        case .following: return "Following"
        case .agents:   return "Workspaces"
        case .skills:   return "Skills"
        case .runners:  return "Runners"
        case .settings: return "Settings"
        case .admin:    return "Admin"
        }
    }

    /// SF Symbol for the sidebar row.
    public var systemImage: String {
        switch self {
        case .tasks:    return "checklist"
        case .following: return "eye"
        case .agents:   return "person.2"
        case .skills:   return "wand.and.stars"
        case .runners:  return "desktopcomputer"
        case .settings: return "gearshape"
        case .admin:    return "lock.shield"
        }
    }

    /// Admin-area sections are hidden from non-admins (mirrors the web route guard).
    public var adminOnly: Bool { self == .admin }

    /// Sections to show in the nav, in display order. Runners leads; Skills is intentionally omitted
    /// (its detail view still exists but is no longer a top-level destination).
    ///
    /// The last two rows are the conditional ones, so that a row appearing or going never shifts a
    /// row a reader navigates by position. Admin is gated by role. Following is gated by whether any
    /// watch needs a person (`WatchProjection.needsAttentionCount`): nearly every watch is one session
    /// waiting on the server for another, which the session's own header and row already say, and a
    /// permanent row could not tell a reader whether it held anything worth opening. The Following
    /// destination itself stays reachable either way — a watch notification deep-links into it
    /// (``forRoute(_:)``), and a session's watches are read where they belong, on the session.
    public static func visible(isAdmin: Bool, followingNeedsAttention: Bool) -> [AppSection] {
        let order: [AppSection] = [.runners, .agents, .tasks, .settings, .following, .admin]
        return order.filter { section in
            if section.adminOnly { return isAdmin }
            if section == .following { return followingNeedsAttention }
            return true
        }
    }

    /// Destinations shown below the regular-width iPad sidebar's first-class Workspace group.
    /// Keep this derived from ``visible(isAdmin:followingNeedsAttention:)`` so role gating, the
    /// Following condition and the cross-client navigation order stay authoritative in one place
    /// while the iPad renderer supplies the group boundary.
    public static func managementSections(isAdmin: Bool, followingNeedsAttention: Bool) -> [AppSection] {
        visible(isAdmin: isAdmin, followingNeedsAttention: followingNeedsAttention).filter { $0 != .agents }
    }

    /// The section a deep-link / notification `Route` lands in. There's no aggregate Open view
    /// anymore, so "home" (`.active`) and an individual `.session` both land in Agents — the
    /// session's owning agent is resolved when routing (see `AppModel.route`).
    public static func forRoute(_ route: Route) -> AppSection {
        switch route {
        case .active, .session: return .agents
        case .task:             return .tasks
        case .runner:           return .runners
        case .watch:            return .following
        }
    }
}
