import Foundation

/// The composer's model / permission-mode / effort pickers, and the *floor* for their contents:
/// a static, Opus-first list (like the web's lib/agentDefaults) that an async runner probe or a
/// configured provider's catalogue may replace once it lands — see ModelSelectionRevision below,
/// which is what keeps such a refresh from overwriting a choice the user already made.
/// Keep in sync with src/web/src/lib/agentDefaults.
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

/// The same explicit edit marker for an effort seed. A value comparison is not enough: the user
/// may intentionally re-select the legacy value while the account preference is still loading,
/// and that action must still prevent the late seed from overwriting their choice.
public struct EffortSelectionRevision: Equatable, Sendable {
    public private(set) var value: UInt = 0
    public init() {}
    public var isPristine: Bool { value == 0 }
    public mutating func markUserEdit() { value &+= 1 }
}

/// Reasoning-effort / OpenCode-variant value offered in the composer. OpenCode variants are
/// model-defined and can add values without an Orbit release, so this is string-backed rather
/// than a closed enum. `allCases` remains the common built-in superset used by static pickers.
public struct Effort: RawRepresentable, CaseIterable, Hashable, Sendable, Identifiable {
    public let rawValue: String

    public init?(rawValue: String) { self.rawValue = rawValue }

    public static let `default` = Effort(rawValue: "")!
    public static let minimal = Effort(rawValue: "minimal")!
    public static let low = Effort(rawValue: "low")!
    public static let medium = Effort(rawValue: "medium")!
    public static let high = Effort(rawValue: "high")!
    public static let xhigh = Effort(rawValue: "xhigh")!
    public static let max = Effort(rawValue: "max")!
    public static let ultra = Effort(rawValue: "ultra")!
    public static let allCases: [Effort] = [
        .default, .minimal, .low, .medium, .high, .xhigh, .max, .ultra,
    ]

    public var id: String { rawValue }
    public var label: String {
        if self == .default { return "Default" }
        if self == .xhigh { return "xHigh" }
        return rawValue.prefix(1).uppercased() + String(rawValue.dropFirst())
    }
}

public enum AgentDefaults {
    /// The engines whose own sign-in, or own configuration, is a provider slug: the slug is the engine's
    /// name. Not an agent-level choice — an agent holds no provider. `name` is how the slug reads where a
    /// provider is named on its own; an engine is named by its CLI (`ProviderEngines.cliName`).
    public static let providers: [ProviderOption] = [
        ProviderOption(id: "claude", name: "Claude"),
        ProviderOption(id: "codex", name: "Codex"),
        ProviderOption(id: "kimi", name: "Kimi"),
        ProviderOption(id: "opencode", name: "OpenCode"),
        ProviderOption(id: "antigravity", name: "Antigravity"),
    ]

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

    /// The engine whose own protocol a row's endpoint speaks — its model table's home. A row still on
    /// the retired `dsh` runtime holds DeepSeek's Anthropic-compatible endpoint; an unreadable runtime
    /// keeps the backend's Claude fallback. Mirrors web's `nativeEngine`.
    private static func nativeEngine(_ runtime: String?) -> String {
        ["codex", "kimi", "antigravity"].contains(runtime ?? "") ? runtime ?? "claude" : "claude"
    }

    /// Kimi's list comes from the runner too (`kimi provider list --json`, which also carries each
    /// model's context window and thinking levels). Its managed default is the one static fallback,
    /// for a runner whose CLI predates that probe.
    public static let kimiModels: [ModelOption] = [
        ModelOption(id: "kimi-code/kimi-for-coding", name: "Kimi for Coding"),
    ]

    /// OpenCode chooses its own model when no `--model` value is supplied: a new session resolves
    /// its configured/default model and a resumed session keeps its current OpenCode model.
    /// Concrete ids are runner-discovered because they include the provider (`provider/model`).
    public static let opencodeModels: [ModelOption] = [
        ModelOption(id: "", name: "Managed by OpenCode"),
    ]

    /// Antigravity's models ship inside the agy binary and come from the runner (`agy models`, one
    /// row per model with its thinking levels folded out of the slug). Until a runner reports them,
    /// the one choice that is true on every agy is passing no `--model` and letting agy pick its
    /// own. Unlike OpenCode's sentinel this row is only the fallback, like Kimi's managed default:
    /// once there is a catalogue, dispatch runs a model-less session on the reported default (the
    /// Runtime's own, else the catalogue's first row), so the row would offer a choice dispatch no
    /// longer makes. The fallback names Gemini's preset default without changing the empty
    /// dispatch value. Mirrors web's ANTIGRAVITY_MODEL_OPTIONS.
    public static let antigravityModels: [ModelOption] = [
        ModelOption(id: "", name: "Gemini 3.8 Flash"),
    ]

    public static let defaultModelID = "claude-opus-5"

    /// The models an engine's own sign-in offers before its runner reports a catalogue. Claude and
    /// Codex lists come exclusively from the runner catalog (Codex via `codex debug models`; Claude via
    /// `claude -p "/model <alias>"`). There is no static fallback for them — when the catalog is
    /// unavailable the picker is empty. An unknown engine string returns an empty array too, matching
    /// apiserver's `agentProvider()`, so a stale value can't leak Claude-only options. OpenCode
    /// contributes only its empty "managed by the runtime" sentinel ahead of the runner catalog;
    /// Antigravity's look-alike row is replaced by the catalog instead (see `antigravityModels`).
    public static func models(for engine: String) -> [ModelOption] {
        switch engine {
        case "kimi":     return kimiModels
        case "opencode": return opencodeModels
        case "antigravity": return antigravityModels
        default:         return []
        }
    }

    /// An engine's own sign-in's models: the runner's catalogue of that CLI, else the static floor.
    public static func models(for engine: String, catalog: RunnerModelCatalog?) -> [ModelOption] {
        if engine == "opencode" {
            return opencodeModels + (catalog?.models(for: engine) ?? [])
        }
        return catalog?.models(for: engine) ?? models(for: engine)
    }

    /// A key's (or pool's) own model table, the same on every engine that runs it: what the runner's
    /// CLI reports for a vendor whose endpoint is that CLI's own (`modelsFromRuntime` — read under the
    /// CLI's engine, never the slug, so an OpenAI key reads Codex's models and a Gemini key agy's), else
    /// the row's own list. An empty list stays empty rather than borrowing Claude's: the composer then
    /// shows the effective fallback as its sole row. A row on the retired `dsh` runtime has no table
    /// outside DeepSeek Harness. Mirrors web's `rowModelOptions`.
    private static func rowModels(_ row: ConfiguredProvider, catalog: RunnerModelCatalog?) -> [ModelOption] {
        if row.modelsFromRuntime == true, row.runtime != "dsh",
           let live = catalog?.models(for: nativeEngine(row.runtime)) {
            return live
        }
        return row.models
            .filter { !$0.value.isEmpty && !$0.label.isEmpty }
            .map { ModelOption(id: $0.value, name: $0.label) }
    }

    /// The models a session on `engine` with `provider` can pick: the model space is the pair's
    /// (docs/provider-engine-contract.md §2.2). DeepSeek Harness takes the runner's ACP catalogue
    /// whichever DeepSeek key it spends; a key brings its own table to every engine that runs it,
    /// OpenCode included (stored bare — dispatch names the key for OpenCode); an engine's own sign-in,
    /// and OpenCode's own config, the runner's catalogue of that CLI. Mirrors web's `modelOptionsFor`.
    public static func models(engine: String, provider: String?, catalog: RunnerModelCatalog?,
                              configured: [ConfiguredProvider]?) -> [ModelOption] {
        if engine == "dsh" { return catalog?.models(for: "dsh") ?? [] }
        if let row = ProviderEngines.configuredRow(provider, configured) { return rowModels(row, catalog: catalog) }
        // The engine's own sign-in — and a provider since removed, whose own table went with it.
        return models(for: engine, catalog: catalog)
    }

    /// Static fallback when neither Runtime default nor catalog is available. Mirrors web's
    /// DEFAULT_MODEL_BY_PROVIDER. Antigravity's is no `--model` at all: agy's models come and go
    /// with its releases, so any id named here could only go stale — and falling through to the
    /// Claude default would hand agy a model it refuses to start on.
    public static func defaultModel(for engine: String) -> String {
        switch engine {
        case "codex": return "gpt-5.6-sol"
        case "kimi":     return "kimi-code/kimi-for-coding"
        case "opencode": return ""
        case "antigravity": return ""
        // Harness's model values are opaque ACP tokens from the runner's catalogue; none is shipped,
        // and until one is reported the runtime picks.
        case "dsh":      return ""
        default:         return defaultModelID
        }
    }

    public static func defaultModel(for engine: String, catalog: RunnerModelCatalog?) -> String {
        models(for: engine, catalog: catalog).first?.id ?? defaultModel(for: engine)
    }

    /// A key's (or pool's) default on any engine that runs it: what the CLI of its own endpoint reports
    /// for a vendor it speaks to natively — its Runtime default, then its catalogue's first row — beating
    /// the id shipped in the preset, else the row's own. Never the Claude default for a key on Codex's
    /// protocol: a key owns its model space. Mirrors web's `rowDefaultModel`.
    private static func rowDefaultModel(_ row: ConfiguredProvider, catalog: RunnerModelCatalog?,
                                        runtimeDefaults: [String: String]?) -> String {
        // A row on the retired `dsh` runtime names no model outside DeepSeek Harness; the runtime picks.
        if row.runtime == "dsh" { return "" }
        let native = nativeEngine(row.runtime)
        if row.modelsFromRuntime == true {
            if let saved = runtimeDefaults?[native], !saved.isEmpty { return saved }
            if let live = catalog?.models(for: native)?.first?.id, !live.isEmpty { return live }
        }
        if let declared = row.defaultModel, !declared.isEmpty { return declared }
        if let first = row.models.first(where: { !$0.value.isEmpty && !$0.label.isEmpty }) { return first.value }
        let fallback = defaultModel(for: native)
        return fallback.isEmpty ? defaultModelID : fallback
    }

    /// The model a session on `engine` with `provider` runs when nothing names one — the same pair-wise
    /// model space as `models(engine:provider:…)`: the Runtime default the heartbeat reports, then the
    /// runner catalogue's first model, then the static fallback, for an engine's own sign-in; a key's own
    /// default for a key. Mirrors web's `defaultModelFor`.
    public static func defaultModel(engine: String, provider: String?, catalog: RunnerModelCatalog?,
                                    configured: [ConfiguredProvider]?,
                                    runtimeDefaults: [String: String]? = nil) -> String {
        // Harness has no static model space: until a runner reports its catalogue the runtime picks.
        if engine == "dsh" {
            if let saved = runtimeDefaults?["dsh"], !saved.isEmpty { return saved }
            return catalog?.models(for: "dsh")?.first?.id ?? ""
        }
        if let row = ProviderEngines.configuredRow(provider, configured) {
            return rowDefaultModel(row, catalog: catalog, runtimeDefaults: runtimeDefaults)
        }
        // OpenCode picks the model itself when none is passed; "" is the choice, not a missing value.
        if engine == "opencode" { return runtimeDefaults?["opencode"] ?? "" }
        // Antigravity resolves like the other engines — the runner's reported default, then its
        // catalogue's first row — except that with neither the answer is agy's own pick (""), which is
        // what dispatch sends too. The generic chain below would read "" as missing and land on Claude.
        if engine == "antigravity" {
            if let saved = runtimeDefaults?["antigravity"], !saved.isEmpty { return saved }
            return catalog?.models(for: "antigravity")?.first?.id ?? ""
        }
        if let saved = runtimeDefaults?[engine], !saved.isEmpty { return saved }
        if let first = models(for: engine, catalog: catalog).first?.id, !first.isEmpty { return first }
        let fallback = defaultModel(for: engine)
        return fallback.isEmpty ? defaultModelID : fallback
    }

    /// A stored model the pair still offers, or nil once the Runtime has retired it — the caller then
    /// re-resolves the current default instead of showing a dead id nobody can select back. Mirrors web's
    /// `livePinnedModel` and the server's `retiredPin`, including which pins are deliberately left alone:
    /// OpenCode owns its own selection, a third-party key's list is a document rather than a live probe,
    /// an unreported catalog can retire nothing, and an id the Runtime itself names (`opus`, `opusplan`, a
    /// gateway id) is current by definition. Judged against the catalogue of the engine that runs it —
    /// DeepSeek Harness's own, whichever key it spends.
    public static func livePin(_ model: String?, engine: String, provider: String?,
                               catalog: RunnerModelCatalog?, configured: [ConfiguredProvider]?,
                               runtimeDefaults: [String: String]?) -> String? {
        guard let model else { return nil }
        if engine == "opencode" { return model }
        let row = ProviderEngines.configuredRow(provider, configured)
        // Antigravity's "" is not a pick that outlives anything: it stood in for a catalogue not reported
        // yet, and dispatch runs a model-less session on the reported default — so the caller falls
        // through to that default, which is what the pill must say.
        if model.isEmpty { return row == nil && engine == "antigravity" ? nil : model }
        if engine != "dsh", let row, row.modelsFromRuntime != true { return model }
        let judge = engine == "dsh" ? engine : row.map { nativeEngine($0.runtime) } ?? engine
        guard let offered = catalog?.models(for: judge), !offered.isEmpty else { return model }
        if let reported = runtimeDefaults?[judge], reported == model { return model }
        return offered.contains { $0.id == model } ? model : nil
    }

    /// The key a model picked for `engine` on `provider` is remembered under in
    /// `User.preferences.defaultModels` (docs/provider-engine-contract.md §6.5): one key's model on
    /// Claude Code is not its model on DeepSeek Harness.
    public static func defaultModelKey(engine: String, provider: String) -> String { "\(engine):\(provider)" }

    /// The model last picked for `engine` on `provider`, read in §6.5's order: the pair's own key, then
    /// what an older client remembered under the old keys — `opencode/<slug>` (whose value names the
    /// key, `orbit-<slug>/<model>`) and `opencode` for OpenCode, the bare slug for the engine a provider
    /// runs on by default. Nil when nothing was picked for it. Mirrors web's `rememberedModel`.
    public static func rememberedModel(engine: String, provider: String, accountModels: [String: String]?,
                                       configured: [ConfiguredProvider]?) -> String? {
        guard let accountModels else { return nil }
        if let own = accountModels[defaultModelKey(engine: engine, provider: provider)] { return own }
        if engine == "opencode" {
            if provider == "opencode" {
                guard let old = accountModels["opencode"], OpenCodeKeys.key(of: old) == nil else { return nil }
                return old
            }
            guard let named = OpenCodeKeys.key(of: accountModels["opencode/\(provider)"]), named.slug == provider
            else { return nil }
            return named.model
        }
        return ProviderEngines.defaultEngine(ofProvider: provider, configured: configured) == engine
            ? accountModels[provider] : nil
    }

    /// An interactive draft remembers the last explicit model pick for its engine and provider. A retired
    /// model falls back to the caller's current default for the pair; an empty OpenCode pick is kept.
    public static func newSessionModel(engine: String, provider: String, accountModels: [String: String]?,
                                       fallback: String, catalog: RunnerModelCatalog?,
                                       configured: [ConfiguredProvider]?,
                                       runtimeDefaults: [String: String]? = nil) -> String {
        livePin(rememberedModel(engine: engine, provider: provider, accountModels: accountModels,
                                configured: configured),
                engine: engine, provider: provider, catalog: catalog,
                configured: configured, runtimeDefaults: runtimeDefaults) ?? fallback
    }

    /// The engine a persisted provider identity runs on when nothing else says — what a session that
    /// recorded no engine ran on (`ProviderEngines.sessionEngine`): an engine's own sign-in its engine,
    /// OpenCode's own config OpenCode, a key its protocol's own engine (DeepSeek Harness for a row still
    /// on the retired `dsh` runtime), and Claude Code for a provider since removed, as dispatch used to
    /// read it. A session's own engine, where it has one, outranks this.
    public static func runtime(for provider: String,
                               configured: [ConfiguredProvider]? = nil) -> String {
        ProviderEngines.sessionEngine(nil, provider: provider, configured: configured)
    }

    public static func isBuiltInProvider(_ provider: String) -> Bool {
        providers.contains { $0.id == provider }
    }

    /// The quota to show for a session on `engine` spending `provider` (mirrors web's
    /// `sessionPlanUsage`).
    ///
    /// Quota belongs to the credential the session actually spends, so the lookup follows the same
    /// order dispatch does: an engine's own sign-in runs on the runner's login and reports through the
    /// heartbeat, while a key (or pool) bills its own account and reports against that — on whichever
    /// engine runs it. A key therefore never falls back to the runner's numbers — those are a different
    /// subscription — and simply has no gauge when its credential has no quota to report. OpenCode's own
    /// configuration and the legacy built-in `dsh` report none. A configured row that shadows a built-in
    /// slug is not what dispatch runs, so its credential is not the one being spent either.
    public static func planUsage(engine: String, provider: String, runner: PlanUsage?,
                                 configured: [ConfiguredProvider]?) -> PlanUsageSnapshot? {
        if provider == engine { return runner?.snapshot(for: engine) }
        guard !isBuiltInProvider(provider), provider != "dsh" else { return nil }
        return configuredProvider(provider, in: configured)?.planUsage
    }

    /// Re-resolve an already-rendered seed from freshly fetched Runtime data. A failed runner read
    /// keeps the current value. Likewise, an unavailable providers response cannot safely replace
    /// a key's cached seed with the engine's own default.
    public static func refreshedDefaultModel(currentModel: String, engine: String, provider: String,
                                             catalog: RunnerModelCatalog?,
                                             configured: [ConfiguredProvider]?,
                                             runtimeDefaults: [String: String]?,
                                             runnerSnapshotLoaded: Bool,
                                             configuredProvidersLoaded: Bool) -> String {
        let row = ProviderEngines.configuredRow(provider, configured)
        // A key owns its default and does not wait for runner heartbeat data — except under DeepSeek
        // Harness, whose models are the runner's catalogue whichever key it spends.
        if configuredProvidersLoaded, row != nil, engine != "dsh" {
            return defaultModel(engine: engine, provider: provider, catalog: catalog, configured: configured,
                                runtimeDefaults: runtimeDefaults)
        }
        guard runnerSnapshotLoaded else { return currentModel }
        if !isBuiltInProvider(provider), row == nil, !configuredProvidersLoaded {
            return currentModel
        }
        return defaultModel(engine: engine, provider: provider, catalog: catalog, configured: configured,
                            runtimeDefaults: runtimeDefaults)
    }

    /// Display name for a model id, across providers. Unknown ids (an `ANTHROPIC_MODEL` env
    /// override pointing at a custom endpoint) render as the raw id.
    public static func friendlyName(_ id: String) -> String {
        (kimiModels + opencodeModels + antigravityModels).first { $0.id == id }?.name ?? id
    }

    /// Written as a loop rather than one expression chaining `??` across four optional-chained
    /// `(catalog?.models(for:) ?? []).first { … }?.name` lookups. That form sat right at the Swift
    /// type-checker's limit — resolving the `??` overloads against the generic `first(where:)` and the
    /// optional chains blows up combinatorially — and started failing every Swift job outright with
    /// "unable to type-check this expression in reasonable time". Same provider order, same result.
    public static func friendlyName(_ id: String, catalog: RunnerModelCatalog?) -> String {
        for provider in ["claude", "codex", "kimi", "opencode", "antigravity", "dsh"] {
            let models: [ModelOption] = catalog?.models(for: provider) ?? []
            if let name = models.first(where: { $0.id == id })?.name { return name }
        }
        return friendlyName(id)
    }

    /// As `friendlyName(_:catalog:)`, also checking the configured providers' model rows — a
    /// custom provider's model id renders its label, not the raw id.
    public static func friendlyName(_ id: String, catalog: RunnerModelCatalog?,
                                    configured: [ConfiguredProvider]?) -> String {
        (configured ?? []).flatMap(\.models).first { $0.value == id }?.label
            ?? friendlyName(id, catalog: catalog)
    }

    /// The name a picker shows for `id` when the session runs on `engine` with `provider`: the label
    /// from that pair's OWN option list, which is what web renders (its Select paints the matching
    /// option's label — see `defaultModelLabel`). The distinction matters for a row whose vendor is the
    /// runtime CLI's own endpoint: its list is the runner's live catalogue, which calls the id "Opus 5",
    /// while the preset's shipped fallback list names it "Claude Opus 5". Resolving by id alone let that
    /// fallback label win and made the closed pill disagree with the menu it opens. A model the list
    /// doesn't offer — a Runtime default not yet in the catalogue — keeps the id-based lookup.
    public static func friendlyName(_ id: String, engine: String, provider: String?,
                                    catalog: RunnerModelCatalog?,
                                    configured: [ConfiguredProvider]?) -> String {
        if let name = models(engine: engine, provider: provider, catalog: catalog, configured: configured)
            .first(where: { $0.id == id })?.name {
            return name
        }
        // The empty id is every model-less runtime's "it picks for itself", which the id alone
        // cannot attribute: there OpenCode's row comes first, and an Antigravity session left on ""
        // after its catalog replaced that row would read "Managed by OpenCode". Its own row names it.
        if id.isEmpty, let name = models(for: engine).first(where: { $0.id == id })?.name {
            return name
        }
        // DeepSeek Harness with no model reported yet: the runtime picks, and no other runtime's
        // "it picks for itself" row describes that.
        if id.isEmpty, engine == "dsh" {
            return "Picked by DeepSeek Harness"
        }
        return friendlyName(id, catalog: catalog, configured: configured)
    }

    /// Reasoning-effort levels an engine accepts. Codex, Kimi, OpenCode and Antigravity report
    /// levels per model, so their static lists are only the fallback when the runner catalog does
    /// not report a model — agy's is its whole `--effort` vocabulary (contract §9.2), of which
    /// Gemini 3.1 Pro, say, has Low and High only. Mirrors web. The server and runner both coerce an
    /// illegal value, but a picker should never offer one. The engine decides the vocabulary, never
    /// the provider's slug: a key on Codex's protocol offers Codex's levels (contract §2.3).
    public static func efforts(for engine: String) -> [Effort] {
        switch engine {
        case "codex":    return [.default, .minimal, .low, .medium, .high, .xhigh, .max, .ultra]
        case "kimi":     return [.default, .low, .high, .max]
        case "opencode": return [.default, .minimal, .low, .medium, .high, .xhigh, .max]
        case "antigravity": return [.default, .low, .medium, .high]
        default:         return [.default, .low, .medium, .high, .xhigh, .max, .ultra]
        }
    }

    /// agy tops out at `high` and starts at `low`, so a level carried in from another runtime that
    /// lies outside that range collapses onto its nearer end — `none` included, a Codex level the
    /// string-backed `Effort` can carry in from the server or an account default. Mirrors web's
    /// ANTIGRAVITY_EFFORT_ALIASES.
    private static let antigravityEffortAliases: [String: Effort] = [
        "none": .low, "minimal": .low, "xhigh": .high, "max": .high, "ultra": .high,
    ]

    /// Coerce a saved/account effort when it crosses into an engine with a smaller effort
    /// vocabulary. Mirrors the API normalization so stale sessions and synced preferences render
    /// the same value the runtime will actually receive. OpenCode keeps every value verbatim —
    /// its vocabulary is model-defined and validated against the catalog below.
    public static func normalizeEffort(_ effort: Effort, for engine: String) -> Effort {
        switch engine {
        case "opencode":
            return effort
        case "codex":
            return effort
        case "kimi":
            switch effort {
            case .minimal: return .low
            case .medium:  return .high
            case .xhigh:   return .max
            default:       return effort
            }
        case "antigravity":
            return antigravityEffortAliases[effort.rawValue] ?? effort
        default:
            return effort
        }
    }

    /// Claude Code's effort levels, lowest first: the scale a declared list is read against.
    /// Mirrors `CLAUDE_EFFORT_ORDER` in apiserver common/runtime-provider.ts.
    private static let claudeEffortOrder: [Effort] = [.low, .medium, .high, .xhigh, .max]

    /// The efforts a key's model declares it accepts on Claude Code (`reasoningLevels` on its row),
    /// lowest first, or nil when it declares nothing. Dispatch holds the session to exactly this list
    /// (apiserver `declaredReasoningLevels`) — a self-hosted model refuses the rest — so the pickers
    /// offer this list rather than Claude's. Only Claude Code honours a declaration: on any other
    /// engine the same key's model is that engine's to describe (contract §2.3). Mirrors web.
    private static func declaredEfforts(engine: String, provider: String?, model: String,
                                        configured: [ConfiguredProvider]?) -> [Effort]? {
        guard engine == "claude", let row = ProviderEngines.configuredRow(provider, configured),
              let levels = row.models.first(where: { $0.value == model })?.reasoningLevels
        else { return nil }
        return claudeEffortOrder.filter { levels.contains($0.rawValue) }
    }

    /// The level dispatch runs `effort` at on a model that declares `levels`: the nearest one, the
    /// higher of two equally near, with Ultra (ultracode, which runs at xhigh) kept wherever xhigh
    /// is. Mirrors `effortWithinDeclaredLevels` (apiserver common/runtime-provider.ts), except that
    /// Default stays Default: the picker offers it, and dispatch resolves it.
    private static func nearestDeclaredEffort(_ effort: Effort, in levels: [Effort]) -> Effort {
        let asked: Effort = effort == .ultra ? .xhigh : effort
        guard let rank = claudeEffortOrder.firstIndex(of: asked), let lowest = levels.first else {
            return .default
        }
        if levels.contains(asked) { return effort }
        func distance(_ level: Effort) -> Int {
            abs((claudeEffortOrder.firstIndex(of: level) ?? rank) - rank)
        }
        // `levels` runs lowest first, so `<=` leaves the higher of two equally near levels standing.
        return levels.reduce(lowest) { distance($1) <= distance($0) ? $1 : $0 }
    }

    /// Harness's thinking levels are its catalogue row's `reasoningLevels` (ACP `reasoning_effort`),
    /// opaque like its model values (`off` included). A model the runner hasn't reported offers
    /// Default only: there is no static list to fall back on. Mirrors web's `dshEffortOptions`.
    private static func dshEfforts(model: String, catalog: RunnerModelCatalog?) -> [Effort] {
        var result: [Effort] = [.default]
        for raw in catalog?.modelInfo(for: "dsh", model: model)?.reasoningLevels ?? [] {
            if let effort = Effort(rawValue: raw), effort != .default, !result.contains(effort) {
                result.append(effort)
            }
        }
        return result
    }

    /// The efforts a session on `engine` can pick for `model`. Codex efforts, OpenCode variants, Kimi
    /// and Antigravity levels are model-specific. Preserve every runner-reported key verbatim so a new
    /// runtime variant does not require a native-client release. An exact catalog row is authoritative
    /// even when its variant list is empty — Kimi's K2.7 Coding declares no levels and rejects every one
    /// of them — while only a model absent from the global heartbeat catalog falls back to the common
    /// list, because it may be project-only or come from a runner too old to probe its CLI. `provider`
    /// matters only for a key's declared levels on Claude Code (`declaredEfforts`). Mirrors web's
    /// `effortOptionsFor`.
    public static func efforts(for engine: String, provider: String? = nil, model: String,
                               catalog: RunnerModelCatalog?,
                               configured: [ConfiguredProvider]? = nil) -> [Effort] {
        if engine == "dsh" {
            return dshEfforts(model: model, catalog: catalog)
        }
        if let declared = declaredEfforts(engine: engine, provider: provider, model: model, configured: configured) {
            return efforts(for: engine).filter {
                $0 == .default || declared.contains($0) || ($0 == .ultra && declared.contains(.xhigh))
            }
        }
        guard engine == "codex" || engine == "opencode" || engine == "kimi"
                || engine == "antigravity" else {
            return efforts(for: engine)
        }
        guard let row = catalog?.modelInfo(for: engine, model: model) else {
            return efforts(for: engine)
        }
        var result: [Effort] = [.default]
        for raw in row.reasoningLevels ?? [] {
            if let effort = Effort(rawValue: raw), effort != .default, !result.contains(effort) {
                result.append(effort)
            }
        }
        return result
    }

    /// Whether a stored/current value is valid for this engine-model pair. If an OpenCode or Kimi
    /// model is absent from the global catalog, retain the value: it may be a project-defined model
    /// and variant, or a KIMI_MODEL_* alias. An exact row, including one with no variants, is
    /// authoritative. Codex and Antigravity hold a model the catalog does not report to their
    /// runtime-wide list instead — their vocabularies are closed, so nothing outside it can be valid.
    public static func supportsEffort(_ effort: Effort, for engine: String, model: String,
                                      catalog: RunnerModelCatalog?) -> Bool {
        if effort == .default { return true }
        if engine == "codex" || engine == "antigravity" {
            guard let row = catalog?.modelInfo(for: engine, model: model) else {
                return efforts(for: engine).contains(effort)
            }
            return (row.reasoningLevels ?? []).contains(effort.rawValue)
        }
        if engine == "opencode" || engine == "kimi" {
            guard let row = catalog?.modelInfo(for: engine, model: model) else { return true }
            return (row.reasoningLevels ?? []).contains(effort.rawValue)
        }
        return efforts(for: engine).contains(effort)
    }

    /// The level a session on `engine` actually runs `effort` at, as dispatch normalizes it by the same
    /// engine — so the pill never names a level the session would not get. Clamp a stored/prefilled
    /// value to Default only when the engine/model data says it is incompatible. Unknown OpenCode models
    /// deliberately preserve custom project variants. On a key's model that declares its levels on
    /// Claude Code, a level it lacks is moved, exactly as dispatch moves it. Mirrors web's
    /// `normalizeEffortFor`.
    public static func normalizedEffort(_ effort: Effort, for engine: String, provider: String? = nil,
                                        model: String, catalog: RunnerModelCatalog?,
                                        configured: [ConfiguredProvider]? = nil) -> Effort {
        if engine == "dsh" {
            return dshEfforts(model: model, catalog: catalog).contains(effort) ? effort : .default
        }
        if let declared = declaredEfforts(engine: engine, provider: provider, model: model, configured: configured) {
            return nearestDeclaredEffort(effort, in: declared)
        }
        if engine == "codex" || engine == "opencode" {
            return supportsEffort(effort, for: engine, model: model, catalog: catalog)
                ? effort : .default
        }
        // Closed vocabularies: map what maps (for example Kimi medium→high), clear the rest.
        let mapped = normalizeEffort(effort, for: engine)
        // Kimi's and Antigravity's vocabularies are closed but per-model, so the mapped value still
        // has to clear the model's own list: K2.7 Coding takes none of them, Gemini 3.1 Pro no Medium.
        if engine == "kimi" || engine == "antigravity" {
            return supportsEffort(mapped, for: engine, model: model, catalog: catalog)
                ? mapped : .default
        }
        return efforts(for: engine).contains(mapped) ? mapped : .default
    }

    /// Resolve the effort shown by an interactive new-session composer. Picking an effort writes
    /// the account preference as a last-picked default, so that value wins over the per-workspace
    /// default which predates the account preference. A missing account key falls back to the
    /// workspace value for older accounts; an explicit account `""` deliberately stays Default.
    public static func newSessionEffort(accountDefault: String?, legacyWorkspaceDefault: String?,
                                        for engine: String, provider: String? = nil, model: String,
                                        catalog: RunnerModelCatalog?,
                                        configured: [ConfiguredProvider]? = nil) -> Effort {
        let raw = accountDefault ?? legacyWorkspaceDefault ?? Effort.default.rawValue
        let candidate = Effort(rawValue: raw) ?? .default
        return normalizedEffort(candidate, for: engine, provider: provider, model: model, catalog: catalog,
                                configured: configured)
    }

    /// Whether fast mode — the runtime's own fast lane: Claude Code's `/fast`, Codex's "Fast"
    /// service tier — is something this runtime and model actually have. Parity with
    /// `fastModeAvailable` in `src/shared/src/models.ts`, which is also what the server polices
    /// dispatch with, so a control drawn here cannot promise a lane the runner would drop.
    ///
    /// `runtime` is the session's engine — the CLI that executes it — never the persisted provider
    /// slug: a key runs on whichever engine the session has (contract §2.3), so a DeepSeek key on
    /// Claude Code is answered as Claude Code and the same key on DeepSeek Harness as Harness.
    ///
    /// - Claude: the model's row in the ASSIGNED runner's catalogue decides, because the CLI that
    ///   will run it is the one that knows. Only a row that did not answer (nil) falls back to
    ///   `fastModeCapableClaudeModels`, so a model the runner reports as fast-less stays fast-less
    ///   even while the table still lists it.
    /// - Codex: the same row must advertise the priority tier. A row that says nothing means no —
    ///   codex drops a tier the model does not advertise without a word, so "unknown" must not draw
    ///   a control whose only possible outcome is being ignored.
    /// - Kimi, OpenCode and Antigravity have no fast lane.
    ///
    /// True means "there is a lane for this runtime and model", never "this account is allowed
    /// it": an organisation setting or data residency is the CLI's to refuse when the request goes
    /// out.
    public static func fastModeAvailable(runtime: String, model: String,
                                         catalog: RunnerModelCatalog?) -> Bool {
        if runtime == "claude" {
            if let reported = catalog?.modelInfo(for: runtime, model: model)?.fastMode {
                return reported
            }
            return fastModeCapableClaudeModels.contains(model)
        }
        guard runtime == "codex",
              let tiers = catalog?.modelInfo(for: runtime, model: model)?.serviceTiers else {
            return false
        }
        return tiers.contains(codexFastServiceTier)
    }

    /// The Claude models whose CLI carries `/fast`, used only where the runner's catalogue has no
    /// row to answer with — a row always wins, including when it says no. Keep in sync with web's
    /// FAST_MODE_CAPABLE_CLAUDE_MODELS.
    public static let fastModeCapableClaudeModels: Set<String> = [
        "claude-opus-5-5",
        "claude-opus-5",
        "claude-opus-4-8",
    ]

    /// The tier Codex calls "Fast" (`codex debug models` → `service_tiers: [{id: "priority"}]`).
    /// Mirrors web's CODEX_FAST_SERVICE_TIER and runner-go's codexFastServiceTier.
    public static let codexFastServiceTier = "priority"

    /// Last-resort context windows for the composer's gauge, for a runner too old to report one of
    /// its own. Not the source of truth and not maintained as if it were: the window belongs to the
    /// engine that runs the model, and a table keyed on a model id cannot express it — Claude Code
    /// offers `opus` and `opus[1m]` as one model with two windows, and the answer also moves with
    /// CLI version, account and gateway. The runner probes its CLIs and ships the real number with
    /// each occupancy reading; this is the gap-filler before it arrives. Keep in sync with web's
    /// CONTEXT_WINDOW_BY_MODEL.
    private static func knownContextWindow(for id: String) -> Int? {
        switch id {
        case "claude-opus-5", "claude-fable-5", "claude-sonnet-5": return 1_000_000
        case "claude-haiku-4-5": return 200_000
        case "kimi-code/kimi-for-coding": return 262_144
        default: return nil
        }
    }

    public static func contextWindow(for id: String) -> Int? {
        knownContextWindow(for: id)
    }

    public static func contextWindow(for id: String, catalog: RunnerModelCatalog?) -> Int? {
        contextWindow(for: id, catalog: catalog, configured: nil, provider: nil)
    }

    /// The window to divide a session's context tokens by, when the session hasn't reported one.
    ///
    /// A live session ships its own (TranscriptState.contextWindow) — the runner reads it off the
    /// CLI that produced the tokens, which is the only way the two halves are guaranteed to
    /// describe the same model at the same moment. This resolves the rest, in order of who knows:
    /// the runner's probe of the installed CLIs, then the row that configured *this* session's
    /// provider (a BYOK gateway the runner can't probe), then the shipped table.
    ///
    /// nil when none of them knows, rather than a default: a gauge with no denominator shows the
    /// token count, while one with a fabricated denominator shows a percentage of nothing — which
    /// is how a 1M model read 83% full. `provider` scopes the configured lookup to the session's
    /// own row; unscoped, any vendor listing the same model id could define another's window.
    /// Mirrors web's contextWindowFor.
    public static func contextWindow(for id: String, catalog: RunnerModelCatalog?,
                                     configured: [ConfiguredProvider]?,
                                     provider: String? = nil) -> Int? {
        if id.isEmpty { return nil }
        if let window = catalog?.contextWindow(for: id), window > 0 { return window }
        let rows = (configured ?? []).filter { provider == nil || $0.slug == provider }
        if let window = rows.flatMap(\.models)
            .first(where: { $0.value == id && ($0.contextWindow ?? 0) > 0 })?.contextWindow {
            return window
        }
        return knownContextWindow(for: id)
    }

    public static let permissionModes = PermissionMode.allCases

    /// Modes a runner deployed as root cannot run at all. Mirrors `ROOT_REFUSED_PERMISSION_MODES`
    /// in shared/permissionSemantics.ts: claude refuses Bypass under root ("--dangerously-skip-
    /// permissions cannot be used with root/sudo privileges") and exits inside its own startup, so
    /// the session dies on its first turn having produced nothing. Every other mode starts normally
    /// as root, which is why this is one entry and not "the unsafe ones".
    public static let rootRefusedPermissionModes: Set<PermissionMode> = [.bypass]

    /// Whether a runner can actually run a mode. `runsAsRoot` is optional on purpose: nil is a
    /// runner that has not reported, and reads as unrestricted rather than withdrawing a mode that
    /// works today.
    public static func isRunnable(_ mode: PermissionMode, runsAsRoot: Bool?) -> Bool {
        runsAsRoot == true ? !rootRefusedPermissionModes.contains(mode) : true
    }

    /// The posture a run gets when nobody said. Mirrors `DEFAULT_PERMISSION_MODE` in
    /// apiserver/src/common/permission-mode.ts: the server resolves this same floor at dispatch,
    /// so a pill showing anything else misreports what the runtime is about to do.
    public static let defaultPermissionMode = PermissionMode.auto

    /// Session intent wins; else the account default (`user.preferences.defaultPermissionMode`);
    /// else the floor. Mirrors the server's `resolvePermissionMode`.
    ///
    /// There is deliberately no workspace/agent step: migration 0094 dropped that column and moved
    /// the seed to the account, so a session with no stored mode is *not* "Don't Ask" — and since
    /// the composer pill is authoritative on resume, guessing here doesn't just misreport the
    /// session, it rewrites it on the next send.
    public static func resolvePermissionMode(session: String?,
                                             accountDefault: String?) -> PermissionMode {
        // A mode neither side understands (older/newer client, hand-edited row) falls through
        // rather than reaching a runtime that cannot honour it — the server does the same.
        if let session, let mode = PermissionMode(rawValue: session) { return mode }
        if let accountDefault, let mode = PermissionMode(rawValue: accountDefault) { return mode }
        return defaultPermissionMode
    }

    /// Claude's Auto mode is model-specific. Every other runtime has it runtime-wide, for any
    /// model — Codex spells it `on-request` ("the model decides when to ask the user for
    /// approval"), Kimi and OpenCode expose it as a plain mode, and Antigravity runs it as
    /// `--dangerously-skip-permissions`, on any model it lists.
    ///
    /// Used ONLY where the assigned runner's catalog has not answered for that model. It is a
    /// fallback and no longer a gate: the runner asks the CLI it will actually run the session
    /// with and reports the modes per model, because this set is exactly the shape that fails
    /// silently — when Opus 5.5 shipped, a runner whose CLI could run it kept offering Default
    /// only, with no error anywhere. Mirrors `AUTO_CAPABLE_CLAUDE_MODELS` in
    /// shared/permissionSemantics.ts, including its demotion to a fallback.
    public static let autoCapableModels: Set<String> = [
        "claude-opus-5-5",
        "claude-opus-5",
        "claude-fable-5-1",
        "claude-fable-5",
        "claude-sonnet-5",
    ]

    /// `catalog` is the ASSIGNED runner's — the machine whose CLI decides the answer. Omitting it
    /// falls back to the set above; a row that came back always wins, including when it withholds
    /// Auto for a model the set still lists. Asked of the session's engine: every engine but Claude
    /// Code has Auto for any model, and a key (or pool) on Claude Code owns its model space, which
    /// Claude's per-model list cannot speak for (shared `autoAvailable`).
    public static func supportsAuto(_ model: String, engine: String = "claude", provider: String? = nil,
                                    configured: [ConfiguredProvider]? = nil,
                                    catalog: RunnerModelCatalog? = nil) -> Bool {
        guard engine == "claude" else { return true }
        // A key's model space is vendor-defined (e.g. DeepSeek), so neither the runner's Claude rows
        // nor the fallback set can police it; the CLI decides for itself.
        if ProviderEngines.configuredRow(provider, configured) != nil { return true }
        if let reported = catalog?.permissionModes(for: engine, model: model) {
            return reported.contains(PermissionMode.auto.rawValue)
        }
        return autoCapableModels.contains(model)
    }

    /// Prevent the UI from carrying a model/mode pair that the engine will reject. The backend
    /// applies the same normalization as a final safety net.
    public static func clampPermissionMode(_ mode: PermissionMode,
                                           for model: String, engine: String = "claude",
                                           provider: String? = nil,
                                           configured: [ConfiguredProvider]? = nil,
                                           catalog: RunnerModelCatalog? = nil) -> PermissionMode {
        if !isSupported(mode, engine: engine) { return .default }
        return mode == .auto
            && !supportsAuto(model, engine: engine, provider: provider, configured: configured, catalog: catalog)
            ? .default : mode
    }

    /// Whether `engine` accepts this mode at all. Only DeepSeek Harness refuses modes outright
    /// (`DshRuntime.permissionModes`, enforced at admission), so its others are shown but not
    /// selectable rather than caveated: the session would be rejected. Mirrors web's
    /// `permissionModeSupported`.
    public static func isSupported(_ mode: PermissionMode, engine: String) -> Bool {
        engine != "dsh" || DshRuntime.permissionModes.contains(mode)
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
