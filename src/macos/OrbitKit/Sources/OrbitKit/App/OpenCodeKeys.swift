import Foundation

/// The protocol a configured key's endpoint speaks, and how an OpenCode session an older client started
/// on a key named it (shared `openCodeKeys`; keep the two in sync). A key speaks exactly one dialect —
/// its endpoint's, which its row's runtime says — and OpenCode speaks every one of them, so a key runs on
/// OpenCode beside its dialect's own engine (`ProviderEngines`). A session on OpenCode stores the key's
/// own slug as its provider and the bare model; dispatch alone names the key for OpenCode.
public enum OpenCodeKeys {
    /// What a key's endpoint speaks: Anthropic Messages, OpenAI Responses, Moonshot's own API or Gemini's.
    public enum Dialect: Equatable, Sendable {
        case anthropic, openai, openaiCompatible, gemini
    }

    /// The dialect a configured key's endpoint speaks, from the runtime its row names. DeepSeek Harness
    /// rows hold DeepSeek's Anthropic-compatible endpoint; anything unknown speaks nothing.
    public static func dialect(_ runtime: String?) -> Dialect? {
        switch runtime ?? "claude" {
        case "claude", "dsh": return .anthropic
        case "codex": return .openai
        case "kimi": return .openaiCompatible
        case "antigravity": return .gemini
        default: return nil
        }
    }

    private static let modelPrefix = "orbit-"

    /// The configured key an older OpenCode model id names, `orbit-<slug>/<model>`, and the model on it —
    /// nil for any other id (OpenCode's own `provider/model`, the empty "managed by OpenCode" pick). Read
    /// only: a session or a preference an older client wrote still carries it (contract §3.3).
    public static func key(of model: String?) -> (slug: String, model: String)? {
        guard let model, model.hasPrefix(modelPrefix), let slash = model.firstIndex(of: "/") else { return nil }
        let slug = model[model.index(model.startIndex, offsetBy: modelPrefix.count)..<slash]
        let rest = model[model.index(after: slash)...]
        guard !slug.isEmpty, !rest.isEmpty else { return nil }
        return (String(slug), String(rest))
    }
}
