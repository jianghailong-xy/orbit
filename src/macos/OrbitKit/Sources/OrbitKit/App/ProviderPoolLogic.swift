import Foundation

/// The account a session on a pool spends: a member of that pool, and whether a claim has actually
/// chosen it yet.
public struct PoolAccount: Equatable, Sendable {
    public let member: PoolMember
    /// True for the member the session's last claim dispatched on; false for the one the next claim
    /// picks, which is all a draft or a session that hasn't been claimed yet can be told.
    public let current: Bool

    public init(member: PoolMember, current: Bool) {
        self.member = member
        self.current = current
    }
}

/// Account pools as the new-session picker and the composer read them — the native port of web's
/// `lib/providerPools.ts`; keep the two in sync. Which member a session starting now runs on
/// (`PoolMember.next`), when a spent pool frees up (`ProviderPool.resetsAt`) and whether a pool can
/// run at all (`ProviderPool.unavailable`) are the server's answers, the claim's own selector asked
/// the way the claim asks it, so nothing here re-derives them.
public enum ProviderPools {

    /// The pools as providers the pickers and the composer resolve like any configured one: an
    /// account pool runs on its members' Claude subscriptions, whose models are the Claude CLI's own
    /// — the model space an Anthropic key has — and it carries no quota of its own (each member has
    /// one). A shared pool runs Codex on OpenAI's own endpoint through the pool gateway, and so does a
    /// pool of one's own ChatGPT account: their models are the Codex CLI's and their mark OpenAI's.
    public static func asProviders(_ pools: [ProviderPool]) -> [ConfiguredProvider] {
        pools.map { pool in
            let codex = runsCodex(pool)
            return ConfiguredProvider(slug: pool.slug, label: pool.label,
                                      runtime: codex ? "codex" : "claude",
                                      presetSlug: codex ? SharedPools.keyPresetSlug : "anthropic",
                                      modelsFromRuntime: true)
        }
    }

    /// Whether a pool runs Codex — a shared pool of OpenAI keys, or a pool of one's own ChatGPT account
    /// (web's `poolRunsCodex`) — rather than its members' Claude subscriptions.
    public static func runsCodex(_ pool: ProviderPool) -> Bool {
        pool.shared != nil || pool.engine == "codex"
    }

    /// The account a session on `pool` is on: the member its last claim recorded (`memberID`), or —
    /// before its first claim, as for a draft — the member the next claim picks. Nil when the
    /// recorded member has since left the pool: the next claim chooses again, and naming anyone
    /// until then would be a guess. Nil too when no member can run.
    public static func sessionAccount(in pool: ProviderPool, memberID: String?) -> PoolAccount? {
        if let memberID, !memberID.isEmpty {
            let key = PublicID.storageKey(memberID)
            return pool.members.first { PublicID.storageKey($0.id) == key }
                .map { PoolAccount(member: $0, current: true) }
        }
        return pool.members.first(where: \.next).map { PoolAccount(member: $0, current: false) }
    }

    /// What the account beside the quota says about itself when asked (a tooltip on web). A shared
    /// pool's member is one of its keys, which is what the second sentence ends by saying.
    public static func accountHelp(pool: ProviderPool, account: PoolAccount) -> String {
        account.current
            ? "\(pool.label) is running this session on \(account.member.label)"
            : "A session on \(pool.label) starts on \(account.member.label) — "
                + (pool.shared != nil ? "the key it picks for you right now" : "the account whose quota resets soonest")
    }

    /// Why the new-session picker greys `pool` out, or nil while it can run: the server's own answer
    /// (`ProviderPool.unavailable`) — none of its accounts can run, and no reset will change that. Read
    /// rather than worked out from the members, since only the server knows which of them its
    /// admission still takes. A pool whose accounts are only spent is not greyed: every door takes it
    /// and it waits for a reset, which `spentNote` names.
    public static func unavailableReason(_ pool: ProviderPool) -> String? {
        pool.unavailable
    }

    /// What the picker's row says in place of its model while every account that can run is spent:
    /// when the first of them frees up — the earliest reset, not the latest — in the words the pool's
    /// head says it on /providers (web's `PoolGauge`). Nil while an account can take the next session,
    /// and for a pool that cannot run at all, which `unavailableReason` speaks for. Read in the order
    /// web's `poolHeadline` reads a pool: an account to run on, the server's refusal, then spent.
    public static func spentNote(_ pool: ProviderPool, now: Date = Date(),
                                 timeZone: TimeZone = .current) -> String? {
        guard !pool.members.contains(where: \.next), unavailableReason(pool) == nil,
              pool.members.contains(where: { $0.state == .spent }) else { return nil }
        guard let resetsAt = pool.resetsAt else { return spentHead(pool) }
        // A pool of nothing but keys is capped rather than spent: the month turning is what frees them,
        // and a date says that where a clock would not (web's `PoolGauge`).
        if keysOnly(pool) {
            guard let date = SharedPoolPage.capReset(resetsAt) else { return spentHead(pool) }
            return "\(spentHead(pool)) · resets \(date)"
        }
        guard let time = formatResetTime(resetsAt, now: now, timeZone: timeZone) else {
            return spentHead(pool)
        }
        return "\(spentHead(pool)) · resets \(time)"
    }

    /// What a pool with nothing left to run on is headed with (web's `PoolGauge`): a pool of nothing but
    /// keys ran out of what their contributors let the others spend this month, which is a cap — or OpenAI
    /// itself put them out of budget, when that is the only reason. A ChatGPT account in it is spent, and
    /// comes back by the hour.
    static func spentHead(_ pool: ProviderPool) -> String {
        guard keysOnly(pool), let shared = pool.shared else { return "All spent" }
        return SharedPoolPage.allOutOfBudget(shared) ? SharedPoolPage.allOutOfBudgetWords : SharedPoolPage.allAtCapWords
    }

    /// Only a pool of nothing but keys is capped (web's `keysOnly`): one read with its people and keys
    /// that holds a ChatGPT account of its owner's runs on that account first.
    static func keysOnly(_ pool: ProviderPool) -> Bool {
        pool.shared != nil && !pool.members.contains { $0.login != nil }
    }

    /// Whether `pool` is drawn for one of the people its owner added rather than for its owner (web's
    /// `readByMember`).
    public static func readByMember(_ pool: ProviderPool) -> Bool {
        pool.shared.map { !SharedPoolPage.ownsPool($0) } ?? false
    }

    /// "2 of 3 accounts available" — "2 of 2 keys you can run on available" for somebody the owner added:
    /// the members a session could start on right now (web's `availabilityOf`, less the admission
    /// refusals only the web page reads).
    public static func availability(_ pool: ProviderPool) -> String {
        "\(readyCount(pool)) of \(pool.members.count) \(memberNoun(pool, pool.members.count)) available"
    }

    /// What `n` of a pool's members are to whoever reads it (web's `memberNoun`): to its owner, accounts —
    /// each ChatGPT account and API key of a Codex pool, each subscription of a Claude one — and to the
    /// people they added, what they can run on: the pool's ChatGPT accounts and its keys, whichever of the
    /// two it holds (the accounts run their sessions too, 2026-10-03).
    public static func memberNoun(_ pool: ProviderPool, _ n: Int) -> String {
        guard readByMember(pool) else { return "account\(n == 1 ? "" : "s")" }
        let accounts = pool.members.contains { $0.login != nil }
        let keys = pool.members.contains { $0.key != nil }
        if accounts && keys { return "account\(n == 1 ? "" : "s") and key\(n == 1 ? "" : "s") you can run on" }
        return (keys ? "key\(n == 1 ? "" : "s")" : "account\(n == 1 ? "" : "s")") + " you can run on"
    }

    // MARK: the pool's page (Settings → Providers → an account pool)

    /// The page's head: what the pool is, and how many of its accounts a session could start on now
    /// (`availability`).
    public static let pageTitle = "Account pool"
    public static let accountsHeader = "Accounts"
    /// The web page's sentence under the pool's name; on a phone, the Accounts section's footer.
    public static let accountsFooter = "Each session starts on the account whose quota resets soonest, so none of it goes unused, and stays on it until that one runs out."

    /// The "2" of "2 of 3 accounts available": the members a session could start on now (web's
    /// `canTakeWork`). One that reports no quota counts — the claim still picks it, just last — and so
    /// does one whose quota the endpoint would not report: the key is not refused.
    public static func readyCount(_ pool: ProviderPool) -> Int {
        pool.members.filter { !AccountPause.isPaused($0.pausedUntil)
            && [.available, .running, .noQuota, .usageUnknown].contains($0.state) }.count
    }

    /// The Accounts header's trailing words (web's `PoolGauge`): the account the next session starts
    /// on — named, in a pool of one's own ChatGPT account that holds just the one and so has nothing to
    /// choose between, and once other people use the pool, as the reader's next session, theirs running
    /// elsewhere — then the gauge `headGauge` reads; with none, when the first spent one frees up; with
    /// none that can run, why.
    public static func headline(_ pool: ProviderPool, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        if let next = pool.members.first(where: { $0.next && !AccountPause.isPaused($0.pausedUntil, now: now) }) {
            if let shared = pool.shared, SharedPoolPage.hasPeople(shared) { return "Next for you: \(next.label)" }
            return next.login != nil && pool.members.count == 1 ? next.label : "Next: \(next.label)"
        }
        if let unavailable = pool.unavailable { return unavailable }
        let paused = pool.members.filter { AccountPause.isPaused($0.pausedUntil, now: now) }
        if !paused.isEmpty {
            return "\(paused.count) paused"
        }
        if pool.members.contains(where: { $0.state == .spent }) {
            return spentNote(pool, now: now, timeZone: timeZone) ?? "All spent"
        }
        // A pool holding ChatGPT accounts is spent rather than capped (web's `poolHeadline`): the accounts
        // come back by the hour, where keys spent to their caps come back with the month.
        return keysOnly(pool) ? "No key can run" : "No account can run"
    }

    /// A member's status tag (web's `memberStatus`).
    public static func memberStatus(_ member: PoolMember, now: Date = Date(),
                                    timeZone: TimeZone = .current) -> PoolStatus {
        switch member.state {
        case .running: return PoolStatus(label: "Running now", tone: .brand)
        case .available: return PoolStatus(label: "Available", tone: .success)
        case .spent:
            guard let resetsAt = member.resetsAt,
                  let time = formatResetTime(resetsAt, now: now, timeZone: timeZone) else {
                return PoolStatus(label: "Spent", tone: .warning)
            }
            return PoolStatus(label: "Spent · resets \(time)", tone: .warning)
        case .refused: return PoolStatus(label: "Unavailable · key refused", tone: .danger)
        // Its line says what brings it back: its owner's sign-in again.
        case .signedOut: return PoolStatus(label: "Signed out", tone: .danger)
        case .usageUnknown: return PoolStatus(label: "Unavailable · usage unreadable", tone: .neutral)
        case .disabled: return PoolStatus(label: "Disabled", tone: .neutral)
        case .noQuota, .unknown: return PoolStatus(label: "No quota reported", tone: .neutral)
        }
    }

    /// The gauge a member's row shows (web's `memberQuota`): the window that stopped a spent member,
    /// else the one closest to its limit — a 5-hour window at 6% says nothing of a weekly one at 97%,
    /// which stops the account first. A tie goes to the first of them, the 5-hour window. Nil when it
    /// reports no quota.
    public static func memberQuota(_ member: PoolMember) -> PlanUsageRow? {
        guard let rows = member.planUsage?.rows, !rows.isEmpty else { return nil }
        if member.state == .spent, let binding = rows.first(where: { $0.window.utilization >= 100 }) {
            return binding
        }
        return rows.reduce(nil as PlanUsageRow?) { tightest, row in
            guard let tightest else { return row }
            return row.window.utilization > tightest.window.utilization ? row : tightest
        }
    }

    /// The head's gauge beside its account (web's `PoolGauge`): the tightest window of the account the
    /// next session starts on (`memberQuota`), by its short name — "Weekly 97%" — in the warning tone at
    /// 90% or more; for a key with no cap, that it has none to fill; for an account that reports no
    /// quota, that it reports none. Nil with no account to start on — `headline` says when or why.
    public static func headGauge(_ pool: ProviderPool) -> PoolStatus? {
        guard let next = pool.members.first(where: \.next) else { return nil }
        guard let quota = memberQuota(next) else {
            return PoolStatus(label: next.key != nil ? noLimit : CodexLoginPool.noQuota, tone: .neutral)
        }
        return PoolStatus(label: quotaReading(quota), tone: quota.nearLimit ? .warning : .neutral)
    }

    /// The head's gauge for a key with no cap: nothing to fill.
    public static let noLimit = "No limit"

    /// A window's reading in the words a gauge has room for: its short name and how much of it is used
    /// ("Weekly 97%", "5h 6%").
    public static func quotaReading(_ row: PlanUsageRow) -> String {
        "\(SessionProviderChoices.compactWindowLabel(row.label)) \(row.percent)%"
    }

    /// When a window resets, as the pages say it: `14:05` within a day, `Mon 14:05` beyond that — a
    /// weekly limit can be days out, and a bare time would read as today. Nil for an unreadable time.
    public static func formatResetTime(_ iso: String, now: Date = Date(),
                                       timeZone: TimeZone = .current) -> String? {
        guard let at = RelativeTime.parse(iso) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = at.timeIntervalSince(now) < 24 * 60 * 60 ? "HH:mm" : "EEE HH:mm"
        return formatter.string(from: at)
    }
}
