import Foundation

/// Does this machine need me? — a port of the web's `src/web/src/lib/runnerAttention.ts`, the rule
/// behind the Runners list's third line, a runner page's Needs Attention cards and the web card,
/// which all say the same sentence about the same machine. An offline runner's row has no third
/// line: its second line already says it is offline, and offline is a state, not a fault.
///
/// That file and `runnerAttention.cases.json` beside it are the one source of the rule:
/// `RunnerAttentionCasesTests` runs the same case file against this port, so a change to what is
/// said, or when, starts in the case file. The words are `RunnerPageCopy`, held to the web's
/// `runnerCopy.ts` by `RunnerPageCopyParityTests`.
///
/// An item is raised only when something depends on it: an engine's signed-out login or its nearly
/// spent quota is news only if a workspace on this machine last ran on that built-in engine. An
/// offline runner keeps only what is still true and still actionable — that it is offline, and
/// that it cannot replace its own binary.
///
/// Pure: the clock (`nowMs`) and the latest release are inputs, and nothing here fetches. Times a
/// reader sees in their own time zone (a quota reset, when it was last seen) ride in `params` as
/// ISO strings for the client to format.

/// A runner as GET /runners reports it — the fields these rules read (the web's `AttentionRunner`).
/// Decodable because the case file writes its runners in this shape, without the database identity
/// a `Runner` requires.
public struct RunnerAttentionRunner: Decodable, Equatable, Sendable {
    public let name: String
    public let displayName: String?
    public let hostname: String?
    public let version: String?
    public let online: Bool?
    public let lastHeartbeatAt: String?
    public let activeSessions: Int?
    public let runsAsRoot: Bool?
    public let minFreeDiskMb: Int?
    public let engines: [RunnerEngineHealth]?
    public let planUsage: PlanUsage?

    public init(_ runner: Runner) {
        name = runner.name
        displayName = runner.displayName
        hostname = runner.hostname
        version = runner.version
        online = runner.online
        lastHeartbeatAt = runner.lastHeartbeatAt
        activeSessions = runner.activeSessions
        runsAsRoot = runner.runsAsRoot
        minFreeDiskMb = runner.minFreeDiskMb
        engines = runner.engines
        planUsage = runner.planUsage
    }
}

/// One of that runner's workspaces as GET /workspaces reports it (the web's `AttentionWorkspace`).
public struct RunnerAttentionWorkspace: Decodable, Equatable, Sendable {
    public let id: String
    public let name: String
    /// The provider its last interactive session ran on: a built-in engine or a configured provider.
    public let lastProvider: String?
    public let workDir: String?
    /// BIGINT columns, which the API sends as strings; numbers are read too.
    public let workDirFreeBytes: Int64?
    public let workDirTotalBytes: Int64?
    public let repoHealth: RunnerRepoHealth?

    public init(_ workspace: Agent) {
        id = workspace.id
        name = workspace.name
        lastProvider = workspace.lastProvider
        workDir = workspace.workDir
        workDirFreeBytes = workspace.workDirFreeBytes
        workDirTotalBytes = workspace.workDirTotalBytes
        repoHealth = workspace.repoHealth
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, lastProvider, workDir, workDirFreeBytes, workDirTotalBytes, repoHealth
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        lastProvider = try c.decodeIfPresent(String.self, forKey: .lastProvider)
        workDir = try c.decodeIfPresent(String.self, forKey: .workDir)
        workDirFreeBytes = c.flexibleInt64(forKey: .workDirFreeBytes)
        workDirTotalBytes = c.flexibleInt64(forKey: .workDirTotalBytes)
        repoHealth = try c.decodeIfPresent(RunnerRepoHealth.self, forKey: .repoHealth)
    }
}

public struct RunnerAttentionInput: Decodable, Equatable, Sendable {
    public let runner: RunnerAttentionRunner
    public let workspaces: [RunnerAttentionWorkspace]
    public let nowMs: Int64
    /// `RunnerAttention.latestRunnerVersion`'s answer; nil when nothing says what the latest is.
    public let latestVersion: String?

    public init(runner: Runner, workspaces: [Agent], nowMs: Int64, latestVersion: String?) {
        self.runner = RunnerAttentionRunner(runner)
        self.workspaces = workspaces.map(RunnerAttentionWorkspace.init)
        self.nowMs = nowMs
        self.latestVersion = latestVersion
    }
}

/// Most severe first — the order items come out in.
public enum RunnerAttentionKind: String, Codable, Equatable, Sendable {
    case offline
    case engineSignedOut
    case checkoutStuck
    case quotaNearLimit
    case diskLow
    case cannotSelfUpdate
    case engineNotUpdating
}

public enum RunnerAttentionTone: String, Codable, Equatable, Sendable {
    case bad
    case warn
    case idle
}

public enum RunnerAttentionActionKind: String, Codable, Equatable, Sendable {
    case signIn
    case repair
    case setReserve
    case copyCommand
    case updateEngines
}

public struct RunnerAttentionAction: Equatable, Sendable {
    public let kind: RunnerAttentionActionKind
    public let engine: String?
    /// repair: POST /workspaces/:id/repo-cleanup for any workspace in the stuck checkout.
    public let workspaceId: String?
    /// copyCommand: what goes on the clipboard.
    public let command: String?
}

public struct RunnerAttentionItem: Equatable, Sendable {
    public let kind: RunnerAttentionKind
    public let tone: RunnerAttentionTone
    /// The list's third line (two at most, joined) — and the web card's.
    public let short: String
    public let title: String
    public let detail: String
    public let action: RunnerAttentionAction?
    /// The facts the sentence was made from, for the client to format or act on. ISO times:
    /// offline `lastSeenAt`, quota `resetsAt`.
    public let params: [String: JSONValue]
}

public struct RunnerDisk: Codable, Equatable, Sendable {
    public let freeBytes: Int64
    public let totalBytes: Int64
    /// Rounded to a whole percent.
    public let usedPercent: Int
}

public struct RunnerKeepFreeTier: Equatable, Sendable {
    public let mb: Int?
    public let label: String
}

/// runnerEngines.ts `updateNoteOf`'s answer: a quiet footnote, or a warning only a person can act on.
public struct RunnerEngineUpdateNote: Equatable, Sendable {
    public enum Tone: String, Equatable, Sendable { case quiet, warn }
    public let tone: Tone
    public let text: String
}

public enum RunnerAttention {
    /// A runner heartbeats every 30s; three missed beats is offline (the server's own window).
    public static let RUNNER_OFFLINE_AFTER_MS: Int64 = 90_000

    /// Keep Free's choices: what PATCH /runners/:id sends as minFreeDiskMb, and what the picker says.
    public static let KEEP_FREE_TIERS: [RunnerKeepFreeTier] = [
        RunnerKeepFreeTier(mb: nil, label: RunnerPageCopy.RUNNER_KEEP_FREE_OFF),
        RunnerKeepFreeTier(mb: 10_240, label: RunnerPageCopy.RUNNER_KEEP_FREE_10_GB),
        RunnerKeepFreeTier(mb: 20_480, label: RunnerPageCopy.RUNNER_KEEP_FREE_20_GB),
        RunnerKeepFreeTier(mb: 51_200, label: RunnerPageCopy.RUNNER_KEEP_FREE_50_GB),
    ]

    private static let minute: Int64 = 60_000
    private static let hour = 60 * minute
    private static let day = 24 * hour
    private static let mib: Int64 = 1_024 * 1_024
    private static let gib = 1_024 * mib
    /// How long an engine may go without a successful update before that becomes the row's problem.
    private static let staleUpdateMs = 7 * day

    /// Every engine a runner reports on, in the order its page lists them, with the CLI's own name
    /// (runnerEngines.ts `ENGINE_CLI_NAME`).
    private static let reportedEngines: [(engine: String, cliName: String)] = [
        ("claude", LoginEngine.claude.displayName),
        ("codex", LoginEngine.codex.displayName),
        ("kimi", LoginEngine.kimi.displayName),
        ("opencode", "OpenCode"),
        ("antigravity", "Antigravity CLI"),
    ]

    /// The login a built-in engine runs on, as a sign-in or a quota sentence names it.
    private static func loginName(_ engine: LoginEngine) -> String {
        switch engine {
        case .claude: return RunnerPageCopy.RUNNER_LOGIN_CLAUDE
        case .codex: return RunnerPageCopy.RUNNER_LOGIN_CODEX
        case .kimi: return RunnerPageCopy.RUNNER_LOGIN_KIMI
        case .antigravity: return "Antigravity"
        }
    }

    /// The RunnerRepoHealth states that block every merge into the checkout, and what it is stuck
    /// in. `dirty` is not one: a stray edit still lets merges fast-forward around it.
    private static let stuckIn: [String: String] = [
        "unmerged": RunnerPageCopy.RUNNER_GIT_CONFLICT,
        "merge": RunnerPageCopy.RUNNER_GIT_MERGE,
        "rebase": RunnerPageCopy.RUNNER_GIT_REBASE,
        "cherry-pick": RunnerPageCopy.RUNNER_GIT_CHERRY_PICK,
        "revert": RunnerPageCopy.RUNNER_GIT_REVERT,
    ]

    /// Claude's windows by `PlanUsageRow.key`.
    private static let claudeWindows: [String: String] = [
        "fiveHour": RunnerPageCopy.RUNNER_QUOTA_FIVE_HOUR,
        "sevenDay": RunnerPageCopy.RUNNER_QUOTA_WEEKLY,
        "sevenDayOpus": RunnerPageCopy.RUNNER_QUOTA_WEEKLY_OPUS,
        "sevenDaySonnet": RunnerPageCopy.RUNNER_QUOTA_WEEKLY_SONNET,
    ]

    /// Codex-shaped windows by the label `PlanUsageSnapshot.rows` derives from their length (a
    /// bucket other than Codex's own puts its name in front, hence the suffix match).
    private static let codexWindows: [(label: String, window: String)] = [
        ("5h limit", RunnerPageCopy.RUNNER_QUOTA_FIVE_HOUR),
        ("Daily limit", RunnerPageCopy.RUNNER_QUOTA_DAILY),
        ("Weekly limit", RunnerPageCopy.RUNNER_QUOTA_WEEKLY),
        ("Monthly limit", RunnerPageCopy.RUNNER_QUOTA_MONTHLY),
        ("Annual limit", RunnerPageCopy.RUNNER_QUOTA_ANNUAL),
    ]

    // MARK: version

    private static func versionParts(_ version: String) -> [Int] {
        var value = version.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.first == "v" || value.first == "V" { value.removeFirst() }
        return value.components(separatedBy: ".").map { part in
            guard !part.isEmpty, part.allSatisfy({ $0.isASCII && $0.isNumber }) else { return 0 }
            return Int(part) ?? 0
        }
    }

    /// Orders runner versions segment by segment as numbers — 0.1.197 is after 0.1.155, and 0.1.100
    /// after 0.1.99 — the way the runner's own updater decides a release is newer (selfupdate.go
    /// isNewer). A segment that isn't a number counts as 0 there too. -1, 0 or 1.
    public static func compareRunnerVersions(_ a: String, _ b: String) -> Int {
        let x = versionParts(a)
        let y = versionParts(b)
        for index in 0..<max(x.count, y.count) {
            let difference = (index < x.count ? x[index] : 0) - (index < y.count ? y[index] : 0)
            if difference != 0 { return difference < 0 ? -1 : 1 }
        }
        return 0
    }

    /// The newest runner release anyone can see: what <origin>/dl/version.json publishes
    /// (`APIClient.runnerReleaseVersion`, nil when it could not be read) or what any of this
    /// account's runners reports running, whichever is newer.
    public static func latestRunnerVersion(_ published: String?, runners: [Runner]) -> String? {
        latestRunnerVersion(published, versions: runners.map(\.version))
    }

    public static func latestRunnerVersion(_ published: String?, versions: [String?]) -> String? {
        var latest: String?
        for candidate in [published] + versions {
            guard let version = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !version.isEmpty else { continue }
            if let current = latest, compareRunnerVersions(version, current) <= 0 { continue }
            latest = version
        }
        return latest
    }

    // MARK: disk

    /// The runner's tightest filesystem. Its workspaces each report the filesystem their workDir
    /// sits on, several usually the same one, so readings are de-duplicated by (free, total) and the
    /// one with the least free space wins: it is the one that fills first. Nil when no workspace
    /// has a reading.
    public static func runnerDisk(_ workspaces: [RunnerAttentionWorkspace]) -> RunnerDisk? {
        var seen = Set<String>()
        var tightest: RunnerDisk?
        for workspace in workspaces {
            guard let free = workspace.workDirFreeBytes, free >= 0,
                  let total = workspace.workDirTotalBytes, total > 0 else { continue }
            guard seen.insert("\(free)/\(total)").inserted else { continue }
            if let tightest, tightest.freeBytes <= free { continue }
            let used = ((Double(total) - Double(free)) / Double(total) * 100).rounded()
            tightest = RunnerDisk(freeBytes: free, totalBytes: total,
                                  usedPercent: min(100, max(0, Int(used))))
        }
        return tightest
    }

    public static func runnerDisk(_ workspaces: [Agent]) -> RunnerDisk? {
        runnerDisk(workspaces.map(RunnerAttentionWorkspace.init))
    }

    /// Bytes in GB the way `df -h` counts them (1024³): whole from 10 GB up, one decimal below.
    public static func formatDiskGb(_ bytes: Int64) -> String {
        let gb = Double(bytes) / Double(gib)
        if gb >= 10 { return String(Int(gb.rounded())) }
        let tenths = Int((gb * 10).rounded())
        if tenths >= 100 { return "10" }
        return "\(tenths / 10).\(tenths % 10)"
    }

    /// What Keep Free shows for a floor: a tier's own name, or a value set elsewhere as it is.
    public static func keepFreeLabel(_ minFreeDiskMb: Int?) -> String {
        let mb = minFreeDiskMb.flatMap { $0 > 0 ? $0 : nil }
        if let tier = KEEP_FREE_TIERS.first(where: { $0.mb == mb }) { return tier.label }
        return RunnerPageCopy.runnerGb(amount: formatDiskGb(Int64(mb ?? 0) * mib))
    }

    // MARK: time and engine updates (runnerEngines.ts)

    /// An ISO time as epoch milliseconds, the way `Date.parse` reads the server's timestamps.
    private static func epochMs(_ iso: String?) -> Int64? {
        guard let iso, let date = RelativeTime.parse(iso) else { return nil }
        return Int64((date.timeIntervalSince1970 * 1_000).rounded())
    }

    /// `just now`, `5m ago`, `3h ago`, `14d ago` — runnerEngines.ts `ago`, not `RelativeTime.ago`.
    public static func ago(_ iso: String, nowMs: Int64) -> String {
        guard let then = epochMs(iso) else { return "just now" }
        let difference = nowMs - then
        if difference < minute { return "just now" }
        if difference < hour { return "\(difference / minute)m ago" }
        if difference < day { return "\(difference / hour)h ago" }
        return "\(difference / day)d ago"
    }

    /// What an engine row says about being kept current. `warn` means this machine has actually
    /// drifted and only a person can say why; everything routine stays `quiet`.
    public static func updateNoteOf(_ update: RunnerEngineUpdate?, nowMs: Int64) -> RunnerEngineUpdateNote? {
        guard let update else { return nil }
        if update.status == "skipped" {
            return RunnerEngineUpdateNote(tone: .quiet, text: "not auto-updated")
        }
        let latest = update.latest.flatMap { $0.isEmpty ? nil : $0 }
        // Drift decides first: it is the one reading taken on the binary itself.
        if let behindSince = epochMs(update.behindSince) {
            let behind = nowMs - behindSince
            if behind > staleUpdateMs {
                let days = max(1, Int(floor(Double(behind) / Double(day))))
                return RunnerEngineUpdateNote(tone: .warn,
                                              text: "\(days)d behind\(latest.map { " \($0)" } ?? "")")
            }
            let text: String
            if update.status == "failed" {
                text = "last update failed · retrying every 30 min"
            } else if let latest {
                text = "updating to \(latest)"
            } else {
                text = "update pending"
            }
            return RunnerEngineUpdateNote(tone: .quiet, text: text)
        }
        let lastOk = epochMs(update.okAt)
        if let lastOk, nowMs - lastOk <= staleUpdateMs {
            if update.status == "failed" {
                return RunnerEngineUpdateNote(tone: .quiet,
                                              text: "last update failed · retrying every 30 min")
            }
            let verb = update.status == "checked" ? "checked" : "updated"
            return RunnerEngineUpdateNote(tone: .quiet, text: "\(verb) \(ago(update.at ?? "", nowMs: nowMs))")
        }
        // Nothing has landed in a week and no drift is being measured.
        guard let lastOk else { return RunnerEngineUpdateNote(tone: .warn, text: "never updated") }
        return RunnerEngineUpdateNote(tone: .warn,
                                      text: "not updated in \(max(1, (nowMs - lastOk) / day))d")
    }

    // MARK: offline

    /// Offline once its heartbeat is more than 90s old, or when the server already says so.
    public static func runnerIsOffline(_ runner: RunnerAttentionRunner, nowMs: Int64) -> Bool {
        if runner.online == false { return true }
        guard let seen = epochMs(runner.lastHeartbeatAt) else { return runner.online != true }
        return nowMs - seen > RUNNER_OFFLINE_AFTER_MS
    }

    public static func runnerIsOffline(_ runner: Runner, nowMs: Int64) -> Bool {
        runnerIsOffline(RunnerAttentionRunner(runner), nowMs: nowMs)
    }

    private static func offlineFor(_ ms: Int64) -> String {
        if ms >= day {
            let days = Int(ms / day)
            return RunnerPageCopy.attentionOfflineFor(
                count: days, unit: days == 1 ? RunnerPageCopy.RUNNER_UNIT_DAY : RunnerPageCopy.RUNNER_UNIT_DAYS)
        }
        if ms >= hour {
            let hours = Int(ms / hour)
            return RunnerPageCopy.attentionOfflineFor(
                count: hours, unit: hours == 1 ? RunnerPageCopy.RUNNER_UNIT_HOUR : RunnerPageCopy.RUNNER_UNIT_HOURS)
        }
        let minutes = max(1, Int(ms / minute))
        return RunnerPageCopy.attentionOfflineFor(
            count: minutes,
            unit: minutes == 1 ? RunnerPageCopy.RUNNER_UNIT_MINUTE : RunnerPageCopy.RUNNER_UNIT_MINUTES)
    }

    private static func offlineItem(_ runner: RunnerAttentionRunner, nowMs: Int64) -> RunnerAttentionItem {
        let sessions = runner.activeSessions ?? 0
        let waiting = sessions == 1
            ? RunnerPageCopy.ATTENTION_OFFLINE_ONE_SESSION_WAITS
            : sessions > 1 ? RunnerPageCopy.attentionOfflineSessionsWait(count: sessions) : nil
        return RunnerAttentionItem(
            kind: .offline, tone: .idle, short: RunnerPageCopy.RUNNER_OFFLINE,
            title: epochMs(runner.lastHeartbeatAt).map { offlineFor(max(0, nowMs - $0)) }
                ?? RunnerPageCopy.ATTENTION_NEVER_CHECKED_IN,
            detail: waiting.map { "\($0) \(RunnerPageCopy.ATTENTION_OFFLINE_WAKE)" }
                ?? RunnerPageCopy.ATTENTION_OFFLINE_WAKE,
            action: nil,
            params: [
                "lastSeenAt": runner.lastHeartbeatAt.map(JSONValue.string) ?? .null,
                "sessions": .int(sessions),
            ])
    }

    // MARK: the rules

    /// `a`, `a and b`, `a and 2 more`.
    private static func namesPhrase(_ names: [String]) -> String {
        if names.count == 2 { return RunnerPageCopy.runnerNamesTwo(first: names[0], second: names[1]) }
        if names.count > 2 { return RunnerPageCopy.runnerNamesMore(first: names[0], others: names.count - 1) }
        return names.first ?? ""
    }

    /// The workspaces whose sessions run on this built-in engine's login on this machine.
    private static func workspacesOn(_ workspaces: [RunnerAttentionWorkspace], _ engine: LoginEngine) -> [String] {
        workspaces.filter { $0.lastProvider == engine.rawValue }.map(\.name)
    }

    private static func signedOutItems(_ runner: RunnerAttentionRunner,
                                       _ workspaces: [RunnerAttentionWorkspace]) -> [RunnerAttentionItem] {
        LoginEngine.allCases.compactMap { engine in
            guard let health = runner.engines?.first(where: { $0.engine == engine.rawValue }),
                  health.installed == true, health.auth == "no" else { return nil }
            let users = workspacesOn(workspaces, engine)
            guard !users.isEmpty else { return nil }
            let name = loginName(engine)
            return RunnerAttentionItem(
                kind: .engineSignedOut, tone: .bad,
                short: RunnerPageCopy.attentionSignedOutShort(engine: name),
                title: RunnerPageCopy.attentionSignedOutTitle(engine: name),
                detail: users.count == 1
                    ? RunnerPageCopy.attentionSignedOutDetail(workspace: users[0], engine: name)
                    : RunnerPageCopy.attentionSignedOutDetailMany(workspaces: namesPhrase(users), engine: name),
                action: RunnerAttentionAction(kind: .signIn, engine: engine.rawValue,
                                              workspaceId: nil, command: nil),
                params: ["engine": .string(engine.rawValue), "workspaces": .array(users.map(JSONValue.string))])
        }
    }

    /// One item per stuck checkout, however many workspaces work in it, named after the first.
    private static func checkoutItems(_ workspaces: [RunnerAttentionWorkspace]) -> [RunnerAttentionItem] {
        var roots: [String] = []
        var byRoot: [String: [RunnerAttentionWorkspace]] = [:]
        for workspace in workspaces {
            guard let state = workspace.repoHealth?.state, stuckIn[state] != nil else { continue }
            let root = workspace.repoHealth?.root.flatMap { $0.isEmpty ? nil : $0 } ?? workspace.id
            if byRoot[root] == nil { roots.append(root) }
            byRoot[root, default: []].append(workspace)
        }
        return roots.compactMap { root in
            guard let stuck = byRoot[root], let first = stuck.first, let health = first.repoHealth,
                  let state = health.state, let operation = stuckIn[state] else { return nil }
            let summary = RunnerPageCopy.attentionCheckoutStuck(workspace: first.name, operation: operation)
            return RunnerAttentionItem(
                kind: .checkoutStuck, tone: .bad, short: summary, title: summary,
                detail: RunnerPageCopy.ATTENTION_CHECKOUT_DETAIL,
                action: RunnerAttentionAction(kind: .repair, engine: nil, workspaceId: first.id, command: nil),
                params: [
                    "workspaceId": .string(first.id),
                    "workspaces": .array(stuck.map { .string($0.name) }),
                    "root": .string(root),
                    "state": .string(state),
                    "branch": health.branch.map(JSONValue.string) ?? .null,
                ])
        }
    }

    private static func quotaWindow(_ row: PlanUsageRow) -> String {
        if let claude = claudeWindows[row.key] { return claude }
        return codexWindows.first { row.label.hasSuffix($0.label) }?.window ?? RunnerPageCopy.RUNNER_QUOTA_OTHER
    }

    /// Warn only when every candidate account is near its limit. Show the fullest window of the
    /// account with the most room; an unread account cannot establish an engine-wide shortage.
    private static func quotaItems(_ runner: RunnerAttentionRunner,
                                   _ workspaces: [RunnerAttentionWorkspace], nowMs: Int64) -> [RunnerAttentionItem] {
        LoginEngine.allCases.compactMap { engine in
            let users = workspacesOn(workspaces, engine)
            guard !users.isEmpty else { return nil }
            let usage = runner.planUsage?.snapshot(for: engine.rawValue)
            let accounts = runner.engines?.first(where: { $0.engine == engine.rawValue })?.accounts
            let snapshots: [PlanUsageSnapshot?]
            if RunnerPageFormat.keepsAccounts(engine.rawValue), let accounts, !accounts.isEmpty {
                snapshots = accounts.filter { $0.auth != "no" }.map {
                    CodexAccounts.snapshot(usage, account: $0.id)
                }
            } else {
                snapshots = [usage]
            }
            var fullest: PlanUsageRow?
            for snapshot in snapshots {
                let near = snapshot?.rows.filter {
                    $0.nearLimit && !(epochMs($0.window.resetsAt).map { $0 <= nowMs } ?? false)
                } ?? []
                // The first of the fullest, as the web's reduce keeps it.
                guard var accountFullest = near.first else { return nil }
                for row in near.dropFirst() where row.percent > accountFullest.percent { accountFullest = row }
                if fullest.map({ accountFullest.percent < $0.percent }) ?? true { fullest = accountFullest }
            }
            guard let fullest else { return nil }
            let name = loginName(engine)
            let window = quotaWindow(fullest)
            return RunnerAttentionItem(
                kind: .quotaNearLimit, tone: .warn,
                short: RunnerPageCopy.attentionQuotaShort(engine: name, window: window, percent: fullest.percent),
                title: RunnerPageCopy.attentionQuotaTitle(engine: name, window: window, percent: fullest.percent),
                detail: users.count == 1
                    ? RunnerPageCopy.attentionQuotaDetail(workspace: users[0], engine: name)
                    : RunnerPageCopy.attentionQuotaDetailMany(workspaces: namesPhrase(users), engine: name),
                action: nil,
                params: [
                    "engine": .string(engine.rawValue),
                    "window": .string(window),
                    "percent": .int(fullest.percent),
                    "resetsAt": fullest.window.resetsAt.map(JSONValue.string) ?? .null,
                    "workspaces": .array(users.map(JSONValue.string)),
                ])
        }
    }

    /// Below Keep Free when one is set — the floor the auto-run sweep stops sending task runs at
    /// (tasks.service diskBelowFloor, MB = 1024²). With none set, under 10% of the disk free.
    private static func diskItem(_ runner: RunnerAttentionRunner,
                                 _ workspaces: [RunnerAttentionWorkspace]) -> RunnerAttentionItem? {
        guard let disk = runnerDisk(workspaces) else { return nil }
        let reserveMb = runner.minFreeDiskMb.flatMap { $0 > 0 ? $0 : nil }
        let low = reserveMb.map { disk.freeBytes < Int64($0) * mib }
            ?? (Double(disk.freeBytes) * 10 < Double(disk.totalBytes))
        guard low else { return nil }
        let free = formatDiskGb(disk.freeBytes)
        let total = formatDiskGb(disk.totalBytes)
        let summary = RunnerPageCopy.attentionDiskFull(percent: disk.usedPercent)
        return RunnerAttentionItem(
            kind: .diskLow, tone: .warn, short: summary, title: summary,
            detail: reserveMb.map {
                RunnerPageCopy.attentionDiskBelowReserve(free: free, total: total,
                                                         reserve: formatDiskGb(Int64($0) * mib))
            } ?? RunnerPageCopy.attentionDiskNoReserve(free: free, total: total),
            action: RunnerAttentionAction(kind: .setReserve, engine: nil, workspaceId: nil, command: nil),
            params: [
                "freeBytes": .int(Int(disk.freeBytes)),
                "totalBytes": .int(Int(disk.totalBytes)),
                "usedPercent": .int(disk.usedPercent),
                "reserveMb": reserveMb.map(JSONValue.int) ?? .null,
            ])
    }

    /// Behind the latest release on a runner that is not root: a regular user stays on its version
    /// until someone runs `sudo orbit upgrade` there. Unknown (nil) is an older runner and is not
    /// flagged; a root runner that is behind installs the release itself when no turn is running.
    private static func cannotSelfUpdateItem(_ runner: RunnerAttentionRunner,
                                             _ latestVersion: String?) -> RunnerAttentionItem? {
        guard runner.runsAsRoot == false,
              let version = runner.version?.trimmingCharacters(in: .whitespacesAndNewlines), !version.isEmpty,
              let latestVersion, !latestVersion.isEmpty,
              compareRunnerVersions(version, latestVersion) < 0 else { return nil }
        let command = RunnerPageCopy.RUNNER_UPGRADE_COMMAND
        return RunnerAttentionItem(
            kind: .cannotSelfUpdate, tone: .warn,
            short: RunnerPageCopy.ATTENTION_CANT_UPDATE_ITSELF,
            title: RunnerPageCopy.ATTENTION_CANT_UPDATE_ITSELF,
            detail: RunnerPageCopy.attentionCantUpdateItselfDetail(version: version, latest: latestVersion,
                                                                   command: command),
            action: RunnerAttentionAction(kind: .copyCommand, engine: nil, workspaceId: nil, command: command),
            params: ["version": .string(version), "latest": .string(latestVersion)])
    }

    /// An installed CLI whose update note is a warning (`updateNoteOf`).
    private static func engineUpdateItems(_ runner: RunnerAttentionRunner, nowMs: Int64) -> [RunnerAttentionItem] {
        reportedEngines.compactMap { engine, cliName in
            guard let health = runner.engines?.first(where: { $0.engine == engine }),
                  health.installed == true,
                  let note = updateNoteOf(health.update, nowMs: nowMs), note.tone == .warn else { return nil }
            let summary = RunnerPageCopy.attentionEngineUpdateFailed(engine: cliName)
            return RunnerAttentionItem(
                kind: .engineNotUpdating, tone: .warn, short: summary, title: summary,
                detail: RunnerPageCopy.attentionEngineUpdateDetail(
                    note: note.text.prefix(1).uppercased() + note.text.dropFirst()),
                action: RunnerAttentionAction(kind: .updateEngines, engine: engine, workspaceId: nil, command: nil),
                params: [
                    "engine": .string(engine),
                    "note": .string(note.text),
                    "latest": health.update?.latest.map(JSONValue.string) ?? .null,
                ])
        }
    }

    /// Everything about this runner that needs a person, most severe first.
    public static func runnerAttention(_ input: RunnerAttentionInput) -> [RunnerAttentionItem] {
        let runner = input.runner
        let offline = runnerIsOffline(runner, nowMs: input.nowMs)
        var items: [RunnerAttentionItem] = []
        if offline {
            items.append(offlineItem(runner, nowMs: input.nowMs))
        } else {
            items += signedOutItems(runner, input.workspaces)
            items += checkoutItems(input.workspaces)
            items += quotaItems(runner, input.workspaces, nowMs: input.nowMs)
            if let disk = diskItem(runner, input.workspaces) { items.append(disk) }
        }
        if let cannotUpdate = cannotSelfUpdateItem(runner, input.latestVersion) { items.append(cannotUpdate) }
        if !offline { items += engineUpdateItems(runner, nowMs: input.nowMs) }
        return items
    }

    public static func runnerAttention(runner: Runner, workspaces: [Agent], nowMs: Int64,
                                       latestVersion: String?) -> [RunnerAttentionItem] {
        runnerAttention(RunnerAttentionInput(runner: runner, workspaces: workspaces, nowMs: nowMs,
                                             latestVersion: latestVersion))
    }

    // MARK: the list row

    /// The list's third line: the first two items' short lines. Nil for an offline runner, whatever
    /// else it needs, and nil when nothing needs anyone.
    public static func listAttentionLine(_ items: [RunnerAttentionItem]) -> String? {
        if items.contains(where: { $0.kind == .offline }) { return nil }
        let shorts = items.prefix(2).map(\.short)
        return shorts.isEmpty ? nil : shorts.joined(separator: RunnerPageCopy.RUNNER_LINE_SEPARATOR)
    }

    /// The list's second line. Online: `<hostname> · v<version>`, leaving out a hostname that is
    /// empty or the same as the name shown above it. Offline: `Offline · last seen 14d ago · v<version>`.
    public static func runnerListSubtitle(_ runner: RunnerAttentionRunner, nowMs: Int64) -> String {
        let version = (runner.version?.trimmingCharacters(in: .whitespacesAndNewlines))
            .flatMap { $0.isEmpty ? nil : RunnerPageCopy.runnerVersionTag(version: $0) }
        if runnerIsOffline(runner, nowMs: nowMs) {
            let lastSeen = runner.lastHeartbeatAt.flatMap { $0.isEmpty ? nil : $0 }
            let status = lastSeen.map { RunnerPageCopy.runnerOfflineLastSeen(when: ago($0, nowMs: nowMs)) }
                ?? RunnerPageCopy.RUNNER_OFFLINE
            return [status, version].compactMap { $0 }.joined(separator: RunnerPageCopy.RUNNER_LINE_SEPARATOR)
        }
        let hostname = runner.hostname?.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = runner.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let shownName = displayName.flatMap { $0.isEmpty ? nil : $0 } ?? runner.name
        let host = hostname.flatMap { $0.isEmpty || $0 == shownName ? nil : $0 }
        return [host, version].compactMap { $0 }.joined(separator: RunnerPageCopy.RUNNER_LINE_SEPARATOR)
    }

    public static func runnerListSubtitle(_ runner: Runner, nowMs: Int64) -> String {
        runnerListSubtitle(RunnerAttentionRunner(runner), nowMs: nowMs)
    }
}
