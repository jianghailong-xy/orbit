import Foundation

/// The Infrastructure page on iOS and macOS — the web's `/infrastructure` (InfrastructurePage.tsx): where
/// the account's agents run and whose quota they spend, on one page (docs/mocks/infrastructure-page/03-ios.png).
/// It is the Mac's Infrastructure section, and Settings › Infrastructure on a phone. Top to bottom: what
/// needs a person, the machines, the account pools and the API keys.
///
/// Needs you, at its top, is what the web's page drew too until it dropped it (2026-10-25): the same rules,
/// read from the same lists — the machines (GET /runners) and the pools, its own and the ones it is in —
/// so nothing new is asked of the server.
public enum Infrastructure {

    // MARK: - Words

    /// The page's line under its title on the web; under Settings' Machines & models row on a phone.
    public static let subtitle = "Where your agents run, and whose model quota they spend."
    /// Over the lines that wait on a person — Settings' "1 needs you" counts them. The web draws them as a
    /// card of their own, with no heading.
    public static let needsYou = "Needs you"
    public static let machines = "Machines"
    public static let machinesDetail = "Subscriptions signed in here are spent only by sessions on that machine."
    public static let details = "Details"
    public static let manage = "Manage"
    /// A key that is switched off — listed, and nothing runs on it.
    public static let disabled = "Disabled"

    public static func offlineLine(machine: String) -> String { "\(machine) is offline" }

    /// "Last seen 1d ago · its subscriptions are unavailable until it’s back".
    public static func offlineDetail(lastHeartbeatAt: String?, nowMs: Int64) -> String {
        let seen = lastHeartbeatAt.map { "Last seen \(RunnerAttention.ago($0, nowMs: nowMs))" } ?? "Never checked in"
        return seen + " · its subscriptions are unavailable until it’s back"
    }

    /// A machine online that nothing can run on: its page's "No coding CLI is signed in", by its name.
    public static func noCliLine(machine: String) -> String { "\(machine) has no coding CLI signed in" }

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
            /// A machine that is offline: its record.
            case offline(runnerID: String)
            /// A machine online with no coding CLI signed in and nothing on a key: its record, which signs one in.
            case noCliSignedIn(runnerID: String)
            /// A pool no session can start on: its page — one of the account's own, or one it is in.
            case poolUnavailable(poolID: String, own: Bool)
        }

        public let kind: Kind
        /// "ThinkPad is offline".
        public let line: String
        /// The names the line sets in bold, as the web does.
        public let names: [String]
        /// What it means: "Last seen 1d ago · its subscriptions are unavailable until it’s back".
        public let detail: String

        public var id: String {
            switch kind {
            case .offline(let runnerID): return "offline:\(runnerID)"
            case .noCliSignedIn(let runnerID): return "nocli:\(runnerID)"
            case .poolUnavailable(let poolID, _): return "pool:\(poolID)"
            }
        }
    }

    /// What needs a person, a line each: each machine offline, then each machine online that nothing can
    /// run on — no coding CLI signed in and no workspace on a key (`RunnerAttention.noCliSignedIn`, which
    /// the web's Settings row counts too) — then each pool no session can start on, the ones the account is
    /// in before its own, as the page lists them. Empty while nothing does. An engine signed out beside one
    /// signed in is no line, as the web's machine card draws it nothing: the machine's own page says so, and
    /// signs it in. `workspaces` are the account's, each on the machine it names.
    public static func attention(runners: [Runner], workspaces: [Agent], memberPools: [ProviderPool],
                                 ownPools: [ProviderPool], now: Date = Date()) -> [Attention] {
        let offline = runners.filter { $0.online != true }.map { runner -> Attention in
            let machine = RunnerPageFormat.displayName(runner)
            return Attention(kind: .offline(runnerID: runner.id), line: offlineLine(machine: machine),
                             names: [machine],
                             detail: offlineDetail(lastHeartbeatAt: runner.lastHeartbeatAt,
                                                   nowMs: RunnerPageFormat.nowMs(now)))
        }
        let noCli = runners.filter { $0.online == true }.compactMap { runner -> Attention? in
            guard let engines = RunnerAttention.noCliSignedIn(
                runner, workspaces: workspaces.filter { $0.runnerId == runner.id }) else { return nil }
            let machine = RunnerPageFormat.displayName(runner)
            return Attention(kind: .noCliSignedIn(runnerID: runner.id), line: noCliLine(machine: machine),
                             names: [machine], detail: RunnerAttention.noCliSignedInDetail(engines))
        }
        let pools = memberPools.map { (pool: $0, own: false) } + ownPools.map { (pool: $0, own: true) }
        let unavailable = pools.compactMap { entry -> Attention? in
            guard let reason = entry.pool.unavailable else { return nil }
            return Attention(kind: .poolUnavailable(poolID: entry.pool.id, own: entry.own),
                             line: poolLine(pool: entry.pool.label), names: [entry.pool.label],
                             detail: poolDetail(reason: reason))
        }
        return offline + noCli + unavailable
    }

    // MARK: - A key's model and name

    /// The model a Cursor CLI session on a Cursor key starts on: Auto, Cursor's own default, by the name
    /// the catalogue of the first machine online that can run it gives it — the models are Cursor CLI's on
    /// each machine, whichever key it runs on (contract §10). Auto with none (web's `cursorModelOf`).
    public static func cursorModel(_ online: [Runner]) -> String {
        for runner in online {
            guard CursorRuntime.state(of: runner) == .ready, let catalog = runner.modelCatalog?.cursor, !catalog.isEmpty
            else { continue }
            let model = runner.runtimeDefaultModels?[CursorRuntime.engine].flatMap { $0.isEmpty ? nil : $0 }
                ?? CursorRuntime.autoModel
            return catalog.first { $0.value == model }?.label ?? catalog[0].label
        }
        return "Auto"
    }

    /// The model a session on this key starts on, by the name the key's own list gives it (web's
    /// `defaultModelOf`): its default, else its first model.
    public static func defaultModel(_ key: ConfiguredProvider) -> String? {
        guard let model = [key.defaultModel, key.models.first?.value].compactMap({ $0 }).first(where: { !$0.isEmpty })
        else { return nil }
        let label = key.models.first { $0.value == model }?.label
        return label.flatMap { $0.isEmpty ? nil : $0 } ?? model
    }

    /// What a key is called: the name its owner gave it, a Gemini key's too — a key is no engine's to be
    /// named after (web's `key.label`).
    public static func keyLabel(_ label: String, presetSlug: String?) -> String { label }

    // MARK: - A machine's row

    /// "2 / 4 running" — the slots taken on a machine that is online.
    public static func running(active: Int, max: Int) -> String { "\(active) / \(max) running" }

    /// A machine's line in the list (03-ios.png): how many of its slots are taken while it is online and has
    /// a limit, then where its engines stand — never a count of the ones signed out, which the web's card
    /// leaves to the machine's own page too.
    public static func machineLine(_ runner: Runner, now: Date = Date()) -> String {
        var parts: [String] = []
        if runner.online == true, let max = runner.maxConcurrent, max > 0 {
            parts.append(running(active: runner.activeSessions ?? 0, max: max))
        }
        parts.append(summary(runner, now: now))
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
        // Cursor CLI wherever its row can get it signed in, installed or not, as every engine here — not on
        // a runner too old for it or a platform it doesn't run on, whose row has nothing to sign in.
        let cursor = CursorRuntime.state(of: runner)
        let engines = LoginEngine.allCases.filter {
            ($0 != .antigravity || runner.antigravity?.googleLogin == .available)
                && ($0 != .cursor || (RunnerPageFormat.showsCursor(runner)
                                      && cursor != .updateRunner && cursor != .unsupportedPlatform))
        }
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

    /// Whether an engine the machine lacks has its page to open from the machine's record (web's Install on
    /// its row): that page installs it — Install, or Retry after an install that failed — or shows the
    /// install running. DeepSeek Harness's page installs its pinned CLI where the machine can run one.
    public static func installsFromPage(_ runner: Runner, engine: String) -> Bool {
        if engine == "dsh" { return DshRuntime.state(of: runner).installable || runner.install?.engine == "dsh" }
        let health = runner.engines?.first { $0.engine == engine }
        if rowKind(health, install: runner.install, slug: engine) == .installing { return true }
        if engine == "opencode" { return installsOpenCode(runner) }
        return LoginEngine(rawValue: engine).map { installable(runner, $0) } ?? false
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
