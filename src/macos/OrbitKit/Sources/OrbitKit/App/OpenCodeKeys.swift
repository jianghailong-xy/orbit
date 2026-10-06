import Foundation

/// How a session on OpenCode names the configured key it spends (web/shared `openCodeKeys`; keep the
/// two in sync). A configured key speaks one dialect — its endpoint's, which its row's runtime says —
/// and OpenCode speaks every one of them, so the server marks each key it may spend
/// (`ConfiguredProvider.runsOnOpenCode`). The session's provider stays `opencode`; the key rides in
/// its model as `orbit-<slug>/<model>`, which the server writes into the run's OpenCode config. The
/// pickers list such a key under OpenCode as `opencode/<slug>` — no configured slug holds a `/`.
public enum OpenCodeKeys {
    private static let modelPrefix = "orbit-"
    private static let choicePrefix = "opencode/"

    /// The OpenCode model id of `model` on the configured key `slug`.
    public static func model(_ slug: String, _ model: String) -> String { "\(modelPrefix)\(slug)/\(model)" }

    /// The configured key an OpenCode model id names, and the model on it — nil for any other id.
    public static func key(of model: String?) -> (slug: String, model: String)? {
        guard let model, model.hasPrefix(modelPrefix), let slash = model.firstIndex(of: "/") else { return nil }
        let slug = model[model.index(model.startIndex, offsetBy: modelPrefix.count)..<slash]
        let rest = model[model.index(after: slash)...]
        guard !slug.isEmpty, !rest.isEmpty else { return nil }
        return (String(slug), String(rest))
    }

    /// The picker identity of the configured key `slug` run on OpenCode.
    public static func choice(_ slug: String) -> String { "\(choicePrefix)\(slug)" }

    /// The configured key an `opencode/<slug>` choice names, or nil for any other identity.
    public static func choiceKey(_ choice: String?) -> String? {
        guard let choice, choice.hasPrefix(choicePrefix), choice.count > choicePrefix.count else { return nil }
        return String(choice.dropFirst(choicePrefix.count))
    }

    /// The picker identity a session runs on: its provider, except that an OpenCode session whose
    /// model names a configured key is on that key's choice (web `providerChoiceFor`).
    public static func choice(provider: String, model: String?) -> String {
        guard provider == "opencode", let key = key(of: model) else { return provider }
        return choice(key.slug)
    }
}
