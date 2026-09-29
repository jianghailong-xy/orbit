import Foundation

/// A runner's Codex accounts: which one a new session starts on, and whose quota a session spends.
///
/// The native port of shared `roomiestCodexAccount` / `codexAccountSnapshot` and the server's
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

    /// What an account is called where one is named: "Default", or what the user called it.
    public static func label(_ id: String, accounts: [RunnerEngineAccount]?) -> String {
        if id == defaultID { return "Default" }
        return accounts?.first { $0.id == id }?.name ?? "Account \(id)"
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

    /// Which account a new session with none picked starts on: the one with the most room right now.
    ///
    /// - Only an account the CLI does not say is signed out is a candidate.
    /// - One with a spent window (100% and not past its reset, or with no reset to go by) is passed
    ///   over while another can run.
    /// - The rest rank by their tightest window's use: accounts report different windows (a Plus login
    ///   a 5-hour and a weekly one, a Pro login only a weekly one). Unread ranks after read.
    /// - Every candidate spent: the one that frees up first.
    /// - Ties go to Default, then to the lower id.
    ///
    /// Nil with fewer than two accounts, or none signed in: nothing to choose between.
    public static func roomiest(_ accounts: [RunnerEngineAccount]?, usage: PlanUsageSnapshot?,
                                now: Date = Date()) -> String? {
        guard let accounts, accounts.count >= 2 else { return nil }
        struct Candidate { let id: String; let tightest: Double; let spentUntil: Double? }
        let candidates: [Candidate] = accounts.filter { $0.auth != "no" }.map { account in
            let ws = snapshot(usage, account: account.id).map(windows) ?? []
            let spent = ws.filter { $0.utilization >= 100 && !(resetTime($0).map { $0 <= now.timeIntervalSince1970 } ?? false) }
            let resets = spent.map { resetTime($0) ?? .infinity }
            return Candidate(id: account.id,
                             tightest: ws.map(\.utilization).max() ?? .infinity,
                             spentUntil: spent.isEmpty ? nil : resets.max())
        }
        func byID(_ a: Candidate, _ b: Candidate) -> Bool {
            if (a.id == defaultID) != (b.id == defaultID) { return a.id == defaultID }
            return a.id < b.id
        }
        let usable = candidates.filter { $0.spentUntil == nil }
        if !usable.isEmpty {
            return usable.sorted { a, b in a.tightest != b.tightest ? a.tightest < b.tightest : byID(a, b) }.first?.id
        }
        return candidates.sorted { a, b in
            let x = a.spentUntil ?? 0, y = b.spentUntil ?? 0
            return x != y ? x < y : byID(a, b)
        }.first?.id
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
