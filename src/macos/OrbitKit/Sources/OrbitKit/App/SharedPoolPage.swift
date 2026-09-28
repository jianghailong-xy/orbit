import Foundation

/// A pool member's status tag: its words, and the colour they are drawn in — web's antd `Tag` colours
/// (green, processing, orange, red, default).
public struct PoolStatus: Equatable, Sendable {
    public enum Tone: Equatable, Sendable {
        case success, brand, warning, danger, neutral
    }

    public let label: String
    public let tone: Tone

    public init(label: String, tone: Tone) {
        self.label = label
        self.tone = tone
    }
}

/// A shared pool's page on iOS — Settings → Providers → a shared pool — in the web page's five blocks
/// and words: what the pool is and "Add a key", its keys, its people, its two rules, and deleting or
/// leaving it. Every sentence here is the web's (`SharedPoolCopyParityTests` reads them back out of the
/// web source); what the page makes of the pool's numbers is worked out here, where it is tested.
public enum SharedPoolPage {
    // MARK: head

    /// The head's title: what the pool is, where the web's line under the pool's name starts.
    public static let title = "Shared Codex pool"
    public static let sharedChip = "SHARED"
    public static let addKey = "Add a key"

    /// "4 members · 2 of 5 keys available".
    public static func subtitle(_ pool: SharedPool) -> String {
        "\(members(pool.people.count)) · \(availableCount(pool)) of \(keys(pool.keys.count)) available"
    }

    // MARK: keys

    public static let keysHeader = "Keys"
    /// The web's sentence under the pool's name; on a phone, the Keys section's footer.
    public static let keysFooter = "Each session starts on the key with the most room, and stays on it until that one runs out."
    public static let noKeys = "No keys yet — no session can start on this pool until one is added."
    public static let you = "you"
    public static let nextChip = "NEXT"
    public static let replaceKey = "Replace key"
    public static let removeKey = "Remove"
    public static let removeFromPool = "Remove from this pool"
    public static let disableKey = "Disable"
    public static let enableKey = "Enable"

    /// The Keys header's trailing words: the key a session starting now runs on.
    public static func nextLine(_ key: SharedPoolKey) -> String { "Next: \(key.label)" }

    /// "Wikova · sk-…AB12": whose key it is, and all anyone is shown of it.
    public static func keyLine(_ key: SharedPoolKey) -> String {
        "\(key.contributor.name) · \(key.fingerprint)"
    }

    /// A key's status tag, in the order the claim reads a key: switched off or refused by OpenAI, it
    /// cannot run at all; spent to its cap, the others cannot run on it until the month turns.
    public static func status(_ key: SharedPoolKey, in pool: SharedPool, now: Date = Date(),
                              timeZone: TimeZone = .current) -> PoolStatus {
        if !key.enabled { return PoolStatus(label: "Disabled", tone: .neutral) }
        switch key.state {
        case .invalid: return PoolStatus(label: "Invalid", tone: .danger)
        case .disabled: return PoolStatus(label: "Disabled", tone: .neutral)
        case .active, .unknown: break
        }
        if atCap(key) {
            guard let end = pool.window?.end,
                  let time = resetTime(end, now: now, timeZone: timeZone) else {
                return PoolStatus(label: "At cap", tone: .warning)
            }
            return PoolStatus(label: "At cap · resets \(time)", tone: .warning)
        }
        return PoolStatus(label: "Available", tone: .success)
    }

    /// Why an invalid key is out, and who can put it back: a line of the row's own, since it runs
    /// longer than a status has room for.
    public static func invalidReason(_ key: SharedPoolKey, in pool: SharedPool) -> String? {
        guard key.state == .invalid else { return nil }
        return canReplace(key, in: pool)
            ? "Rejected by OpenAI — replace it with a working key to put it back in the pool."
            : "Rejected by OpenAI — only \(key.contributor.name) can replace it."
    }

    /// The others have spent the cap its contributor set this month. Its contributor's own sessions
    /// are never capped, which the claim reads; the row says what the key is to everyone else.
    public static func atCap(_ key: SharedPoolKey) -> Bool {
        guard let cap = key.shareCap else { return false }
        return (key.usage.othersCostUsd ?? 0) >= Double(cap)
    }

    /// A key a session could start on now: switched on, not refused by OpenAI, not spent to its cap —
    /// the "2" of "2 of 5 keys available".
    public static func canRun(_ key: SharedPoolKey) -> Bool {
        key.enabled && key.state == .active && !atCap(key)
    }

    public static func availableCount(_ pool: SharedPool) -> Int {
        pool.keys.filter(canRun).count
    }

    /// "$12.40 of $50": what the others spent on the key this month, against the cap its contributor
    /// set. A key with no cap shows the spend alone.
    public static func money(_ key: SharedPoolKey) -> String {
        let spent = dollars(key.usage.othersCostUsd ?? 0)
        guard let cap = key.shareCap else { return spent }
        return "\(spent) of $\(cap)"
    }

    /// The key's gauge, 0…100: how much of its cap the others have spent. Nil for a key with no cap.
    public static func capPercent(_ key: SharedPoolKey) -> Int? {
        guard let cap = key.shareCap else { return nil }
        guard cap > 0 else { return 100 }
        let spent = key.usage.othersCostUsd ?? 0
        return min(100, max(0, Int((spent / Double(cap) * 100).rounded())))
    }

    /// The key a session of the caller's starting now runs on — the claim's own rule
    /// (apiserver `pool-key-select.ts`), asked with no key to stick to: with "Own key first", a key of
    /// the caller's own that can run; then the most room left, a key with no cap (or the caller's own)
    /// having all of it; then the lower id. Nil when none can run for them.
    public static func nextKey(_ pool: SharedPool) -> SharedPoolKey? {
        let me = pool.people.first(where: \.you).map { PublicID.storageKey($0.userId) }
        func mine(_ key: SharedPoolKey) -> Bool { PublicID.storageKey(key.contributor.userId) == me }
        func room(_ key: SharedPoolKey) -> Double {
            guard !mine(key), let cap = key.shareCap else { return .infinity }
            return Double(cap) - (key.usage.othersCostUsd ?? 0)
        }
        let usable = pool.keys.filter { $0.enabled && $0.state == .active && room($0) > 0 }
        return usable.min { a, b in
            let rank = (pool.ownKeyFirst && mine(a) ? 0 : 1, pool.ownKeyFirst && mine(b) ? 0 : 1)
            if rank.0 != rank.1 { return rank.0 < rank.1 }
            let left = room(a), right = room(b)
            if left != right { return left > right }
            return PublicID.storageKey(a.id) < PublicID.storageKey(b.id)
        }
    }

    // MARK: people

    public static let membersHeader = "Members"
    public static let shareHeader = "Share of this month’s use"
    public static let addMembers = "Add members"
    public static let adminChip = "ADMIN"
    public static let addMembersPrompt = "Add someone by the email of their Orbit account."
    public static let email = "Email"
    public static let add = "Add"

    /// "2 keys" / "No key": what a person has put in. Having none is no bar to running on the pool.
    public static func personLine(_ person: SharedPoolPerson) -> String {
        person.keys == 0 ? "No key" : keys(person.keys)
    }

    /// A person's share of what the pool ran this month, 0…100. Nothing run yet reads 0 for everyone.
    public static func share(_ person: SharedPoolPerson, in pool: SharedPool) -> Int {
        let total = pool.people.reduce(0) { $0 + $1.usage.costUsd }
        guard total > 0 else { return 0 }
        return min(100, max(0, Int((person.usage.costUsd / total * 100).rounded())))
    }

    // MARK: rules

    public static let rulesHeader = "Rules"
    public static let membersCanAdd = "Members can add keys"
    public static let ownKeyFirst = "Own key first"
    public static let ownKeyFirstHint = "A member’s sessions start on a key they added while it has room, then move on to the others’."
    public static let setByAdmins = "Set by the pool’s admins"

    public static func membersCanAddHint(_ pool: SharedPool) -> String {
        "Anyone in \(pool.label) can put an OpenAI API key in. Off: only admins can."
    }

    // MARK: delete / leave

    public static let deletePool = "Delete pool"
    public static let deletePoolNote = "Its keys are removed from the Orbit server and no session can run on it."
    public static let leavePool = "Leave pool"
    public static let leavePoolNote = "Your keys leave with you."

    public static func deleteTitle(_ pool: SharedPool) -> String { "Delete \(pool.label)?" }
    public static func leaveTitle(_ pool: SharedPool) -> String { "Leave \(pool.label)?" }
    public static func removeTitle(_ key: SharedPoolKey, in pool: SharedPool) -> String {
        "Remove \(key.label) from \(pool.label)?"
    }

    // MARK: what the caller may do

    public static func isAdmin(_ pool: SharedPool) -> Bool { pool.viewerRole == .admin }

    /// Admins always; members while the pool lets them.
    public static func canAddKey(_ pool: SharedPool) -> Bool { isAdmin(pool) || pool.membersCanAdd }

    /// Its contributor, or an admin.
    public static func canRemove(_ key: SharedPoolKey, in pool: SharedPool) -> Bool {
        key.contributor.you || isAdmin(pool)
    }

    /// A key OpenAI refused, to its contributor or an admin.
    public static func canReplace(_ key: SharedPoolKey, in pool: SharedPool) -> Bool {
        key.contributor.you || isAdmin(pool)
    }

    /// Only its contributor switches a key off and on.
    public static func canSwitch(_ key: SharedPoolKey) -> Bool { key.contributor.you }

    // MARK: faces

    /// The colours a person's initial is drawn on, by their place in the pool: whoever made it first.
    public static let avatarPalette = ["#3370FF", "#16A34A", "#DB2777", "#EA580C", "#7C3AED", "#0891B2"]

    /// The colour of `userId`'s circle in `pool`, the same beside their keys as in Members.
    public static func avatarHex(_ userId: String, in pool: SharedPool) -> String {
        let key = PublicID.storageKey(userId)
        guard let at = pool.people.firstIndex(where: { PublicID.storageKey($0.userId) == key }) else {
            return "#8E8E93"
        }
        return avatarPalette[at % avatarPalette.count]
    }

    /// The letter in a person's circle.
    public static func initial(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        return trimmed.first.map { String($0).uppercased() } ?? "?"
    }

    // MARK: words

    /// When a month's caps come back, as the page says it: `02:00` within a day, `Thu 02:00` within the
    /// week, and `Oct 1` beyond it, where a weekday alone would be ambiguous. Nil for an unreadable time.
    public static func resetTime(_ iso: String, now: Date = Date(), timeZone: TimeZone = .current) -> String? {
        guard let at = RelativeTime.parse(iso) else { return nil }
        let away = at.timeIntervalSince(now)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = away < 24 * 60 * 60 ? "HH:mm" : away < 7 * 24 * 60 * 60 ? "EEE HH:mm" : "MMM d"
        return formatter.string(from: at)
    }

    static func dollars(_ amount: Double) -> String { String(format: "$%.2f", amount) }

    static func members(_ n: Int) -> String { "\(n) member\(n == 1 ? "" : "s")" }

    static func keys(_ n: Int) -> String { "\(n) key\(n == 1 ? "" : "s")" }
}
