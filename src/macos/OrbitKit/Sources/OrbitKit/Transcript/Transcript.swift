import Foundation

// The render model the reducer produces. UI-free and Equatable so it can be asserted in
// tests and diffed cheaply by a SwiftUI view layer.

/// One renderable row in the conversation.
public enum TranscriptItem: Identifiable, Equatable, Sendable {
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

public struct UserBubble: Equatable, Sendable {
    public let id: String
    public var text: String
    public var attachmentIds: [String]
    public var clientTurnId: String?
    /// Optimistically shown before the server's `user` event confirms it.
    public var pending: Bool
}

public struct AssistantBubble: Equatable, Sendable {
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

public struct ThinkingBlock: Equatable, Sendable {
    public let id: String
    public var text: String
    public var streamingText: String
    public var seq: Int?
    public var displayText: String { text.isEmpty ? streamingText : text }
}

public enum ToolStatus: String, Equatable, Sendable {
    case running
    case ok
    case error
}

public struct ToolCard: Equatable, Sendable {
    public let id: String        // toolUseId
    public var name: String
    public var input: JSONValue
    public var result: String?
    public var status: ToolStatus
}

/// A background shell the agent launched with Bash(run_in_background).
public struct BackgroundProc: Equatable, Sendable, Identifiable {
    public let id: String
    public var command: String?
    public var status: String    // running | completed | failed | killed
    public var outputTail: String
}

/// A live tool-permission / question / plan prompt awaiting a human decision.
public struct PendingApproval: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable { case tool, question, plan }
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
