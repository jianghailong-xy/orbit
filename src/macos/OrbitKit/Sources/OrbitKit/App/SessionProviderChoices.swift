import Foundation

/// What the pickers offer, engine first: the new-session hero lists the engines — the CLIs a session
/// runs on, fixed for its life — and the composer's Provider menu lists the credentials the session's
/// engine can run on (docs/provider-engine-contract.md §2.1): its own sign-in on the runner with that
/// machine's accounts, the account pools on it, and every key it runs — the same DeepSeek key under
/// Claude Code, DeepSeek Harness and OpenCode alike.
///
/// Mirrors web's `lib/sessionProviderChoices.ts`; keep the two in sync.
public struct ProviderChoice: Equatable, Sendable, Identifiable {
    /// Where a credential comes from: the engine's own sign-in on the runner (`login`), OpenCode's own
    /// configuration there (`opencode`), an account pool, or one of the user's keys.
    public enum Kind: Equatable, Sendable { case login, opencode, pool, key }

    /// What a session on it stores as its provider: the engine's name for its own sign-in, `opencode`
    /// for OpenCode's own configuration, the pool's or the key's slug.
    public let slug: String
    public let label: String
    /// Which credential an engine's own sign-in is, in small type beside it: Antigravity's Google
    /// account or the machine's Gemini key, OpenCode's `opencode auth`.
    public let labelDetail: String?
    public let kind: Kind
    /// Which brand's mark/tint to draw. An engine's own sign-in borrows its vendor preset, a key uses
    /// the preset it was created from, and a self-maintained endpoint has none.
    public let brandKey: String?
    /// The model a session on this engine and credential runs with unless something overrides it,
    /// already resolved to a label — so "switching provider changes your model" is visible before the
    /// tap.
    public let modelLabel: String
    /// Why this choice can't run on the runner the session is on, or nil when it can. Set for a
    /// credential the engine can't run on that machine — its CLI missing there, or its sign-in signed
    /// out. The row stays listed and carries the reason rather than disappearing: hiding it turns "not
    /// signed in on this runner" into "Orbit lost my provider", which is the one question the picker
    /// exists to answer. Set too for an account pool the server says cannot run at all
    /// (`ProviderPool.unavailable`) — a reason no machine fixes, which is why `fixEngine` stays nil for
    /// it. Not for one whose accounts are only spent: that one waits for a reset (`note`).
    public let unavailable: String?
    /// Which engine row on Infrastructure fixes `unavailable` — the engine the menu is for. Set whenever
    /// a runner can fix `unavailable`; nil on a pool whose accounts are what is missing, whose row is
    /// greyed out rather than sent anywhere.
    public let fixEngine: String?
    /// An account pool: how many accounts it holds, counted on its mark. Nil for anything else.
    public let poolSize: Int?
    /// What `poolSize` counts when it is not accounts: a shared pool's keys (web's `poolUnit`), said
    /// on the mark's badge. Nil counts accounts.
    public let poolUnit: String?
    /// A key that is also an account in one of the user's pools. Still pickable on its own — pinning
    /// one account is a real need — but a session lands on the pool beside it first.
    public let inPool: Bool
    /// What the row says in place of its model while it still takes the pick: an account pool whose
    /// accounts that can run are all spent, and when the first frees up (`ProviderPools.spentNote`).
    /// Nil for anything else.
    public let note: String?
    /// The runner's own accounts of this engine, when it has signed in more than one: offered under its
    /// row, so a session can start on another account than its workspace's. Codex, Claude, Antigravity
    /// and Kimi — the engines whose CLI keeps a login per directory (`Session.codexAccount`,
    /// `.claudeAccount`, `.antigravityAccount`, `.kimiAccount`).
    public let accounts: [AccountChoice]?
    public var id: String { slug }

    public init(slug: String, label: String, kind: Kind, brandKey: String?, modelLabel: String,
                unavailable: String? = nil, fixEngine: String? = nil, poolSize: Int? = nil,
                poolUnit: String? = nil, inPool: Bool = false, note: String? = nil,
                accounts: [AccountChoice]? = nil, labelDetail: String? = nil) {
        self.slug = slug
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

    /// The engine's own credential on the runner — its sign-in, or OpenCode's own configuration —
    /// rather than a pool or a key.
    public var isOwn: Bool { kind == .login || kind == .opencode }
}

/// One of the runner's accounts of an engine, as a row under that engine in the picker (web
/// `AccountChoice`).
public struct AccountChoice: Equatable, Sendable, Identifiable {
    /// `default`, or the id of a slot the runner added — what the session is created with.
    public let id: String
    public let label: String
    /// Its own quota's tightest window — the one closest to its limit, which is the one that stops it —
    /// compactly: "5h 100%", "Weekly 0%"; an Antigravity bucket by what is left, "gemini-5h 4% left".
    /// "env key" for Antigravity's Default on a runner that runs it on its own Gemini key. Nil when
    /// none is reported.
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

/// An engine — the CLI a session runs on, fixed for its life — as the new-session hero lists it, with
/// the credentials it can run on here (web `EngineChoice`). Which of them a session spends is the
/// composer's Provider menu's question; a row here names the engine and the credential a pick of it
/// lands on.
public struct EngineChoice: Equatable, Sendable, Identifiable {
    public let slug: String
    /// The CLI's own product name (`ProviderEngines.cliName`).
    public let label: String
    /// The vendor preset whose mark the engine wears (`SessionProviderChoices.enginePreset`).
    public let brandKey: String?
    /// Every credential on this runner the engine can run on (`SessionProviderChoices.providers`).
    public let providers: [ProviderChoice]
    /// Where picking the engine lands (`SessionProviderChoices.engines`) — or nothing, for DeepSeek
    /// Harness before a DeepSeek key is connected.
    public let provider: ProviderChoice?
    /// Why the engine can't take a session here, and where that is fixed: the landing's own reason when
    /// none of its credentials can run, or the DeepSeek key there is none of.
    public let unavailable: String?
    public let fixEngine: String?
    public var id: String { slug }

    public init(slug: String, label: String, brandKey: String?, providers: [ProviderChoice],
                provider: ProviderChoice?, unavailable: String? = nil, fixEngine: String? = nil) {
        self.slug = slug
        self.label = label
        self.brandKey = brandKey
        self.providers = providers
        self.provider = provider
        self.unavailable = unavailable
        self.fixEngine = fixEngine
    }
}

/// What the pickers judge an engine and its credentials by: the account's keys and pools, and the
/// runner a session would run on (web `ChoiceSources`).
public struct ChoiceSources: Sendable {
    /// GET /providers, with the pools read as providers too (`ProviderPools.asProviders`) — where a
    /// pool's models are resolved from; `pools` says which of its entries are pools.
    public var configured: [ConfiguredProvider]
    public var catalog: RunnerModelCatalog?
    public var runtimeDefaults: [String: String]?
    /// The engines' health as the runner last reported it. A runner that has reported nothing claims
    /// nothing, so everything stays pickable — as does any engine missing from a partial report.
    public var engines: [RunnerEngineHealth]?
    public var pools: [ProviderPool]
    /// The runner's quota report, read for each of its accounts' own windows.
    public var planUsage: PlanUsage?
    public var now: Date
    public var antigravity: RunnerAntigravityState?
    /// Whether Antigravity's sign-in runs on the machine's Gemini key for this workspace.
    public var antigravityKeyAvailable: Bool?
    /// Whether the runner can start DeepSeek Harness; nil before any runner snapshot is read, which
    /// claims nothing (`DshRuntime.state`).
    public var dshState: DshRuntime.RunnerState?

    public init(configured: [ConfiguredProvider], catalog: RunnerModelCatalog? = nil,
                runtimeDefaults: [String: String]? = nil, engines: [RunnerEngineHealth]? = nil,
                pools: [ProviderPool] = [], planUsage: PlanUsage? = nil, now: Date = Date(),
                antigravity: RunnerAntigravityState? = nil, antigravityKeyAvailable: Bool? = nil,
                dshState: DshRuntime.RunnerState? = nil) {
        self.configured = configured
        self.catalog = catalog
        self.runtimeDefaults = runtimeDefaults
        self.engines = engines
        self.pools = pools
        self.planUsage = planUsage
        self.now = now
        self.antigravity = antigravity
        self.antigravityKeyAvailable = antigravityKeyAvailable
        self.dshState = dshState
    }
}

/// An engine and a provider of it — a draft's pick, or what a workspace last ran on (web `EnginePick`).
public struct EnginePick: Equatable, Sendable {
    public let engine: String
    public let provider: String

    public init(engine: String, provider: String) {
        self.engine = engine
        self.provider = provider
    }
}

public enum SessionProviderChoices {
    /// The runner's accounts of an engine (`health`) as picker rows, each with its own quota — nil
    /// unless it has signed in more than one (web `accountChoices`). `usage` is the engine's snapshot
    /// (`CodexAccounts.usage`).
    public static func accountChoices(_ health: RunnerEngineHealth?, usage: PlanUsageSnapshot?) -> [AccountChoice]? {
        guard let health, let accounts = health.accounts, accounts.count >= 2 else { return nil }
        return accounts.map { account in
            // Antigravity's Default on the runner's own Gemini key runs, on the key, with no quota of its
            // own to show (`RunnerPageFormat.runsOnEnvKey`): not an account that is signed out.
            if RunnerPageFormat.runsOnEnvKey(health, account: account.id, auth: account.auth) {
                return AccountChoice(id: account.id, label: CodexAccounts.label(account.id, accounts: accounts),
                                     quota: "env key")
            }
            let own = account.auth == "yes" ? CodexAccounts.snapshot(usage, account: account.id) : nil
            let rows = own?.rows ?? []
            // The window closest to its limit: a Claude login's 5-hour window can read 0% while its
            // weekly one is spent, and the first window alone would say it has room. An Antigravity
            // bucket's row counts what is left rather than what is used, so its tightest is the one
            // with least left: the binding row, judged by use.
            let row: PlanUsageRow?
            if rows.contains(where: \.remaining) {
                row = own?.bindingRow()
            } else {
                row = rows.reduce(nil as PlanUsageRow?) { tightest, next in
                    tightest.map { next.percent > $0.percent ? next : $0 } ?? next
                }
            }
            return AccountChoice(
                id: account.id,
                label: CodexAccounts.label(account.id, accounts: accounts),
                quota: row.map(quotaText),
                nearLimit: (row?.window.utilization ?? 0) >= 90,
                unavailable: account.auth == "no" ? "Not signed in" : nil)
        }
    }

    /// One account's tightest window, compactly: "5h 100%" — or, for one that counts what is left, its
    /// bucket and that: "gemini-5h 4% left".
    static func quotaText(_ row: PlanUsageRow) -> String {
        guard row.remaining else { return "\(compactWindowLabel(row.label)) \(row.percent)%" }
        return "\(row.groupLabel ?? row.label) \(row.percent)% left"
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

    /// The engines a runner signs into (`ProviderEngines.loginEngines`), in the order their sign-ins
    /// were first offered. Antigravity's sign-in is offered when the server confirms an environment key
    /// or a runner Google account. `opencode` has no sign-in to offer, only its own configuration; `dsh`
    /// runs on DeepSeek keys alone.
    public static let engineSlugs = ["claude", "codex", "antigravity", "kimi"]

    /// An engine's own sign-in has no configured row, so it has no preset to inherit a look from.
    /// Borrow the vendor preset carrying the same mark: the engine and the key are the same company,
    /// and a user who sees both should see one logo. Antigravity's vendor ships no preset carrying its
    /// mark — Google's (Gemini) runs on it, but is named for the models a Gemini key buys while the
    /// engine is the CLI that drives them — so it names its own mark (web's `ENGINE_BRAND`); DeepSeek
    /// Harness wears DeepSeek's whale, the keys it runs on.
    public static let enginePreset: [String: String] = [
        "claude": "anthropic", "codex": "openai", "kimi": "moonshot", "antigravity": "antigravity",
        "dsh": "deepseek",
    ]

    /// Missing outranks signed out. Only the CLI's own "no" counts for auth: `unknown` is an engine
    /// that wouldn't answer, which is not evidence enough to take the choice away.
    static func engineBlocker(_ health: RunnerEngineHealth?) -> String? {
        guard let health else { return nil }
        if health.installed == false { return "Not installed" }
        if health.auth == "no" { return "Not signed in" }
        return nil
    }

    /// Antigravity admission uses the runner capability the server reads when dispatching.
    static func antigravityBlocker(_ state: RunnerAntigravityState?, health: RunnerEngineHealth? = nil, login: Bool = false) -> String? {
        if state?.supported == false { return "Update runner" }
        if state?.installed == false { return "Not installed" }
        if login {
            if health?.auth == "no" || (state?.authSource == "google" && state?.envKeyAvailable == false) {
                return "Not signed in"
            }
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

    /// The same question for a credential that brings its own key — a key or a pool — which runs on the
    /// engine's CLI. The binary has to be there, so a missing one blocks it exactly as it blocks the
    /// engine. Sign-in doesn't apply: the key is the credential, and a signed-out CLI runs it fine.
    static func byokBlocker(_ health: RunnerEngineHealth?) -> String? {
        health?.installed == false ? "Not installed" : nil
    }

    /// OpenCode has no sign-in to judge, only whether it is there: Orbit installs it, so a machine
    /// without it lists it with the reason. A runner that has reported nothing claims nothing.
    static func openCodeMissing(_ engines: [RunnerEngineHealth]?) -> Bool {
        guard let engines else { return false }
        return engines.first { $0.engine == "opencode" }?.installed != true
    }

    /// The arrow that closes a picker row's reason: where tapping the row goes.
    ///
    /// A sign-in this client can drive is a promise the row can keep, so those engines get ", sign
    /// in →". What a runner is missing otherwise takes the bare arrow: an install (`opencode`
    /// included, now that Orbit installs it), a runner update, a DeepSeek key to connect,
    /// Antigravity's install-or-key row, and OpenCode's own `auth login` — which asks which underlying
    /// provider to use, so the relay's DTO can't express it (`EngineAuth.Remedy.runCommand`). Naming a
    /// sign-in on those points at a button that isn't there, and the row already lands on the one that
    /// is.
    public static func fixSuffix(_ fixEngine: String?) -> String {
        ["antigravity", "dsh", DshRuntime.connectFix, "opencode"].contains(fixEngine ?? "")
            ? " →" : ", sign in →"
    }

    /// Why a pool none of whose credentials can run is greyed out, in the pool's own words: what it holds
    /// is what its reader can run on — its ChatGPT accounts first and its keys when none can (2026-10-03),
    /// built for one of the people its owner added the same way it is for its owner (web's
    /// `engineProviders`, ProviderPool.unavailable).
    static func poolBlocker(_ pool: ProviderPool) -> String? {
        ProviderPools.unavailableReason(pool)
    }

    /// The engine an account pool runs on: Codex for a shared pool and for one of one's own ChatGPT
    /// accounts, Claude Code otherwise (web's `poolEngine`).
    public static func poolEngine(_ pool: ProviderPool) -> String {
        ProviderPools.runsCodex(pool) ? "codex" : "claude"
    }

    /// What an engine's sign-in is called in the menu: the one account the runner reports by its own
    /// name, else Default — the account dispatch resolves a session on the sign-in to.
    static func signInLabel(_ health: RunnerEngineHealth?) -> String {
        guard let accounts = health?.accounts, accounts.count == 1 else { return "Default" }
        return CodexAccounts.label(accounts[0].id, accounts: accounts)
    }

    /// The credentials `engine` can run on, in the Provider menu's order: the engine's own sign-in on the
    /// runner — or OpenCode's own configuration — then the account pools that run on it, then every key
    /// it runs (`ProviderEngines.engines(ofProvider:)`, read off GET /providers' `engines`) in the order
    /// the API returned them. DeepSeek Harness has no sign-in: its credentials are the user's DeepSeek
    /// keys, every one of them.
    ///
    /// Each carries the health the runner last reported, because a choice is a claim about someone
    /// else's machine. The engine's CLI not installed there, or its sign-in signed out → listed with the
    /// reason, pointing at Infrastructure, where that machine gets its install or its sign-in. A key or a
    /// pool brings its own credential, so only the CLI has to be there; a pool also needs one of its
    /// accounts able to run, which the server says (`ProviderPool.unavailable`). Mirrors web's
    /// `engineProviders`.
    public static func providers(for engine: String, sources: ChoiceSources) -> [ProviderChoice] {
        let health = sources.engines?.first { $0.engine == engine }
        let keyAvailable = sources.antigravityKeyAvailable ?? sources.antigravity?.envKeyAvailable ?? false
        let antigravity = sources.antigravity
        // What a credential that brings its own key needs from this runner: the engine's CLI, and for
        // Harness and agy what the server admits them on.
        let carried: String? = engine == "dsh" ? sources.dshState?.label
            : engine == "antigravity" ? antigravityBlocker(antigravity, health: health)
            : engine == "opencode" ? (openCodeMissing(sources.engines) ? "Not installed" : nil)
            : byokBlocker(health)

        var own: [ProviderChoice] = []
        if ProviderEngines.isLoginProvider(engine)
            && (engine != "antigravity" || keyAvailable || antigravity?.authSource == "google") {
            let googleAccount = antigravity?.authSource == "google"
                && !(keyAvailable && antigravity?.envKeyAvailable == false)
            let blocker = engine == "antigravity"
                ? antigravityBlocker(antigravity, health: health, login: !keyAvailable || googleAccount)
                : engineBlocker(health)
            own.append(ProviderChoice(
                slug: engine,
                label: signInLabel(health),
                kind: .login,
                brandKey: enginePreset[engine],
                modelLabel: modelLabel(engine: engine, provider: engine, sources: sources),
                unavailable: blocker,
                fixEngine: blocker == nil ? nil : engine,
                accounts: blocker == nil
                    ? accountChoices(health, usage: CodexAccounts.usage(engine, planUsage: sources.planUsage,
                                                                         engines: sources.engines))
                    : nil,
                labelDetail: engine == "antigravity" ? (googleAccount ? "Google account" : "env key") : nil))
        }
        if engine == "opencode" { own.append(openCodeOwnChoice(sources)) }

        // Somebody a pool's owner added runs on the pool's ChatGPT accounts first and on its keys when
        // none can (pool-credential-select.ts, 2026-10-03), so what the pool holds is what they can run
        // on, and the pool's own answer (`unavailable`) is the reason. A missing CLI outranks the
        // members, because it is the one of the two a runner can fix.
        let pools = sources.pools.filter { poolEngine($0) == engine }.map { pool -> ProviderChoice in
            ProviderChoice(
                slug: pool.slug,
                label: pool.label,
                kind: .pool,
                brandKey: enginePreset[engine],
                modelLabel: modelLabel(engine: engine, provider: pool.slug, sources: sources),
                unavailable: carried ?? poolBlocker(pool),
                fixEngine: carried == nil ? nil : engine,
                poolSize: pool.members.count,
                // 'N keys' only where the pool really is nothing but keys; a pool holding ChatGPT
                // accounts counts accounts (the reader's own words — ProviderPools.memberNoun).
                poolUnit: pool.shared != nil && !pool.members.contains { $0.login != nil } ? "key" : nil,
                note: ProviderPools.spentNote(pool, now: sources.now))
        }

        let poolSlugs = Set(sources.pools.map(\.slug))
        let pooled = Set(sources.pools.flatMap { $0.members.map(\.slug) })
        // A configured row that shadows a built-in slug would give the menu two rows that dispatch the
        // same identity; the engine's own sign-in above already covers it.
        let keys = sources.configured
            .filter {
                !poolSlugs.contains($0.slug) && !ProviderEngines.isLoginProvider($0.slug) && $0.slug != "opencode"
                    && ProviderEngines.engines(ofProvider: $0.slug, configured: sources.configured).contains(engine)
            }
            .map { key -> ProviderChoice in
                ProviderChoice(
                    slug: key.slug,
                    label: key.label,
                    kind: .key,
                    brandKey: key.presetSlug,
                    modelLabel: modelLabel(engine: engine, provider: key.slug, sources: sources),
                    unavailable: carried,
                    fixEngine: carried == nil ? nil : engine,
                    inPool: pooled.contains(key.slug))
            }

        return own + pools + keys
    }

    /// OpenCode's own configuration on the runner — whatever `opencode auth login` set up there.
    static func openCodeOwnChoice(_ sources: ChoiceSources) -> ProviderChoice {
        let missing = openCodeMissing(sources.engines)
        return ProviderChoice(
            slug: "opencode",
            label: "OpenCode's own sign-in",
            kind: .opencode,
            brandKey: nil,
            modelLabel: modelLabel(engine: "opencode", provider: "opencode", sources: sources),
            unavailable: missing ? "Not installed" : nil,
            fixEngine: missing ? "opencode" : nil,
            labelDetail: "opencode auth")
    }

    /// The protocol a key's endpoint speaks (its row's `runtime`), as a key's page names it: never an
    /// engine — a key runs on several (`engines`), and the protocol is what decides which (web's
    /// `runtimeSummary`).
    public static func runtimeSummary(_ runtime: String?) -> String {
        switch runtime {
        case "codex": return "OpenAI-compatible"
        case "kimi": return "Moonshot API"
        case "antigravity": return "Gemini API"
        default: return "Anthropic-compatible"
        }
    }

    /// A vendor's name, as its keys are called in a sentence (board 8): one key runs on several engines,
    /// so it is never named after one.
    private static let keyVendors: [String: String] = [
        "anthropic": "Anthropic", "openai": "OpenAI", "gemini": "Google Gemini", "deepseek": "DeepSeek",
        DshRuntime.presetSlug: "DeepSeek", "moonshot": "Moonshot", "glm": "Z.AI", "minimax": "MiniMax",
        "qwen": "Qwen",
    ]

    /// A key as a sentence names it, lowercase for the middle of one: `the DeepSeek key “DeepSeek 2”` —
    /// its vendor and the name its owner gave it, never its slug. A custom endpoint is DeepSeek's when
    /// DeepSeek Harness runs it (`engines`, which only the server can tell). Mirrors web's `keyName`.
    public static func keyName(_ key: ConfiguredProvider) -> String {
        let vendor: String?
        if let preset = key.presetSlug, !preset.isEmpty {
            vendor = keyVendors[preset]
        } else {
            vendor = key.engines?.contains("dsh") == true ? keyVendors["deepseek"] : nil
        }
        guard let vendor else { return "the key “\(key.label)”" }
        return "the \(vendor) key “\(key.label)”"
    }

    /// What a session runs on, engine and credential in one phrase, as a workspace's settings say it
    /// (board 7): `Claude Code` on the engine's own sign-in — or OpenCode's own configuration, the
    /// legacy built-in `dsh` — and `Claude Code via DeepSeek` on a key or a pool, by its own name.
    /// Mirrors web's `engineVia`.
    public static func engineVia(engine: String, provider: String, configured: [ConfiguredProvider]?) -> String {
        let name = ProviderEngines.cliName(engine)
        if provider == engine { return name }
        return "\(name) via \(configured?.first { $0.slug == provider }?.label ?? provider)"
    }

    /// What names a credential where its engine is not beside it: an engine's own sign-in by the
    /// engine's CLI, anything else by its own label (web's `providerNameOn`).
    public static func providerName(on engine: String, _ choice: ProviderChoice) -> String {
        choice.kind == .login ? ProviderEngines.cliName(engine) : choice.label
    }

    /// The choice to show as a session's (or a draft's) current provider when the menu does not list it:
    /// a key this account no longer has on offer — removed, turned off — or one that has not loaded yet,
    /// the legacy built-in `dsh` (DeepSeek Harness on a key in its workspace's environment), or
    /// Antigravity's sign-in on a runner that offers it neither a Google account nor a Gemini key. Each
    /// still renders something truthful rather than silently reading as another credential, and never
    /// changes the engine. Mirrors web's `currentProviderChoice`.
    public static func current(engine: String, provider: String, in providers: [ProviderChoice],
                               sources: ChoiceSources) -> ProviderChoice {
        if let found = providers.first(where: { $0.slug == provider }) { return found }
        let label = modelLabel(engine: engine, provider: provider, sources: sources)
        if provider == "opencode" { return openCodeOwnChoice(sources) }
        if ProviderEngines.isLoginProvider(provider) {
            let antigravity = sources.antigravity
            let blocker = provider == "antigravity"
                ? antigravityBlocker(antigravity, login: antigravity?.envKeyAvailable != true) : nil
            return ProviderChoice(
                slug: provider, label: "Default", kind: .login, brandKey: enginePreset[provider],
                modelLabel: label, unavailable: blocker, fixEngine: blocker == nil ? nil : provider,
                labelDetail: provider == "antigravity"
                    ? (antigravity?.authSource == "google" ? "Google account" : "env key") : nil)
        }
        if provider == "dsh", !sources.configured.contains(where: { $0.slug == provider }) {
            return ProviderChoice(slug: provider, label: "Workspace key", kind: .key,
                                  brandKey: enginePreset["dsh"], modelLabel: label,
                                  labelDetail: "ORBIT_DSH_API_KEY")
        }
        let row = sources.configured.first { $0.slug == provider }
        return ProviderChoice(slug: provider, label: row?.label ?? provider, kind: .key,
                              brandKey: row?.presetSlug, modelLabel: label)
    }

    /// `engine` landing on `provider`, carrying its reason when it cannot run.
    private static func landing(_ engine: String, providers: [ProviderChoice],
                                on provider: ProviderChoice) -> EngineChoice {
        EngineChoice(slug: engine, label: ProviderEngines.cliName(engine), brandKey: enginePreset[engine],
                     providers: providers, provider: provider,
                     unavailable: provider.unavailable, fixEngine: provider.fixEngine)
    }

    /// Where a pick of `engine` lands: the first of `preferred` it holds that can run (the draft's pick,
    /// then what the workspace last ran there), else its own sign-in (OpenCode's own configuration), else
    /// the first of its credentials that can run — one in a pool last, since the pool beside it is the
    /// usual answer. DeepSeek Harness, with no sign-in, lands on the first DeepSeek key. An engine none
    /// of whose credentials can run lands on its own sign-in (or its first) and carries that reason.
    private static func landingOf(_ engine: String, providers: [ProviderChoice],
                                  preferred: [EnginePick]) -> ProviderChoice {
        let ready = providers.filter { $0.unavailable == nil }
        return preferred.filter { $0.engine == engine }
            .lazy.compactMap { pick in ready.first { $0.slug == pick.provider } }.first
            ?? ready.first(where: \.isOwn)
            ?? ready.first { !$0.inPool }
            ?? ready.first
            ?? providers.first(where: \.isOwn)
            ?? providers[0]
    }

    /// The new-session hero's engines, in `ProviderEngines.all`'s order (Claude Code, Codex, Kimi Code,
    /// Antigravity CLI, OpenCode, DeepSeek Harness), each with its credentials and the one a pick of it
    /// lands on. An engine with nothing to run on here is left out — except DeepSeek Harness on a runner
    /// that could run it: with no DeepSeek key yet it offers the connection instead (a turned-off key
    /// does not count, since GET /providers lists none), so "where is DeepSeek Harness?" has an answer
    /// in the picker itself. Mirrors web's `engineChoices`.
    public static func engines(sources: ChoiceSources, preferred: [EnginePick] = []) -> [EngineChoice] {
        ProviderEngines.all.compactMap { engine -> EngineChoice? in
            let providers = providers(for: engine, sources: sources)
            if !providers.isEmpty {
                return landing(engine, providers: providers,
                               on: landingOf(engine, providers: providers, preferred: preferred))
            }
            if engine == "dsh", let state = sources.dshState, state != .updateRunner {
                return EngineChoice(slug: engine, label: ProviderEngines.cliName(engine),
                                    brandKey: enginePreset[engine], providers: [], provider: nil,
                                    unavailable: DshRuntime.connectKey, fixEngine: DshRuntime.connectFix)
            }
            return nil
        }
    }

    /// The hero's current engine: `engine` landing on `provider` — the draft's pick, or what the
    /// workspace last ran on — even where that provider is not one of the credentials listed for it (a
    /// key since removed), which is then drawn as it is rather than silently replaced. Mirrors web's
    /// `currentEngineChoice`.
    public static func currentEngine(engine: String, provider: String, engines: [EngineChoice],
                                     sources: ChoiceSources) -> EngineChoice {
        let providers = engines.first { $0.slug == engine }?.providers ?? []
        return landing(engine, providers: providers,
                       on: current(engine: engine, provider: provider, in: providers, sources: sources))
    }

    /// The engine a session runs on, as the composer's model menu titles itself: the CLI's own product
    /// name (`Claude Code`, not `Claude`, because a session on a DeepSeek key writes DeepSeek's models
    /// while Claude Code executes them). Read off the session's own engine, which no pick in the menu
    /// changes — a session's engine is fixed for its life (contract §3.5). Mirrors web's
    /// `engineTitleFor`.
    public static func engineTitle(_ engine: String) -> String {
        ProviderEngines.cliName(engine)
    }

    // MARK: - the composer's Provider menu (boards iOS 4 ④⑤ and iOS 5)

    /// What became of a session's own key when its engine's menu no longer lists it (board iOS 5 ④).
    /// The engine stays either way; a credential of the same engine in the menu fixes the session.
    public enum KeyGone: Equatable, Sendable {
        /// Turned off on the web: its page there — `providerID` — is where it is turned back on.
        case turnedOff(providerID: String?)
        /// Deleted: nothing here undoes it.
        case deleted

        /// The Provider row's value, in the warning colour (web's `shownKeyGone.status`).
        public var status: String {
            switch self {
            case .turnedOff: return "Turned off"
            case .deleted: return "Key deleted"
            }
        }

        /// What the key's own row says beside its name.
        public var rowStatus: String {
            switch self {
            case .turnedOff: return "Turned off"
            case .deleted: return "Deleted"
            }
        }
    }

    /// What became of `provider`, a session's own, when the menu of its engine does not list it: turned
    /// off — the account's own keys still hold it — or deleted. Nil while it is listed, for an engine's
    /// own sign-in or OpenCode's own configuration, for a key the catalogue still serves, before the
    /// account's own keys are read, and for the legacy built-in `dsh`, which is no key of the user's.
    /// Mirrors web's `shownKeyGone`.
    public static func keyGone(provider: String, listed: Bool, configured: [ConfiguredProvider],
                               ownKeys: [ConfiguredProvider]?) -> KeyGone? {
        guard !listed, !ProviderEngines.isLoginProvider(provider), provider != "opencode",
              !configured.contains(where: { $0.slug == provider }), let ownKeys else { return nil }
        if let row = ownKeys.first(where: { $0.slug == provider }) {
            return row.enabled == false ? .turnedOff(providerID: row.providerID) : nil
        }
        return provider == "dsh" ? nil : .deleted
    }

    /// One group of the Provider submenu, under its heading.
    public struct MenuGroup: Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let choices: [ProviderChoice]
    }

    /// The Provider submenu, grouped by where a credential comes from (board iOS 4 ④, web
    /// `providerMenuGroups`): the session's own provider first, under its own heading, when its engine no
    /// longer lists it; then the runner's own sign-in — or OpenCode's own configuration — on that
    /// machine, the account pools, and the keys. `choices` is the menu's rows, the session's own leading
    /// when it is not listed (`listed` false). Only what the session's engine runs, never another
    /// engine's.
    public static func menuGroups(_ choices: [ProviderChoice], listed: Bool, runnerName: String?) -> [MenuGroup] {
        let machine = runnerName.flatMap { $0.isEmpty ? nil : $0 } ?? "this runner"
        let rest = listed ? choices : Array(choices.dropFirst())
        let own = rest.filter(\.isOwn)
        let signedIn = own.contains { $0.kind == .login && $0.unavailable == nil }
        var groups: [MenuGroup] = []
        if !listed, let session = choices.first {
            groups.append(MenuGroup(id: "session", title: "This session's key", choices: [session]))
        }
        let rows: [(String, String, [ProviderChoice])] = [
            ("machine", signedIn ? "Signed in on \(machine)" : "On \(machine)", own),
            ("pools", "Account pools", rest.filter { $0.kind == .pool }),
            ("keys", "API keys", rest.filter { $0.kind == .key }),
        ]
        groups += rows.filter { !$0.2.isEmpty }.map { MenuGroup(id: $0.0, title: $0.1, choices: $0.2) }
        return groups
    }

    /// Under OpenCode's Provider menu, why the account's Claude subscription tokens are not in it (board
    /// iOS 4 ⑤): Anthropic serves one to Claude Code alone. Nil on any other engine, or with none.
    public static func subscriptionOnlyNote(engine: String, configured: [ConfiguredProvider]) -> String? {
        guard engine == "opencode" else { return nil }
        let tokens = configured.filter { $0.runtime == "claude" && $0.engines == ["claude"] }
        guard !tokens.isEmpty else { return nil }
        let names = tokens.map(\.label).joined(separator: ", ")
        return "\(names) \(tokens.count == 1 ? "isn’t" : "aren’t") here: a subscription token runs on Claude Code only."
    }

    /// What the Provider row says the session is on (web `shownProviderValue`): an engine's own sign-in
    /// by the account in use — Automatic while Orbit picks it — OpenCode's own configuration as its own
    /// sign-in, anything else by its own name.
    public static func providerValue(_ row: ProviderChoice?, provider: String, automatic: Bool,
                                     accountLabel: String?) -> String {
        guard let row else { return provider }
        switch row.kind {
        case .login: return automatic ? "Automatic" : accountLabel ?? row.label
        case .opencode: return "Own sign-in"
        case .pool, .key: return row.label
        }
    }

    /// The label for the model a session on `engine` with `provider` resolves to: the pair's own option
    /// list's name for it, else the catalogue's, else the raw id; an engine that picks for itself shows
    /// the option that says so — OpenCode's "Managed by OpenCode", agy's fallback named for Gemini's
    /// default. Mirrors web's `defaultModelLabel`.
    static func modelLabel(engine: String, provider: String, sources: ChoiceSources) -> String {
        let model = AgentDefaults.defaultModel(engine: engine, provider: provider, catalog: sources.catalog,
                                               configured: sources.configured,
                                               runtimeDefaults: sources.runtimeDefaults)
        if let named = AgentDefaults.models(engine: engine, provider: provider, catalog: sources.catalog,
                                            configured: sources.configured).first(where: { $0.id == model }) {
            return named.name
        }
        guard !model.isEmpty else { return "Managed by the provider" }
        return AgentDefaults.friendlyName(model, catalog: sources.catalog, configured: sources.configured)
    }
}
