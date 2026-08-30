import Foundation

/// One normalized event in a session's stream (mirrors `NormalizedRunEvent` in
/// src/shared/src/events.ts). The runner assigns `seq`; the control plane persists durable
/// events and replays them over SSE.
public struct RunEvent: Codable, Equatable, Sendable {
    /// Monotonic per-session sequence. Some live-only events use 0, while runner-emitted
    /// `tool_output`/`background_output` snapshots may carry a real counter value despite never
    /// being persisted; `RunEventType.isDurable`, not this number, controls cursor bookkeeping.
    public let seq: Int
    public let type: RunEventType
    /// ISO-8601 timestamp from the runner.
    public let ts: String?
    /// conversation_turn.id that produced this event; absent for session-level events.
    public let turnId: String?
    /// Event-type-specific data.
    public let payload: JSONValue
    /// The server clipped this tool call/result to a preview (`APIClient.maxEventPayload`).
    /// Expanding the card refetches the payload whole via `APIClient.eventFull`.
    public let truncated: Bool

    /// The `seq` the server stamps on a terminal `status` broadcast (`Number.MAX_SAFE_INTEGER` in
    /// apiserver: runner-api turn-complete/finalize, and the reaper). It means "after everything",
    /// not a row — nothing with this seq is persisted, so it can never be replayed. A client that
    /// lets it advance the reconnect cursor asks for `?sinceSeq=<this>` forever after, and the
    /// server's history replay (`seq > sinceSeq`) returns NOTHING from then on: every turn that
    /// happens while the app isn't watching live is lost to that session for good. Web guards it
    /// the same way (AgentView's `isSeq`).
    public static let sentinelSeq = 9_007_199_254_740_991

    enum CodingKeys: String, CodingKey { case seq, type, ts, turnId, payload, truncated }

    public init(seq: Int, type: RunEventType, ts: String? = nil, turnId: String? = nil, payload: JSONValue = .null, truncated: Bool = false) {
        self.seq = seq
        self.type = type
        self.ts = ts
        self.turnId = turnId
        self.payload = payload
        self.truncated = truncated
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Tolerant decoding: a missing/odd field never drops the whole event.
        self.seq = (try? c.decode(Int.self, forKey: .seq)) ?? 0
        self.type = (try? c.decode(RunEventType.self, forKey: .type)) ?? .unknown
        self.ts = try? c.decodeIfPresent(String.self, forKey: .ts)
        self.turnId = try? c.decodeIfPresent(String.self, forKey: .turnId)
        self.payload = (try? c.decodeIfPresent(JSONValue.self, forKey: .payload)) ?? .null
        self.truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
    }
}

/// One page of a session's persisted events (tail-first pagination — see `APIClient.eventPage`).
/// `events` are chronological (seq ascending); `hasMore` is true when older events remain before
/// this page. Mirrors the web `EventPage` (src/web/src/api.ts) and the server `/events/page`.
public struct EventPage: Decodable, Sendable {
    public let events: [RunEvent]
    public let hasMore: Bool
    public init(events: [RunEvent], hasMore: Bool) {
        self.events = events
        self.hasMore = hasMore
    }
}
