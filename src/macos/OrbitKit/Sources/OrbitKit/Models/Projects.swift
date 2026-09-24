import Foundation

/// A project as the projects index lists it (`GET /projects`), mirroring the row the web's
/// `ProjectsPage` draws and `@orbit/shared`'s `project-progress.ts` declares.
///
/// The index row, not the document: the server deliberately leaves the criteria, instructions and
/// per-status tally off it (they are `GET /projects/:id`'s), and carries instead the three facts a
/// list needs — the seven task lanes, the most recent task write, and who has to act.
///
/// Every field this build does not know is ignored and every field an older server does not send
/// decodes to its empty form, so a rolling deploy on either side never makes the list fail to load.

/// Where a project stands as a record: still being worked, finished, or given up on.
public enum ProjectStatus: String, Codable, Sendable, CaseIterable {
    case open = "OPEN"
    case done = "DONE"
    case cancelled = "CANCELLED"
    /// Forward-compatibility floor: a status this build does not know is shown as closed work
    /// rather than failing the list that carried it.
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ProjectStatus(rawValue: raw) ?? .unknown
    }

    public var label: String {
        switch self {
        case .open: return "Open"
        case .done: return "Done"
        case .cancelled: return "Cancelled"
        case .unknown: return "Unknown"
        }
    }
}

/// The lanes every task of a project falls in exactly once (`ProjectPanoramaBuckets`): the same
/// classification the project page, the task cards and the dispatcher read.
public struct ProjectBuckets: Codable, Equatable, Sendable {
    public let running: Int
    /// Nothing is owed to it — it could start now.
    public let ready: Int
    /// Waiting on a prerequisite.
    public let blocked: Int
    public let awaitingVerification: Int
    public let done: Int
    /// Nil only from a server that predates the lane; ``ProjectAttention/failedTaskCount(_:)``
    /// derives it then, as the web does.
    public let failed: Int?
    public let cancelled: Int

    public init(running: Int = 0, ready: Int = 0, blocked: Int = 0, awaitingVerification: Int = 0,
                done: Int = 0, failed: Int? = 0, cancelled: Int = 0) {
        self.running = running
        self.ready = ready
        self.blocked = blocked
        self.awaitingVerification = awaitingVerification
        self.done = done
        self.failed = failed
        self.cancelled = cancelled
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        running = try c.decodeIfPresent(Int.self, forKey: .running) ?? 0
        ready = try c.decodeIfPresent(Int.self, forKey: .ready) ?? 0
        blocked = try c.decodeIfPresent(Int.self, forKey: .blocked) ?? 0
        awaitingVerification = try c.decodeIfPresent(Int.self, forKey: .awaitingVerification) ?? 0
        done = try c.decodeIfPresent(Int.self, forKey: .done) ?? 0
        failed = try c.decodeIfPresent(Int.self, forKey: .failed)
        cancelled = try c.decodeIfPresent(Int.self, forKey: .cancelled) ?? 0
    }
}

/// What the project's coordinator can be holding (`COORDINATOR_LEAD_KINDS`): the exception kinds
/// that are not the owner's from birth.
public enum CoordinatorLeadKind: String, Codable, Sendable, CaseIterable {
    case integrationConflict = "INTEGRATION_CONFLICT"
    case integrationCheckFailed = "INTEGRATION_CHECK_FAILED"
    case integrationError = "INTEGRATION_ERROR"
    case taskFailed = "TASK_FAILED"
    /// Forward-compatibility floor: the chip then says only that the coordinator is on something.
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CoordinatorLeadKind(rawValue: raw) ?? .unknown
    }
}

/// How loud the loudest open USER-owned blocker is.
public enum ProjectAttentionSeverity: String, Codable, Sendable {
    case info = "INFO"
    case warning = "WARNING"
    case critical = "CRITICAL"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ProjectAttentionSeverity(rawValue: raw) ?? .unknown
    }
}

/// One of the four things a project waits on its owner for, aggregated per kind (§7.1 V1).
public struct ProjectListOwnerItem: Codable, Equatable, Sendable {
    public let kind: OwnerItemKind
    public let count: Int
    /// How long the owner has been asked: the oldest open item of this kind.
    public let oldestWaitingSince: String

    public init(kind: OwnerItemKind, count: Int, oldestWaitingSince: String) {
        self.kind = kind
        self.count = count
        self.oldestWaitingSince = oldestWaitingSince
    }
}

/// What the coordinator is holding, led by the item that has waited longest (§7.1 V1).
public struct ProjectListCoordinatorItems: Codable, Equatable, Sendable {
    public let count: Int
    public let leadKind: CoordinatorLeadKind
    public let oldestWaitingSince: String
    public let nextEscalationAt: String?

    public init(count: Int, leadKind: CoordinatorLeadKind, oldestWaitingSince: String,
                nextEscalationAt: String? = nil) {
        self.count = count
        self.leadKind = leadKind
        self.oldestWaitingSince = oldestWaitingSince
        self.nextEscalationAt = nextEscalationAt
    }
}

/// Who must act on a project, and how long they have had to (`ProjectListAttention`).
public struct ProjectListAttention: Codable, Equatable, Sendable {
    public let userBlockers: Int
    public let coordinatorBlockers: Int
    public let systemBlockers: Int
    public let maxSeverity: ProjectAttentionSeverity?
    public let attentionSinceAt: String?
    public let nextCheckAt: String?
    public let ownerItems: [ProjectListOwnerItem]
    public let coordinatorItems: ProjectListCoordinatorItems?

    public init(userBlockers: Int = 0, coordinatorBlockers: Int = 0, systemBlockers: Int = 0,
                maxSeverity: ProjectAttentionSeverity? = nil, attentionSinceAt: String? = nil,
                nextCheckAt: String? = nil, ownerItems: [ProjectListOwnerItem] = [],
                coordinatorItems: ProjectListCoordinatorItems? = nil) {
        self.userBlockers = userBlockers
        self.coordinatorBlockers = coordinatorBlockers
        self.systemBlockers = systemBlockers
        self.maxSeverity = maxSeverity
        self.attentionSinceAt = attentionSinceAt
        self.nextCheckAt = nextCheckAt
        self.ownerItems = ownerItems
        self.coordinatorItems = coordinatorItems
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userBlockers = try c.decodeIfPresent(Int.self, forKey: .userBlockers) ?? 0
        coordinatorBlockers = try c.decodeIfPresent(Int.self, forKey: .coordinatorBlockers) ?? 0
        systemBlockers = try c.decodeIfPresent(Int.self, forKey: .systemBlockers) ?? 0
        maxSeverity = try c.decodeIfPresent(ProjectAttentionSeverity.self, forKey: .maxSeverity)
        attentionSinceAt = try c.decodeIfPresent(String.self, forKey: .attentionSinceAt)
        nextCheckAt = try c.decodeIfPresent(String.self, forKey: .nextCheckAt)
        ownerItems = try c.decodeIfPresent([ProjectListOwnerItem].self, forKey: .ownerItems) ?? []
        coordinatorItems = try c.decodeIfPresent(ProjectListCoordinatorItems.self,
                                                 forKey: .coordinatorItems)
    }
}

/// Where a project's finished tasks land: straight onto the upstream, or onto a branch of its own.
public enum IntegrationLine: String, Codable, Sendable {
    case main = "MAIN"
    case projectBranch = "PROJECT_BRANCH"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = IntegrationLine(rawValue: raw) ?? .unknown
    }
}

/// The line a list row states beside its title (`ProjectListIntegration`).
public struct ProjectListIntegration: Codable, Equatable, Sendable {
    public let line: IntegrationLine
    /// The branch's own name, as a merge receipt spells it (no `refs/heads/`).
    public let ref: String

    public init(line: IntegrationLine, ref: String) {
        self.line = line
        self.ref = ref
    }
}

/// One row of `GET /projects`.
public struct ProjectSummary: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let status: ProjectStatus
    public let goal: String?
    public let createdAt: String
    public let updatedAt: String?
    /// The whole task population, settled work included — every lane of ``buckets`` sums to it.
    public let taskCount: Int
    public let buckets: ProjectBuckets
    /// The most recent task write, or nil when the project has never held a task.
    public let lastActivityAt: String?
    /// Nil only from a server that predates the aggregate.
    public let attention: ProjectListAttention?
    /// Nil when nobody has decided a line and nothing has integrated yet.
    public let integration: ProjectListIntegration?

    public init(id: String, title: String, status: ProjectStatus = .open, goal: String? = nil,
                createdAt: String = "", updatedAt: String? = nil, taskCount: Int = 0,
                buckets: ProjectBuckets = ProjectBuckets(), lastActivityAt: String? = nil,
                attention: ProjectListAttention? = nil, integration: ProjectListIntegration? = nil) {
        self.id = id
        self.title = title
        self.status = status
        self.goal = goal
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.taskCount = taskCount
        self.buckets = buckets
        self.lastActivityAt = lastActivityAt
        self.attention = attention
        self.integration = integration
    }

    private struct Counts: Codable {
        let tasks: Int?
    }

    enum CodingKeys: String, CodingKey {
        case id, title, status, goal, createdAt, updatedAt, buckets, lastActivityAt, attention,
             integration
        case counts = "_count"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        status = try c.decodeIfPresent(ProjectStatus.self, forKey: .status) ?? .unknown
        goal = try c.decodeIfPresent(String.self, forKey: .goal)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        taskCount = try c.decodeIfPresent(Counts.self, forKey: .counts)?.tasks ?? 0
        buckets = try c.decodeIfPresent(ProjectBuckets.self, forKey: .buckets) ?? ProjectBuckets()
        lastActivityAt = try c.decodeIfPresent(String.self, forKey: .lastActivityAt)
        attention = try c.decodeIfPresent(ProjectListAttention.self, forKey: .attention)
        integration = try c.decodeIfPresent(ProjectListIntegration.self, forKey: .integration)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(status, forKey: .status)
        try c.encodeIfPresent(goal, forKey: .goal)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(updatedAt, forKey: .updatedAt)
        try c.encode(Counts(tasks: taskCount), forKey: .counts)
        try c.encode(buckets, forKey: .buckets)
        try c.encodeIfPresent(lastActivityAt, forKey: .lastActivityAt)
        try c.encodeIfPresent(attention, forKey: .attention)
        try c.encodeIfPresent(integration, forKey: .integration)
    }
}
