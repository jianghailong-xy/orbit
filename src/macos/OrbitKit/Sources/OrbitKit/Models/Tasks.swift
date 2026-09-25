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
    /// The project this task is filed under, and how the attempt ended when it did so by being
    /// replaced or dropped. Both are read by `TaskReopen`'s question and by nothing else here: the
    /// panel's Reopen sentence about the project is only true of work filed under one, and the
    /// sentence about a cleared record is only true of a row that carries one.
    public let projectId: String?
    public let terminalReason: String?
    /// Which of the four completion criteria settles this task. Carried on every task payload, so a
    /// panel can tell an OWNER_CONFIRMED task from the three a run or a verifier settles without a
    /// second read (`OwnerConfirmations.panelAction`).
    public let completionCriterion: String?
    /// Per-task run override: the provider/model this task's runs use instead of the assignee
    /// agent's own. Both nil = inherit from the assignee (the common case).
    public let provider: String?
    public let model: String?
    public let autoRunWhenReady: Bool?
    public let creatorSessionId: String?
    public let creatorType: String?
    public let creatorId: String?
    public let creatorName: String?
    public let createdAt: String?
    public let updatedAt: String?

    // How this row is settled, and — on a row with no work of its own — the check that does it.
    // Absent on an older server, which reads as "no gate row": the detail only ever asks these
    // through `TaskJudgment`, and the answer it needs from a missing field is the same one an
    // unset verdict gives. See `TaskJudgment.isGateRow` for the predicate they spell. The
    // criterion beside them is declared above, with the payload's other scalars.
    /// `MANUAL` (this row has work) or `VERIFICATION_PASSED` (a verdict settles it).
    public let completionPolicy: String?
    /// `verifies_task_id`: the subject this row checks. Non-null exactly on a check row.
    public let verifiesTaskId: String?
    /// Where a subject's check stands: MISSING / PENDING / RUNNING / BLOCKED / FAILED / PASSED.
    public let verificationState: String?
    /// The check that currently settles this row, from the detail read.
    public let verifier: TaskVerifierRef?

    // What Copy as Markdown reads besides the fields above (`ShareMarkdown.task`): what settles the
    // task, and what replaced it or what it replaced. Detail payload only.
    public let acceptanceCriteria: String?
    public let acceptanceCommand: String?
    public let acceptanceExpectedExitCode: Int?
    /// Why a superseded task names no successor (`SUCCESSOR_DELETED` when it was deleted).
    public let supersededByTaskIdAbsentReason: String?
    /// The attempts this task replaced.
    public let supersedes: [TaskRef]?
    /// What replaced this task, oldest first: the last one is the live attempt.
    public let successorChain: [TaskRef]?

    // Computed list-view flags (absent on the detail payload).
    public let running: Bool?
    public let queued: Bool?
    public let blocked: Bool?
    public let dependencyState: String?
    /// Authoritative server Ready predicate on incremental list-row reads. Full Ready pages are
    /// already filtered server-side and older/detail payloads omit it, so presentation logic keeps
    /// its compatibility fallback when nil.
    public let runnable: Bool?

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
        case id, title, description, status, assigneeId, listId, dueDate, provider, model
        case projectId, terminalReason
        case completionCriterion
        case autoRunWhenReady
        case creatorSessionId, creatorType, creatorId, creatorName, createdAt, updatedAt
        case completionPolicy, verifiesTaskId, verificationState, verifier
        case acceptanceCriteria, acceptanceCommand, acceptanceExpectedExitCode
        case supersededByTaskIdAbsentReason, supersedes, successorChain
        case running, queued, blocked, dependencyState, runnable
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

/// The check that currently settles a task, as the detail read returns it. The same current check
/// the project page's lanes and its graph read, so a card cannot name a different check than the
/// one that decides the row. `verdict` is the conclusion it wrote, absent until it writes one.
public struct TaskVerifierRef: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String?
    public let verdict: String?
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
    public let runState: SessionRunState?
    public let sessionState: SessionState?
    public let endReason: String?
    public let archivedAt: String?
    public let deletedAt: String?
    public let createdAt: String?
    public let agent: AgentNameRef?

    /// Resolve the task detail's modern run state first, retaining compatibility with older
    /// servers that only returned the raw runner status or the legacy mixed session state.
    public var resolvedRunState: SessionRunState? {
        SessionRunState.resolveOptional(runState, legacy: sessionState,
                                        status: status, endReason: endReason)
    }
}

public struct AgentNameRef: Codable, Equatable, Sendable {
    public let name: String?
}

// MARK: - list/page responses

/// A user-created task list as returned by `GET /task-lists`. `runningTasks` and `completed`
/// are server-derived navigation state: a busy list stays active even when its other tasks are
/// done, and an empty list is never considered completed.
public struct TaskListSummary: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let createdAt: String?
    public let updatedAt: String?
    public let runningTasks: Int?
    public let completed: Bool?
    public let counts: TaskListCounts?

    public var taskCount: Int { counts?.tasks ?? 0 }

    enum CodingKeys: String, CodingKey {
        case id, title, createdAt, updatedAt, runningTasks, completed
        case counts = "_count"
    }
}

public struct TaskListCounts: Codable, Equatable, Sendable {
    public let tasks: Int?
}

/// A named list detail. Its task rows use the same list shape as `GET /tasks`, including live
/// run/dependency overlays, so the native list can render either endpoint identically.
public struct TaskListDetail: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let createdAt: String?
    public let updatedAt: String?
    public let tasks: [TaskItem]
}

/// Aggregate counts are scoped to the selected list (or No list), but deliberately ignore the
/// active status/search filter. This keeps the filter badges and progress summary stable.
public struct TaskPageCounts: Codable, Equatable, Sendable {
    public let total: Int
    public let open: Int
    public let inProgress: Int
    public let done: Int
    public let failed: Int
    public let cancelled: Int
    public let running: Int
    public let queued: Int
    public let runnable: Int
}

/// How much aggregate metadata `GET /tasks/page` should compute. `.full` omits the query parameter
/// and keeps the legacy response; `.total` skips the scope-wide status/runnable block, and `.none`
/// returns rows + cursor only (the mode used for later pages and cheap reconciliation).
///
/// This enum is deliberately passed non-optionally with a `.full` default. If its parameter were
/// optional, Swift would interpret a call written `counts: .none` as `Optional.none` and silently
/// omit the query item instead of selecting the wire's `counts=none` mode.
public enum TaskPageCountsMode: String, Codable, Equatable, Sendable {
    case full
    case none
    case total
}

/// Cursor page returned by `GET /tasks/page`. The cursor is opaque and must be passed back as-is.
/// `total` is absent for `counts=none`; `counts` is absent for both reduced aggregate modes.
public struct TaskPage: Codable, Equatable, Sendable {
    public let items: [TaskItem]
    public let nextCursor: String?
    public let total: Int?
    public let counts: TaskPageCounts?
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

/// PATCH /tasks/:id — `assigneeId`/`listId`/`dueDate`/`provider`/`model` are three-state (omit /
/// null=clear / set), mirroring `UpdateTaskDto` where they're typed `string | null`.
/// `dependsOnTaskIds` replaces the complete prerequisite set when present: nil omits the field,
/// [] clears it.
public struct UpdateTaskRequest: Encodable, Sendable {
    public var title: String?
    public var description: String?
    public var status: TaskStatus?
    public var assigneeId: FieldUpdate<String>
    public var listId: FieldUpdate<String>
    public var dueDate: FieldUpdate<String>
    public var provider: FieldUpdate<String>
    public var model: FieldUpdate<String>
    public var dependsOnTaskIds: [String]?
    public var autoRunWhenReady: Bool?
    /// `supersededByTaskId`/`terminalReason` are three-state like the four above, and the two are
    /// one edit: a row that names a successor or a terminal reason is retired, and CLEARING both in
    /// the same request as a status write is what `TasksService.update`'s SU4 guard asks for before
    /// it will let a replaced attempt go back to OPEN. `TaskReopen.request` is the caller that does
    /// exactly that; nothing else here writes either field.
    public var supersededByTaskId: FieldUpdate<String>
    public var terminalReason: FieldUpdate<String>

    public init(title: String? = nil, description: String? = nil, status: TaskStatus? = nil,
                assigneeId: FieldUpdate<String> = .keep, listId: FieldUpdate<String> = .keep,
                dueDate: FieldUpdate<String> = .keep, provider: FieldUpdate<String> = .keep,
                model: FieldUpdate<String> = .keep, dependsOnTaskIds: [String]? = nil,
                autoRunWhenReady: Bool? = nil,
                supersededByTaskId: FieldUpdate<String> = .keep,
                terminalReason: FieldUpdate<String> = .keep) {
        self.title = title
        self.description = description
        self.status = status
        self.assigneeId = assigneeId
        self.listId = listId
        self.dueDate = dueDate
        self.provider = provider
        self.model = model
        self.dependsOnTaskIds = dependsOnTaskIds
        self.autoRunWhenReady = autoRunWhenReady
        self.supersededByTaskId = supersededByTaskId
        self.terminalReason = terminalReason
    }

    enum CodingKeys: String, CodingKey {
        case title, description, status, assigneeId, listId, dueDate, provider, model
        case dependsOnTaskIds, autoRunWhenReady
        case supersededByTaskId, terminalReason
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(description, forKey: .description)
        try c.encodeIfPresent(status, forKey: .status)
        try assigneeId.encode(into: &c, forKey: .assigneeId)
        try listId.encode(into: &c, forKey: .listId)
        try dueDate.encode(into: &c, forKey: .dueDate)
        try provider.encode(into: &c, forKey: .provider)
        try model.encode(into: &c, forKey: .model)
        try c.encodeIfPresent(dependsOnTaskIds, forKey: .dependsOnTaskIds)
        try c.encodeIfPresent(autoRunWhenReady, forKey: .autoRunWhenReady)
        try supersededByTaskId.encode(into: &c, forKey: .supersededByTaskId)
        try terminalReason.encode(into: &c, forKey: .terminalReason)
    }
}

/// POST /tasks/:id/execute — the body of one Run now.
///
/// `triggerId` names the PRESS, not the run: the server keys this request's receipt on it, so every
/// resend of one press — the 401 refresh-and-retry inside `APIClient.send`, a resend after a
/// timeout, a second press over a visible failure — is answered from the first one's answer instead
/// of starting a second run. A client that sends no body at all keeps working exactly as it did and
/// is owed no such promise: a name the server minted is one this client never saw and cannot repeat.
public struct RunTaskRequest: Encodable, Sendable {
    public let triggerId: String
    public init(triggerId: String) { self.triggerId = triggerId }
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
