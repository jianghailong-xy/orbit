import Foundation

/// Single source of truth for the composer's model / permission-mode / effort pickers. The
/// `claude` CLI has no list command, so (like the web's lib/agentDefaults) this is a static,
/// Opus-first list. Keep in sync with src/web/src/lib/agentDefaults.
public struct ModelOption: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
}

public struct ProviderOption: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
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
    ]

    public static let claudeModels: [ModelOption] = [
        ModelOption(id: "claude-fable-5", name: "Fable 5"),
        ModelOption(id: "claude-opus-4-8", name: "Opus 4.8"),
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

    public static let defaultModelID = "claude-opus-4-8"

    /// The models a provider's pickers offer. Anything that isn't exactly "codex" is Claude —
    /// matching apiserver's `agentProvider()`, so a stale provider string can't empty the menu.
    public static func models(for provider: String) -> [ModelOption] {
        provider == "codex" ? codexModels : claudeModels
    }

    public static func models(for provider: String, catalog: RunnerModelCatalog?) -> [ModelOption] {
        catalog?.models(for: provider) ?? models(for: provider)
    }

    /// Seed model for a provider when the agent has none. Mirrors web's DEFAULT_MODEL_BY_PROVIDER.
    public static func defaultModel(for provider: String) -> String {
        provider == "codex" ? "gpt-5.6-sol" : defaultModelID
    }

    public static func defaultModel(for provider: String, catalog: RunnerModelCatalog?) -> String {
        models(for: provider, catalog: catalog).first?.id ?? defaultModel(for: provider)
    }

    /// Display name for a model id, across providers. Unknown ids (an `ANTHROPIC_MODEL` env
    /// override pointing at a custom endpoint) render as the raw id.
    public static func friendlyName(_ id: String) -> String {
        (claudeModels + codexModels).first { $0.id == id }?.name ?? id
    }

    public static func friendlyName(_ id: String, catalog: RunnerModelCatalog?) -> String {
        (catalog?.models(for: "claude") ?? []).first { $0.id == id }?.name
            ?? (catalog?.models(for: "codex") ?? []).first { $0.id == id }?.name
            ?? friendlyName(id)
    }

    /// Reasoning-effort levels a provider accepts. Claude tops out at `max`; Codex's Responses API
    /// tops out at `xhigh` and adds `minimal`. Mirrors web's CLAUDE_/CODEX_EFFORT_OPTIONS. The
    /// server and runner both coerce an illegal value, but a picker should never offer one.
    public static func efforts(for provider: String) -> [Effort] {
        provider == "codex"
            ? [.default, .minimal, .low, .medium, .high, .xhigh]
            : [.default, .low, .medium, .high, .xhigh, .max]
    }

    /// Per-model context-window size (max input tokens), for the composer's context-usage
    /// gauge. Claude values are the models' true windows (Opus 4.8 / Sonnet 5 / Fable 5 =
    /// 1M, Haiku 4.5 = 200K); Codex is a best-effort default. Keep in sync with web's
    /// CONTEXT_WINDOW_BY_MODEL.
    public static func contextWindow(for id: String) -> Int {
        switch id {
        case "claude-fable-5", "claude-opus-4-8", "claude-sonnet-5": return 1_000_000
        case "claude-haiku-4-5": return 200_000
        case "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna": return 372_000
        case "gpt-5.5", "gpt-5.4", "gpt-5.4-mini": return 400_000
        default: return 200_000
        }
    }

    public static func contextWindow(for id: String, catalog: RunnerModelCatalog?) -> Int {
        catalog?.contextWindow(for: id) ?? contextWindow(for: id)
    }

    public static let permissionModes = PermissionMode.allCases

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
