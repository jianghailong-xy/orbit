import Foundation

// The Watch API's wire vocabulary (`/api/watches`), transcribed from `@orbit/shared`'s `watch.ts`.
// The authority is `contracts/watch.contract.json` (docs/watch-contract.md): `WatchContractTests`
// reads that file and holds the states, leaves, transitions and limits below to it.
//
// A watch is a row on the control plane with no process behind it — a different thing from a
// Background process (contract §9.2), with its own presentation in `WatchProjection`.
//
// Every enum decodes a value this build doesn't know to `.unknown` rather than throwing: a newer
// server may add a state or a leaf, and one watch this build can't name must not blank the list.

/// Where a watch stands (contract §3). It starts ACTIVE; the last five are terminal.
public enum WatchState: String, Codable, Sendable, CaseIterable {
    case active = "ACTIVE"
    case paused = "PAUSED"
    case matched = "MATCHED"
    case expired = "EXPIRED"
    case cancelled = "CANCELLED"
    case revoked = "REVOKED"
    case unresolvable = "UNRESOLVABLE"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WatchState(rawValue: raw) ?? .unknown
    }
}

/// The two kinds a watch observes. A task list or project is only ever expanded into these at
/// create; it is never a live set (contract §4).
public enum WatchTargetKind: String, Codable, Sendable {
    case session = "SESSION"
    case task = "TASK"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WatchTargetKind(rawValue: raw) ?? .unknown
    }
}

/// One target's state (contract §3): SATISFIED once a leaf the predicate names holds for it, and
/// GONE once its row is deleted — which takes it out of the set rather than counting it as met.
public enum WatchTargetState: String, Codable, Sendable, CaseIterable {
    case observed = "OBSERVED"
    case satisfied = "SATISFIED"
    case gone = "GONE"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WatchTargetState(rawValue: raw) ?? .unknown
    }
}

/// Whether what a Match (or a watch's end) caused got done (contract §3). DEAD_LETTER is the only
/// terminal state, and it has to be visible.
public enum WatchDeliveryState: String, Codable, Sendable, CaseIterable {
    case pending = "PENDING"
    case inFlight = "IN_FLIGHT"
    case delivered = "DELIVERED"
    case deadLetter = "DEAD_LETTER"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WatchDeliveryState(rawValue: raw) ?? .unknown
    }
}

/// What a watch does when it matches (contract §6). Exactly one per watch.
public enum WatchAction: String, Codable, Sendable, CaseIterable {
    /// One notification to the account's user.
    case notifyUser = "NOTIFY_USER"
    /// One turn queued on the observer session: how a session waits without a polling process.
    case resumeSession = "RESUME_SESSION"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WatchAction(rawValue: raw) ?? .unknown
    }
}

public enum WatchMode: String, Codable, Sendable {
    case oneShot = "ONE_SHOT"
    case continuous = "CONTINUOUS"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WatchMode(rawValue: raw) ?? .unknown
    }
}

public enum WatchObserverType: String, Codable, Sendable {
    case user = "USER"
    case session = "SESSION"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WatchObserverType(rawValue: raw) ?? .unknown
    }
}

/// The v1 leaves (contract §2.2). Deliberately not interchangeable: a settled turn is not a
/// terminal run, and neither of them is a task being done.
public enum WatchLeaf: String, Codable, Sendable, CaseIterable {
    case sessionTurnSettled = "SESSION_TURN_SETTLED"
    case sessionRunTerminal = "SESSION_RUN_TERMINAL"
    case sessionLifecycleTerminal = "SESSION_LIFECYCLE_TERMINAL"
    case sessionNeedsAttention = "SESSION_NEEDS_ATTENTION"
    case taskTerminal = "TASK_TERMINAL"
    case taskFailed = "TASK_FAILED"
    case taskDone = "TASK_DONE"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WatchLeaf(rawValue: raw) ?? .unknown
    }

    /// The only kind of target the leaf is evaluated against; nil for a leaf this build doesn't know.
    public var targetKind: WatchTargetKind? {
        switch self {
        case .sessionTurnSettled, .sessionRunTerminal, .sessionLifecycleTerminal, .sessionNeedsAttention:
            return .session
        case .taskTerminal, .taskFailed, .taskDone:
            return .task
        case .unknown:
            return nil
        }
    }
}

/// The contract's `limits` a client acts on: the deadline an edit may set, and the shape of a
/// condition the server accepts.
public enum WatchLimits {
    public static let minTtlSeconds = 60
    public static let defaultTtlSeconds = 86_400
    public static let maxTtlSeconds = 2_592_000
    public static let maxPredicateDepth = 2
    public static let maxOperandsPerComposite = 4
    /// The failed attempt that brings a delivery's `attempts` here makes it a dead letter.
    public static let maxDeliveryAttempts = 8
}

/// A typed condition over the whole target set (contract §2): one leaf aggregated over every
/// target, or a composite of those. A closed grammar — no shell, no SQL, no free text.
public indirect enum WatchPredicate: Codable, Hashable, Sendable {
    /// Holds when the leaf holds for every target.
    case all(WatchLeaf)
    /// Holds when the leaf holds for at least one target.
    case any(WatchLeaf)
    case allOf([WatchPredicate])
    case anyOf([WatchPredicate])
    /// A term this build can't read, named by its `kind`. Drawn as such and never sent back: an
    /// edit replaces the predicate whole.
    case unknown(String)

    /// The grammar version this build reads and writes. The server serves it beside the newer ones
    /// (contract `servedPredicateVersions`) and refuses a version it does not serve.
    public static let version = 1

    private enum CodingKeys: String, CodingKey { case kind, over, leaf, operands }
    private static let allTargets = "ALL_TARGETS"

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "ALL", "ANY":
            // v1 has one selector. A term over some other set means something this build can't say.
            guard try c.decodeIfPresent(String.self, forKey: .over) == Self.allTargets else {
                self = .unknown(kind)
                return
            }
            let leaf = try c.decode(WatchLeaf.self, forKey: .leaf)
            self = kind == "ALL" ? .all(leaf) : .any(leaf)
        case "ALL_OF", "ANY_OF":
            let operands = try c.decode([WatchPredicate].self, forKey: .operands)
            self = kind == "ALL_OF" ? .allOf(operands) : .anyOf(operands)
        default:
            self = .unknown(kind)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .all(let leaf):
            try c.encode("ALL", forKey: .kind)
            try c.encode(Self.allTargets, forKey: .over)
            try c.encode(leaf, forKey: .leaf)
        case .any(let leaf):
            try c.encode("ANY", forKey: .kind)
            try c.encode(Self.allTargets, forKey: .over)
            try c.encode(leaf, forKey: .leaf)
        case .allOf(let operands):
            try c.encode("ALL_OF", forKey: .kind)
            try c.encode(operands, forKey: .operands)
        case .anyOf(let operands):
            try c.encode("ANY_OF", forKey: .kind)
            try c.encode(operands, forKey: .operands)
        case .unknown(let kind):
            try c.encode(kind, forKey: .kind)
        }
    }

    /// Every leaf the predicate names, in order.
    public var leaves: [WatchLeaf] {
        switch self {
        case .all(let leaf), .any(let leaf): return [leaf]
        case .allOf(let operands), .anyOf(let operands): return operands.flatMap(\.leaves)
        case .unknown: return []
        }
    }

    /// Whether this build can read every term — and so describe it, or offer to keep it.
    public var isKnown: Bool {
        switch self {
        case .all(let leaf), .any(let leaf): return leaf != .unknown
        case .allOf(let operands), .anyOf(let operands): return operands.allSatisfy(\.isKnown)
        case .unknown: return false
        }
    }
}

/// One frozen target and what the evaluator last recorded about it.
public struct WatchTarget: Codable, Equatable, Sendable {
    public let targetKind: WatchTargetKind
    /// The session's or task's id, as the public id like every other id above the API line.
    public let targetResourceId: String
    public let state: WatchTargetState
    public let targetEpoch: Int
    /// When an evaluation last MOVED this target's state: the evaluator writes it only together
    /// with a change, so it reads as "last changed". The watch's own `lastEvaluatedAt` is the look.
    public let lastEvaluatedAt: String?
}

/// What a target looked like to the evaluation that recorded a Match or an expiry.
public struct WatchTargetObservation: Codable, Equatable, Sendable {
    public let kind: WatchTargetKind
    public let id: String
    public let epoch: Int
    public let state: WatchTargetState
    /// Whether that evaluation moved the target's state.
    public let changed: Bool
    /// What each leaf the predicate names answered for this target. Absent on a GONE target.
    public let leaves: [String: Bool]?
    /// The columns those leaves read. A task carries only `status`. Absent on a GONE target.
    public let observed: WatchObservedFacts?
}

public struct WatchObservedFacts: Codable, Equatable, Sendable {
    /// The task's or session's raw status column.
    public let status: String
    public let endReason: String?
    public let runState: String?
    public let lifecycleState: String?
    public let pendingApproval: Bool?
}

/// A Match's `perTargetSnapshot`, and an expiry's `expirySnapshot`.
public struct WatchSnapshot: Codable, Equatable, Sendable {
    public let evaluatedAt: String
    public let targets: [WatchTargetObservation]
}

/// What a Match (or a watch's end) caused, and whether it got done. `attempts` counts the attempts
/// that failed.
public struct WatchDelivery: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let action: WatchAction
    public let state: WatchDeliveryState
    public let attempts: Int
    /// When the next attempt is due, or the last one was.
    public let nextAttemptAt: String?
    public let lastError: String?
    public let deliveredAt: String?
    public let deadLetteredAt: String?
    public let createdAt: String
    public let updatedAt: String
}

/// Why a delivery is a dead letter: the code heading its `lastError`, as in `WAKE_WITHDRAWN: …` (contract
/// `deliveryGuards.deadLetterCodes`). `WatchContractTests` holds `quietCodes` to that table, which the web reads
/// through `@orbit/shared`, so both raise the same dead letters.
public enum WatchDeadLetter {
    /// The codes whose dead letter nobody has to act on (`needsAttention: false`): the wake was taken back on
    /// purpose before it ran — its owner withdrew that one turn, or a caller that already had its answer inline
    /// released it. Still shown, as withdrawn; never a reason to file the watch under Needs attention.
    public static let quietCodes: Set<String> = ["WAKE_WITHDRAWN"]

    /// Whether `delivery` is a dead letter somebody has to look at: every one but a quiet one.
    public static func needsAttention(_ delivery: WatchDelivery) -> Bool {
        guard delivery.state == .deadLetter else { return false }
        let error = delivery.lastError ?? ""
        return !quietCodes.contains { error.hasPrefix("\($0):") }
    }
}

/// A Match: the condition held at one moment (contract §1). Immutable — a fact, not a notification.
public struct WatchMatch: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let generation: Int
    public let matchedAt: String
    /// The evaluator's own account in the contract's vocabulary (`ALL TASK_TERMINAL 7/7`) — also
    /// the body of the push a NOTIFY_USER match sends.
    public let reason: String
    public let predicateVersion: Int
    public let perTargetSnapshot: WatchSnapshot?
    public let deliveries: [WatchDelivery]
}

/// The turn a RESUME_SESSION watch that ended unmatched owes its observer (contract §3, §5). The
/// wire calls these `expiryDeliveries`, but they cover a revoked and an unresolvable end too.
public struct WatchEndDelivery: Decodable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case expiry = "EXPIRY"
        case revoked = "REVOKED"
        case unresolvable = "UNRESOLVABLE"
        case unknown = "UNKNOWN"

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .unknown
        }
    }

    public let kind: Kind
    /// The delivery's own fields, which the wire flattens into the same object as `kind`.
    public let delivery: WatchDelivery
    /// What the expiring evaluation saw. Nil for the other two kinds: a revoked watch reports
    /// nothing about its targets (§7), and an unresolvable one has none left.
    public let expirySnapshot: WatchSnapshot?

    private enum CodingKeys: String, CodingKey { case kind, expirySnapshot }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(Kind.self, forKey: .kind)
        expirySnapshot = try c.decodeIfPresent(WatchSnapshot.self, forKey: .expirySnapshot)
        delivery = try WatchDelivery(from: decoder)
    }

    init(kind: Kind, delivery: WatchDelivery, expirySnapshot: WatchSnapshot?) {
        self.kind = kind
        self.delivery = delivery
        self.expirySnapshot = expirySnapshot
    }
}

/// `GET /watches` and `GET /watches/:id`, and what every control answers with.
public struct Watch: Decodable, Equatable, Sendable, Identifiable {
    /// The public id. A push names the watch by its UUID instead, so match ids through
    /// `PublicID.storageKey` (see `WatchIndex.find`).
    public let id: String
    public let observerType: WatchObserverType
    /// The session a RESUME_SESSION watch resumes; nil when the account's user is the observer.
    public let observerSessionId: String?
    public let predicateVersion: Int
    public let predicate: WatchPredicate
    public let mode: WatchMode
    public let action: WatchAction
    public let state: WatchState
    /// How many Matches the watch has recorded.
    public let generation: Int
    public let expiresAt: String
    public let nextEvaluateAt: String?
    /// When the evaluator last looked — every landed evaluation writes it, whether or not anything
    /// changed. What freshness reads.
    public let lastEvaluatedAt: String?
    public let createdAt: String
    public let updatedAt: String
    /// Frozen at create.
    public let targets: [WatchTarget]
    /// Oldest first.
    public let matches: [WatchMatch]
    /// At most one, and only for a RESUME_SESSION watch that ended unmatched and uncancelled.
    public let expiryDeliveries: [WatchEndDelivery]
}

/// `PATCH /watches/:id`: the condition and/or the deadline of a live watch. Its targets and its
/// action stay as created. A nil field is left out, and the server refuses a body with neither.
public struct UpdateWatchRequest: Encodable, Equatable, Sendable {
    public let predicateVersion: Int?
    public let predicate: WatchPredicate?
    /// Counted from the edit, not from the create.
    public let ttlSeconds: Int?

    public init(predicate: WatchPredicate? = nil, ttlSeconds: Int? = nil) {
        self.predicateVersion = predicate == nil ? nil : WatchPredicate.version
        self.predicate = predicate
        self.ttlSeconds = ttlSeconds
    }
}
