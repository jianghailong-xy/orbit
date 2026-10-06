import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   "CROSS-PROJECT CROSSINGS" — THIS CLIENT'S HALF OF WEB'S `ProjectCrossingsCard.tsx`
   ─────────────────────────────────────────────────────────────────────────────────────────────

   WHAT IS ASKED
   -------------
   Work an agent wants to take over a project's line: a task filed under another project
   (`FILE_TASK`), a dependency on another project's task (`DEPEND_ON_TASK`), or a task that already
   exists moved into another project (`MOVE_TASK`). Each one waits on the account owner — no
   coordinator signs a crossing for another goal — and `GET /projects/:id/handoffs` lists every one
   this project is an end of, in either direction.

   ANSWERING TAKES TWO PRESSES
   ---------------------------
   The first only asks. The second names the subject and both ends, says what follows from the
   answer, and sends the crossing key back with it: the server refuses an answer that names another
   crossing than the row at that id (`APPROVAL_TARGET_MISMATCH`), so a list that changed between the
   read and the press cannot turn one considered answer into an answer about somebody else's work.

   CONFIRMING A MOVE IS THE MOVE
   -----------------------------
   A yes to a `MOVE_TASK` moves the task, as the owner's act, and spends the request (`APPLIED`) in
   the same write; nobody sends anything again (account owner, 2026-10-06). So a move says so in
   its own words, never in a filing's.

   The words are the browser's, sentence for sentence: `ProjectCrossingsCard.tsx` and
   `lib/attribution.ts`. `ProjectCrossingsCardCopyParityTests` reads them back.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

// MARK: - the wire

/// One row of `GET /projects/:id/handoffs` — a declared crossing, from either end. Web's
/// `ProjectCrossingRow`.
public struct ProjectCrossing: Decodable, Equatable, Sendable, Identifiable {
    /// One end of the crossing by name, as the list joins it.
    public struct ProjectEnd: Decodable, Equatable, Sendable {
        public let title: String
        /// `OPEN`, `DONE` or `CANCELLED`.
        public let status: String?

        public init(title: String, status: String? = nil) {
            self.title = title
            self.status = status
        }
    }

    /// The task a `MOVE_TASK` moves, or a `DEPEND_ON_TASK` waits on, as it reads now.
    public struct SubjectTask: Decodable, Equatable, Sendable {
        public let id: String
        public let publicId: String?
        public let title: String

        public init(id: String, publicId: String? = nil, title: String) {
            self.id = id
            self.publicId = publicId
            self.title = title
        }
    }

    /// A criterion a move names: the target's it would count towards — whose `text` is nil once
    /// that criterion has been deleted — or the source's it serves now.
    public struct Criterion: Decodable, Equatable, Sendable {
        public let key: String
        public let text: String?

        public init(key: String, text: String?) {
            self.key = key
            self.text = text
        }
    }

    public let id: String
    /// The Base62 twin the server adds beside `id`. Absent from an older server.
    public let publicId: String?
    public let fromProjectId: String
    public let fromProjectPublicId: String?
    public let toProjectId: String
    public let toProjectPublicId: String?
    /// The two ends by name. Absent from a server that joined neither.
    public let fromProject: ProjectEnd?
    public let toProject: ProjectEnd?
    /// `FILE_TASK`, `DEPEND_ON_TASK` or `MOVE_TASK`, as the server spells it.
    public let kind: String
    public let subjectTaskId: String?
    public let subjectTaskPublicId: String?
    /// Nil for a filing and for a subject since deleted; absent from a server older than the move.
    public let subjectTask: SubjectTask?
    /// `MOVE_TASK`: the target project's criterion the request names. Nil when it names none.
    public let requestedCriterion: Criterion?
    /// `MOVE_TASK`: the source project's criterion the task declares today, which the move takes
    /// back. Nil when it declares none of the source project's.
    public let withdrawnCriterion: Criterion?
    /// The digest of the two ends and the subject — the crossing itself, not the row recording it.
    /// An answer echoes it back (`acknowledgedCrossingKey`).
    public let crossingKey: String
    /// `PENDING`, `APPROVED`, `DENIED` or `APPLIED`.
    public let state: String
    /// What the crossing is about: the plan's title, or the task's as it was when it was asked.
    public let title: String
    public let reason: String?
    public let requestedAt: String
    public let decidedAt: String?
    public let expiresAt: String?

    public init(id: String, publicId: String? = nil, fromProjectId: String,
                fromProjectPublicId: String? = nil, toProjectId: String, toProjectPublicId: String? = nil,
                fromProject: ProjectEnd? = nil, toProject: ProjectEnd? = nil, kind: String,
                subjectTaskId: String? = nil, subjectTaskPublicId: String? = nil,
                subjectTask: SubjectTask? = nil, requestedCriterion: Criterion? = nil,
                withdrawnCriterion: Criterion? = nil, crossingKey: String, state: String, title: String,
                reason: String? = nil, requestedAt: String, decidedAt: String? = nil,
                expiresAt: String? = nil) {
        self.id = id
        self.publicId = publicId
        self.fromProjectId = fromProjectId
        self.fromProjectPublicId = fromProjectPublicId
        self.toProjectId = toProjectId
        self.toProjectPublicId = toProjectPublicId
        self.fromProject = fromProject
        self.toProject = toProject
        self.kind = kind
        self.subjectTaskId = subjectTaskId
        self.subjectTaskPublicId = subjectTaskPublicId
        self.subjectTask = subjectTask
        self.requestedCriterion = requestedCriterion
        self.withdrawnCriterion = withdrawnCriterion
        self.crossingKey = crossingKey
        self.state = state
        self.title = title
        self.reason = reason
        self.requestedAt = requestedAt
        self.decidedAt = decidedAt
        self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey {
        case id, publicId, fromProjectId, fromProjectPublicId, toProjectId, toProjectPublicId
        case fromProject, toProject, kind, subjectTaskId, subjectTaskPublicId, subjectTask
        case requestedCriterion, withdrawnCriterion, crossingKey, state, title, reason
        case requestedAt, decidedAt, expiresAt
    }

    /// What a row cannot be answered without is required: which row, its two ends, what it is and
    /// where it stands, and the key an answer echoes. Everything the card only reads is decoded one
    /// field at a time, so an older server's row — no joined titles, no subject read, no criteria —
    /// is a row with less on it, never a list that fails to decode.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        publicId = try? c.decodeIfPresent(String.self, forKey: .publicId)
        fromProjectId = try c.decode(String.self, forKey: .fromProjectId)
        fromProjectPublicId = try? c.decodeIfPresent(String.self, forKey: .fromProjectPublicId)
        toProjectId = try c.decode(String.self, forKey: .toProjectId)
        toProjectPublicId = try? c.decodeIfPresent(String.self, forKey: .toProjectPublicId)
        fromProject = try? c.decodeIfPresent(ProjectEnd.self, forKey: .fromProject)
        toProject = try? c.decodeIfPresent(ProjectEnd.self, forKey: .toProject)
        kind = try c.decode(String.self, forKey: .kind)
        subjectTaskId = try? c.decodeIfPresent(String.self, forKey: .subjectTaskId)
        subjectTaskPublicId = try? c.decodeIfPresent(String.self, forKey: .subjectTaskPublicId)
        subjectTask = try? c.decodeIfPresent(SubjectTask.self, forKey: .subjectTask)
        requestedCriterion = try? c.decodeIfPresent(Criterion.self, forKey: .requestedCriterion)
        withdrawnCriterion = try? c.decodeIfPresent(Criterion.self, forKey: .withdrawnCriterion)
        crossingKey = try c.decode(String.self, forKey: .crossingKey)
        state = try c.decode(String.self, forKey: .state)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        requestedAt = (try? c.decodeIfPresent(String.self, forKey: .requestedAt)) ?? ""
        decidedAt = try? c.decodeIfPresent(String.self, forKey: .decidedAt)
        expiresAt = try? c.decodeIfPresent(String.self, forKey: .expiresAt)
    }

    /// A request to move a task that already exists — the kind whose yes IS the move.
    public var isMove: Bool { kind == ProjectCrossings.moveKind }
}

/// The two answers a person gives a crossing.
public enum ProjectCrossingDecision: String, Codable, Equatable, Sendable {
    case approve = "APPROVE"
    case deny = "DENY"
}

/// `POST /projects/:id/handoffs/:handoffId/decision`: the answer, and the crossing it is about.
public struct ProjectCrossingDecisionRequest: Encodable, Equatable, Sendable {
    public let decision: ProjectCrossingDecision
    /// The `crossingKey` of the row this answer was given on — what makes the second press a fence.
    public let acknowledgedCrossingKey: String

    public init(decision: ProjectCrossingDecision, acknowledgedCrossingKey: String) {
        self.decision = decision
        self.acknowledgedCrossingKey = acknowledgedCrossingKey
    }
}

// MARK: - the words and the logic

public enum ProjectCrossings {

    public static let moveKind = "MOVE_TASK"

    // MARK: the card

    public static let title = "Cross-project crossings"
    public static let unreadable = "Crossings could not be loaded"
    /// A project end the server sent no title for.
    public static let unnamedProject = "unnamed project"
    public static let arrow = " → "
    public static let approveAsk = "Approve…"
    public static let refuseAsk = "Refuse…"
    public static let cancel = "Cancel"
    /// The head over the second press's crossing key.
    public static let crossingKeyLabel = "Crossing"
    /// The head of a refused answer, over the server's code and reason.
    public static let notRecorded = "That answer was not recorded"

    /// How many crossings are still questions — the card's count.
    public static func waiting(_ count: Int) -> String {
        "\(count) waiting"
    }

    public static func reasonGiven(_ reason: String) -> String {
        "Reason given: \(reason)"
    }

    /// The part of the crossing key the second press shows.
    public static func shortKey(_ key: String) -> String {
        String(key.prefix(12))
    }

    // MARK: a move

    public static let moveSubjectLabel = "Task to move"
    public static let moveRequestedCriterionLabel = "Target criterion requested"
    public static let moveWithdrawnCriterionLabel = "Source criterion it serves now"
    public static let moveWithdrawnCriterionNote = "Confirming the move withdraws this declaration."
    public static let moveCriterionGone = "The target project no longer states this criterion."
    public static let moveApproveConsequence =
        "Confirming is the move: the task joins the target project as soon as you answer, and nobody has to send the request again."
    public static let moveDenyConsequence =
        "Refusing is final for this request, and the task stays where it is. If you change your mind, move the task yourself."

    /// What each state means for a move, where `TaskDetailCopy.crossingStateMeaning` speaks for a
    /// filing: the task is already filed, so "not filed anywhere until you answer" would be false of
    /// it.
    public static let moveStateMeaning: [String: String] = [
        "PENDING": "the task stays in its project until you answer, and confirming moves it",
        "APPROVED": "the task has not moved: this yes was recorded without moving it",
        "DENIED": "refusing is final for this request, and the task stays where it is",
        "APPLIED": "the task was moved when this request was confirmed",
    ]

    // MARK: a filing, and a dependency

    public static let fileApproveConsequence =
        "The writer may then file this work under the target project. It is not filed by this answer."
    public static let fileDenyConsequence =
        "Refusing is final for this crossing. If you change your mind, file the work yourself."

    // MARK: the state

    /// What a state is called — `lib/attribution.ts`'s `CROSSING_STATE_LABEL`, which the task page's
    /// attribution card already holds. A state nobody wrote a label for reads as its own code.
    public static func label(_ state: String) -> String {
        TaskDetailCopy.crossingStateLabel[state] ?? state
    }

    /// What follows from the row's state, in the words for its kind.
    public static func meaning(_ row: ProjectCrossing) -> String {
        (row.isMove ? moveStateMeaning : TaskDetailCopy.crossingStateMeaning)[row.state] ?? row.state
    }

    /// A crossing that is still a question is the only one that can be answered.
    public static func isAnswerable(_ state: String) -> Bool {
        state == "PENDING"
    }

    /// The crossings that are still questions, oldest first, then everything else newest first —
    /// web's `orderCrossings`: the question that has waited longest holds up the most, and history
    /// reads newest first.
    public static func ordered(_ rows: [ProjectCrossing]) -> [ProjectCrossing] {
        let pending = rows.filter { isAnswerable($0.state) }.sorted { $0.requestedAt < $1.requestedAt }
        let answered = rows.filter { !isAnswerable($0.state) }.sorted { $0.requestedAt > $1.requestedAt }
        return pending + answered
    }

    /// How many of these a person can still answer.
    public static func waitingCount(_ rows: [ProjectCrossing]) -> Int {
        rows.filter { isAnswerable($0.state) }.count
    }

    // MARK: ids and names

    /// The id a person can read and paste: Base62 when the server sent it, the raw id otherwise.
    public static func fromID(_ row: ProjectCrossing) -> String {
        row.fromProjectPublicId ?? row.fromProjectId
    }

    public static func toID(_ row: ProjectCrossing) -> String {
        row.toProjectPublicId ?? row.toProjectId
    }

    /// The task a move moves, by id.
    public static func subjectID(_ row: ProjectCrossing) -> String? {
        row.subjectTaskPublicId ?? row.subjectTaskId
    }

    /// A move's task as it reads now; the row's own title is the one it had when the move was asked.
    public static func subjectTitle(_ row: ProjectCrossing) -> String {
        row.subjectTask?.title ?? row.title
    }

    /// The id the decision door is addressed by.
    public static func doorID(_ row: ProjectCrossing) -> String {
        row.publicId ?? row.id
    }

    // MARK: the second press

    /// What the second press is agreeing to: the answer, the subject, both ends — by title, by id
    /// when the server sent none — and what follows from it.
    public struct Prompt: Equatable, Sendable {
        public let verb: String
        public let from: String
        public let to: String
        public let subject: String
        public let consequence: String

        public init(verb: String, from: String, to: String, subject: String, consequence: String) {
            self.verb = verb
            self.from = from
            self.to = to
            self.subject = subject
            self.consequence = consequence
        }
    }

    public static func prompt(_ row: ProjectCrossing, _ decision: ProjectCrossingDecision) -> Prompt {
        let verb = decision == .approve ? "Approve" : "Refuse"
        let from = row.fromProject?.title ?? fromID(row)
        let to = row.toProject?.title ?? toID(row)
        if row.isMove {
            return Prompt(verb: verb, from: from, to: to, subject: subjectTitle(row),
                          consequence: decision == .approve ? moveApproveConsequence : moveDenyConsequence)
        }
        return Prompt(verb: verb, from: from, to: to, subject: row.title,
                      consequence: decision == .approve ? fileApproveConsequence : fileDenyConsequence)
    }

    /// The second press's question, naming the subject and both ends.
    public static func question(_ prompt: Prompt) -> String {
        "\(prompt.verb) moving “\(prompt.subject)” from \(prompt.from) to \(prompt.to)?"
    }

    /// The press that sends the answer.
    public static func confirmLabel(_ prompt: Prompt) -> String {
        "Yes, \(prompt.verb.lowercased())"
    }

    /// The body of the press: the answer, and the key of the crossing it was given on.
    public static func request(_ row: ProjectCrossing,
                               _ decision: ProjectCrossingDecision) -> ProjectCrossingDecisionRequest {
        ProjectCrossingDecisionRequest(decision: decision, acknowledgedCrossingKey: row.crossingKey)
    }

    // MARK: a refused answer

    /// Why the door did not take an answer: its own code when it sent one, and its sentence. A move
    /// refused because its task is being landed right then says so, and that the request still
    /// waits.
    public struct Refusal: Equatable, Sendable {
        public let code: String?
        public let message: String

        public init(code: String?, message: String) {
            self.code = code
            self.message = message
        }
    }

    public static func refusal(_ error: Error) -> Refusal {
        Refusal(code: APIClient.refusalCode(error), message: APIClient.failureReason(error))
    }
}
