import Foundation

/// The reads behind the three project-page sections that are about the plan rather than its tally:
/// the blockers the project document carries (`GET /projects/:id` → `blockers`), the run queue
/// (`GET /projects/:id/panorama/ready`) and the dependency graph (`GET /projects/:id/dependency-graph`).
/// Shapes mirror the web's `ProjectBlockers.tsx`, `lib/queries.ts` and `lib/projectDependencyGraph.ts`.
///
/// Decoded tolerantly, like every model here: a field an older server does not send decodes to its
/// empty form, and a value from a newer one lands on a floor instead of failing the page.

// MARK: - Blockers

/// One structured reason the project did not move, with the sentence it is asking for.
public struct ProjectBlocker: Codable, Equatable, Sendable, Identifiable {
    /// The parts of `detail` a row draws. The rest of it is the server's own bookkeeping.
    public struct Detail: Codable, Equatable, Sendable {
        /// The delivery a machine may not settle (`OUTSIDE_DECLARED_SCOPE`, …), when this is one.
        public let reason: String?
        /// The files it names.
        public let paths: [String]

        public init(reason: String? = nil, paths: [String] = []) {
            self.reason = reason
            self.paths = paths
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            reason = try? c.decodeIfPresent(String.self, forKey: .reason)
            paths = (try? c.decodeIfPresent([String].self, forKey: .paths)) ?? []
        }
    }

    public let id: String
    public let kind: String
    /// `USER`, `COORDINATOR` or `SYSTEM` — who has to act.
    public let owner: String
    public let severity: String?
    public let requiredAction: String
    public let subjectTitle: String?
    public let criterionOrdinal: Int?
    public let criterionRevision: Int?
    public let detail: Detail
    public let firstSeenAt: String?
    public let resolvedAt: String?
    /// `AUTO`, `USER` or `COORDINATOR`, once it was resolved.
    public let resolvedBy: String?
    public let resolutionNote: String?

    public init(id: String, kind: String, owner: String = "USER", severity: String? = nil,
                requiredAction: String = "", subjectTitle: String? = nil, criterionOrdinal: Int? = nil,
                criterionRevision: Int? = nil, detail: Detail = Detail(), firstSeenAt: String? = nil,
                resolvedAt: String? = nil, resolvedBy: String? = nil, resolutionNote: String? = nil) {
        self.id = id
        self.kind = kind
        self.owner = owner
        self.severity = severity
        self.requiredAction = requiredAction
        self.subjectTitle = subjectTitle
        self.criterionOrdinal = criterionOrdinal
        self.criterionRevision = criterionRevision
        self.detail = detail
        self.firstSeenAt = firstSeenAt
        self.resolvedAt = resolvedAt
        self.resolvedBy = resolvedBy
        self.resolutionNote = resolutionNote
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        owner = try c.decodeIfPresent(String.self, forKey: .owner) ?? "SYSTEM"
        severity = try c.decodeIfPresent(String.self, forKey: .severity)
        requiredAction = try c.decodeIfPresent(String.self, forKey: .requiredAction) ?? ""
        subjectTitle = try c.decodeIfPresent(String.self, forKey: .subjectTitle)
        criterionOrdinal = try? c.decodeIfPresent(Int.self, forKey: .criterionOrdinal)
        criterionRevision = try? c.decodeIfPresent(Int.self, forKey: .criterionRevision)
        detail = (try? c.decodeIfPresent(Detail.self, forKey: .detail)) ?? Detail()
        firstSeenAt = try c.decodeIfPresent(String.self, forKey: .firstSeenAt)
        resolvedAt = try c.decodeIfPresent(String.self, forKey: .resolvedAt)
        resolvedBy = try c.decodeIfPresent(String.self, forKey: .resolvedBy)
        resolutionNote = try c.decodeIfPresent(String.self, forKey: .resolutionNote)
    }
}

/// Every open blocker, and the latest resolved ones with how many there were in all.
public struct ProjectBlockers: Codable, Equatable, Sendable {
    public let open: [ProjectBlocker]
    /// Newest first.
    public let resolved: [ProjectBlocker]
    public let resolvedCount: Int

    public init(open: [ProjectBlocker] = [], resolved: [ProjectBlocker] = [], resolvedCount: Int = 0) {
        self.open = open
        self.resolved = resolved
        self.resolvedCount = resolvedCount
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        open = try c.decodeIfPresent([ProjectBlocker].self, forKey: .open) ?? []
        resolved = try c.decodeIfPresent([ProjectBlocker].self, forKey: .resolved) ?? []
        resolvedCount = try c.decodeIfPresent(Int.self, forKey: .resolvedCount) ?? resolved.count
    }
}

/// `POST /projects/:id/blockers/:blockerId/resolve`: the owner's reason, recorded beside who gave it.
public struct ResolveProjectBlockerRequest: Codable, Equatable, Sendable {
    public let reason: String

    public init(reason: String) {
        self.reason = reason
    }
}

// MARK: - Run queue

/// `GET /projects/:id/panorama/ready`: the tasks that can run now or are running, the ones that
/// release the most work first.
public struct ProjectReadyToRun: Codable, Equatable, Sendable {
    /// The list holding an otherwise-ready task, which has to be resumed before Run is offered.
    public struct PausedList: Codable, Equatable, Sendable {
        public let id: String
        public let title: String
        public let readyCount: Int
        public let autoRunReadyCount: Int

        public init(id: String, title: String, readyCount: Int = 0, autoRunReadyCount: Int = 0) {
            self.id = id
            self.title = title
            self.readyCount = readyCount
            self.autoRunReadyCount = autoRunReadyCount
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            readyCount = try c.decodeIfPresent(Int.self, forKey: .readyCount) ?? 0
            autoRunReadyCount = try c.decodeIfPresent(Int.self, forKey: .autoRunReadyCount) ?? 0
        }
    }

    /// Where a row stands: it can run, a run of it is waiting for a runner or going, or its list is
    /// paused.
    public enum RunState: String, Codable, Sendable {
        case ready = "READY"
        case queued = "QUEUED"
        case running = "RUNNING"
        case paused = "PAUSED"

        /// An older server sends none, and a value this build does not know draws as ready — the
        /// web's reading during a rolling deploy.
        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = RunState(rawValue: raw) ?? .ready
        }
    }

    public struct Item: Codable, Equatable, Sendable, Identifiable {
        public let taskId: String
        public let title: String
        public let status: String
        public let runState: RunState
        /// The run's session, while one is queued or going.
        public let sessionId: String?
        public let pausedList: PausedList?
        /// How much unfinished work waits on this task; nil when the project is too large to rank.
        public let downstreamBlocked: Int?

        public var id: String { taskId }

        public init(taskId: String, title: String, status: String = "OPEN", runState: RunState = .ready,
                    sessionId: String? = nil, pausedList: PausedList? = nil, downstreamBlocked: Int? = 0) {
            self.taskId = taskId
            self.title = title
            self.status = status
            self.runState = runState
            self.sessionId = sessionId
            self.pausedList = pausedList
            self.downstreamBlocked = downstreamBlocked
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            taskId = try c.decode(String.self, forKey: .taskId)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
            runState = (try? c.decodeIfPresent(RunState.self, forKey: .runState)) ?? .ready
            sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
            pausedList = try? c.decodeIfPresent(PausedList.self, forKey: .pausedList)
            downstreamBlocked = try c.decodeIfPresent(Int.self, forKey: .downstreamBlocked)
        }
    }

    /// Set instead of a short ranking when the project is too large to close over.
    public struct ImpactTruncated: Codable, Equatable, Sendable {
        public let maxTasks: Int

        public init(maxTasks: Int) {
            self.maxTasks = maxTasks
        }
    }

    /// Every runnable task in the project, not only the rows in `items`.
    public let readyCount: Int
    public let queuedCount: Int
    public let runningCount: Int
    public let pausedCount: Int
    public let items: [Item]
    public let impactTruncated: ImpactTruncated?

    public init(readyCount: Int = 0, queuedCount: Int = 0, runningCount: Int = 0, pausedCount: Int = 0,
                items: [Item] = [], impactTruncated: ImpactTruncated? = nil) {
        self.readyCount = readyCount
        self.queuedCount = queuedCount
        self.runningCount = runningCount
        self.pausedCount = pausedCount
        self.items = items
        self.impactTruncated = impactTruncated
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        readyCount = try c.decodeIfPresent(Int.self, forKey: .readyCount) ?? 0
        queuedCount = try c.decodeIfPresent(Int.self, forKey: .queuedCount) ?? 0
        runningCount = try c.decodeIfPresent(Int.self, forKey: .runningCount) ?? 0
        pausedCount = try c.decodeIfPresent(Int.self, forKey: .pausedCount) ?? 0
        items = try c.decodeIfPresent([Item].self, forKey: .items) ?? []
        impactTruncated = try? c.decodeIfPresent(ImpactTruncated.self, forKey: .impactTruncated)
    }
}

/// `PATCH /task-lists/:id` lifting a list's pause, from the run queue.
public struct ResumeTaskListRequest: Codable, Equatable, Sendable {
    public let paused: Bool
    public let note: String

    public init(note: String) {
        paused = false
        self.note = note
    }
}

// MARK: - Dependency graph

/// One thing the graph draws: a task, or a fold standing for several — a straight run or a repeated
/// motif (folded by the server), or a block of finished work (folded here, see `ProjectGraph`).
public struct ProjectGraphMark: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        case task = "TASK"
        case run = "RUN"
        case motif = "MOTIF"
        /// Never sent: the client's own fold of finished work.
        case settled = "SETTLED"
        case unknown = "UNKNOWN"

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .unknown
        }
    }

    /// A task inside a fold: a run's steps, a motif's samples, a settled block's members.
    public struct Member: Codable, Equatable, Sendable {
        public let taskId: String
        public let title: String
        public let status: String
        public let running: Bool
        public let queued: Bool
        public let workState: String?
        public let verificationState: String?

        public init(taskId: String, title: String, status: String, running: Bool = false,
                    queued: Bool = false, workState: String? = nil, verificationState: String? = nil) {
            self.taskId = taskId
            self.title = title
            self.status = status
            self.running = running
            self.queued = queued
            self.workState = workState
            self.verificationState = verificationState
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            taskId = try c.decode(String.self, forKey: .taskId)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
            running = try c.decodeIfPresent(Bool.self, forKey: .running) ?? false
            queued = try c.decodeIfPresent(Bool.self, forKey: .queued) ?? false
            workState = try c.decodeIfPresent(String.self, forKey: .workState)
            verificationState = try c.decodeIfPresent(String.self, forKey: .verificationState)
        }
    }

    public let kind: Kind
    public let id: String
    public let title: String
    public let parentTaskId: String?
    // A task mark.
    public let taskId: String?
    public let status: String?
    public let running: Bool
    public let queued: Bool
    public let workState: String?
    public let verificationState: String?
    // A fold.
    public let taskCount: Int
    /// How many of its tasks are in each status (`DONE`, `IN_PROGRESS`, `FAILED`, `CANCELLED`, `OPEN`).
    public let statusCounts: [String: Int]
    /// A run's steps in order, or a settled block's tasks.
    public let members: [Member]
    /// A few of a motif's tasks, failures and running work first.
    public let samples: [Member]
    public let instanceCount: Int?
    /// False when a run is longer than the response carries steps for.
    public let expandable: Bool

    public init(kind: Kind, id: String, title: String, parentTaskId: String? = nil, taskId: String? = nil,
                status: String? = nil, running: Bool = false, queued: Bool = false,
                workState: String? = nil, verificationState: String? = nil, taskCount: Int = 1,
                statusCounts: [String: Int] = [:], members: [Member] = [], samples: [Member] = [],
                instanceCount: Int? = nil, expandable: Bool = false) {
        self.kind = kind
        self.id = id
        self.title = title
        self.parentTaskId = parentTaskId
        self.taskId = taskId
        self.status = status
        self.running = running
        self.queued = queued
        self.workState = workState
        self.verificationState = verificationState
        self.taskCount = taskCount
        self.statusCounts = statusCounts
        self.members = members
        self.samples = samples
        self.instanceCount = instanceCount
        self.expandable = expandable
    }

    /// A task drawn as itself.
    public static func task(id: String, title: String, status: String, workState: String? = nil,
                            running: Bool = false, queued: Bool = false, parentTaskId: String? = nil,
                            verificationState: String? = nil) -> ProjectGraphMark {
        ProjectGraphMark(kind: .task, id: id, title: title, parentTaskId: parentTaskId, taskId: id,
                         status: status, running: running, queued: queued, workState: workState,
                         verificationState: verificationState)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decodeIfPresent(Kind.self, forKey: .kind)) ?? .unknown
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        parentTaskId = try c.decodeIfPresent(String.self, forKey: .parentTaskId)
        taskId = try c.decodeIfPresent(String.self, forKey: .taskId)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        running = try c.decodeIfPresent(Bool.self, forKey: .running) ?? false
        queued = try c.decodeIfPresent(Bool.self, forKey: .queued) ?? false
        workState = try c.decodeIfPresent(String.self, forKey: .workState)
        verificationState = try c.decodeIfPresent(String.self, forKey: .verificationState)
        taskCount = try c.decodeIfPresent(Int.self, forKey: .taskCount) ?? 1
        statusCounts = (try? c.decodeIfPresent([String: Int].self, forKey: .statusCounts)) ?? [:]
        members = (try? c.decodeIfPresent([Member].self, forKey: .members)) ?? []
        samples = (try? c.decodeIfPresent([Member].self, forKey: .samples)) ?? []
        instanceCount = try c.decodeIfPresent(Int.self, forKey: .instanceCount)
        expandable = try c.decodeIfPresent(Bool.self, forKey: .expandable) ?? false
    }
}

/// Prerequisite → dependent, between marks.
public struct ProjectGraphEdge: Codable, Equatable, Hashable, Sendable {
    public let sourceMarkId: String
    public let targetMarkId: String

    public init(sourceMarkId: String, targetMarkId: String) {
        self.sourceMarkId = sourceMarkId
        self.targetMarkId = targetMarkId
    }
}

/// `GET /projects/:id/dependency-graph`: the whole project at once, folded, not a page of it.
public struct ProjectDependencyGraph: Codable, Equatable, Sendable {
    public let marks: [ProjectGraphMark]
    public let edges: [ProjectGraphEdge]
    /// Tasks behind the marks — the project's own size, not the number of things drawn.
    public let taskCount: Int
    /// The project is bigger than one request reads, or its fold than one response carries.
    public let truncated: Bool
    /// How many tasks one request reads — what `truncated` is measured against.
    public let maxTasks: Int?

    public init(marks: [ProjectGraphMark] = [], edges: [ProjectGraphEdge] = [], taskCount: Int? = nil,
                truncated: Bool = false, maxTasks: Int? = nil) {
        self.marks = marks
        self.edges = edges
        self.taskCount = taskCount ?? marks.count
        self.truncated = truncated
        self.maxTasks = maxTasks
    }

    private struct Limits: Codable {
        let maxTasks: Int?
    }

    enum CodingKeys: String, CodingKey {
        case marks, edges, taskCount, truncated, limits
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        marks = try c.decodeIfPresent([ProjectGraphMark].self, forKey: .marks) ?? []
        edges = try c.decodeIfPresent([ProjectGraphEdge].self, forKey: .edges) ?? []
        taskCount = try c.decodeIfPresent(Int.self, forKey: .taskCount) ?? marks.count
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
        maxTasks = (try? c.decodeIfPresent(Limits.self, forKey: .limits))?.maxTasks
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(marks, forKey: .marks)
        try c.encode(edges, forKey: .edges)
        try c.encode(taskCount, forKey: .taskCount)
        try c.encode(truncated, forKey: .truncated)
        try c.encode(Limits(maxTasks: maxTasks), forKey: .limits)
    }
}
