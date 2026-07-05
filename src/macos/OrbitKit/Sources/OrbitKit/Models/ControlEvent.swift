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
    }
    public let id: String
    public let title: String?
    public let status: RunStatus
    public let agentId: String?
    public let agent: AgentRef?
    public let pendingApprovals: Int
    public let lastTurnAt: String?
}

/// `data` for `session.ended`.
public struct ControlSessionEnded: Codable, Equatable, Sendable {
    public let status: RunStatus
    public let endReason: String
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
