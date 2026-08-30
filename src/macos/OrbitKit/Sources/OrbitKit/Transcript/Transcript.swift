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
    /// A sign-in failure, rendered as a remedy card rather than an error line: the runtime reports
    /// it as ordinary assistant text (or an `error` event, when the engine never got to spawn), but
    /// the fix is a human action — so the transcript offers the sign-in instead of a diagnosis.
    case authError(id: String, message: String)
    /// A failure that fixes itself — a spent quota, or the provider briefly unable to answer. Also
    /// plain assistant text, but neither an error to act on nor a reply: a pause, with a retry the
    /// server has already armed.
    case autoRetry(AutoRetryNotice)

    public var id: String {
        switch self {
        case .user(let b): return b.id
        case .assistant(let b): return b.id
        case .thinking(let b): return b.id
        case .toolCall(let c): return c.id
        case .interrupt(let id, _): return id
        case .error(let id, _): return id
        case .authError(let id, _): return id
        case .autoRetry(let n): return n.id
        }
    }
}

/// The transcript's record of one self-healing outage. What the *card* then shows depends on the
/// session's live retry state (see `AutoRetryLogic`), which is not transcript history and so is
/// read from the session detail at render time.
public struct AutoRetryNotice: Equatable, Sendable, Codable, Identifiable {
    /// Which self-healing failure this is. They differ only in wording and in how long the server
    /// keeps trying; everything else about the card is identical.
    public enum Variant: String, Equatable, Sendable, Codable { case quota, apiError }

    public let id: String
    /// The runtime's own sentence, verbatim.
    public let message: String
    public let variant: Variant
    public let seq: Int
    /// This outage is over: the session went on afterwards (any user message, whoever sent it —
    /// the retry firing, a manual retry, or the user typing something else). Only the newest card
    /// describes a live situation; the ones above it are history and must not show a countdown or
    /// offer to disarm a retry that belongs to a later failure.
    public var stale: Bool
    /// The user bubble the retry would re-send sits directly above this card, so quoting it inside
    /// the card would be the same sentence twice.
    public var afterUserMsg: Bool

    public init(id: String, message: String, variant: Variant, seq: Int,
                stale: Bool = false, afterUserMsg: Bool = false) {
        self.id = id
        self.message = message
        self.variant = variant
        self.seq = seq
        self.stale = stale
        self.afterUserMsg = afterUserMsg
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
    /// The run ended before this message was ever handed to the agent, so it never will be — the
    /// server drains still-queued turns when a session settles terminal, and says so with no event
    /// of its own. Replaces the "Sending…"/"Queued" indicator with "Not delivered" instead of
    /// leaving a message that is going nowhere looking like it is still on its way.
    public var undelivered: Bool
    /// What delivery appended to this message — a `#`-reference expansion, a list's condition
    /// board — kept verbatim and out of `text`. The runner echoes what it *received*, so without
    /// this separation Orbit's own generated context sits inside the person's bubble as if they
    /// had typed it. Named on one line by the view; see `splitDeliveredMessage`.
    public var injected: [String]
    /// Filed by the server as a steer: written into the turn that was already running rather than
    /// queued behind it. Not a variety of `queued` — the opposite of it: this message is not
    /// waiting for anything and cannot be withdrawn. Since it is answered by the turn it joined
    /// rather than by one of its own, `delivery` below is the only report it ever gets, so the
    /// indicator is shown for a steer where an ordinary message shows nothing. Learned from the
    /// POST response, and re-learned from the durable `user` event after a reload.
    public var steer: Bool
    /// How far this message got into the engine's conversation: the state its `user` event opened
    /// with, amended by each `user_delivery` after it (`SteerDelivery`). Nil for a transcript
    /// recorded before the runner reported delivery at all, and on every runtime that does not.
    public var delivery: String?

    public init(id: String, text: String, attachments: [TurnAttachment] = [], ts: String? = nil,
                clientTurnId: String? = nil, turnId: String? = nil, pending: Bool, queued: Bool = false,
                undelivered: Bool = false, injected: [String] = [], steer: Bool = false,
                delivery: String? = nil) {
        self.id = id
        self.text = text
        self.attachments = attachments
        self.ts = ts
        self.clientTurnId = clientTurnId
        self.turnId = turnId
        self.pending = pending
        self.queued = queued
        self.undelivered = undelivered
        self.injected = injected
        self.steer = steer
        self.delivery = delivery
    }

    // Tolerant decode so transcript snapshots written before `attachments`/`ts` existed still
    // rehydrate (those keys just default) instead of discarding the whole cached session.
    enum CodingKeys: String, CodingKey {
        case id, text, attachments, ts, clientTurnId, turnId, pending, queued, undelivered, injected
        case steer, delivery
    }
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
        undelivered = (try? c.decodeIfPresent(Bool.self, forKey: .undelivered)) ?? false
        injected = (try? c.decodeIfPresent([String].self, forKey: .injected)) ?? []
        steer = (try? c.decodeIfPresent(Bool.self, forKey: .steer)) ?? false
        delivery = try? c.decodeIfPresent(String.self, forKey: .delivery)
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
    /// Whether the result carried an image block at all — true even when `resultImages` is empty
    /// because the server dropped an oversized image's bytes (`MAX_IMAGE_PAYLOAD`). The card opens
    /// on this, and opening is what refetches the picture. Web parity: `hasResultImage`.
    public var resultHasImage: Bool
    public var status: ToolStatus
    /// seq of the `tool_use` event, and whether the server clipped its `input` to a preview.
    /// Expanding the card refetches the call whole (`APIClient.eventFull`).
    public var inputSeq: Int
    public var inputTruncated: Bool
    /// The same pair for the `tool_result` — a different event with its own seq.
    public var resultSeq: Int?
    public var resultTruncated: Bool

    public init(id: String, name: String, input: JSONValue, result: String?,
                resultImages: [Data] = [], resultHasImage: Bool = false, status: ToolStatus,
                inputSeq: Int = 0, inputTruncated: Bool = false,
                resultSeq: Int? = nil, resultTruncated: Bool = false) {
        self.id = id
        self.name = name
        self.input = input
        self.result = result
        self.resultImages = resultImages
        self.resultHasImage = resultHasImage
        self.status = status
        self.inputSeq = inputSeq
        self.inputTruncated = inputTruncated
        self.resultSeq = resultSeq
        self.resultTruncated = resultTruncated
    }

    // Tolerant decode so transcript snapshots written before `resultImages` existed still rehydrate
    // (the key just defaults to empty) instead of discarding the whole cached session.
    enum CodingKeys: String, CodingKey {
        case id, name, input, result, resultImages, resultHasImage, status, inputSeq, inputTruncated, resultSeq, resultTruncated
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        input = try c.decode(JSONValue.self, forKey: .input)
        result = try c.decodeIfPresent(String.self, forKey: .result)
        resultImages = (try? c.decodeIfPresent([Data].self, forKey: .resultImages)) ?? []
        // A snapshot written before this key existed falls back to what it can still see: bytes
        // present ⇒ an image was there.
        resultHasImage = (try? c.decodeIfPresent(Bool.self, forKey: .resultHasImage)) ?? !resultImages.isEmpty
        status = try c.decode(ToolStatus.self, forKey: .status)
        inputSeq = (try? c.decodeIfPresent(Int.self, forKey: .inputSeq)) ?? 0
        inputTruncated = (try? c.decodeIfPresent(Bool.self, forKey: .inputTruncated)) ?? false
        resultSeq = try? c.decodeIfPresent(Int.self, forKey: .resultSeq)
        resultTruncated = (try? c.decodeIfPresent(Bool.self, forKey: .resultTruncated)) ?? false
    }
}

/// The pieces of a tool card that can make its view need another untrimmed-payload fetch.
///
/// Kept UI-free so the trigger is directly testable: a foreground Shell starts expanded, meaning
/// `expanded` itself does not change when its final result arrives. A newly available truncated
/// result must still produce a different task identity, while live output snapshots (which change
/// only `result`) must not restart the fetch task four times a second.
public struct ToolPayloadResolutionKey: Equatable, Sendable {
    public let inputSeq: Int?
    public let resultSeq: Int?

    public init(card: ToolCard, expanded: Bool, needsWholeResult: Bool = false) {
        inputSeq = expanded && card.inputTruncated ? card.inputSeq : nil
        resultSeq = (expanded || needsWholeResult) && card.resultTruncated ? card.resultSeq : nil
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
