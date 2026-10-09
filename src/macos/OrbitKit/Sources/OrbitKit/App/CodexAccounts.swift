import Foundation

/// A runner's Codex accounts: which one a new session starts on, and whose quota a session spends.
///
/// The native port of shared `accountToStartOn` / `codexAccountSnapshot` and the server's
/// `automaticCodexAccount`. The server makes the choice when it creates a session and stores it
/// (`Session.codexAccount`); this asks the same question of the same numbers so the New Session
/// screen can say where a session would start, and the composer whose quota to show.
public enum CodexAccounts {
    /// The account every runner has: the CODEX_HOME its own environment selects.
    public static let defaultID = "default"
    /// What `PATCH /sessions/:id/account` takes to put a session back on Automatic.
    public static let automaticID = "automatic"

    /// Variables that mean a run brings a key of its own — it then spends no account's subscription
    /// (shared `OWN_CREDENTIAL_KEYS`) — or a CODEX_HOME of its own, which already says where it runs.
    private static let decidingEnvKeys = ["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]
    /// Claude Code's: a CLAUDE_CONFIG_DIR of its own, or a key or token of its own (shared
    /// `OWN_CREDENTIAL_KEYS`).
    private static let claudeDecidingEnvKeys = [
        "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
    ]
    /// Antigravity's: the Gemini directory of an account of its own (shared `ACCOUNT_DIR_VAR`, which
    /// the runner reads to pick the sign-in a session runs on), or a Gemini key of its own.
    private static let antigravityDecidingEnvKeys = ["ORBIT_ANTIGRAVITY_GOOGLE_DIR", "GEMINI_API_KEY"]
    /// Kimi Code's: a KIMI_CODE_HOME of its own.
    private static let kimiDecidingEnvKeys = ["KIMI_CODE_HOME"]
    /// …or a model of its own, which only both of these together are (shared `OWN_CREDENTIAL_NEEDS_ALL`,
    /// runner `kimiUsesEnvModel`): either one alone still runs on the account's login.
    private static let kimiOwnModelEnvKeys = ["KIMI_MODEL_NAME", "KIMI_MODEL_API_KEY"]

    /// The snapshot `engine`'s accounts' quota is read from: the runner's own report for Codex and
    /// Claude Code (`Runner.planUsage`). Antigravity's never rides there — it travels with the engine's
    /// health, Default's buckets beside every other account's under `accounts` (shared
    /// `withEnginePlanUsage`), and is read the same way from then on (`snapshot`).
    public static func usage(_ engine: String, planUsage: PlanUsage?,
                             engines: [RunnerEngineHealth]?) -> PlanUsageSnapshot? {
        if engine == "antigravity" { return engines?.first { $0.engine == engine }?.planUsage }
        return planUsage?.snapshot(for: engine)
    }

    /// The account a workspace picked for its sessions on `engine` (`Agent.codexAccount`,
    /// `.claudeAccount`, `.antigravityAccount`, `.kimiAccount`); nil leaves it to Automatic.
    public static func workspaceAccount(_ engine: String, of agent: Agent?) -> String? {
        switch engine {
        case "claude": return agent?.claudeAccount
        case "antigravity": return agent?.antigravityAccount
        case "kimi": return agent?.kimiAccount
        default: return agent?.codexAccount
        }
    }

    /// What a runner declares once it signs an Antigravity account Orbit names into that account's own
    /// Gemini directory, rather than signing the runner's one Google sign-in in again.
    public static let antigravityAccountLoginCapability = "antigravity-account-login/v1"
    /// The same for Kimi Code: an account Orbit names signs in, on the site the sign-in names, into a
    /// KIMI_CODE_HOME of its own rather than Default's.
    public static let kimiAccountLoginCapability = "kimi-account-login/v1"

    /// What a runner declares when a session there can move to another of its accounts of `engine`:
    /// Codex, Claude Code and Kimi Code carry the conversation from one account's directory to the
    /// other's (`codex-account-move/v1`, `claude-account-move/v1`, `kimi-account-move/v1`). An
    /// Antigravity conversation lives in the session's own directory whichever account it runs on, so
    /// there is nothing to carry: a runner that keeps Antigravity accounts at all — one that signs them
    /// in (`antigravityAccountLoginCapability`) — moves a session between them.
    public static func moveCapability(_ engine: String) -> String {
        switch engine {
        case "claude": return "claude-account-move/v1"
        case "antigravity": return antigravityAccountLoginCapability
        case "kimi": return "kimi-account-move/v1"
        default: return "codex-account-move/v1"
        }
    }

    /// One account's own quota: Default's is the snapshot's own windows, any other account's is its
    /// entry under `accounts`. Nil when the runner reports none for that account.
    public static func snapshot(_ usage: PlanUsageSnapshot?, account: String) -> PlanUsageSnapshot? {
        guard let usage else { return nil }
        if account != defaultID { return usage.accounts?[account] }
        guard usage.accounts != nil else { return usage }
        var own = usage
        own.accounts = nil
        return windows(own).isEmpty ? nil : own
    }

    /// One account's quota as reported, windowless or not — web's `codexAccountSnapshot` itself, where
    /// `snapshot` is the drawing half that collapses a Default with nothing to draw to nil. A Default
    /// minus its `accounts` counts as reported when it carries anything besides `provider` — a
    /// `fetchedAt` alone says the runner read it and the answer held no window, as a Kimi plan with no
    /// quota limit reads — and any other account counts when its entry under `accounts` exists.
    public static func reportedSnapshot(_ usage: PlanUsageSnapshot?, account: String) -> PlanUsageSnapshot? {
        guard let usage else { return nil }
        if account != defaultID { return usage.accounts?[account] }
        guard usage.accounts != nil else { return usage }
        var own = usage
        own.accounts = nil
        return reported(own) ? own : nil
    }

    /// Whether anything besides `provider` is set on `s` (web's `Object.keys(own).some(key => key !==
    /// 'provider')`): the read's own `fetchedAt` is enough — it says the runner asked and this was the
    /// whole answer.
    private static func reported(_ s: PlanUsageSnapshot) -> Bool {
        s.fiveHour != nil || s.sevenDay != nil || s.sevenDayOpus != nil || s.sevenDaySonnet != nil
            || s.month != nil || s.monthCode != nil || s.primary != nil || s.secondary != nil
            || s.limitId != nil || s.limitName != nil || s.planType != nil
            || s.rateLimitReachedType != nil || s.credits != nil || s.rateLimits != nil
            || s.rateLimitReset != nil || s.fetchedAt != nil || s.buckets != nil
    }

    /// What an account is called where one is named: what the user called it — Default too, once
    /// renamed in Orbit — else "Default", or the slot's own id (web `accountNameOf`).
    public static func label(_ id: String, accounts: [RunnerEngineAccount]?) -> String {
        if let name = accounts?.first(where: { $0.id == id })?.name, !name.isEmpty { return name }
        return id == defaultID ? "Default" : "Account \(id)"
    }

    /// `wanted` when the runner reports it, else Default — the account dispatch runs a session on
    /// (the server's `accountOnRunner`).
    public static func onRunner(_ wanted: String?, accounts: [RunnerEngineAccount]?) -> String {
        guard let wanted, !wanted.isEmpty, accounts?.contains(where: { $0.id == wanted }) == true else {
            return defaultID
        }
        return wanted
    }

    /// Whether a new session of `engine` (`codex`, `claude`, `antigravity` or `kimi`) on `agent` starts
    /// on Automatic: its workspace picked no account of that engine, its env selects no other config
    /// directory and no key of its own, and the runner has more than one account to choose between (the
    /// server's `automaticAccount`). The same answer says whether a session there is on Automatic unless
    /// an account was picked for it by hand.
    public static func automaticOffered(engine: String = "codex", agent: Agent?,
                                        accounts: [RunnerEngineAccount]?) -> Bool {
        automaticOffered(engine: engine, pick: workspaceAccount(engine, of: agent),
                         env: agent?.env, accounts: accounts)
    }

    /// The same question asked of the workspace's `pick` for that engine and its `env` — what a
    /// session's detail carries of its workspace (`SessionAgentRef`).
    public static func automaticOffered(engine: String, pick: String?, env: [String: String]?,
                                        accounts: [RunnerEngineAccount]?) -> Bool {
        guard (accounts?.count ?? 0) >= 2, pick?.isEmpty ?? true else { return false }
        let env = env ?? [:]
        let set = { (key: String) in !(env[key]?.trimmingCharacters(in: .whitespaces).isEmpty ?? true) }
        if engine == "kimi" && kimiOwnModelEnvKeys.allSatisfy(set) { return false }
        let deciding: [String]
        switch engine {
        case "claude": deciding = claudeDecidingEnvKeys
        case "antigravity": deciding = antigravityDecidingEnvKeys
        case "kimi": deciding = kimiDecidingEnvKeys
        default: deciding = decidingEnvKeys
        }
        return !deciding.contains(where: set)
    }

    /// Which account a new session with none picked starts on: the one whose quota would otherwise go
    /// to waste first.
    ///
    /// - Only an account the CLI does not say is signed out is a candidate.
    /// - One with a spent window (100% and not past its reset, or with no reset to go by) is passed
    ///   over while another can run.
    /// - One with a window nearly spent (80% of a 5-hour one, 90% of a longer one — `nearlySpent`) comes
    ///   after the rest: a run started there would soon meet its limit and have to move.
    /// - Then soonest-expiring first: the reset of each account's longest window (`expiresAt`).
    ///   Different plans hold very different amounts, so how much is left is not compared across
    ///   accounts — only when it expires. An account with nothing reported comes after every one that has.
    /// - Equal expiry: the one with more room, by its tightest window. Unread ranks after read.
    /// - One paused by hand (`pausedUntil`) waits as a spent one does, until its pause ends.
    /// - Every candidate spent: the one that frees up first.
    /// - Ties go to Default, then to the lower id.
    ///
    /// Nil with fewer than two accounts, or none signed in: nothing to choose between.
    public static func toStartOn(_ accounts: [RunnerEngineAccount]?, usage: PlanUsageSnapshot?,
                                 now: Date = Date()) -> String? {
        guard let accounts, accounts.count >= 2 else { return nil }
        struct Candidate {
            let id: String; let nearLimit: Bool; let expiresAt: Double; let tightest: Double; let spentUntil: Double?
        }
        let candidates: [Candidate] = accounts.filter { $0.auth != "no" }.map { account in
            let own = snapshot(usage, account: account.id)
            let ws = own.map(windows) ?? []
            // Not past its reset — or with no reset to go by, which nothing says has come.
            let open = ws.filter { !(resetTime($0).map { $0 <= now.timeIntervalSince1970 } ?? false) }
            let spent = open.filter { $0.utilization >= 100 }
            let resets = spent.map { resetTime($0) ?? .infinity }
            var spentUntil = spent.isEmpty ? nil : resets.max()
            if let pause = account.pausedUntil.flatMap(RelativeTime.parse)?.timeIntervalSince1970,
               pause > now.timeIntervalSince1970 {
                spentUntil = max(pause, spentUntil ?? 0)
            }
            return Candidate(id: account.id,
                             nearLimit: own.map { nearlySpent($0, now: now) } ?? false,
                             expiresAt: own.map { expiresAt($0, now: now) } ?? .infinity,
                             tightest: ws.map(\.utilization).max() ?? .infinity,
                             spentUntil: spentUntil)
        }
        func byID(_ a: Candidate, _ b: Candidate) -> Bool {
            if (a.id == defaultID) != (b.id == defaultID) { return a.id == defaultID }
            return a.id < b.id
        }
        let usable = candidates.filter { $0.spentUntil == nil }
        if !usable.isEmpty {
            return usable.sorted { a, b in
                if a.nearLimit != b.nearLimit { return !a.nearLimit }
                if a.expiresAt != b.expiresAt { return a.expiresAt < b.expiresAt }
                return a.tightest != b.tightest ? a.tightest < b.tightest : byID(a, b)
            }.first?.id
        }
        return candidates.sorted { a, b in
            let x = a.spentUntil ?? 0, y = b.spentUntil ?? 0
            return x != y ? x < y : byID(a, b)
        }.first?.id
    }

    /// At or over this share consumed, a window is nearly spent (shared `NEAR_LIMIT_UTILIZATION`).
    static let nearLimitUtilization = 90.0
    /// The same for a window of five hours or less (shared `SHORT_WINDOW_NEAR_LIMIT_UTILIZATION`).
    static let shortWindowNearLimitUtilization = 80.0
    static let shortWindowMins = 5 * 60

    /// Whether any window of `s` is nearly spent and not past its reset (shared `quotaNearLimit`): 80% of
    /// one of five hours or less, 90% of a longer one or of one that does not say how long it is. By the
    /// window's length, never its slot: Codex reports a Pro login's weekly window as its `primary`.
    static func nearlySpent(_ s: PlanUsageSnapshot, now: Date) -> Bool {
        withLength(s).contains { entry in
            let open = !(resetTime(entry.window).map { $0 <= now.timeIntervalSince1970 } ?? false)
            let short = entry.mins.map { $0 <= shortWindowMins } ?? false
            return open && entry.window.utilization >= (short ? shortWindowNearLimitUtilization : nearLimitUtilization)
        }
    }

    /// When what an account has left of its quota goes to waste (shared `quotaExpiresAt`): the reset
    /// of its longest window — a weekly one where it has one — which gives back a full window whatever
    /// was left of the old one. When no window says how long it is, the latest reset. Infinity when no
    /// window names a reset ahead of `now`: nothing is known to expire.
    static func expiresAt(_ s: PlanUsageSnapshot, now: Date) -> Double {
        let ahead: [(mins: Int?, at: Double)] = withLength(s).compactMap { entry in
            guard let at = resetTime(entry.window), at > now.timeIntervalSince1970 else { return nil }
            return (entry.mins, at)
        }
        guard let longest = ahead.map({ $0.mins ?? -1 }).max() else { return .infinity }
        let pick = longest >= 0 ? ahead.filter { ($0.mins ?? -1) == longest } : ahead
        return pick.map(\.at).max() ?? .infinity
    }

    /// How long a Kimi Code monthly window is, for weighing it against the others (shared `MONTH_MINS`):
    /// longer than any week, which is all its length decides here.
    static let monthMins = 30 * 24 * 60

    /// Every window of one snapshot with its length in minutes (shared `windowsWithLength`): Claude's
    /// and Kimi Code's named ones by their names, Codex's as it reports them — nil when one does not
    /// say — and Antigravity's buckets as the windows they are (`bucketWindow`).
    static func withLength(_ s: PlanUsageSnapshot) -> [(window: PlanUsageWindow, mins: Int?)] {
        let week = 7 * 24 * 60
        let named: [(PlanUsageWindow?, Int)] = [(s.fiveHour, 5 * 60), (s.sevenDay, week), (s.sevenDayOpus, week),
                                                (s.sevenDaySonnet, week), (s.month, monthMins),
                                                (s.monthCode, monthMins)]
        let buckets: [PlanUsageWindow?] = (s.buckets ?? []).map(bucketWindow)
        let reported = [s.primary, s.secondary] + (s.rateLimits ?? []).flatMap { [$0.primary, $0.secondary] }
            + buckets
        let all: [(window: PlanUsageWindow, mins: Int?)] =
            named.compactMap { window, mins in window.map { ($0, $0.windowDurationMins ?? mins) } }
            + reported.compactMap { window in window.map { ($0, $0.windowDurationMins) } }
        return all
    }

    /// Every window one snapshot reports: Claude's named ones, Kimi Code's monthly pair, Codex's
    /// primary/secondary pair, the per-bucket windows Codex reports under `rateLimits`, and
    /// Antigravity's buckets (`bucketWindow`).
    static func windows(_ s: PlanUsageSnapshot) -> [PlanUsageWindow] {
        [s.fiveHour, s.sevenDay, s.sevenDayOpus, s.sevenDaySonnet, s.month, s.monthCode, s.primary,
         s.secondary].compactMap { $0 }
            + (s.rateLimits ?? []).flatMap { [$0.primary, $0.secondary].compactMap { $0 } }
            + (s.buckets ?? []).map(bucketWindow)
    }

    /// How long an Antigravity bucket's window is, from agy's own name for it (shared
    /// `BUCKET_WINDOW_MINS`); nil for one it names otherwise.
    static let bucketWindowMins: [String: Int] = ["5h": 5 * 60, "weekly": 7 * 24 * 60]

    /// One Antigravity bucket as a window (shared `bucketWindow`): what agy says is left, turned into
    /// the share consumed every other window speaks in, with its reset. Only for weighing quota
    /// against quota — what a page shows stays agy's own remaining fraction (`PlanUsageSnapshot.rows`).
    static func bucketWindow(_ bucket: PlanUsageBucket) -> PlanUsageWindow {
        PlanUsageWindow(utilization: (1 - bucket.remainingFraction) * 100, resetsAt: bucket.resetTime,
                        windowDurationMins: bucketWindowMins[bucket.window])
    }

    private static func resetTime(_ w: PlanUsageWindow) -> Double? {
        guard let at = w.resetsAt else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        return (withFraction.date(from: at) ?? plain.date(from: at))?.timeIntervalSince1970
    }
}
