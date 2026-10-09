import Foundation

// User preferences, mirroring users.controller `me` / `me/preferences` (UpdatePreferencesDto).
// The PATCH body is a partial set shallow-merged server-side: an omitted key keeps its value.
// `defaultModels` also merges its provider entries, preserving the other providers' choices.
// `theme` / `defaultPermissionMode` are kept as `String` (not enums) so an unknown future value
// decodes rather than throwing — the app maps known values and ignores the rest.

public struct UserPreferences: Codable, Equatable, Sendable {
    public let theme: String?                  // "system" | "light" | "dark"
    public let defaultModel: String?
    /// Last-picked model per provider, synced across clients.
    public let defaultModels: [String: String]?
    public let defaultPermissionMode: String?
    /// Account-wide default reasoning effort for a new session (last-picked-wins). "" = model
    /// default; otherwise an `Effort` raw value. Synced so a value chosen on web seeds new
    /// sessions here, and vice-versa (replaces web's per-browser localStorage).
    public let defaultEffort: String?
    /// Whether this account's sessions may orchestrate — spawn and drive other sessions via the orbit
    /// MCP session tools. One switch for every workspace, enforced server-side on each claim, spawn
    /// and call. Absent means on; only opting out is ever written.
    public let enableOrchestration: Bool?
    /// Whether a session settling — finished on its own, or failed for good — pushes an alert to
    /// this account's devices. Absent means on; only opting out is ever written.
    public let notifySessionFinished: Bool?
    /// Whether an agent may push a line of its own (the `notify` tool / `orbit notify`) to this
    /// account's devices. Absent means on; only opting out is ever written.
    public let notifyAgentMessage: Bool?
    /// The account's master switch for smart model selection (docs/model-routing-design.md). Off
    /// unless it is exactly `true`: absent, or anything but a boolean, decodes nil and reads as off
    /// (`smartModelSelection`), so a stray value never fails the whole `me` payload.
    public let modelRouting: Bool?
    /// Whether this account's Claude sessions offer the next message it would probably type once a
    /// turn ends (docs/prompt-suggestions-design.md). Absent means on; only opting out is ever
    /// written. Tolerant like `modelRouting`: a stray value reads as absent rather than failing `me`.
    public let promptSuggestions: Bool?

    /// Whether smart model selection is on for this account — only an explicit `true` turns it on.
    public var smartModelSelection: Bool { modelRouting == true }
    /// Whether suggested replies are on for this account — on unless explicitly turned off.
    public var suggestedReplies: Bool { promptSuggestions != false }

    private enum CodingKeys: String, CodingKey {
        case theme, defaultModel, defaultModels, defaultPermissionMode, defaultEffort
        case enableOrchestration, notifySessionFinished, notifyAgentMessage, modelRouting, promptSuggestions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        theme = try c.decodeIfPresent(String.self, forKey: .theme)
        defaultModel = try c.decodeIfPresent(String.self, forKey: .defaultModel)
        defaultModels = try c.decodeIfPresent([String: String].self, forKey: .defaultModels)
        defaultPermissionMode = try c.decodeIfPresent(String.self, forKey: .defaultPermissionMode)
        defaultEffort = try c.decodeIfPresent(String.self, forKey: .defaultEffort)
        enableOrchestration = try c.decodeIfPresent(Bool.self, forKey: .enableOrchestration)
        notifySessionFinished = try c.decodeIfPresent(Bool.self, forKey: .notifySessionFinished)
        notifyAgentMessage = try c.decodeIfPresent(Bool.self, forKey: .notifyAgentMessage)
        modelRouting = (try? c.decodeIfPresent(Bool.self, forKey: .modelRouting)) ?? nil
        promptSuggestions = (try? c.decodeIfPresent(Bool.self, forKey: .promptSuggestions)) ?? nil
    }
}

/// PATCH /users/me/preferences — only the present keys are merged; nil omits (synthesized
/// `encodeIfPresent`), matching the server's shallow-merge "keep omitted".
public struct UpdatePreferencesRequest: Encodable, Sendable {
    public var theme: String?
    public var defaultModel: String?
    public var defaultModels: [String: String]?
    public var defaultPermissionMode: String?
    public var defaultEffort: String?
    public var enableOrchestration: Bool?
    public var notifySessionFinished: Bool?
    public var notifyAgentMessage: Bool?
    public var modelRouting: Bool?
    public var promptSuggestions: Bool?
    public init(theme: String? = nil, defaultModel: String? = nil, defaultModels: [String: String]? = nil,
                defaultPermissionMode: String? = nil,
                defaultEffort: String? = nil, enableOrchestration: Bool? = nil,
                notifySessionFinished: Bool? = nil, notifyAgentMessage: Bool? = nil,
                modelRouting: Bool? = nil, promptSuggestions: Bool? = nil) {
        self.theme = theme
        self.defaultModel = defaultModel
        self.defaultModels = defaultModels
        self.defaultPermissionMode = defaultPermissionMode
        self.defaultEffort = defaultEffort
        self.enableOrchestration = enableOrchestration
        self.notifySessionFinished = notifySessionFinished
        self.notifyAgentMessage = notifyAgentMessage
        self.modelRouting = modelRouting
        self.promptSuggestions = promptSuggestions
    }
}
