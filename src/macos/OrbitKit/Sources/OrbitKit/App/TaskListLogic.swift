import Foundation

// Pure task presentation logic shared by macOS and iOS. The Web client and the server's
// `runnableTaskWhere` predicate are the product baseline; keeping those rules here prevents the
// row action, Ready filter and detail action from drifting independently again.

public enum TaskScope: Hashable, Sendable {
    case all
    case unlisted
    case list(String)

    public var id: String {
        switch self {
        case .all:            return "all"
        case .unlisted:       return "unlisted"
        case .list(let id):   return "list:\(id)"
        }
    }

    /// Query value understood by `GET /tasks/page`; nil means the owner's aggregate task scope.
    public var listQueryValue: String? {
        switch self {
        case .all:          return nil
        case .unlisted:     return "none"
        case .list(let id): return id
        }
    }
}

/// The two views of one scope — the web's segmented control: the rows, or each label's progress.
public enum TaskListViewMode: String, Sendable {
    case tasks, batches
}

/// What a row's second line says after its status pill: the first of these that is true, else who
/// it is assigned to. Every sentence is one the web or the session list already says.
public enum TaskRowPhrase: Equatable, Sendable {
    /// An OWNER_CONFIRMED run is waiting on the owner — `OwnerConfirmations.waitingForConfirmation`.
    case waitingForConfirmation
    /// A prerequisite failed or was cancelled — the web row's red-lock tooltip.
    case prerequisiteCancelled
    /// Waiting for prerequisites — the web row's grey-lock tooltip.
    case waitingForPrerequisites
    /// Starts once, at this local time — the web row's "Starts …" marker.
    case starts(String)
}

public enum TaskFilter: String, CaseIterable, Sendable, Identifiable {
    case runnable, all, running, ongoing, failed, done, cancelled

    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .runnable:  return "Ready"
        case .all:       return "All"
        case .running:   return "Running"
        case .ongoing:   return "Open"
        case .failed:    return "Failed"
        case .done:      return "Done"
        case .cancelled: return "Cancelled"
        }
    }

    /// Query value understood by `GET /tasks/page`; nil is the unfiltered All view.
    public var queryValue: String? {
        switch self {
        case .runnable:  return "RUNNABLE"
        case .all:       return nil
        case .running:   return "RUNNING"
        case .ongoing:   return "ONGOING"
        case .failed:    return "FAILED"
        case .done:      return "DONE"
        case .cancelled: return "CANCELLED"
        }
    }

    public func matches(_ task: TaskItem) -> Bool {
        switch self {
        case .runnable:  return TaskListLogic.canStart(task)
        case .all:       return true
        case .running:   return TaskListLogic.isRunning(task)
        case .ongoing:   return task.status == .open || task.status == .inProgress
        case .failed:    return task.status == .failed
        case .done:      return task.status == .done
        case .cancelled: return task.status == .cancelled
        }
    }
}

public enum TaskSort: String, CaseIterable, Sendable, Identifiable {
    case created, status, title, assignee
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .created:  return "Created"
        case .status:   return "Status"
        case .title:    return "Title"
        case .assignee: return "Assignee"
        }
    }
}

/// The per-row pill. A live session overlay wins over the agent-maintained lifecycle label.
public enum TaskPillKind: String, Sendable, Equatable {
    case running, queued, done, inProgress, open, failed, cancelled
}

public struct TaskPill: Equatable, Sendable {
    public let kind: TaskPillKind
    public let label: String
}

/// Counts for the whole selected scope, before the current filter/search is applied.
public struct TaskOverview: Equatable, Sendable {
    public let total: Int
    public let open: Int
    public let inProgress: Int
    public let done: Int
    public let failed: Int
    public let cancelled: Int
    public let running: Int
    public let queued: Int
    public let runnable: Int
    /// On the outside-projects scope: the tasks on project pages, for the page's one sentence.
    public var inProjects: TaskInProjectsCount? = nil

    public func count(for filter: TaskFilter) -> Int {
        switch filter {
        case .runnable:  return runnable
        case .all:       return total
        case .running:   return running
        case .ongoing:   return open + inProgress
        case .failed:    return failed
        case .done:      return done
        case .cancelled: return cancelled
        }
    }
}

public enum TaskListLogic {
    // MARK: execution state

    /// True execution, derived from list overlays or the richer detail's sessions.
    public static func isRunning(_ task: TaskItem) -> Bool {
        if task.running == true { return true }
        return task.sessions?.contains { $0.resolvedRunState == .running } == true
    }

    /// A queued task is only labelled queued when it has no actively running session.
    public static func isQueued(_ task: TaskItem) -> Bool {
        guard !isRunning(task) else { return false }
        if task.queued == true { return true }
        return task.sessions?.contains { $0.resolvedRunState == .queued } == true
    }

    public static func isBusy(_ task: TaskItem) -> Bool {
        isRunning(task) || isQueued(task)
    }

    /// Detail payloads omit the list-only `blocked` boolean, so dependencyState (and direct edges
    /// as an old-server fallback) must participate in the same gate.
    public static func isBlocked(_ task: TaskItem) -> Bool {
        if task.blocked == true { return true }
        if task.dependencyState == "BLOCKED" || task.dependencyState == "BLOCKED_FAILED" {
            return true
        }
        return task.dependsOn?.contains { $0.dependsOnTask?.status != .done } == true
    }

    /// Web/server Ready semantics. `assigneeHasRunner` is supplied by the detail view because its
    /// compact assignee relation omits runner fields; list rows can use the embedded runner.
    public static func canStart(_ task: TaskItem, assigneeHasRunner: Bool? = nil) -> Bool {
        // A gate row has no work of its own, so nothing starts a run on it: the server's Ready
        // predicate excludes the shape and Execute answers 409. `runnable` carries that on list
        // rows, but the detail payload omits it and the detail action is the one press a reader
        // can make — so the declaration is asked on every path, exactly as the browser asks it.
        if TaskJudgment.isGateRow(task) { return false }
        // Incremental row reads carry the complete database predicate (paused/held lists,
        // workspace enablement, aggregate parents and retired attempts included). Those gates are
        // intentionally not all mirrored in the tolerant cross-version DTO, so the server value
        // wins when present. Detail callers pass an explicit runner fact and use the local gates.
        if assigneeHasRunner == nil, let runnable = task.runnable { return runnable }
        let hasRunner = assigneeHasRunner ?? (task.assignee?.runner?.id != nil)
        return task.status != .done && hasRunner && !isBusy(task) && !isBlocked(task)
    }

    // MARK: scope, filter and search

    /// The tab the page opens on: the one the reader last picked, else All — the web's rule
    /// (`initialTaskFilter`), so the two clients open the same account onto the same list.
    public static func initialFilter(remembered: String?) -> TaskFilter {
        remembered.flatMap(TaskFilter.init(rawValue:)) ?? .all
    }

    /// The `projectId` the page's reads send. Every task and No list are the owner's own work —
    /// the tasks filed under no project (`none`); a project's tasks are on that project's page. A
    /// list the reader opened, or one conversation's tasks, is a scope somebody picked and lists
    /// its members whoever filed them (a coordinator's "View all" would otherwise land on nothing).
    public static func projectScope(_ scope: TaskScope, creatorSessionID: String?) -> String? {
        guard creatorSessionID == nil else { return nil }
        switch scope {
        case .all, .unlisted: return "none"
        case .list:           return nil
        }
    }

    /// A list whose every task is some project's: reached from that project's page, not from
    /// Tasks. An empty list stays — it is somebody's plan — and so does every list when the server
    /// does not report the split.
    public static func isProjectOnlyList(_ list: TaskListSummary) -> Bool {
        guard let outside = list.tasksOutsideProjects else { return false }
        return list.taskCount > 0 && outside == 0
    }

    // MARK: a row

    /// The second line's phrase, first true wins: waiting on the owner, a failed prerequisite, a
    /// prerequisite still running, a scheduled start. Nil means the line names the assignee.
    public static func rowPhrase(_ task: TaskItem, timeZone: TimeZone = .current,
                                 locale: Locale = .current) -> TaskRowPhrase? {
        if task.awaitingOwnerConfirmation == true { return .waitingForConfirmation }
        if isBlocked(task) {
            return task.dependencyState == "BLOCKED_FAILED" ? .prerequisiteCancelled : .waitingForPrerequisites
        }
        if task.status != .done, task.status != .cancelled,
           let local = TaskDetailLogic.scheduledLocal(task.runAt, timeZone: timeZone, locale: locale) {
            return .starts(local)
        }
        return nil
    }

    /// The time slot on the first line. A running row says how long its run has been going ("12m",
    /// no "ago"), the way a session row does while it works; every other row says when it last
    /// changed ("2h ago").
    public static func rowTime(_ task: TaskItem, now: Date = Date()) -> String? {
        if isRunning(task), let since = task.runningSince, let elapsed = RelativeTime.elapsed(since, now: now) {
            return elapsed
        }
        guard let stamp = task.updatedAt ?? task.createdAt else { return nil }
        return RelativeTime.format(stamp, now: now)
    }

    /// The empty page, in the web's sentences.
    public static func emptyTitle(scope: TaskScope, filter: TaskFilter) -> String {
        switch filter {
        case .runnable: return TaskListCopy.noneReady
        case .running:  return TaskListCopy.noneRunning
        default:
            switch scope {
            case .list:     return TaskListCopy.noneInList
            case .unlisted: return TaskListCopy.noneUnlisted
            case .all:      return TaskListCopy.noneYet
            }
        }
    }

    /// Whether Happening now is pinned over the rows: only on the unfiltered tab of a browsing
    /// scope (web: `pinStrip`). `/tasks/active` is narrowed by neither a session nor a label, so
    /// under either it would pin live tasks the page is not showing.
    public static func pinsHappeningNow(filter: TaskFilter, creatorSessionID: String?, labels: [String]) -> Bool {
        filter == .all && creatorSessionID == nil && labels.isEmpty
    }

    public static func scoped(_ items: [TaskItem], to scope: TaskScope) -> [TaskItem] {
        switch scope {
        case .all:          return items
        case .unlisted:     return items.filter { $0.listId == nil }
        case .list(let id): return items.filter { $0.listId == id }
        }
    }

    public static func filtered(_ items: [TaskItem], _ filter: TaskFilter) -> [TaskItem] {
        filter == .all ? items : items.filter { filter.matches($0) }
    }

    public static func searched(_ items: [TaskItem], query: String) -> [TaskItem] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return items }
        return items.filter { $0.title.localizedCaseInsensitiveContains(q) }
    }

    /// The web's tab row, in its order: everything, what is waiting, what could start, what is
    /// running, how it ended. Cancelled is rare, matching Web: hidden until the scope contains one
    /// (or it is selected).
    public static func availableFilters(overview: TaskOverview, current: TaskFilter) -> [TaskFilter] {
        var filters: [TaskFilter] = [.all, .ongoing, .runnable, .running, .failed, .done]
        if overview.cancelled > 0 || current == .cancelled { filters.append(.cancelled) }
        return filters
    }

    // MARK: summary

    public static func overview(_ items: [TaskItem]) -> TaskOverview {
        var open = 0, inProgress = 0, done = 0, failed = 0, cancelled = 0
        var running = 0, queued = 0, runnable = 0
        for task in items {
            switch task.status {
            case .open:       open += 1
            case .inProgress: inProgress += 1
            case .done:       done += 1
            case .failed:     failed += 1
            case .cancelled:  cancelled += 1
            }
            if isRunning(task) { running += 1 }
            else if isQueued(task) { queued += 1 }
            if canStart(task) { runnable += 1 }
        }
        return TaskOverview(total: items.count, open: open, inProgress: inProgress,
                            done: done, failed: failed, cancelled: cancelled,
                            running: running, queued: queued, runnable: runnable)
    }

    public static func overview(_ counts: TaskPageCounts) -> TaskOverview {
        TaskOverview(total: counts.total, open: counts.open, inProgress: counts.inProgress,
                     done: counts.done, failed: counts.failed, cancelled: counts.cancelled,
                     running: counts.running, queued: counts.queued, runnable: counts.runnable,
                     inProjects: counts.inProjects)
    }

    public static func listIsCompleted(_ list: TaskListSummary) -> Bool {
        list.completed == true && (list.runningTasks ?? 0) == 0
    }

    // MARK: sort and status presentation

    /// Lifecycle rank matching Web STATUS_ORDER; live overlays sit ahead of every lifecycle state.
    private static func lifecycleRank(_ status: TaskStatus) -> Int {
        switch status {
        case .inProgress: return 1
        case .failed:     return 2
        case .open:       return 3
        case .done:       return 4
        case .cancelled:  return 5
        }
    }

    public static func statusRank(_ task: TaskItem) -> Int {
        if isRunning(task) { return 0 }
        if isQueued(task) { return 1 }
        return lifecycleRank(task.status) + 1
    }

    /// Stable sort by the chosen field; equal pairs retain the server's createdAt-desc order.
    public static func sorted(_ items: [TaskItem], by sort: TaskSort, descending: Bool) -> [TaskItem] {
        let cmp: (TaskItem, TaskItem) -> Int
        switch sort {
        case .created:  cmp = { compareStr($0.createdAt, $1.createdAt) }
        case .status:   cmp = { statusRank($0) - statusRank($1) }
        case .title:    cmp = { compareStr($0.title, $1.title, numeric: true) }
        case .assignee: cmp = { compareStr($0.assignee?.name, $1.assignee?.name, numeric: true) }
        }
        return items.enumerated().sorted { a, b in
            let c = descending ? -cmp(a.element, b.element) : cmp(a.element, b.element)
            return c != 0 ? c < 0 : a.offset < b.offset
        }.map(\.element)
    }

    private static func compareStr(_ a: String?, _ b: String?, numeric: Bool = false) -> Int {
        let left = a ?? "", right = b ?? ""
        let options: String.CompareOptions = numeric ? [.numeric, .caseInsensitive] : []
        switch left.compare(right, options: options) {
        case .orderedAscending:  return -1
        case .orderedDescending: return 1
        case .orderedSame:       return 0
        }
    }

    /// The live half of ``pill(_:)``, for a caller that holds the two facts rather than a whole row
    /// — an Orbit link card reads them off `LinkPreviewTask`. Nil when neither overlay applies, so
    /// the caller falls through to the lifecycle pill it already has. Kept here rather than written
    /// out again there: the words are this row's, and a card is a second place they are said.
    public static func overlayPill(running: Bool, queued: Bool) -> TaskPill? {
        if running { return TaskPill(kind: .running, label: "Running") }
        if queued { return TaskPill(kind: .queued, label: "Queued") }
        return nil
    }

    public static func pill(_ task: TaskItem) -> TaskPill {
        if let overlay = overlayPill(running: isRunning(task), queued: isQueued(task)) {
            return overlay
        }
        switch task.status {
        case .done:       return TaskPill(kind: .done, label: "Done")
        case .inProgress: return TaskPill(kind: .inProgress, label: "In progress")
        case .open:       return TaskPill(kind: .open, label: "Open")
        case .failed:     return TaskPill(kind: .failed, label: "Failed")
        case .cancelled:  return TaskPill(kind: .cancelled, label: "Cancelled")
        }
    }
}
