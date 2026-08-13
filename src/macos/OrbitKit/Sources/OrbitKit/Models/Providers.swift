import Foundation

/// One model a configured provider offers (`models[]` on GET /api/providers). `contextWindow`
/// is optional — the context gauge falls back to the static table when a row omits it.
public struct ConfiguredProviderModel: Codable, Equatable, Sendable, Identifiable {
    public let value: String
    public let label: String
    public let contextWindow: Int?
    public var id: String { value }

    public init(value: String, label: String, contextWindow: Int? = nil) {
        self.value = value
        self.label = label
        self.contextWindow = contextWindow
    }
}

/// A control-plane–configured provider (GET /api/providers): a custom identity (its own slug,
/// label and model list) that borrows a built-in runtime for execution. Its slug lands in an
/// agent/session's `provider` field just like a built-in, so `AgentDefaults` merges it into the
/// pickers alongside claude/codex. The payload is de-sensitized (enabled providers only, no
/// key/baseUrl). Mirrors web's `ConfiguredProvider` (lib/agentDefaults.ts).
public struct ConfiguredProvider: Codable, Equatable, Sendable, Identifiable {
    public let slug: String
    public let label: String
    /// The built-in runtime the provider borrows ("claude" in Phase 1). Optional so a future
    /// server shape still decodes; nothing client-side branches on it yet.
    public let runtime: String?
    public let models: [ConfiguredProviderModel]
    public let defaultModel: String?
    /// The vendor preset this provider was configured from — its brand identity, and where the
    /// new-session picker gets its mark. Nil for a self-maintained custom endpoint (which falls
    /// back to the neutral glyph). Optional so an older server's payload still decodes.
    public let presetSlug: String?
    /// True when this vendor's endpoint is the runtime CLI's own (Anthropic for claude, OpenAI for
    /// codex): the runner's live catalogue describes it, so `models` is only a fallback and the
    /// pickers follow the borrowed runtime's catalog instead. Optional so an older server's payload
    /// still decodes. Mirrors web's `ConfiguredProvider.modelsFromRuntime`.
    public let modelsFromRuntime: Bool?
    public var id: String { slug }

    public init(slug: String, label: String, runtime: String? = nil,
                models: [ConfiguredProviderModel] = [], defaultModel: String? = nil,
                presetSlug: String? = nil, modelsFromRuntime: Bool? = nil) {
        self.slug = slug
        self.label = label
        self.runtime = runtime
        self.models = models
        self.defaultModel = defaultModel
        self.presetSlug = presetSlug
        self.modelsFromRuntime = modelsFromRuntime
    }
}
