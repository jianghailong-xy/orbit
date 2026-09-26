import Foundation

// The task detail page's reads beside `GET /tasks/:id`, transcribed from the web's own types:
// `GET /tasks/:id/attribution` (`lib/attribution.ts`), `GET /tasks/:id/dependency-graph`
// (`lib/taskDependencyGraph.ts`), and the create body `POST /watches` takes (`lib/watches.ts`).
// Decoding is tolerant in the house style: an older server that omits a field must not blank the
// whole block, only the fact it did not send.

// MARK: - attribution

/// `GET /tasks/:id/attribution`: where the work counts, where it was noticed, which crossing
/// touches it and what blocks it. Every fact that is absent says why (`*AbsentReason`).
public struct TaskAttribution: Decodable, Equatable, Sendable {
    public let taskId: String
    public let owning: AttributionProjectRef?
    public let owningAbsentReason: String?
    public let discovery: AttributionDiscovery
    public let crossing: AttributionCrossing?
    public let crossingAbsentReason: String?
    public let blocker: AttributionBlocker?
    public let blockerAbsentReason: String?

    public init(taskId: String, owning: AttributionProjectRef? = nil, owningAbsentReason: String? = nil,
                discovery: AttributionDiscovery, crossing: AttributionCrossing? = nil,
                crossingAbsentReason: String? = nil, blocker: AttributionBlocker? = nil,
                blockerAbsentReason: String? = nil) {
        self.taskId = taskId
        self.owning = owning
        self.owningAbsentReason = owningAbsentReason
        self.discovery = discovery
        self.crossing = crossing
        self.crossingAbsentReason = crossingAbsentReason
        self.blocker = blocker
        self.blockerAbsentReason = blockerAbsentReason
    }

    enum CodingKeys: String, CodingKey {
        case taskId, owning, owningAbsentReason, discovery, crossing, crossingAbsentReason
        case blocker, blockerAbsentReason
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decodeIfPresent(String.self, forKey: .taskId) ?? ""
        owning = try c.decodeIfPresent(AttributionProjectRef.self, forKey: .owning)
        owningAbsentReason = try c.decodeIfPresent(String.self, forKey: .owningAbsentReason)
        discovery = try c.decodeIfPresent(AttributionDiscovery.self, forKey: .discovery)
            ?? AttributionDiscovery(recorded: false)
        crossing = try c.decodeIfPresent(AttributionCrossing.self, forKey: .crossing)
        crossingAbsentReason = try c.decodeIfPresent(String.self, forKey: .crossingAbsentReason)
        blocker = try c.decodeIfPresent(AttributionBlocker.self, forKey: .blocker)
        blockerAbsentReason = try c.decodeIfPresent(String.self, forKey: .blockerAbsentReason)
    }
}

public struct AttributionProjectRef: Decodable, Equatable, Sendable {
    public let projectId: String
    public let title: String
    /// `OPEN` / `DONE` / `CANCELLED`.
    public let status: String

    public init(projectId: String, title: String, status: String) {
        self.projectId = projectId
        self.title = title
        self.status = status
    }
}

public struct AttributionDiscovery: Decodable, Equatable, Sendable {
    public struct TaskRef: Decodable, Equatable, Sendable {
        public let taskId: String
        public let title: String
        public init(taskId: String, title: String) {
            self.taskId = taskId
            self.title = title
        }
    }

    public struct SessionRef: Decodable, Equatable, Sendable {
        public let sessionId: String
        public let title: String?
        public init(sessionId: String, title: String?) {
            self.sessionId = sessionId
            self.title = title
        }
    }

    public let project: AttributionProjectRef?
    public let triggerEvent: String?
    public let task: TaskRef?
    public let session: SessionRef?
    public let recorded: Bool
    public let absentReason: String?
    /// `EVIDENCE_ONLY`: where the work was found grants nothing about where it may be filed.
    public let authority: String

    public init(project: AttributionProjectRef? = nil, triggerEvent: String? = nil, task: TaskRef? = nil,
                session: SessionRef? = nil, recorded: Bool, absentReason: String? = nil,
                authority: String = "EVIDENCE_ONLY") {
        self.project = project
        self.triggerEvent = triggerEvent
        self.task = task
        self.session = session
        self.recorded = recorded
        self.absentReason = absentReason
        self.authority = authority
    }

    enum CodingKeys: String, CodingKey {
        case project, triggerEvent, task, session, recorded, absentReason, authority
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        project = try c.decodeIfPresent(AttributionProjectRef.self, forKey: .project)
        triggerEvent = try c.decodeIfPresent(String.self, forKey: .triggerEvent)
        task = try c.decodeIfPresent(TaskRef.self, forKey: .task)
        session = try c.decodeIfPresent(SessionRef.self, forKey: .session)
        recorded = try c.decodeIfPresent(Bool.self, forKey: .recorded) ?? false
        absentReason = try c.decodeIfPresent(String.self, forKey: .absentReason)
        authority = try c.decodeIfPresent(String.self, forKey: .authority) ?? "EVIDENCE_ONLY"
    }
}

public struct AttributionCrossing: Decodable, Equatable, Sendable {
    /// `PENDING` / `APPROVED` / `DENIED` / `APPLIED`.
    public let state: String
    public let from: AttributionProjectRef?
    public let to: AttributionProjectRef?
    public let code: String?
    public let requiredAction: String?

    public init(state: String, from: AttributionProjectRef? = nil, to: AttributionProjectRef? = nil,
                code: String? = nil, requiredAction: String? = nil) {
        self.state = state
        self.from = from
        self.to = to
        self.code = code
        self.requiredAction = requiredAction
    }
}

public struct AttributionBlocker: Decodable, Equatable, Sendable {
    public let kind: String
    public let owner: String
    public let requiredAction: String
    public let nextCheckAt: String
    public let code: String?

    public init(kind: String, owner: String, requiredAction: String, nextCheckAt: String, code: String? = nil) {
        self.kind = kind
        self.owner = owner
        self.requiredAction = requiredAction
        self.nextCheckAt = nextCheckAt
        self.code = code
    }
}

// MARK: - dependency graph

/// `GET /tasks/:id/dependency-graph`: the task's weakly connected dependency component around it.
/// Edges always run prerequisite → the task waiting for it, so arrows flow toward the focus.
public struct TaskDependencyGraph: Decodable, Equatable, Sendable {
    public struct Node: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let status: String
        public let running: Bool
        public let queued: Bool
        public let depth: Int?

        public init(id: String, title: String, status: String, running: Bool = false, queued: Bool = false,
                    depth: Int? = nil) {
            self.id = id
            self.title = title
            self.status = status
            self.running = running
            self.queued = queued
            self.depth = depth
        }

        enum CodingKeys: String, CodingKey { case id, title, status, running, queued, depth }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            status = try c.decodeIfPresent(String.self, forKey: .status) ?? "OPEN"
            running = try c.decodeIfPresent(Bool.self, forKey: .running) ?? false
            queued = try c.decodeIfPresent(Bool.self, forKey: .queued) ?? false
            depth = try c.decodeIfPresent(Int.self, forKey: .depth)
        }
    }

    public struct Edge: Decodable, Equatable, Hashable, Sendable {
        public let sourceTaskId: String
        public let targetTaskId: String

        public init(sourceTaskId: String, targetTaskId: String) {
            self.sourceTaskId = sourceTaskId
            self.targetTaskId = targetTaskId
        }
    }

    public struct Counts: Decodable, Equatable, Sendable {
        public let upstream: Int
        public let downstream: Int?

        public init(upstream: Int, downstream: Int?) {
            self.upstream = upstream
            self.downstream = downstream
        }
    }

    public struct CollapsedGroup: Decodable, Equatable, Sendable {
        public let hiddenCount: Int
        public let cursor: String?

        public init(hiddenCount: Int, cursor: String? = nil) {
            self.hiddenCount = hiddenCount
            self.cursor = cursor
        }
    }

    public struct Limits: Decodable, Equatable, Sendable {
        public let maxDepth: Int?
        public let maxNodes: Int?
        public let maxEdges: Int?

        public init(maxDepth: Int? = nil, maxNodes: Int? = nil, maxEdges: Int? = nil) {
            self.maxDepth = maxDepth
            self.maxNodes = maxNodes
            self.maxEdges = maxEdges
        }
    }

    public let focusTaskId: String
    public let nodes: [Node]
    public let edges: [Edge]
    public let counts: Counts?
    /// The snapshot stops short of the whole component (the summary then says `loaded`).
    public let truncated: Bool
    public let limits: Limits?
    public let collapsedGroups: [CollapsedGroup]
    public let truncatedEdges: Bool

    public init(focusTaskId: String, nodes: [Node], edges: [Edge], counts: Counts? = nil, truncated: Bool = false,
                limits: Limits? = nil, collapsedGroups: [CollapsedGroup] = [], truncatedEdges: Bool = false) {
        self.focusTaskId = focusTaskId
        self.nodes = nodes
        self.edges = edges
        self.counts = counts
        self.truncated = truncated
        self.limits = limits
        self.collapsedGroups = collapsedGroups
        self.truncatedEdges = truncatedEdges
    }

    enum CodingKeys: String, CodingKey {
        case focusTaskId, nodes, edges, counts, truncated, limits, collapsedGroups, truncatedEdges
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        focusTaskId = try c.decode(String.self, forKey: .focusTaskId)
        nodes = try c.decodeIfPresent([Node].self, forKey: .nodes) ?? []
        edges = try c.decodeIfPresent([Edge].self, forKey: .edges) ?? []
        counts = try c.decodeIfPresent(Counts.self, forKey: .counts)
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
        limits = try c.decodeIfPresent(Limits.self, forKey: .limits)
        collapsedGroups = try c.decodeIfPresent([CollapsedGroup].self, forKey: .collapsedGroups) ?? []
        truncatedEdges = try c.decodeIfPresent(Bool.self, forKey: .truncatedEdges) ?? false
    }
}

// MARK: - following a task

/// `POST /watches`: follow targets. The web's `createWatchBody` — the predicate in the editor's
/// grammar version, the targets, what to do when it holds, until when, and one key per dialog so a
/// retried Follow returns the watch the first press made.
public struct CreateWatchRequest: Encodable, Equatable, Sendable {
    public struct Target: Encodable, Equatable, Sendable {
        public let kind: WatchTargetKind
        public let id: String
    }

    public let predicateVersion: Int
    public let predicate: WatchPredicate
    public let targets: [Target]
    public let action: WatchAction
    public let ttlSeconds: Int
    public let idempotencyKey: String

    public init(taskID: String, predicate: WatchPredicate, ttlSeconds: Int, idempotencyKey: String) {
        predicateVersion = WatchPredicate.version
        self.predicate = predicate
        targets = [Target(kind: .task, id: taskID)]
        action = .notifyUser
        self.ttlSeconds = ttlSeconds
        self.idempotencyKey = idempotencyKey
    }
}
