import Foundation

/// Settings → Shared links on iOS: every public link this account has made, filed by where it
/// stands — web's `SharedLinksPage`, word for word (`SettingsCopyParityTests` reads the words back
/// out of it). Active opens for anyone who has it; Paused is a session in the Trash, which opens
/// again once restored; Ended is turned off or expired, for good.
public enum SharedLinksList {
    public enum Tab: String, CaseIterable, Sendable, Identifiable {
        case active, paused, ended

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .active: return "Active"
            case .paused: return "Paused"
            case .ended:  return "Ended"
            }
        }

        public var state: ShareLinkState {
            switch self {
            case .active: return .active
            case .paused: return .paused
            case .ended:  return .ended
            }
        }

        /// What the tab says when it holds nothing.
        public var empty: String {
            switch self {
            case .active: return "Nothing is shared right now. Share a session from its ⋯ menu."
            case .paused: return "No link is paused. A session’s link pauses while the session is in Trash."
            case .ended:  return "No link has ended yet."
            }
        }
    }

    public static let title = "Shared links"
    public static let subtitle = "Everything you’ve made viewable by link. Anyone who has one of these links can open what it includes — no sign-in."
    public static let couldNotLoad = "Couldn’t load your links:"

    /// The links in one tab, in the order the server answered them.
    public static func links(_ all: [ShareLink], in tab: Tab) -> [ShareLink] {
        all.filter { $0.state == tab.state }
    }

    /// The press that ends a link can: an ended one has nothing left to turn off.
    public static func canTurnOff(_ link: ShareLink) -> Bool {
        link.state == .active || link.state == .paused
    }

    /// `<baseURL>/s/<token>` — the address a visitor opens, the same one the Share panel copies.
    public static func publicURL(_ link: ShareLink, base: URL) -> URL {
        base.appendingPathComponent("s").appendingPathComponent(link.token)
    }

    /// "Link turned off", "3 links turned off".
    public static func turnedOff(_ count: Int) -> String {
        count == 1 ? "Link turned off" : "\(count) links turned off"
    }

    /// The line under a link's title: what it is and where it stands. "Session · Completed Sep 22",
    /// "Task · Done", "Paused · in Trash — …", "Project · Turned off Sep 24".
    public static func whereLine(_ link: ShareLink) -> String {
        let kind = kindWord(link.kind)
        switch link.state {
        case .paused:
            return "Paused · in Trash — restoring the session turns this link back on"
        case .ended:
            let word = link.stateReason == "EXPIRED" ? "Expired" : "Turned off"
            let day = (link.revokedAt ?? link.expiresAt).flatMap(SharePanelCopy.shortDate)
            return "\(kind) · " + (day.map { "\(word) \($0)" } ?? word)
        case .active, .unknown:
            return "\(kind) · \(rootStatus(link))"
        }
    }

    public static func kindWord(_ kind: ShareRootKind) -> String {
        switch kind {
        case .session: return "Session"
        case .task:    return "Task"
        case .project: return "Project"
        }
    }

    /// Where the root itself stands, in the words each root's own pages use.
    private static func rootStatus(_ link: ShareLink) -> String {
        let status = link.root.status ?? ""
        switch link.kind {
        case .task:
            return taskStatusLabel[status] ?? status
        case .project:
            return projectStatusLabel[status] ?? status
        case .session:
            let lifecycle = sessionLifecycle(link.root)
            if lifecycle == "Completed", let day = link.root.completedAt.flatMap(SharePanelCopy.shortDate) {
                return "\(lifecycle) \(day)"
            }
            return lifecycle
        }
    }

    /// web `TaskStatusPill`'s labels.
    private static let taskStatusLabel = ["DONE": "Done", "IN_PROGRESS": "In progress", "OPEN": "Open",
                                          "FAILED": "Failed", "CANCELLED": "Cancelled"]
    /// web `ProjectsPage`'s status words.
    private static let projectStatusLabel = ["OPEN": "Open", "DONE": "Completed", "CANCELLED": "Cancelled"]

    /// web `sessionLifecycleStateOf` + `sessionLifecycleLabel`: the root's own lifecycle when it says
    /// one (the pre-Completed `ARCHIVED` spelling reads as Completed), else Completed once it has a
    /// completion time, else Open.
    private static func sessionLifecycle(_ root: ShareRootSummary) -> String {
        switch root.lifecycleState?.uppercased() {
        case "COMPLETED", "ARCHIVED": return "Completed"
        case "TRASH": return "Trash"
        case "OPEN": return "Open"
        default: return root.completedAt == nil ? "Open" : "Completed"
        }
    }
}
