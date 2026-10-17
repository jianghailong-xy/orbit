import Foundation

/// One folder's row at the top of a workspace's session list (docs/session-folders-move-design.md
/// §3.3): the folder, how many of the list's sessions are in it, and the one state it reports for
/// them in its trailing slot.
public struct SessionFolderRow: Identifiable, Equatable, Sendable {
    public let folder: SessionFolder
    /// How many of the list's sessions are filed in it — 0 for an empty folder in Open.
    public let sessionCount: Int
    /// The sessions in a folder don't appear outside it, so its row reports for them, by the drawer
    /// Workspace row's rule (`WorkspaceNavigationStatusLogic`): how many wait on you, else the
    /// spinner while one runs, else the breathing mark while a background job is in flight.
    public let status: WorkspaceNavigationStatus

    public var id: String { folder.id }

    public init(folder: SessionFolder, sessionCount: Int, status: WorkspaceNavigationStatus) {
        self.folder = folder
        self.sessionCount = sessionCount
        self.status = status
    }
}

/// A workspace's session list as it is drawn: the folder rows on top, then the sessions in no
/// folder, which go on to `SessionTimeGrouping` (or the tag sections) as the whole list did.
public struct SessionFolderListing: Equatable, Sendable {
    public let folders: [SessionFolderRow]
    public let sessions: [Session]

    public init(folders: [SessionFolderRow], sessions: [Session]) {
        self.folders = folders
        self.sessions = sessions
    }
}

/// Grouping a workspace's session list by folder. It is done here rather than by the server
/// because the Open and Completed lists are already whole-list fetches narrowed to one workspace
/// (`SessionFilter.forAgent`), so splitting them once more by `folderId` costs no request (§3.3).
public enum SessionFolderGrouping {
    /// Split one workspace's list for one scope into folder rows and the sessions in no folder.
    ///
    /// - Parameters:
    ///   - sessions: the workspace's sessions for `view`, in the list's order.
    ///   - folders: that workspace's folders, in any order.
    ///   - byTag: the list is narrowed to a tag or grouped by tag.
    ///   - runnerOffline: the workspace's Runner is explicitly offline, which takes a stale spinner
    ///     off a folder row exactly as it does off the workspace's own row.
    ///
    /// Open shows every folder, the empty ones too; Completed only the folders a completed session
    /// is in. Trash is flat, and so is a list narrowed to or grouped by a tag: two groupings
    /// stacked on one list would leave a session with two places to be. Folders sort by name as
    /// Finder sorts names. A session whose folder isn't among `folders` — deleted since the list
    /// was fetched, or not loaded yet — stays in the list rather than vanishing into a folder
    /// nobody can open.
    public static func listing(_ sessions: [Session], folders: [SessionFolder], view: SessionView,
                               byTag: Bool, runnerOffline: Bool = false,
                               watching: [String: WatchSessionSummary] = [:]) -> SessionFolderListing {
        guard view != .trash, !byTag else {
            return SessionFolderListing(folders: [], sessions: sessions)
        }
        let known = Set(folders.map(\.id))
        var filed: [String: [Session]] = [:]
        var loose: [Session] = []
        for session in sessions {
            if let id = session.folderId, known.contains(id) {
                filed[id, default: []].append(session)
            } else {
                loose.append(session)
            }
        }
        let rows = byName(folders).compactMap { folder -> SessionFolderRow? in
            let inside = filed[folder.id] ?? []
            if view == .completed && inside.isEmpty { return nil }
            return SessionFolderRow(folder: folder, sessionCount: inside.count,
                                    status: status(of: inside, runnerOffline: runnerOffline, watching: watching))
        }
        return SessionFolderListing(folders: rows, sessions: loose)
    }

    /// What a folder's page lists: the sessions filed in `folderID`, in the scope of the list it
    /// was opened from. Ordered the way that list orders the scope
    /// (`SessionFilter.forAgent(_:agentID:view:)`) — pinned first and then by latest activity,
    /// Completed in the server's order — so `SessionTimeGrouping.sections` gives the page the
    /// same Pinned and time sections the list draws.
    public static func sessions(_ sessions: [Session], inFolder folderID: String,
                                view: SessionView) -> [Session] {
        let filed = sessions.filter { $0.folderId == folderID }
        return view == .completed ? filed : SessionFilter.consoleSorted(filed)
    }

    /// A folder row's trailing slot: `WorkspaceNavigationStatusLogic` over the same per-session
    /// readings the drawer's Workspace row is made of (`NeedsYouLogic.byAgent`,
    /// `WorkspaceActivityLogic`), so a folder and its workspace can't read a session differently.
    static func status(of sessions: [Session], runnerOffline: Bool,
                       watching: [String: WatchSessionSummary] = [:]) -> WorkspaceNavigationStatus {
        WorkspaceNavigationStatusLogic.resolve(
            waiting: sessions.filter(NeedsYouLogic.isCounted).count,
            running: sessions.contains { WorkspaceActivityLogic.isRunning($0, watching: watching[$0.id]) },
            jobs: sessions.contains { WorkspaceActivityLogic.isRunningJob($0, watching: watching[$0.id]) },
            runnerOffline: runnerOffline)
    }

    /// Folders by name as Finder orders names (`localizedStandardCompare`): case-insensitive, and
    /// digits by value, so "Sprint 2" comes before "Sprint 10". The id settles a tie, so the order
    /// can't change between two reads of the same folders.
    static func byName(_ folders: [SessionFolder]) -> [SessionFolder] {
        folders.sorted { a, b in
            switch a.name.localizedStandardCompare(b.name) {
            case .orderedAscending: return true
            case .orderedDescending: return false
            case .orderedSame: return a.id < b.id
            }
        }
    }
}
