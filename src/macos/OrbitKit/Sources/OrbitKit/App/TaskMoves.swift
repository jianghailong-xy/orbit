import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE TASK-MOVE CARD A CONVERSATION DRAWS
   ─────────────────────────────────────────────────────────────────────────────────────────────

   A `MOVE_TASK` crossing is work an agent asks to bring an existing task into another project. It
   waits on the account owner, and until now the only place to answer it was the project page's
   crossings card. The server now counts the waiting moves on the session rows — the session that
   asked, and the coordinator of the project they go into — and serves them per session, grouped
   into batches (one asker, one source, one target), with one door that answers a whole batch.

   This client's half: the model of that read (`TaskMoveBatch`), the words its card says, and the
   two presses an answer takes. The card itself lives in `Views/TaskMoveCard.swift` and reuses the
   project page's `ProjectCrossingRow` for answering one move inside Show all — the same row, the
   same two presses, the same words (`ProjectCrossings.swift`).
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/// One batch of task moves a session draws as one card: the moves one session asked for out of one
/// project into another, as `GET /sessions/:id/task-moves` groups them.
///
/// A batch still waiting is every PENDING move of that trio; an answered one is the moves that one
/// answer settled (one state, one moment), so the card that was waiting becomes the line that says
/// what the answer did. `batchKey` is the server's stable key for it.
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

/// The words the card says, and the few rules over a batch that are not the view's.
public enum TaskMoves {
    /// The server's spelling of a batch nothing has answered.
    public static let waitingState = "PENDING"
    /// How many moves the card lists before Show all, as the board draws it.
    public static let collapsedCount = 3

    // MARK: the row

    /// The session row's word for `moves` waiting task moves — `@orbit/shared`'s
    /// `taskMovesRowWord`, word for word.
    public static func rowWord(_ moves: Int) -> String {
        moves == 1 ? "Approve task move" : "Approve \(moves) task moves"
    }

    // MARK: the card

    /// "Move 8 tasks into this project" — what the batch is, and that its answer moves them. In
    /// the asking session, when that session does not coordinate the target, the same line names
    /// the project they go into instead: "Move 8 tasks into Runner link hardening".
    public static func title(_ batch: TaskMoveBatch) -> String {
        guard !batch.drawnAs.contains(targetCoordinator) else { return title(batch.count) }
        let target = batch.moves.first?.toProject?.title ?? batch.toProjectId
        return count(batch.count, into: target)
    }

    /// The same words over a count, for a card with no batch to read: "this project" is the target
    /// when it is the conversation's own.
    public static func title(_ count: Int) -> String { self.count(count, into: "this project") }

    private static func count(_ count: Int, into target: String) -> String {
        count == 1 ? "Move 1 task into \(target)" : "Move \(count) tasks into \(target)"
    }

    /// The server's `drawnAs` values: this session asked, and this session coordinates the target.
    static let requester = "REQUESTER"
    static let targetCoordinator = "TARGET_COORDINATOR"

    /// The source end of the card's second line: `From <title> (<status>)`. The title and status
    /// are drawn by the view; this is the word before them.
    public static let from = "From "
    public static let askedByItsCoordinator = "Asked by its coordinator"
    /// The same line in the session that asked for the moves itself.
    public static let askedHere = "Asked here"

    /// "Asked by Runner link v1 coordinator · Nov 9, 08:31", or "Asked here · …" in the session
    /// that asked. A batch whose asker the server joined no name for keeps the board's own words,
    /// and a stamp this build cannot read leaves the date off rather than printing the raw value.
    public static func asked(_ batch: TaskMoveBatch) -> String {
        let who: String
        if batch.drawnAs.contains(requester) {
            who = askedHere
        } else if let title = batch.moves.first?.requestedBySession?.title, !title.isEmpty {
            who = "Asked by \(title)"
        } else {
            who = askedByItsCoordinator
        }
        guard let when = moment(batch.since) else { return who }
        return "\(who) · \(when)"
    }

    /// The task a move carries, and the target criterion it would count towards — the project
    /// page's two field names, in the same order (`ProjectCrossingRow.moveSubject` /
    /// `moveCriteria`).
    public static func moveLine(_ move: ProjectCrossing) -> String {
        var line = ProjectCrossings.moveSubjectLabel
        if let requested = move.requestedCriterion {
            let text = requested.text ?? ProjectCrossings.moveCriterionGone
            line += " · \(ProjectCrossings.moveRequestedCriterionLabel): \(text)"
        }
        return line
    }

    /// The second press's line under a move: the criterion, and the crossing key it sends back —
    /// "Criterion 4 · key d81f99d9…".
    public static func confirmLine(_ move: ProjectCrossing) -> String {
        let key = "\(keyLabel) \(ProjectCrossings.shortKey(move.crossingKey))…"
        guard let requested = move.requestedCriterion else { return key }
        let text = requested.text ?? ProjectCrossings.moveCriterionGone
        return "\(text) · \(key)"
    }

    /// The word before a crossing key on the second press, as the board writes it.
    public static let keyLabel = "key"

    /// "Show all 8" — the press that lists every move in the batch, each answerable on its own.
    public static func showAll(_ count: Int) -> String { "Show all \(count)" }
    /// The same press once every move is listed.
    public static let showFewer = "Show fewer"

    /// "and 5 more" — the second press names the first three and counts the rest.
    public static func more(_ count: Int) -> String { "and \(count) more" }

    /// The first press's buttons: "Approve 8 moves…" / "Approve 8 moves", and the one refusal the
    /// board writes without a count ("Refuse…").
    public static func approveAsk(_ count: Int) -> String {
        count == 1 ? "Approve move…" : "Approve \(count) moves…"
    }
    public static func approve(_ count: Int) -> String {
        count == 1 ? "Approve move" : "Approve \(count) moves"
    }
    public static func refuse(_ count: Int) -> String {
        count == 1 ? "Refuse move" : "Refuse \(count) moves"
    }

    /// The second press's question: "Approve 8 task moves?". A batch is one answer, so a refusal
    /// asks the same way.
    public static func confirmTitle(_ count: Int, _ decision: ProjectCrossingDecision) -> String {
        let verb = decision == .approve ? "Approve" : "Refuse"
        return "\(verb) \(count) task move\(count == 1 ? "" : "s")?"
    }

    /// What follows from each answer — the project page's own two sentences, not new words.
    public static func consequence(_ decision: ProjectCrossingDecision) -> String {
        decision == .approve ? ProjectCrossings.moveApproveConsequence : ProjectCrossings.moveDenyConsequence
    }

    /// The one line an answered batch is left as.
    public static func resolved(_ batch: TaskMoveBatch) -> String {
        switch batch.state {
        case "APPLIED":
            return moved(batch.count)
        case "DENIED":
            return batch.count == 1
                ? "Refused a task move into this project"
                : "Refused \(batch.count) task moves into this project"
        default:
            // A state this build has no sentence for still says which way it went, in its own
            // word, rather than showing the server's code alone.
            return "\(taskMoves(batch.count)) into this project: \(ProjectCrossings.label(batch.state))"
        }
    }

    public static func moved(_ count: Int) -> String {
        count == 1 ? "Moved 1 task into this project" : "Moved \(count) tasks into this project"
    }

    /// The batch's moves as one answer's body, each with the key the card read.
    public static func answer(_ batch: TaskMoveBatch, _ decision: ProjectCrossingDecision)
        -> TaskMoveBatchDecisionRequest {
        TaskMoveBatchDecisionRequest(
            decision: decision,
            moves: batch.moves.map { TaskMoveAnswer(handoffId: $0.id, crossingKey: $0.crossingKey) })
    }

    // MARK: small words

    private static func moves(_ count: Int) -> String { "\(count) move\(count == 1 ? "" : "s")" }
    private static func taskMoves(_ count: Int) -> String { "\(count) task move\(count == 1 ? "" : "s")" }

    /// The board's date: "Nov 9, 08:31". Deliberately not `RelativeTime` — this line says WHEN the
    /// move was asked, as the project page's crossings say it, and a day-old request reading
    /// "1d ago" loses the hour the owner is deciding about.
    public static func moment(_ iso: String) -> String? {
        guard let date = RelativeTime.parse(iso) else { return nil }
        return momentFormat.string(from: date)
    }

    private static let momentFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMM d, HH:mm"
        return f
    }()
}
