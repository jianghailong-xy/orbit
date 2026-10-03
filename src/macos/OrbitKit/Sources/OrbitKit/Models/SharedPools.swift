import Foundation

/// Shared Codex pools as GET /api/providers/shared-pools serves them (`SharedPoolsService.poolView`,
/// migration 0320): organization/project OpenAI API keys several Orbit users put in and run Codex on
/// through the pool gateway. Only the pools the caller is in are listed, each as that caller reads it —
/// their role, whether each key is theirs. No response carries a key: `fingerprint` (`sk-…AB12`) is all
/// anyone is shown of one.
///
/// As with `ProviderPool`, every field this build does not know is ignored, a state or role it does not
/// know reads as `.unknown`, and a key or person it cannot read at all is left out, so a server one
/// release ahead never blanks the page.

/// Where a key stands with OpenAI. `enabled` — its contributor's own switch — is a separate field.
public enum PoolKeyState: String, Codable, Sendable, CaseIterable {
    case active = "ACTIVE"
    /// OpenAI answered 401 for it: no claim picks it until its contributor or an admin replaces it.
    case invalid = "INVALID"
    /// OpenAI refused it because its organization or project is switched off.
    case disabled = "DISABLED"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PoolKeyState(rawValue: raw) ?? .unknown
    }
}

/// A person's place in a shared pool.
public enum SharedPoolRole: String, Codable, Sendable, CaseIterable {
    case admin = "ADMIN"
    case member = "MEMBER"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SharedPoolRole(rawValue: raw) ?? .unknown
    }
}

/// What some of the pool's ledger adds up to this month: tokens, and dollars.
public struct PoolSpend: Codable, Equatable, Sendable {
    public let inputTokens: Int
    public let outputTokens: Int
    public let costUsd: Double
    /// A key's only: what everyone but its contributor spent on it — what its share cap limits.
    public let othersCostUsd: Double?

    public init(inputTokens: Int = 0, outputTokens: Int = 0, costUsd: Double = 0, othersCostUsd: Double? = nil) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.costUsd = costUsd
        self.othersCostUsd = othersCostUsd
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        inputTokens = (try? c.decodeIfPresent(Int.self, forKey: .inputTokens)) ?? 0
        outputTokens = (try? c.decodeIfPresent(Int.self, forKey: .outputTokens)) ?? 0
        costUsd = (try? c.decodeIfPresent(Double.self, forKey: .costUsd)) ?? 0
        othersCostUsd = (try? c.decodeIfPresent(Double.self, forKey: .othersCostUsd)) ?? nil
    }
}

/// Who put a key in.
public struct PoolKeyContributor: Codable, Equatable, Sendable {
    public let userId: String
    public let name: String
    /// The caller put it in.
    public let you: Bool

    public init(userId: String, name: String, you: Bool = false) {
        self.userId = userId
        self.name = name
        self.you = you
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try c.decode(String.self, forKey: .userId)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        you = try c.decodeIfPresent(Bool.self, forKey: .you) ?? false
    }
}

/// One key in a shared pool.
public struct SharedPoolKey: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// What its contributor named it (`orbit-org-1`): the list and the switch notices use it.
    public let label: String
    /// `sk-…` and the key's last four characters — all anyone is shown of it.
    public let fingerprint: String
    public let state: PoolKeyState
    /// Its contributor's own switch: off, no claim picks it.
    public let enabled: Bool
    /// Whole dollars a calendar month (UTC) everyone but its contributor may spend on it. Nil: no cap.
    public let shareCap: Int?
    /// Out of budget until then — OpenAI answered `insufficient_quota` for it, and the page says
    /// `Out of budget · resets …` (`pool-key-select.ts` spent). Nil when it is not, which is what the
    /// server sends once the mark is behind us too.
    public let spentUntil: String?
    public let contributor: PoolKeyContributor
    /// This month's use of it; `othersCostUsd` is what its cap counts.
    public let usage: PoolSpend
    /// A session on the pool is generating on it right now.
    public let running: Bool
    /// The key a session the caller starts now runs on — the claim's own choice, asked for them. At
    /// most one key of a pool carries it.
    public let next: Bool

    public init(id: String, label: String, fingerprint: String, state: PoolKeyState = .active,
                enabled: Bool = true, shareCap: Int? = nil, spentUntil: String? = nil,
                contributor: PoolKeyContributor,
                usage: PoolSpend = PoolSpend(), running: Bool = false, next: Bool = false) {
        self.id = id
        self.label = label
        self.fingerprint = fingerprint
        self.state = state
        self.enabled = enabled
        self.shareCap = shareCap
        self.spentUntil = spentUntil
        self.contributor = contributor
        self.usage = usage
        self.running = running
        self.next = next
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        fingerprint = try c.decodeIfPresent(String.self, forKey: .fingerprint) ?? ""
        state = try c.decodeIfPresent(PoolKeyState.self, forKey: .state) ?? .unknown
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        shareCap = (try? c.decodeIfPresent(Int.self, forKey: .shareCap)) ?? nil
        spentUntil = (try? c.decodeIfPresent(String.self, forKey: .spentUntil)) ?? nil
        contributor = try c.decode(PoolKeyContributor.self, forKey: .contributor)
        usage = (try? c.decodeIfPresent(PoolSpend.self, forKey: .usage)) ?? PoolSpend()
        running = (try? c.decodeIfPresent(Bool.self, forKey: .running)) ?? false
        next = (try? c.decodeIfPresent(Bool.self, forKey: .next)) ?? false
    }
}

/// One person in a shared pool.
public struct SharedPoolPerson: Codable, Equatable, Sendable, Identifiable {
    public let userId: String
    public let name: String
    public let role: SharedPoolRole
    /// Made the pool: always an admin, whom nobody can remove or make a member.
    public let creator: Bool
    /// The caller.
    public let you: Bool
    /// How many keys they put in.
    public let keys: Int
    /// How many sessions they started on the pool this month.
    public let sessions: Int
    /// What they ran on the pool this month, on anyone's keys.
    public let usage: PoolSpend

    public var id: String { userId }

    public init(userId: String, name: String, role: SharedPoolRole = .member, creator: Bool = false,
                you: Bool = false, keys: Int = 0, sessions: Int = 0, usage: PoolSpend = PoolSpend()) {
        self.userId = userId
        self.name = name
        self.role = role
        self.creator = creator
        self.you = you
        self.keys = keys
        self.sessions = sessions
        self.usage = usage
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try c.decode(String.self, forKey: .userId)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        role = try c.decodeIfPresent(SharedPoolRole.self, forKey: .role) ?? .unknown
        creator = try c.decodeIfPresent(Bool.self, forKey: .creator) ?? false
        you = try c.decodeIfPresent(Bool.self, forKey: .you) ?? false
        keys = try c.decodeIfPresent(Int.self, forKey: .keys) ?? 0
        sessions = (try? c.decodeIfPresent(Int.self, forKey: .sessions)) ?? 0
        usage = (try? c.decodeIfPresent(PoolSpend.self, forKey: .usage)) ?? PoolSpend()
    }
}

/// The calendar month (UTC) a share cap and every usage figure count.
public struct SharedPoolWindow: Codable, Equatable, Sendable {
    public let start: String
    /// When this month's caps start again.
    public let end: String

    public init(start: String, end: String) {
        self.start = start
        self.end = end
    }
}

/// A shared pool, as one of its people reads it.
public struct SharedPool: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// What a session's `provider` holds when it runs on this pool.
    public let slug: String
    public let label: String
    /// `codex`: a shared pool runs Codex, on OpenAI's own endpoint through the pool gateway.
    public let engine: String
    /// Made on the shared pools page (migration 0321): API keys alone, never a ChatGPT account. False on a
    /// Codex pool of somebody's own (0323), which takes people and keys beside its owner's accounts (0358).
    /// An older server, which listed only the first kind, leaves it out: true.
    public let shared: Bool
    /// The ChatGPT accounts a pool of somebody's own holds (migrations 0323/0324), as its owner's page
    /// reads them and — since 2026-10-03 — as everyone in the pool reads them: the accounts run their
    /// sessions too (pool-credential-select.ts). Which of them the reader's next session runs on is its
    /// `next`. Empty for a shared pool, which holds none, and for an older server.
    public let logins: [CodexLogin]
    /// Rule: anyone in the pool may put a key in. Off, only admins can.
    public let membersCanAdd: Bool
    /// Rule: a member's sessions start on a key they put in while it has room.
    public let ownKeyFirst: Bool
    /// The caller's role.
    public let viewerRole: SharedPoolRole
    public let window: SharedPoolWindow?
    public let people: [SharedPoolPerson]
    public let keys: [SharedPoolKey]

    public init(id: String, slug: String, label: String, engine: String = "codex", shared: Bool = true,
                logins: [CodexLogin] = [],
                membersCanAdd: Bool = true, ownKeyFirst: Bool = true, viewerRole: SharedPoolRole = .member,
                window: SharedPoolWindow? = nil, people: [SharedPoolPerson] = [], keys: [SharedPoolKey] = []) {
        self.id = id
        self.slug = slug
        self.label = label
        self.engine = engine
        self.shared = shared
        self.logins = logins
        self.membersCanAdd = membersCanAdd
        self.ownKeyFirst = ownKeyFirst
        self.viewerRole = viewerRole
        self.window = window
        self.people = people
        self.keys = keys
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        slug = try c.decode(String.self, forKey: .slug)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? slug
        engine = try c.decodeIfPresent(String.self, forKey: .engine) ?? "codex"
        shared = (try? c.decodeIfPresent(Bool.self, forKey: .shared)) ?? true
        // An account in a shape this build cannot read is no reason to lose the rest of the pool.
        logins = (try? c.decodeIfPresent([LossyDecodable<CodexLogin>].self, forKey: .logins))?
            .compactMap(\.value) ?? []
        membersCanAdd = try c.decodeIfPresent(Bool.self, forKey: .membersCanAdd) ?? true
        ownKeyFirst = try c.decodeIfPresent(Bool.self, forKey: .ownKeyFirst) ?? true
        viewerRole = try c.decodeIfPresent(SharedPoolRole.self, forKey: .viewerRole) ?? .unknown
        window = (try? c.decodeIfPresent(SharedPoolWindow.self, forKey: .window)) ?? nil
        people = try c.decodeIfPresent([LossyDecodable<SharedPoolPerson>].self, forKey: .people)?
            .compactMap(\.value) ?? []
        keys = try c.decodeIfPresent([LossyDecodable<SharedPoolKey>].self, forKey: .keys)?
            .compactMap(\.value) ?? []
    }
}

/// POST /providers/shared-pools/:id/keys — a key of the caller's own. `apiKey` is the only place the
/// key is ever sent: the answer is the pool, which shows its fingerprint.
public struct AddPoolKeyRequest: Encodable, Equatable, Sendable {
    public let label: String
    public let apiKey: String
    /// Whole dollars a month the others may spend on it; nil (left out) for no cap.
    public let shareCap: Int?

    public init(label: String, apiKey: String, shareCap: Int? = nil) {
        self.label = label
        self.apiKey = apiKey
        self.shareCap = shareCap
    }
}

/// PUT /providers/shared-pools/:id/keys/:keyId/secret — a new secret for a key OpenAI refused.
public struct ReplacePoolKeyRequest: Encodable, Equatable, Sendable {
    public let apiKey: String

    public init(apiKey: String) { self.apiKey = apiKey }
}

/// PATCH /providers/shared-pools/:id/keys/:keyId — what its contributor switches. Nil fields stay.
public struct UpdatePoolKeyRequest: Encodable, Equatable, Sendable {
    public let enabled: Bool?

    public init(enabled: Bool? = nil) { self.enabled = enabled }
}

/// PATCH /providers/shared-pools/:id — an admin's rules. Nil fields stay.
public struct UpdateSharedPoolRequest: Encodable, Equatable, Sendable {
    public let membersCanAdd: Bool?
    public let ownKeyFirst: Bool?

    public init(membersCanAdd: Bool? = nil, ownKeyFirst: Bool? = nil) {
        self.membersCanAdd = membersCanAdd
        self.ownKeyFirst = ownKeyFirst
    }
}

/// POST /providers/shared-pools/:id/people — a person an admin adds, by their Orbit account's email.
public struct AddSharedPoolPersonRequest: Encodable, Equatable, Sendable {
    public let email: String

    public init(email: String) { self.email = email }
}

/// PATCH /providers/shared-pools/:id/people/:userId — an admin makes a person an admin or a member.
public struct UpdateSharedPoolPersonRequest: Encodable, Equatable, Sendable {
    public let role: SharedPoolRole

    public init(role: SharedPoolRole) { self.role = role }
}
