import Foundation

/// One project replaces its member sessions, using the coordinator's placement and wording.
/// Activity and folder counts belong to this workspace/view; supplemental sessions supply content.
public struct SessionProjectRow: Identifiable, Equatable, Sendable {
    public enum Indicator: Equatable, Sendable { case needsYou, running, jobs }
    public enum Target: Equatable, Sendable { case session(String), project(String) }

    public let projectId: String
    public let title: String
    public let status: ProjectStatus
    public let members: [Session]
    public let sessionCount: Int
    public let coordinator: Session?
    public let folderId: String?
    public let pinnedAt: String?
    public let lastTurnAt: String?
    public let createdAt: String?
    public let needsYou: Bool
    public let running: Bool
    public let jobs: Bool
    public let indicator: Indicator?
    public let line: SessionLine
    public let target: Target
    public let taskCounts: ProjectSidebarTaskCounts?
    public let runningCount: Int

    public var id: String { projectId }
}

public enum SessionProjectEntry: Identifiable, Equatable, Sendable {
    case session(Session)
    case project(SessionProjectRow)

    public var id: String {
        switch self {
        case .session(let session): return session.id
        case .project(let project): return project.id
        }
    }
    public var pinnedAt: String? {
        switch self {
        case .session(let session): return session.pinnedAt
        case .project(let project): return project.pinnedAt
        }
    }
    public var lastTurnAt: String? {
        switch self {
        case .session(let session): return session.lastTurnAt
        case .project(let project): return project.lastTurnAt
        }
    }
    public var createdAt: String? {
        switch self {
        case .session(let session): return session.createdAt
        case .project(let project): return project.createdAt
        }
    }
}

public struct SessionProjectListing: Equatable, Sendable {
    public let folders: [SessionFolderRow]
    public let projects: [SessionProjectRow]
    public let sessions: [Session]
    public let entries: [SessionProjectEntry]
}

/// Port of `src/web/src/lib/sessionProjects.ts` (design §4, §6, §7), after folder grouping.
public enum SessionProjectGrouping {
    public static func listShowsProjects(view: SessionView, byTag: Bool, searching: Bool = false) -> Bool {
        view != .trash && !byTag && !searching
    }

    public static func listing(_ sessions: [Session], folders: [SessionFolder], projects: [ProjectSummary],
                               view: SessionView, byTag: Bool, searching: Bool = false,
                               folderID: String? = nil, runnerOffline: Bool = false,
                               now: Date = Date(), coordinators: [Session] = [],
                               contentSessions: [Session]? = nil,
                               watching: [String: WatchSessionSummary] = [:],
                               line: ((Session) -> SessionLine)? = nil) -> SessionProjectListing {
        guard listShowsProjects(view: view, byTag: byTag, searching: searching) else {
            return SessionProjectListing(folders: [], projects: [], sessions: sessions,
                                         entries: sessions.map(SessionProjectEntry.session))
        }
        let sessionLine = line ?? { SessionLine.make(for: $0, live: true, watching: watching[$0.id]) }
        var coordinatorByProject: [String: Session] = [:]
        for session in coordinators + sessions where session.projectMembership?.role == .coordinator {
            coordinatorByProject[session.projectMembership!.projectId] = session
        }
        var groups: [String: [Session]] = [:]
        var projectIDs: [String] = []
        for session in sessions {
            guard let id = session.projectMembership?.projectId else { continue }
            if groups[id] == nil { projectIDs.append(id) }
            groups[id, default: []].append(session)
        }
        // Folder rows count all local sessions under the coordinator's folder, ignoring member moves.
        let assigned = sessions.map { session -> Session in
            guard let id = session.projectMembership?.projectId else { return session }
            return session.settingFolder(coordinatorByProject[id]?.folderId)
        }
        let folderListing = SessionFolderGrouping.listing(assigned, folders: folders, view: view,
                                                         byTag: byTag, runnerOffline: runnerOffline,
                                                         watching: watching)
        let knownFolders = Set(folders.map(\.id))
        func inScope(_ id: String?) -> Bool {
            if let folderID { return id == folderID }
            guard let id else { return true }
            return !knownFolders.contains(id)
        }
        let loose = sessions.filter { $0.projectMembership == nil && inScope($0.folderId) }
        if projectIDs.isEmpty {
            return SessionProjectListing(folders: folderID == nil ? folderListing.folders : [],
                                         projects: [], sessions: loose,
                                         entries: loose.map(SessionProjectEntry.session))
        }
        var rows: [SessionProjectRow] = []
        for projectID in projectIDs {
            let members = groups[projectID]!
            let coordinator = coordinatorByProject[projectID]
            let folderID = coordinator?.folderId
            guard inScope(folderID) else { continue }
            let summary = projects.first { $0.id == projectID }
            let membership = members[0].projectMembership!
            var content = members
            if let contentSessions {
                content = []
                for session in contentSessions.filter({ $0.projectMembership?.projectId == projectID }) + members {
                    if let index = content.firstIndex(where: { $0.id == session.id }) {
                        content[index] = session
                    } else {
                        content.append(session)
                    }
                }
            }
            let lines = Dictionary(content.map { ($0.id, sessionLine($0)) }, uniquingKeysWith: { _, last in last })
            let coordinatorLine = coordinator.map { lines[$0.id] ?? sessionLine($0) }
            let waiting = content.filter { lines[$0.id]?.tone == .approval }.sorted { a, b in
                let left = waitingInstant(a), right = waitingInstant(b)
                if left != right {
                    if !left.isFinite { return false }
                    if !right.isFinite { return true }
                    return left < right
                }
                return a.id.localizedCompare(b.id) == .orderedAscending
            }
            let selectedLine: SessionLine
            let target: SessionProjectRow.Target
            if let coordinator, let coordinatorLine, coordinatorLine.tone == .approval {
                selectedLine = coordinatorLine
                target = .session(coordinator.id)
            } else if let lead = waiting.first {
                selectedLine = SessionLine(text: SessionProjectCopy.waitingSession(lines[lead.id]!.text,
                                                                                  title: lead.title ?? ""),
                                           tone: .approval)
                target = .session(lead.id)
            } else if let coordinator, let held = summary?.attention?.coordinatorItems {
                let copy = SessionProjectCopy.coordinatorLead(held.leadKind)
                let age = ProjectAttention.elapsedLabel(held.oldestWaitingSince, now: now)
                selectedLine = SessionLine(text: [copy, age].compactMap { $0 }.joined(separator: " · "),
                                           tone: .running)
                target = .session(coordinator.id)
            } else if let coordinator, let coordinatorLine {
                selectedLine = coordinatorLine
                target = .session(coordinator.id)
            } else {
                selectedLine = SessionLine(text: SessionProjectCopy.noCoordinator, tone: .preview)
                target = .project(projectID)
            }
            let latest = members.dropFirst().reduce(members[0]) { newest, session in
                instant(session.lastTurnAt ?? session.createdAt) > instant(newest.lastTurnAt ?? newest.createdAt)
                    ? session : newest
            }
            // Unlike counted navigation badges, the row also shows a start request as amber.
            let needsYou = members.contains { lines[$0.id]?.tone == .approval }
            let runningCount = runnerOffline ? 0 : members.filter {
                WorkspaceActivityLogic.isRunning($0, watching: watching[$0.id])
            }.count
            let running = runningCount > 0
            let jobs = !runnerOffline && members.contains {
                WorkspaceActivityLogic.isRunningJob($0, watching: watching[$0.id])
            }
            rows.append(SessionProjectRow(
                projectId: projectID, title: summary?.title ?? membership.projectTitle,
                status: summary?.status ?? membership.projectStatus, members: members,
                sessionCount: content.count, coordinator: coordinator, folderId: folderID,
                pinnedAt: coordinator?.pinnedAt, lastTurnAt: latest.lastTurnAt ?? latest.createdAt,
                createdAt: coordinator?.createdAt ?? latest.createdAt,
                needsYou: needsYou, running: running, jobs: jobs,
                indicator: needsYou ? .needsYou : running ? .running : jobs ? .jobs : nil,
                line: selectedLine, target: target, taskCounts: summary?.taskCounts,
                runningCount: summary?.buckets.running ?? runningCount))
        }
        let entries = (loose.map(SessionProjectEntry.session) + rows.map(SessionProjectEntry.project)).sorted { a, b in
            if view == .open, (a.pinnedAt != nil) != (b.pinnedAt != nil) { return a.pinnedAt != nil }
            return instant(a.lastTurnAt ?? a.createdAt) > instant(b.lastTurnAt ?? b.createdAt)
        }
        return SessionProjectListing(folders: folderID == nil ? folderListing.folders : [],
                                     projects: rows, sessions: loose, entries: entries)
    }

    /// The project sessions page's Now section (iOS): the members other than the coordinator that
    /// are working or waiting on you, in the order given. The coordinator keeps its own section.
    public static func nowSessions(_ sessions: [Session],
                                   watching: (Session) -> WatchSessionSummary? = { _ in nil }) -> [Session] {
        sessions.filter { session in
            guard session.projectMembership?.role != .coordinator else { return false }
            let glyph = SessionStatusGlyph.make(for: session, watching: watching(session))
            if case .spinner = glyph.shape { return true }
            return glyph.tone == .warning
        }
    }

    private static func instant(_ iso: String?) -> TimeInterval {
        iso.flatMap(RelativeTime.parse)?.timeIntervalSince1970 ?? -.infinity
    }

    private static func waitingInstant(_ session: Session) -> TimeInterval {
        let times = (session.ownerItems ?? []).map { instant($0.since) }.filter(\.isFinite)
        return times.min() ?? instant(session.lastTurnAt ?? session.createdAt)
    }
}
