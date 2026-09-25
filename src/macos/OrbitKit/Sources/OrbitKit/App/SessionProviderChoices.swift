import Foundation

/// What the new-session provider picker offers: the runner's own signed-in engines first, then
/// this account's account pools, then its configured (BYOK) providers. Grouped, because they differ
/// in the one way a user cares about — an engine spends the subscription signed into on that
/// machine, a configured provider spends the API key you pasted, and a pool spends whichever of
/// its accounts has the most room.
///
/// Mirrors web's `lib/sessionProviderChoices.ts`; keep the two in sync.
public struct ProviderChoice: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable { case engine, byok, pool }

    public let slug: String
    public let label: String
    public let kind: Kind
    /// Which brand's mark/tint to draw. A built-in engine borrows its vendor preset, a configured
    /// provider uses the preset it was created from, and a self-maintained endpoint has none.
    public let brandKey: String?
    /// The model this choice runs with unless something overrides it, already resolved to a label —
    /// so "switching provider changes your model" is visible before the tap.
    public let modelLabel: String
    /// Why this choice can't run on the runner the session is on, or nil when it can. Set for an
    /// engine whose CLI that machine doesn't have, or has but says it isn't signed into. The row
    /// stays listed and carries the reason rather than disappearing: hiding it turns "not signed
    /// in on this runner" into "Orbit lost my provider", which is the one question the picker
    /// exists to answer. Set too for an account pool the server says cannot run at all
    /// (`ProviderPool.unavailable`) — a reason no machine fixes, which is why `fixEngine` stays nil
    /// for it. Not for one whose accounts are only spent: that one waits for a reset (`note`).
    public let unavailable: String?
    /// Which engine row on the Providers page fixes `unavailable`. That is the CLI this choice
    /// runs on, which for a BYOK provider is not its own slug — a Moonshot row is fixed on the
    /// Kimi engine row. Set whenever a runner can fix `unavailable`; nil on a pool whose accounts
    /// are what is missing, whose row is greyed out rather than sent anywhere.
    public let fixEngine: String?
    /// An account pool: how many accounts it holds, counted on its mark. Nil for anything else.
    public let poolSize: Int?
    /// A configured provider that is also an account in one of the user's pools. Still pickable on
    /// its own — pinning one account is a real need — but offered behind "Pin a specific account",
    /// since the pool beside it already runs on it.
    public let inPool: Bool
    /// What the row says in place of its model while it still takes the pick: an account pool whose
    /// accounts that can run are all spent, and when the first frees up (`ProviderPools.spentNote`).
    /// Nil for anything else.
    public let note: String?
    public var id: String { slug }

    public init(slug: String, label: String, kind: Kind, brandKey: String?, modelLabel: String,
                unavailable: String? = nil, fixEngine: String? = nil, poolSize: Int? = nil,
                inPool: Bool = false, note: String? = nil) {
        self.slug = slug
        self.label = label
        self.kind = kind
        self.brandKey = brandKey
        self.modelLabel = modelLabel
        self.unavailable = unavailable
        self.fixEngine = fixEngine
        self.poolSize = poolSize
        self.inPool = inPool
        self.note = note
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

    /// Why an engine can't run a session on that machine, or nil when it can. Missing outranks
    /// signed out — a CLI that isn't installed has nothing to sign into. Only the CLI's own "no"
    /// counts for auth: `unknown` is an engine that wouldn't answer, which is not evidence enough
    /// to take the choice away. Mirrors web's `engineBlocker`.
    static func engineBlocker(_ health: RunnerEngineHealth?) -> String? {
        guard let health else { return nil }
        if health.installed == false { return "Not installed" }
        if health.auth == "no" { return "Not signed in" }
        return nil
    }

    /// The same question for a configured provider, which runs by borrowing an engine's CLI (a
    /// Moonshot row spawns the Kimi CLI with its key in the environment). The binary has to be
    /// there, so a missing one blocks it exactly as it blocks the engine. Sign-in doesn't apply:
    /// the pasted key is the credential, and a signed-out CLI runs this provider fine.
    static func byokBlocker(_ health: RunnerEngineHealth?) -> String? {
        health?.installed == false ? "Not installed" : nil
    }

    /// The picker's contents. Engines always come first and are always all three: they are what a
    /// user with nothing configured can still run, so the list is never empty.
    ///
    /// `engines` is the health the runner last reported, because every choice here is a claim about
    /// someone else's machine. A runner that has reported nothing claims nothing, so all three stay
    /// runnable — as does any engine missing from a partial report.
    ///
    /// The user's account pools come after the engines, each one choice that runs on Claude with its
    /// accounts' own keys. The providers in a pool stay pickable, marked `inPool` for the picker to
    /// fold away. `configured` is expected to carry the pools too (`ProviderPools.asProviders`),
    /// since that is where a pool's models and runtime are resolved from; `pools` says which of its
    /// entries are pools.
    public static func choices(configured: [ConfiguredProvider],
                               catalog: RunnerModelCatalog? = nil,
                               engines: [RunnerEngineHealth]? = nil,
                               pools: [ProviderPool] = [],
                               now: Date = Date()) -> [ProviderChoice] {
        let health = { (engine: String) in engines?.first { $0.engine == engine } }
        let engineChoices = engineSlugs.map { slug in
            let blocker = engineBlocker(health(slug))
            return ProviderChoice(
                slug: slug,
                label: AgentDefaults.providerName(slug, configured: configured),
                kind: .engine,
                brandKey: enginePreset[slug],
                modelLabel: modelLabel(for: slug, configured: configured, catalog: catalog),
                unavailable: blocker,
                fixEngine: blocker == nil ? nil : slug)
        }
        // Like a configured provider, a pool needs the CLI it runs on and nothing signed in: each run
        // carries one of its accounts' keys. A missing CLI outranks the accounts, because it is the
        // one of the two a runner can fix.
        let claudeBlocker = byokBlocker(health("claude"))
        let poolChoices = pools.map { pool -> ProviderChoice in
            ProviderChoice(
                slug: pool.slug,
                label: pool.label,
                kind: .pool,
                brandKey: "anthropic",
                modelLabel: modelLabel(for: pool.slug, configured: configured, catalog: catalog),
                unavailable: claudeBlocker ?? ProviderPools.unavailableReason(pool),
                fixEngine: claudeBlocker == nil ? nil : "claude",
                poolSize: pool.members.count,
                note: ProviderPools.spentNote(pool, now: now))
        }
        let poolSlugs = Set(pools.map(\.slug))
        let pooled = Set(pools.flatMap { $0.members.map(\.slug) })
        // A configured row shadowing a built-in slug would give two entries that dispatch the same
        // identity; the engine entry above already covers it.
        let byok = configured
            .filter { !engineSlugs.contains($0.slug) && !poolSlugs.contains($0.slug) }
            .map { provider -> ProviderChoice in
                // Judged through the engine it borrows, since that CLI is what actually runs it.
                let runtime = executingRuntime(provider.slug, configured: configured)
                let blocker = byokBlocker(health(runtime))
                return ProviderChoice(
                    slug: provider.slug,
                    label: provider.label,
                    kind: .byok,
                    brandKey: provider.presetSlug,
                    modelLabel: modelLabel(for: provider.slug, configured: configured, catalog: catalog),
                    unavailable: blocker,
                    fixEngine: blocker == nil ? nil : runtime,
                    inPool: pooled.contains(provider.slug))
            }
        return engineChoices + poolChoices + byok
    }

    /// The providers a session that already exists may be moved to: the ones that borrow the same
    /// runtime CLI it was started on.
    ///
    /// That is the whole rule, and the session's own history imposes it — the transcript, the
    /// resume id and the wire protocol belong to the CLI that started the conversation, so
    /// claude→codex is a new session rather than a setting. Two Anthropic accounts, or an account
    /// and a compatible endpoint, are the same CLI with different credentials: the engine re-spawns
    /// and the conversation carries over. The backend enforces the same rule
    /// (SessionsService.resolveProviderSwitch); this keeps the picker from offering a rejected move.
    ///
    /// Order is `choices`' own — engines, then configured providers as the API returned them — and
    /// is deliberately NOT rotated to put the current one first. This menu is the same short list
    /// every time it opens, so its rows should sit where they sat last time; re-ordering per
    /// selection made two sessions on one runtime disagree about where "DeepSeek" lives, and made
    /// the new-session sheet disagree with both. The current row is marked by the tick, not by
    /// position. The one exception is a provider absent from `choices` — removed, disabled, or
    /// `opencode`, which is never offered — which has no natural position and so leads.
    ///
    /// Mirrors web's `sameRuntimeChoices`; keep the two in sync.
    public static func sameRuntime(_ provider: String,
                                   in choices: [ProviderChoice],
                                   configured: [ConfiguredProvider],
                                   catalog: RunnerModelCatalog? = nil) -> [ProviderChoice] {
        let runtime = executingRuntime(provider, configured: configured)
        let sameRuntime = choices.filter {
            executingRuntime($0.slug, configured: configured) == runtime
        }
        if sameRuntime.contains(where: { $0.slug == provider }) { return sameRuntime }
        return [current(provider, in: choices, configured: configured, catalog: catalog)] + sameRuntime
    }

    /// The built-in runtime that actually executes an identity, mirroring the server's
    /// `execRuntime`. Deliberately not `AgentDefaults.runtime(for:)`, which answers "claude" for
    /// the OpenCode slug — harmless where it is used for model defaults, but here it would offer
    /// an OpenCode session every Claude provider on the account.
    static func executingRuntime(_ provider: String, configured: [ConfiguredProvider]) -> String {
        if let custom = configured.first(where: { $0.slug == provider }) {
            let borrowed = custom.runtime ?? ""
            return borrowed == "codex" || borrowed == "kimi" ? borrowed : "claude"
        }
        return ["codex", "kimi", "opencode"].contains(provider) ? provider : "claude"
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
        return AgentDefaults.friendlyName(model, for: provider, catalog: catalog,
                                          configured: configured)
    }
}
