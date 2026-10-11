import Foundation

/// One model a configured provider offers (`models[]` on GET /api/providers). `contextWindow`
/// is optional — the context gauge falls back to the static table when a row omits it.
/// `reasoningLevels` is what a self-hosted Claude-runtime model declares it accepts; dispatch holds
/// the session's effort to it (see `AgentDefaults.efforts(for:model:catalog:configured:)`).
public struct ConfiguredProviderModel: Codable, Equatable, Sendable, Identifiable {
    public let value: String
    public let label: String
    public let contextWindow: Int?
    public let reasoningLevels: [String]?
    public var id: String { value }

    public init(value: String, label: String, contextWindow: Int? = nil,
                reasoningLevels: [String]? = nil) {
        self.value = value
        self.label = label
        self.contextWindow = contextWindow
        self.reasoningLevels = reasoningLevels
    }
}

/// A control-plane–configured provider (GET /api/providers): a key — its own slug, label and model
/// list — that one or more engines run on (docs/provider-engine-contract.md §2.1). Its slug lands in a
/// session's `provider` beside the engine that runs it, as an engine's own sign-in does. The account
/// pools ride the same shape (`ProviderPools.asProviders`), each running on its own engine alone. The
/// payload is de-sensitized (enabled providers only, no key/baseUrl). Mirrors web's
/// `ConfiguredProvider` (lib/workspaceDefaults.ts).
public struct ConfiguredProvider: Codable, Equatable, Sendable, Identifiable {
    /// The configured row's id, used to open its key editor in the web app.
    public var providerID: String? = nil
    public let slug: String
    public let label: String
    /// The protocol the key's endpoint speaks, named by the engine that speaks it natively: "claude"
    /// (Anthropic Messages), "codex" (OpenAI Responses), "kimi" (Moonshot) or "antigravity" (Gemini).
    /// Not the engine: which engines run the key is `engines` (`ProviderEngines.of`). Optional so a
    /// future server shape still decodes; nil reads as "claude", as on the server.
    public let runtime: String?
    public let models: [ConfiguredProviderModel]
    public let defaultModel: String?
    /// The vendor preset this provider was configured from — its brand identity, and where the
    /// new-session picker gets its mark. Nil for a self-maintained custom endpoint (which falls
    /// back to the neutral glyph). Optional so an older server's payload still decodes.
    public let presetSlug: String?
    /// True when this vendor's endpoint is the runtime CLI's own (Anthropic for claude, OpenAI for
    /// codex, Gemini for antigravity): the runner's live catalogue describes it, so `models` is only
    /// a fallback and the pickers follow the borrowed runtime's catalog instead. Optional so an
    /// older server's payload still decodes. Mirrors web's `ConfiguredProvider.modelsFromRuntime`.
    public let modelsFromRuntime: Bool?
    /// Subscription quota for *this row's credential*, when it has one to report (an Anthropic
    /// endpoint reached with a subscription token). Nil for a metered API key or a third-party
    /// endpoint, neither of which has a 5-hour/weekly window at all. Served by GET /providers.
    public let planUsage: PlanUsageSnapshot?
    /// Whether an OpenCode session may spend this key too (`OpenCodeKeys`), as GET /providers decides
    /// it. Nil from an older server, which reads as no.
    public var runsOnOpenCode: Bool? = nil
    /// Every engine this key runs on, its default first, as GET /providers and /providers/mine answer for
    /// it (docs/provider-engine-contract.md §6.3): a DeepSeek key on Claude Code, OpenCode and DeepSeek
    /// Harness, a Claude subscription token on Claude Code alone. Nil from an older server, which
    /// `ProviderEngines.of` reads as the key's runtime.
    public var engines: [String]? = nil
    /// The endpoint, and whether a key is stored — only on the account's own list (GET
    /// /providers/mine); the pickers' catalogue carries neither. What tells a DeepSeek key
    /// (`DeepSeekBalance.applies`) and names its endpoint on the key's page.
    public var baseUrl: String? = nil
    public var hasApiKey: Bool? = nil
    /// Whether the key is switched on. Only GET /providers/mine says — the account's own keys, disabled
    /// ones included (the Infrastructure page's API keys); the catalogue lists enabled keys alone, and
    /// nil reads as on.
    public var enabled: Bool? = nil
    public var id: String { slug }

    private enum CodingKeys: String, CodingKey {
        case providerID = "id"
        case slug, label, runtime, models, defaultModel, presetSlug, modelsFromRuntime, planUsage, runsOnOpenCode
        case engines
        case baseUrl, hasApiKey
        case enabled
    }

    public init(slug: String, label: String, runtime: String? = nil,
                models: [ConfiguredProviderModel] = [], defaultModel: String? = nil,
                presetSlug: String? = nil, modelsFromRuntime: Bool? = nil,
                planUsage: PlanUsageSnapshot? = nil, runsOnOpenCode: Bool? = nil,
                baseUrl: String? = nil, hasApiKey: Bool? = nil, enabled: Bool? = nil,
                engines: [String]? = nil) {
        self.slug = slug
        self.label = label
        self.runtime = runtime
        self.models = models
        self.defaultModel = defaultModel
        self.presetSlug = presetSlug
        self.modelsFromRuntime = modelsFromRuntime
        self.planUsage = planUsage
        self.runsOnOpenCode = runsOnOpenCode
        self.baseUrl = baseUrl
        self.hasApiKey = hasApiKey
        self.enabled = enabled
        self.engines = engines
    }
}
