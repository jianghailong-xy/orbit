import Foundation

/// The Infrastructure page's Account pools and API keys (`Infrastructure` has the rest of it), in the
/// web page's words (`SettingsCopyParityTests` reads them back out of the web source). Adding or
/// editing a key stays on the web; a pool's row opens the pool's page, where a shared pool is run from.
public enum ProvidersOverview {
    public static let accountPools = "Account pools"
    public static let accountPoolsDetail = "Several accounts under one name."
    public static let apiKeys = "API keys"
    public static let apiKeysDetail = "On your account and usable from every machine — billed per token."
    public static let noKeys = "No keys yet"
    public static let editOnWeb = "Adding or changing a key happens on the web."
    /// A pool's page when the pool has gone — deleted, or left — as the web page says it.
    public static let poolGone = "That pool no longer exists."
    /// A key's page when the key has gone, as the web's edit page says it.
    public static let keyGone = "That provider no longer exists."

    /// The line under a key's name: its default model — or, for a DeepSeek Harness key, whose models
    /// come from the runtime itself and which has no default, where it runs.
    public static func keyLine(_ key: ConfiguredProvider) -> String? {
        if let model = key.defaultModel, !model.isEmpty { return model }
        return key.runtime == "dsh" ? "Runs on DeepSeek Harness" : nil
    }

    /// A pool of Claude keys' value: why nothing in it can run, when that is so; otherwise how many of its
    /// accounts a session could start on now, in the words a phone gives the web card's head ("2 of 3
    /// available" — the web drops "accounts" at that width to keep the pool's name).
    public static func poolSummary(_ pool: ProviderPool) -> String {
        if let unavailable = pool.unavailable { return unavailable }
        return "\(ProviderPools.readyCount(pool)) of \(pool.members.count) available"
    }

    // MARK: a Codex pool, by who reads it (web's `PoolCard` head, docs/mocks/account-pool-access/03-6)

    /// Whether the row wears SHARED: anybody but its owner can use the pool — which is so for everybody it
    /// was shared with.
    public static func isShared(_ pool: ProviderPool) -> Bool {
        pool.shared.map(SharedPoolPage.hasPeople) ?? false
    }

    /// A Codex pool's line under its name: to somebody its owner added, whose it is and how many keys they
    /// can run on — its accounts and its gauge are on its page; a pool its owner keeps to themselves, "Just
    /// me" and how many of its accounts are left to run on; once shared, how many of them a session could
    /// start on now, beside SHARED.
    public static func codexPoolLine(_ pool: ProviderPool) -> String {
        if ProviderPools.readByMember(pool) {
            let owner = pool.shared.flatMap(SharedPoolPage.owner)?.name ?? ""
            return "\(CodexPoolPage.whose(owner)) · \(pool.members.count) \(ProviderPools.memberNoun(pool, pool.members.count))"
        }
        if isShared(pool) { return ProviderPools.availability(pool) }
        return "\(CodexPoolPage.justMe) · \(ProviderPools.availability(pool))"
    }

    /// A Codex pool's value at the row's end: its head's gauge (web's `PoolGauge`) less the account's name,
    /// which a phone's row has no room for — the tightest window of the account the next session starts on
    /// — or, with none to start on, when the first frees up or why. Nil to somebody its owner added: their
    /// gauge is on the pool's page.
    public static func codexPoolValue(_ pool: ProviderPool, now: Date = Date(),
                                      timeZone: TimeZone = .current) -> PoolStatus? {
        guard !ProviderPools.readByMember(pool) else { return nil }
        return ProviderPools.headGauge(pool)
            ?? PoolStatus(label: ProviderPools.headline(pool, now: now, timeZone: timeZone), tone: .neutral)
    }
}
