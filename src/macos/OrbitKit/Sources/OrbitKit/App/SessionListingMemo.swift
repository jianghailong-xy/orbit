import Foundation

/// Everything a session list's grouping (projects, folders, recency sections) is computed from —
/// the workspace list's and a folder page's alike. A list regroups only when one of these differs
/// from the pass before (`SessionListingMemo`), so a grouping must read nothing else: a fact left
/// out of here is one the list would go on drawing stale.
///
/// The arrays are the models' own, not copies narrowed for this list: an array that was not
/// reassigned compares by its storage in O(1), so an unchanged pass costs next to nothing.
public struct SessionListInputs: Equatable, Sendable {
    /// The workspace the list is for (its folders are picked out of `folders` by it).
    public var workspaceID: String
    /// The workspace's sessions for `view`, before the tag filter (`AgentsModel.agentSessions`).
    public var sessions: [Session]
    /// The tag filter chip's selection, nil for "All".
    public var tagFilter: String?
    /// The folder a folder page shows, nil for the workspace's own list.
    public var folderID: String?
    /// The account's Open sessions (`AppModel.sessions`).
    public var accountSessions: [Session]
    /// The same scope across every workspace (`AgentsModel.allSessions`).
    public var allSessions: [Session]
    /// The owner's whole folder library (`AppModel.sessionFolders`).
    public var folders: [SessionFolder]
    /// `ProjectsModel.sidebarProjects`.
    public var projects: [ProjectSummary]
    /// The live watches by session storage key (`WatchesModel.summaries`).
    public var watches: [String: WatchSessionSummary]
    public var view: SessionView
    public var groupByTag: Bool
    public var searching: Bool
    public var runnerOffline: Bool
    /// The wall-clock minute: a project row's landing and waiting ages ("3m") and the recency
    /// buckets move with time alone, so a list left on screen regroups at most once a minute.
    public var minute: Int

    public init(workspaceID: String, sessions: [Session], tagFilter: String? = nil, folderID: String? = nil,
                accountSessions: [Session], allSessions: [Session], folders: [SessionFolder],
                projects: [ProjectSummary], watches: [String: WatchSessionSummary], view: SessionView,
                groupByTag: Bool = false, searching: Bool, runnerOffline: Bool, now: Date = Date()) {
        self.workspaceID = workspaceID
        self.sessions = sessions
        self.tagFilter = tagFilter
        self.folderID = folderID
        self.accountSessions = accountSessions
        self.allSessions = allSessions
        self.folders = folders
        self.projects = projects
        self.watches = watches
        self.view = view
        self.groupByTag = groupByTag
        self.searching = searching
        self.runnerOffline = runnerOffline
        self.minute = Int((now.timeIntervalSince1970 / 60).rounded(.down))
    }

    /// The list's sessions narrowed to the tag filter chip, when one is active.
    public var shownSessions: [Session] {
        guard let tagFilter else { return sessions }
        return SessionFilter.withTag(sessions, tagID: tagFilter)
    }

    /// A tag filter or Group by Tag is a grouping of its own: no folders or projects beside it.
    public var byTag: Bool { tagFilter != nil || groupByTag }

    /// This workspace's folders, out of the owner's whole library.
    public var workspaceFolders: [SessionFolder] { folders.filter { $0.workspaceId == workspaceID } }

    /// One session's live watch, by either spelling of its id.
    public func watch(for sessionID: String) -> WatchSessionSummary? {
        watches[PublicID.storageKey(sessionID)]
    }
}

/// The last grouping a list drew and what it was computed from. A view's body runs far more often
/// than its inputs change (a row selected, a page popped back to, a focus request), and regrouping
/// a workspace's sessions costs milliseconds each time; this hands the previous answer back until
/// the inputs differ.
///
/// A plain class, deliberately not observable: it is written while the body runs, and an observed
/// write there would invalidate the very view reading it. The body still re-runs when an input
/// changes, because building the `SessionListInputs` reads every one of them from the models.
public final class SessionListingMemo<Value> {
    private var last: (inputs: SessionListInputs, value: Value)?
    /// The rows' lines, kept across regroupings: a session running in the list changes the inputs
    /// every few seconds, and only its own line has to be worked out again.
    public let lines = SessionLineCache()
    /// How many times `compute` has run — what the tests count.
    public private(set) var computations = 0

    public init() {}

    public func value(for inputs: SessionListInputs,
                      compute: (SessionListInputs, SessionLineCache) -> Value) -> Value {
        if let last, last.inputs == inputs { return last.value }
        let value = compute(inputs, lines)
        lines.endPass()
        computations += 1
        last = (inputs, value)
        return value
    }
}

/// `SessionLine.make(for:live: true, watching:)` per session, worked out again only for a session
/// (or its watch) that changed since it was last asked for. A line is a pure function of the two,
/// and the regular expressions behind a preview are most of what a regrouping costs.
public final class SessionLineCache {
    private var entries: [String: Entry] = [:]
    private var asked: Set<String> = []
    /// How many lines were actually made — what the tests count.
    public private(set) var made = 0

    private struct Entry {
        let session: Session
        let watching: WatchSessionSummary?
        let line: SessionLine
    }

    public init() {}

    public func line(for session: Session, watching: WatchSessionSummary?) -> SessionLine {
        asked.insert(session.id)
        if let entry = entries[session.id], entry.session == session, entry.watching == watching {
            return entry.line
        }
        let line = SessionLine.make(for: session, live: true, watching: watching)
        made += 1
        entries[session.id] = Entry(session: session, watching: watching, line: line)
        return line
    }

    /// Forgets the sessions this pass did not ask for, so the cache holds one list's rows and not
    /// every session it has ever drawn.
    public func endPass() {
        entries = entries.filter { asked.contains($0.key) }
        asked.removeAll(keepingCapacity: true)
    }
}
