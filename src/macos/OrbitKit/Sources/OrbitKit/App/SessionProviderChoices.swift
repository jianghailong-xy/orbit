import Foundation

/// What the new-session provider picker offers: the runner's own signed-in engines first, then
/// this account's configured (BYOK) providers. Two groups, because they differ in the one way a
/// user cares about — an engine spends the subscription signed into on that machine, a configured
/// provider spends the API key you pasted.
///
/// Mirrors web's `lib/sessionProviderChoices.ts`; keep the two in sync.
public struct ProviderChoice: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable { case engine, byok }

    public let slug: String
    public let label: String
    public let kind: Kind
    /// Which brand's mark/tint to draw. A built-in engine borrows its vendor preset, a configured
    /// provider uses the preset it was created from, and a self-maintained endpoint has none.
    public let brandKey: String?
    /// The model this choice runs with unless something overrides it, already resolved to a label —
    /// so "switching provider changes your model" is visible before the tap.
    public let modelLabel: String
    public var id: String { slug }

    public init(slug: String, label: String, kind: Kind, brandKey: String?, modelLabel: String) {
        self.slug = slug
        self.label = label
        self.kind = kind
        self.brandKey = brandKey
        self.modelLabel = modelLabel
    }
}

public enum SessionProviderChoices {
    /// Exactly the slugs a runner can sign into (`LoginEngine` in @orbit/shared). `opencode` is a
    /// fourth built-in provider but not a login engine, so it is never offered — it only appears
    /// as the current pick when an agent is already set to it.
    public static let engineSlugs = ["claude", "codex", "kimi"]

    /// A built-in engine has no configured row, so it has no preset to inherit a look from. Borrow
    /// the vendor preset carrying the same mark: the engine and the BYOK provider are the same
    /// company, and a user who sees both should see one logo.
    static let enginePreset: [String: String] = [
        "claude": "anthropic", "codex": "openai", "kimi": "moonshot",
    ]

    /// The picker's contents. Engines always come first and are always all three: they are what a
    /// user with nothing configured can still run, so the list is never empty.
    public static func choices(configured: [ConfiguredProvider],
                               catalog: RunnerModelCatalog? = nil) -> [ProviderChoice] {
        let engines = engineSlugs.map { slug in
            ProviderChoice(
                slug: slug,
                label: AgentDefaults.providerName(slug, configured: configured),
                kind: .engine,
                brandKey: enginePreset[slug],
                modelLabel: modelLabel(for: slug, configured: configured, catalog: catalog))
        }
        // A configured row shadowing a built-in slug would give two entries that dispatch the same
        // identity; the engine entry above already covers it.
        let byok = configured
            .filter { !engineSlugs.contains($0.slug) }
            .map { provider in
                ProviderChoice(
                    slug: provider.slug,
                    label: provider.label,
                    kind: .byok,
                    brandKey: provider.presetSlug,
                    modelLabel: modelLabel(for: provider.slug, configured: configured, catalog: catalog))
            }
        return engines + byok
    }

    /// The entry to show as current. An agent set to `opencode`, or pointing at a provider that has
    /// since been removed or disabled, resolves to nothing above — both still have to render
    /// truthfully rather than silently reading as Claude, so they get a synthesized entry.
    public static func current(_ provider: String,
                               in choices: [ProviderChoice],
                               configured: [ConfiguredProvider],
                               catalog: RunnerModelCatalog? = nil) -> ProviderChoice {
        if let found = choices.first(where: { $0.slug == provider }) { return found }
        return ProviderChoice(
            slug: provider,
            label: AgentDefaults.providerName(provider, configured: configured),
            kind: AgentDefaults.isBuiltInProvider(provider) ? .engine : .byok,
            brandKey: enginePreset[provider] ?? configured.first { $0.slug == provider }?.presetSlug,
            modelLabel: modelLabel(for: provider, configured: configured, catalog: catalog))
    }

    /// The label for a provider's resolved default model, or a plain hint when the provider picks
    /// for itself (OpenCode sends no model and resolves its own).
    static func modelLabel(for provider: String,
                           configured: [ConfiguredProvider],
                           catalog: RunnerModelCatalog?) -> String {
        let model = AgentDefaults.defaultModel(for: provider, catalog: catalog, configured: configured)
        guard !model.isEmpty else { return "Managed by the provider" }
        return AgentDefaults.friendlyName(model, catalog: catalog, configured: configured)
    }
}
