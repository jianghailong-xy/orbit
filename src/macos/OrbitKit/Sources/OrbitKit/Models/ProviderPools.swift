import Foundation

/// Account pools as GET /api/providers/pools serves them (`ProvidersService.poolViews`): several of
/// the user's own Claude subscriptions under one dispatchable slug, each member with its own quota
/// and where it stands. Mirrors web's `ProviderPool` / `PoolMember` (lib/providerPools.ts) field for
/// field — `ProviderPoolsParityTests` holds the two declarations together.
///
/// Every field this build does not know is ignored, a state it does not know reads as `.unknown`,
/// and a member (or pool) it cannot read at all is left out, so a server one release ahead never
/// makes the picker lose every pool at once.

/// Where one member of a pool stands, in the order the claim reads a member.
public enum PoolMemberState: String, Codable, Sendable, CaseIterable {
    /// Its key was refused (401/403). Final for that key: a new one is the way back.
    case refused = "REFUSED"
    case disabled = "DISABLED"
    /// A window is used up; `PoolMember.resetsAt` says when it frees up.
    case spent = "SPENT"
    /// A session is generating on it right now.
    case running = "RUNNING"
    case available = "AVAILABLE"
    /// It runs, but reports no 5-hour window: last in line, which is not the same as idle.
    case noQuota = "NO_QUOTA"
    /// Forward-compatibility floor: a state this build does not know. Nothing here reads it as spent,
    /// and whether its pool can run at all is the server's to say (`ProviderPool.unavailable`).
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PoolMemberState(rawValue: raw) ?? .unknown
    }
}

/// One account in a pool: a provider the user configured, keyless and endpointless.
public struct PoolMember: Codable, Equatable, Sendable, Identifiable {
    /// The provider row's id — the row `Session.poolMemberProviderId` records. Either may arrive in
    /// either spelling, so compare through `PublicID.storageKey`.
    public let id: String
    /// The provider's own slug, which stays dispatchable on its own ("Pin a specific account").
    public let slug: String
    public let label: String
    public let presetSlug: String?
    public let enabled: Bool
    /// This account's own quota, read with its own credential. Nil when it reports none — or reports
    /// it in a shape this build cannot read, which is no reason to lose the member.
    public let planUsage: PlanUsageSnapshot?
    public let state: PoolMemberState
    /// SPENT only: when this account can take work again.
    public let resetsAt: String?
    /// The member a session starting now would run on — the claim's own selector, asked the way the
    /// claim asks it. At most one member of a pool carries it.
    public let next: Bool

    public init(id: String, slug: String, label: String, presetSlug: String? = nil,
                enabled: Bool = true, planUsage: PlanUsageSnapshot? = nil,
                state: PoolMemberState, resetsAt: String? = nil, next: Bool = false) {
        self.id = id
        self.slug = slug
        self.label = label
        self.presetSlug = presetSlug
        self.enabled = enabled
        self.planUsage = planUsage
        self.state = state
        self.resetsAt = resetsAt
        self.next = next
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        slug = try c.decode(String.self, forKey: .slug)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? slug
        presetSlug = try c.decodeIfPresent(String.self, forKey: .presetSlug)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        planUsage = (try? c.decodeIfPresent(PlanUsageSnapshot.self, forKey: .planUsage)) ?? nil
        state = try c.decodeIfPresent(PoolMemberState.self, forKey: .state) ?? .unknown
        resetsAt = try c.decodeIfPresent(String.self, forKey: .resetsAt)
        next = try c.decodeIfPresent(Bool.self, forKey: .next) ?? false
    }
}

/// An account pool: one more provider slug to pick and dispatch with, whose runs spend its members'
/// own subscriptions one account at a time.
public struct ProviderPool: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// What a session's or workspace's `provider` holds when it runs on this pool.
    public let slug: String
    public let label: String
    /// Set only while every member that can run is spent: the EARLIEST of their resets, since one
    /// account freeing up is enough for work to continue.
    public let resetsAt: String?
    /// Set only when no member can run at all, and no reset will change that — none in it, or each
    /// one disabled, refused by the endpoint, or one the pool would not admit today: why, in a few
    /// words ("No accounts", "No account can run"). The server refuses to start or switch a session
    /// onto such a pool, or to pin a task to it. A pool whose members are only spent never carries it.
    public let unavailable: String?
    public let members: [PoolMember]

    public init(id: String, slug: String, label: String, resetsAt: String? = nil,
                unavailable: String? = nil, members: [PoolMember] = []) {
        self.id = id
        self.slug = slug
        self.label = label
        self.resetsAt = resetsAt
        self.unavailable = unavailable
        self.members = members
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        slug = try c.decode(String.self, forKey: .slug)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? slug
        resetsAt = try c.decodeIfPresent(String.self, forKey: .resetsAt)
        // A reason in a shape this build cannot read is no reason to lose the pool — and no reason.
        let reason = (try? c.decodeIfPresent(String.self, forKey: .unavailable)) ?? nil
        unavailable = reason?.isEmpty == false ? reason : nil
        members = try c.decodeIfPresent([LossyDecodable<PoolMember>].self, forKey: .members)?
            .compactMap(\.value) ?? []
    }
}

/// One element of a list, decoded on its own: an element this build cannot read comes back nil
/// instead of failing the whole list around it. Never throws, so the list's container still steps
/// over exactly one element per call.
struct LossyDecodable<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}
