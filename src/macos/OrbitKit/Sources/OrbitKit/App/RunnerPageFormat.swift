import Foundation

/// How the runner list and a runner's pages put a machine into words — the native half of the
/// effect mocks' runner page (ios-list.png, ios-detail.png), drawn by iOS and macOS alike.
///
/// What needs a person, and every sentence said about it, is not decided here: that is
/// `RunnerAttention` and `RunnerPageCopy`, the same rule and words as the web's. This is what the
/// pages build from them and from the DTOs — which status word leads the page, the slots a row
/// shows, an engine's version without its CLI's decoration, which account a sign-in names, a disk in
/// GB, a time in the reader's own time zone — kept here rather than in the SwiftUI views so it is
/// tested where the views cannot be compiled.
public enum RunnerPageFormat {

    /// `Date` as the epoch milliseconds `RunnerAttention` takes its clock in.
    public static func nowMs(_ now: Date) -> Int64 {
        Int64((now.timeIntervalSince1970 * 1_000).rounded())
    }

    // MARK: presence

    /// The status dot, by the web's rule: green online, grey offline — a machine that drains is online.
    public enum Presence: Equatable, Sendable {
        case online
        case offline
    }

    public static func isOffline(_ runner: Runner, now: Date) -> Bool {
        RunnerAttention.runnerIsOffline(runner, nowMs: nowMs(now))
    }

    public static func presence(_ runner: Runner, now: Date) -> Presence {
        isOffline(runner, now: now) ? .offline : .online
    }

    /// The name every screen shows a machine by: the owner's alias, else Orbit Cloud for the account's
    /// managed runner (its row's `managed`, else `ManagedRunnerIdentity`, the managed status's runnerId —
    /// never its stored name, `orbit-managed` on a server before migration 1250), else the machine's own name.
    public static func displayName(_ runner: Runner) -> String {
        displayName(runner, managedRunnerID: ManagedRunnerIdentity.runnerID)
    }

    /// `displayName` against a given managed runner id: what the default form reads, kept pure for tests.
    public static func displayName(_ runner: Runner, managedRunnerID: String?) -> String {
        let alias = runner.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !alias.isEmpty { return alias }
        return isManaged(runner, managedRunnerID: managedRunnerID) ? RunnerPageCopy.MANAGED_RUNNER_LABEL : runner.name
    }

    /// The name a machine falls back to with no alias: Orbit Cloud for the managed runner, else its own.
    public static func defaultName(_ runner: Runner) -> String {
        isManaged(runner) ? RunnerPageCopy.MANAGED_RUNNER_LABEL : runner.name
    }

    /// Whether `runner` is the account's managed runner: its row says so (`managed`), or its id is the
    /// managed status's runnerId (an older server, which sends no flag).
    public static func isManaged(_ runner: Runner) -> Bool {
        isManaged(runner, managedRunnerID: ManagedRunnerIdentity.runnerID)
    }

    /// `isManaged` against a given managed runner id, kept pure for tests.
    public static func isManaged(_ runner: Runner, managedRunnerID: String?) -> Bool {
        runner.managed == true || isManaged(runner.id, managedRunnerID: managedRunnerID)
    }

    public static func isManaged(_ runnerID: String?, managedRunnerID: String?) -> Bool {
        guard let runnerID, let managedRunnerID, !runnerID.isEmpty, !managedRunnerID.isEmpty else { return false }
        return PublicID.storageKey(runnerID) == PublicID.storageKey(managedRunnerID)
    }

    /// The OS a runner reported, from its `os:<goos>` capability (`darwin`, `linux`, `windows`, …), as the web's
    /// `machineOs` reads it; nil when it has not said. A machine list draws its mark by it (docs/mocks/machine-menu-icons, A).
    public static func os(_ runner: Runner) -> String? {
        guard let capability = runner.capabilities?.first(where: { $0.hasPrefix("os:") }) else { return nil }
        return String(capability.dropFirst(3))
    }

    /// Orbit Cloud leads the list. The other machines keep the order the server gave them.
    public static func managedFirst(_ runners: [Runner], managedRunnerID: String?) -> [Runner] {
        guard let index = runners.firstIndex(where: { isManaged($0, managedRunnerID: managedRunnerID) }),
              index != runners.startIndex else { return runners }
        var order = runners
        let managed = order.remove(at: index)
        order.insert(managed, at: 0)
        return order
    }

    /// A list row's `4/12` and the bar beside it. The web card's rule: none for an offline machine,
    /// whose count would say nothing true, or for one with no limit reported.
    public struct Slots: Equatable, Sendable {
        public let active: Int
        public let max: Int

        /// How much of the bar is filled, 0…1.
        public var fraction: Double { max > 0 ? min(1, Double(active) / Double(max)) : 0 }
        /// Every slot taken: the bar turns amber.
        public var full: Bool { active >= max }
        public var text: String { RunnerPageCopy.runnerSlots(active: active, max: max) }
    }

    public static func slots(_ runner: Runner, now: Date) -> Slots? {
        guard !isOffline(runner, now: now), let max = runner.maxConcurrent, max > 0 else { return nil }
        return Slots(active: runner.activeSessions ?? 0, max: max)
    }

    /// The list line's colour: the most severe item's — red for a signed-out engine or a stuck
    /// checkout, amber otherwise. Nil when the list shows no attention line.
    public static func listTone(_ items: [RunnerAttentionItem]) -> RunnerAttentionTone? {
        guard RunnerAttention.listAttentionLine(items) != nil else { return nil }
        return items.first?.tone
    }

    // MARK: the page head

    /// The word the head's status line starts with, drawn in its own colour.
    public static func statusWord(_ runner: Runner, now: Date) -> String {
        isOffline(runner, now: now) ? RunnerPageCopy.RUNNER_OFFLINE : RunnerPageCopy.RUNNER_ONLINE
    }

    /// `Online · 4 of 12 running`, or `Offline · last seen Sep 14, 10:25 PM` in the reader's time zone.
    public static func statusLine(_ runner: Runner, now: Date, timeZone: TimeZone = .current) -> String {
        if isOffline(runner, now: now) {
            guard let seen = runner.lastHeartbeatAt, let when = lastSeen(seen, timeZone: timeZone) else {
                return RunnerPageCopy.RUNNER_OFFLINE
            }
            return RunnerPageCopy.runnerOfflineLastSeen(when: when)
        }
        guard let max = runner.maxConcurrent, max > 0 else { return RunnerPageCopy.RUNNER_ONLINE }
        return RunnerPageCopy.RUNNER_ONLINE + RunnerPageCopy.RUNNER_LINE_SEPARATOR
            + RunnerPageCopy.runnerRunningOf(active: runner.activeSessions ?? 0, max: max)
    }

    /// `vmi3129740 · v0.1.197` — the list's second line for a machine that is up, whether or not
    /// this one is: a hostname empty or the same as the name shown is left out.
    /// A managed runner's version is `RunnerAttention.runnerVersionLine`'s: its release or its build line
    /// (`Build 95884b1 · Nov 16`), never `managed-<sha>`.
    public static func hostLine(_ runner: Runner, managed: Bool? = nil) -> String {
        let orbitCloud = managed ?? isManaged(runner)
        let shown = displayName(runner, managedRunnerID: orbitCloud ? runner.id : nil)
        let host = (runner.hostname?.trimmingCharacters(in: .whitespacesAndNewlines))
            .flatMap { $0.isEmpty || $0 == shown ? nil : $0 }
        let version = RunnerAttention.runnerVersionLine(runner.version, managed: orbitCloud)
        return [host, version].compactMap { $0 }.joined(separator: RunnerPageCopy.RUNNER_LINE_SEPARATOR)
    }

    /// Where a machine's IP is, from the Claude region check's last answer (`runner.region`):
    /// `📍 Japan`, `📍 Japan (via proxy)`. Nil for a runner no check has decided, or one too old to
    /// check. The web's `runnerLocationLine`.
    public static func location(_ runner: Runner) -> String? {
        guard let region = runner.region else { return nil }
        let name = region.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let place = name.isEmpty ? (region.country?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") : name
        guard !place.isEmpty else { return nil }
        return region.viaProxy == true
            ? RunnerPageCopy.runnerLocationViaProxy(place: place)
            : RunnerPageCopy.runnerLocation(place: place)
    }

    // MARK: Needs Attention

    /// An item's sentence as the page shows it. A nearly spent quota leads with when it resets, in the
    /// reader's time zone: `Resets Thu, Oct 2 at 11:59 AM. wikova-develop runs on …`.
    public static func attentionDetail(_ item: RunnerAttentionItem, now: Date,
                                       timeZone: TimeZone = .current) -> String {
        guard item.kind == .quotaNearLimit, case .string(let iso)? = item.params["resetsAt"],
              let when = resetsWhen(iso, now: now, timeZone: timeZone) else { return item.detail }
        return RunnerPageCopy.attentionQuotaResets(when: when) + " " + item.detail
    }

    /// The workspace names an item's sentence names, set in bold on the page.
    public static func attentionNames(_ item: RunnerAttentionItem) -> [String] {
        guard case .array(let names)? = item.params["workspaces"] else { return [] }
        return names.compactMap { name in
            guard case .string(let text) = name, item.detail.contains(text) else { return nil }
            return text
        }
    }

    /// The command an item's sentence quotes, set in monospace on the page.
    public static func attentionCode(_ item: RunnerAttentionItem) -> [String] {
        guard let command = item.action?.command, item.detail.contains(command) else { return [] }
        return [command]
    }

    // MARK: Capacity

    /// `186 of 197 GB used`.
    public static func diskUsedLine(_ disk: RunnerDisk) -> String {
        RunnerPageCopy.runnerDiskUsed(used: RunnerAttention.formatDiskGb(disk.totalBytes - disk.freeBytes),
                                      total: RunnerAttention.formatDiskGb(disk.totalBytes))
    }

    /// The disk bar turns amber at 90% used, or once what is free is under the Keep Free reserve.
    public static func diskIsTight(_ disk: RunnerDisk, minFreeDiskMb: Int?) -> Bool {
        if disk.usedPercent >= 90 { return true }
        guard let reserve = keepFreeValue(minFreeDiskMb) else { return false }
        return disk.freeBytes < Int64(reserve) * 1_024 * 1_024
    }

    /// The reserve Keep Free is set to: nil for Off, and for a value that means none.
    public static func keepFreeValue(_ minFreeDiskMb: Int?) -> Int? {
        minFreeDiskMb.flatMap { $0 > 0 ? $0 : nil }
    }

    /// The Keep Free picker's choices: Off / 10 / 20 / 50 GB, and a value set some other way, as it is.
    public static func keepFreeChoices(_ minFreeDiskMb: Int?) -> [RunnerKeepFreeTier] {
        let tiers = RunnerAttention.KEEP_FREE_TIERS
        guard let current = keepFreeValue(minFreeDiskMb), !tiers.contains(where: { $0.mb == current }) else {
            return tiers
        }
        return tiers + [RunnerKeepFreeTier(mb: current, label: RunnerAttention.keepFreeLabel(current))]
    }

    // MARK: Engines

    /// The engines a runner reports on, in the order its page lists them — runnerEngines.ts
    /// `ENGINE_CLI_NAME`'s — and any the page doesn't know yet after them, as reported; Cursor CLI last,
    /// after DeepSeek Harness (board iOS 2 ②), once a runner of the account knows it
    /// (`ProviderEngines.appleShowsEngine`, `fleet` — this runner alone without one). A runner predating
    /// Antigravity, or Cursor CLI, keeps its row too, so the page can explain that it needs an update.
    public static let engineOrder = ["claude", "codex", "kimi", "opencode", "antigravity", "dsh"]

    public static func engines(_ runner: Runner, fleet: [Runner]? = nil) -> [RunnerEngineHealth] {
        var reported = runner.engines ?? []
        if !reported.contains(where: { $0.engine == "antigravity" }) {
            reported.append(RunnerEngineHealth(engine: "antigravity", installed: runner.antigravity?.installed,
                                               version: runner.antigravity?.version))
        }
        let known = engineOrder.compactMap { engine in reported.first { $0.engine == engine } }
        let others = reported.filter { !engineOrder.contains($0.engine) && $0.engine != CursorRuntime.engine }
        guard showsCursor(runner, fleet: fleet) else { return known + others }
        return known + others + [reported.first { $0.engine == CursorRuntime.engine }
            ?? RunnerEngineHealth(engine: CursorRuntime.engine)]
    }

    /// Whether a machine's page draws Cursor CLI: once a runner of the account knows it — this one alone
    /// where no list of the account's runners is in view.
    public static func showsCursor(_ runner: Runner, fleet: [Runner]? = nil) -> Bool {
        ProviderEngines.appleShowsEngine(CursorRuntime.engine, runners: fleet ?? [runner])
    }

    /// The Engines section's footer: Cursor CLI's half sentence beside the others' where its row is drawn
    /// (board iOS 2 ②) — its version is the one Orbit pins, not the latest every 30 minutes.
    public static func enginesFooter(_ runner: Runner, fleet: [Runner]? = nil, offline: Bool) -> String {
        if offline { return RunnerPageCopy.RUNNER_ENGINES_OFFLINE_FOOTER }
        if isManaged(runner) { return RunnerPageCopy.RUNNER_ENGINES_MANAGED_FOOTER }
        return showsCursor(runner, fleet: fleet) ? CursorRuntime.machineEnginesFooter : RunnerPageCopy.RUNNER_ENGINES_FOOTER
    }

    /// Whether `engine` is Claude Code on a machine whose Claude connection comes out where Anthropic
    /// doesn't offer Claude (`Runner.region`, docs/claude-region-check-contract.md): Orbit runs no
    /// Anthropic account there and starts no Claude sign-in, so its row says so, and Check Again stands
    /// where Sign In and Add Account would. A runner that reads no region is never blocked.
    public static func claudeRegionBlocked(_ runner: Runner, engine: String) -> Bool {
        engine == ClaudeRegion.engine && ClaudeRegion.blocked(runner.region)
    }

    /// What a machine blocked for the Claude region says under its Claude Code row (web's
    /// `re-login-note`, board 03's group footnote): why, and what still runs there; then when it was
    /// checked and where Claude's connection came out.
    public struct RegionNote: Equatable, Sendable {
        public let note: String
        public let checked: String?
    }

    public static func claudeRegionNote(_ runner: Runner, now: Date) -> RegionNote? {
        guard let region = runner.region, region.blocked, let name = region.name, !name.isEmpty else { return nil }
        let checked = region.checkedAt.map {
            ClaudeRegionCopy.claudeRegionChecked(when: RunnerAttention.ago($0, nowMs: nowMs(now)), region: name,
                                                 viaProxy: region.viaProxy == true)
        }
        return RegionNote(note: ClaudeRegionCopy.claudeRegionMachineNote(region: name), checked: checked)
    }

    /// The CLI's own product name, as every list of engines says it (shared `ENGINE_CLI_NAMES`, web's
    /// `ENGINE_CLI_NAME`): `Claude Code`, `Codex`, `Kimi Code`, `OpenCode`, `Antigravity CLI`, `DeepSeek
    /// Harness` — on a machine's page as in the pickers.
    public static func engineName(_ engine: String) -> String {
        ProviderEngines.cliName(engine)
    }

    /// OpenCode's sign-in belongs to whichever provider it runs.
    public static func loginEngine(_ engine: String) -> LoginEngine? { LoginEngine(rawValue: engine) }

    /// The engines whose CLI keeps a login per directory, so one machine holds several accounts of
    /// them (shared `ACCOUNT_ENGINES`): an Antigravity account is a Google sign-in in a Gemini
    /// directory of its own, a Kimi Code account a KIMI_CODE_HOME of its own.
    public static func keepsAccounts(_ engine: String) -> Bool {
        engine == "claude" || engine == "codex" || engine == "antigravity" || engine == "kimi"
            || engine == CursorRuntime.engine
    }

    /// Antigravity's Default on a runner that runs agy on its own GEMINI_API_KEY (web `runsOnEnvKey`):
    /// the engine answers signed in — on the key, `authSource` not google — while Default, which is
    /// the runner's Google sign-in and nothing else, does not. A session there runs on that key, so
    /// Default is neither signed out nor short of quota: its line says it runs on the key, as the
    /// engine's row always has ("env key"), and nothing that counts signed-out accounts counts it.
    /// `auth` is Default's own answer — nil where the runner lists no accounts.
    public static func runsOnEnvKey(_ health: RunnerEngineHealth, account: String, auth: String?) -> Bool {
        health.engine == "antigravity" && account == CodexAccounts.defaultID && auth != "yes"
            && health.auth == "yes" && health.authSource != "google"
    }

    /// The version a CLI reported, without what it printed around it: `2.1.284 (Claude Code)` and
    /// `codex-cli 0.158.0` are `2.1.284` and `0.158.0`. Nil when it reported none.
    public static func engineVersion(_ reported: String?) -> String? {
        guard let reported = reported?.trimmingCharacters(in: .whitespacesAndNewlines), !reported.isEmpty else {
            return nil
        }
        for token in reported.split(whereSeparator: { $0 == " " || $0 == "(" || $0 == ")" }) {
            var word = Substring(token)
            if word.first == "v" || word.first == "V" { word = word.dropFirst() }
            let parts = word.split(separator: ".", omittingEmptySubsequences: false)
            if parts.count >= 2, parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy { $0.isASCII && $0.isNumber } }) {
                return String(word)
            }
        }
        return reported
    }

    /// What colour a status word is drawn in.
    public enum Tone: Equatable, Sendable {
        case ok
        case warn
        case muted
    }

    public struct Status: Equatable, Sendable {
        public let text: String
        public let tone: Tone

        public init(text: String, tone: Tone) {
            self.text = text
            self.tone = tone
        }
    }

    /// One login's answer: only the CLI's own yes is signed in; a CLI that wouldn't say is a failed
    /// check, said as such and never as signed in (nor as signed out). Nil only where the account has
    /// no answer of its own to give — Antigravity's Default on the machine's Gemini key.
    public static func authStatus(_ auth: String?) -> Status? {
        switch auth {
        case "yes": return Status(text: RunnerPageCopy.RUNNER_ENGINE_SIGNED_IN, tone: .ok)
        case "no": return Status(text: RunnerPageCopy.RUNNER_ENGINE_SIGNED_OUT, tone: .warn)
        case "unknown": return Status(text: RunnerPageCopy.RUNNER_ENGINE_COULDNT_CHECK, tone: .muted)
        default: return nil
        }
    }

    /// Where an engine's sign-ins stand, after its version on the Engines row. An engine with several
    /// accounts is signed in only when every one of them is (web `signedIn`): a row that called the
    /// machine signed in over a signed-out account would hide the one thing it is there to say.
    public static func engineStatus(_ health: RunnerEngineHealth, runner: Runner? = nil) -> Status? {
        // Claude's connection from this machine comes out where Anthropic doesn't offer Claude: the row's
        // whole story, which no install or sign-in here changes (web's orange Region not supported).
        if let runner, claudeRegionBlocked(runner, engine: health.engine) {
            return Status(text: ClaudeRegionCopy.CLAUDE_REGION_NOT_SUPPORTED, tone: .warn)
        }
        // Harness has no sign-in: each session brings a configured API key. What this machine decides
        // is whether it can start one at all, which is what the row says instead (web parity).
        if health.engine == "dsh" {
            let state = runner.map { DshRuntime.state(of: $0) }
                ?? DshRuntime.state(capabilities: [DshRuntime.runnerCapability], engines: [health])
            guard let label = state.label else { return Status(text: "Uses API keys", tone: .muted) }
            return Status(text: label, tone: state == .notInstalled ? .muted : .warn)
        }
        // A runner that predates Cursor CLI, a platform its pinned build doesn't run on, or a build other
        // than the pinned one: the row's whole story, which nothing signed in changes (web parity).
        if health.engine == CursorRuntime.engine, let runner, let label = CursorRuntime.state(of: runner).blocksLabel {
            return Status(text: label, tone: .warn)
        }
        if health.engine == "antigravity", let runner, health.installed != false, health.auth != "yes" {
            switch runner.antigravity?.googleLogin {
            case .unsupportedPlatform: return Status(text: "Not supported yet", tone: .muted)
            case .available: break
            default: return Status(text: "Update runner", tone: .muted)
            }
        }
        guard health.installed == true else {
            return Status(text: RunnerPageCopy.RUNNER_ENGINE_NOT_INSTALLED, tone: .muted)
        }
        guard loginEngine(health.engine) != nil else { return nil }
        let accounts = health.accounts ?? []
        guard accounts.count >= 2 else {
            // A runner that runs Antigravity on its own Gemini key and holds no Google account but
            // Default says so, as its row always has: the key is what its sessions run on.
            if runsOnEnvKey(health, account: CodexAccounts.defaultID, auth: accounts.first?.auth) {
                return Status(text: "env key", tone: .ok)
            }
            return authStatus(health.auth)
        }
        // Default on such a runner's key runs, so it counts as in, never as out.
        let auths: [String?] = accounts.map { runsOnEnvKey(health, account: $0.id, auth: $0.auth) ? "yes" : $0.auth }
        if auths.allSatisfy({ $0 == "yes" }) {
            return Status(text: RunnerPageCopy.runnerEngineAccountsSignedIn(count: accounts.count), tone: .ok)
        }
        if auths.contains("no") { return authStatus("no") }
        // None out, and not all in: the check answered for some or none of them. Say so rather than
        // leaving the row with no status at all (web's "N couldn’t be checked" / "couldn’t check N
        // accounts" on the group's head).
        let unchecked = auths.filter { $0 != "yes" }.count
        return Status(
            text: unchecked == accounts.count
                ? RunnerPageCopy.runnerEngineCouldntCheckAccounts(count: unchecked)
                : RunnerPageCopy.runnerEngineAccountsUnchecked(count: unchecked),
            tone: .muted)
    }

    /// Which of Kimi's two sites its login is on, said after the version on its Engines row (web's
    /// `2.1.1 · kimi.ai`): the same CLI signs in to either, and a session spends that site's
    /// subscription. Nil for every other engine, before Kimi's first sign-in — and with several
    /// accounts, which can be on different sites: each says its own on the engine page.
    public static func engineSite(_ health: RunnerEngineHealth) -> String? {
        guard (health.accounts ?? []).count < 2 else { return nil }
        return KimiSite.current(of: health)?.domain
    }

    /// OpenCode's note after its version when its CLI listed no provider key (web's
    /// `1.19.5 · no provider key found`): its Unknown is about a key, never the version. Nil otherwise.
    public static func engineKeyNote(_ health: RunnerEngineHealth) -> String? {
        health.engine == "opencode" && health.openCodeNoKey == true && health.auth != "yes"
            ? RunnerPageCopy.RUNNER_ENGINE_NO_PROVIDER_KEY : nil
    }

    /// Whether the Engines row offers Sign In: an engine Orbit signs in, installed, with a login
    /// signed out — never Antigravity's Default on a runner that runs on its own Gemini key
    /// (`runsOnEnvKey`), which is not out.
    public static func needsSignIn(_ health: RunnerEngineHealth) -> Bool {
        guard health.installed == true, loginEngine(health.engine) != nil else { return false }
        return health.auth == "no" || (health.accounts ?? []).contains {
            $0.auth == "no" && !runsOnEnvKey(health, account: $0.id, auth: $0.auth)
        }
    }

    /// Why the engine page cannot sign `engine` in on this runner, where a sentence says it: Antigravity,
    /// whose Google sign-in an older runner or a macOS one doesn't offer — and Cursor CLI on a runner that
    /// can't run it at all, which says what fixes that (`CursorRuntime.stateHint`).
    public static func signInHint(_ runner: Runner, engine: String) -> String? {
        if engine == CursorRuntime.engine {
            let state = CursorRuntime.state(of: runner)
            guard state.blocks else { return nil }
            return CursorRuntime.stateHint(state, installationError: CursorRuntime.health(runner.engines)?.installationError)
        }
        return engine == "antigravity" ? EngineAuth.antigravityLoginHint(runner.antigravity?.googleLogin) : nil
    }

    /// Whether the engine page signs an account of `engine` in on this runner: every engine Orbit
    /// signs in, Antigravity's Google sign-in only where the runner offers it, and Cursor CLI only where
    /// the runner can run it.
    public static func canSignIn(_ runner: Runner, engine: String) -> Bool {
        // No Claude sign-in starts on a machine blocked for the region (contract §12).
        if claudeRegionBlocked(runner, engine: engine) { return false }
        if engine == CursorRuntime.engine { return !CursorRuntime.state(of: runner).blocks }
        return engine != "antigravity" || antigravityCanSignIn(runner)
    }

    /// Whether the engine page offers Add Account: an engine that keeps accounts — for Antigravity, on
    /// a runner that relays its Google sign-in and keeps the account it signs in apart from Default's
    /// (`antigravity-account-login/v1`), and for Kimi on one that signs the account it adds into a
    /// KIMI_CODE_HOME of its own (`kimi-account-login/v1`); an older one would sign Default in again in
    /// its place.
    public static func canAddAccount(_ runner: Runner, engine: String) -> Bool {
        // An account is added by signing it in, which a machine blocked for the Claude region doesn't do.
        guard keepsAccounts(engine), !claudeRegionBlocked(runner, engine: engine) else { return false }
        switch engine {
        case "antigravity":
            return antigravityCanSignIn(runner)
                && runner.capabilities?.contains(CodexAccounts.antigravityAccountLoginCapability) == true
        case "kimi":
            return runner.capabilities?.contains(CodexAccounts.kimiAccountLoginCapability) == true
        case CursorRuntime.engine:
            // A runner that keeps Cursor CLI accounts apart (D4 A, Linux today); any other keeps Default
            // alone (contract §16.2).
            return runner.capabilities?.contains(CursorRuntime.accountLoginCapability) == true
                && !CursorRuntime.state(of: runner).blocks
        default:
            return true
        }
    }

    /// The engine page's name for its section of logins: Accounts where the engine keeps several on
    /// this runner, Sign-In where it has the one — as Kimi and Cursor CLI do on a runner that cannot add
    /// a second (`canAddAccount`), whose page reads as it always has.
    public static func accountsTitle(_ runner: Runner, engine: String) -> String {
        let addedOnlyByCapability = engine == "kimi" || engine == CursorRuntime.engine
        return keepsAccounts(engine) && (!addedOnlyByCapability || canAddAccount(runner, engine: engine))
            ? "Accounts" : "Sign-In"
    }

    public static func antigravityCanSignIn(_ runner: Runner) -> Bool {
        runner.antigravity?.googleLogin == .available
            && runner.engines?.first(where: { $0.engine == "antigravity" })?.installed == true
    }

    /// `Update to 2.1.270 failed Sep 13` — only for a failure that has become the row's problem
    /// (`RunnerAttention.updateNoteOf` says warn); a failed pass the updater retries in half an hour
    /// is the engine page's footnote, not the row's. `dismissed` is the release its warning was dismissed
    /// against (`Runner.engineUpdateDismissals`), which keeps the line away while it is still the latest.
    public static func updateFailedLine(_ health: RunnerEngineHealth, now: Date, dismissed: String? = nil,
                                        timeZone: TimeZone = .current) -> String? {
        guard health.installed == true, let update = health.update, update.status == "failed",
              let latest = update.latest?.trimmingCharacters(in: .whitespacesAndNewlines), !latest.isEmpty,
              RunnerAttention.updateNoteOf(update, nowMs: nowMs(now), dismissed: dismissed)?.tone == .warn,
              let at = update.at, let when = day(at, now: now, timeZone: timeZone) else { return nil }
        return RunnerPageCopy.runnerEngineUpdateFailed(version: latest, when: when)
    }

    /// The engine a Needs Attention item's "Dismiss until next … release" dismisses: an engine not
    /// updating whose latest release is known — only a warning against a known latest has a next one
    /// to wait for (web MachineSettingsPage).
    public static func updateWarningDismissEngine(_ item: RunnerAttentionItem) -> String? {
        guard item.kind == .engineNotUpdating, let engine = item.action?.engine,
              case .string(let latest)? = item.params["latest"], !latest.isEmpty else { return nil }
        return engine
    }

    /// Whether the engine page offers Dismiss for this engine's update warning: an online runner, an
    /// installed CLI whose note still warns, against a known latest (web RunnerEngines' panel).
    public static func offersUpdateWarningDismiss(_ runner: Runner, health: RunnerEngineHealth, now: Date) -> Bool {
        guard !isOffline(runner, now: now), health.installed == true,
              let latest = health.update?.latest, !latest.isEmpty else { return false }
        return RunnerAttention.updateNoteOf(health.update, nowMs: nowMs(now),
                                            dismissed: runner.engineUpdateDismissals?[health.engine])?.tone == .warn
    }

    /// The Engines header's note: when the updater last looked (`Checked 6m ago`) — or, for a runner
    /// that has gone quiet, the day everything under it was last reported (`Reported Sep 14`).
    public static func enginesNote(_ runner: Runner, now: Date, timeZone: TimeZone = .current) -> String? {
        if isOffline(runner, now: now) {
            return runner.lastHeartbeatAt
                .flatMap { day($0, now: now, timeZone: timeZone) }
                .map { RunnerPageCopy.runnerEnginesReported(when: $0) }
        }
        let checked = (runner.engines ?? [])
            .filter { $0.installed == true }
            .compactMap { health in health.update?.at.flatMap { at in RelativeTime.parse(at).map { (at, $0) } } }
            .max { $0.1 < $1.1 }
        return checked.map { RunnerPageCopy.runnerEnginesChecked(when: RunnerAttention.ago($0.0, nowMs: nowMs(now))) }
    }

    /// The quota window an Engines row shows under the engine: the binding one — the window that stops
    /// a login, or will stop it first (`PlanUsageSnapshot.bindingRow`, the one the composer's gauge
    /// shows). Default's while the engine is signed in and has one account; with several — or while
    /// Default is removed from Orbit, even one — that of the account a new session starts on, which the
    /// row names above it (`engineNextAccount`, web's "Next: …") so it never reads as the whole
    /// machine's, and never as Default's. None for an account signed out. One per row, whether the CLI
    /// reports two windows or four: every window, and every account's, is the engine page's to list.
    public static func engineWindows(_ runner: Runner, engine: String, now: Date = Date()) -> [PlanUsageRow] {
        // No Anthropic usage is read on a machine blocked for the Claude region: nothing to gauge.
        guard let health = runner.engines?.first(where: { $0.engine == engine }), health.installed == true,
              !claudeRegionBlocked(runner, engine: engine) else {
            return []
        }
        let account: String
        if (health.accounts ?? []).count >= 2 || health.removedDefault != nil {
            guard let next = nextAccount(runner, health: health, now: now),
                  health.accounts?.first(where: { $0.id == next })?.auth != "no" else { return [] }
            account = next
        } else {
            guard health.auth == "yes" else { return [] }
            account = CodexAccounts.defaultID
        }
        let usage = CodexAccounts.usage(engine, planUsage: runner.planUsage, engines: runner.engines)
        return CodexAccounts.snapshot(usage, account: account)?.bindingRow(at: now).map { [$0] } ?? []
    }

    /// The account an Engines row names above its window while the engine has several — or while its
    /// Default is removed from Orbit, when the one that remains is where sessions start (web's folded
    /// head, "Next: …"): the one a new session starts on, whose window that is. Nil with one account,
    /// with none signed in, or when that account has no window to show — web's row names it above one
    /// only too.
    public static func engineNextAccount(_ runner: Runner, engine: String, now: Date = Date()) -> String? {
        guard let health = runner.engines?.first(where: { $0.engine == engine }), health.installed == true,
              let next = nextAccount(runner, health: health, now: now),
              !engineWindows(runner, engine: engine, now: now).isEmpty else { return nil }
        return CodexAccounts.label(next, accounts: health.accounts)
    }

    /// Whether the engine page marks `account` NEXT beside its name (web `AccountName`'s chip, the
    /// account pools' mark for the same thing): the account a new session nobody picked one for starts
    /// on (`nextAccount`) — so only where the engine has two accounts or more to choose between, or
    /// its Default is removed from Orbit and one remains.
    public static func marksNext(_ runner: Runner, engine: String, account: String, now: Date = Date()) -> Bool {
        // No session starts on any Claude account of a machine blocked for the region (web parity).
        guard let health = runner.engines?.first(where: { $0.engine == engine }),
              !claudeRegionBlocked(runner, engine: engine) else { return false }
        return nextAccount(runner, health: health, now: now) == account
    }

    /// Which of an engine's several accounts a new session starts on (`CodexAccounts.toStartOn`, web's
    /// `accountToStartOn`); nil with one account, or none signed in. While Default is removed from Orbit,
    /// one of the accounts that remain, the only one too (`toStartOn`'s `defaultRemoved`).
    private static func nextAccount(_ runner: Runner, health: RunnerEngineHealth, now: Date) -> String? {
        let usage = CodexAccounts.usage(health.engine, planUsage: runner.planUsage, engines: runner.engines)
        return CodexAccounts.toStartOn(health.accounts, usage: usage, now: now,
                                       defaultRemoved: health.removedDefault != nil)
    }

    /// One account's own windows: Default's are the engine snapshot's, another's its entry under
    /// `accounts` (`CodexAccounts.snapshot`, web `codexAccountSnapshot`) — Antigravity's snapshot being
    /// the one its engine health carries (`CodexAccounts.usage`), where Default's buckets are there only
    /// while the runner's own Google sign-in is.
    public static func accountWindows(_ runner: Runner, engine: String, account: String) -> [PlanUsageRow] {
        guard !claudeRegionBlocked(runner, engine: engine) else { return [] }
        let usage = CodexAccounts.usage(engine, planUsage: runner.planUsage, engines: runner.engines)
        return CodexAccounts.snapshot(usage, account: account)?.rows ?? []
    }

    /// Whether this account's quota was read and its plan carries no quota limit — Kimi only (web's
    /// `kimiNoQuotaLimit`): a windowless kimi snapshot is a plan with nothing to gauge, said as
    /// "No quota limit", never as "No quota reported" (a read that failed or never ran). The read must
    /// have happened (`CodexAccounts.reportedSnapshot` — a Default with `accounts` beside it keeps its
    /// windowless read, which `snapshot` collapses to nil), and the month's coding share counts though
    /// no row draws it: a plan that reports it has a limit.
    public static func accountNoQuotaLimit(_ runner: Runner, engine: String, account: String) -> Bool {
        guard engine == "kimi" else { return false }
        let usage = CodexAccounts.usage(engine, planUsage: runner.planUsage, engines: runner.engines)
        guard let snapshot = CodexAccounts.reportedSnapshot(usage, account: account) else { return false }
        return snapshot.provider == "kimi" && snapshot.fiveHour == nil && snapshot.sevenDay == nil
            && snapshot.month == nil && snapshot.monthCode == nil
    }

    /// The engines whose quota a runner reads: the ones Orbit signs in.
    public static func reportsQuota(_ engine: String) -> Bool { loginEngine(engine) != nil }

    /// One sign-in on the engine page: Default and each account the runner added.
    public struct AccountLine: Equatable, Sendable, Identifiable {
        /// `default`, or the account's id on that runner.
        public let id: String
        /// What the user called it — Default too, once renamed in Orbit — else `Default`, or
        /// `Account <id>`.
        public let name: String
        /// Where its login lives on that machine, with the home directory as `~`.
        public let home: String?
        /// Its sign-in's answer, `yes` / `no` / `unknown` — none for one that runs on a key (`envKey`).
        public let auth: String?
        /// Antigravity's Default on a runner that runs on its own Gemini key (`runsOnEnvKey`): neither
        /// signed in nor out, with nothing to sign in or pause, its line says what it runs on instead.
        public let envKey: Bool
        public var isDefault: Bool { id == CodexAccounts.defaultID }
        /// The line under the name: where its login lives — a Kimi account's after the site its login
        /// is on, which is each account's own (`kimi.com · ~/.orbit/kimi-accounts/5c2e91a0`) — and, for
        /// a Default renamed in Orbit, that it is still the machine's own login (web's DEFAULT mark).
        public var subtitle: String? {
            let line = [site, plan.map { "\($0) plan" }, home, isDefault && name != "Default" ? "Default" : nil]
                .compactMap { $0 }.joined(separator: " · ")
            return line.isEmpty ? nil : line
        }
        /// What a sign-in on this line names: the account, when the runner lists more than one; nil —
        /// the runner's own login, as every sign-in was before accounts — when it doesn't.
        public let signInAccount: String?
        public let pausedUntil: String?
        /// When its login lapses, as the runner read it (`RunnerEngineAccount.loginExpiresAt`).
        public let loginExpiresAt: String?
        /// Kimi only: the site its login is on, `kimi.com` or `kimi.ai` (`KimiSite`) — the account's own,
        /// Default's being the engine's.
        public var site: String? = nil
        /// Cursor CLI only: the plan the account is on, as Cursor names it (`Free`, `Pro`), said before its
        /// directory (board iOS 2 ③, web's `Free plan · ~/.orbit/cursor/default`).
        public var plan: String? = nil
    }

    /// Every account an engine is signed into on that runner, Default first. One line for the
    /// runner's own login when it keeps no others — whose answer is the engine's, unless that is a
    /// Gemini key's rather than Default's Google sign-in (`runsOnEnvKey`). While Default is removed from
    /// Orbit (`removedDefault`) the accounts that remain are each a line of their own, the only one too:
    /// a line of the engine's own login would be Default's, which the machine keeps and Orbit no longer
    /// uses. `usage` is the engine's snapshot (`CodexAccounts.usage`), where a Cursor CLI account's plan
    /// is read.
    public static func accountLines(_ health: RunnerEngineHealth, usage: PlanUsageSnapshot? = nil) -> [AccountLine] {
        let accounts = health.accounts ?? []
        let plan = { (account: String) -> String? in
            health.engine == CursorRuntime.engine ? CodexAccounts.reportedSnapshot(usage, account: account)?.planName : nil
        }
        guard accounts.count >= 2 || (health.removedDefault != nil && !accounts.isEmpty) else {
            let own = accounts.first
            let envKey = runsOnEnvKey(health, account: CodexAccounts.defaultID, auth: own?.auth)
            return [AccountLine(id: CodexAccounts.defaultID,
                                name: CodexAccounts.label(CodexAccounts.defaultID, accounts: accounts),
                                home: (own?.home ?? own?.codexHome).map(tildePath),
                                auth: envKey ? nil : health.auth, envKey: envKey,
                                signInAccount: nil, pausedUntil: own?.pausedUntil,
                                loginExpiresAt: own?.loginExpiresAt, site: engineSite(health),
                                plan: plan(CodexAccounts.defaultID))]
        }
        return accounts.map { account in
            let envKey = runsOnEnvKey(health, account: account.id, auth: account.auth)
            return AccountLine(id: account.id, name: CodexAccounts.label(account.id, accounts: accounts),
                               home: (account.home ?? account.codexHome).map(tildePath),
                               auth: envKey ? nil : account.auth, envKey: envKey,
                               signInAccount: account.id, pausedUntil: account.pausedUntil,
                               loginExpiresAt: account.loginExpiresAt, site: KimiSite.site(of: account)?.domain,
                               plan: plan(account.id))
        }
    }

    /// A Cursor CLI account that met Cursor's usage limit this period (`CursorRuntime.usageLimit`): spent
    /// until its included usage resets. Nil for one that can run, and on every other engine.
    public static func accountUsageLimit(_ runner: Runner, engine: String, account: String,
                                         now: Date = Date()) -> CursorRuntime.UsageLimit? {
        guard engine == CursorRuntime.engine else { return nil }
        let usage = CodexAccounts.usage(engine, planUsage: runner.planUsage, engines: runner.engines)
        return CursorRuntime.usageLimit(CodexAccounts.reportedSnapshot(usage, account: account), now: now)
    }

    /// How far ahead of a login lapsing its line warns: Claude Code's own lead ("Your login expires in
    /// 3 days · run /login to renew"), so the page says it when the CLI would.
    public static let loginWarningLead: TimeInterval = 3 * 86_400

    /// The warning under a signed-in account whose login lapses within `loginWarningLead`, in whole
    /// days rounded up the way Claude Code counts them. Nil for an account not signed in, one whose
    /// login records no lapse, one further off — and one already past it, which the runner reports
    /// signed out.
    public static func loginExpiresLine(_ line: AccountLine, now: Date) -> String? {
        guard line.auth == "yes", let lapses = line.loginExpiresAt.flatMap(RelativeTime.parse) else { return nil }
        let left = lapses.timeIntervalSince(now)
        guard left > 0, left <= loginWarningLead else { return nil }
        let days = Int((left / 86_400).rounded(.up))
        return RunnerPageCopy.runnerEngineLoginExpires(
            count: days, unit: days == 1 ? RunnerPageCopy.RUNNER_UNIT_DAY : RunnerPageCopy.RUNNER_UNIT_DAYS)
    }

    /// What a signed-out account costs, under its Signed out: nothing runs on it until it is signed in
    /// again — and when it is the engine's only account on that machine, nothing runs on the engine
    /// there at all. Nil for any account not signed out.
    public static func signedOutNote(_ line: AccountLine, alone: Bool, engine: String) -> String? {
        guard line.auth == "no" else { return nil }
        return alone ? RunnerPageCopy.runnerEngineSignedOutAlone(engine: engineName(engine))
                     : RunnerPageCopy.RUNNER_ENGINE_ACCOUNT_SIGNED_OUT_NOTE
    }

    /// What a row says under it when its sign-in check got no answer: a failed check, not a
    /// sign-out. Nil for an engine Orbit signs no one in to — OpenCode's unknown is its provider's —
    /// and when every account answered.
    public static func couldntCheckNote(_ health: RunnerEngineHealth, engine: String) -> String? {
        guard health.installed == true, loginEngine(engine) != nil else { return nil }
        let accounts = health.accounts ?? []
        let unchecked = accounts.isEmpty
            ? health.auth == "unknown"
            : accounts.contains { $0.auth == "unknown" && !runsOnEnvKey(health, account: $0.id, auth: $0.auth) }
        return unchecked ? RunnerPageCopy.runnerEngineCouldntCheckNote() : nil
    }

    /// What Add Account calls a new account until the user names it: its number on the machine,
    /// Default being the first — or the next number free, so it never takes a name an account already
    /// goes by (web `defaultAccountName`).
    public static func defaultAccountName(_ accounts: [RunnerEngineAccount]) -> String {
        let taken = Set(accounts.map { CodexAccounts.label($0.id, accounts: accounts) })
        var number = max(accounts.count, 1) + 1
        while taken.contains("Account \(number)") { number += 1 }
        return "Account \(number)"
    }

    /// What became of the last removal asked of this account: under way, or refused in the machine's
    /// own words. Nil when the last removal was another account's. Refused because sessions are running
    /// in the account, it says so in the page's words and lists them (`blocking`, web `BlockingSessions`).
    public struct AccountRemoval: Equatable, Sendable {
        public let pending: Bool
        public let refused: String?
        public let blocking: [BlockingSession]
        /// Under way and waiting on the sessions it moved to another account to leave this one (web
        /// `runnerAccountMovingOne`/`Many`); nil otherwise.
        public let moving: String?

        public init(pending: Bool, refused: String?, blocking: [BlockingSession] = [], moving: String? = nil) {
            self.pending = pending
            self.refused = refused
            self.blocking = blocking
            self.moving = moving
        }
    }

    /// One session a refused removal lists: its title, or Untitled session; a dot — green in a turn,
    /// orange waiting for input, grey otherwise — and the word for the first two; opened by `id`.
    public struct BlockingSession: Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let tone: Tone
        public let label: String?

        public init(_ session: RunnerAccountRemoveSession) {
            id = session.id
            let trimmed = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
            title = trimmed.isEmpty ? RunnerAccountCopy.RUNNER_ACCOUNT_IN_USE_UNTITLED : trimmed
            switch session.status {
            case .running?, .pending?:
                tone = .ok
                label = RunnerAccountCopy.RUNNER_ACCOUNT_IN_USE_RUNNING
            case .awaitingInput?:
                tone = .warn
                label = RunnerAccountCopy.RUNNER_ACCOUNT_IN_USE_WAITING
            default:
                tone = .muted
                label = nil
            }
        }
    }

    public static func removal(_ state: RunnerAccountRemoveState?, engine: String,
                               account: String) -> AccountRemoval? {
        guard let state, state.engine == engine, state.account == account else { return nil }
        let failed = state.status == "failed"
        let blocking = failed ? state.sessions.map(BlockingSession.init) : []
        let refused: String?
        switch blocking.count {
        case 0: refused = failed ? state.message : nil
        // A relayed state naming Default is always a sign-out (docs/default-sign-out-design.md).
        case let count where account == CodexAccounts.defaultID:
            refused = signOutInUse(count: count)
        case 1: refused = RunnerAccountCopy.runnerAccountInUseOne(engine: engineName(engine))
        default: refused = RunnerAccountCopy.runnerAccountInUseMany(engine: engineName(engine), count: blocking.count)
        }
        let pending = state.status == "pending"
        let count = pending ? (state.moving ?? 0) : 0
        let moving: String?
        switch count {
        case ..<1: moving = nil
        case 1: moving = RunnerAccountCopy.runnerAccountMovingOne(engine: engineName(engine))
        default: moving = RunnerAccountCopy.runnerAccountMovingMany(engine: engineName(engine), count: count)
        }
        return AccountRemoval(pending: pending, refused: refused, blocking: blocking, moving: moving)
    }

    /// Whether an account's swipe and long-press menu offer Remove: every account the runner added,
    /// whose sign-in goes from the machine, and Default while another account of that engine stays on
    /// the runner — which takes Default off Orbit's list alone, and which the control plane refuses with
    /// no other account to run on (web `AccountRow`'s `removable`). One on its way off the machine
    /// counts as gone already.
    public static func offersRemove(_ line: AccountLine, health: RunnerEngineHealth, runner: Runner) -> Bool {
        !line.isDefault || othersStaying(line, health: health, runner: runner) > 0
    }

    /// Whether Remove can be pressed: Default's removal is Orbit's own record and asks nothing of the
    /// machine, so it works with the runner offline; an added account's sign-in is deleted by the
    /// runner, which has to be online for it.
    public static func canRemove(_ line: AccountLine, offline: Bool) -> Bool { line.isDefault || !offline }

    /// What a runner declares when it signs `engine`'s Default out on request (runner-go default_sign_out.go).
    public static func defaultSignOutCapability(_ engine: String) -> String { "\(engine)-default-sign-out/v1" }

    /// Whether `line`'s menu offers Sign out…: the Default row of an engine, while it is signed in and its
    /// runner declares it can sign it out — an older runner would read the request as a removal.
    public static func offersSignOut(_ line: AccountLine, engine: String, runner: Runner) -> Bool {
        line.isDefault && line.auth == "yes" && !line.envKey
            && runner.capabilities?.contains(defaultSignOutCapability(engine)) == true
    }

    /// Whether Sign out… can be pressed: the runner deletes the credential, so it has to be online, and
    /// one request at a time is in flight.
    public static func canSignOut(offline: Bool, pending: Bool) -> Bool { !offline && !pending }

    /// Default's login is deleted from the machine; for Claude Code and Codex the CLI in a terminal shares
    /// it, which the question says too (the web's words).
    public static func signOutQuestion(_ line: AccountLine, engine: String, runner: Runner) -> RemovalQuestion {
        let machine = displayName(runner)
        var message = RunnerAccountCopy.runnerDefaultSignOutDetail(runner: machine)
        if engine == "claude" || engine == "codex" {
            message += " " + RunnerAccountCopy.runnerDefaultSignOutTerminal(runner: machine, command: engine)
        }
        return RemovalQuestion(title: RunnerAccountCopy.runnerDefaultSignOutTitle(name: line.name), message: message)
    }

    /// The second question, once the runner named `count` sessions running on Default.
    public static func signOutAgainQuestion(_ line: AccountLine, count: Int) -> RemovalQuestion {
        RemovalQuestion(title: signOutInUse(name: line.name, count: count),
                        message: RunnerAccountCopy.RUNNER_DEFAULT_SIGN_OUT_RUNNING_DETAIL)
    }

    private static func signOutInUse(name: String = "Default", count: Int) -> String {
        count == 1 ? RunnerAccountCopy.runnerDefaultSignOutRunningOne(name: name)
                   : RunnerAccountCopy.runnerDefaultSignOutRunningMany(count: count, name: name)
    }

    /// What a runner declares when it can make an added Claude Code account the Default: the swap
    /// itself, and moving a session into its account's new folder (RunnersService.setDefaultAccount
    /// asks for both).
    public static let claudeAccountSwapCapabilities = ["claude-account-swap/v1", "claude-account-move/v1"]

    /// Whether `line`'s menu offers Set as default: an added Claude Code account's only.
    public static func offersSetDefault(_ line: AccountLine, engine: String) -> Bool {
        engine == "claude" && !line.isDefault
    }

    /// The Set as default this runner has in flight or last finished, when it is `account`'s; nil otherwise.
    public static func swapOf(_ runner: Runner, account: String) -> RunnerClaudeAccountSwapState? {
        guard let swap = runner.claudeAccountSwap, swap.account == account else { return nil }
        return swap
    }

    /// Why Set as default can't be chosen now, said where its hint is; null when it can. `pressing`:
    /// this page's own request is on its way.
    public static func setDefaultBlocked(_ runner: Runner, offline: Bool, pressing: Bool) -> String? {
        if offline { return RunnerAccountCopy.RUNNER_ACCOUNT_SET_DEFAULT_OFFLINE }
        let caps = Set(runner.capabilities ?? [])
        if !claudeAccountSwapCapabilities.allSatisfy(caps.contains) {
            return RunnerAccountCopy.RUNNER_ACCOUNT_SET_DEFAULT_UPDATE
        }
        if pressing || runner.claudeAccountSwap?.status == "pending" {
            return RunnerAccountCopy.RUNNER_ACCOUNT_SET_DEFAULT_BUSY
        }
        return nil
    }

    /// The question before `line`'s Set as default: the swap of the two folders, the terminal, the
    /// sessions and the workspaces. The Default's folder is the one the runner reports, else ~/.claude.
    public static func setDefaultQuestion(_ line: AccountLine, health: RunnerEngineHealth,
                                          runner: Runner) -> RemovalQuestion {
        let accounts = health.accounts ?? []
        let defaultAccount = accounts.first { $0.id == CodexAccounts.defaultID }
        let defaultDir = (defaultAccount?.home ?? defaultAccount?.codexHome).map(tildePath) ?? "~/.claude"
        let defaultName = CodexAccounts.label(CodexAccounts.defaultID, accounts: accounts)
        let dir = line.home ?? ""
        return RemovalQuestion(title: RunnerAccountCopy.runnerAccountSetDefaultTitle(name: line.name),
                               message: RunnerAccountCopy.runnerAccountSetDefaultDetail(
                                   name: line.name, defaultDir: defaultDir, defaultName: defaultName,
                                   dir: dir, runner: displayName(runner)))
    }

    /// Under an account while it is being made the Default: how many sessions' turns the swap waits on,
    /// and any terminal Claude Code on either folder. Nil unless its swap is pending.
    public static func settingDefaultLine(_ runner: Runner, line: AccountLine) -> String? {
        guard let swap = swapOf(runner, account: line.id), swap.status == "pending" else { return nil }
        let waiting = swap.waitingOn.count
        let said: String
        switch waiting {
        case 0: said = RunnerAccountCopy.runnerAccountSettingDefault(name: line.name)
        case 1: said = RunnerAccountCopy.runnerAccountSettingDefaultOne(name: line.name)
        default: said = RunnerAccountCopy.runnerAccountSettingDefaultMany(name: line.name, count: waiting)
        }
        if swap.foreignProcesses.isEmpty { return said }
        return said + " " + RunnerAccountCopy.RUNNER_ACCOUNT_SETTING_DEFAULT_TERMINAL
    }

    /// A swap of this account's that failed, which puts both logins back: its `message` is the machine's
    /// reason. Nil otherwise.
    public static func failedSwap(_ runner: Runner, line: AccountLine) -> RunnerClaudeAccountSwapState? {
        guard let swap = swapOf(runner, account: line.id), swap.status == "failed" else { return nil }
        return swap
    }

    /// The question in front of an account's Remove, and what removing it comes to.
    public struct RemovalQuestion: Equatable, Sendable {
        public let title: String
        public let message: String
    }

    /// Default's says Orbit stops using it there while the machine keeps its sign-in and the CLI in a
    /// terminal keeps working (the web's words, `RunnerAccountCopy`). An added account's sign-in goes from
    /// the machine: while Default is removed from Orbit its workspaces go to Automatic, or — for the last
    /// account Orbit uses there — to Default, by its name, which Orbit then uses again (the web's words
    /// too), never to a Default as though it were in use; while Default is, to Default (the web's words).
    public static func removalQuestion(_ line: AccountLine, health: RunnerEngineHealth,
                                       runner: Runner) -> RemovalQuestion {
        let machine = displayName(runner)
        if line.isDefault {
            return RemovalQuestion(title: RunnerAccountCopy.runnerAccountRemoveTitle(name: line.name),
                                   message: RunnerAccountCopy.runnerDefaultRemoveDetail(
                                       runner: machine, cli: engineName(health.engine)))
        }
        if let name = removedDefaultName(health) {
            return RemovalQuestion(title: RunnerAccountCopy.runnerAccountRemoveTitle(name: line.name),
                                   message: othersStaying(line, health: health, runner: runner) > 0
                                       ? RunnerAccountCopy.runnerAccountRemoveDetailAutomatic(runner: machine)
                                       : RunnerAccountCopy.runnerAccountRemoveDetailLast(runner: machine, name: name))
        }
        return RemovalQuestion(title: RunnerAccountCopy.runnerAccountRemoveTitle(name: line.name),
                               message: RunnerAccountCopy.RUNNER_ACCOUNT_REMOVE_DETAIL)
    }

    /// What a Default removed from Orbit is called: the name it was given in Orbit, else `Default` (web
    /// `accountNameOf`). Nil while Default is in use.
    public static func removedDefaultName(_ health: RunnerEngineHealth) -> String? {
        guard let removed = health.removedDefault else { return nil }
        return CodexAccounts.label(CodexAccounts.defaultID,
                                   accounts: [RunnerEngineAccount(id: CodexAccounts.defaultID, name: removed.name)])
    }

    /// The line that ends an engine's accounts while its Default is removed from Orbit, beside Use again
    /// (web `RemovedDefault`): which one it is and where it lives on the machine, which keeps it —
    /// `Default · ~/.codex isn’t used by Orbit`. Nil while Default is in use.
    public static func removedDefaultLine(_ health: RunnerEngineHealth) -> String? {
        guard let removed = health.removedDefault, !(health.accounts ?? []).isEmpty,
              let name = removedDefaultName(health) else { return nil }
        return RunnerAccountCopy.runnerDefaultRemovedLine(name: name, dir: tildePath(removed.home))
    }

    /// How many of the engine's accounts other than `line`'s stay on the runner: one whose removal is
    /// under way, or done and not yet read again, is as good as gone (web `beingRemoved`).
    private static func othersStaying(_ line: AccountLine, health: RunnerEngineHealth, runner: Runner) -> Int {
        (health.accounts ?? []).filter { account in
            guard account.id != line.id else { return false }
            guard let state = runner.accountRemove, state.engine == health.engine,
                  state.account == account.id else { return true }
            return state.status != "pending" && state.status != "done"
        }.count
    }

    /// Whether an Update Engines Now the runner has not finished is under way.
    public static func engineUpdateInFlight(_ install: RunnerInstallState?) -> Bool {
        guard let install, install.mode == "update" else { return false }
        return install.status == "pending" || install.status == "installing"
    }

    /// One line of what the last Update Engines Now said, and whether it is a failure (drawn red).
    public struct UpdateRelayLine: Equatable {
        public let text: String
        public let failed: Bool
        public init(_ text: String, failed: Bool = false) {
            self.text = text
            self.failed = failed
        }
    }

    /// Where the last Update Engines Now got to, in the web engine section's words. A finished run
    /// lists only the engines that need someone (web `engineUpdateReportLines`): the failures, and
    /// an install Orbit may not replace. Current, updated, pinned, waiting for sessions or retried
    /// on the next pass sort themselves out, and listing them buried the line that mattered.
    public static func updateRelayLines(_ install: RunnerInstallState?) -> [UpdateRelayLine] {
        guard let install, install.mode == "update", let status = install.status else { return [] }
        switch status {
        case "pending": return [UpdateRelayLine("Queued — the runner picks this up on its next check-in.")]
        case "installing": return [UpdateRelayLine("Updating this machine’s engine CLIs…")]
        case "done", "failed":
            let message = install.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if message.isEmpty { return [UpdateRelayLine("Nothing to update.")] }
            let lines = message.split(separator: "\n").map(String.init)
                .filter { updateLineFailed($0) || $0.contains("owned by another user") }
                .map { UpdateRelayLine($0, failed: updateLineFailed($0)) }
            return lines.isEmpty ? [UpdateRelayLine("Nothing here needs your attention.")] : lines
        default: return []
        }
    }

    /// The runner's own rule for a failed run (`updateRunFailed`, src/runner-go/engineinstall.go),
    /// read per line.
    static func updateLineFailed(_ line: String) -> Bool {
        line.contains("update failed") || line.contains("timed out") || line.contains("does not run")
    }

    // MARK: Workspaces

    /// A path the way a terminal spells it, with the machine's home directory as `~` (web
    /// `tildePath`): the page can't ask that machine where its home is, so this reads the places a
    /// home directory lives, and leaves any other path whole.
    public static func tildePath(_ path: String) -> String {
        for prefix in ["/root"] where path == prefix || path.hasPrefix(prefix + "/") {
            return "~" + path.dropFirst(prefix.count)
        }
        for parent in ["/home/", "/Users/"] where path.hasPrefix(parent) {
            let rest = path.dropFirst(parent.count)
            guard let user = rest.split(separator: "/", omittingEmptySubsequences: false).first,
                  !user.isEmpty else { continue }
            return "~" + rest.dropFirst(user.count)
        }
        return path
    }

    /// A workspace row's second line: where it works, and `Worktrees` when its sessions each get one.
    public static func workspaceLine(_ workspace: Agent) -> String {
        let dir = (workspace.workDir?.trimmingCharacters(in: .whitespacesAndNewlines))
            .flatMap { $0.isEmpty ? nil : tildePath($0) }
        let worktrees = workspace.enableWorktree == true ? RunnerPageCopy.RUNNER_WORKSPACE_WORKTREES : nil
        return [dir, worktrees].compactMap { $0 }.joined(separator: RunnerPageCopy.RUNNER_LINE_SEPARATOR)
    }

    /// How many of a workspace's sessions are running (GET /sessions/counts), compared by the id
    /// itself — a count and a workspace row can spell one id two ways.
    public static func runningCount(_ workspace: Agent, counts: [WorkspaceSessionCounts]) -> Int {
        let key = PublicID.storageKey(workspace.id)
        return counts.first { PublicID.storageKey($0.workspaceId) == key }?.running ?? 0
    }

    // MARK: About This Runner

    /// Whether a newer release than this runner's own is out — the case About This Runner's Update
    /// Runner Now is there for. False when either version isn't known, so nothing is offered on a guess.
    /// Never for the account's managed runner: Orbit rolls its image, so there is no release for it to catch up with.
    public static func isBehindLatest(_ runner: Runner, latest: String?, managed: Bool? = nil) -> Bool {
        if managed ?? isManaged(runner) { return false }
        guard let version = runner.version?.trimmingCharacters(in: .whitespacesAndNewlines), !version.isEmpty,
              let latest = latest?.trimmingCharacters(in: .whitespacesAndNewlines), !latest.isEmpty else {
            return false
        }
        return RunnerAttention.compareRunnerVersions(version, latest) < 0
    }

    /// `0.1.197 · Latest`; a runner that is behind and installs the release itself says so
    /// (`0.1.194 · 0.1.197 installs when no turn is running`), and so does one a staged rollout holds
    /// back (`0.1.194 · 0.1.197 not rolled out to it yet`). One that can't update itself is Needs
    /// Attention's to say, and here is just its version. A runner that reports where its updates stand
    /// says which it is; an older one is judged by `runsAsRoot`, as before.
    ///
    /// The account's managed runner (Orbit Cloud) says only that Orbit updates it: its release with that
    /// note, or the build it runs (`Build 95884b1 · Nov 16`) for an image that reports no release — never
    /// `managed-<sha>`, and "Kept up to date by Orbit" only when no build is known.
    public static func versionValue(_ runner: Runner, latest: String?, managed: Bool? = nil) -> String? {
        if managed ?? isManaged(runner) {
            guard let version = runner.version?.trimmingCharacters(in: .whitespacesAndNewlines),
                  RunnerAttention.isReleaseVersion(version) else {
                return RunnerAttention.runnerVersionLine(runner.version, managed: true)
            }
            return version + RunnerPageCopy.RUNNER_LINE_SEPARATOR + RunnerPageCopy.MANAGED_RUNNER_UPDATED_BY_ORBIT
        }
        guard let version = runner.version?.trimmingCharacters(in: .whitespacesAndNewlines), !version.isEmpty else {
            return nil
        }
        guard let latest = latest?.trimmingCharacters(in: .whitespacesAndNewlines), !latest.isEmpty else {
            return version
        }
        if !isBehindLatest(runner, latest: latest, managed: false) {
            return version + RunnerPageCopy.RUNNER_LINE_SEPARATOR + RunnerPageCopy.RUNNER_VERSION_LATEST
        }
        // Draining or restarting for a release: `0.1.253 · updating to 0.1.254`.
        if let target = runner.selfUpdate?.targetVersion,
           runner.selfUpdate?.phase == "draining" || runner.selfUpdate?.phase == "restarting" {
            return version + RunnerPageCopy.RUNNER_LINE_SEPARATOR + RunnerPageCopy.runnerVersionUpdatingTo(version: target)
        }
        let note: String?
        let quiet = runner.selfUpdate?.quietWindowSeconds.flatMap { $0 > 0 ? $0 : nil }
        switch runner.selfUpdate?.state {
        case nil: note = runner.runsAsRoot == true ? RunnerPageCopy.RUNNER_VERSION_INSTALLS_WHEN_IDLE : nil
        case "enabled"?, "waitingForIdle"?:
            note = quiet.map { RunnerPageCopy.runnerVersionInstallsWhenQuiet(minutes: quietMinutes(seconds: $0)) }
                ?? RunnerPageCopy.RUNNER_VERSION_INSTALLS_WHEN_IDLE
        case "heldByRollout"?: note = RunnerPageCopy.RUNNER_VERSION_NOT_ROLLED_OUT
        default: note = nil
        }
        guard let note else { return version }
        return version + RunnerPageCopy.RUNNER_LINE_SEPARATOR + latest + " " + note
    }

    // MARK: the Update card (board 4)

    /// A release this runner is behind, in the phase it reports — the web's `runnerUpdateCard`.
    public struct UpdateCard: Equatable, Sendable {
        /// The runner's phase, or `updated`: no release waiting, and one installed within the last day.
        public let phase: String
        /// Amber while it holds work back or restarts; plain while work goes on as usual.
        public let warn: Bool
        public let title: String
        public let tag: String
        /// Empty on an Updated card whose runner measured nothing about the restart: no body is drawn.
        public let body: String
        /// Draining only: `Waiting for 2 of 8 turns · 38 min`, and the share of those turns done.
        public let progressLabel: String?
        public let progress: Double?
        /// Draining only: the reader's turns it waits for — session, title, `running 1 h 52 min`.
        public var turns: [Turn] = []

        public struct Turn: Equatable, Sendable {
            public let id: String
            public let title: String
            public let running: String?
        }
    }

    /// A runner's quiet window (`selfUpdate.quietWindowSeconds`) in whole minutes, at least one — the web's
    /// `runnerQuietMinutes`.
    public static func quietMinutes(seconds: Int) -> Int { max(1, Int((Double(seconds) / 60).rounded())) }

    private static func availableBodyQuiet(seconds: Int) -> String {
        let minutes = quietMinutes(seconds: seconds)
        return RunnerPageCopy.runnerUpdateAvailableBodyQuiet(
            minutes: minutes, unit: minutes == 1 ? RunnerPageCopy.RUNNER_UNIT_MINUTE : RunnerPageCopy.RUNNER_UNIT_MINUTES)
    }

    /// The card a runner's report calls for; nil with no phase (nothing waiting, or a runner too old
    /// to say) or no version to name, and for a phase this client does not know.
    public static func updateCard(_ runner: Runner, now: Date, timeZone: TimeZone = .current) -> UpdateCard? {
        guard let report = runner.selfUpdate else { return nil }
        guard let phase = report.phase else { return updatedCard(report, now: now, timeZone: timeZone) }
        guard let version = report.targetVersion else { return nil }
        switch phase {
        case "available":
            return UpdateCard(phase: phase, warn: false,
                              title: RunnerPageCopy.runnerUpdateAvailableTitle(version: version),
                              tag: RunnerPageCopy.RUNNER_UPDATE_TAG_AVAILABLE,
                              // A runner that reports its quiet window waits for it; one that doesn't keeps the old wording.
                              body: report.quietWindowSeconds.flatMap { $0 > 0 ? availableBodyQuiet(seconds: $0) : nil }
                                  ?? RunnerPageCopy.RUNNER_UPDATE_AVAILABLE_BODY,
                              progressLabel: nil, progress: nil)
        case "draining":
            let left = report.turnsInFlight ?? 0
            let of = report.turnsAtDrain.map { max($0, left) }
            let waited = report.drainingSince.flatMap { RelativeTime.parse($0) }.map {
                updateWaited(minutes: max(0, Int(now.timeIntervalSince($0) / 60)))
            }
            let unit = (of ?? left) == 1 ? RunnerPageCopy.RUNNER_UPDATE_TURN : RunnerPageCopy.RUNNER_UPDATE_TURNS
            let count = of.map { RunnerPageCopy.runnerUpdateWaitingForOf(left: left, of: $0, unit: unit) }
                ?? RunnerPageCopy.runnerUpdateWaitingFor(left: left, unit: unit)
            let since = report.availableSince.flatMap { updateClock($0, timeZone: timeZone) }
            return UpdateCard(
                phase: phase, warn: true,
                title: RunnerPageCopy.runnerUpdateDrainingTitle(version: version),
                tag: RunnerPageCopy.RUNNER_UPDATE_TAG_DRAINING,
                body: since.map { RunnerPageCopy.runnerUpdateDrainingBody(version: version, since: $0) }
                    ?? RunnerPageCopy.RUNNER_UPDATE_DRAINING_BODY_NO_SINCE,
                progressLabel: waited.map { count + RunnerPageCopy.RUNNER_LINE_SEPARATOR + $0 } ?? count,
                progress: of.map { $0 > 0 ? Double($0 - left) / Double($0) : 0 } ?? 0,
                turns: updateTurns(runner, now: now))
        case "restarting":
            // After the owner's Update Now, the turns it interrupted continue once it is back.
            let interrupted = report.interruptedTurns ?? 0
            return UpdateCard(phase: phase, warn: true,
                              title: RunnerPageCopy.runnerUpdateRestartingTitle(version: version),
                              tag: RunnerPageCopy.RUNNER_UPDATE_TAG_RESTARTING,
                              body: interrupted > 0 ? RunnerPageCopy.runnerUpdateRestartingBodyInterrupted(turns: interrupted)
                                  : RunnerPageCopy.RUNNER_UPDATE_RESTARTING_BODY,
                              progressLabel: nil, progress: nil)
        case "postponed":
            guard let until = report.postponedUntil.flatMap({ updateClock($0, timeZone: timeZone) }) else { return nil }
            return UpdateCard(phase: phase, warn: false,
                              title: RunnerPageCopy.runnerUpdatePostponedTitle(version: version, until: until),
                              tag: RunnerPageCopy.RUNNER_UPDATE_TAG_POSTPONED,
                              body: RunnerPageCopy.runnerUpdatePostponedBody(until: until),
                              progressLabel: nil, progress: nil)
        default:
            return nil
        }
    }

    /// The Updated card (board 4): the last update, for a day after it was installed — how long the
    /// restart took and how many turns an Update Now interrupted for it, as far as the runner measured
    /// them (the web's `updatedCard`). Its body is empty when the runner measured neither. Nil with no
    /// update recorded, or an older one.
    static func updatedCard(_ report: RunnerSelfUpdate, now: Date, timeZone: TimeZone) -> UpdateCard? {
        guard let to = report.lastUpdatedTo, let iso = report.lastUpdatedAt, let at = RelativeTime.parse(iso),
              let tag = updateClock(iso, timeZone: timeZone) else { return nil }
        let age = now.timeIntervalSince(at)
        guard age <= Double(RunnerPageCopy.RUNNER_UPDATE_TAG_UPDATED_HOURS) * 3600, age >= -60 else { return nil }
        let took = report.lastUpdateSeconds.flatMap { $0 > 0 ? RunnerPageCopy.runnerUpdateTook(seconds: $0) : nil }
        return UpdateCard(phase: "updated", warn: false,
                          title: RunnerPageCopy.runnerUpdateUpdatedTitle(version: to), tag: tag,
                          body: RunnerPageCopy.runnerUpdateUpdatedBody(
                              took: took, interruptedTurns: report.lastUpdateInterruptedTurns ?? 0),
                          progressLabel: nil, progress: nil)
    }

    /// The reader's turns on the runner (`updateTurns`, longest running first): each one's session, its
    /// title (`Untitled session` with none) and `running 1 h 52 min`. The draining card lists them, and
    /// Update Now… names them as the turns it interrupts.
    public static func updateTurns(_ runner: Runner, now: Date) -> [UpdateCard.Turn] {
        (runner.updateTurns ?? []).map { turn in
            let title = turn.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return UpdateCard.Turn(
                id: turn.id,
                title: title.isEmpty ? RunnerPageCopy.RUNNER_UPDATE_UNTITLED_TURN : title,
                running: turn.startedAt.flatMap { RelativeTime.parse($0) }.map {
                    RunnerPageCopy.runnerUpdateTurnRunning(
                        duration: updateWaited(minutes: max(0, Int(now.timeIntervalSince($0) / 60))))
                })
        }
    }

    /// How long it has waited: `38 min`, `1 h 52 min`, `2 h`.
    public static func updateWaited(minutes: Int) -> String {
        if minutes < 60 { return RunnerPageCopy.runnerUpdateWaitedMinutes(minutes: minutes) }
        let hours = minutes / 60, rest = minutes % 60
        return rest > 0 ? RunnerPageCopy.runnerUpdateWaitedHoursMinutes(hours: hours, minutes: rest)
            : RunnerPageCopy.runnerUpdateWaitedHours(hours: hours)
    }

    /// The clock time the card names, as the board writes it: `09:58`.
    public static func updateClock(_ iso: String, timeZone: TimeZone = .current) -> String? {
        RelativeTime.parse(iso).map { formatter("HH:mm", timeZone).string(from: $0) }
    }

    /// `Sep 20, 4:00 PM · 0.1.189 → 0.1.190`: when the runner last updated itself, in the reader's time
    /// zone, and between which versions. Nil for a runner that doesn't report its updates, and for one
    /// that hasn't updated itself yet.
    public static func lastUpdate(_ runner: Runner, timeZone: TimeZone = .current) -> String? {
        guard let report = runner.selfUpdate else { return nil }
        let versions: String?
        if let from = report.lastUpdatedFrom, let to = report.lastUpdatedTo {
            versions = RunnerPageCopy.runnerUpdatedFromTo(from: from, to: to)
        } else {
            versions = report.lastUpdatedTo
        }
        let parts = [report.lastUpdatedAt.flatMap { lastSeen($0, timeZone: timeZone) }, versions].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: RunnerPageCopy.RUNNER_LINE_SEPARATOR)
    }

    public static func runsAsValue(_ runner: Runner) -> String? {
        switch runner.runsAsRoot {
        case true?: return RunnerPageCopy.RUNNER_RUNS_AS_ROOT
        case false?: return RunnerPageCopy.RUNNER_RUNS_AS_REGULAR_USER
        case nil: return nil
        }
    }

    /// `Just now`, `5m ago`.
    public static func lastCheckIn(_ runner: Runner, now: Date) -> String? {
        guard let seen = runner.lastHeartbeatAt, !seen.isEmpty else { return nil }
        let ago = RunnerAttention.ago(seen, nowMs: nowMs(now))
        return ago.prefix(1).uppercased() + ago.dropFirst()
    }

    /// `Jun 18`.
    public static func registered(_ runner: Runner, now: Date, timeZone: TimeZone = .current) -> String? {
        runner.enrolledAt.flatMap { day($0, now: now, timeZone: timeZone) }
    }

    // MARK: times, in the reader's time zone

    /// The page's words are English, so its dates are too, whatever language the device is in.
    private static func formatter(_ format: String, _ timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = format
        return formatter
    }

    private static func sameDay(_ a: Date, _ b: Date, _ timeZone: TimeZone) -> Bool {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.isDate(a, inSameDayAs: b)
    }

    private static func sameYear(_ a: Date, _ b: Date, _ timeZone: TimeZone) -> Bool {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.component(.year, from: a) == calendar.component(.year, from: b)
    }

    /// When a quota window resets: `10:59 AM` today, `Thu, Oct 2 at 11:59 AM` on another day.
    public static func resetsWhen(_ iso: String, now: Date, timeZone: TimeZone = .current) -> String? {
        guard let at = RelativeTime.parse(iso) else { return nil }
        let time = formatter("h:mm a", timeZone).string(from: at)
        if sameDay(at, now, timeZone) { return time }
        return formatter("EEE, MMM d", timeZone).string(from: at) + " at " + time
    }

    /// Under a quota window's gauge: `Resets 10:59 AM`.
    public static func resetsLine(_ row: PlanUsageRow, now: Date, timeZone: TimeZone = .current) -> String? {
        row.window.resetsAt.flatMap { resetsWhen($0, now: now, timeZone: timeZone) }.map { "Resets \($0)" }
    }

    /// When an offline runner last checked in: `Sep 14, 10:25 PM`.
    public static func lastSeen(_ iso: String, timeZone: TimeZone = .current) -> String? {
        RelativeTime.parse(iso).map { formatter("MMM d, h:mm a", timeZone).string(from: $0) }
    }

    /// A day: `Sep 13`, with its year when it isn't this one.
    public static func day(_ iso: String, now: Date, timeZone: TimeZone = .current) -> String? {
        guard let at = RelativeTime.parse(iso) else { return nil }
        return formatter(sameYear(at, now, timeZone) ? "MMM d" : "MMM d, yyyy", timeZone).string(from: at)
    }

    // MARK: Add Runner

    /// The instance's origin, which install.sh and the runner binaries are served from and baked to.
    public static func origin(_ baseURL: URL) -> String {
        guard let components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let scheme = components.scheme, let host = components.host else {
            var text = baseURL.absoluteString
            while text.hasSuffix("/") { text.removeLast() }
            return text
        }
        return "\(scheme)://\(host)" + (components.port.map { ":\($0)" } ?? "")
    }

    /// The machine a new runner is installed on.
    public enum Platform: String, CaseIterable, Identifiable, Sendable {
        case macOS
        case linux
        case windows

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .macOS: return RunnerPageCopy.RUNNER_PLATFORM_MACOS
            case .linux: return RunnerPageCopy.RUNNER_PLATFORM_LINUX
            case .windows: return RunnerPageCopy.RUNNER_PLATFORM_WINDOWS
            }
        }
    }

    /// The one command that installs a runner and registers it (web `RunnerRegisterGuide`).
    public static func installCommand(_ platform: Platform, origin: String) -> String {
        platform == .windows
            ? RunnerPageCopy.runnerInstallCommandWindows(origin: origin)
            : RunnerPageCopy.runnerInstallCommandUnix(origin: origin)
    }

    /// The runners online right now — what Add Runner's wait is measured against.
    public static func onlineIDs(_ runners: [Runner]) -> Set<String> {
        Set(runners.filter { $0.online == true }.map(\.id))
    }

    /// The first runner online now that wasn't when the wait began (web `RunnerRegisterGuide`: there
    /// is no push for a runner coming online, so the list is read until one does).
    public static func newlyOnline(_ runners: [Runner], baseline: Set<String>) -> Runner? {
        runners.first { $0.online == true && !baseline.contains($0.id) }
    }

    /// The code `orbit register` printed, as the server spells it — `ABCDE-FGH23`, upper case — once
    /// all ten characters are in, whether or not the dash was typed. Nil until then.
    public static func deviceCode(_ typed: String) -> String? {
        let characters = typed.uppercased().filter { $0.isLetter || $0.isNumber }
        guard characters.count == 10, characters.allSatisfy({ $0.isASCII }) else { return nil }
        return "\(characters.prefix(5))-\(characters.suffix(5))"
    }

    /// The notice under a request whose name a runner of this account already has, as the web's
    /// /enroll page words it: when that runner was last online, if the server says, then what
    /// re-registering does.
    public static func deviceNameTakenDetail(_ device: DeviceInfo, now: Date) -> String {
        guard let seen = device.existingLastSeenAt, !seen.isEmpty else {
            return RunnerPageCopy.RUNNER_DEVICE_NAME_TAKEN_DETAIL
        }
        let lastOnline = RunnerPageCopy.runnerDeviceLastOnline(when: RunnerAttention.ago(seen, nowMs: nowMs(now)))
        return "\(lastOnline) \(RunnerPageCopy.RUNNER_DEVICE_NAME_TAKEN_DETAIL)"
    }
}
