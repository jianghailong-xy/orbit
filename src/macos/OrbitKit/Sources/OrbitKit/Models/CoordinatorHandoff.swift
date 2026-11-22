import Foundation

// Coordinator handoff — "Start a new coordinator" with a handoff note (docs/coordinator-handoff.md,
// board 02). The wire shapes mirror src/shared/src/coordinator-handoff.ts field for field.

/// Where a handoff stands on the outgoing coordinator. A cancelled handoff is never shown on a
/// session (`coordinatorHandoff` is null), so `.cancelled` is only ever an endpoint's answer.
public enum CoordinatorHandoffState: String, Codable, Equatable, Sendable {
    case writing = "WRITING"
    case handingOver = "HANDING_OVER"
    case failed = "FAILED"
    case completed = "COMPLETED"
    case cancelled = "CANCELLED"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CoordinatorHandoffState(rawValue: raw) ?? .unknown
    }
}

/// Why a note was not written (`COORDINATOR_HANDOFF_FAILURE_REASONS`).
public enum CoordinatorHandoffFailureCode: String, Codable, Equatable, Sendable, CaseIterable {
    case turnFailed = "TURN_FAILED"
    case turnStopped = "TURN_STOPPED"
    case timedOut = "TIMED_OUT"
    case emptyNote = "EMPTY_NOTE"
    /// The replacement threw: the outgoing coordinator is already completed, so Try again and Keep
    /// this coordinator cannot work — only Hand over without a note can.
    case replaceFailed = "REPLACE_FAILED"
    /// The note turn never reached the engine: this coordinator's own model could not start, and no successor
    /// was picked (with one, the server hands over without a note by itself).
    case coordinatorCantRun = "COORDINATOR_CANT_RUN"
}

/// What kind of pending work a `CoordinatorPendingWait` is (`CoordinatorPendingWaitKind`).
public enum CoordinatorPendingWaitKind: String, Codable, Equatable, Sendable, CaseIterable {
    case watch = "WATCH"
    case subagent = "SUBAGENT"
    case job = "JOB"
    case wakeup = "WAKEUP"
    case loop = "LOOP"
}

/// One piece of pending work the outgoing coordinator had, as the confirm dialog and "N waits moved
/// here" name it.
public struct CoordinatorPendingWait: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// A server without `kind`, a handoff recorded before it, or a kind this build does not know: a watch.
    public let kind: CoordinatorPendingWaitKind
    public let label: String
    /// A PAUSED watch: it moves and stays paused.
    public let paused: Bool

    public init(id: String, kind: CoordinatorPendingWaitKind = .watch, label: String, paused: Bool = false) {
        self.id = id
        self.kind = kind
        self.label = label
        self.paused = paused
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = (try? c.decodeIfPresent(CoordinatorPendingWaitKind.self, forKey: .kind)) ?? .watch
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        paused = try c.decodeIfPresent(Bool.self, forKey: .paused) ?? false
    }
}

/// The engine, provider slug and optional model requested for the new coordinator.
public struct CoordinatorHandoffSuccessor: Codable, Hashable, Sendable {
    public let engine: String?
    public let provider: String?
    public let model: String?

    public init(engine: String? = nil, provider: String? = nil, model: String? = nil) {
        self.engine = engine
        self.provider = provider
        self.model = model
    }

    /// "Same as this one" said on purpose: sent as `"successor": null`, which clears a pick saved earlier.
    public static let same = CoordinatorHandoffSuccessor()
}

/// A handoff press's body: `{}` when no successor is named (the handoff keeps what it has), `"successor": null`
/// for `.same`, else the pick.
struct CoordinatorHandoffRequest: Encodable {
    let successor: CoordinatorHandoffSuccessor?

    private enum CodingKeys: String, CodingKey { case successor }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if successor == .same { try c.encodeNil(forKey: .successor) }
        else { try c.encodeIfPresent(successor, forKey: .successor) }
    }
}

/// `coordinatorHandoff` on the OUTGOING coordinator's session.
public struct SessionCoordinatorHandoff: Codable, Equatable, Sendable {
    public let state: CoordinatorHandoffState
    /// When the current note turn was asked for (ISO) — the WRITING timer counts from it.
    public let startedAt: String
    public let failureCode: CoordinatorHandoffFailureCode?
    public let failureReason: String?
    public let handedOverToSessionId: String?
    public let successor: CoordinatorHandoffSuccessor?

    public init(state: CoordinatorHandoffState, startedAt: String,
                failureCode: CoordinatorHandoffFailureCode? = nil, failureReason: String? = nil,
                handedOverToSessionId: String? = nil, successor: CoordinatorHandoffSuccessor? = nil) {
        self.state = state
        self.startedAt = startedAt
        self.failureCode = failureCode
        self.failureReason = failureReason
        self.handedOverToSessionId = handedOverToSessionId
        self.successor = successor
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(CoordinatorHandoffState.self, forKey: .state)
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt) ?? ""
        // A code this build does not know is still a failure: the sentence beside it says why.
        failureCode = try? c.decodeIfPresent(CoordinatorHandoffFailureCode.self, forKey: .failureCode)
        failureReason = try c.decodeIfPresent(String.self, forKey: .failureReason)
        handedOverToSessionId = try c.decodeIfPresent(String.self, forKey: .handedOverToSessionId)
        successor = try c.decodeIfPresent(CoordinatorHandoffSuccessor.self, forKey: .successor)
    }
}

/// `coordinatorHandoffReceived` on the SUCCESSOR's session.
public struct SessionCoordinatorHandoffReceived: Codable, Equatable, Sendable {
    public let handoffFromSessionId: String
    /// Null when the owner skipped the note.
    public let note: String?
    public let handedOverAt: String
    public let movedWaits: [CoordinatorPendingWait]

    public init(handoffFromSessionId: String, note: String?, handedOverAt: String,
                movedWaits: [CoordinatorPendingWait] = []) {
        self.handoffFromSessionId = handoffFromSessionId
        self.note = note
        self.handedOverAt = handedOverAt
        self.movedWaits = movedWaits
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handoffFromSessionId = try c.decode(String.self, forKey: .handoffFromSessionId)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        handedOverAt = try c.decodeIfPresent(String.self, forKey: .handedOverAt) ?? ""
        movedWaits = (try? c.decodeIfPresent([CoordinatorPendingWait].self, forKey: .movedWaits)) ?? []
    }
}

/// What every handoff endpoint answers: the project's handoff as it now stands.
public struct CoordinatorHandoffView: Codable, Equatable, Sendable {
    public let projectId: String
    public let sessionId: String
    public let state: CoordinatorHandoffState
    public let startedAt: String?
    public let failureCode: CoordinatorHandoffFailureCode?
    public let failureReason: String?
    public let handedOverToSessionId: String?
    public let movedWaits: [CoordinatorPendingWait]?
    public let successor: CoordinatorHandoffSuccessor?
}
