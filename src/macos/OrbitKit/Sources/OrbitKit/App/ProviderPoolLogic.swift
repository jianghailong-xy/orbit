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
/// (`PoolMember.next`) and when a spent pool frees up (`ProviderPool.resetsAt`) are the server's
/// answers, the claim's own selector asked the way the claim asks it, so nothing here re-derives
/// them.
public enum ProviderPools {
    /// The picker row the pools' own accounts fold away under (web's `NewSessionProviderHero`).
    public static let pinAccountLabel = "Pin a specific account"
    /// The picker's section of pools, in the words the /providers page heads its pools with (web's
    /// `AccountPools`).
    public static let sectionTitle = "Account pools"
    public static let sectionFooter = "Several Claude subscriptions under one name — each session "
        + "starts on the account with the most room in its 5-hour window."

    /// A member that can take work now — what "N of M accounts available" counts. One that reports
    /// no quota counts: the claim still picks it, just last.
    public static func canTakeWork(_ member: PoolMember) -> Bool {
        switch member.state {
        case .available, .running, .noQuota: return true
        case .refused, .disabled, .spent, .unknown: return false
        }
    }

    /// The pools as providers the pickers and the composer resolve like any configured one: a pool
    /// runs on its members' Claude subscriptions, whose models are the Claude CLI's own — the model
    /// space an Anthropic key has — and it carries no quota of its own (each member has one).
    public static func asProviders(_ pools: [ProviderPool]) -> [ConfiguredProvider] {
        pools.map { pool in
            ConfiguredProvider(slug: pool.slug, label: pool.label, runtime: "claude",
                               presetSlug: "anthropic", modelsFromRuntime: true)
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

    /// What the account beside the quota says about itself when asked (a tooltip on web).
    public static func accountHelp(pool: ProviderPool, account: PoolAccount) -> String {
        account.current
            ? "\(pool.label) is running this session on \(account.member.label)"
            : "A session on \(pool.label) starts on \(account.member.label) — the account with the most room right now"
    }

    /// Why the new-session picker greys `pool` out, or nil while any of its accounts can take work.
    /// With none that can ("0 of N available") the reason is the pool head's on web (`PoolGauge`):
    /// when every account that can run is spent, when the first of them frees up — the earliest
    /// reset, not the latest — and otherwise that no account can run at all.
    public static func unavailableReason(_ pool: ProviderPool, now: Date = Date(),
                                         timeZone: TimeZone = .current) -> String? {
        guard !pool.members.contains(where: canTakeWork) else { return nil }
        guard pool.members.contains(where: { $0.state == .spent }) else { return "No account can run" }
        guard let resetsAt = pool.resetsAt,
              let time = formatResetTime(resetsAt, now: now, timeZone: timeZone) else { return "All spent" }
        return "All spent · resets \(time)"
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
