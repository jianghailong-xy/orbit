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

    /// Whether a new session of `engine` (`codex` or `claude`) on `agent` starts on Automatic: its
    /// workspace picked no account of that engine, its env selects no other config directory and no
    /// key of its own, and the runner has more than one account to choose between (the server's
    /// `automaticAccount`). The same answer says whether a session there is on Automatic unless an
    /// account was picked for it by hand.
    public static func automaticOffered(engine: String = "codex", agent: Agent?,
                                        accounts: [RunnerEngineAccount]?) -> Bool {
        automaticOffered(engine: engine, pick: engine == "claude" ? agent?.claudeAccount : agent?.codexAccount,
                         env: agent?.env, accounts: accounts)
    }

    /// The same question asked of the workspace's `pick` for that engine and its `env` — what a
    /// session's detail carries of its workspace (`SessionAgentRef`).
    public static func automaticOffered(engine: String, pick: String?, env: [String: String]?,
                                        accounts: [RunnerEngineAccount]?) -> Bool {
        guard (accounts?.count ?? 0) >= 2, pick?.isEmpty ?? true else { return false }
        let env = env ?? [:]
        return !(engine == "claude" ? claudeDecidingEnvKeys : decidingEnvKeys).contains { key in
            !(env[key]?.trimmingCharacters(in: .whitespaces).isEmpty ?? true)
        }
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
            return Candidate(id: account.id,
                             nearLimit: own.map { nearlySpent($0, now: now) } ?? false,
                             expiresAt: own.map { expiresAt($0, now: now) } ?? .infinity,
                             tightest: ws.map(\.utilization).max() ?? .infinity,
                             spentUntil: spent.isEmpty ? nil : resets.max())
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

    /// Every window of one snapshot with its length in minutes (shared `windowsWithLength`): Claude's
    /// named ones by their names, Codex's as it reports them — nil when one does not say.
    static func withLength(_ s: PlanUsageSnapshot) -> [(window: PlanUsageWindow, mins: Int?)] {
        let week = 7 * 24 * 60
        let named: [(PlanUsageWindow?, Int)] = [(s.fiveHour, 5 * 60), (s.sevenDay, week), (s.sevenDayOpus, week),
                                                (s.sevenDaySonnet, week)]
        let reported = [s.primary, s.secondary] + (s.rateLimits ?? []).flatMap { [$0.primary, $0.secondary] }
        let all: [(window: PlanUsageWindow, mins: Int?)] =
            named.compactMap { window, mins in window.map { ($0, $0.windowDurationMins ?? mins) } }
            + reported.compactMap { window in window.map { ($0, $0.windowDurationMins) } }
        return all
    }

    /// Every window one snapshot reports: Claude's named ones, Codex's primary/secondary pair, and the
    /// per-bucket windows Codex reports under `rateLimits`.
    static func windows(_ s: PlanUsageSnapshot) -> [PlanUsageWindow] {
        [s.fiveHour, s.sevenDay, s.sevenDayOpus, s.sevenDaySonnet, s.primary, s.secondary].compactMap { $0 }
            + (s.rateLimits ?? []).flatMap { [$0.primary, $0.secondary].compactMap { $0 } }
    }

    private static func resetTime(_ w: PlanUsageWindow) -> Double? {
        guard let at = w.resetsAt else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        return (withFraction.date(from: at) ?? plain.date(from: at))?.timeIntervalSince1970
    }
}
