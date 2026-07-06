import Foundation

/// Top-level navigation sections, mirroring the web AppShell nav. Pure data — titles and SF
/// Symbol names are just strings — so it lives in OrbitKit and is unit-tested; the SwiftUI
/// sidebar renders `visible(isAdmin:)`. Admin is role-gated like the web's route guard.
public enum AppSection: String, CaseIterable, Sendable, Identifiable {
    case tasks, agents, skills, runners, settings, admin

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .tasks:    return "Tasks"
        case .agents:   return "Agents"
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
    /// (its detail view still exists but is no longer a top-level destination). Admin is gated by role.
    public static func visible(isAdmin: Bool) -> [AppSection] {
        let order: [AppSection] = [.runners, .agents, .tasks, .settings, .admin]
        return order.filter { !$0.adminOnly || isAdmin }
    }

    /// The section a deep-link / notification `Route` lands in. There's no aggregate Active view
    /// anymore, so "home" (`.active`) and an individual `.session` both land in Agents — the
    /// session's owning agent is resolved when routing (see `AppModel.route`).
    public static func forRoute(_ route: Route) -> AppSection {
        switch route {
        case .active, .session: return .agents
        case .task:             return .tasks
        case .runner:           return .runners
        }
    }
}
