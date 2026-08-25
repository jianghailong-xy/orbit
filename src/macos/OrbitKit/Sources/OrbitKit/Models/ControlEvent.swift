import Foundation

// Swift mirror of the control-plane wire protocol in `src/shared/src/realtime.ts` — the
// user-scoped SSE stream (`GET /api/events`) that pushes coarse lifecycle / status / approval /
// background events for ALL of the user's sessions, replacing list polling. Keep the two in
// lockstep. See docs/realtime-control-plane-stream.md.

/// Control-plane event types. `.unknown` is the forward-compat floor: a server that ships a new
/// type must not break an older client, so unrecognized strings decode to it (and are ignored).
public enum ControlEventType: String, Codable, Sendable {
    case sessionCreated = "session.created"
    case sessionUpdated = "session.updated"
    case sessionEnded = "session.ended"
    case sessionError = "session.error"
    case approvalRequested = "approval.requested"
    case approvalResolved = "approval.resolved"
    case backgroundTask = "background.task"
    /// A task / agent the owner can see changed — usually an agent's MCP task_*/agent_* call.
    /// Task payloads on current servers name bounded rows or explicitly request resync; legacy
    /// payloads remain coarse reload nudges. Agent changes are still list nudges.
    case taskChanged = "task.changed"
    case agentChanged = "agent.changed"
    /// Owner-level libraries. These are USER-scoped: `sessionId` is empty (see ControlEvent).
    case taskListChanged = "task.list.changed"
    case tagChanged = "tag.changed"
    case providerChanged = "provider.changed"
    case notification = "notification"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ControlEventType(rawValue: raw) ?? .unknown
    }
}

/// The envelope every control-plane event ships in. One connection carries many sessions, so
/// each event names its scope; `agentId` lets per-agent lists filter client-side.
public struct ControlEvent: Codable, Equatable, Sendable {
    public let type: ControlEventType
    /// The session this event is about — EMPTY for the user-scoped library events
    /// (`task.list.changed` / `tag.changed` / `provider.changed`), which belong to the owner rather
    /// than to any session. Still non-optional: the keepalive ping omits the field entirely, and
    /// that's what makes it fail to decode (see SSEDecoding.controlEvent).
    public let sessionId: String
    public let agentId: String?
    public let ts: String
    /// Typed per `type` — decode with `payload(_:)`.
    public let data: JSONValue?

    public init(type: ControlEventType, sessionId: String, agentId: String?, ts: String,
                data: JSONValue?) {
        self.type = type
        self.sessionId = sessionId
        self.agentId = agentId
        self.ts = ts
        self.data = data
    }

    /// Decode `data` as one of the typed payloads below (round-trips through JSON, so the
    /// payload structs stay plain `Codable` mirrors of the TypeScript shapes). nil when the
    /// payload is absent or doesn't match — callers treat that as "ignore the event".
    public func payload<T: Decodable>(_ type: T.Type) -> T? {
        guard let data, let bytes = try? JSONEncoder().encode(data) else { return nil }
        return try? JSONDecoder().decode(T.self, from: bytes)
    }
}

/// `data` for `session.created` / `session.updated`: the slim list-row summary, field-aligned
/// with the `GET /sessions` list row so the client can upsert it wholesale (decision Q2).
public struct ControlSessionSummary: Codable, Equatable, Sendable {
    public struct AgentRef: Codable, Equatable, Sendable {
        public let id: String
        public let name: String?
        public let model: String?
        /// Sent by the control plane (`realtime.service.ts` selects it alongside name/model). Decoded
        /// here so the payload round-trips; `SessionUpsert` still prefers the row's own richer agent.
        public let effort: String?
    }
    public let id: String
    /// Work item whose live run this session represents. New servers include it so task list
    /// running/queued overlays can refresh by id; nil also covers ordinary conversations and
    /// rolling-version servers that omit the field.
    public let taskId: String?
    public let title: String?
    public let status: RunStatus
    /// Explicit low-level runner state; `status` is retained for older control planes.
    public let runStatus: RunStatus?
    /// Server-normalized state, omitted by older control planes.
    public let sessionState: SessionState?
    /// Orthogonal execution state and lifecycle location, omitted by older control planes.
    public let runState: SessionRunState?
    public let lifecycleState: SessionLifecycleState?
    public let capabilities: SessionCapabilities?
    public let agentId: String?
    public let agent: AgentRef?
    public let pendingApprovals: Int
    public let lastTurnAt: String?
    /// When the server will re-send the message this run's failure killed — part of the summary
    /// because it is part of what `runState == .failed` means (see `Session.retryPending`).
    ///
    /// Doubly optional because all three cases differ: `nil` is an older control plane that never
    /// sends the key (keep whatever the row knows), `.some(nil)` is this server saying nothing is
    /// armed any more (the retries ran out — clear it, and the row stops saying "Retrying"), and
    /// `.some(value)` is the moment to resume. `decodeIfPresent` cannot tell the first two apart
    /// — it maps an explicit null to nil as well — so the decoder asks `contains` instead.
    public let retryAt: String??

    public var effectiveRunStatus: RunStatus { runStatus ?? status }
    public var effectiveRunState: SessionRunState {
        SessionRunState.resolve(runState, legacy: sessionState, status: effectiveRunStatus)
    }
    public var effectiveLifecycleState: SessionLifecycleState? {
        guard let lifecycleState, lifecycleState != .unknown else { return nil }
        return lifecycleState
    }

    private enum LegacyCodingKeys: String, CodingKey { case filingState }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let legacy = try decoder.container(keyedBy: LegacyCodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        taskId = try values.decodeIfPresent(String.self, forKey: .taskId)
        title = try values.decodeIfPresent(String.self, forKey: .title)
        status = try values.decode(RunStatus.self, forKey: .status)
        runStatus = try values.decodeIfPresent(RunStatus.self, forKey: .runStatus)
        sessionState = try values.decodeIfPresent(SessionState.self, forKey: .sessionState)
        runState = try values.decodeIfPresent(SessionRunState.self, forKey: .runState)
        lifecycleState = try values.decodeIfPresent(SessionLifecycleState.self, forKey: .lifecycleState)
            ?? legacy.decodeIfPresent(SessionLifecycleState.self, forKey: .filingState)
        capabilities = try values.decodeIfPresent(SessionCapabilities.self, forKey: .capabilities)
        agentId = try values.decodeIfPresent(String.self, forKey: .agentId)
        agent = try values.decodeIfPresent(AgentRef.self, forKey: .agent)
        pendingApprovals = try values.decode(Int.self, forKey: .pendingApprovals)
        lastTurnAt = try values.decodeIfPresent(String.self, forKey: .lastTurnAt)
        retryAt = values.contains(.retryAt)
            ? .some(try values.decodeIfPresent(String.self, forKey: .retryAt))
            : nil
    }
}

/// `data` for `session.ended`.
public struct ControlSessionEnded: Codable, Equatable, Sendable {
    public let status: RunStatus
    public let runStatus: RunStatus?
    public let sessionState: SessionState?
    public let runState: SessionRunState?
    public let lifecycleState: SessionLifecycleState?
    public let endReason: String?

    public var effectiveRunStatus: RunStatus { runStatus ?? status }
    public var effectiveRunState: SessionRunState {
        SessionRunState.resolve(runState, legacy: sessionState,
                                status: effectiveRunStatus, endReason: endReason)
    }
    public var effectiveLifecycleState: SessionLifecycleState? {
        guard let lifecycleState, lifecycleState != .unknown else { return nil }
        return lifecycleState
    }

    private enum LegacyCodingKeys: String, CodingKey { case filingState }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let legacy = try decoder.container(keyedBy: LegacyCodingKeys.self)
        status = try values.decode(RunStatus.self, forKey: .status)
        runStatus = try values.decodeIfPresent(RunStatus.self, forKey: .runStatus)
        sessionState = try values.decodeIfPresent(SessionState.self, forKey: .sessionState)
        runState = try values.decodeIfPresent(SessionRunState.self, forKey: .runState)
        lifecycleState = try values.decodeIfPresent(SessionLifecycleState.self, forKey: .lifecycleState)
            ?? legacy.decodeIfPresent(SessionLifecycleState.self, forKey: .filingState)
        endReason = try values.decodeIfPresent(String.self, forKey: .endReason)
    }
}

/// `data` for `session.error`. `recoverable=true` marks a mid-turn (non-fatal) error; `false`
/// usually accompanies a status→FAILED `session.updated` (don't notify twice — design §5.2).
public struct ControlSessionError: Codable, Equatable, Sendable {
    public let message: String
    public let recoverable: Bool
}

/// `data` for `approval.requested` / `approval.resolved`.
public struct ControlApproval: Codable, Equatable, Sendable {
    public let approvalId: String
    public let pendingApprovals: Int
}

/// `data` for `background.task`.
public struct ControlBackgroundTask: Codable, Equatable, Sendable {
    public let name: String
    public let status: String
    public let exitCode: Int?
}

/// `data` for `agent.changed`.
///
/// A workspace metadata refresh does not always invalidate task rows. In particular, starting an
/// ordinary session changes that workspace's provider default, but it changes neither the Ready
/// predicate nor any task-list field. Older servers omit the flag, so callers must conservatively
/// treat `nil` as `true` during a rolling upgrade.
public struct ControlAgentChanged: Codable, Equatable, Sendable {
    public let agentId: String
    public let affectsTaskRows: Bool?

    public init(agentId: String, affectsTaskRows: Bool? = nil) {
        self.agentId = agentId
        self.affectsTaskRows = affectsTaskRows
    }
}

/// `data` for `task.changed`.
///
/// Older servers name one changed row with `taskId`. Newer bulk-aware publishers can name every
/// affected row with `taskIds`, or set `resync` when the mutation cannot be represented as a
/// bounded set of ids. Keeping all three fields optional lets a rolling-upgrade client decode both
/// shapes; callers should use `effectiveTaskIds` to fold the singular id into the array and remove
/// duplicates before scheduling targeted row reads.
public struct ControlTaskChanged: Codable, Equatable, Sendable {
    public let taskId: String?
    public let taskIds: [String]?
    public let resync: Bool?

    public init(taskId: String? = nil, taskIds: [String]? = nil, resync: Bool? = nil) {
        self.taskId = taskId
        self.taskIds = taskIds
        self.resync = resync
    }

    /// Every non-empty id carried by either wire generation, in first-seen order.
    public var effectiveTaskIds: [String] {
        var seen = Set<String>()
        var result: [String] = []
        for id in (taskId.map { [$0] } ?? []) + (taskIds ?? []) where !id.isEmpty {
            if seen.insert(id).inserted { result.append(id) }
        }
        return result
    }

    /// True only for the bulk-aware wire generation and a bounded, non-empty change. A payload
    /// containing `taskId` alone is from a server that predates the lightweight row endpoint, so
    /// clients must retain the coarse snapshot fallback for that shape during rolling upgrades.
    public var canRefreshIncrementally: Bool {
        taskIds != nil && resync != true && !effectiveTaskIds.isEmpty
    }
}
