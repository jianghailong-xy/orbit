import Foundation

// The render model the reducer produces. UI-free and Equatable so it can be asserted in
// tests and diffed cheaply by a SwiftUI view layer.

/// One renderable row in the conversation.
/// `Codable` so a whole reducer snapshot can be persisted to disk and rehydrated (see
/// `FileTranscriptStore`).
public enum TranscriptItem: Identifiable, Equatable, Sendable, Codable {
    case user(UserBubble)
    case assistant(AssistantBubble)
    case thinking(ThinkingBlock)
    case toolCall(ToolCard)
    case interrupt(id: String, seq: Int)
    case error(id: String, message: String)

    public var id: String {
        switch self {
        case .user(let b): return b.id
        case .assistant(let b): return b.id
        case .thinking(let b): return b.id
        case .toolCall(let c): return c.id
        case .interrupt(let id, _): return id
        case .error(let id, _): return id
        }
    }
}

/// One attachment ref carried on a user turn (`{id, mime, name}`). The durable `user` event echoes
/// these so the bubble can render image thumbnails / file chips after a reload — mirroring the web,
/// which reads `ev.payload.attachments`. The bytes are fetched on demand via GET /attachments/:id.
public struct TurnAttachment: Equatable, Sendable, Codable, Identifiable {
    public let id: String
    public let mime: String?
    public let name: String?
    public init(id: String, mime: String? = nil, name: String? = nil) {
        self.id = id
        self.mime = mime
        self.name = name
    }
    /// Inline-renderable image. An unknown mime (optimistic bubble, before the durable event lands)
    /// is treated as an image — the common case (the composer's primary attach path) — and the
    /// loader falls back to a file chip if the bytes don't decode.
    public var isImage: Bool { mime.map { $0.hasPrefix("image/") } ?? true }
}

public struct UserBubble: Equatable, Sendable, Codable {
    public let id: String
    public var text: String
    /// Image/file attachments sent with this turn (web parity: rendered above the text).
    public var attachments: [TurnAttachment]
    /// Wall-clock of the source `user` event (ISO-8601), shown as a relative time under the bubble.
    /// Nil on the optimistic bubble until the durable event reconciles it.
    public var ts: String?
    public var clientTurnId: String?
    /// Server-assigned turn id, learned from the POST /turns (or /resume) response. The durable
    /// `user` event echoes this on `ev.turnId` — not `clientTurnId` — so it's the key that
    /// reconciles the optimistic bubble (web parity). Nil until that response lands.
    public var turnId: String?
    /// Optimistically shown before the server's `user` event confirms it.
    public var pending: Bool
    /// True when this turn was sent while another was already in flight, so it's waiting its turn
    /// rather than being delivered immediately — drives a "Queued" indicator instead of "Sending…"
    /// (web parity). Captured once at send time; only read while `pending`.
    public var queued: Bool

    public init(id: String, text: String, attachments: [TurnAttachment] = [], ts: String? = nil,
                clientTurnId: String? = nil, turnId: String? = nil, pending: Bool, queued: Bool = false) {
        self.id = id
        self.text = text
        self.attachments = attachments
        self.ts = ts
        self.clientTurnId = clientTurnId
        self.turnId = turnId
        self.pending = pending
        self.queued = queued
    }

    // Tolerant decode so transcript snapshots written before `attachments`/`ts` existed still
    // rehydrate (those keys just default) instead of discarding the whole cached session.
    enum CodingKeys: String, CodingKey { case id, text, attachments, ts, clientTurnId, turnId, pending, queued }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        text = try c.decode(String.self, forKey: .text)
        attachments = (try? c.decodeIfPresent([TurnAttachment].self, forKey: .attachments)) ?? []
        ts = try? c.decodeIfPresent(String.self, forKey: .ts)
        clientTurnId = try? c.decodeIfPresent(String.self, forKey: .clientTurnId)
        turnId = try? c.decodeIfPresent(String.self, forKey: .turnId)
        pending = (try? c.decodeIfPresent(Bool.self, forKey: .pending)) ?? false
        queued = (try? c.decodeIfPresent(Bool.self, forKey: .queued)) ?? false
    }
}

public struct AssistantBubble: Equatable, Sendable, Codable {
    public let id: String
    /// Finalized text (set by the durable `assistant` event or flushed at turn end).
    public var text: String
    /// Live-streaming buffer accumulated from `text_delta` (animation only, pre-finalize).
    public var streamingText: String
    public var seq: Int?
    public var turnId: String?
    public var isFinalized: Bool { seq != nil }
    /// What the UI renders: finalized text if present, else the live buffer.
    public var displayText: String { text.isEmpty ? streamingText : text }
}

public struct ThinkingBlock: Equatable, Sendable, Codable {
    public let id: String
    public var text: String
    public var streamingText: String
    public var seq: Int?
    public var isFinalized: Bool { seq != nil }
    public var displayText: String { text.isEmpty ? streamingText : text }
}

public enum ToolStatus: String, Equatable, Sendable, Codable {
    case running
    case ok
    case error
}

public struct ToolCard: Equatable, Sendable, Codable {
    public let id: String        // toolUseId
    public var name: String
    public var input: JSONValue
    public var result: String?
    /// Inline images carried by the tool_result — e.g. `Read` on a .png, or an MCP tool returning a
    /// screenshot. The reducer decodes each `image` content block's base64 payload into bytes here;
    /// the view turns them into a `PlatformImage`. Empty for the common text-only result. Web parity:
    /// the web transcript renders the same blocks inline via `resultImages()`.
    public var resultImages: [Data]
    public var status: ToolStatus

    public init(id: String, name: String, input: JSONValue, result: String?,
                resultImages: [Data] = [], status: ToolStatus) {
        self.id = id
        self.name = name
        self.input = input
        self.result = result
        self.resultImages = resultImages
        self.status = status
    }

    // Tolerant decode so transcript snapshots written before `resultImages` existed still rehydrate
    // (the key just defaults to empty) instead of discarding the whole cached session.
    enum CodingKeys: String, CodingKey { case id, name, input, result, resultImages, status }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        input = try c.decode(JSONValue.self, forKey: .input)
        result = try c.decodeIfPresent(String.self, forKey: .result)
        resultImages = (try? c.decodeIfPresent([Data].self, forKey: .resultImages)) ?? []
        status = try c.decode(ToolStatus.self, forKey: .status)
    }
}

/// A background shell the agent launched with Bash(run_in_background).
public struct BackgroundProc: Equatable, Sendable, Identifiable, Codable {
    public let id: String
    /// The raw command that was launched (web parity: `BgShell.command`). When a `description`
    /// supplies the row title, the command surfaces in the row's expanded body instead of being lost.
    public var command: String?
    /// Optional human `description` from the Bash launch — the row title when present (web parity:
    /// `BgShell.description`), which frees `command` to show the real command below it. Defaulted so
    /// snapshots persisted before this field existed still decode (missing optional reads as nil).
    public var description: String? = nil
    public var status: String    // running | completed | failed | killed
    public var outputTail: String
    /// ISO-8601 of the launch (the surfacing tool_result / first background event) — powers the
    /// tray's "5m ago". Optional, so it's nil until an event carrying `ts` lands and old snapshots
    /// still decode (synthesized Codable reads a missing optional as nil). Web parity: `BgShell.startedTs`.
    public var startedAt: String? = nil
}

/// A live tool-permission / question / plan prompt awaiting a human decision.
public struct PendingApproval: Equatable, Sendable, Identifiable, Codable {
    public enum Kind: String, Sendable, Codable { case tool, question, plan }
    public let id: String
    public var kind: Kind
    public var toolName: String?
    public var input: JSONValue?
    public init(id: String, kind: Kind, toolName: String?, input: JSONValue?) {
        self.id = id
        self.kind = kind
        self.toolName = toolName
        self.input = input
    }
}
