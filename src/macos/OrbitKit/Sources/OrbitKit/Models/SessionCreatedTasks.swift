import Foundation

// `GET /api/sessions/:id/created-tasks?limit=`: what the "Tasks created here" card above a session's
// composer is drawn from. Mirrors `@orbit/shared`'s `sessionCreatedTasks.ts`; every id is the
// base62 public id.
//
// A row is not quite a task: a task the session created that another one took over is drawn as the
// end of that chain, with `replaces` naming the task the session created, and several of them taken
// over by one successor are one row. The server has already done that and already put the rows in
// the card's order — this client draws them as they come. Every count counts rows, which is what
// keeps the pills and the sentence in agreement.

/// The session's created tasks as the card draws them.
public struct SessionCreatedTasks: Codable, Equatable, Sendable {
    /// `{ id, title }`: the task a row's task took over, or a project the rows belong to.
    public struct Named: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String
    }

    /// Every row, whatever `limit` was.
    public let total: Int
    /// Rows whose `running` is true.
    public let running: Int
    /// Rows whose status is FAILED.
    public let failed: Int
    /// Rows whose status is DONE.
    public let done: Int
    /// The first `limit` rows: Failed, Running, Queued, the rest of the unfinished, Done, Cancelled,
    /// newest first within each.
    public let items: [SessionCreatedTaskRow]
    /// The projects `items` belong to, each once, in the order `items` first names them.
    public let projects: [Named]
}

/// One row of the card.
public struct SessionCreatedTaskRow: Codable, Equatable, Sendable, Identifiable {
    /// The task the row draws: the one the session created, or the end of its supersession chain.
    public let id: String
    public let title: String
    /// The task's status as the wire spells it (`TaskStatus`'s raw values). Kept as the string so a
    /// status this build has no case for is drawn under its own name instead of costing the card.
    public let status: String
    /// The task list's live overlays: a RUNNING session on it, or a PENDING one with none running.
    public let running: Bool
    public let queued: Bool
    public let createdAt: String
    public let projectId: String?
    /// The task this session created that the row's task took over; nil when the row IS that task.
    public let replaces: SessionCreatedTasks.Named?
}

extension SessionCreatedTaskRow {
    /// The row's pill, in the task list's own words: a live run outranks the lifecycle
    /// (`TaskListLogic.pill`), so one task reads the same word here as on the Tasks page.
    public var pill: TaskPill {
        TaskListLogic.overlayPill(running: running, queued: queued)
            ?? ReferencedTaskNote.pill(status: status)
    }
}

extension SessionCreatedTasks {
    /// Whether any row is running or queued — while one is, the card reads again every 15s.
    public var hasLiveRows: Bool {
        running > 0 || items.contains { $0.running || $0.queued }
    }

    /// Whether this answer draws `taskID`: as a row's task, or as the task a row replaces. Either
    /// spelling of the id matches.
    public func draws(taskID: String) -> Bool {
        let key = PublicID.storageKey(taskID)
        return items.contains { row in
            PublicID.storageKey(row.id) == key
                || row.replaces.map { PublicID.storageKey($0.id) == key } == true
        }
    }
}
