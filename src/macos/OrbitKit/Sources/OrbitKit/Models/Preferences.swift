import Foundation

// User preferences, mirroring users.controller `me` / `me/preferences` (UpdatePreferencesDto).
// The PATCH body is a partial set shallow-merged server-side: an omitted key keeps its value.
// `theme` / `defaultPermissionMode` are kept as `String` (not enums) so an unknown future value
// decodes rather than throwing — the app maps known values and ignores the rest.

public struct UserPreferences: Codable, Equatable, Sendable {
    public let theme: String?                  // "system" | "light" | "dark"
    public let defaultModel: String?
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
}

/// PATCH /users/me/preferences — only the present keys are merged; nil omits (synthesized
/// `encodeIfPresent`), matching the server's shallow-merge "keep omitted".
public struct UpdatePreferencesRequest: Encodable, Sendable {
    public var theme: String?
    public var defaultModel: String?
    public var defaultPermissionMode: String?
    public var defaultEffort: String?
    public var enableOrchestration: Bool?
    public var notifySessionFinished: Bool?
    public var notifyAgentMessage: Bool?
    public init(theme: String? = nil, defaultModel: String? = nil, defaultPermissionMode: String? = nil,
                defaultEffort: String? = nil, enableOrchestration: Bool? = nil,
                notifySessionFinished: Bool? = nil, notifyAgentMessage: Bool? = nil) {
        self.theme = theme
        self.defaultModel = defaultModel
        self.defaultPermissionMode = defaultPermissionMode
        self.defaultEffort = defaultEffort
        self.enableOrchestration = enableOrchestration
        self.notifySessionFinished = notifySessionFinished
        self.notifyAgentMessage = notifyAgentMessage
    }
}
