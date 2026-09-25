import Foundation

/// The reads behind one project's page, mirroring the shapes the web's `ProjectDetailPage` draws:
/// the project document (`GET /projects/:id`), its work lanes (`/panorama`), its integration line
/// (`/integration`), its coordinator (`/coordinator/status`) and a page of its tasks (`/tasks/page`).
///
/// Decoded tolerantly, like every model here: a field this build does not know is ignored, one an
/// older server does not send decodes to its empty form, and an enum value from a newer server lands
/// on its `unknown` floor instead of failing the page.

/// Decodes a server `bigint` column, which `BigInt.prototype.toJSON` sends as a decimal string, from
/// either spelling — compared as text, never parsed.
private func decodeDecimal<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) -> String? {
    if let text = try? c.decodeIfPresent(String.self, forKey: key) { return text }
    if let number = try? c.decodeIfPresent(Int.self, forKey: key) { return String(number) }
    return nil
}

// MARK: - GET /projects/:id

/// One task standing between a criterion and its work having met it, and what would settle it.
public struct ProjectCriterionHeldUpBy: Codable, Equatable, Sendable {
    public let taskId: String
    public let title: String
    /// A code out of the completion table (`RUN_ACCEPTANCE_COMMAND`, …).
    public let requiredAction: String

    public init(taskId: String, title: String, requiredAction: String) {
        self.taskId = taskId
        self.title = title
        self.requiredAction = requiredAction
    }
}

/// One clause of the derivation that does not hold, and the work holding it open.
public struct ProjectCriterionUnmet: Codable, Equatable, Sendable {
    public let clause: String
    public let heldUpBy: [ProjectCriterionHeldUpBy]

    public init(clause: String, heldUpBy: [ProjectCriterionHeldUpBy] = []) {
        self.clause = clause
        self.heldUpBy = heldUpBy
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        clause = try c.decode(String.self, forKey: .clause)
        heldUpBy = try c.decodeIfPresent([ProjectCriterionHeldUpBy].self, forKey: .heldUpBy) ?? []
    }
}

/// One stated criterion and what the read says about the WORK filed under it. `satisfied` absent is
/// the read declining to answer — a third state, never merged with "no".
public struct ProjectCriterion: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let ordinal: Int
    public let text: String
    public let satisfied: Bool?
    public let unmet: [ProjectCriterionUnmet]
    /// `LANDED`, `UNKNOWN` (no receipt either way — never "not landed") or `ON_INTEGRATION_LINE`.
    public let landing: String?
    /// How the owner said anybody would know this criterion holds.
    public let verificationMethod: String?

    public init(id: String, ordinal: Int, text: String, satisfied: Bool? = nil,
                unmet: [ProjectCriterionUnmet] = [], landing: String? = nil,
                verificationMethod: String? = nil) {
        self.id = id
        self.ordinal = ordinal
        self.text = text
        self.satisfied = satisfied
        self.unmet = unmet
        self.landing = landing
        self.verificationMethod = verificationMethod
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        ordinal = try c.decodeIfPresent(Int.self, forKey: .ordinal) ?? 0
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        satisfied = try c.decodeIfPresent(Bool.self, forKey: .satisfied)
        unmet = try c.decodeIfPresent([ProjectCriterionUnmet].self, forKey: .unmet) ?? []
        landing = try c.decodeIfPresent(String.self, forKey: .landing)
        verificationMethod = try c.decodeIfPresent(String.self, forKey: .verificationMethod)
    }
}

/// The settings half of a project's integration line, as the project document carries it.
public struct ProjectIntegrationSettings: Codable, Equatable, Sendable {
    public let line: IntegrationLine?
    /// The line's branch, spelled as a merge receipt spells it.
    public let ref: String?
    /// The branch "on main" means for this project.
    public let upstreamRef: String?
    public let locked: Bool
    public let mergeCheckCommand: String?
    /// How long an exception may wait on the coordinator before it becomes the owner's.
    public let escalationSeconds: Int?

    public init(line: IntegrationLine? = nil, ref: String? = nil, upstreamRef: String? = nil,
                locked: Bool = false, mergeCheckCommand: String? = nil, escalationSeconds: Int? = nil) {
        self.line = line
        self.ref = ref
        self.upstreamRef = upstreamRef
        self.locked = locked
        self.mergeCheckCommand = mergeCheckCommand
        self.escalationSeconds = escalationSeconds
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        line = try c.decodeIfPresent(IntegrationLine.self, forKey: .line)
        ref = try c.decodeIfPresent(String.self, forKey: .ref)
        upstreamRef = try c.decodeIfPresent(String.self, forKey: .upstreamRef)
        locked = try c.decodeIfPresent(Bool.self, forKey: .locked) ?? false
        mergeCheckCommand = try c.decodeIfPresent(String.self, forKey: .mergeCheckCommand)
        escalationSeconds = try c.decodeIfPresent(Int.self, forKey: .escalationSeconds)
    }
}

/// `GET /projects/:id`: the project's own record, narrowed to what its page draws.
public struct ProjectDocument: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let status: ProjectStatus
    public let goal: String?
    public let instructions: String?
    public let createdAt: String
    public let updatedAt: String?
    /// The Automatic switch. Nil when the read did not say, which is never a "no".
    public let coordinatorEnabled: Bool?
    /// The revision the switch's write is fenced against — a decimal string, compared as text.
    public let configRevision: String?
    public let coordinatorSessionId: String?
    /// Everything filed under the project, settled work included.
    public let taskCount: Int
    public let acceptanceCriteriaItems: [ProjectCriterion]
    public let integration: ProjectIntegrationSettings?
    /// How many tasks hold each status. Absent from a server that predates it — which is not the
    /// same as zero, so a sentence that counts from it has to say so.
    public let tasksByStatus: [String: Int]?
    /// Every open blocker and the latest resolved ones; nil from a server that predates the read.
    public let blockers: ProjectBlockers?

    public init(id: String, title: String, status: ProjectStatus = .open, goal: String? = nil,
                instructions: String? = nil, createdAt: String = "", updatedAt: String? = nil,
                coordinatorEnabled: Bool? = nil, configRevision: String? = nil,
                coordinatorSessionId: String? = nil, taskCount: Int = 0,
                acceptanceCriteriaItems: [ProjectCriterion] = [],
                integration: ProjectIntegrationSettings? = nil,
                tasksByStatus: [String: Int]? = nil, blockers: ProjectBlockers? = nil) {
        self.id = id
        self.title = title
        self.status = status
        self.goal = goal
        self.instructions = instructions
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.coordinatorEnabled = coordinatorEnabled
        self.configRevision = configRevision
        self.coordinatorSessionId = coordinatorSessionId
        self.taskCount = taskCount
        self.acceptanceCriteriaItems = acceptanceCriteriaItems
        self.integration = integration
        self.tasksByStatus = tasksByStatus
        self.blockers = blockers
    }

    private struct Counts: Codable {
        let tasks: Int?
    }

    enum CodingKeys: String, CodingKey {
        case id, title, status, goal, instructions, createdAt, updatedAt, coordinatorEnabled,
             configRevision, coordinatorSessionId, acceptanceCriteriaItems, integration, tasksByStatus,
             blockers
        case counts = "_count"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        status = try c.decodeIfPresent(ProjectStatus.self, forKey: .status) ?? .unknown
        goal = try c.decodeIfPresent(String.self, forKey: .goal)
        instructions = try c.decodeIfPresent(String.self, forKey: .instructions)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        coordinatorEnabled = try c.decodeIfPresent(Bool.self, forKey: .coordinatorEnabled)
        configRevision = decodeDecimal(c, .configRevision)
        coordinatorSessionId = try c.decodeIfPresent(String.self, forKey: .coordinatorSessionId)
        taskCount = try c.decodeIfPresent(Counts.self, forKey: .counts)?.tasks ?? 0
        acceptanceCriteriaItems = try c.decodeIfPresent([ProjectCriterion].self,
                                                        forKey: .acceptanceCriteriaItems) ?? []
        integration = try c.decodeIfPresent(ProjectIntegrationSettings.self, forKey: .integration)
        tasksByStatus = try? c.decodeIfPresent([String: Int].self, forKey: .tasksByStatus)
        blockers = try? c.decodeIfPresent(ProjectBlockers.self, forKey: .blockers)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(status, forKey: .status)
        try c.encodeIfPresent(goal, forKey: .goal)
        try c.encodeIfPresent(instructions, forKey: .instructions)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(updatedAt, forKey: .updatedAt)
        try c.encodeIfPresent(coordinatorEnabled, forKey: .coordinatorEnabled)
        try c.encodeIfPresent(configRevision, forKey: .configRevision)
        try c.encodeIfPresent(coordinatorSessionId, forKey: .coordinatorSessionId)
        try c.encode(Counts(tasks: taskCount), forKey: .counts)
        try c.encode(acceptanceCriteriaItems, forKey: .acceptanceCriteriaItems)
        try c.encodeIfPresent(integration, forKey: .integration)
        try c.encodeIfPresent(tasksByStatus, forKey: .tasksByStatus)
        try c.encodeIfPresent(blockers, forKey: .blockers)
    }
}

// MARK: - GET /projects/:id/integration

/// One integration job in flight, as the Work overview card's live line reads it.
///
/// `taskTitle` is nil for the kinds that land no single task — a promotion of the project's own
/// branch, a merge check — because the title is a fact only the task's row has and inventing one for
/// those would name work that is not what is being pushed.
public struct ProjectIntegrationInFlight: Codable, Equatable, Sendable {
    public let taskTitle: String?
    /// `RUNNING` while the combined-tree checks run, `QUEUED` while the job waits its turn.
    public let state: String
    /// What "for how long" counts from: the claim for a running job, the enqueue for a queued one.
    public let startedAt: String

    public init(taskTitle: String? = nil, state: String, startedAt: String) {
        self.taskTitle = taskTitle
        self.state = state
        self.startedAt = startedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskTitle = try c.decodeIfPresent(String.self, forKey: .taskTitle)
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "QUEUED"
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt) ?? ""
    }
}

/// The integration line plus what the queue has done with it — the facts the page's line row draws.
public struct ProjectIntegrationView: Codable, Equatable, Sendable {
    public let line: IntegrationLine?
    public let ref: String?
    public let upstreamRef: String?
    /// How far the line is ahead of upstream; nil before anything landed on it.
    public let commitsAheadOfUpstream: Int?
    /// When upstream was last absorbed into the line; nil when it never was.
    public let lastUpstreamSyncAt: String?
    public let integratingCount: Int
    public let queuedCount: Int
    /// `PASSING`, `FAILING` or `UNKNOWN` (no finished check — never a failure).
    public let mergeCheckOnTip: String
    /// The OLDEST job those two counts count, described; nil when there is none. What the Work
    /// overview card's live landing line is drawn from.
    public let inFlight: ProjectIntegrationInFlight?

    public init(line: IntegrationLine? = nil, ref: String? = nil, upstreamRef: String? = nil,
                commitsAheadOfUpstream: Int? = nil, lastUpstreamSyncAt: String? = nil,
                integratingCount: Int = 0, queuedCount: Int = 0, mergeCheckOnTip: String = "UNKNOWN",
                inFlight: ProjectIntegrationInFlight? = nil) {
        self.line = line
        self.ref = ref
        self.upstreamRef = upstreamRef
        self.commitsAheadOfUpstream = commitsAheadOfUpstream
        self.lastUpstreamSyncAt = lastUpstreamSyncAt
        self.integratingCount = integratingCount
        self.queuedCount = queuedCount
        self.mergeCheckOnTip = mergeCheckOnTip
        self.inFlight = inFlight
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        line = try c.decodeIfPresent(IntegrationLine.self, forKey: .line)
        ref = try c.decodeIfPresent(String.self, forKey: .ref)
        upstreamRef = try c.decodeIfPresent(String.self, forKey: .upstreamRef)
        commitsAheadOfUpstream = try c.decodeIfPresent(Int.self, forKey: .commitsAheadOfUpstream)
        lastUpstreamSyncAt = try c.decodeIfPresent(String.self, forKey: .lastUpstreamSyncAt)
        integratingCount = try c.decodeIfPresent(Int.self, forKey: .integratingCount) ?? 0
        queuedCount = try c.decodeIfPresent(Int.self, forKey: .queuedCount) ?? 0
        mergeCheckOnTip = try c.decodeIfPresent(String.self, forKey: .mergeCheckOnTip) ?? "UNKNOWN"
        inFlight = try c.decodeIfPresent(ProjectIntegrationInFlight.self, forKey: .inFlight)
    }
}

// MARK: - GET /projects/:id/panorama

/// Where the project's work stands, lane by lane — plus, once the project integrates, how its done
/// work splits between integrating, the project branch and main.
public struct ProjectPanoramaBuckets: Codable, Equatable, Sendable {
    public let running: Int
    public let ready: Int
    public let blocked: Int
    public let awaitingVerification: Int
    public let done: Int
    public let failed: Int
    public let cancelled: Int
    /// The integration lanes, all four present or the card draws the single Done lane.
    public let integrating: Int?
    public let onIntegrationLine: Int?
    public let onUpstream: Int?
    public let doneNotIntegrated: Int?
    /// Blocked tasks held by nothing but a prerequisite that is finished and not yet landed.
    public let waitingForLanding: Int?

    public init(running: Int = 0, ready: Int = 0, blocked: Int = 0, awaitingVerification: Int = 0,
                done: Int = 0, failed: Int = 0, cancelled: Int = 0, integrating: Int? = nil,
                onIntegrationLine: Int? = nil, onUpstream: Int? = nil, doneNotIntegrated: Int? = nil,
                waitingForLanding: Int? = nil) {
        self.running = running
        self.ready = ready
        self.blocked = blocked
        self.awaitingVerification = awaitingVerification
        self.done = done
        self.failed = failed
        self.cancelled = cancelled
        self.integrating = integrating
        self.onIntegrationLine = onIntegrationLine
        self.onUpstream = onUpstream
        self.doneNotIntegrated = doneNotIntegrated
        self.waitingForLanding = waitingForLanding
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        running = try c.decodeIfPresent(Int.self, forKey: .running) ?? 0
        ready = try c.decodeIfPresent(Int.self, forKey: .ready) ?? 0
        blocked = try c.decodeIfPresent(Int.self, forKey: .blocked) ?? 0
        awaitingVerification = try c.decodeIfPresent(Int.self, forKey: .awaitingVerification) ?? 0
        done = try c.decodeIfPresent(Int.self, forKey: .done) ?? 0
        failed = try c.decodeIfPresent(Int.self, forKey: .failed) ?? 0
        cancelled = try c.decodeIfPresent(Int.self, forKey: .cancelled) ?? 0
        integrating = try c.decodeIfPresent(Int.self, forKey: .integrating)
        onIntegrationLine = try c.decodeIfPresent(Int.self, forKey: .onIntegrationLine)
        onUpstream = try c.decodeIfPresent(Int.self, forKey: .onUpstream)
        doneNotIntegrated = try c.decodeIfPresent(Int.self, forKey: .doneNotIntegrated)
        waitingForLanding = try c.decodeIfPresent(Int.self, forKey: .waitingForLanding)
    }
}

public struct ProjectPanorama: Codable, Equatable, Sendable {
    public struct Shape: Codable, Equatable, Sendable {
        public let taskCount: Int
        /// Dependencies with both ends in this project.
        public let edgeCount: Int

        public init(taskCount: Int = 0, edgeCount: Int = 0) {
            self.taskCount = taskCount
            self.edgeCount = edgeCount
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            taskCount = try c.decodeIfPresent(Int.self, forKey: .taskCount) ?? 0
            edgeCount = try c.decodeIfPresent(Int.self, forKey: .edgeCount) ?? 0
        }
    }

    public let buckets: ProjectPanoramaBuckets
    public let shape: Shape

    public init(buckets: ProjectPanoramaBuckets = ProjectPanoramaBuckets(), shape: Shape = Shape()) {
        self.buckets = buckets
        self.shape = shape
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        buckets = try c.decodeIfPresent(ProjectPanoramaBuckets.self, forKey: .buckets)
            ?? ProjectPanoramaBuckets()
        shape = try c.decodeIfPresent(Shape.self, forKey: .shape) ?? Shape()
    }
}

// MARK: - GET /projects/:id/coordinator/status

/// Which of the four places a project's coordination can be in.
public enum ProjectCoordinationState: String, Codable, Sendable {
    case live = "LIVE"
    case trashed = "TRASHED"
    case unavailable = "UNAVAILABLE"
    case neverOpened = "NEVER_OPENED"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ProjectCoordinationState(rawValue: raw) ?? .unknown
    }
}

/// What the project's coordination is, and what opening it would do right now.
public struct ProjectCoordinatorStatus: Codable, Equatable, Sendable {
    public struct Session: Codable, Equatable, Sendable {
        public let id: String
        public let title: String?
        public let runState: SessionRunState?
        public let lifecycleState: SessionLifecycleState?
        public let engineTurnActive: Bool
        public let pendingApprovals: Int
        public let startedAt: String?
        public let finishedAt: String?
        public let completedAt: String?
        /// The conversation's newest turn — what "last active" reads. Nil from a server that
        /// predates it, or for a conversation that never took one.
        public let lastTurnAt: String?

        public init(id: String, title: String? = nil, runState: SessionRunState? = nil,
                    lifecycleState: SessionLifecycleState? = nil, engineTurnActive: Bool = false,
                    pendingApprovals: Int = 0, startedAt: String? = nil, finishedAt: String? = nil,
                    completedAt: String? = nil, lastTurnAt: String? = nil) {
            self.id = id
            self.title = title
            self.runState = runState
            self.lifecycleState = lifecycleState
            self.engineTurnActive = engineTurnActive
            self.pendingApprovals = pendingApprovals
            self.startedAt = startedAt
            self.finishedAt = finishedAt
            self.completedAt = completedAt
            self.lastTurnAt = lastTurnAt
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decodeIfPresent(String.self, forKey: .title)
            runState = try? c.decodeIfPresent(SessionRunState.self, forKey: .runState)
            lifecycleState = try? c.decodeIfPresent(SessionLifecycleState.self, forKey: .lifecycleState)
            engineTurnActive = try c.decodeIfPresent(Bool.self, forKey: .engineTurnActive) ?? false
            pendingApprovals = try c.decodeIfPresent(Int.self, forKey: .pendingApprovals) ?? 0
            startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt)
            finishedAt = try c.decodeIfPresent(String.self, forKey: .finishedAt)
            completedAt = try c.decodeIfPresent(String.self, forKey: .completedAt)
            lastTurnAt = try c.decodeIfPresent(String.self, forKey: .lastTurnAt)
        }
    }

    /// Whether Orbit's last word to the conversation reached it.
    public struct Wakeups: Codable, Equatable, Sendable {
        /// `DELIVERED`, `QUEUED`, `RETURNED` or `NONE`.
        public let state: String
        public let at: String?

        public init(state: String, at: String? = nil) {
            self.state = state
            self.at = at
        }
    }

    /// What the coordinator has started on its own today, against what it may.
    public struct Fuse: Codable, Equatable, Sendable {
        public let selfStartedToday: Int
        /// Nil when the project authorised no limit.
        public let limit: Int?
        public let paused: Bool
        public let episodeId: String?

        public init(selfStartedToday: Int = 0, limit: Int? = nil, paused: Bool = false,
                    episodeId: String? = nil) {
            self.selfStartedToday = selfStartedToday
            self.limit = limit
            self.paused = paused
            self.episodeId = episodeId
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            selfStartedToday = try c.decodeIfPresent(Int.self, forKey: .selfStartedToday) ?? 0
            limit = try c.decodeIfPresent(Int.self, forKey: .limit)
            paused = try c.decodeIfPresent(Bool.self, forKey: .paused) ?? false
            episodeId = try c.decodeIfPresent(String.self, forKey: .episodeId)
        }
    }

    public struct Coordination: Codable, Equatable, Sendable {
        public let sessionId: String?
        public let session: Session?
        /// How many times the coordinator conversation has been replaced (a decimal string).
        public let coordinatorGeneration: String?
        public let workspaceId: String?
        public let workspaceName: String?
        public let agentName: String?
        public let wakeups: Wakeups?
        public let fuse: Fuse?

        public init(sessionId: String? = nil, session: Session? = nil,
                    coordinatorGeneration: String? = nil, workspaceId: String? = nil,
                    workspaceName: String? = nil, agentName: String? = nil,
                    wakeups: Wakeups? = nil, fuse: Fuse? = nil) {
            self.sessionId = sessionId
            self.session = session
            self.coordinatorGeneration = coordinatorGeneration
            self.workspaceId = workspaceId
            self.workspaceName = workspaceName
            self.agentName = agentName
            self.wakeups = wakeups
            self.fuse = fuse
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
            session = try c.decodeIfPresent(Session.self, forKey: .session)
            coordinatorGeneration = decodeDecimal(c, .coordinatorGeneration)
            workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
            workspaceName = try c.decodeIfPresent(String.self, forKey: .workspaceName)
            agentName = try c.decodeIfPresent(String.self, forKey: .agentName)
            wakeups = try? c.decodeIfPresent(Wakeups.self, forKey: .wakeups)
            fuse = try? c.decodeIfPresent(Fuse.self, forKey: .fuse)
        }
    }

    public struct Openability: Codable, Equatable, Sendable {
        public struct Landing: Codable, Equatable, Sendable {
            public let workspaceId: String?
            public let workspaceName: String?

            public init(workspaceId: String? = nil, workspaceName: String? = nil) {
                self.workspaceId = workspaceId
                self.workspaceName = workspaceName
            }
        }

        public let canOpen: Bool
        public let willCreate: Bool
        public let refusalCode: String?
        public let refusalDetail: String?
        /// The server's own sentence for what would unblock opening it.
        public let requiredAction: String?
        public let landing: Landing?

        public init(canOpen: Bool = true, willCreate: Bool = false, refusalCode: String? = nil,
                    refusalDetail: String? = nil, requiredAction: String? = nil,
                    landing: Landing? = nil) {
            self.canOpen = canOpen
            self.willCreate = willCreate
            self.refusalCode = refusalCode
            self.refusalDetail = refusalDetail
            self.requiredAction = requiredAction
            self.landing = landing
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            canOpen = try c.decodeIfPresent(Bool.self, forKey: .canOpen) ?? false
            willCreate = try c.decodeIfPresent(Bool.self, forKey: .willCreate) ?? false
            refusalCode = try c.decodeIfPresent(String.self, forKey: .refusalCode)
            refusalDetail = try c.decodeIfPresent(String.self, forKey: .refusalDetail)
            requiredAction = try c.decodeIfPresent(String.self, forKey: .requiredAction)
            landing = try? c.decodeIfPresent(Landing.self, forKey: .landing)
        }
    }

    public let projectId: String
    public let readAt: String?
    public let state: ProjectCoordinationState
    public let coordination: Coordination
    public let openability: Openability

    public init(projectId: String, readAt: String? = nil, state: ProjectCoordinationState,
                coordination: Coordination = Coordination(), openability: Openability = Openability()) {
        self.projectId = projectId
        self.readAt = readAt
        self.state = state
        self.coordination = coordination
        self.openability = openability
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId) ?? ""
        readAt = try c.decodeIfPresent(String.self, forKey: .readAt)
        state = try c.decodeIfPresent(ProjectCoordinationState.self, forKey: .state) ?? .unknown
        coordination = try c.decodeIfPresent(Coordination.self, forKey: .coordination) ?? Coordination()
        openability = try c.decodeIfPresent(Openability.self, forKey: .openability) ?? Openability(canOpen: false)
    }
}

/// `POST /projects/:id/coordinator`: the conversation that coordinates the project, found or opened.
public struct ProjectCoordinatorOpened: Codable, Equatable, Sendable {
    public let sessionId: String
    public let created: Bool
    /// The workspace the conversation runs in — the console's agent.
    public let workspaceId: String?

    public init(sessionId: String, created: Bool = false, workspaceId: String? = nil) {
        self.sessionId = sessionId
        self.created = created
        self.workspaceId = workspaceId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        created = try c.decodeIfPresent(Bool.self, forKey: .created) ?? false
        workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
    }
}

// MARK: - GET /projects/:id/tasks/page

/// Where one task stands between "done" and "on main".
public struct ProjectTaskIntegration: Codable, Equatable, Sendable {
    /// `NOT_APPLICABLE`, `QUEUED`, `RUNNING`, `CONFLICT`, `CHECK_FAILED`, `ERROR`, `AWAITING_OWNER`,
    /// `ON_INTEGRATION_LINE` or `ON_UPSTREAM`; a value this build does not know draws nothing.
    public let state: String
    /// `COORDINATOR` or `OWNER`, while somebody has to act.
    public let handler: String?
    public let checksRunningForMs: Double?

    public init(state: String, handler: String? = nil, checksRunningForMs: Double? = nil) {
        self.state = state
        self.handler = handler
        self.checksRunningForMs = checksRunningForMs
    }
}

/// One task of a project, as the project's task page serves it.
public struct ProjectTaskRow: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    /// The task's status (`OPEN`, `IN_PROGRESS`, `DONE`, `CANCELLED`, `FAILED`).
    public let status: String
    public let parentTaskId: String?
    public let childCount: Int
    /// Prerequisites not yet DONE or CANCELLED.
    public let unmetCount: Int
    /// Tasks that name this one as a prerequisite.
    public let blocksCount: Int
    /// Longest prerequisite path to this task inside the project.
    public let topoLevel: Int
    /// `READY`, `BLOCKED` or `BLOCKED_FAILED`.
    public let dependencyState: String?
    /// The server's canonical work lane: `RUNNING`, `READY`, `BLOCKED`, `AWAITING_VERIFICATION`,
    /// `DONE`, `FAILED` or `CANCELLED`.
    public let workState: String?
    public let completionPolicy: String?
    public let verifiesTaskId: String?
    public let verificationState: String?
    public let autoRunWhenReady: Bool?
    public let integration: ProjectTaskIntegration?
    /// Finished prerequisites not yet landed on the project's integration line.
    public let landingWaitCount: Int?

    public init(id: String, title: String, status: String = "OPEN", parentTaskId: String? = nil,
                childCount: Int = 0, unmetCount: Int = 0, blocksCount: Int = 0, topoLevel: Int = 0,
                dependencyState: String? = "READY", workState: String? = nil,
                completionPolicy: String? = nil, verifiesTaskId: String? = nil,
                verificationState: String? = nil, autoRunWhenReady: Bool? = nil,
                integration: ProjectTaskIntegration? = nil, landingWaitCount: Int? = nil) {
        self.id = id
        self.title = title
        self.status = status
        self.parentTaskId = parentTaskId
        self.childCount = childCount
        self.unmetCount = unmetCount
        self.blocksCount = blocksCount
        self.topoLevel = topoLevel
        self.dependencyState = dependencyState
        self.workState = workState
        self.completionPolicy = completionPolicy
        self.verifiesTaskId = verifiesTaskId
        self.verificationState = verificationState
        self.autoRunWhenReady = autoRunWhenReady
        self.integration = integration
        self.landingWaitCount = landingWaitCount
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        parentTaskId = try c.decodeIfPresent(String.self, forKey: .parentTaskId)
        childCount = try c.decodeIfPresent(Int.self, forKey: .childCount) ?? 0
        unmetCount = try c.decodeIfPresent(Int.self, forKey: .unmetCount) ?? 0
        blocksCount = try c.decodeIfPresent(Int.self, forKey: .blocksCount) ?? 0
        topoLevel = try c.decodeIfPresent(Int.self, forKey: .topoLevel) ?? 0
        dependencyState = try c.decodeIfPresent(String.self, forKey: .dependencyState)
        workState = try c.decodeIfPresent(String.self, forKey: .workState)
        completionPolicy = try c.decodeIfPresent(String.self, forKey: .completionPolicy)
        verifiesTaskId = try c.decodeIfPresent(String.self, forKey: .verifiesTaskId)
        verificationState = try c.decodeIfPresent(String.self, forKey: .verificationState)
        autoRunWhenReady = try c.decodeIfPresent(Bool.self, forKey: .autoRunWhenReady)
        integration = try? c.decodeIfPresent(ProjectTaskIntegration.self, forKey: .integration)
        landingWaitCount = try c.decodeIfPresent(Int.self, forKey: .landingWaitCount)
    }
}

/// One page of a project's top-level tasks. `nextCursor` is set only when a further page exists.
public struct ProjectTaskPage: Codable, Equatable, Sendable {
    public let items: [ProjectTaskRow]
    public let nextCursor: String?

    public init(items: [ProjectTaskRow] = [], nextCursor: String? = nil) {
        self.items = items
        self.nextCursor = nextCursor
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([ProjectTaskRow].self, forKey: .items) ?? []
        nextCursor = try c.decodeIfPresent(String.self, forKey: .nextCursor)
    }
}

// MARK: - writes

/// `PATCH /projects/:id` with a status: how a project is recorded done, cancelled, or reopened.
public struct UpdateProjectStatusRequest: Codable, Equatable, Sendable {
    public let status: String

    public init(status: ProjectStatus) {
        self.status = status.rawValue
    }
}

/// `PATCH /projects/:id` flipping the Automatic switch, fenced on the revision it was read at.
public struct SetProjectAutomaticRequest: Codable, Equatable, Sendable {
    public let coordinatorEnabled: Bool
    public let expectedConfigRevision: String

    public init(coordinatorEnabled: Bool, expectedConfigRevision: String) {
        self.coordinatorEnabled = coordinatorEnabled
        self.expectedConfigRevision = expectedConfigRevision
    }
}
