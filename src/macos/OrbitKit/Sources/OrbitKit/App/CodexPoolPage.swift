import Foundation

/// A Codex pool's page on iOS, drawn for whoever reads it (docs/mocks/account-pool-access/01–03) — web's
/// `CodexPoolPage` (pages/ProviderPoolPage.tsx) and the Accounts card it draws (components/AccountPools.tsx)
/// in their words. Its owner sees each ChatGPT account and API key in it, says who else can use it
/// (`WhoCanUseIt`), and adds and takes out accounts, keys and people. Somebody they added reads the same
/// accounts — since 2026-10-03 their sessions run on them too (pool-credential-select.ts) — without what
/// changes one, may put a key of their own in, and may leave.
///
/// `own` is the pool as its owner's providers read it — its ChatGPT accounts — and `access` its people,
/// accounts and keys (GET /providers/shared-pools/:id, or the list a pool of somebody else's is read from). A
/// pool made on the shared pools page (migration 0321) has only the second, and is drawn the same way with no
/// ChatGPT account in it. What each person may do is the server's (SharedPoolsService, CodexLoginService);
/// this offers only that. `PoolAccessCopyParityTests` holds every word here to the web source.
public struct CodexPoolPage: Equatable, Sendable {
    /// The pool as its owner's providers read it: its ChatGPT accounts. Nil when it is read as one of its
    /// people, and for a pool made on the shared pools page.
    public let own: ProviderPool?
    /// Its people and API keys, as the reader reads them. Nil until they are read: its owner's accounts are
    /// drawn alone meanwhile, as the web page draws them.
    public let access: SharedPool?
    /// The pool as the page draws it: its accounts first, then its keys (web's `pool`).
    public let pool: ProviderPool

    /// Nil with neither half to draw.
    public init?(own: ProviderPool?, access: SharedPool?) {
        if let own {
            pool = access.map { SharedPools.ownPoolWithAccess(own, $0) } ?? own
        } else if let access {
            pool = SharedPools.asProviderPool(access)
        } else {
            return nil
        }
        self.own = own
        self.access = access
    }

    // MARK: who reads it

    /// The reader is the pool's owner, and the page is drawn for them (web's `mine`).
    public var mine: Bool { access.map(SharedPoolPage.ownsPool) ?? true }
    /// Anybody can use it besides its owner (web's `people`): "Me and people I add".
    public var people: Bool { access.map(SharedPoolPage.hasPeople) ?? false }
    /// Its ChatGPT accounts, oldest first: from the owner's own providers read where there is one, and from
    /// the pool's page for one of the people the owner added — they run their sessions too (2026-10-03).
    public var logins: [CodexLogin] { own.map { CodexLoginPool.logins($0) } ?? access?.logins ?? [] }
    /// How many ChatGPT accounts it holds, as "Who can use it" and its dialogs count them — read by
    /// everyone in the pool, whose sessions the accounts run (migration 0371). Nil only for a pool that
    /// cannot hold one at all: anything but Codex (web's `accounts`).
    public var accounts: Int? { pool.engine == "codex" ? logins.count : nil }
    /// Whose the pool is (web's `poolOwner`).
    public var owner: SharedPoolPerson? { access.flatMap(SharedPoolPage.owner) }

    // MARK: the head

    public static let title = "Codex pool"
    /// Worn beside the pool's name once anybody but its owner can use it.
    public static let sharedChip = "SHARED"
    public static let justMe = "Just me"
    public static let addAccount = "Add account"
    public static let addKey = "Add a key"

    /// Who can use it — the first thing said of a pool after what it is, set in bold (web's `who`): to
    /// anybody but its owner, whose it is; to its owner, "Me and 2 people", or "Just me".
    public var who: String {
        if !mine { return Self.whose(owner?.name ?? "") }
        if let access, people { return Self.meAnd(access.people.count - 1) }
        return Self.justMe
    }

    public static func whose(_ owner: String) -> String { "\(owner)’s" }
    public static func meAnd(_ others: Int) -> String { "Me and \(SharedPoolPage.plural(others, "person", "people"))" }

    /// The rest of the line under the pool's name, after `who`: how many people are in it — said to anybody
    /// but its owner — and how many of its accounts or keys a session could start on now.
    public var subtitleRest: String {
        let count = mine ? "" : " · " + SharedPoolPage.plural(access?.people.count ?? 0, "person", "people")
        return "\(count) · \(ProviderPools.availability(pool))"
    }

    /// What the reader's sessions run on, which ends the web page's line under the pool's name (web's
    /// `how`); on a phone, the Accounts section's footer (`howSentence`).
    public var how: String {
        if !mine {
            guard let accounts, accounts > 0 else {
                return Self.memberHow + (access?.ownKeyFirst == true ? Self.ownFirst : "") + "."
            }
            return Self.memberAccountsHow
        }
        if own == nil { return Self.keysHow }
        return people ? Self.sharedHow : Self.justMeHow
    }

    public static let memberHow = "your sessions run on the API keys"
    public static let ownFirst = ", your own first"
    public static let keysHow = "each session starts on the key with the most room, and stays on it until that one runs out."
    /// Read by one of the people the owner added, of a pool whose accounts run their sessions too.
    public static let memberAccountsHow = "each session starts on its ChatGPT accounts; the API keys when none of them can run."
    public static let sharedHow = "each session starts on your ChatGPT accounts; the API keys when none of them can run."
    public static let justMeHow = "each session starts on the account whose quota resets soonest, and stays on it until that one runs out."

    /// `how`, as a sentence of its own.
    public var howSentence: String { how.prefix(1).uppercased() + how.dropFirst() }

    /// What the head's press opens.
    public enum Adding: Equatable, Sendable {
        /// "Add account" asks first what kind goes in (`kinds`).
        case choose
        /// Straight to signing a ChatGPT account in: the pool's people and keys are not read (yet).
        case signIn
        /// "Add a key".
        case key
    }

    /// Whether the reader may put something in: its owner always, a member while the pool's own rule for
    /// that kind says so (web's `mayAddAccount`/`mayAddKey`).
    public var mayAddAccount: Bool { mine || (access.map(SharedPoolPage.canAddAccount) ?? false) }
    public var mayAddKey: Bool { mine || (access.map(SharedPoolPage.canAddKey) ?? false) }

    /// The head's press, or nil: its owner always has one — one ChatGPT account after another, or a key, on
    /// a pool of their own; a key on one made on the shared pools page — and anybody the pool lets put
    /// something in has one too: "Add account" while a ChatGPT account may go in (migration 0371), "Add a
    /// key" while only keys may.
    public var adding: Adding? {
        guard mayAddAccount || mayAddKey else { return nil }
        guard mayAddAccount else { return .key }
        guard mine else { return .choose }
        return access == nil ? .signIn : .choose
    }

    /// The press's words: "Add account" wherever an account of the reader's may go in, "Add a key" where
    /// only keys may.
    public var addLabel: String { mayAddAccount ? Self.addAccount : Self.addKey }

    // MARK: the Accounts card

    public static let accountsHeader = "Accounts"

    /// How many accounts it holds, beside the card's header — said to its owner.
    public var accountsCount: Int? { mine ? pool.members.count : nil }

    /// Whether each account says whose sessions it runs (web's `tagged`): on its owner's page, once anybody
    /// else can use it — a ChatGPT account and a key both run everybody's since 2026-10-03
    /// (`everyoneHere`). A rule rather than a setting.
    public var tagged: Bool { mine && people }

    public static let everyoneHere = "Everyone here"

    /// What the card says in place of its rows while it has none: no account until one is signed in on a
    /// pool of one's own, no key until one is added on any other — and, to one of the people the owner
    /// added, the sign-in named as the owner's, which is whose it is to make.
    public var emptyNote: String? {
        guard pool.members.isEmpty else { return nil }
        guard CodexLoginPool.isLoginPool(pool) else { return SharedPoolPage.noKeys }
        // "you sign in" wherever the reader may sign one in themselves — its owner, or a member the pool's
        // rule lets (migration 0371) — "its owner signs in" for anybody the pool does not.
        return mayAddAccount ? CodexLoginPool.noAccount : CodexLoginPool.noAccountOwner
    }

    // MARK: going out of it

    public static let deletePool = "Delete pool"
    public static let leavePool = "Leave pool"
    public static let delete = "Delete"
    public static let leave = "Leave"
    public static let leaveNote = "Your keys leave with you."

    /// Its owner deletes it; anybody else leaves it.
    public var exitLabel: String { mine ? Self.deletePool : Self.leavePool }
    public var exitConfirm: String { mine ? Self.delete : Self.leave }
    public var exitTitle: String { mine ? Self.deleteTitle(pool.label) : Self.leaveTitle(pool.label) }

    public static func deleteTitle(_ label: String) -> String { "Delete \(label)?" }
    public static func leaveTitle(_ label: String) -> String { "Leave \(label)?" }

    /// What going out of it does, said beside the press and asked before it (web's `outNote`): deleting it
    /// takes its ChatGPT sign-ins and its API keys off the Orbit server — and, once it is shared, everybody's
    /// way to run on it — and leaving it takes the reader's keys with them.
    public var outNote: String {
        guard mine else { return Self.leaveNote }
        let deleted = "Its \(gone.joined(separator: " and ")) \(gone == [Self.signIn] ? "is" : "are") deleted from the Orbit server"
        return deleted + (people ? Self.deletedShared : Self.deletedAlone)
    }

    public static let deletedShared = ", and nobody can run on it."
    public static let deletedAlone = " with it."
    static let signIn = "ChatGPT sign-in"
    static let signIns = "ChatGPT sign-ins"
    static let apiKeys = "API keys"

    /// What deleting it takes off the Orbit server (web's `gone`): its ChatGPT sign-ins, its API keys, or
    /// both.
    var gone: [String] {
        let keys = access?.keys ?? []
        var gone: [String] = []
        if own != nil && (!logins.isEmpty || keys.isEmpty) { gone.append(logins.count == 1 ? Self.signIn : Self.signIns) }
        if own == nil || !keys.isEmpty { gone.append(Self.apiKeys) }
        return gone
    }

    // MARK: "Add account"

    public static func addAccountTitle(_ label: String) -> String { "Add an account to \(label)" }

    /// One kind of account "Add account" offers: what it is, then whose sessions run on it — the bold run.
    public struct Kind: Equatable, Sendable, Identifiable {
        public enum ID: Hashable, Sendable { case chatGPT, key }

        public let id: ID
        public let title: String
        public let lead: String
        public let bold: String
        public let rest: String
    }

    /// "Add account" (03-1): which kind goes in — another ChatGPT account of the reader's, which runs the
    /// sessions of everyone in the pool, or an OpenAI API key, which runs everybody's — said on the choice
    /// rather than found out after. `accounts` is how many ChatGPT accounts the pool holds already, and
    /// `mine` whether the reader is its owner: a member's own account runs everyone's here from the moment
    /// it is in (migration 0371), where the owner may still share the pool later.
    public static func kinds(accounts: Int, mine: Bool = true) -> [Kind] {
        [
            Kind(id: .chatGPT, title: CodexSignIn.title,
                 lead: accounts > 0 ? "Another ChatGPT account of yours." : "A ChatGPT account of yours.",
                 bold: "Everyone in the pool runs on it",
                 rest: mine ? " once you share the pool — until then, your sessions alone." : ", you included."),
            Kind(id: .key, title: "Paste an OpenAI API key", lead: "An organization or project key.",
                 bold: "Everyone who can use this pool runs on it", rest: ", up to a monthly limit you set."),
        ]
    }
}
