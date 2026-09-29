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
///
/// A page read from the middle of a transcript (`APIClient.eventPageAround` / `eventPageAfter`, for a
/// link to one record — `SessionRecordLink`) carries a cursor each way as well: `before` is what to
/// pass as `before=` for the page older than this one, `after` what to pass as `after=` for the page
/// newer, each nil when that direction has nothing more. A tail page has neither — nothing is newer
/// than the tail, which is what a nil `after` says. The page around a record also names the record's
/// `anchor`.
public struct EventPage: Decodable, Sendable {
    public let events: [RunEvent]
    public let hasMore: Bool
    public let before: Int?
    public let after: Int?
    public let anchor: TranscriptAnchor?
    public init(events: [RunEvent], hasMore: Bool, before: Int? = nil, after: Int? = nil,
                anchor: TranscriptAnchor? = nil) {
        self.events = events
        self.hasMore = hasMore
        self.before = before
        self.after = after
        self.anchor = anchor
    }
}

/// The record a page was read around, and the seq it sits at: an event is itself, a turn the `user`
/// event its message entered the transcript as, a tool call its `tool_use`. `kind` is `turn`, `event`
/// or `tool_call`; `id` is the record's public id.
public struct TranscriptAnchor: Decodable, Equatable, Sendable {
    public let kind: String
    public let id: String
    public let seq: Int
    public init(kind: String, id: String, seq: Int) {
        self.kind = kind
        self.id = id
        self.seq = seq
    }
}
