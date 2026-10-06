import Foundation

/// What the new-session provider picker offers: the runner's own signed-in engines first, then
/// this account's account pools, then its configured (BYOK) providers. Grouped, because they differ
/// in the one way a user cares about — an engine spends the subscription signed into on that
/// machine, a configured provider spends the API key you pasted, and a pool spends whichever of
/// its accounts' quota resets soonest.
///
/// Mirrors web's `lib/sessionProviderChoices.ts`; keep the two in sync.
public struct ProviderChoice: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable { case engine, byok, pool }

    public let slug: String
    public let label: String
    public let labelDetail: String?
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
    /// What `poolSize` counts when it is not accounts: a shared pool's keys (web's `poolUnit`), said
    /// on the mark's badge. Nil counts accounts.
    public let poolUnit: String?
    /// A configured provider that is also an account in one of the user's pools. Still pickable on
    /// its own — pinning one account is a real need — but offered behind "Pin a specific account",
    /// since the pool beside it already runs on it.
    public let inPool: Bool
    /// What the row says in place of its model while it still takes the pick: an account pool whose
    /// accounts that can run are all spent, and when the first frees up (`ProviderPools.spentNote`).
    /// Nil for anything else.
    public let note: String?
    /// The runner's own accounts of this engine, when it has signed in more than one: offered under
    /// its row, so a session can start on another account than its workspace's. Codex and Claude —
    /// the engines whose CLI keeps a login per directory (`Session.codexAccount`, `.claudeAccount`).
    public let accounts: [AccountChoice]?
    /// Not a provider at all: the offer to connect one (DeepSeek Harness with no key yet). Always
    /// `unavailable`, never a session's provider, so no runtime's menu lists it.
    public let setup: Bool
    public var id: String { slug }

    public init(slug: String, label: String, kind: Kind, brandKey: String?, modelLabel: String,
                unavailable: String? = nil, fixEngine: String? = nil, poolSize: Int? = nil,
                poolUnit: String? = nil, inPool: Bool = false, note: String? = nil,
                accounts: [AccountChoice]? = nil, labelDetail: String? = nil, setup: Bool = false) {
        self.slug = slug
        self.setup = setup
        self.label = label
        self.labelDetail = labelDetail
        self.kind = kind
        self.brandKey = brandKey
        self.modelLabel = modelLabel
        self.unavailable = unavailable
        self.fixEngine = fixEngine
        self.poolSize = poolSize
        self.poolUnit = poolUnit
        self.inPool = inPool
        self.note = note
        self.accounts = accounts
    }
}

/// One of the runner's accounts of an engine, as a row under that engine in the picker (web
/// `AccountChoice`).
public struct AccountChoice: Equatable, Sendable, Identifiable {
    /// `default`, or the id of a slot the runner added — what the session is created with.
    public let id: String
    public let label: String
    /// Its own quota's tightest window — the one closest to its limit, which is the one that stops it —
    /// compactly: "5h 100%", "Weekly 0%". Nil when none is reported.
    public let quota: String?
    /// That window is at least 90% spent — where the composer's quota gauge turns amber too.
    public let nearLimit: Bool
    /// Why it can't take a session: the CLI says it is signed out.
    public let unavailable: String?

    public init(id: String, label: String, quota: String? = nil, nearLimit: Bool = false,
                unavailable: String? = nil) {
        self.id = id
        self.label = label
        self.quota = quota
        self.nearLimit = nearLimit
        self.unavailable = unavailable
    }
}

/// An engine — the CLI a session runs on — as the new-session hero lists it (web `EngineChoice`).
/// Which provider of that engine the session spends (its own sign-in, an account pool, a key that
/// borrows it) is the composer's Provider menu's question, so a row here names the engine and the
/// provider a pick of it lands on.
public struct EngineChoice: Equatable, Sendable, Identifiable {
    public let slug: String
    public let label: String
    /// The vendor preset whose mark the engine wears (`SessionProviderChoices.enginePreset`).
    public let brandKey: String?
    /// Where picking this engine lands (`SessionProviderChoices.engines`).
    public let provider: ProviderChoice
    public var id: String { slug }
    /// Why none of this engine's providers can run here — the landing provider's own reason, since
    /// there is no better one to pick — and where it is fixed.
    public var unavailable: String? { provider.unavailable }
    public var fixEngine: String? { provider.fixEngine }
}

public enum SessionProviderChoices {
    /// The runner's accounts of an engine as picker rows, each with its own quota — nil unless it has
    /// signed in more than one (web `providerChoices`).
    public static func accountChoices(_ accounts: [RunnerEngineAccount]?, usage: PlanUsageSnapshot?) -> [AccountChoice]? {
        guard let accounts, accounts.count >= 2 else { return nil }
        return accounts.map { account in
            // The window closest to its limit: a Claude login's 5-hour window can read 0% while its
            // weekly one is spent, and the first window alone would say it has room.
            let rows = account.auth == "yes" ? (CodexAccounts.snapshot(usage, account: account.id)?.rows ?? []) : []
            let row = rows.reduce(nil as PlanUsageRow?) { tightest, row in
                tightest.map { row.percent > $0.percent ? row : $0 } ?? row
            }
            return AccountChoice(
                id: account.id,
                label: CodexAccounts.label(account.id, accounts: accounts),
                quota: row.map { r in "\(compactWindowLabel(r.label)) \(r.percent)%" },
                nearLimit: (row?.window.utilization ?? 0) >= 90,
                unavailable: account.auth == "no" ? "Not signed in" : nil)
        }
    }

    /// A window's name short enough for a row beside an account's: "5h", "Weekly", "Weekly Opus" —
    /// Codex's "5h limit" and Claude's "5-hour limit" and "Weekly · all models" alike (web
    /// `compactWindowLabel`).
    static func compactWindowLabel(_ label: String) -> String {
        var short = label.hasSuffix(" limit") ? String(label.dropLast(" limit".count)) : label
        if short == "5-hour" { short = "5h" }
        if short.hasSuffix(" · all models") { short = String(short.dropLast(" · all models".count)) }
        return short.replacingOccurrences(of: " · ", with: " ")
    }

    /// Login engines, with Antigravity offered for Google sign-in or a workspace/runner key.
    public static let engineSlugs = ["claude", "codex", "antigravity", "kimi"]

    /// A built-in engine has no configured row, so it has no preset to inherit a look from. Borrow
    /// the vendor preset carrying the same mark: the engine and the BYOK provider are the same
    /// company, and a user who sees both should see one logo. Antigravity's vendor ships no preset
    /// carrying its mark — Google's (Gemini) runs on it, but is named for the models a Gemini key
    /// buys while the engine is the CLI that drives them — so its key names its own mark (web's
    /// `ENGINE_BRAND`).
    static let enginePreset: [String: String] = [
        "claude": "anthropic", "codex": "openai", "kimi": "moonshot", "antigravity": "antigravity",
    ]

    /// Missing outranks signed out. Antigravity readiness and credential availability are supplied by
    /// the server separately.
    static func engineBlocker(_ health: RunnerEngineHealth?) -> String? {
        guard let health else { return nil }
        if health.installed == false { return "Not installed" }
        if health.auth == "no" { return "Not signed in" }
        return nil
    }

    static func antigravityBlocker(_ state: RunnerAntigravityState?, health: RunnerEngineHealth? = nil, login: Bool = false) -> String? {
        if state?.supported == false { return "Update runner" }
        if state?.installed == false { return "Not installed" }
        if login {
            if state?.authSource == "google", state?.envKeyAvailable == false { return "Not signed in" }
            return engineBlocker(health)
        }
        return byokBlocker(health)
    }

    /// Read only the server's key-availability result for the machine this session will run on.
    public static func antigravityKeyAvailable(workspace: Agent?, runner: Runner?) -> Bool {
        guard let runner else { return false }
        if let workspace { return workspace.antigravityKeyAvailableByRunner?[runner.id] == true }
        return runner.antigravity?.envKeyAvailable == true
    }

    /// The same question for a configured provider, which runs by borrowing an engine's CLI (a
    /// Moonshot row spawns the Kimi CLI with its key in the environment). The binary has to be
    /// there, so a missing one blocks it exactly as it blocks the engine. Sign-in doesn't apply:
    /// the pasted key is the credential, and a signed-out CLI runs this provider fine.
    static func byokBlocker(_ health: RunnerEngineHealth?) -> String? {
        health?.installed == false ? "Not installed" : nil
    }

    /// Why a pool none of whose credentials can run is greyed out, in the pool's own words: what it holds
    /// is what its reader can run on — its ChatGPT accounts first and its keys when none can (2026-10-03),
    /// built for one of the people its owner added the same way it is for its owner (web's
    /// `providerChoices`, ProviderPool.unavailable). Mirrors web's `providerChoices`.
    static func poolBlocker(_ pool: ProviderPool) -> String? {
        ProviderPools.unavailableReason(pool)
    }

    /// The picker's contents. Antigravity is offered for a Google account or server-confirmed key;
    /// login engines stay listed when their CLI is missing or signed out.
    ///
    /// The user's pools come after the engines, each one choice that runs on its members' own
    /// credentials. The providers in a pool stay pickable, marked `inPool` for the picker to fold
    /// away. `configured` is expected to carry the pools too (`ProviderPools.asProviders`), since
    /// that is where a pool's models and runtime are resolved from; `pools` says which of its
    /// entries are pools — a shared pool of OpenAI keys (its `shared` set) runs Codex rather than
    /// Claude, on a key the server picks for the session.
    public static func choices(configured: [ConfiguredProvider],
                               catalog: RunnerModelCatalog? = nil,
                               engines: [RunnerEngineHealth]? = nil,
                               pools: [ProviderPool] = [],
                               planUsage: PlanUsage? = nil,
                               now: Date = Date(),
                               antigravity: RunnerAntigravityState? = nil,
                               antigravityKeyAvailable: Bool? = nil,
                               dshState: DshRuntime.RunnerState? = nil) -> [ProviderChoice] {
        let health = { (engine: String) in engines?.first { $0.engine == engine } }
        let keyAvailable = antigravityKeyAvailable ?? antigravity?.envKeyAvailable ?? false
        let googleAccount = antigravity?.authSource == "google"
            && !(keyAvailable && antigravity?.envKeyAvailable == false)
        let engineChoices = engineSlugs.filter { $0 != "antigravity" || keyAvailable || antigravity?.authSource == "google" }.map { slug in
            let blocker = slug == "antigravity" ? antigravityBlocker(antigravity, health: health(slug), login: !keyAvailable || googleAccount) : engineBlocker(health(slug))
            return ProviderChoice(
                slug: slug,
                label: AgentDefaults.providerName(slug, configured: configured),
                kind: .engine,
                brandKey: enginePreset[slug],
                modelLabel: modelLabel(for: slug, configured: configured, catalog: catalog),
                unavailable: blocker,
                fixEngine: blocker == nil ? nil : slug,
                accounts: (slug == "codex" || slug == "claude") && blocker == nil
                    ? accountChoices(health(slug)?.accounts, usage: planUsage?.snapshot(for: slug))
                    : nil,
                labelDetail: slug == "antigravity" ? (googleAccount ? "Google account" : "env key") : nil)
        }
        // Like a configured provider, a pool needs the CLI it runs on and nothing signed in: each run
        // carries one of its members' credentials. A missing CLI outranks the members, because it is
        // the one of the two a runner can fix. A shared pool's CLI is Codex, whose runs carry a
        // session token for the pool's gateway — and so is a pool of one's own ChatGPT accounts', whose
        // accounts the server holds: which engine a pool runs is its own, not whether it is shared.
        let poolChoices = pools.map { pool -> ProviderChoice in
            let runtime = ProviderPools.runsCodex(pool) ? "codex" : "claude"
            let blocker = byokBlocker(health(runtime))
            return ProviderChoice(
                slug: pool.slug,
                label: pool.label,
                kind: .pool,
                brandKey: enginePreset[runtime],
                modelLabel: modelLabel(for: pool.slug, configured: configured, catalog: catalog),
                unavailable: blocker ?? poolBlocker(pool),
                fixEngine: blocker == nil ? nil : runtime,
                poolSize: pool.members.count,
                // 'N keys' only where the pool really is nothing but keys; a pool holding ChatGPT accounts
                // counts accounts (the reader's own words — ProviderPools.memberNoun).
                poolUnit: pool.shared != nil && !pool.members.contains { $0.login != nil } ? "key" : nil,
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
                let blocker = runtime == "antigravity" ? antigravityBlocker(antigravity, health: health(runtime))
                    : runtime == "dsh" ? dshState?.label
                    : byokBlocker(health(runtime))
                return ProviderChoice(
                    slug: provider.slug,
                    label: provider.label,
                    kind: .byok,
                    brandKey: provider.presetSlug,
                    modelLabel: modelLabel(for: provider.slug, configured: configured, catalog: catalog),
                    unavailable: blocker,
                    fixEngine: blocker == nil ? nil : runtime,
                    inPool: pooled.contains(provider.slug),
                    // DeepSeek's key runs on either agent; say which one this row is.
                    labelDetail: runtime == "antigravity" ? "Antigravity CLI"
                        : runtime == "dsh" ? "Harness"
                        : provider.presetSlug == "deepseek" ? "Claude Code" : nil)
            }
        // No Harness key yet, on a runner that could run one: offer the connection rather than
        // nothing, so "where is DeepSeek Harness?" has an answer in the picker itself.
        let dshSetup: [ProviderChoice] =
            dshState != nil && dshState != .updateRunner
                && !configured.contains(where: { $0.runtime == "dsh" })
            ? [ProviderChoice(slug: "\(DshRuntime.presetSlug):connect", label: "DeepSeek Harness", kind: .byok,
                              brandKey: DshRuntime.presetSlug, modelLabel: "", unavailable: "Add API key",
                              fixEngine: DshRuntime.connectFix, setup: true)]
            : []
        // OpenCode, once the runner reports it installed — it has no sign-in to offer, so a machine
        // without it has nothing to fix here either. Its own config first, then every key it may spend
        // (`OpenCodeKeys`): it speaks each dialect a configured key does, so the same key is listed
        // under its own engine above and here, as `opencode/<slug>` (web parity).
        let openCode: [ProviderChoice] = health("opencode")?.installed == true
            ? [ProviderChoice(slug: "opencode", label: AgentDefaults.providerName("opencode", configured: nil),
                              kind: .engine, brandKey: nil,
                              modelLabel: modelLabel(for: "opencode", configured: configured, catalog: catalog))]
                + configured
                    .filter { $0.runsOnOpenCode == true && !poolSlugs.contains($0.slug) }
                    .map { provider in
                        let choice = OpenCodeKeys.choice(provider.slug)
                        return ProviderChoice(slug: choice, label: provider.label, kind: .byok,
                                              brandKey: provider.presetSlug,
                                              modelLabel: modelLabel(for: choice, configured: configured, catalog: catalog))
                    }
            : []
        return engineChoices + poolChoices + byok + dshSetup + openCode
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
                                   catalog: RunnerModelCatalog? = nil,
                                   antigravity: RunnerAntigravityState? = nil) -> [ProviderChoice] {
        let runtime = executingRuntime(provider, configured: configured)
        let sameRuntime = choices.filter {
            !$0.setup && executingRuntime($0.slug, configured: configured) == runtime
        }
        if sameRuntime.contains(where: { $0.slug == provider }) { return sameRuntime }
        return [current(provider, in: choices, configured: configured, catalog: catalog,
                        antigravity: antigravity)] + sameRuntime
    }

    /// The built-in runtime that actually executes an identity, mirroring the server's
    /// `execRuntime`. Deliberately not `AgentDefaults.runtime(for:)`, which answers "claude" for
    /// the OpenCode slug — harmless where it is used for model defaults, but here it would offer
    /// an OpenCode session every Claude provider on the account. A Gemini key borrows Antigravity,
    /// so it executes on the same CLI as the engine's own slug.
    public static func executingRuntime(_ provider: String, configured: [ConfiguredProvider]) -> String {
        // A key run on OpenCode is run by OpenCode, whichever CLI the key itself borrows.
        if OpenCodeKeys.choiceKey(provider) != nil { return "opencode" }
        if let custom = configured.first(where: { $0.slug == provider }) {
            let borrowed = custom.runtime ?? ""
            return ["codex", "kimi", "antigravity", "dsh"].contains(borrowed) ? borrowed : "claude"
        }
        return ["codex", "kimi", "opencode", "antigravity", "dsh"].contains(provider) ? provider : "claude"
    }

    /// The entry to show as current. An agent set to `opencode`, or pointing at a provider that has
    /// since been removed or disabled, resolves to nothing above — both still have to render
    /// truthfully rather than silently reading as Claude, so they get a synthesized entry.
    public static func current(_ provider: String,
                               in choices: [ProviderChoice],
                               configured: [ConfiguredProvider],
                               catalog: RunnerModelCatalog? = nil,
                               antigravity: RunnerAntigravityState? = nil) -> ProviderChoice {
        if let found = choices.first(where: { $0.slug == provider }) { return found }
        let runtime = executingRuntime(provider, configured: configured)
        let blocker = runtime == "antigravity" ? antigravityBlocker(antigravity, login: provider == "antigravity" && antigravity?.envKeyAvailable != true) : nil
        return ProviderChoice(
            slug: provider,
            label: AgentDefaults.providerName(provider, configured: configured),
            kind: AgentDefaults.isBuiltInProvider(provider) ? .engine : .byok,
            brandKey: enginePreset[provider] ?? configured.first { $0.slug == provider }?.presetSlug,
            modelLabel: modelLabel(for: provider, configured: configured, catalog: catalog),
            unavailable: blocker, fixEngine: blocker == nil ? nil : "antigravity",
            labelDetail: provider == "antigravity" ? (antigravity?.authSource == "google" ? "Google account" : "env key") : runtime == "antigravity" ? "Antigravity CLI" : nil)
    }

    /// The engine row for `provider`, landing on it. Also how the hero names a pick that is in no
    /// group (`opencode`, a removed provider): its runtime, on the synthesized current choice.
    public static func engine(for provider: ProviderChoice, configured: [ConfiguredProvider]) -> EngineChoice {
        let slug = provider.setup ? "dsh" : executingRuntime(provider.slug, configured: configured)
        // Harness is not a built-in provider option (its key is a configured row), so name it here.
        return EngineChoice(slug: slug,
                            label: slug == "dsh" ? "DeepSeek Harness" : AgentDefaults.providerName(slug, configured: nil),
                            brandKey: slug == "dsh" ? DshRuntime.presetSlug : enginePreset[slug], provider: provider)
    }

    /// `choices` grouped by the engine that runs them, in the order the engines first appear there
    /// (web `engineChoices`). Each engine lands on the first of `preferred` it holds that can run (the
    /// draft's pick, then what the workspace last ran on), else its own sign-in, else the first of its
    /// providers that can run — one in a pool last, since the pool beside it is the usual answer. An
    /// engine none of whose providers can run lands on its own row (or its first) and carries its reason.
    public static func engines(_ choices: [ProviderChoice], configured: [ConfiguredProvider],
                               preferred: [String?] = []) -> [EngineChoice] {
        var order: [String] = []
        var groups: [String: [ProviderChoice]] = [:]
        for choice in choices {
            let runtime = choice.setup ? "dsh" : executingRuntime(choice.slug, configured: configured)
            if groups[runtime] == nil { order.append(runtime) }
            groups[runtime, default: []].append(choice)
        }
        return order.map { engine in
            let group = groups[engine]!
            let ready = group.filter { $0.unavailable == nil }
            let landing = preferred.lazy.compactMap { slug in ready.first { $0.slug == slug } }.first
                ?? ready.first { $0.slug == engine }
                ?? ready.first { !$0.inPool }
                ?? ready.first
                ?? group.first { $0.slug == engine }
                ?? group[0]
            return self.engine(for: landing, configured: configured)
        }
    }

    /// The label for a provider's resolved default model, or a plain hint when the provider picks
    /// for itself (OpenCode sends no model and resolves its own).
    static func modelLabel(for provider: String,
                           configured: [ConfiguredProvider],
                           catalog: RunnerModelCatalog?) -> String {
        let model = AgentDefaults.defaultModel(for: provider, catalog: catalog, configured: configured)
        guard !model.isEmpty else {
            return executingRuntime(provider, configured: configured) == "antigravity"
                ? "Gemini 3.8 Flash" : "Managed by the provider"
        }
        return AgentDefaults.friendlyName(model, for: provider, catalog: catalog,
                                          configured: configured)
    }
}
