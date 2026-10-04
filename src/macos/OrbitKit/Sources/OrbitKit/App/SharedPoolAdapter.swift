import Foundation

/// Shared Codex pools as the new-session picker and the composer read them — the native port of web's
/// `lib/sharedPools.ts` adapter (`sharedPoolAsProviderPool`); keep the two in sync. A pool somebody was
/// added to is drawn as an account pool whose members are its ChatGPT accounts and its keys — the
/// accounts first, as every session of the pool runs on them while one can run (2026-10-03) — so the
/// Providers page, the picker and the composer take it exactly as they take one of the user's own Claude
/// pools. Which account or key a session starting now runs on (`CodexLogin.next`, `SharedPoolKey.next`),
/// where each one stands and what the others spent of a key's cap are the server's answers, read off
/// `SharedPool`; nothing here re-derives them.
public enum SharedPools {
    /// `sk-…AB12` is all anyone is shown of a key; the model space it runs is the Codex CLI's.
    public static let keyPresetSlug = "openai"

    /// A pool in the shape an account pool is drawn in — its ChatGPT accounts, then its keys, as members.
    /// `shared` carries the whole view, which is what tells the kinds apart: a shared pool runs Codex on
    /// one of its keys rather than Claude on one of the viewer's subscriptions.
    public static func asProviderPool(_ pool: SharedPool) -> ProviderPool {
        let members = loginMembers(pool) + keyMembers(pool)
        let free = members.contains { !AccountPause.isPaused($0.pausedUntil) && ($0.state == .available || $0.state == .running) }
        // Whether waiting brings anything back: an account that is not signed out — a spent one comes back
        // by the hour — or a key OpenAI still takes that is switched on (web's `keysPool`).
        let revives = pool.logins.contains { $0.state != "SIGNED_OUT" }
            || pool.keys.contains { $0.enabled && $0.state == .active }
        let stops = members.compactMap { $0.state == .spent ? $0.resetsAt : nil }
        return ProviderPool(
            id: pool.id,
            slug: pool.slug,
            label: pool.label,
            // A pool nobody can start on until its first stop lets go — the earliest of them, an account
            // pool's own rule, which is the month turning for a cap, OpenAI's own mark for a key it took
            // out of budget, and an account's window resetting. Web's `sharedPoolAsProviderPool` reads the
            // same members the same way.
            resetsAt: free || stops.isEmpty ? nil : SharedPoolPage.earliest(stops),
            // Why nothing can run, in the words the owner's own pool page uses (web's `keysPool`):
            // 'Signed out' while the pool holds accounts and OpenAI refused every one, else the keys' own
            // answer. A pool holding no account — a shared pool (0321) among them, which migration 0371
            // lets one hold — is its keys' own answer alone.
            unavailable: revives ? nil
                : !pool.logins.isEmpty ? CodexLoginPool.signedOutWords
                : pool.keys.isEmpty ? (pool.shared ? "No keys" : CodexLoginPool.notSignedIn)
                : "No key can run",
            members: members,
            shared: pool,
            // What the pool runs on, from its own view: a member's page drawn from this needs it to know
            // the pool can hold ChatGPT accounts.
            engine: pool.engine)
    }

    /// The pool's ChatGPT accounts as its members, before its keys: every session of the pool starts on
    /// an account while one can run (2026-10-03). The account the server marked is the reader's next; the
    /// rest of what a row reads is the account's own (`CodexLoginPool`).
    static func loginMembers(_ pool: SharedPool) -> [PoolMember] {
        pool.logins.map { login in
            let state = CodexLoginPool.state(login)
            return PoolMember(
                id: "login:\(login.fingerprint)",
                slug: pool.slug,
                label: CodexLoginPool.name(login),
                presetSlug: keyPresetSlug,
                enabled: true,
                planUsage: login.usage,
                state: state,
                resetsAt: state == .spent ? (CodexLoginPool.spentUntil(login) ?? nil) : nil,
                next: login.next && !AccountPause.isPaused(login.pausedUntil),
                login: login, pausedUntil: login.pausedUntil)
        }
    }

    public static func asProviderPools(_ pools: [SharedPool]) -> [ProviderPool] {
        pools.map(asProviderPool)
    }

    /// A Codex pool of the user's own, read twice — its ChatGPT accounts with the providers (`own`, as the
    /// decoder draws them), its people and keys from `access` — drawn as one (web's `ownPoolWithAccess`):
    /// its accounts first, then its keys, in the order every session of the pool takes them — the owner's
    /// and the people they added's alike (2026-10-03). A key is the next session's only while none of the
    /// accounts can take one.
    public static func ownPoolWithAccess(_ own: ProviderPool, _ access: SharedPool) -> ProviderPool {
        let accounts = own.members
        let paused = accounts.contains { AccountPause.isPaused($0.pausedUntil) }
        let serverNext = access.logins.first(where: \.next)
        // The owner's login list stays oldest first; the shared read names the server's replacement.
        let nextAccount = paused
            ? accounts.first { $0.login?.fingerprint == serverNext?.fingerprint && !AccountPause.isPaused($0.pausedUntil) }
            : accounts.first(where: \.next) ?? accounts.first { $0.state == .available }
        let members = accounts.map { $0.marked(next: $0.id == nextAccount?.id) }
            + keyMembers(access).map { nextAccount == nil ? $0 : $0.marked(next: false) }
        let working = members.contains { !AccountPause.isPaused($0.pausedUntil) && ($0.state == .available || $0.state == .running) }
        let stops = members.compactMap { $0.state == .spent ? $0.resetsAt : nil }
        // Whether waiting brings anything back: not when every account is signed out and every key refused
        // or switched off.
        let revives = accounts.contains { $0.state != .signedOut }
            || access.keys.contains { $0.enabled && $0.state == .active }
        return ProviderPool(
            id: own.id,
            slug: own.slug,
            label: own.label,
            resetsAt: !working && !stops.isEmpty ? SharedPoolPage.earliest(stops) : nil,
            unavailable: revives ? nil
                : !accounts.isEmpty ? CodexLoginPool.signedOutWords
                : !access.keys.isEmpty ? "No key can run" : CodexLoginPool.notSignedIn,
            members: members,
            shared: access,
            engine: own.engine,
            login: own.login,
            logins: own.logins)
    }

    /// The pool's keys as its members, in the order a session of the reader's takes them: their own first
    /// while the pool starts a person's sessions on theirs (`ownKeyFirst`).
    static func keyMembers(_ pool: SharedPool) -> [PoolMember] {
        let keys = pool.ownKeyFirst
            ? pool.keys.filter(\.contributor.you) + pool.keys.filter { !$0.contributor.you }
            : pool.keys
        return keys.map { key -> PoolMember in
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
                next: key.next && !AccountPause.isPaused(key.pausedUntil),
                key: key, pausedUntil: key.pausedUntil)
        }
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

private extension PoolMember {
    /// The same member, the next session's or not.
    func marked(next: Bool) -> PoolMember {
        PoolMember(id: id, slug: slug, label: label, presetSlug: presetSlug, enabled: enabled, planUsage: planUsage,
                   state: state, resetsAt: resetsAt, next: next, key: key, login: login, pausedUntil: pausedUntil)
    }
}
