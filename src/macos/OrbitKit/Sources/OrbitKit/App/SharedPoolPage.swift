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
/// web source); what the page makes of the pool's numbers is worked out here the way web's
/// `lib/sharedPools.ts` works it out, and is tested. Which key is next, which one a session is running
/// on and who may do what are the server's answers, so nothing here re-derives them.
public enum SharedPoolPage {
    // MARK: head

    /// The head's title: what the pool is, where the web's line under the pool's name starts.
    public static let title = "Shared Codex pool"
    public static let sharedChip = "SHARED"
    public static let addKey = "Add a key"

    /// "4 members · 2 of 5 keys available".
    public static func subtitle(_ pool: SharedPool) -> String {
        "\(plural(pool.people.count, "member")) · \(availableCount(pool)) of \(plural(pool.keys.count, "key")) available"
    }

    // MARK: keys

    public static let keysHeader = "Keys"
    /// The web's sentence under the pool's name; on a phone, the Keys section's footer.
    public static let keysFooter = "Each session starts on the key with the most room, and stays on it until that one runs out."
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
    /// outranks switched off: it is the one somebody has to act on.
    public enum KeyState: Equatable, Sendable {
        case invalid, disabled, atCap, running, available
    }

    public static func keyState(_ key: SharedPoolKey) -> KeyState {
        if key.state == .invalid { return .invalid }
        if !key.enabled || key.state == .disabled { return .disabled }
        if atCap(key) { return .atCap }
        return key.running ? .running : .available
    }

    /// A key's status tag (web's `memberStatus` for a key): a capped key comes back on the first of the
    /// next month, which is said as a date.
    public static func status(_ key: SharedPoolKey, in pool: SharedPool) -> PoolStatus {
        switch keyState(key) {
        case .invalid: return PoolStatus(label: "Invalid", tone: .danger)
        case .disabled: return PoolStatus(label: "Disabled", tone: .neutral)
        case .atCap:
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

    /// The "2" of "2 of 5 keys available": the keys a session of the caller's could start on now.
    public static func availableCount(_ pool: SharedPool) -> Int {
        pool.keys.filter { [.available, .running].contains(keyState($0)) }.count
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

    /// The key a session the caller starts now runs on — the server's answer.
    public static func nextKey(_ pool: SharedPool) -> SharedPoolKey? {
        pool.keys.first(where: \.next)
    }

    /// The Keys header's trailing words (web's `PoolGauge`): the key the next session starts on; with
    /// none, why — none in the pool, none that can run — or, when every one that can is capped, when
    /// the month turns.
    public static func keysHeadline(_ pool: SharedPool) -> String {
        if let next = nextKey(pool) { return "Next: \(next.label)" }
        if pool.keys.isEmpty { return "No keys" }
        if !pool.keys.contains(where: { $0.enabled && $0.state == .active }) { return "No key can run" }
        if pool.keys.contains(where: { keyState($0) == .atCap }) {
            guard let end = pool.window?.end, let date = capReset(end) else { return "All at cap" }
            return "All at cap · resets \(date)"
        }
        return "No key can run"
    }

    // MARK: people

    public static let membersHeader = "Members"
    public static let shareHeader = "Share of this month’s use"
    public static let addMembers = "Add members"
    public static let adminChip = "ADMIN"
    public static let addMembersNote = "They see it on their Providers page and in the session picker, and can start sessions on it."
    public static let emailPlaceholder = "name@example.com"
    public static let add = "Add"
    public static let makeAdmin = "Make admin"
    public static let makeMember = "Make member"
    public static let removeFromPool = "Remove from pool"
    public static let removePersonNote = "Their keys leave with them."

    public static func addMembersTitle(_ pool: SharedPool) -> String { "Add members to \(pool.label)" }
    public static func added(_ pool: SharedPool) -> String { "Added to \(pool.label)" }
    public static func removePersonTitle(_ person: SharedPoolPerson, in pool: SharedPool) -> String {
        "Remove \(person.name) from \(pool.label)?"
    }

    /// "2 keys · 23 sessions" / "No key · 6 sessions": what a person put in, and how much they ran on
    /// the pool this month. Having no key is no bar to running on it.
    public static func personLine(_ person: SharedPoolPerson) -> String {
        "\(person.keys == 0 ? "No key" : plural(person.keys, "key")) · \(plural(person.sessions, "session"))"
    }

    /// A person's share of what the pool ran this month, 0…100. Nothing run yet reads 0 for everyone.
    public static func share(_ person: SharedPoolPerson, in pool: SharedPool) -> Int {
        let total = pool.people.reduce(0) { $0 + $1.usage.costUsd }
        guard total > 0 else { return 0 }
        return min(100, max(0, Int((person.usage.costUsd / total * 100).rounded())))
    }

    /// Whether the caller manages `person`: an admin, over anyone but themselves and the pool's creator.
    public static func canManage(_ person: SharedPoolPerson, in pool: SharedPool) -> Bool {
        isAdmin(pool) && !person.you && !person.creator
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
    public static let delete = "Delete"
    public static let leave = "Leave"

    public static func deleteTitle(_ pool: SharedPool) -> String { "Delete \(pool.label)?" }
    public static func leaveTitle(_ pool: SharedPool) -> String { "Leave \(pool.label)?" }

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

    static func plural(_ n: Int, _ one: String) -> String { "\(n) \(one)\(n == 1 ? "" : "s")" }
}
