import Foundation

/// A task one of this session's live watches waits on, as the Tasks card reads it: by the name and
/// the standing the watch carries for it.
public struct SessionWatchedTask: Equatable, Sendable {
    public let id: String
    public let title: String
    /// Nil when the watch carries no standing for it.
    public let standing: WatchTargetStatus?
    /// A watch naming it has gone unchecked (`WatchProjection.stripStaleLine`).
    public let stale: Bool

    public init(id: String, title: String, standing: WatchTargetStatus?, stale: Bool) {
        self.id = id
        self.title = title
        self.standing = standing
        self.stale = stale
    }
}

/// What the session's one Tasks card draws: the tasks it created and the tasks its watches wait on,
/// one row per task. The browser's `sessionTaskCard` (`@orbit/shared`); both are held to
/// `session-created-tasks.fixture.json`'s `card` cases by `SessionCreatedTasksCopyParityTests`.
public struct SessionTaskCard: Equatable, Sendable {
    public struct Row: Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String
        /// Nil for a watched task whose standing nobody could read: no pill.
        public let pill: TaskPill?
        /// Whether its task is running, failed or done, for the sentence.
        let standing: WatchTargetStatus?
        /// Nil for a task created elsewhere, which writes `elsewhere` in its age's place.
        public let createdAt: String?
        public let replaces: SessionCreatedTasks.Named?
        /// A live watch of this session waits on it: the row carries an eye…
        public let watched: Bool
        /// …orange while that watch goes unchecked.
        public let stale: Bool
    }

    /// Watched rows first, then the rest; within each, created rows as served, then the others.
    public let rows: [Row]
    /// The sentence's numbers: the created rows' tallies plus the watched tasks created elsewhere.
    public let running: Int
    public let failed: Int
    public let done: Int
    public let total: Int
    /// How many rows carry an eye — the header's count.
    public let watching: Int
    /// Some row's eye is orange.
    public let stale: Bool

    /// Nil when the session neither created nor waits on any task. A watched task the session
    /// created marks that row (as its task, or as the task the row replaces, in either spelling of
    /// the id); one created elsewhere joins as a row of its own. The created rows are only the page
    /// the server sent, so a watched task created here but past it joins as if created elsewhere.
    public init?(created: SessionCreatedTasks?, watched: [SessionWatchedTask]) {
        var byKey: [String: SessionWatchedTask] = [:]
        var order: [String] = []
        for task in watched {
            let key = PublicID.storageKey(task.id)
            if let seen = byKey[key] {
                // Two watches over one task: one row, orange if either has gone unchecked.
                byKey[key] = SessionWatchedTask(id: seen.id, title: seen.title, standing: seen.standing,
                                                stale: seen.stale || task.stale)
            } else {
                byKey[key] = task
                order.append(key)
            }
        }
        var claimed = Set<String>()
        let createdRows: [Row] = (created?.items ?? []).map { row in
            let keys = [PublicID.storageKey(row.id)] + (row.replaces.map { [PublicID.storageKey($0.id)] } ?? [])
            let hits = keys.filter { byKey[$0] != nil }
            claimed.formUnion(hits)
            return Row(id: row.id, title: row.title, pill: row.pill,
                       standing: WatchTargetStatus(status: row.status, running: row.running, queued: row.queued),
                       createdAt: row.createdAt, replaces: row.replaces, watched: !hits.isEmpty,
                       stale: hits.contains { byKey[$0]!.stale })
        }
        let elsewhere: [Row] = order.filter { !claimed.contains($0) }.map { key in
            let task = byKey[key]!
            return Row(id: task.id, title: task.title,
                       pill: task.standing.map {
                           TaskListLogic.overlayPill(running: $0.running, queued: $0.queued)
                               ?? ReferencedTaskNote.pill(status: $0.status)
                       },
                       standing: task.standing, createdAt: nil, replaces: nil, watched: true, stale: task.stale)
        }
        var running = created?.running ?? 0
        var failed = created?.failed ?? 0
        var done = created?.done ?? 0
        var total = created?.total ?? 0
        for row in elsewhere {
            total += 1
            if row.standing?.running == true { running += 1 }
            if row.standing?.status == "FAILED" { failed += 1 } else if row.standing?.status == "DONE" { done += 1 }
        }
        guard total > 0 else { return nil }
        rows = createdRows.filter(\.watched) + elsewhere + createdRows.filter { !$0.watched }
        self.running = running
        self.failed = failed
        self.done = done
        self.total = total
        let marked = rows.filter(\.watched)
        watching = marked.count
        stale = marked.contains(where: \.stale)
    }

    /// What the collapsed row says: one task by name, or the sentence in parts.
    public var single: Row? {
        SessionCreatedTasksCopy.singleNamesTheTask && total == 1 && rows.count == 1 ? rows[0] : nil
    }

    public var countParts: [SessionCreatedTasksCopy.CountPart] {
        SessionCreatedTasksCopy.countParts(running: running, failed: failed, done: done, total: total)
    }
}

extension WatchSessionSummary {
    /// The watches the Watching card draws: those waiting on something that is not a task. A task
    /// the session waits on is an eye in its Tasks card instead. Nil when every watch waits on tasks.
    public var beyondTasks: WatchSessionSummary? {
        let kept = watches.filter { watch in
            watch.targets.contains { $0.state != .gone && $0.targetKind != .task }
        }
        return kept.isEmpty ? nil : WatchSessionSummary(observing: kept)
    }

    /// The tasks the live watches wait on, for the Tasks card (`SessionTaskCard`). `name` names a
    /// target the watch carries no title for.
    public func watchedTasks(now: Date = Date(), name: (WatchTarget) -> String?) -> [SessionWatchedTask] {
        watches.flatMap { watch in
            let stale = WatchProjection.stripStaleLine(for: watch, now: now) != nil
            return watch.targets.filter { $0.state != .gone && $0.targetKind == .task }.map { target in
                SessionWatchedTask(id: target.targetResourceId,
                                   title: WatchProjection.targetTitle(kind: .task, id: target.targetResourceId,
                                                                      name: target.targetTitle ?? name(target)),
                                   standing: target.targetStatus, stale: stale)
            }
        }
    }

    /// What the Tasks card says above its rows: the unchecked reminder of each watch the Watching
    /// card doesn't draw, each line once.
    public func taskStaleLines(now: Date = Date()) -> [String] {
        var seen = Set<String>()
        return watches
            .filter { watch in !watch.targets.contains { $0.state != .gone && $0.targetKind != .task } }
            .compactMap { WatchProjection.stripStaleLine(for: $0, now: now) }
            .filter { seen.insert($0).inserted }
    }
}
