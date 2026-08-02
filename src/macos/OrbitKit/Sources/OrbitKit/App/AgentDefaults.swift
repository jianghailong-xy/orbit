import Foundation

/// Single source of truth for the composer's model / permission-mode / effort pickers. The
/// `claude` CLI has no list command, so (like the web's lib/agentDefaults) this is a static,
/// Opus-first list. Keep in sync with src/web/src/lib/agentDefaults.
public struct ModelOption: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct ProviderOption: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
}

/// Tracks whether a model value has ever been selected explicitly by the user. Async runner and
/// provider refreshes may replace an initial seed only while this remains pristine; comparing the
/// model strings is insufficient because a user can pick away and then return to the seed.
public struct ModelSelectionRevision: Equatable, Sendable {
    public private(set) var value: UInt = 0
    public init() {}
    public var isPristine: Bool { value == 0 }
    public mutating func markUserEdit() { value &+= 1 }
}

/// Reasoning-effort levels offered in the composer, in the same order as web's EFFORT_OPTIONS.
/// `.default` ("") omits `--effort` so the model picks its own.
public enum Effort: String, CaseIterable, Sendable, Identifiable {
    case `default` = ""
    case minimal, low, medium, high, xhigh, max
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .default: return "Default"
        case .xhigh:   return "xHigh"
        default:       return rawValue.capitalized   // Minimal / Low / Medium / High / Max
        }
    }
    /// Wire value for a turn/resume request: nil = omit the field (same as Default).
    public var wire: String? { self == .default ? nil : rawValue }
}

public enum AgentDefaults {
    /// Provider runtimes an agent can target. Mirrors web's PROVIDER_OPTIONS.
    public static let providers: [ProviderOption] = [
        ProviderOption(id: "claude", name: "Claude"),
        ProviderOption(id: "codex", name: "Codex"),
        ProviderOption(id: "kimi", name: "Kimi"),
    ]

    /// Provider-picker options with the control-plane–configured providers appended after the
    /// built-ins. Mirrors web's mergedProviderOptions.
    public static func providers(configured: [ConfiguredProvider]?) -> [ProviderOption] {
        providers + (configured ?? []).map { ProviderOption(id: $0.slug, name: $0.label) }
    }

    /// Display name for a provider slug: a built-in's fixed label, then a configured provider's
    /// label, then the raw slug — a since-removed/disabled provider must not silently read as
    /// "Claude" (mirrors web's RunnerDetailPage providerLabel).
    public static func providerName(_ slug: String, configured: [ConfiguredProvider]?) -> String {
        providers.first { $0.id == slug }?.name
            ?? configuredProvider(slug, in: configured)?.label
            ?? slug
    }

    /// Resolve a configured provider by slug — a built-in slug never matches (the server refuses
    /// to mint one), so built-in runtimes always resolve to the static/catalog lists.
    private static func configuredProvider(_ slug: String,
                                           in configured: [ConfiguredProvider]?) -> ConfiguredProvider? {
        configured?.first { $0.slug == slug }
    }

    /// Mirrors Claude Code's `/model` picker (Opus 5 default / Fable 5 / Sonnet 5 / Haiku 4.5).
    /// Previous models (Opus 4.8, …) stay reachable by pinning the id directly and render as their
    /// raw id, same as any other non-current model.
    public static let claudeModels: [ModelOption] = [
        ModelOption(id: "claude-opus-5", name: "Opus 5"),
        ModelOption(id: "claude-fable-5", name: "Fable 5"),
        ModelOption(id: "claude-sonnet-5", name: "Sonnet 5"),
        ModelOption(id: "claude-haiku-4-5", name: "Haiku 4.5"),
    ]

    public static let codexModels: [ModelOption] = [
        ModelOption(id: "gpt-5.6-sol", name: "GPT-5.6-Sol"),
        ModelOption(id: "gpt-5.6-terra", name: "GPT-5.6-Terra"),
        ModelOption(id: "gpt-5.6-luna", name: "GPT-5.6-Luna"),
        ModelOption(id: "gpt-5.5", name: "GPT-5.5"),
        ModelOption(id: "gpt-5.4", name: "GPT-5.4"),
        ModelOption(id: "gpt-5.4-mini", name: "GPT-5.4 Mini"),
    ]

    public static let kimiModels: [ModelOption] = [
        ModelOption(id: "kimi-code/kimi-for-coding", name: "Kimi for Coding"),
    ]

    public static let defaultModelID = "claude-opus-5"

    /// The models a provider's pickers offer. Unknown provider strings fall back to Claude so a
    /// stale value can't empty the menu.
    public static func models(for provider: String) -> [ModelOption] {
        switch provider {
        case "codex": return codexModels
        case "kimi":  return kimiModels
        default:      return claudeModels
        }
    }

    public static func models(for provider: String, catalog: RunnerModelCatalog?) -> [ModelOption] {
        catalog?.models(for: provider) ?? models(for: provider)
    }

    /// As `models(for:catalog:)`, but a configured provider's own model list (from the control
    /// plane) wins for its slug. Mirrors web's modelOptionsForProvider.
    public static func models(for provider: String, catalog: RunnerModelCatalog?,
                              configured: [ConfiguredProvider]?) -> [ModelOption] {
        if let custom = configuredProvider(provider, in: configured) {
            let options = custom.models
                .filter { !$0.value.isEmpty && !$0.label.isEmpty }
                .map { ModelOption(id: $0.value, name: $0.label) }
            // Keep an empty custom model space empty. The composer inserts the effective fallback
            // as its sole row; falling through would leak Claude models into custom Codex.
            return options
        }
        return models(for: provider, catalog: catalog)
    }

    /// Static fallback when neither Runtime default nor catalog is available. Mirrors web's
    /// DEFAULT_MODEL_BY_PROVIDER.
    public static func defaultModel(for provider: String) -> String {
        switch provider {
        case "codex": return "gpt-5.6-sol"
        case "kimi":  return "kimi-code/kimi-for-coding"
        default:      return defaultModelID
        }
    }

    public static func defaultModel(for provider: String, catalog: RunnerModelCatalog?) -> String {
        models(for: provider, catalog: catalog).first?.id ?? defaultModel(for: provider)
    }

    /// As `defaultModel(for:catalog:)`, preferring a configured provider's declared default,
    /// then its first model, then the static default of the runtime it borrows. Mirrors web's
    /// defaultModelForProvider.
    public static func defaultModel(for provider: String, catalog: RunnerModelCatalog?,
                                    configured: [ConfiguredProvider]?) -> String {
        if let custom = configuredProvider(provider, in: configured) {
            if let def = custom.defaultModel, !def.isEmpty { return def }
            if let first = custom.models.first(where: { !$0.value.isEmpty && !$0.label.isEmpty }) {
                return first.value
            }
            return defaultModel(for: custom.runtime == "codex" ? "codex" : "claude")
        }
        return models(for: provider, catalog: catalog).first?.id ?? defaultModel(for: provider)
    }

    /// Resolve the model a brand-new session should start with. A configured provider owns its
    /// separate model space/default. For built-in runtimes, the heartbeat-reported effective
    /// default wins, then the runner catalog's first model, then the static fallback.
    public static func effectiveDefaultModel(for provider: String, catalog: RunnerModelCatalog?,
                                             configured: [ConfiguredProvider]?,
                                             runtimeDefaults: [String: String]?) -> String {
        if configuredProvider(provider, in: configured) != nil {
            return defaultModel(for: provider, catalog: catalog, configured: configured)
        }
        // A removed/disabled custom identity executes through the historical Claude fallback.
        // Normalize it before consulting heartbeat/catalog data; an unknown slug must never mint
        // a separate Runtime-default namespace or bypass Claude's reported default.
        let runtime = providers.contains(where: { $0.id == provider }) ? provider : "claude"
        if let saved = runtimeDefaults?[runtime], !saved.isEmpty { return saved }
        return defaultModel(for: runtime, catalog: catalog, configured: configured)
    }

    /// Resolve a persisted built-in/configured provider identity to the local runtime that
    /// executes it. Missing configured providers retain the server's historical Claude fallback.
    public static func runtime(for provider: String,
                               configured: [ConfiguredProvider]? = nil) -> String {
        if let custom = configuredProvider(provider, in: configured) {
            // Configured providers currently borrow only Claude or Codex. Invalid legacy values
            // use the same safe Claude fallback as the backend.
            return custom.runtime == "codex" ? "codex" : "claude"
        }
        let value = provider
        return value == "codex" || value == "kimi" ? value : "claude"
    }

    public static func isBuiltInProvider(_ provider: String) -> Bool {
        providers.contains { $0.id == provider }
    }

    /// Re-resolve an already-rendered seed from freshly fetched Runtime data. A failed runner read
    /// keeps the current value. Likewise, an unavailable providers response cannot safely replace
    /// a custom provider's cached seed with the built-in Claude fallback.
    public static func refreshedDefaultModel(currentModel: String, for provider: String,
                                             catalog: RunnerModelCatalog?,
                                             configured: [ConfiguredProvider]?,
                                             runtimeDefaults: [String: String]?,
                                             runnerSnapshotLoaded: Bool,
                                             configuredProvidersLoaded: Bool) -> String {
        let isBuiltIn = providers.contains { $0.id == provider }
        // A configured provider owns its default and does not depend on runner heartbeat data.
        if configuredProvidersLoaded,
           configuredProvider(provider, in: configured) != nil {
            return defaultModel(for: provider, catalog: catalog, configured: configured)
        }
        guard runnerSnapshotLoaded else { return currentModel }
        if !isBuiltIn, configuredProvider(provider, in: configured) == nil,
           !configuredProvidersLoaded {
            return currentModel
        }
        return effectiveDefaultModel(
            for: provider, catalog: catalog, configured: configured,
            runtimeDefaults: runtimeDefaults)
    }

    /// Display name for a model id, across providers. Unknown ids (an `ANTHROPIC_MODEL` env
    /// override pointing at a custom endpoint) render as the raw id.
    public static func friendlyName(_ id: String) -> String {
        (claudeModels + codexModels + kimiModels).first { $0.id == id }?.name ?? id
    }

    public static func friendlyName(_ id: String, catalog: RunnerModelCatalog?) -> String {
        (catalog?.models(for: "claude") ?? []).first { $0.id == id }?.name
            ?? (catalog?.models(for: "codex") ?? []).first { $0.id == id }?.name
            ?? (catalog?.models(for: "kimi") ?? []).first { $0.id == id }?.name
            ?? friendlyName(id)
    }

    /// As `friendlyName(_:catalog:)`, also checking the configured providers' model rows — a
    /// custom provider's model id renders its label, not the raw id.
    public static func friendlyName(_ id: String, catalog: RunnerModelCatalog?,
                                    configured: [ConfiguredProvider]?) -> String {
        (configured ?? []).flatMap(\.models).first { $0.value == id }?.label
            ?? friendlyName(id, catalog: catalog)
    }

    /// Reasoning-effort levels a provider accepts. Claude tops out at `max`; Codex's Responses API
    /// tops out at `xhigh` and adds `minimal`; managed Kimi exposes low/high/max. Mirrors web. The
    /// server and runner both coerce an illegal value, but a picker should never offer one.
    public static func efforts(for provider: String) -> [Effort] {
        switch provider {
        case "codex": return [.default, .minimal, .low, .medium, .high, .xhigh]
        case "kimi":  return [.default, .low, .high, .max]
        default:      return [.default, .low, .medium, .high, .xhigh, .max]
        }
    }

    /// Coerce a saved/account effort when it crosses into a runtime with a smaller effort
    /// vocabulary. Mirrors the API normalization so stale sessions and synced preferences render
    /// the same value the runtime will actually receive.
    public static func normalizeEffort(_ effort: Effort, for provider: String) -> Effort {
        switch provider {
        case "codex":
            return effort == .max ? .xhigh : effort
        case "kimi":
            switch effort {
            case .minimal: return .low
            case .medium:  return .high
            case .xhigh:   return .max
            default:       return effort
            }
        default:
            return effort
        }
    }

    /// Per-model context-window size (max input tokens), for the composer's context-usage gauge.
    /// Claude only: these are the models' true windows (Opus 5 / Fable 5 / Sonnet 5 = 1M,
    /// Haiku 4.5 = 200K), and the Claude CLI has no way to report them, so they have to live here.
    /// Codex models are absent on purpose — the runner catalog carries their real `context_window`
    /// from `codex debug models`, so it stays right as Codex ships new models. Keep in sync with
    /// web's CONTEXT_WINDOW_BY_MODEL.
    private static func knownContextWindow(for id: String) -> Int? {
        switch id {
        case "claude-opus-5", "claude-fable-5", "claude-sonnet-5": return 1_000_000
        case "claude-haiku-4-5": return 200_000
        case "kimi-code/kimi-for-coding": return 262_144
        default: return nil
        }
    }

    public static func contextWindow(for id: String) -> Int {
        knownContextWindow(for: id) ?? 200_000
    }

    public static func contextWindow(for id: String, catalog: RunnerModelCatalog?) -> Int {
        if let known = knownContextWindow(for: id) { return known }
        return catalog?.contextWindow(for: id) ?? 200_000
    }

    /// As `contextWindow(for:catalog:)`, checking the configured providers' model rows first —
    /// their windows come from the control plane, not the runner. Mirrors web's contextWindowFor.
    public static func contextWindow(for id: String, catalog: RunnerModelCatalog?,
                                     configured: [ConfiguredProvider]?) -> Int {
        if let window = (configured ?? []).flatMap(\.models)
            .first(where: { $0.value == id && ($0.contextWindow ?? 0) > 0 })?.contextWindow {
            return window
        }
        return contextWindow(for: id, catalog: catalog)
    }

    public static let permissionModes = PermissionMode.allCases

    /// Claude's Auto mode is model-specific. Codex does not expose it, while Kimi exposes Auto as
    /// a runtime-wide permission mode (including arbitrary locally configured model aliases).
    public static let autoCapableModels: Set<String> = [
        "claude-opus-5",
        "claude-fable-5",
        "claude-sonnet-5",
        "kimi-code/kimi-for-coding",
    ]

    public static func supportsAuto(_ model: String, provider: String = "claude",
                                    configured: [ConfiguredProvider]? = nil) -> Bool {
        switch runtime(for: provider, configured: configured) {
        case "kimi":  return true
        case "codex": return false
        default:      return autoCapableModels.contains(model)
        }
    }

    /// Prevent the UI from carrying a model/mode pair that the runtime will reject. The backend
    /// applies the same normalization as a final safety net.
    public static func clampPermissionMode(_ mode: PermissionMode,
                                           for model: String, provider: String = "claude",
                                           configured: [ConfiguredProvider]? = nil) -> PermissionMode {
        mode == .auto && !supportsAuto(model, provider: provider, configured: configured)
            ? .default : mode
    }

    public static func label(_ mode: PermissionMode) -> String {
        switch mode {
        case .default:     return "Default"
        case .acceptEdits: return "Accept Edits"
        case .plan:        return "Plan"
        case .auto:        return "Auto"
        case .dontAsk:     return "Don't Ask"
        case .bypass:      return "Bypass"
        }
    }
}
