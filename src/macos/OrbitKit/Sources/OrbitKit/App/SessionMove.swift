import Foundation

/// One row of the Move panel's folder group (docs/session-folders-move-design.md §4): a place in the
/// session's own workspace it can be filed — No Folder, or one of the workspace's folders.
public struct SessionMoveFolderOption: Identifiable, Equatable, Sendable {
    /// The folder, or nil for No Folder: in no folder, back in the workspace's list.
    public let folder: SessionFolder?
    /// How many of the list's sessions are in the folder; nil on No Folder, which counts nothing.
    public let sessionCount: Int?
    /// The session is filed here now — the row the panel ticks.
    public let isCurrent: Bool

    /// The folder's id; empty for No Folder, which no folder's id can be.
    public var id: String { folder?.id ?? "" }

    public init(folder: SessionFolder?, sessionCount: Int?, isCurrent: Bool) {
        self.folder = folder
        self.sessionCount = sessionCount
        self.isCurrent = isCurrent
    }
}

/// What the Move panel's folder group offers. Pure, so its rows and its tick are tested here rather
/// than on a device.
public enum SessionMoveLogic {
    /// No Folder, then every folder of `workspaceID` by name — the empty ones too, whichever scope the
    /// list shows, since any of them can take the session — each with how many of `listed` (the list
    /// the row was moved from) are in it, as the list's own folder rows count them.
    ///
    /// The session is read as `listed` has it now, so a move made while the panel was away is where
    /// the tick goes. Its folder is ticked; one that isn't among the workspace's folders (deleted
    /// since the row was read) ticks No Folder, which is where the list shows such a session
    /// (`SessionFolderGrouping.listing`).
    public static func folderOptions(for session: Session, workspaceID: String,
                                     folders: [SessionFolder], listed: [Session]) -> [SessionMoveFolderOption] {
        let own = SessionFolderGrouping.byName(folders.filter { $0.workspaceId == workspaceID })
        let folderID = (listed.first { $0.id == session.id } ?? session).folderId
        let current = own.contains { $0.id == folderID } ? folderID : nil
        var counts: [String: Int] = [:]
        for row in listed {
            if let id = row.folderId { counts[id, default: 0] += 1 }
        }
        return [SessionMoveFolderOption(folder: nil, sessionCount: nil, isCurrent: current == nil)]
            + own.map { SessionMoveFolderOption(folder: $0, sessionCount: counts[$0.id] ?? 0,
                                                isCurrent: $0.id == current) }
    }

    /// The name New Folder… asks the server for, as the server will store it: without the space
    /// around it. Nil for a name of spaces alone, which Create ignores, as Save ignores a blank title.
    public static func folderName(_ draft: String) -> String? {
        let name = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }
}

/// The Move panel's words, and the toast a move leaves (docs/session-folders-move-design.md §4).
public enum SessionMoveCopy {
    public static let title = "Move"
    public static let done = "Done"
    public static let noFolder = "No Folder"
    public static let newFolder = "New Folder…"

    /// The first group's header: the folders of the workspace the session is in.
    public static func folderGroup(workspace: String) -> String { "Folder in \(workspace)" }

    /// New Folder…'s system prompt.
    public static let newFolderTitle = "New Folder"
    public static let newFolderMessage = "The session moves into it."
    public static let folderNamePlaceholder = "Name"
    public static let create = "Create"
    public static let cancel = "Cancel"

    /// The alert New Folder… raises when the folder wasn't created, over `createFailure`.
    public static let couldNotCreate = "Couldn’t Create Folder"
    public static let ok = "OK"

    /// Why the folder wasn't created, in one sentence. The server refuses a name its workspace
    /// already has with a 409, and that is said in so many words; anything else is the server's
    /// own reason (`APIClient.failureReason`).
    public static func createFailure(_ error: Error, name: String, workspace: String) -> String {
        if case APIError.http(let status, _) = error, status == 409 {
            return "There’s already a folder named “\(name)” in \(workspace). Choose another name."
        }
        return "The folder couldn’t be created: \(APIClient.failureReason(error))."
    }

    /// The toast once a move has gone through: the folder the session went to — or, moved to No
    /// Folder, the one it left.
    public static func moved(to destination: SessionFolder?, from origin: SessionFolder?) -> String {
        if let destination { return "Moved to “\(destination.name)”" }
        if let origin { return "Moved out of “\(origin.name)”" }
        return "Moved out of its folder"
    }

    /// The toast when the server refused a move, which put the row back where it was.
    public static let moveFailed = "Could not move session"
}
