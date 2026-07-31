import Foundation

// Task DTOs mirroring src/apiserver/src/tasks (controller routes + service include shapes).
// The model type is `TaskItem`, NOT `Task`, so it doesn't shadow Swift concurrency's `Task`
// inside OrbitKit (EventStream et al. rely on `Task { … }`). Fields are generously optional so
// the list row (computed flags + `_count`) and the richer detail payload (comments / sessions /
// dependency edges) both decode through one type — matching DTOs.swift's tolerant style.

/// A task. `GET /tasks` returns the scalar columns + `assignee` (with its runner) + `_count` +
/// the computed `running`/`queued`/`blocked`/`dependencyState`; `GET /tasks/:id` instead adds
/// `comments` (author-resolved), `sessions`, `creatorSession`, and the dependency edges.
public struct TaskItem: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let description: String?
    public let status: TaskStatus
    public let assigneeId: String?
    public let listId: String?
    public let dueDate: String?
    public let autoRunWhenReady: Bool?
    public let creatorSessionId: String?
    public let createdAt: String?
    public let updatedAt: String?

    // Computed list-view flags (absent on the detail payload).
    public let running: Bool?
    public let queued: Bool?
    public let blocked: Bool?
    public let dependencyState: String?

    // Nested relations.
    public let assignee: TaskAssignee?
    public let comments: [TaskComment]?
    public let sessions: [SessionRef]?
    public let creatorSession: SessionRef?
    public let dependsOn: [DependencyEdge]?
    public let dependedOnBy: [DependencyEdge]?

    // `_count: { comments }` on the list payload.
    public let counts: TaskCounts?

    /// Comment count from whichever shape is present (`_count` on list, the array on detail).
    public var commentCount: Int? { counts?.comments ?? comments?.count }

    enum CodingKeys: String, CodingKey {
        case id, title, description, status, assigneeId, listId, dueDate, autoRunWhenReady
        case creatorSessionId, createdAt, updatedAt
        case running, queued, blocked, dependencyState
        case assignee, comments, sessions, creatorSession, dependsOn, dependedOnBy
        case counts = "_count"
    }
}

/// `assignee` on the list payload carries its runner (for the batch-run modal); on detail it's
/// just `{id,name,model}`. The runner fields are optional so both shapes decode.
public struct TaskAssignee: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String?
    public let model: String?
    public let runnerId: String?
    public let runner: RunnerRef?
}

public struct RunnerRef: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String?
    public let displayName: String?
    public let maxConcurrent: Int?
}

public struct TaskCounts: Codable, Equatable, Sendable {
    public let comments: Int?
}

public struct TaskComment: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let body: String
    public let authorType: String?
    public let authorId: String?
    /// Resolved server-side (the author is polymorphic USER|AGENT, no FK).
    public let authorName: String?
    public let createdAt: String?
}

/// Lightweight `{id,title,status}` for a *task* (dependency edges) — `status` is a `TaskStatus`.
public struct TaskRef: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String?
    public let status: TaskStatus?
}

/// A dependency edge. `dependsOn` entries carry `dependsOnTask` (the prerequisite); `dependedOnBy`
/// entries carry `task` (the dependent). Both keys are optional so either edge list decodes here.
public struct DependencyEdge: Codable, Equatable, Sendable {
    public let dependsOnTask: TaskRef?
    public let task: TaskRef?
}

/// Lightweight reference to a *session* — used by both `sessions` (runs under the task) and
/// `creatorSession` (the run that authored it). `status` is a `RunStatus`, NOT a `TaskStatus`;
/// `agent`/`createdAt` are absent on `creatorSession`, hence optional.
public struct SessionRef: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String?
    public let status: RunStatus?
    public let createdAt: String?
    public let agent: AgentNameRef?
}

public struct AgentNameRef: Codable, Equatable, Sendable {
    public let name: String?
}

// MARK: - requests

/// POST /tasks
public struct CreateTaskRequest: Encodable, Sendable {
    public let title: String
    public let description: String?
    public let assigneeId: String?
    public let listId: String?
    public let dueDate: String?
    public let dependsOnTaskIds: [String]?
    public let autoRunWhenReady: Bool?
    public init(title: String, description: String? = nil, assigneeId: String? = nil,
                listId: String? = nil, dueDate: String? = nil,
                dependsOnTaskIds: [String]? = nil, autoRunWhenReady: Bool? = nil) {
        self.title = title
        self.description = description
        self.assigneeId = assigneeId
        self.listId = listId
        self.dueDate = dueDate
        self.dependsOnTaskIds = dependsOnTaskIds
        self.autoRunWhenReady = autoRunWhenReady
    }
}

/// PATCH /tasks/:id — `assigneeId`/`listId`/`dueDate` are three-state (omit / null=clear / set),
/// mirroring `UpdateTaskDto` where they're typed `string | null`. `dependsOnTaskIds` replaces
/// the complete prerequisite set when present: nil omits the field, [] clears it.
public struct UpdateTaskRequest: Encodable, Sendable {
    public var title: String?
    public var description: String?
    public var status: TaskStatus?
    public var assigneeId: FieldUpdate<String>
    public var listId: FieldUpdate<String>
    public var dueDate: FieldUpdate<String>
    public var dependsOnTaskIds: [String]?
    public var autoRunWhenReady: Bool?

    public init(title: String? = nil, description: String? = nil, status: TaskStatus? = nil,
                assigneeId: FieldUpdate<String> = .keep, listId: FieldUpdate<String> = .keep,
                dueDate: FieldUpdate<String> = .keep, dependsOnTaskIds: [String]? = nil,
                autoRunWhenReady: Bool? = nil) {
        self.title = title
        self.description = description
        self.status = status
        self.assigneeId = assigneeId
        self.listId = listId
        self.dueDate = dueDate
        self.dependsOnTaskIds = dependsOnTaskIds
        self.autoRunWhenReady = autoRunWhenReady
    }

    enum CodingKeys: String, CodingKey {
        case title, description, status, assigneeId, listId, dueDate, dependsOnTaskIds, autoRunWhenReady
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(description, forKey: .description)
        try c.encodeIfPresent(status, forKey: .status)
        try assigneeId.encode(into: &c, forKey: .assigneeId)
        try listId.encode(into: &c, forKey: .listId)
        try dueDate.encode(into: &c, forKey: .dueDate)
        try c.encodeIfPresent(dependsOnTaskIds, forKey: .dependsOnTaskIds)
        try c.encodeIfPresent(autoRunWhenReady, forKey: .autoRunWhenReady)
    }
}

/// POST /tasks/batch-execute — `maxConcurrent` caps only this batch, not any runner's cap.
public struct BatchExecuteRequest: Encodable, Sendable {
    public let taskIds: [String]
    public let maxConcurrent: Int?
    public init(taskIds: [String], maxConcurrent: Int? = nil) {
        self.taskIds = taskIds
        self.maxConcurrent = maxConcurrent
    }
}

/// POST /tasks/batch-stop
public struct BatchStopRequest: Encodable, Sendable {
    public let taskIds: [String]
    public init(taskIds: [String]) { self.taskIds = taskIds }
}

/// POST /tasks/batch-assign — `assigneeId` nil clears the assignment (sent as explicit null,
/// never omitted: batch-assign always sets, there is no "leave unchanged").
public struct BatchAssignRequest: Encodable, Sendable {
    public let taskIds: [String]
    public let assigneeId: String?
    public init(taskIds: [String], assigneeId: String?) {
        self.taskIds = taskIds
        self.assigneeId = assigneeId
    }
    enum CodingKeys: String, CodingKey { case taskIds, assigneeId }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(taskIds, forKey: .taskIds)
        if let assigneeId { try c.encode(assigneeId, forKey: .assigneeId) }
        else { try c.encodeNil(forKey: .assigneeId) }
    }
}

/// POST /tasks/:id/comments — `mentions` are agent ids @-mentioned (notified + triggered).
public struct CreateTaskCommentRequest: Encodable, Sendable {
    public let body: String
    public let mentions: [String]?
    public init(body: String, mentions: [String]? = nil) {
        self.body = body
        self.mentions = mentions
    }
}

/// POST /tasks/:id/dependencies
public struct AddDependencyRequest: Encodable, Sendable {
    public let dependsOnTaskId: String
    public init(dependsOnTaskId: String) { self.dependsOnTaskId = dependsOnTaskId }
}
