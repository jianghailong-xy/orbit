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
    /// Whether an agent created from here on starts allowed to orchestrate other sessions. A seed
    /// for that agent's own switch, never the permission itself — the server enforces
    /// `Agent.enableOrchestration`, so this can't grant anything to an agent that already exists.
    /// Absent = off.
    public let defaultEnableOrchestration: Bool?
}

/// PATCH /users/me/preferences — only the present keys are merged; nil omits (synthesized
/// `encodeIfPresent`), matching the server's shallow-merge "keep omitted".
public struct UpdatePreferencesRequest: Encodable, Sendable {
    public var theme: String?
    public var defaultModel: String?
    public var defaultPermissionMode: String?
    public var defaultEffort: String?
    public var defaultEnableOrchestration: Bool?
    public init(theme: String? = nil, defaultModel: String? = nil, defaultPermissionMode: String? = nil,
                defaultEffort: String? = nil, defaultEnableOrchestration: Bool? = nil) {
        self.theme = theme
        self.defaultModel = defaultModel
        self.defaultPermissionMode = defaultPermissionMode
        self.defaultEffort = defaultEffort
        self.defaultEnableOrchestration = defaultEnableOrchestration
    }
}
