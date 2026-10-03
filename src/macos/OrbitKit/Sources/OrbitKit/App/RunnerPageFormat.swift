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
    /// `ENGINE_CLI_NAME`'s — and any the page doesn't know yet after them, as reported.
    public static let engineOrder = ["claude", "codex", "kimi", "opencode", "antigravity"]

    public static func engines(_ runner: Runner) -> [RunnerEngineHealth] {
        let reported = runner.engines ?? []
        let known = engineOrder.compactMap { engine in reported.first { $0.engine == engine } }
        return known + reported.filter { !engineOrder.contains($0.engine) }
    }

    /// The CLI's own product name: `Claude Code`, `Codex`, `Kimi Code`, `OpenCode`,
    /// `Antigravity CLI`.
    public static func engineName(_ engine: String) -> String {
        if let login = LoginEngine(rawValue: engine) { return login.displayName }
        if engine == "antigravity" { return "Antigravity CLI" }
        return engine == "opencode" ? "OpenCode" : engine
    }

    /// The engines Orbit signs in on a runner. OpenCode's sign-in belongs to whichever provider it
    /// runs, and Antigravity has none — it runs on a Gemini API key from its environment — so a
    /// runner page has nothing to say about either.
    public static func loginEngine(_ engine: String) -> LoginEngine? { LoginEngine(rawValue: engine) }

    /// The engines whose CLI keeps a login per directory, so one machine holds several accounts of
    /// them (web `ACCOUNT_ENGINES`).
    public static func keepsAccounts(_ engine: String) -> Bool { engine == "claude" || engine == "codex" }

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
    public static func engineStatus(_ health: RunnerEngineHealth) -> Status? {
        guard health.installed == true else {
            return Status(text: RunnerPageCopy.RUNNER_ENGINE_NOT_INSTALLED, tone: .muted)
        }
        guard loginEngine(health.engine) != nil else { return nil }
        let accounts = health.accounts ?? []
        guard accounts.count >= 2 else { return authStatus(health.auth) }
        if accounts.allSatisfy({ $0.auth == "yes" }) {
            return Status(text: RunnerPageCopy.runnerEngineAccountsSignedIn(count: accounts.count), tone: .ok)
        }
        return accounts.contains { $0.auth == "no" } ? authStatus("no") : nil
    }

    /// Whether the Engines row offers Sign In: an engine Orbit signs in, installed, with a login
    /// signed out.
    public static func needsSignIn(_ health: RunnerEngineHealth) -> Bool {
        guard health.installed == true, loginEngine(health.engine) != nil else { return false }
        return health.auth == "no" || (health.accounts ?? []).contains { $0.auth == "no" }
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

    /// The quota windows an Engines row shows under the engine: Default's, while the engine is signed
    /// in and has one account. With several, each account's quota is its own and lives on the
    /// engine's page (web: a group's own columns stay empty rather than speak for one account).
    public static func engineWindows(_ runner: Runner, engine: String) -> [PlanUsageRow] {
        guard let health = runner.engines?.first(where: { $0.engine == engine }), health.installed == true,
              health.auth == "yes", (health.accounts ?? []).count < 2 else { return [] }
        return accountWindows(runner, engine: engine, account: CodexAccounts.defaultID)
    }

    /// One account's own windows: Default's are the engine snapshot's, another's its entry under
    /// `accounts` (`CodexAccounts.snapshot`, web `codexAccountSnapshot`).
    public static func accountWindows(_ runner: Runner, engine: String, account: String) -> [PlanUsageRow] {
        CodexAccounts.snapshot(runner.planUsage?.snapshot(for: engine), account: account)?.rows ?? []
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
        public let auth: String?
        public var isDefault: Bool { id == CodexAccounts.defaultID }
        /// The line under the name: where its login lives — and, for a Default renamed in Orbit, that
        /// it is still the machine's own login (web's DEFAULT mark).
        public var subtitle: String? {
            guard isDefault, name != "Default" else { return home }
            return [home, "Default"].compactMap { $0 }.joined(separator: " · ")
        }
        /// What a sign-in on this line names: the account, when the runner lists more than one; nil —
        /// the runner's own login, as every sign-in was before accounts — when it doesn't.
        public let signInAccount: String?
    }

    /// Every account an engine is signed into on that runner, Default first. One line for the
    /// runner's own login when it keeps no others.
    public static func accountLines(_ health: RunnerEngineHealth) -> [AccountLine] {
        let accounts = health.accounts ?? []
        guard accounts.count >= 2 else {
            let own = accounts.first
            return [AccountLine(id: CodexAccounts.defaultID,
                                name: CodexAccounts.label(CodexAccounts.defaultID, accounts: accounts),
                                home: (own?.home ?? own?.codexHome).map(tildePath),
                                auth: health.auth, signInAccount: nil)]
        }
        return accounts.map { account in
            AccountLine(id: account.id, name: CodexAccounts.label(account.id, accounts: accounts),
                        home: (account.home ?? account.codexHome).map(tildePath),
                        auth: account.auth, signInAccount: account.id)
        }
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

    /// `0.1.197 · Latest`; a root runner that is behind installs the release itself when no turn is
    /// running, so it says so (`0.1.194 · 0.1.197 installs when no turn is running`). One that can't
    /// update itself is Needs Attention's to say, and here is just its version.
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
        guard runner.runsAsRoot == true else { return version }
        return version + RunnerPageCopy.RUNNER_LINE_SEPARATOR + latest + " "
            + RunnerPageCopy.RUNNER_VERSION_INSTALLS_WHEN_IDLE
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
}
