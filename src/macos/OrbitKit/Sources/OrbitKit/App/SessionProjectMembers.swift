import Foundation

/// The sessions a project's sessions page lists (design §5): the project's members across every
/// Workspace, Open and Completed, never Trash, each once, newest activity first. The page's reads,
/// what the app already holds when the page opens, and each poll all go through this one rule, so
/// the rows the page opens on are counted the way its read counts them.
public enum SessionProjectMembers {
    /// How long a poll leaves the Completed members as last read while nothing says they moved —
    /// the web's `PROJECT_SESSION_REFRESH_MS`. They move almost only by an Open member being
    /// completed, which a poll sees for itself (`poll`).
    public static let completedRefresh: TimeInterval = 60

    /// `projectID`'s members out of `sessions`, matched in either spelling of the id. The first
    /// copy of a session wins, so the freshest list goes first.
    public static func members(of projectID: String, in sessions: [Session]) -> [Session] {
        let key = PublicID.storageKey(projectID)
        var seen = Set<String>()
        return sessions.filter {
            guard let membership = $0.projectMembership, $0.effectiveLifecycleState != .trash,
                  PublicID.storageKey(membership.projectId) == key else { return false }
            return seen.insert($0.id).inserted
        }.sorted { ($0.lastTurnAt ?? $0.createdAt ?? "") > ($1.lastTurnAt ?? $1.createdAt ?? "") }
    }

    /// One poll of the page without asking for either list again. Its Open members are the app's
    /// Open list's — kept current by the app's own poll and the control stream — and its Completed
    /// ones are `completed`, as last read. A member `shown` as Open that the Open list no longer
    /// has has moved: completed, trashed, or out of the project. Only a read of the Completed list
    /// can say which, so it stays as it was shown, and `moved` asks for that read.
    public static func poll(shown: [Session], projectID: String, openList: [Session],
                            completed: [Session]) -> (members: [Session], moved: Bool) {
        let open = members(of: projectID, in: openList)
        let openIDs = Set(open.map(\.id))
        let moved = shown.filter { $0.effectiveLifecycleState == .open && !openIDs.contains($0.id) }
        return (members(of: projectID, in: open + completed + moved), !moved.isEmpty)
    }
}
