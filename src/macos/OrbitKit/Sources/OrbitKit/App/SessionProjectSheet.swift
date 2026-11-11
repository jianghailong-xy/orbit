import Foundation

/// The phone's way into a project's sessions (owner 2026-11-11, docs/mocks/project-sessions-column
/// board 5): a project row opens its coordinator's conversation, and the navigation bar of that
/// conversation and of every member's carries a button that puts the project's sessions page up as
/// a sheet. Web: the title-bar button of `WorkspaceView`.
public enum SessionProjectSheet {
    /// The button's accessibility label (the web's tooltip).
    public static let buttonLabel = "Project sessions"
    /// The project glyph the button draws beside its count.
    public static let glyph = "square.grid.2x2"

    /// What a tap on a project row opens on a phone.
    public enum RowTap: Equatable, Sendable {
        /// The coordinator's conversation, pushed over the list.
        case coordinator(Session)
        /// The project's sessions page, for a row whose coordinator the app does not hold.
        case sessions
    }

    public static func rowTap(_ row: SessionProjectRow) -> RowTap {
        row.coordinator.map(RowTap.coordinator) ?? .sessions
    }

    /// The project whose button a conversation's navigation bar carries: the one it is a member of,
    /// coordinator or not. A landing session is platform work, not a member, and carries none.
    public static func projectID(of session: Session?) -> String? {
        guard let session, !session.isLanding else { return nil }
        return session.projectMembership?.projectId
    }

    /// The count beside the glyph: the project's sessions as its page counts them ("11 sessions"),
    /// landings left out. The page's own read when it is for this project; until then, the members
    /// the app's lists already hold.
    public static func sessionCount(projectID: String, page: (projectID: String, sessions: [Session])?,
                                    known: [Session]) -> Int {
        let key = PublicID.storageKey(projectID)
        if let page, PublicID.storageKey(page.projectID) == key {
            return page.sessions.filter { !$0.isLanding }.count
        }
        return SessionProjectMembers.members(of: projectID, in: known).filter { !$0.isLanding }.count
    }
}
