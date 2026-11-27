import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE TASK MOVES A SESSION IS SERVED
   ─────────────────────────────────────────────────────────────────────────────────────────────

   Emitted from TaskMoves.swift's first version; the move card itself is the crossing decision card
   main already draws (`CrossingBatches.swift`, `CrossingDecisionCard.swift`). What is left here is
   the wire the card is answered through: `GET /sessions/:id/task-moves` (a session's MOVE_TASK
   batches, as asker or as the target project's coordinator) and the one-door answer
   `POST /sessions/:id/task-moves/decision`, which writes nothing if any move's crossing key names
   another crossing. The row word "Approve task move(s)" is `@orbit/shared`'s.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/// One batch of task moves as `GET /sessions/:id/task-moves` groups them: the moves one session
/// asked for out of one project into another, or the moves waiting on it as that project's
/// coordinator.
public struct TaskMoveBatch: Decodable, Equatable, Sendable {
    public let batchKey: String
    public let requestedBySessionId: String
    public let fromProjectId: String
    public let toProjectId: String
    /// `PENDING` while waiting; `APPLIED`, `DENIED` (or `APPROVED`, an earlier build's yes that
    /// moved nothing) once answered.
    public let state: String
    /// The oldest move's request moment (ISO-8601) — where the card is drawn.
    public let since: String
    public let decidedAt: String?
    /// Whether this session asked for these moves, coordinates the project they go into, or both.
    public let drawnAs: [String]
    /// Oldest request first.
    public let moves: [ProjectCrossing]

    public var isWaiting: Bool { state == TaskMoves.waitingState }
    public var count: Int { moves.count }

    public init(batchKey: String, requestedBySessionId: String, fromProjectId: String,
                toProjectId: String, state: String, since: String, decidedAt: String? = nil,
                drawnAs: [String] = [], moves: [ProjectCrossing]) {
        self.batchKey = batchKey
        self.requestedBySessionId = requestedBySessionId
        self.fromProjectId = fromProjectId
        self.toProjectId = toProjectId
        self.state = state
        self.since = since
        self.decidedAt = decidedAt
        self.drawnAs = drawnAs
        self.moves = moves
    }

    private enum CodingKeys: String, CodingKey {
        case batchKey, requestedBySessionId, fromProjectId, toProjectId, state, since, decidedAt
        case drawnAs, moves
    }

    /// Every field this build does not know is read leniently, so a server that adds one never
    /// makes the read — and the card — fail. The rows themselves decode through `ProjectCrossing`,
    /// which already answers an older server's missing detail with a row that says less.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        batchKey = try c.decode(String.self, forKey: .batchKey)
        requestedBySessionId = (try? c.decodeIfPresent(String.self, forKey: .requestedBySessionId)) ?? ""
        fromProjectId = (try? c.decodeIfPresent(String.self, forKey: .fromProjectId)) ?? ""
        toProjectId = (try? c.decodeIfPresent(String.self, forKey: .toProjectId)) ?? ""
        state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "UNKNOWN"
        since = (try? c.decodeIfPresent(String.self, forKey: .since)) ?? ""
        decidedAt = try? c.decodeIfPresent(String.self, forKey: .decidedAt)
        drawnAs = (try? c.decodeIfPresent([String].self, forKey: .drawnAs)) ?? []
        moves = (try? c.decodeIfPresent([ProjectCrossing].self, forKey: .moves)) ?? []
    }
}

/// One move of a batch answer: the row, and the crossing key the card was drawn from. The server
/// refuses an answer whose key names another crossing, and answers nothing of a batch where any
/// one disagrees (`APPROVAL_TARGET_MISMATCH`).
public struct TaskMoveAnswer: Encodable, Equatable, Sendable {
    public let handoffId: String
    public let crossingKey: String

    public init(handoffId: String, crossingKey: String) {
        self.handoffId = handoffId
        self.crossingKey = crossingKey
    }
}

/// `POST /sessions/:id/task-moves/decision`: one answer for a whole batch.
public struct TaskMoveBatchDecisionRequest: Encodable, Equatable, Sendable {
    public let decision: ProjectCrossingDecision
    public let moves: [TaskMoveAnswer]

    public init(decision: ProjectCrossingDecision, moves: [TaskMoveAnswer]) {
        self.decision = decision
        self.moves = moves
    }
}

public enum TaskMoves {
    /// The server's spelling of a batch nothing has answered.
    public static let waitingState = "PENDING"

    /// The session row's word for `moves` waiting task moves — `@orbit/shared`'s
    /// `taskMovesRowWord`, word for word.
    public static func rowWord(_ moves: Int) -> String {
        moves == 1 ? "Approve task move" : "Approve \(moves) task moves"
    }

    /// The batch's moves as one answer's body, each with the key the card read. Only moves still
    /// waiting are sent: a row answered meanwhile is the door's `HANDOFF_ALREADY_ANSWERED`.
    public static func answer(_ rows: [ProjectCrossing], _ decision: ProjectCrossingDecision)
        -> TaskMoveBatchDecisionRequest {
        TaskMoveBatchDecisionRequest(
            decision: decision,
            moves: rows.map { TaskMoveAnswer(handoffId: $0.id, crossingKey: $0.crossingKey) })
    }
}
