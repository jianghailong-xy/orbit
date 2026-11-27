import Foundation

/// Dragging a session row onto a folder row on the Mac: a shortcut for the Move panel's first group,
/// filing a session in a folder of its own workspace (docs/session-folders-move-design.md §4). The
/// panel stays the complete way to move; a drag never leaves the workspace. The web's rules are the
/// same (`src/web/src/lib/sessionDrag.ts`).
public enum SessionFolderDrag {
    /// What dropping the dragged session on a target does.
    public enum Verdict: Equatable, Sendable {
        /// Files it there.
        case move
        /// The folder it is already in: takes no drop, so no request and no toast.
        case here
        /// Anything else — another workspace's folder, which only the Move panel reaches.
        case refused
    }

    /// The verdict for dropping a session of `sessionWorkspaceID`, filed in `sessionFolderID`, on
    /// `targetFolderID` of `targetWorkspaceID` — nil is No Folder, which a folder's page offers.
    /// `knownFolderIDs` are that workspace's folders: a session whose folder isn't among them
    /// (deleted since the list was read) is in no folder, where the list draws it.
    public static func verdict(sessionWorkspaceID: String?, sessionFolderID: String?,
                               targetWorkspaceID: String, targetFolderID: String?,
                               knownFolderIDs: Set<String>) -> Verdict {
        guard sessionWorkspaceID == targetWorkspaceID else { return .refused }
        if let targetFolderID, !knownFolderIDs.contains(targetFolderID) { return .refused }
        let current = sessionFolderID.flatMap { knownFolderIDs.contains($0) ? $0 : nil }
        return current == targetFolderID ? .here : .move
    }

    /// Whether a session row may be picked up: only where the list offers somewhere to drop it
    /// (`dropTargets` — folder rows, or a folder's page), and only a row the Move panel would file:
    /// not in Trash, and not a member that goes where its project's coordinator goes (unless the list
    /// has no row for its project here, `hasProjectMark`). A coordinator is moved as it is by the
    /// panel, its members following.
    public static func draggable(_ session: Session, view: SessionView, hasProjectMark: Bool,
                                 dropTargets: Bool) -> Bool {
        guard dropTargets, view != .trash else { return false }
        guard let membership = session.projectMembership else { return true }
        if membership.role == .coordinator { return true }
        return hasProjectMark
    }

    /// Whether a project's row may be picked up: it stands for its coordinator, which is what the
    /// drag carries and what the row's Move files (the members follow). A project with no
    /// coordinator has no Move, so no drag.
    public static func draggable(projectCoordinator: Session?, view: SessionView, dropTargets: Bool) -> Bool {
        guard projectCoordinator != nil else { return false }
        guard dropTargets, view != .trash else { return false }
        return true
    }

    /// How far the list scrolls on one tick of a drag held near its top or bottom edge, in points:
    /// negative up, positive down, 0 away from both and outside the list. `pointerY` and the edges
    /// are measured downward. Faster the closer the pointer is to the edge.
    public static func edgeScrollStep(pointerY: Double, top: Double, bottom: Double,
                                      edge: Double = 48, maxStep: Double = 16) -> Double {
        let zone = min(edge, (bottom - top) / 3)
        guard zone > 0, pointerY >= top, pointerY <= bottom else { return 0 }
        let intoTop = top + zone - pointerY
        if intoTop > 0 { return -(intoTop / zone * maxStep).rounded(.up) }
        let intoBottom = pointerY - (bottom - zone)
        if intoBottom > 0 { return (intoBottom / zone * maxStep).rounded(.up) }
        return 0
    }
}
