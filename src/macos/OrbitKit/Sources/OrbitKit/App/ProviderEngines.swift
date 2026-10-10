import Foundation

/// The engines a session can run on, each by its CLI's own product name, and which engines a
/// credential runs on: the compatibility table of the provider/engine split
/// (docs/provider-engine-contract.md §2.1), shared `providerEngines.ts` — `ALL_ENGINES` and
/// `ENGINE_CLI_NAMES`, which `SettingsCopyParityTests` reads back out of that file, then
/// `credentialEngines`, `defaultEngineOf` and `isEngineCompatible`. Mirrored in Kotlin too; keep the
/// three in sync.
///
/// A session has two axes. Its engine is the CLI on the runner that produced its runtimeSessionId,
/// fixed for the session's life. Its provider is only where the credential comes from: the engine's
/// own sign-in on the runner (the slug is the engine's name), an account pool, a configured key, or
/// OpenCode's own config. A key is no engine's: one DeepSeek key runs on Claude Code, OpenCode and
/// DeepSeek Harness alike. Clients read each key's engines off /providers (`ConfiguredProvider.engines`):
/// only the server, holding the key, can tell a Claude subscription token.
public enum ProviderEngines {
    /// Every engine, in the order a picker lists them, with its CLI's name.
    public static let names: [(engine: String, name: String)] = [
        ("claude", "Claude Code"),
        ("codex", "Codex"),
        ("kimi", "Kimi Code"),
        ("antigravity", "Antigravity CLI"),
        ("opencode", "OpenCode"),
        ("dsh", "DeepSeek Harness"),
    ]

    /// Every engine, in the order a picker lists them (shared `ALL_ENGINES`).
    public static let all: [String] = names.map(\.engine)

    /// "Antigravity CLI" for `antigravity`; an engine this build doesn't know, by the name it came as.
    public static func cliName(_ engine: String) -> String {
        names.first { $0.engine == engine }?.name ?? engine
    }

    public static func isEngine(_ value: String?) -> Bool {
        value.map(all.contains) ?? false
    }

    /// Where a session's credential comes from — the four kinds a provider slug can name (shared
    /// `EngineCredential`).
    public enum Credential: Equatable, Sendable {
        /// The engine's own sign-in on the runner; the provider slug is the engine's name.
        case login(engine: String)
        /// An account pool, which runs on the engine it was made on.
        case pool(engine: String)
        /// A configured key. `runtime` is the row's column, which names the protocol its endpoint speaks;
        /// `subscriptionToken` is whether the key is a Claude subscription token, which Anthropic serves
        /// to Claude Code alone — the server's to say.
        case key(runtime: String?, presetSlug: String?, baseUrl: String, subscriptionToken: Bool)
        /// OpenCode's own provider configuration on the runner.
        case opencode
    }

    /// The engine whose own protocol each dialect is: what a key runs on when nothing else is named.
    private static let nativeEngine: [OpenCodeKeys.Dialect: String] = [
        .anthropic: "claude", .openai: "codex", .openaiCompatible: "kimi", .gemini: "antigravity",
    ]

    private static let deepSeekHost = "api.deepseek.com"
    /// The presets whose key is a DeepSeek platform key. `deepseek-harness` rows exist until the
    /// migration folds them into DeepSeek keys.
    private static let deepSeekPresets: Set<String> = ["deepseek", "deepseek-harness"]

    /// Whether a row's key is a DeepSeek account's, the only keys DeepSeek Harness runs on. A preset row
    /// is decided by its preset; a custom one (no preset) by its endpoint being DeepSeek's own host.
    public static func isDeepSeekKey(presetSlug: String?, baseUrl: String) -> Bool {
        if let presetSlug, !presetSlug.isEmpty { return deepSeekPresets.contains(presetSlug) }
        guard let url = URL(string: baseUrl), url.scheme != nil, let host = url.host else { return false }
        return host.lowercased() == deepSeekHost
    }

    /// The engines `credential` can run on, its default engine first and the rest in `all`'s order;
    /// empty when nothing can run it (a key on a protocol no engine speaks).
    public static func credentialEngines(_ credential: Credential) -> [String] {
        switch credential {
        case .login(let engine), .pool(let engine):
            return isEngine(engine) ? [engine] : []
        case .opencode:
            return ["opencode"]
        case .key(let runtime, let presetSlug, let baseUrl, let subscriptionToken):
            guard let dialect = OpenCodeKeys.dialect(runtime), let native = nativeEngine[dialect] else { return [] }
            if subscriptionToken { return dialect == .anthropic ? ["claude"] : [] }
            // A row still on the retired `dsh` runtime ran on DeepSeek Harness, and keeps doing so by default.
            let legacyDsh = runtime == "dsh"
            let first = legacyDsh ? "dsh" : native
            var runs: Set<String> = [native, "opencode"]
            if dialect == .anthropic && (legacyDsh || isDeepSeekKey(presetSlug: presetSlug, baseUrl: baseUrl)) {
                runs.insert("dsh")
            }
            return [first] + all.filter { $0 != first && runs.contains($0) }
        }
    }

    /// The engine a caller that names only the credential gets, or nil when nothing can run it.
    public static func defaultEngine(of credential: Credential) -> String? {
        credentialEngines(credential).first
    }

    public static func isCompatible(_ engine: String, _ credential: Credential) -> Bool {
        credentialEngines(credential).contains(engine)
    }

    // MARK: - Reading a provider slug the way the pickers do (web `workspaceDefaults`)

    /// The engines whose own sign-in on the runner is a credential: the provider slug is the engine's
    /// name, and only that engine runs it.
    public static let loginEngines = ["claude", "codex", "kimi", "antigravity"]

    /// Whether `provider` is an engine's own sign-in on the runner (its slug is the engine's name).
    public static func isLoginProvider(_ provider: String?) -> Bool {
        provider.map(loginEngines.contains) ?? false
    }

    /// The engines a key runs on, its default first, as the server answers for it (`engines`). A row from
    /// a payload that predates `engines` — and a pool read as a provider — runs on its protocol's own
    /// engine, and on OpenCode where the server said so; a protocol no engine speaks, on none.
    public static func of(_ key: ConfiguredProvider) -> [String] {
        if let engines = key.engines { return engines.filter(isEngine) }
        guard let dialect = OpenCodeKeys.dialect(key.runtime), let native = nativeEngine[dialect] else { return [] }
        let first = key.runtime == "dsh" ? "dsh" : native
        return key.runsOnOpenCode == true ? [first, "opencode"] : [first]
    }

    /// The configured key (or pool) `provider` names. An engine's own sign-in and OpenCode's own config
    /// never match one: dispatch reads those slugs as built-ins first.
    public static func configuredRow(_ provider: String?, _ configured: [ConfiguredProvider]?) -> ConfiguredProvider? {
        guard let provider, !isLoginProvider(provider), provider != "opencode" else { return nil }
        return configured?.first { $0.slug == provider }
    }

    /// The engines `provider` runs on, the one a session naming only it gets first: an engine's own
    /// sign-in its engine, OpenCode's own config OpenCode, a key what GET /providers says, a pool its own
    /// engine. The legacy built-in `dsh` is DeepSeek Harness on the key its workspace's environment
    /// holds. Empty for a provider this account does not have (removed, turned off, not loaded yet).
    public static func engines(ofProvider provider: String?, configured: [ConfiguredProvider]?) -> [String] {
        guard let provider, !provider.isEmpty else { return [] }
        if isLoginProvider(provider) { return [provider] }
        if provider == "opencode" { return ["opencode"] }
        if let row = configuredRow(provider, configured) { return of(row) }
        return provider == "dsh" ? ["dsh"] : []
    }

    /// The engine a session naming only `provider` runs on, or nil when nothing here can say.
    public static func defaultEngine(ofProvider provider: String?, configured: [ConfiguredProvider]?) -> String? {
        engines(ofProvider: provider, configured: configured).first
    }

    /// The engine a session runs on: the one it recorded, which never changes — else, for a row an older
    /// replica wrote, the engine its provider ran on before engines were recorded (contract §1.1), and
    /// Claude Code when even that provider is gone, as dispatch used to read it.
    public static func sessionEngine(_ engine: String?, provider: String?,
                                     configured: [ConfiguredProvider]?) -> String {
        if isEngine(engine), let engine { return engine }
        return defaultEngine(ofProvider: provider, configured: configured) ?? "claude"
    }

    /// A session's provider and model with OpenCode's old encoding read the new way: a session an older
    /// client started on a key under OpenCode stored `opencode` and named the key in its model,
    /// `orbit-<slug>/<model>` (contract §3.3). That is the key `<slug>`, with `<model>`.
    public static func sessionPick(engine: String, provider: String,
                                   model: String?) -> (provider: String, model: String?) {
        guard engine == "opencode", provider == "opencode", let key = OpenCodeKeys.key(of: model) else {
            return (provider, model)
        }
        return (key.slug, key.model)
    }
}
