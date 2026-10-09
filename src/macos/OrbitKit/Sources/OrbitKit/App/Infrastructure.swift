import Foundation

/// The Infrastructure page on iOS and macOS — the web's `/infrastructure` (InfrastructurePage.tsx): where
/// the account's agents run and whose quota they spend, on one page (docs/mocks/infrastructure-page/03-ios.png).
/// It is the Mac's Infrastructure section, and Settings › Infrastructure on a phone. Top to bottom: what
/// needs a person, what each engine can run on now, the machines, the account pools and the API keys.
///
/// The two blocks at its top are the web's own (InfrastructureOverview.tsx): the same rules, read from the
/// same lists — the machines (GET /runners), the account's own keys (GET /providers/mine) and its pools, its
/// own and the ones it is in — so nothing new is asked of the server. Their words are the web's too, which
/// `InfrastructureCopyParityTests` reads back out of the web source.
public enum Infrastructure {

    // MARK: - Words

    /// The page's line under its title on the web; under Settings' Machines & models row on a phone.
    public static let subtitle = "Where your agents run, and whose model quota they spend."
    /// Over the lines that wait on a person — Settings' "1 needs you" counts them. The web draws them as a
    /// card of their own, with no heading.
    public static let needsYou = "Needs you"
    public static let enginesTitle = "What your agents can run on"
    public static let enginesDetail = "Every engine, and everything that can pay for it right now."
    public static let machines = "Machines"
    public static let machinesDetail = "Subscriptions signed in here are spent only by sessions on that machine."
    public static let ready = "Ready"
    public static let notSetUp = "Not set up"
    public static let subscription = "Subscription"
    public static let apiKey = "API key"
    public static let pool = "Pool"
    /// An engine nothing can pay for. The web goes on to offer a key too; adding a key happens on the web.
    public static let nothingCanPay = "No machine signed in, no key."
    public static let installOnAMachine = "Install on a machine"
    public static let signIn = "Sign in"
    public static let details = "Details"
    public static let manage = "Manage"
    /// A key that is switched off — listed, and nothing runs on it.
    public static let disabled = "Disabled"
    public static let signedOutDetail = "Sessions there can’t use it"

    public static func signedOutLine(engine: LoginEngine, machine: String) -> String {
        "\(engine.displayName) is signed out on \(machine)"
    }

    public static func offlineLine(machine: String) -> String { "\(machine) is offline" }

    /// "Last seen 1d ago · its subscriptions are unavailable until it’s back".
    public static func offlineDetail(lastHeartbeatAt: String?, nowMs: Int64) -> String {
        let seen = lastHeartbeatAt.map { "Last seen \(RunnerAttention.ago($0, nowMs: nowMs))" } ?? "Never checked in"
        return seen + " · its subscriptions are unavailable until it’s back"
    }

    public static func poolLine(pool: String) -> String { "\(pool) is unavailable" }

    /// "No account can run · no session can start on it" — the pool's own reason first.
    public static func poolDetail(reason: String) -> String { "\(reason) · no session can start on it" }

    /// "3 machines · 7 / 12 slots busy", over the machines: the slots of those online. Nil with none.
    public static func machinesCount(_ runners: [Runner]) -> String? {
        guard !runners.isEmpty else { return nil }
        let online = runners.filter { $0.online == true }
        let busy = online.reduce(0) { $0 + ($1.activeSessions ?? 0) }
        let all = online.reduce(0) { $0 + ($1.maxConcurrent ?? 0) }
        return "\(runners.count) machine\(runners.count == 1 ? "" : "s") · \(busy) / \(all) slots busy"
    }

    // MARK: - Needs you

    /// One line of what waits on a person (web's `NeedsAttention`), and where its way out goes.
    public struct Attention: Equatable, Sendable, Identifiable {
        public enum Kind: Equatable, Sendable {
            /// An engine installed but signed out on a machine that is online: signed in again on that
            /// engine's page, where signing in lives.
            case signedOut(runnerID: String, engine: LoginEngine)
            /// A machine that is offline: its record.
            case offline(runnerID: String)
            /// A pool no session can start on: its page — one of the account's own, or one it is in.
            case poolUnavailable(poolID: String, own: Bool)
        }

        public let kind: Kind
        /// "Codex is signed out on Mac Studio".
        public let line: String
        /// The names the line sets in bold, as the web does.
        public let names: [String]
        /// What it means: "Sessions there can’t use it".
        public let detail: String

        public var id: String {
            switch kind {
            case .signedOut(let runnerID, let engine): return "out:\(runnerID)/\(engine.rawValue)"
            case .offline(let runnerID): return "offline:\(runnerID)"
            case .poolUnavailable(let poolID, _): return "pool:\(poolID)"
            }
        }
    }

    /// What needs a person, a line each, in the web's order: each engine signed out on a machine that is
    /// online, each machine offline, then each pool no session can start on — the ones the account is in
    /// before its own, as the page lists them. Empty while nothing does.
    public static func attention(runners: [Runner], memberPools: [ProviderPool], ownPools: [ProviderPool],
                                 now: Date = Date()) -> [Attention] {
        let signedOut = runners.flatMap { runner in
            signedOutEngines(runner).map { engine -> Attention in
                let machine = RunnerPageFormat.displayName(runner)
                return Attention(kind: .signedOut(runnerID: runner.id, engine: engine),
                                 line: signedOutLine(engine: engine, machine: machine),
                                 names: [engine.displayName, machine], detail: signedOutDetail)
            }
        }
        let offline = runners.filter { $0.online != true }.map { runner -> Attention in
            let machine = RunnerPageFormat.displayName(runner)
            return Attention(kind: .offline(runnerID: runner.id), line: offlineLine(machine: machine),
                             names: [machine],
                             detail: offlineDetail(lastHeartbeatAt: runner.lastHeartbeatAt,
                                                   nowMs: RunnerPageFormat.nowMs(now)))
        }
        let pools = memberPools.map { (pool: $0, own: false) } + ownPools.map { (pool: $0, own: true) }
        let unavailable = pools.compactMap { entry -> Attention? in
            guard let reason = entry.pool.unavailable else { return nil }
            return Attention(kind: .poolUnavailable(poolID: entry.pool.id, own: entry.own),
                             line: poolLine(pool: entry.pool.label), names: [entry.pool.label],
                             detail: poolDetail(reason: reason))
        }
        return signedOut + offline + unavailable
    }

    /// The engines signed out on a machine that is online — the ones Needs you lists for it, so a machine's
    /// row and that list never disagree. None for a machine offline: its line says so instead.
    public static func signedOutEngines(_ runner: Runner) -> [LoginEngine] {
        guard runner.online == true else { return [] }
        return LoginEngine.allCases.filter { signedOut(runner, $0) }
    }

    /// Whether this engine is signed out on this machine (web's `signedOutOn`): installed, the CLI's own
    /// answer is no, and no account of it is signed in either — with one that is, sessions there still run
    /// on it. Antigravity only where its Google sign-in can be started, the one way back in there is.
    static func signedOut(_ runner: Runner, _ engine: LoginEngine) -> Bool {
        let health = engineHealth(runner, engine)
        guard rowKind(health, install: runner.install, engine: engine) == .signedOut else { return false }
        if engine == .antigravity
            && (runner.antigravity?.supported == false || runner.antigravity?.googleLogin != .available) {
            return false
        }
        return !(health?.accounts ?? []).contains { $0.auth == "yes" }
    }

    // MARK: - What each engine can run on

    /// One engine and what can pay for it now (web's `EngineOverview` card).
    public struct Engine: Equatable, Sendable, Identifiable {
        /// A key that runs on the engine, and the model a session on it starts on.
        public struct Key: Equatable, Sendable {
            public let label: String
            public let model: String?
        }

        public let engine: LoginEngine
        /// Subscription: each machine online signed in to it — "Mac Studio ×2" for two of its accounts.
        public let machines: [String]
        /// API key: the enabled keys whose runtime it is.
        public let keys: [Key]
        /// Pool: its pools that can start a session.
        public let pools: [String]

        /// Ready with any source at all; Not set up without.
        public var ready: Bool { !machines.isEmpty || !keys.isEmpty || !pools.isEmpty }
        public var id: String { engine.rawValue }
    }

    /// Every engine, and what can pay for it now: the machines online signed in to it, by how many of their
    /// accounts; the account's enabled keys that run on it — DeepSeek's under Claude Code — each with its
    /// model; its pools that can start a session (one that is unavailable is in Needs you instead).
    public static func engines(runners: [Runner], keys: [ConfiguredProvider], pools: [ProviderPool]) -> [Engine] {
        let online = runners.filter { $0.online == true }
        return LoginEngine.allCases.map { engine in
            let machines = online.compactMap { runner -> String? in
                let count = logins(runner, engine)
                guard count > 0 else { return nil }
                let name = RunnerPageFormat.displayName(runner)
                return count > 1 ? "\(name) ×\(count)" : name
            }
            let engineKeys = keys.filter { $0.enabled != false && $0.runtime == engine.rawValue }
                .map { Engine.Key(label: keyLabel($0.label, presetSlug: $0.presetSlug), model: defaultModel($0)) }
            let enginePools = pools.filter {
                $0.unavailable == nil && (ProviderPools.runsCodex($0) ? LoginEngine.codex : .claude) == engine
            }
            return Engine(engine: engine, machines: machines, keys: engineKeys, pools: enginePools.map(\.label))
        }
    }

    /// The machine Install on a machine opens, on that engine's page: the first one online, as the web's
    /// does. Nil with none online — the way to one is registering a machine.
    public static func installTarget(_ runners: [Runner]) -> Runner? {
        runners.first { $0.online == true }
    }

    /// How many logins of this engine a session on this machine can run on (web's `loginsOn`): each
    /// account signed in, or the engine's own answer where it reports no accounts. Antigravity's Default
    /// on the machine's own Gemini key counts, as it does on the machine's page (`runsOnEnvKey`).
    static func logins(_ runner: Runner, _ engine: LoginEngine) -> Int {
        guard let health = engineHealth(runner, engine), health.installed == true,
              !(engine == .antigravity && runner.antigravity?.supported == false) else { return 0 }
        let accounts = health.accounts ?? []
        if accounts.isEmpty { return health.auth == "yes" ? 1 : 0 }
        return accounts.filter {
            $0.auth == "yes" || RunnerPageFormat.runsOnEnvKey(health, account: $0.id, auth: $0.auth)
        }.count
    }

    /// The model a session on this key starts on, by the name the key's own list gives it (web's
    /// `defaultModelOf`): its default, else its first model.
    public static func defaultModel(_ key: ConfiguredProvider) -> String? {
        guard let model = [key.defaultModel, key.models.first?.value].compactMap({ $0 }).first(where: { !$0.isEmpty })
        else { return nil }
        let label = key.models.first { $0.value == model }?.label
        return label.flatMap { $0.isEmpty ? nil : $0 } ?? model
    }

    /// What a key is called (web's `providerDisplayLabel`): the runtime's name for the Gemini preset left
    /// under its own name, and whatever its owner named it otherwise.
    public static func keyLabel(_ label: String, presetSlug: String?) -> String {
        presetSlug == "gemini" && label == "Gemini" ? "Antigravity" : label
    }

    // MARK: - A machine's row

    /// "2 / 4 running" — the slots taken on a machine that is online.
    public static func running(active: Int, max: Int) -> String { "\(active) / \(max) running" }

    public static func signedOutCount(_ count: Int) -> String {
        count == 1 ? "1 engine signed out" : "\(count) engines signed out"
    }

    /// A machine's line in the list (03-ios.png): how many of its slots are taken while it is online and has
    /// a limit, then how many of its engines are signed out — Needs you's rule — or, with none, where its
    /// engines stand.
    public static func machineLine(_ runner: Runner, now: Date = Date()) -> String {
        var parts: [String] = []
        if runner.online == true, let max = runner.maxConcurrent, max > 0 {
            parts.append(running(active: runner.activeSessions ?? 0, max: max))
        }
        let out = signedOutEngines(runner).count
        parts.append(out > 0 ? signedOutCount(out) : summary(runner, now: now))
        return parts.joined(separator: " · ")
    }

    /// A machine's engines in a few words (web's folded card, `summaryOf`): an install or update under way
    /// or failed, the engines not keeping current while it is online, else how many of the engines the page
    /// lists are signed in.
    public static func summary(_ runner: Runner, now: Date = Date()) -> String {
        let relay = runner.install
        let updating = relay?.mode == "update"
        if relay?.status == "failed" { return updating ? "Update failed" : "Install failed" }
        if relay?.status == "pending" || relay?.status == "installing" { return updating ? "Updating…" : "Installing…" }
        guard let reported = runner.engines else { return "Engines not reported" }
        let engines = LoginEngine.allCases.filter { $0 != .antigravity || runner.antigravity?.googleLogin == .available }
        let shown = reported.filter { health in engines.contains { $0.rawValue == health.engine } }
        let nowMs = RunnerPageFormat.nowMs(now)
        let stale = shown.filter {
            $0.installed == true && RunnerAttention.updateNoteOf($0.update, nowMs: nowMs)?.tone == .warn
        }.count
        if stale > 0 && runner.online == true {
            return stale == 1 ? "1 engine not updating" : "\(stale) engines not updating"
        }
        let ready = shown.filter(signedIn).count
        return ready == engines.count ? "All signed in" : "\(ready) of \(engines.count) signed in"
    }

    /// Signed in, with every account of it too (web's `signedIn`): Antigravity's Default on the machine's
    /// own key runs, so it counts.
    private static func signedIn(_ health: RunnerEngineHealth) -> Bool {
        health.installed == true && health.auth == "yes" && (health.accounts ?? []).allSatisfy {
            $0.auth == "yes" || RunnerPageFormat.runsOnEnvKey(health, account: $0.id, auth: $0.auth)
        }
    }

    // MARK: - One engine on one machine

    /// Where one engine's row stands on a machine (web's `RowKind`).
    public enum RowKind: Equatable, Sendable {
        case signedIn, signedOut
        /// The CLI wouldn't say — never drawn as signed in.
        case unknown
        case missing, installing
        /// Installed, before the machine's next check-in says so itself.
        case installed
        case installFailed
    }

    /// One engine on one machine as its row reads it (web's `engineHealthOf`): the runner's own report — for
    /// Antigravity with its install and credential taken from the server's answer once it has one.
    public static func engineHealth(_ runner: Runner, _ engine: LoginEngine) -> RunnerEngineHealth? {
        let reported = runner.engineHealth(engine)
        guard engine == .antigravity, let state = runner.antigravity, let installed = state.installed else {
            return reported
        }
        return RunnerEngineHealth(engine: engine.rawValue, installed: installed,
                                  version: state.version ?? reported?.version,
                                  auth: reported?.auth ?? (state.envKeyAvailable ? "yes" : "unknown"),
                                  accounts: reported?.accounts, update: reported?.update,
                                  authSource: state.authSource ?? reported?.authSource,
                                  planUsage: reported?.planUsage, installationError: reported?.installationError,
                                  dsh: reported?.dsh)
    }

    /// What an engine's row says (web's `rowKindOf`): an install of it in flight, or one that ended before
    /// the machine's probe answered for itself, outranks the probe; then whether it is there and signed in.
    public static func rowKind(_ health: RunnerEngineHealth?, install: RunnerInstallState?,
                               engine: LoginEngine) -> RowKind {
        rowKind(health, install: install, slug: engine.rawValue)
    }

    /// The same for an engine named by its slug — OpenCode among them, which a runner installs and
    /// nothing here signs in.
    public static func rowKind(_ health: RunnerEngineHealth?, install: RunnerInstallState?,
                               slug engine: String) -> RowKind {
        if let install, install.engine == engine {
            if install.status == "pending" || install.status == "installing" { return .installing }
            if install.status == "failed" && health?.installed != true { return .installFailed }
            if install.status == "done" && health?.installed != true { return .installed }
        }
        guard health?.installed == true else { return .missing }
        switch health?.auth {
        case "yes": return .signedIn
        case "no": return .signedOut
        default: return .unknown
        }
    }

    /// Whether an engine's page offers to install it on this machine (web's Install and Retry on its row):
    /// one the machine doesn't have, or whose last install failed — Antigravity only on a runner that can
    /// run it.
    public static func installable(_ runner: Runner, _ engine: LoginEngine) -> Bool {
        if engine == .antigravity && runner.antigravity?.supported == false { return false }
        switch rowKind(engineHealth(runner, engine), install: runner.install, engine: engine) {
        case .missing, .installFailed: return true
        default: return false
        }
    }

    /// Whether OpenCode's page offers to install it (web's OpenCode row): it signs in per provider, on the
    /// machine, so its install is the one press its page has — on a machine that reports it missing, or
    /// whose last install of it failed. A runner that never mentions OpenCode gets none, as the web draws
    /// it no row.
    public static func installsOpenCode(_ runner: Runner) -> Bool {
        guard let health = runner.engines?.first(where: { $0.engine == "opencode" }) else { return false }
        switch rowKind(health, install: runner.install, slug: "opencode") {
        case .missing, .installFailed: return true
        default: return false
        }
    }
}
