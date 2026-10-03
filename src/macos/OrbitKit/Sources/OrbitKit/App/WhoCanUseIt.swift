import Foundation

/// "Who can use it" (docs/mocks/account-pool-access/02) on a Codex pool's page — web's `WhoCanUseItCard`
/// (components/SharedPool.tsx) in its words. Its owner keeps the pool to themselves (Just me) or adds
/// people by the email of their Orbit account (Me and people I add). Who can use a pool is its people and
/// nothing else, so the switch adds people — through Share (`SharePool`) — or, after asking (`JustMine`),
/// takes every one of them out. Each person's row says what their sessions run on, how many keys they put
/// in, how many sessions they started this month and their share of this month's API key use, which
/// everyone in the pool sees. The people the owner added read all of it and change none of it. While a pool
/// shared with people has no API key, its owner is told at the foot of the card that none of them can start
/// a session on it yet (02, the boundary state), and offered Add an API key. `PoolAccessCopyParityTests`
/// holds every word here to the web source.
public struct WhoCanUseIt: Equatable, Sendable {
    public let pool: SharedPool
    /// How many ChatGPT accounts of its owner's the pool holds — nil for a pool made on the shared pools
    /// page, which never holds one.
    public let accounts: Int?

    public init(pool: SharedPool, accounts: Int?) {
        self.pool = pool
        self.accounts = accounts
    }

    /// The reader is the pool's owner.
    public var mine: Bool { SharedPoolPage.ownsPool(pool) }
    /// Anybody is in it besides its owner.
    public var people: Bool { SharedPoolPage.hasPeople(pool) }
    /// Everybody in it but its owner: the people they added.
    public var added: [SharedPoolPerson] { pool.people.filter { !$0.creator } }

    // MARK: the head

    public static let header = "Who can use it"
    public static let shareNote = "Share of this month’s API key use"
    public static let addPeople = "Add people"

    /// How many can use it, beside the header, once anybody but its owner can.
    public var count: Int? { people ? pool.people.count : nil }

    /// The words at the head's far end, once it is shared: what each row's share counts — and, to anybody
    /// but its owner, who set who can use it.
    public var note: String? {
        guard people else { return nil }
        return mine ? Self.shareNote : Self.setBy(SharedPoolPage.owner(pool)?.name ?? "")
    }

    public static func setBy(_ owner: String) -> String { "Set by \(owner) · share of this month’s API key use" }

    /// "Add people" is its owner's, once the pool is shared; before that, the switch is how they share it.
    public var addsPeople: Bool { mine && people }

    // MARK: Just me, or Me and people I add

    public enum Mode: Hashable, Sendable, CaseIterable {
        case justMe, withPeople

        public var label: String {
            switch self {
            case .justMe: return CodexPoolPage.justMe
            case .withPeople: return WhoCanUseIt.withPeople
            }
        }
    }

    public static let withPeople = "Me and people I add"

    /// What the switch says: the pool's people, which only a press — and the pool's next read — moves.
    public var mode: Mode { people ? .withPeople : .justMe }
    /// The switch is its owner's alone.
    public var showsMode: Bool { mine }

    /// What the switch's setting means, beside it.
    public var modeHint: String { people ? Self.theySee(pool.label) : Self.nobodyElse }

    public static func theySee(_ label: String) -> String {
        "They see \(label) on their Providers page and in the session picker."
    }
    public static let nobodyElse = "Nobody else in Orbit sees this pool or its accounts."

    // MARK: each person

    public static let ownerChip = "OWNER"
    public static let runsOnEverything = "Runs on everything — your ChatGPT accounts first"
    public static let runsOnKeys = "Runs on the API keys"

    /// A person's row, once anybody but its owner can use the pool.
    public var rows: [SharedPoolPerson] { people ? pool.people : [] }

    /// What a person's row says under their name (web's `PersonRow`): to its owner, what their sessions run
    /// on, said as the rule it is — `runs`, and whether that is everything — then the keys they put in and the
    /// sessions they started this month; to anybody else, those two alone.
    public struct PersonLine: Equatable, Sendable {
        public let runs: String?
        /// The pool's owner's own sessions run on its ChatGPT accounts first, and then on its keys.
        public let everything: Bool
        public let rest: String
    }

    public func line(_ person: SharedPoolPerson) -> PersonLine {
        let sessions = SharedPoolPage.plural(person.sessions, "session")
        guard mine else { return PersonLine(runs: nil, everything: false, rest: SharedPoolPage.personLine(person)) }
        // The owner's own sessions run on its ChatGPT accounts first; everybody else's — and everybody's in
        // a pool of keys alone — on its API keys.
        if person.creator && accounts != nil {
            return PersonLine(runs: Self.runsOnEverything, everything: true, rest: sessions)
        }
        let keys = person.keys == 0 ? "no key" : SharedPoolPage.plural(person.keys, "key")
        return PersonLine(runs: Self.runsOnKeys, everything: false, rest: "\(keys) · \(sessions)")
    }

    /// Whether anything ran on the pool's keys this month: until then there is no share to draw.
    public var ran: Bool { pool.people.contains { $0.usage.costUsd > 0 } }

    /// Whether the reader manages `person` — its owner, over everybody they added.
    public func manages(_ person: SharedPoolPerson) -> Bool { mine && !person.creator }

    /// Whether a person can be made an admin or a member: on a pool made on the shared pools page, which may
    /// have more admins than its maker. A pool of one's own has one, its owner.
    public var offersRoles: Bool { pool.shared }

    // MARK: its owner's rule, and what is said under it

    public static let ruleTitle = "They can add their own API keys"
    public static let ruleHint = "Off: only you put keys in. A key they add runs everyone’s sessions here, theirs first."

    /// Whether they may put keys of their own in is its owner's to say, once anybody else can use it.
    public var showsRule: Bool { mine && people }

    public static let footLead = "Your ChatGPT accounts only ever run your own sessions."
    public static let footRest = " OpenAI’s terms don’t allow a ChatGPT account to be shared, so nobody you add can run on one — or see which accounts they are."

    /// The lock at the card's foot: said to its owner, once anybody else can use a pool their ChatGPT
    /// accounts are in.
    public var showsFoot: Bool { mine && people && accounts != nil }

    /// Shared with people and no API key yet: none of them can start a session on it, and what fixes it —
    /// said to its owner alone, with "Add an API key" (02, the boundary state).
    public var warning: AddPoolKey.Fact? {
        guard mine, people, pool.keys.isEmpty else { return nil }
        let names = SharedPoolPage.listOf(added.map(\.name))
        let accounts = accounts == nil ? "" : ", and your ChatGPT accounts only run your own sessions"
        return AddPoolKey.Fact(lead: "\(names) can’t start a session here yet.",
                               rest: " \(pool.label) has no API key\(accounts).")
    }

    public static let addAPIKey = "Add an API key"
}

/// "Share <pool>" (03-4) — web's `SharePoolModal`: who to add, by the email of their Orbit account, and —
/// before they are in — what that means: the pool on their pages, its API keys to run on and never the
/// owner's ChatGPT accounts, and everybody's share of the keys' use shown to everybody. A pool with no key
/// yet says first that they could not start a session on it, and offers to add one first.
public enum SharePool {
    public static func title(_ pool: SharedPool) -> String { "Share \(pool.label)" }
    public static let emailsLabel = "Emails of their Orbit accounts"
    public static let share = "Share"
    public static let shareAnyway = "Share anyway"
    public static let addKeyFirst = "Add an API key first"

    /// With no key in the pool yet, the sheet warns instead of saying what they get.
    public static func noKey(_ pool: SharedPool) -> Bool { pool.keys.isEmpty }

    public static func risk(_ pool: SharedPool, accounts: Int?) -> AddPoolKey.Fact {
        let accounts = accounts == nil ? "" : ", because your ChatGPT accounts only run your own sessions"
        return AddPoolKey.Fact(lead: "\(pool.label) has no API key yet.",
                               rest: " They’ll see it but can’t start a session until it has one\(accounts).")
    }

    /// What being added means, before anybody is: the pool on their pages, the keys they run on — never its
    /// owner's ChatGPT accounts, when it holds any — and that everybody's share is shown to everybody.
    public static func facts(_ pool: SharedPool, accounts: Int?) -> [AddPoolKey.Fact] {
        let keys = pool.keys.map(\.label)
        var run = ", which \(keys.count == 1 ? "is" : "are") \(SharedPoolPage.listOf(keys)) now."
        if accounts == 1 {
            run += " Your ChatGPT account stays yours alone: they can’t run on it or see which account it is."
        } else if let accounts, accounts > 1 {
            run += " Your \(accounts) ChatGPT accounts stay yours alone: they can’t run on them or see which accounts they are."
        }
        return [
            AddPoolKey.Fact(lead: "They see \(pool.label)",
                            rest: " on their Providers page and in the session picker, and can start sessions on it."),
            AddPoolKey.Fact(lead: "Their sessions run on the pool’s API keys", rest: run),
            AddPoolKey.Fact(lead: "Everyone sees each person’s share", rest: " of this month’s API key use."),
        ]
    }

    /// The addresses typed, in the order they were: a comma or a space ends one (web's `tokenSeparators`),
    /// and the same one twice is one.
    public static func emails(_ typed: String) -> [String] {
        var seen = Set<String>()
        return typed.split(whereSeparator: { $0 == "," || $0.isWhitespace })
            .map(String.init)
            .filter { seen.insert($0).inserted }
    }

    /// One address that was not added, with the server's reason: named once the rest are in.
    public static func missed(_ email: String, reason: String) -> String { "\(email) (\(reason))" }

    /// How sharing went: who could not be added and why, or that they are in.
    public static func outcome(_ pool: SharedPool, missed: [String]) -> String {
        missed.isEmpty ? "Added to \(pool.label)" : "Not added: \(missed.joined(separator: ", "))"
    }
}

/// "Make <pool> just yours?" (03-5) — web's `justMine` confirmation and `JustMineCost`: going back to Just
/// me takes everybody but its owner out at once, and their keys and session tokens with them, so it says
/// first who loses the pool, which keys go with them — a key goes with whoever added it — and what stays.
public enum JustMine {
    public static func title(_ pool: SharedPool) -> String { "Make \(pool.label) just yours?" }
    public static let confirm = "Make it just mine"

    /// What it costs, in one paragraph. `accounts` is how many ChatGPT accounts of its owner's the pool
    /// holds — nil for a pool made on the shared pools page.
    public static func cost(_ pool: SharedPool, accounts: Int?) -> String {
        let others = pool.people.filter { !$0.creator }
        let keysOf = { (userId: String) in pool.keys.filter { $0.contributor.userId == userId }.map(\.label) }
        let leaving = others.compactMap { person -> (person: SharedPoolPerson, keys: [String])? in
            let keys = keysOf(person.userId)
            return keys.isEmpty ? nil : (person, keys)
        }
        var staying: [String] = []
        if let accounts, accounts > 0 { staying.append(accounts == 1 ? "Your ChatGPT account" : "Your ChatGPT accounts") }
        if let owner = SharedPoolPage.owner(pool) { staying += keysOf(owner.userId) }

        var text = "\(SharedPoolPage.listOf(others.map(\.name))) \(others.count == 1 ? "loses" : "lose")"
            + " it at once, and their sessions on it stop."
        if !leaving.isEmpty {
            let goes = leaving.enumerated().map { at, leaves in
                (at == 0 ? "" : at == leaving.count - 1 ? " and " : ", ")
                    + "\(SharedPoolPage.listOf(leaves.keys)) \(leaves.keys.count == 1 ? "leaves" : "leave") with \(leaves.person.name)"
            }
            text += " " + goes.joined() + ", because a key goes with whoever added it."
        }
        if !staying.isEmpty {
            text += " \(SharedPoolPage.listOf(staying)) \(staying.count > 1 || (accounts ?? 0) > 1 ? "stay" : "stays")."
        }
        return text
    }
}
