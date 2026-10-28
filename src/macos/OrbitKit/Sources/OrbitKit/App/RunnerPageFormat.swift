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

    /// The status dot: green online, amber while it drains, grey offline.
    public enum Presence: Equatable, Sendable {
        case online
        case draining
        case offline
    }

    public static func isOffline(_ runner: Runner, now: Date) -> Bool {
        RunnerAttention.runnerIsOffline(runner, nowMs: nowMs(now))
    }

    public static func presence(_ runner: Runner, now: Date) -> Presence {
        if isOffline(runner, now: now) { return .offline }
        return runner.status == .draining ? .draining : .online
    }

    /// The name the list and the page head show: the alias, else the machine's own name.
    public static func displayName(_ runner: Runner) -> String {
        let alias = runner.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return alias.isEmpty ? runner.name : alias
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
    public static func hostLine(_ runner: Runner) -> String {
        let shown = displayName(runner)
        let host = (runner.hostname?.trimmingCharacters(in: .whitespacesAndNewlines))
            .flatMap { $0.isEmpty || $0 == shown ? nil : $0 }
        let version = (runner.version?.trimmingCharacters(in: .whitespacesAndNewlines))
            .flatMap { $0.isEmpty ? nil : RunnerPageCopy.runnerVersionTag(version: $0) }
        return [host, version].compactMap { $0 }.joined(separator: RunnerPageCopy.RUNNER_LINE_SEPARATOR)
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
        return showsCursor(runner, fleet: fleet) ? CursorRuntime.machineEnginesFooter : RunnerPageCopy.RUNNER_ENGINES_FOOTER
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

    /// One login's answer: only the CLI's own yes is signed in, and a CLI that wouldn't say is not
    /// shown as either.
    public static func authStatus(_ auth: String?) -> Status? {
        switch auth {
        case "yes": return Status(text: RunnerPageCopy.RUNNER_ENGINE_SIGNED_IN, tone: .ok)
        case "no": return Status(text: RunnerPageCopy.RUNNER_ENGINE_SIGNED_OUT, tone: .warn)
        default: return nil
        }
    }

    /// Where an engine's sign-ins stand, after its version on the Engines row. An engine with several
    /// accounts is signed in only when every one of them is (web `signedIn`): a row that called the
    /// machine signed in over a signed-out account would hide the one thing it is there to say.
    public static func engineStatus(_ health: RunnerEngineHealth, runner: Runner? = nil) -> Status? {
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
        return auths.contains("no") ? authStatus("no") : nil
    }

    /// Which of Kimi's two sites its login is on, said after the version on its Engines row (web's
    /// `2.1.1 · kimi.ai`): the same CLI signs in to either, and a session spends that site's
    /// subscription. Nil for every other engine, before Kimi's first sign-in — and with several
    /// accounts, which can be on different sites: each says its own on the engine page.
    public static func engineSite(_ health: RunnerEngineHealth) -> String? {
        guard (health.accounts ?? []).count < 2 else { return nil }
        return KimiSite.current(of: health)?.domain
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
        if engine == CursorRuntime.engine { return !CursorRuntime.state(of: runner).blocks }
        return engine != "antigravity" || antigravityCanSignIn(runner)
    }

    /// Whether the engine page offers Add Account: an engine that keeps accounts — for Antigravity, on
    /// a runner that relays its Google sign-in and keeps the account it signs in apart from Default's
    /// (`antigravity-account-login/v1`), and for Kimi on one that signs the account it adds into a
    /// KIMI_CODE_HOME of its own (`kimi-account-login/v1`); an older one would sign Default in again in
    /// its place.
    public static func canAddAccount(_ runner: Runner, engine: String) -> Bool {
        guard keepsAccounts(engine) else { return false }
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
    /// is the engine page's footnote, not the row's.
    public static func updateFailedLine(_ health: RunnerEngineHealth, now: Date,
                                        timeZone: TimeZone = .current) -> String? {
        guard health.installed == true, let update = health.update, update.status == "failed",
              let latest = update.latest?.trimmingCharacters(in: .whitespacesAndNewlines), !latest.isEmpty,
              RunnerAttention.updateNoteOf(update, nowMs: nowMs(now))?.tone == .warn,
              let at = update.at, let when = day(at, now: now, timeZone: timeZone) else { return nil }
        return RunnerPageCopy.runnerEngineUpdateFailed(version: latest, when: when)
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
        guard let health = runner.engines?.first(where: { $0.engine == engine }), health.installed == true else {
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
        guard let health = runner.engines?.first(where: { $0.engine == engine }) else { return false }
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
    /// own words. Nil when the last removal was another account's.
    public struct AccountRemoval: Equatable, Sendable {
        public let pending: Bool
        public let refused: String?
    }

    public static func removal(_ state: RunnerAccountRemoveState?, engine: String,
                               account: String) -> AccountRemoval? {
        guard let state, state.engine == engine, state.account == account else { return nil }
        return AccountRemoval(pending: state.status == "pending",
                              refused: state.status == "failed" ? state.message : nil)
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

    /// The question in front of an account's Remove, and what removing it comes to.
    public struct RemovalQuestion: Equatable, Sendable {
        public let title: String
        public let message: String
    }

    /// Default's says Orbit stops using it there while the machine keeps its sign-in and the CLI in a
    /// terminal keeps working (the web's words, `RunnerAccountCopy`). An added account's sign-in goes from
    /// the machine: while Default is removed from Orbit its workspaces go to Automatic, or — for the last
    /// account Orbit uses there — to Default, by its name, which Orbit then uses again (the web's words
    /// too), never to a Default as though it were in use; while Default is, the page's own question,
    /// which says Default is untouched.
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
        let place = line.home ?? "Its sign-in"
        return RemovalQuestion(title: "Remove “\(line.name)” from \(machine)?",
                               message: "\(place) goes from this machine, and sessions stop running on it. "
                                   + "Default is untouched.")
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

    /// Where the last Update Engines Now got to, in the web engine section's words.
    public static func updateRelayLine(_ install: RunnerInstallState?) -> String? {
        guard let install, install.mode == "update", let status = install.status else { return nil }
        switch status {
        case "pending": return "Queued — the runner picks this up on its next check-in."
        case "installing": return "Updating this machine’s engine CLIs…"
        case "done", "failed":
            let message = install.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return message.isEmpty ? "Nothing to update." : message
        default: return nil
        }
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

    /// `0.1.197 · Latest`; a runner that is behind and installs the release itself says so
    /// (`0.1.194 · 0.1.197 installs when no turn is running`), and so does one a staged rollout holds
    /// back (`0.1.194 · 0.1.197 not rolled out to it yet`). One that can't update itself is Needs
    /// Attention's to say, and here is just its version. A runner that reports where its updates stand
    /// says which it is; an older one is judged by `runsAsRoot`, as before.
    public static func versionValue(_ runner: Runner, latest: String?) -> String? {
        guard let version = runner.version?.trimmingCharacters(in: .whitespacesAndNewlines), !version.isEmpty else {
            return nil
        }
        guard let latest = latest?.trimmingCharacters(in: .whitespacesAndNewlines), !latest.isEmpty else {
            return version
        }
        if RunnerAttention.compareRunnerVersions(version, latest) >= 0 {
            return version + RunnerPageCopy.RUNNER_LINE_SEPARATOR + RunnerPageCopy.RUNNER_VERSION_LATEST
        }
        let note: String?
        switch runner.selfUpdate?.state {
        case nil: note = runner.runsAsRoot == true ? RunnerPageCopy.RUNNER_VERSION_INSTALLS_WHEN_IDLE : nil
        case "enabled"?, "waitingForIdle"?: note = RunnerPageCopy.RUNNER_VERSION_INSTALLS_WHEN_IDLE
        case "heldByRollout"?: note = RunnerPageCopy.RUNNER_VERSION_NOT_ROLLED_OUT
        default: note = nil
        }
        guard let note else { return version }
        return version + RunnerPageCopy.RUNNER_LINE_SEPARATOR + latest + " " + note
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
