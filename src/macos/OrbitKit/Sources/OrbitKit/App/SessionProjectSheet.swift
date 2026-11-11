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

    /// The project's session count, one number for the button beside the glyph and for the sessions
    /// page's "Project · N sessions": the page's own read of the project's Open and Completed members,
    /// landings left out. Nil until that read has answered for this project, because the app's lists
    /// alone hold only the Open members. A count shown before the read would change when the sheet
    /// opened, so the button draws its glyph alone until the read answers.
    public static func sessionCount(projectID: String, page: (projectID: String, sessions: [Session])?,
                                    answered: Bool) -> Int? {
        guard answered, let page, PublicID.storageKey(page.projectID) == PublicID.storageKey(projectID)
        else { return nil }
        return page.sessions.filter { !$0.isLanding }.count
    }

    /// The page a conversation's button reads and opens. It is the one the app already holds for this
    /// project, if any: a new address would drop that page's read, and the page under a phone's
    /// conversation would lose its members. Otherwise it is a new one, from the conversation's
    /// workspace.
    public static func address(projectID: String, shown: SessionProjectAddress?,
                               agentID: String) -> SessionProjectAddress {
        if let shown, PublicID.storageKey(shown.projectID) == PublicID.storageKey(projectID) { return shown }
        return SessionProjectAddress(projectID: projectID, agentID: agentID, view: .open)
    }
}
