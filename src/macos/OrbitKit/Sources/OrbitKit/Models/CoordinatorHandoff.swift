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
}

/// One wait the outgoing coordinator set, as the confirm dialog and "N waits moved here" name it.
public struct CoordinatorPendingWait: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    /// A PAUSED watch: it moves and stays paused.
    public let paused: Bool

    public init(id: String, label: String, paused: Bool = false) {
        self.id = id
        self.label = label
        self.paused = paused
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

    public init(state: CoordinatorHandoffState, startedAt: String,
                failureCode: CoordinatorHandoffFailureCode? = nil, failureReason: String? = nil,
                handedOverToSessionId: String? = nil) {
        self.state = state
        self.startedAt = startedAt
        self.failureCode = failureCode
        self.failureReason = failureReason
        self.handedOverToSessionId = handedOverToSessionId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(CoordinatorHandoffState.self, forKey: .state)
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt) ?? ""
        // A code this build does not know is still a failure: the sentence beside it says why.
        failureCode = try? c.decodeIfPresent(CoordinatorHandoffFailureCode.self, forKey: .failureCode)
        failureReason = try c.decodeIfPresent(String.self, forKey: .failureReason)
        handedOverToSessionId = try c.decodeIfPresent(String.self, forKey: .handedOverToSessionId)
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
}
