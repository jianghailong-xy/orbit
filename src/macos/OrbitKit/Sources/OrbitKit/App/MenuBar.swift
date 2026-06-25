import Foundation

/// One row in the menu-bar dropdown (and a deep-link target).
public struct QuickItem: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let subtitle: String
    public let route: Route
}

/// Everything the menu-bar item and the Dock badge render, derived purely from the Active
/// session list. The macOS `MenuBarExtra` / `NSApp.dockTile` are thin shells over this.
public struct MenuBarSummary: Equatable, Sendable {
    public let needsYou: Int
    public let running: Int
    public let queued: Int
    /// Dock-tile / menu-bar badge — nil when nothing needs you, "99+" capped.
    public let badge: String?
    public let items: [QuickItem]
    public init(needsYou: Int, running: Int, queued: Int, badge: String?, items: [QuickItem]) {
        self.needsYou = needsYou
        self.running = running
        self.queued = queued
        self.badge = badge
        self.items = items
    }
    public static let empty = MenuBarSummary(needsYou: 0, running: 0, queued: 0, badge: nil, items: [])
}

public enum MenuBar {
    public static func summary(from sessions: [Session], limit: Int = 8) -> MenuBarSummary {
        let g = SessionGrouping.group(sessions)
        let items = (g.needsYou + g.running).prefix(limit).map { s in
            QuickItem(id: s.id,
                      title: s.title ?? "Session",
                      subtitle: subtitle(for: s),
                      route: .session(s.id))
        }
        return MenuBarSummary(needsYou: g.needsYou.count,
                              running: g.running.count,
                              queued: g.queued.count,
                              badge: badge(g.needsYou.count),
                              items: Array(items))
    }

    public static func badge(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return count > 99 ? "99+" : String(count)
    }

    private static func subtitle(for s: Session) -> String {
        if let n = s.pendingApprovals, n > 0 { return "\(n) pending approval\(n == 1 ? "" : "s")" }
        switch s.status {
        case .running: return "Running"
        case .awaitingInput: return "Awaiting input"
        case .pending: return "Queued"
        default: return s.status.rawValue.capitalized
        }
    }
}
