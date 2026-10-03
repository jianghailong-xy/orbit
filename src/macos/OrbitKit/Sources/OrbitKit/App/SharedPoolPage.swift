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

/// What a Codex pool's page says of its API keys and its people — web's key rows (`KeyRow` in
/// components/AccountPools.tsx), its people's rows and menus (components/SharedPool.tsx) and the pool
/// view's own answers (`lib/sharedPools.ts`) — for the page `CodexPoolPage` draws. Every sentence here is the
/// web's (`SharedPoolCopyParityTests` reads them back out of the web source); what the page makes of the
/// pool's numbers is worked out here the way web's `lib/sharedPools.ts` works it out, and is tested. Which
/// key is next, which one a session is running on and who may do what are the server's answers, so nothing
/// here re-derives them.
public enum SharedPoolPage {
    // MARK: keys

    /// What stopped the keys that cannot run, when none of them can: the month's caps, or OpenAI's own
    /// out-of-budget mark (web's `PoolGauge` chooses between the same two).
    public static let allAtCapWords = "All at cap"
    public static let allOutOfBudgetWords = "All out of budget"
    public static let noKeys = "No keys yet — no session can start on this pool until one is added."
    public static let you = "you"
    public static let nextChip = "NEXT"
    public static let replaceKey = "Replace key"
    public static let disableKey = "Disable"
    public static let enableKey = "Enable"
    public static let remove = "Remove"
    /// What removing a key does, asked before it is done.
    public static let removeKeyNote = "It is deleted from the Orbit server, and no session runs on it again."

    public static func removeKeyTitle(_ key: SharedPoolKey) -> String { "Remove \(key.label)?" }
    public static func removedKey(_ key: SharedPoolKey) -> String { "\(key.label) is out of the pool" }

    /// "Wikova · sk-…AB12": whose key it is, and all anyone is shown of it.
    public static func keyLine(_ key: SharedPoolKey) -> String {
        "\(key.contributor.name) · \(key.fingerprint)"
    }

    /// Where a key stands for a session the caller starts now (web's `keyState`). Refused by OpenAI
    /// outranks switched off: it is the one somebody has to act on. Out of budget outranks the cap: it
    /// is OpenAI's own answer, and it holds for the key's contributor where the cap only holds for the
    /// others.
    public enum KeyState: Equatable, Sendable {
        case invalid, disabled, spent, running, available
    }

    public static func keyState(_ key: SharedPoolKey) -> KeyState {
        if key.state == .invalid { return .invalid }
        if !key.enabled || key.state == .disabled { return .disabled }
        if key.spentUntil != nil || atCap(key) { return .spent }
        return key.running ? .running : .available
    }

    /// A key's status tag (web's `memberStatus` for a key): a capped key comes back on the first of the
    /// next month, and one OpenAI put out of budget at its own mark — both said as a date.
    public static func status(_ key: SharedPoolKey, in pool: SharedPool) -> PoolStatus {
        switch keyState(key) {
        case .invalid: return PoolStatus(label: "Invalid", tone: .danger)
        case .disabled: return PoolStatus(label: "Disabled", tone: .neutral)
        case .spent:
            if let until = key.spentUntil {
                guard let date = capReset(until) else { return PoolStatus(label: "Out of budget", tone: .warning) }
                return PoolStatus(label: "Out of budget · resets \(date)", tone: .warning)
            }
            guard let end = pool.window?.end, let date = capReset(end) else {
                return PoolStatus(label: "At cap", tone: .warning)
            }
            return PoolStatus(label: "At cap · resets \(date)", tone: .warning)
        case .running: return PoolStatus(label: "Running now", tone: .brand)
        case .available: return PoolStatus(label: "Available", tone: .success)
        }
    }

    /// Why an invalid key is out, and who can put it back: a line of the row's own, since it runs
    /// longer than a status has room for.
    public static func invalidReason(_ key: SharedPoolKey, in pool: SharedPool) -> String? {
        guard key.state == .invalid else { return nil }
        return canReplace(key, in: pool)
            ? "Rejected by OpenAI — replace it with a working key to put it back in the pool."
            : "Rejected by OpenAI — only \(key.contributor.name) or the pool’s admins can replace it."
    }

    /// The others have spent the cap its contributor set this month — which stops everyone's sessions on
    /// it but its contributor's, whose own use is never capped.
    public static func atCap(_ key: SharedPoolKey) -> Bool {
        guard !key.contributor.you, let cap = key.shareCap else { return false }
        return (key.usage.othersCostUsd ?? 0) >= Double(cap)
    }

    /// Whether every key of `pool` that cannot run is out of budget rather than at its cap — which of
    /// the two the Keys header names when none of them can run (web's `allOutOfBudget`).
    public static func allOutOfBudget(_ pool: SharedPool) -> Bool {
        let stopped = pool.keys.filter { keyState($0) == .spent }
        return !stopped.isEmpty && stopped.allSatisfy { $0.spentUntil != nil }
    }

    /// The EARLIEST of some reset instants — one key or account free of its reason is enough for work to
    /// continue — parsed rather than compared as text, so the answer does not ride on how the server
    /// spells a time.
    static func earliest(_ resets: [String]) -> String? {
        resets.min { (RelativeTime.parse($0) ?? .distantFuture) < (RelativeTime.parse($1) ?? .distantFuture) }
    }

    /// "$12.40 of $50": what the others spent on the key this month, against the cap its contributor
    /// set. A key with no cap shows the spend alone.
    public static func money(_ key: SharedPoolKey) -> String {
        let spent = String(format: "$%.2f", key.usage.othersCostUsd ?? 0)
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

    // MARK: people

    public static let adminChip = "ADMIN"
    public static let makeAdmin = "Make admin"
    public static let makeMember = "Make member"
    public static let removeFromPool = "Remove from pool"
    public static let removePersonNote = "Their keys leave with them."

    public static func removePersonTitle(_ person: SharedPoolPerson, in pool: SharedPool) -> String {
        "Remove \(person.name) from \(pool.label)?"
    }

    /// "2 keys · 23 sessions" / "No key · 6 sessions": what a person put in, and how much they ran on
    /// the pool this month — what anybody but its owner reads under each name. Having no key is no bar to
    /// running on it.
    public static func personLine(_ person: SharedPoolPerson) -> String {
        "\(person.keys == 0 ? "No key" : plural(person.keys, "key")) · \(plural(person.sessions, "session"))"
    }

    /// A person's share of what the pool ran this month, 0…100. Nothing run yet reads 0 for everyone.
    public static func share(_ person: SharedPoolPerson, in pool: SharedPool) -> Int {
        let total = pool.people.reduce(0) { $0 + $1.usage.costUsd }
        guard total > 0 else { return 0 }
        return min(100, max(0, Int((person.usage.costUsd / total * 100).rounded())))
    }

    // MARK: whose it is

    /// Whose the pool is: the person who made it, whose ChatGPT accounts are in it and who says who else can
    /// use it (web's `poolOwner`).
    public static func owner(_ pool: SharedPool) -> SharedPoolPerson? { pool.people.first(where: \.creator) }

    /// Whether the caller is the pool's owner — the page drawn for them — rather than one of the people they
    /// added (web's `ownsPool`).
    public static func ownsPool(_ pool: SharedPool) -> Bool { pool.people.contains { $0.you && $0.creator } }

    /// "Me and people I add" rather than "Just me": anybody is in it besides its owner (web's `hasPeople`).
    public static func hasPeople(_ pool: SharedPool) -> Bool { pool.people.count > 1 }

    // MARK: what the caller may do

    public static func isAdmin(_ pool: SharedPool) -> Bool { pool.viewerRole == .admin }

    /// Admins always; members while the pool lets them.
    public static func canAddKey(_ pool: SharedPool) -> Bool { isAdmin(pool) || pool.membersCanAdd }

    /// Its contributor, or an admin.
    public static func canRemove(_ key: SharedPoolKey, in pool: SharedPool) -> Bool {
        key.contributor.you || isAdmin(pool)
    }

    /// The same two paste a working key over one OpenAI refused.
    public static func canReplace(_ key: SharedPoolKey, in pool: SharedPool) -> Bool {
        canRemove(key, in: pool)
    }

    /// Only its contributor switches a key off and on.
    public static func canSwitch(_ key: SharedPoolKey) -> Bool { key.contributor.you }

    // MARK: faces

    /// The colours a person's initial is drawn on (web's `personColor`), one per place in the pool's
    /// own order — creator first, then by when they joined — so a person wears the same one beside every
    /// key they put in and in Members.
    public static let avatarPalette = ["#3370FF", "#16A34A", "#DB2777", "#EA580C", "#7C3AED", "#0D9488", "#CA8A04", "#475569"]

    public static func avatarHex(_ userId: String, in pool: SharedPool) -> String {
        let key = PublicID.storageKey(userId)
        let at = pool.people.firstIndex { PublicID.storageKey($0.userId) == key } ?? pool.people.count
        return avatarPalette[at % avatarPalette.count]
    }

    /// The letter in a person's circle.
    public static func initial(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        return trimmed.first.map { String($0).uppercased() } ?? "?"
    }

    // MARK: words

    /// When a cap starts again, as a date (web's `formatCapReset`): always the first of a month, in UTC,
    /// which a weekday would not say. Nil for an unreadable time.
    public static func capReset(_ iso: String) -> String? {
        guard let at = RelativeTime.parse(iso) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "MMM d"
        return formatter.string(from: at)
    }

    static func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String {
        "\(n) \(n == 1 ? one : many ?? "\(one)s")"
    }

    /// `a`, `a and b`, `a, b and c`: names in a sentence (web's `listOf`).
    static func listOf(_ items: [String]) -> String {
        guard let last = items.last, items.count > 1 else { return items.first ?? "" }
        return "\(items.dropLast().joined(separator: ", ")) and \(last)"
    }
}
