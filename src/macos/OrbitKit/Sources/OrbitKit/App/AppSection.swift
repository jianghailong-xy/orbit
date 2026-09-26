import Foundation

/// Top-level navigation sections, mirroring the web AppShell nav. Pure data — titles and SF
/// Symbol names are just strings — so it lives in OrbitKit and is unit-tested; the SwiftUI
/// sidebar renders `visible(isAdmin:)`. Admin is role-gated like the web's route guard.
public enum AppSection: String, CaseIterable, Sendable, Identifiable {
    case tasks, following, agents, skills, runners, settings, admin, projects, wiki

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .projects: return "Projects"
        case .tasks:    return "Tasks"
        case .following: return "Following"
        case .agents:   return "Workspaces"
        case .skills:   return "Skills"
        case .runners:  return "Runners"
        case .settings: return "Settings"
        case .admin:    return "Admin"
        case .wiki:     return "Wiki"
        }
    }

    /// SF Symbol for the sidebar row.
    public var systemImage: String {
        switch self {
        case .projects: return "square.grid.2x2"
        case .tasks:    return "checklist"
        case .following: return "eye"
        case .agents:   return "person.2"
        case .skills:   return "wand.and.stars"
        case .runners:  return "desktopcomputer"
        case .settings: return "gearshape"
        case .admin:    return "lock.shield"
        // The SF Symbols glyph for a book or a library — what the web draws as AntD's
        // `BookOutlined`, on the drawer row and on every `orbit-wiki:` card alike.
        case .wiki:     return "book.closed"
        }
    }

    /// Admin-area sections are hidden from non-admins (mirrors the web route guard).
    public var adminOnly: Bool { self == .admin }

    /// Sections to show in the nav, in display order. Runners leads; Skills is intentionally omitted
    /// (its detail view still exists but is no longer a top-level destination). Projects sits just
    /// before Tasks — a project is what its tasks are for — and the Wiki, what the work learned,
    /// follows them: the work, then what is known, then the machines. Following, the watches kept on
    /// sessions and tasks, comes after. Admin is gated by role.
    public static func visible(isAdmin: Bool) -> [AppSection] {
        let order: [AppSection] = [.runners, .agents, .projects, .tasks, .wiki, .following, .settings, .admin]
        return order.filter { !$0.adminOnly || isAdmin }
    }

    /// What the iPhone drawer and the regular-width iPad sidebar lead with, ABOVE the Workspaces and
    /// set apart from them: the work itself — its projects and its tasks — and the Wiki, the other
    /// thing a codebase has (Projects is the work in it, the Wiki is what the work learned). The web
    /// sidebar puts Wiki right under Projects for the same reason. Following is not among them:
    /// its watches are the waits agents keep for their own sessions, already drawn on each session's
    /// row, header and Watching strip, and that strip, a watch's link and its alert are what open it.
    /// The iPhone drawer has no row for it; on iPad it falls to the Manage group below.
    public static let workSections: [AppSection] = [.projects, .tasks, .wiki]

    /// Destinations shown below the regular-width iPad sidebar's first-class Workspace group.
    /// Keep this derived from ``visible(isAdmin:)`` so role gating and the cross-client navigation
    /// order stay authoritative in one place while the iPad renderer supplies the group boundary.
    public static func managementSections(isAdmin: Bool) -> [AppSection] {
        visible(isAdmin: isAdmin).filter { $0 != .agents && !workSections.contains($0) }
    }

    /// The section a deep-link / notification `Route` lands in. There's no aggregate Open view
    /// anymore, so "home" (`.active`) and an individual `.session` both land in Agents — the
    /// session's owning agent is resolved when routing (see `AppModel.route`).
    public static func forRoute(_ route: Route) -> AppSection {
        switch route {
        case .active, .session: return .agents
        case .task, .list:      return .tasks
        case .runner:           return .runners
        case .watch:            return .following
        }
    }
}
