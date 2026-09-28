import Foundation

/// Shared Codex pools as the new-session picker and the composer read them — the native port of web's
/// `lib/sharedPools.ts` adapter (`sharedPoolAsProviderPool`); keep the two in sync. A shared pool is
/// drawn as an account pool whose members are its keys, so the Providers page, the picker and the
/// composer take it exactly as they take one of the user's own Claude pools. Which key a session
/// starting now runs on (`SharedPoolKey.next`), where each one stands and what the others spent of
/// its cap are the server's answers, read off `SharedPool`; nothing here re-derives them.
public enum SharedPools {
    /// `sk-…AB12` is all anyone is shown of a key; the model space it runs is the Codex CLI's.
    public static let keyPresetSlug = "openai"

    /// A shared pool in the shape an account pool is drawn in — its keys as members. `shared` carries
    /// the whole view, which is what tells the two kinds apart: a shared pool runs Codex on one of its
    /// keys rather than Claude on one of the viewer's subscriptions.
    public static func asProviderPool(_ pool: SharedPool) -> ProviderPool {
        let members = pool.keys.map { key -> PoolMember in
            // Where a key stands, in web's precedence: refused by OpenAI outranks switched off,
            // which outranks the others' cap (`SharedPoolPage.keyState`).
            let state = SharedPoolPage.keyState(key)
            return PoolMember(
                id: key.id,
                slug: key.id,
                label: key.label,
                presetSlug: keyPresetSlug,
                enabled: key.enabled,
                planUsage: keyWindow(key, in: pool),
                state: memberState(state),
                // A stopped key has a reset, and it is a date rather than a window's clock: OpenAI's
                // own mark when the gateway set one (`spentUntil`), else the month's end — the same
                // choice web's `sharedPoolAsProviderPool` makes for the same key.
                resetsAt: state == .spent ? (key.spentUntil ?? pool.window?.end) : nil,
                next: key.next,
                key: key)
        }
        let free = members.contains { $0.state == .available || $0.state == .running }
        let runnable = pool.keys.contains { $0.enabled && $0.state == .active }
        return ProviderPool(
            id: pool.id,
            slug: pool.slug,
            label: pool.label,
            // A pool nobody can start on until its first stop lets go — the earliest of them, an account
            // pool's own rule, which is the month turning for a cap and OpenAI's own mark for a key it
            // took out of budget. Web's `sharedPoolAsProviderPool` reads the same members the same way.
            resetsAt: free ? nil : SharedPoolPage.firstReset(pool),
            unavailable: runnable ? nil : pool.keys.isEmpty ? "No keys" : "No key can run",
            members: members,
            shared: pool)
    }

    public static func asProviderPools(_ pools: [SharedPool]) -> [ProviderPool] {
        pools.map(asProviderPool)
    }

    /// A key's state in this client's member vocabulary. The pool's own states are the keys'
    /// (`PoolKeyState`), so a key OpenAI refused is a member whose key was refused (`refused`) and a
    /// key that cannot run now — the others' cap used up, or OpenAI's own mark on it — is `spent`;
    /// the words for each are the pool's to say.
    static func memberState(_ state: SharedPoolPage.KeyState) -> PoolMemberState {
        switch state {
        case .invalid: return .refused
        case .disabled: return .disabled
        case .spent: return .spent
        case .running: return .running
        case .available: return .available
        }
    }

    /// A capped key's gauge, in the shape a quota bar reads (web's `keyWindow`): the share of its cap
    /// the others spent this month, which resets with the month. A key with no cap has no gauge.
    static func keyWindow(_ key: SharedPoolKey, in pool: SharedPool) -> PlanUsageSnapshot? {
        guard let percent = SharedPoolPage.capPercent(key) else { return nil }
        return PlanUsageSnapshot(provider: "codex", primary: PlanUsageWindow(
            utilization: Double(percent),
            resetsAt: pool.window?.end,
            windowDurationMins: 30 * 24 * 60))
    }
}
