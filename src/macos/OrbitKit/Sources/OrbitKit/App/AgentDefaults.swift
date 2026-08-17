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
    public static let allCases: [Effort] = [.default, .minimal, .low, .medium, .high, .xhigh, .max]

    public var id: String { rawValue }
    public var label: String {
        if self == .default { return "Default" }
        if self == .xhigh { return "xHigh" }
        return rawValue.prefix(1).uppercased() + String(rawValue.dropFirst())
    }
}

public enum AgentDefaults {
    /// The built-in runtimes a session (or a pinned task) can run on. Mirrors web's
    /// PROVIDER_OPTIONS. Not an agent-level choice — an agent holds no provider.
    public static let providers: [ProviderOption] = [
        ProviderOption(id: "claude", name: "Claude"),
        ProviderOption(id: "codex", name: "Codex"),
        ProviderOption(id: "kimi", name: "Kimi"),
        ProviderOption(id: "opencode", name: "OpenCode"),
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

    /// The built-in runtime whose live catalog describes a `modelsFromRuntime` provider — the vendor
    /// IS that CLI's own endpoint (Anthropic→claude, OpenAI→codex), so the runner's probe of the
    /// installed CLI leads and the stored `models` list is only the fallback. Read under this key,
    /// never the slug, so an OpenAI provider reads Codex models and can't land in Claude's namespace.
    /// Mirrors web's `custom.runtime === CODEX ? CODEX : CLAUDE`.
    private static func runtimeCatalogKey(for custom: ConfiguredProvider) -> String {
        custom.runtime == "codex" ? "codex" : "claude"
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

    public static let defaultModelID = "claude-opus-5"

    /// The models a provider's pickers offer. Claude and Codex lists come exclusively from the
    /// runner catalog (Codex via `codex debug models`; Claude via `claude -p "/model <alias>"`).
    /// There is no static fallback for them — when the catalog is unavailable the picker is empty.
    /// An unknown provider string returns an empty array too, matching apiserver's
    /// `agentProvider()`, so a stale value can't leak Claude-only options. OpenCode contributes
    /// only its empty "managed by the runtime" sentinel ahead of the runner catalog.
    public static func models(for provider: String) -> [ModelOption] {
        switch provider {
        case "kimi":     return kimiModels
        case "opencode": return opencodeModels
        default:         return []
        }
    }

    public static func models(for provider: String, catalog: RunnerModelCatalog?) -> [ModelOption] {
        if provider == "opencode" {
            return opencodeModels + (catalog?.models(for: provider) ?? [])
        }
        return catalog?.models(for: provider) ?? models(for: provider)
    }

    /// As `models(for:catalog:)`, but a configured provider's own model list (from the control
    /// plane) wins for its slug. Mirrors web's modelOptionsForProvider.
    public static func models(for provider: String, catalog: RunnerModelCatalog?,
                              configured: [ConfiguredProvider]?) -> [ModelOption] {
        if let custom = configuredProvider(provider, in: configured) {
            // …except when the vendor IS the runtime CLI's own endpoint (Anthropic for claude,
            // OpenAI for codex): the runner's probe of the installed CLI is more current than any
            // list we ship, so it leads and the stored `models` is only the fallback. Mirrors web's
            // modelOptionsForProvider.
            if custom.modelsFromRuntime == true,
               let live = catalog?.models(for: runtimeCatalogKey(for: custom)) {
                return live
            }
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
        case "kimi":     return "kimi-code/kimi-for-coding"
        case "opencode": return ""
        default:         return defaultModelID
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
            // For a vendor the runtime CLI speaks to natively, what that CLI reports as its first
            // model beats the id we shipped in the preset — same precedence as the option list.
            if custom.modelsFromRuntime == true,
               let live = catalog?.models(for: runtimeCatalogKey(for: custom))?.first?.id {
                return live
            }
            if let def = custom.defaultModel, !def.isEmpty { return def }
            if let first = custom.models.first(where: { !$0.value.isEmpty && !$0.label.isEmpty }) {
                return first.value
            }
            return defaultModel(for: runtime(for: provider, configured: configured))
        }
        return models(for: provider, catalog: catalog).first?.id ?? defaultModel(for: provider)
    }

    /// Resolve the model a brand-new session should start with. A configured provider owns its
    /// separate model space/default. For built-in runtimes, the heartbeat-reported effective
    /// default wins, then the runner catalog's first model, then the static fallback.
    public static func effectiveDefaultModel(for provider: String, catalog: RunnerModelCatalog?,
                                             configured: [ConfiguredProvider]?,
                                             runtimeDefaults: [String: String]?) -> String {
        if let custom = configuredProvider(provider, in: configured) {
            // A vendor on the runtime CLI's own endpoint follows what that CLI reports as its
            // default — the same value the built-in engine seeds: the heartbeat-reported default
            // first, then (in defaultModel below) its live catalog. Mirrors web's
            // defaultModelForProvider.
            if custom.modelsFromRuntime == true,
               let saved = runtimeDefaults?[runtimeCatalogKey(for: custom)], !saved.isEmpty {
                return saved
            }
            return defaultModel(for: provider, catalog: catalog, configured: configured)
        }
        // A removed/disabled custom identity executes through the historical Claude fallback.
        // Normalize it before consulting heartbeat/catalog data; an unknown slug must never mint
        // a separate Runtime-default namespace or bypass Claude's reported default.
        let runtime = providers.contains(where: { $0.id == provider }) ? provider : "claude"
        if let saved = runtimeDefaults?[runtime], !saved.isEmpty { return saved }
        return defaultModel(for: runtime, catalog: catalog, configured: configured)
    }

    /// A stored model the provider still offers, or nil once the Runtime has retired it — the
    /// caller then re-resolves the current default instead of showing a dead id nobody can select
    /// back. Mirrors web's `livePinnedModel` and the server's `retiredPin`, including which pins
    /// are deliberately left alone: OpenCode owns its own selection, a configured third-party's
    /// list is a document rather than a live probe, an unreported catalog can retire nothing, and
    /// an id the Runtime itself names (`opus`, `opusplan`, a gateway id) is current by definition.
    public static func livePin(_ model: String?, provider: String, catalog: RunnerModelCatalog?,
                               configured: [ConfiguredProvider]?,
                               runtimeDefaults: [String: String]?) -> String? {
        guard let model else { return nil }
        // OpenCode's "you pick" sentinel is a choice, not a stale value.
        if model.isEmpty { return model }
        let custom = configuredProvider(provider, in: configured)
        if custom == nil, provider == "opencode" { return model }
        if let custom, custom.modelsFromRuntime != true { return model }
        let key = custom.map { runtimeCatalogKey(for: $0) } ?? runtime(for: provider,
                                                                      configured: configured)
        guard let offered = catalog?.models(for: key), !offered.isEmpty else { return model }
        if let reported = runtimeDefaults?[key], reported == model { return model }
        return offered.contains { $0.id == model } ? model : nil
    }

    /// Resolve a persisted built-in/configured provider identity to the local runtime that
    /// executes it. Missing configured providers retain the server's historical Claude fallback.
    public static func runtime(for provider: String,
                               configured: [ConfiguredProvider]? = nil) -> String {
        if let custom = configuredProvider(provider, in: configured) {
            // Configured providers borrow Claude, Codex or Kimi. Invalid legacy values, and a
            // provider row that names no runtime at all, use the same safe Claude fallback as
            // the backend.
            let borrowed = custom.runtime ?? ""
            return borrowed == "codex" || borrowed == "kimi" ? borrowed : "claude"
        }
        let value = provider
        return value == "codex" || value == "kimi" ? value : "claude"
    }

    public static func isBuiltInProvider(_ provider: String) -> Bool {
        providers.contains { $0.id == provider }
    }

    /// The quota to show for a session running on `provider` (mirrors web's `sessionPlanUsage`).
    ///
    /// Quota belongs to the credential the session actually spends, so the lookup follows the same
    /// order dispatch does: a configured provider bills its own key and reports against that
    /// account, while a built-in engine runs on the runner's own login and reports through the
    /// heartbeat. A configured slug therefore never falls back to the runner's numbers — those are
    /// a different subscription — and simply has no gauge when its credential has no quota to
    /// report. A configured row that shadows a built-in slug is not what dispatch runs, so its
    /// credential is not the one being spent either.
    public static func planUsage(for provider: String, runner: PlanUsage?,
                                 configured: [ConfiguredProvider]?) -> PlanUsageSnapshot? {
        if !isBuiltInProvider(provider),
           let custom = configuredProvider(provider, in: configured) {
            return custom.planUsage
        }
        return runner?.snapshot(for: provider)
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
        (kimiModels + opencodeModels).first { $0.id == id }?.name ?? id
    }

    /// Written as a loop rather than one expression chaining `??` across four optional-chained
    /// `(catalog?.models(for:) ?? []).first { … }?.name` lookups. That form sat right at the Swift
    /// type-checker's limit — resolving the `??` overloads against the generic `first(where:)` and the
    /// optional chains blows up combinatorially — and started failing every Swift job outright with
    /// "unable to type-check this expression in reasonable time". Same provider order, same result.
    public static func friendlyName(_ id: String, catalog: RunnerModelCatalog?) -> String {
        for provider in ["claude", "codex", "kimi", "opencode"] {
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

    /// The name a picker shows for `id` when the session runs on `provider`: the label from that
    /// provider's OWN option list, which is what web renders (its Select paints the matching
    /// option's label — see `defaultModelLabel`). The distinction matters for a row whose vendor is
    /// the runtime CLI's own endpoint: its list is the runner's live catalogue, which calls the id
    /// "Opus 5", while the preset's shipped fallback list names it "Claude Opus 5". Resolving by id
    /// alone let that fallback label win and made the closed pill disagree with the menu it opens.
    /// A model the list doesn't offer — a Runtime default not yet in the catalogue — keeps the
    /// id-based lookup.
    public static func friendlyName(_ id: String, for provider: String,
                                    catalog: RunnerModelCatalog?,
                                    configured: [ConfiguredProvider]?) -> String {
        models(for: provider, catalog: catalog, configured: configured).first { $0.id == id }?.name
            ?? friendlyName(id, catalog: catalog, configured: configured)
    }

    /// Reasoning-effort levels a provider accepts. Claude tops out at `max`; Codex's Responses API
    /// tops out at `xhigh` and adds `minimal`. Kimi's and OpenCode's levels are model-defined, so
    /// their static lists are only the fallback for a model the catalog does not report.
    /// Mirrors web. The server and runner both coerce an illegal value, but a picker should never
    /// offer one.
    public static func efforts(for provider: String) -> [Effort] {
        switch provider {
        case "codex":    return [.default, .minimal, .low, .medium, .high, .xhigh]
        case "kimi":     return [.default, .low, .high, .max]
        case "opencode": return [.default, .minimal, .low, .medium, .high, .xhigh, .max]
        default:         return [.default, .low, .medium, .high, .xhigh, .max]
        }
    }

    /// Coerce a saved/account effort when it crosses into a runtime with a smaller effort
    /// vocabulary. Mirrors the API normalization so stale sessions and synced preferences render
    /// the same value the runtime will actually receive. OpenCode keeps every value verbatim —
    /// its vocabulary is model-defined and validated against the catalog below.
    public static func normalizeEffort(_ effort: Effort, for provider: String) -> Effort {
        switch provider {
        case "opencode":
            return effort
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

    /// OpenCode variants and Kimi thinking levels are model-specific. Preserve every runner-reported
    /// key verbatim so a new runtime variant does not require a native-client release. An exact
    /// catalog row is authoritative even when its variant list is empty — Kimi's K2.7 Coding
    /// declares no levels and rejects every one of them — while only a model absent from the global
    /// heartbeat catalog falls back to the common list, because it may be project-only or come from
    /// a runner too old to probe its CLI.
    public static func efforts(for provider: String, model: String,
                               catalog: RunnerModelCatalog?) -> [Effort] {
        guard provider == "opencode" || provider == "kimi" else { return efforts(for: provider) }
        guard let row = catalog?.modelInfo(for: provider, model: model) else {
            return efforts(for: provider)
        }
        var result: [Effort] = [.default]
        for raw in row.reasoningLevels ?? [] {
            if let effort = Effort(rawValue: raw), effort != .default, !result.contains(effort) {
                result.append(effort)
            }
        }
        return result
    }

    /// Whether a stored/current value is valid for this provider-model pair. If an OpenCode or Kimi
    /// model is absent from the global catalog, retain the value: it may be a project-defined model
    /// and variant, or a KIMI_MODEL_* alias. An exact row, including one with no variants, is
    /// authoritative.
    public static func supportsEffort(_ effort: Effort, for provider: String, model: String,
                                      catalog: RunnerModelCatalog?) -> Bool {
        if effort == .default { return true }
        if provider == "opencode" || provider == "kimi" {
            guard let row = catalog?.modelInfo(for: provider, model: model) else { return true }
            return (row.reasoningLevels ?? []).contains(effort.rawValue)
        }
        return efforts(for: provider).contains(effort)
    }

    /// Clamp a stored/prefilled value to Default only when the provider/model data says it is
    /// incompatible. Unknown OpenCode models deliberately preserve custom project variants.
    public static func normalizedEffort(_ effort: Effort, for provider: String, model: String,
                                        catalog: RunnerModelCatalog?) -> Effort {
        if provider == "opencode" {
            return supportsEffort(effort, for: provider, model: model, catalog: catalog)
                ? effort : .default
        }
        // Closed vocabularies: map what maps (Codex max→xhigh, Kimi medium→high), clear the rest.
        let mapped = normalizeEffort(effort, for: provider)
        // Kimi's vocabulary is closed but per-model, so the mapped value still has to clear the
        // model's own list: K2.7 Coding takes none of them.
        if provider == "kimi" {
            return supportsEffort(mapped, for: provider, model: model, catalog: catalog)
                ? mapped : .default
        }
        return efforts(for: provider).contains(mapped) ? mapped : .default
    }

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
    /// approval"), Kimi and OpenCode expose it as a plain mode.
    /// Mirrors `AUTO_CAPABLE_CLAUDE_MODELS` in shared/permissionSemantics.ts.
    public static let autoCapableModels: Set<String> = [
        "claude-opus-5",
        "claude-fable-5",
        "claude-sonnet-5",
    ]

    public static func supportsAuto(_ model: String, provider: String = "claude",
                                    configured: [ConfiguredProvider]? = nil) -> Bool {
        // The runtime that will actually honor the mode, so `executingRuntime` rather than
        // `runtime(for:)` — the latter answers "claude" for the OpenCode slug (fine for the model
        // defaults it serves), which would clamp away an Auto the OpenCode session does have.
        let runtime = SessionProviderChoices.executingRuntime(provider, configured: configured ?? [])
        guard runtime == "claude" else { return true }
        // A configured provider's model space is vendor-defined (e.g. DeepSeek), so the static
        // Claude allow-list can't police it; the CLI decides for itself.
        return configuredProvider(provider, in: configured) != nil
            || autoCapableModels.contains(model)
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
