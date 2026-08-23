import Foundation

// The canonical execution atom from the Session State V2 contract (docs/session-state-v2-contract.md).
// One object answers separately the two questions the raw `status` column has always answered
// together — and therefore answered wrong for someone: what the run is doing right now
// (`activity`), and how it ended (`outcome`, `nil` until it has).
//
// This is stage R (dual-read) of that contract's migration: the server does not send `execution`
// yet, so `effectiveExecution` on every session-shaped DTO still derives the atom from the legacy
// fields. What this file adds is the shape and the precedence — a complete canonical object wins,
// anything else falls back whole — so the Expand task can start sending it without waiting on a
// client release, and the Cutover task has exactly one accessor to move presentation onto.

/// What the run is doing right now.
///
/// Deliberately NOT the runner-slot answer: `RUNNING` is a permit and `GENERATING` is the engine
/// producing output, and a self-driven turn (a background task reporting in, a scheduled wake-up)
/// is the second without the first. Contract §2.
public enum SessionActivity: String, Codable, Sendable {
    case queued = "QUEUED"
    case generating = "GENERATING"
    case idle = "IDLE"
    /// An end the server accepted but the runner has not carried out yet. Writes are already
    /// refused server-side here (`capabilities.resumeBlockedReason == .ending`).
    case stopping = "STOPPING"
    case terminated = "TERMINATED"
    /// Forward compatibility: a value this build does not know. Never guessed at — §6 forbids
    /// mapping an unknown onto any settled reading, so it stays unknown and refuses writes.
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionActivity(rawValue: raw) ?? .unknown
    }

    /// Whether the engine is producing output — what a working spinner asks.
    public var isGenerating: Bool { self == .generating }

    /// Whether another user turn may be offered. `stopping` / `terminated` / `unknown` are all
    /// refused (§6): the first two by the server, the third because a reading we could not decode
    /// is not a permission.
    public var acceptsUserTurn: Bool {
        switch self {
        case .queued, .generating, .idle: return true
        case .stopping, .terminated, .unknown: return false
        }
    }
}

/// How the run ended.
///
/// `nil` — the key absent, or an explicit JSON null — means "no verdict yet", and is deliberately a
/// different *shape* from every value rather than another case, so no reader can confuse "still
/// running" with a verdict it failed to recognize. Contract §2.
public enum SessionOutcome: String, Codable, Sendable {
    case succeeded = "SUCCEEDED"
    case failed = "FAILED"
    /// The single neutral terminal: the run stopped without a success or failure verdict.
    case ended = "ENDED"
    /// Forward compatibility, and distinct from `nil`: a verdict we could not read is not the
    /// absence of one.
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionOutcome(rawValue: raw) ?? .unknown
    }
}

/// The atom: one activity, and the verdict if there is one.
///
/// It decodes as a whole or not at all. An object that fails to name an activity, or types either
/// field as something other than a string, is not a canonical object — it throws here, and the
/// call sites' `decodeExecutionIfPresent` turns that into "no atom" so the reader falls back to the
/// legacy fields rather than half-believing this one. An activity or outcome we simply do not
/// recognize is a different matter: that object IS complete, and its unknown value is preserved.
public struct SessionExecution: Codable, Equatable, Sendable {
    public let activity: SessionActivity
    /// `nil` while the run has produced no verdict. See ``SessionOutcome``.
    public let outcome: SessionOutcome?

    public init(activity: SessionActivity, outcome: SessionOutcome? = nil) {
        self.activity = activity
        self.outcome = outcome
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        activity = try c.decode(SessionActivity.self, forKey: .activity)
        outcome = try c.decodeIfPresent(SessionOutcome.self, forKey: .outcome)
    }
}

public extension SessionExecution {
    /// The atom a client derives when the server sends none — every payload, today.
    ///
    /// It reproduces the contract's truth table (§3) from what a client actually holds, taking the
    /// run state the existing three-level fallback already resolved (`runState` → raw status →
    /// legacy `sessionState`) so this adds a shape, not a second opinion. Two inputs are named
    /// separately because they change the answer: a parked session with `engineTurnActive` is
    /// generating, and `capabilities.resumeBlockedReason == .ending` is the client's only sight of
    /// `cancelRequestedAt` — the server derives that flag from exactly the non-terminal-plus-cancel
    /// condition the STOPPING rows test for.
    ///
    /// One published difference it cannot correct: D3 (an `INTERRUPTED` row carrying an
    /// `endReason` but no cancel) has already collapsed to `.ended` before this sees it, because
    /// the client is not told the two apart. That is a reason to prefer the server's atom, which is
    /// the point of preferring it.
    static func derived(runState: SessionRunState,
                        engineTurnActive: Bool = false,
                        ending: Bool = false) -> SessionExecution {
        // §3.1 priorities 1–2: a settled run — decodable or not — outranks any pending end request.
        switch runState {
        case .succeeded: return SessionExecution(activity: .terminated, outcome: .succeeded)
        case .failed:    return SessionExecution(activity: .terminated, outcome: .failed)
        case .ended:     return SessionExecution(activity: .terminated, outcome: .ended)
        case .unknown:   return SessionExecution(activity: .unknown, outcome: .unknown)
        default: break
        }
        // Priority 3: an accepted end outranks generating — what streams during teardown is a
        // transcript, not an invitation to reply.
        if ending { return SessionExecution(activity: .stopping) }
        // Priorities 4–5.
        switch runState {
        case .queued:  return SessionExecution(activity: .queued)
        case .running: return SessionExecution(activity: .generating)
        default:       return SessionExecution(activity: engineTurnActive ? .generating : .idle)
        }
    }
}

extension KeyedDecodingContainer {
    /// Decode a canonical `execution` atom without ever failing the payload around it.
    ///
    /// A malformed atom yields `nil` — the whole object, not a repaired half of it — and the caller
    /// falls back to the legacy fields. That is the "complete object or nothing" half of the
    /// contract's precedence; the unknown-value half lives in the enums themselves.
    func decodeExecutionIfPresent(_ key: Key) -> SessionExecution? {
        (try? decodeIfPresent(SessionExecution.self, forKey: key)) ?? nil
    }

    /// The same, for a payload that is folded into a row rather than read whole: the absent key and
    /// the present-but-unusable one mean different things to an upsert, so they stay distinguishable.
    /// `nil` = the key was not sent (an older control plane — keep what the row has);
    /// `.some(nil)` = sent as null or unusable (this server has no atom — drop the row's stale one);
    /// `.some(atom)` = replace wholesale.
    func decodeExecutionSlot(_ key: Key) -> SessionExecution?? {
        contains(key) ? .some(decodeExecutionIfPresent(key)) : nil
    }
}
