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
    /// The picker row the pools' own accounts fold away under (web's `NewSessionProviderHero`).
    public static let pinAccountLabel = "Pin a specific account"
    /// The picker's section of pools, in the words the /providers page heads its pools with (web's
    /// `AccountPools`).
    public static let sectionTitle = "Account pools"
    public static let sectionFooter = ProvidersOverview.accountPoolsDetail

    /// The pools as providers the pickers and the composer resolve like any configured one: an
    /// account pool runs on its members' Claude subscriptions, whose models are the Claude CLI's own
    /// — the model space an Anthropic key has — and it carries no quota of its own (each member has
    /// one). A shared pool runs Codex on OpenAI's own endpoint through the pool gateway, so its
    /// models are the Codex CLI's and its mark OpenAI's.
    public static func asProviders(_ pools: [ProviderPool]) -> [ConfiguredProvider] {
        pools.map { pool in
            let shared = pool.shared != nil
            return ConfiguredProvider(slug: pool.slug, label: pool.label,
                                      runtime: shared ? "codex" : "claude",
                                      presetSlug: shared ? SharedPools.keyPresetSlug : "anthropic",
                                      modelsFromRuntime: true)
        }
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
                + (pool.shared != nil ? "the key it picks for you" : "the account with the most room")
                + " right now"
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
        // A shared pool's keys are capped rather than spent: the month turning is what frees them,
        // and a date says that where a clock would not (web's `PoolGauge`).
        if pool.shared != nil {
            guard let date = SharedPoolPage.capReset(resetsAt) else { return spentHead(pool) }
            return "\(spentHead(pool)) · resets \(date)"
        }
        guard let time = formatResetTime(resetsAt, now: now, timeZone: timeZone) else {
            return spentHead(pool)
        }
        return "\(spentHead(pool)) · resets \(time)"
    }

    /// What a pool with nothing left to run on is headed with (web's `PoolGauge`): a shared pool's keys
    /// ran out of what their contributors let the others spend this month, which is a cap — or OpenAI
    /// itself put them out of budget, when that is the only reason, which is the two words the pool's
    /// own page heads its keys with (`SharedPoolPage.keysHeadline`).
    static func spentHead(_ pool: ProviderPool) -> String {
        guard let shared = pool.shared else { return "All spent" }
        return SharedPoolPage.allOutOfBudget(shared) ? SharedPoolPage.allOutOfBudgetWords : SharedPoolPage.allAtCapWords
    }

    // MARK: the pool's page (Settings → Providers → an account pool)

    /// The page's head: what the pool is, and how many of its accounts a session could start on now
    /// (web's `availabilityOf`, less the admission refusals only the web page reads).
    public static let pageTitle = "Account pool"
    public static let accountsHeader = "Accounts"
    /// The web page's sentence under the pool's name; on a phone, the Accounts section's footer.
    public static let accountsFooter = "Each session starts on the account with the most room in its 5-hour window, and stays on it until that one runs out."

    public static func pageSubtitle(_ pool: ProviderPool) -> String {
        let n = pool.members.count
        return "\(readyCount(pool)) of \(n) account\(n == 1 ? "" : "s") available"
    }

    /// The "2" of "2 of 3 accounts available": the members a session could start on now (web's
    /// `canTakeWork`). One that reports no quota counts — the claim still picks it, just last — and so
    /// does one whose quota the endpoint would not report: the key is not refused.
    public static func readyCount(_ pool: ProviderPool) -> Int {
        pool.members.filter { [.available, .running, .noQuota, .usageUnknown].contains($0.state) }.count
    }

    /// The Accounts header's trailing words (web's `PoolGauge`): the account the next session starts
    /// on; with none, when the first spent one frees up; with none that can run, why.
    public static func headline(_ pool: ProviderPool, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        if let next = pool.members.first(where: \.next) { return "Next: \(next.label)" }
        if let unavailable = pool.unavailable { return unavailable }
        if pool.members.contains(where: { $0.state == .spent }) {
            return spentNote(pool, now: now, timeZone: timeZone) ?? "All spent"
        }
        return "No account can run"
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
        case .usageUnknown: return PoolStatus(label: "Unavailable · usage unreadable", tone: .neutral)
        case .disabled: return PoolStatus(label: "Disabled", tone: .neutral)
        case .noQuota, .unknown: return PoolStatus(label: "No quota reported", tone: .neutral)
        }
    }

    /// The gauge a member's row shows (web's `memberQuota`): the window that stopped a spent member,
    /// else the 5-hour window the pool ranks its members by. Nil when it reports no quota.
    public static func memberQuota(_ member: PoolMember) -> PlanUsageRow? {
        guard let rows = member.planUsage?.rows, !rows.isEmpty else { return nil }
        if member.state == .spent, let binding = rows.first(where: { $0.window.utilization >= 100 }) {
            return binding
        }
        return rows.first(where: { $0.key == "fiveHour" }) ?? rows.first
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
