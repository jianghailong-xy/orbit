import Foundation

// Five more of Orbit's own turns, drawn as cards rather than as the reader's bubble or an empty
// bubble with the block folded under it (docs/mocks/orbit-turn-cards/) — this end's copy of
// shared/src/orbit-turn-cards.ts. Each is read off the payload the control plane recorded beside the
// turn, under the key of the same name, on the `user` event and on the queued and active turn rows;
// never out of the turn's words. A payload that is not one parses as nil, and the turn keeps its old
// reading. Web parity: `lib/orbitTurnCards.ts`, `OrbitTurnCards.tsx`.

/// `evidenceReview` — a revision handed to the session that dispatched its task.
public struct EvidenceReviewCard: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case open = "OPEN", superseded = "SUPERSEDED",
                                                         decided = "DECIDED", closed = "CLOSED" }
    public let evidenceId: String
    public let taskId: String
    public let title: String
    public let revision: String
    public let runSessionId: String
    public let dueAt: String?
    public let claim: String?
    public let state: State
    public let latestRevision: String
    /// CONFIRM or SEND_BACK once decided.
    public let decision: String?

    public init(evidenceId: String = "", taskId: String, title: String, revision: String, runSessionId: String,
                dueAt: String? = nil, claim: String? = nil, state: State = .open, latestRevision: String? = nil,
                decision: String? = nil) {
        self.evidenceId = evidenceId
        self.taskId = taskId
        self.title = title
        self.revision = revision
        self.runSessionId = runSessionId
        self.dueAt = dueAt
        self.claim = claim
        self.state = state
        self.latestRevision = latestRevision ?? revision
        self.decision = decision
    }

    public static func parse(_ payload: JSONValue) -> EvidenceReviewCard? { parseCard(payload["evidenceReview"]) }

    public static func parseCard(_ value: JSONValue?) -> EvidenceReviewCard? {
        guard let card = value, case .object = card,
              let taskId = card["taskId"]?.stringValue, !taskId.isEmpty,
              let title = card["title"]?.stringValue,
              let revision = card["revision"]?.asString,
              let runSessionId = card["runSessionId"]?.stringValue,
              let state = card["state"]?.stringValue.flatMap(State.init(rawValue:)) else { return nil }
        return EvidenceReviewCard(evidenceId: card["evidenceId"]?.stringValue ?? "", taskId: taskId, title: title,
                                  revision: revision, runSessionId: runSessionId,
                                  dueAt: card["dueAt"]?.stringValue, claim: card["claim"]?.stringValue,
                                  state: state, latestRevision: card["latestRevision"]?.asString ?? revision,
                                  decision: card["decision"]?.stringValue)
    }
}

/// `evidenceSendBack` — a send-back's note handed to the run that submitted the revision.
public struct EvidenceSendBackCard: Codable, Equatable, Sendable {
    public let decisionId: String
    public let taskId: String
    public let title: String
    public let revision: String
    public let note: String
    /// The account owner pressed Send back (`by: OWNER`); otherwise a session decided.
    public let byOwner: Bool
    public let bySessionId: String?
    public let byTitle: String?

    public init(decisionId: String = "", taskId: String, title: String, revision: String, note: String,
                byOwner: Bool, bySessionId: String? = nil, byTitle: String? = nil) {
        self.decisionId = decisionId
        self.taskId = taskId
        self.title = title
        self.revision = revision
        self.note = note
        self.byOwner = byOwner
        self.bySessionId = bySessionId
        self.byTitle = byTitle
    }

    public static func parse(_ payload: JSONValue) -> EvidenceSendBackCard? { parseCard(payload["evidenceSendBack"]) }

    public static func parseCard(_ value: JSONValue?) -> EvidenceSendBackCard? {
        guard let card = value, case .object = card,
              let taskId = card["taskId"]?.stringValue, !taskId.isEmpty,
              let title = card["title"]?.stringValue,
              let revision = card["revision"]?.asString,
              let note = card["note"]?.stringValue,
              let by = card["by"]?.stringValue, by == "OWNER" || by == "SESSION" else { return nil }
        return EvidenceSendBackCard(decisionId: card["decisionId"]?.stringValue ?? "", taskId: taskId, title: title,
                                    revision: revision, note: note, byOwner: by == "OWNER",
                                    bySessionId: card["bySessionId"]?.stringValue,
                                    byTitle: card["byTitle"]?.stringValue)
    }
}

/// `runQuestion` — a task run's question routed to its project's coordinator. Read-only here: the
/// coordinator answers it with `session_reply`, or the owner on their own card once it is passed on.
public struct RunQuestionCard: Codable, Equatable, Sendable {
    public struct Question: Codable, Equatable, Sendable {
        public let question: String
        public let multiSelect: Bool
        public let options: [String]

        public init(question: String, multiSelect: Bool = false, options: [String]) {
            self.question = question
            self.multiSelect = multiSelect
            self.options = options
        }
    }

    public let requestId: String
    public let approvalId: String
    public let taskId: String?
    public let taskTitle: String
    public let runSessionId: String
    public let replyBy: String
    public let state: String
    public let approvalStatus: String
    public let questions: [Question]
    /// What was answered, keyed by question text, once answered.
    public let answers: [String: [String]]?
    /// SESSION: the coordinator answered it. OWNER: the account owner did. Nil while unanswered.
    public let answeredBy: String?

    public init(requestId: String, approvalId: String = "", taskId: String?, taskTitle: String, runSessionId: String,
                replyBy: String, state: String = "OPEN", approvalStatus: String = "PENDING",
                questions: [Question], answers: [String: [String]]? = nil, answeredBy: String? = nil) {
        self.requestId = requestId
        self.approvalId = approvalId
        self.taskId = taskId
        self.taskTitle = taskTitle
        self.runSessionId = runSessionId
        self.replyBy = replyBy
        self.state = state
        self.approvalStatus = approvalStatus
        self.questions = questions
        self.answers = answers
        self.answeredBy = answeredBy
    }

    public static func parse(_ payload: JSONValue) -> RunQuestionCard? { parseCard(payload["runQuestion"]) }

    /// Whether the card is worth reading live (`SessionRequestView.runQuestion`): not once the stored
    /// card already says who answered, which never changes.
    public var readsLive: Bool { answeredBy == nil }

    /// The card to draw: the request's card as it stands now over the one the echo stored, while the
    /// stored one is unanswered (web parity: `RunQuestionTurnCard`'s `live ?? stored`).
    public static func drawn(stored: RunQuestionCard, live: SessionRequestView?) -> RunQuestionCard {
        guard stored.readsLive, let card = live?.runQuestion else { return stored }
        return card
    }

    /// Whether to look again on the slow poll: before the first read, while the request waits, and
    /// while the card, passed to the owner, waits for their answer (web parity: `sessionRequestQuery`).
    public static func keepsReading(_ live: SessionRequestView?) -> Bool {
        guard let live else { return true }
        if live.state == .open { return true }
        guard let card = live.runQuestion else { return false }
        return card.answeredBy == nil && card.approvalStatus == "PENDING"
    }

    public static func parseCard(_ value: JSONValue?) -> RunQuestionCard? {
        guard let card = value, case .object = card,
              let requestId = card["requestId"]?.stringValue,
              let runSessionId = card["runSessionId"]?.stringValue,
              let replyBy = card["replyBy"]?.stringValue,
              let state = card["state"]?.stringValue,
              case .array(let raw)? = card["questions"] else { return nil }
        let questions: [Question] = raw.compactMap { item in
            guard let question = item["question"]?.stringValue else { return nil }
            var options: [String] = []
            if case .array(let list)? = item["options"] {
                options = list.compactMap { $0["label"]?.stringValue }
            }
            return Question(question: question, multiSelect: item["multiSelect"]?.boolValue ?? false, options: options)
        }
        var answers: [String: [String]]?
        if case .object(let picked)? = card["answers"] {
            var read: [String: [String]] = [:]
            for (question, value) in picked {
                if case .array(let values) = value { read[question] = values.compactMap(\.stringValue) }
                else if let one = value.stringValue { read[question] = [one] }
            }
            answers = read
        }
        let answeredBy = card["answeredBy"]?.stringValue.flatMap { $0 == "SESSION" || $0 == "OWNER" ? $0 : nil }
        return RunQuestionCard(requestId: requestId, approvalId: card["approvalId"]?.stringValue ?? "",
                               taskId: card["taskId"]?.stringValue, taskTitle: card["taskTitle"]?.stringValue ?? "",
                               runSessionId: runSessionId, replyBy: replyBy, state: state,
                               approvalStatus: card["approvalStatus"]?.stringValue ?? "",
                               questions: questions, answers: answers, answeredBy: answeredBy)
    }

    /// One line under a question: an option, ticked when it was picked; or the person's own words,
    /// a picked value that is no option's label.
    public struct Line: Equatable, Sendable {
        public let text: String
        public let picked: Bool
    }

    public func lines(_ question: Question) -> [Line] {
        let picked = answers?[question.question] ?? []
        var lines = question.options.map { option in
            picked.contains(option) ? Line(text: "\u{2713} \(option)", picked: true) : Line(text: option, picked: false)
        }
        for own in picked where !question.options.contains(own) {
            lines.append(Line(text: "\u{2713} \u{201C}\(own)\u{201D}", picked: true))
        }
        return lines
    }

    public var answered: Bool { answeredBy != nil }
}

/// `runNotice` — a task run's notify, which reaches its coordinator and not the owner.
public struct RunNoticeCard: Codable, Equatable, Sendable {
    public let requestId: String
    public let taskId: String?
    public let taskTitle: String
    public let runSessionId: String
    public let message: String
    public let state: String

    public init(requestId: String, taskId: String?, taskTitle: String, runSessionId: String,
                message: String, state: String = "OPEN") {
        self.requestId = requestId
        self.taskId = taskId
        self.taskTitle = taskTitle
        self.runSessionId = runSessionId
        self.message = message
        self.state = state
    }

    public static func parse(_ payload: JSONValue) -> RunNoticeCard? { parseCard(payload["runNotice"]) }

    public static func parseCard(_ value: JSONValue?) -> RunNoticeCard? {
        guard let card = value, case .object = card,
              let requestId = card["requestId"]?.stringValue,
              let runSessionId = card["runSessionId"]?.stringValue,
              let message = card["message"]?.stringValue else { return nil }
        return RunNoticeCard(requestId: requestId, taskId: card["taskId"]?.stringValue,
                             taskTitle: card["taskTitle"]?.stringValue ?? "", runSessionId: runSessionId,
                             message: message, state: card["state"]?.stringValue ?? "")
    }
}

/// `sessionOpening` — the opening turn of a session Orbit opened with a prompt of its own: one line
/// saying why, with the brief folded under it.
public struct SessionOpeningCard: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case coordinator = "COORDINATOR", judgment = "JUDGMENT", dispatch = "DISPATCH",
             mention = "MENTION", other = "OTHER"
    }
    public struct Target: Codable, Equatable, Sendable {
        /// PROJECT, TASK or LIST.
        public let kind: String
        public let id: String
        public let title: String

        public init(kind: String, id: String, title: String) {
            self.kind = kind
            self.id = id
            self.title = title
        }

        /// The app's own door for it: `orbit-project:`, `orbit-task:`, `orbit-list:`.
        public var url: URL? {
            let scheme: String
            switch kind {
            case "PROJECT": scheme = "orbit-project"
            case "TASK": scheme = "orbit-task"
            case "LIST": scheme = "orbit-list"
            default: return nil
            }
            guard PublicID.toUUID(id) != nil else { return nil }
            return URL(string: "\(scheme):\(id)")
        }
    }

    public let kind: Kind
    public let target: Target?
    /// The owner's comment, for a mention's reply: their own words, shown as theirs.
    public let mention: String?

    public init(kind: Kind, target: Target?, mention: String? = nil) {
        self.kind = kind
        self.target = target
        self.mention = mention
    }

    public static func parse(_ payload: JSONValue) -> SessionOpeningCard? { parseCard(payload["sessionOpening"]) }

    public static func parseCard(_ value: JSONValue?) -> SessionOpeningCard? {
        guard let card = value, case .object = card,
              let kind = card["kind"]?.stringValue.flatMap(Kind.init(rawValue:)) else { return nil }
        var target: Target?
        if let t = card["target"], let kind = t["kind"]?.stringValue, ["PROJECT", "TASK", "LIST"].contains(kind),
           let id = t["id"]?.stringValue, let title = t["title"]?.stringValue {
            target = Target(kind: kind, id: id, title: title)
        }
        return SessionOpeningCard(kind: kind, target: target, mention: card["mention"]?.stringValue)
    }

    /// The sentence before the target's link — the whole sentence when there is no target to name.
    public var lead: String {
        guard target != nil else { return OrbitTurnCardCopy.openingOther }
        switch kind {
        case .coordinator: return OrbitTurnCardCopy.openingCoordinator
        case .judgment: return OrbitTurnCardCopy.openingJudgment
        case .dispatch: return OrbitTurnCardCopy.openingDispatch
        case .mention: return OrbitTurnCardCopy.openingMention
        case .other: return OrbitTurnCardCopy.openingOther
        }
    }

    /// The target, only where the sentence names one.
    public var linkedTarget: Target? { kind == .other ? nil : target }
}

/// How a card's state line reads: its words and the colour they take.
public struct OrbitTurnCardStateLine: Equatable, Sendable {
    public enum Tone: Equatable, Sendable { case secondary, warning, success }
    public let text: String
    public let tone: Tone
}

/// The words of the five cards, word for word as the web defines them (`orbitTurnCardsCopy`).
public enum OrbitTurnCardCopy {
    public static let evidenceToReview = "Evidence to review"
    public static let evidenceSentBack = "Evidence sent back"
    public static let questionFromTaskRun = "Question from a task run"
    public static let noticeFromTaskRun = "Notice from a task run"
    public static let sessionWasTold = "What this session was told"
    public static let runWasTold = "What the run was told"
    public static let coordinatorWasTold = "What the coordinator was told"
    public static let showAll = "Show all"
    public static let showLess = "Show less"
    public static let showBrief = "Show brief"
    public static let hideBrief = "Hide brief"
    public static let aTaskRun = "A task run"
    public static let you = "you"
    public static let aSession = "a session"
    public static let noticeState = "Nothing to reply to. It did not reach you."
    public static let openingCoordinator = "Orbit started this session as the coordinator of"
    public static let openingJudgment = "Orbit started this session to judge"
    public static let openingDispatch = "Orbit started this session to dispatch the list"
    public static let openingMention = "Orbit started this session for your mention on"
    public static let openingOther = "Orbit started this session"

    /// "Revision 2 · Due 13:35" — the due time only once the turn was handed out.
    public static func evidenceMeta(_ card: EvidenceReviewCard, now: Date = Date()) -> String {
        let due = card.dueAt.flatMap { OwnerConfirmations.receiptTime($0, now: now) }
        return "Revision \(card.revision)" + (due.map { " · Due \($0)" } ?? "")
    }

    /// "Revision 1 · by " — the who follows, as a link or as plain words.
    public static func sendBackLead(_ card: EvidenceSendBackCard) -> String { "Revision \(card.revision) · by " }

    public static func sendBackWho(_ card: EvidenceSendBackCard) -> String {
        card.byOwner ? you : (card.byTitle?.isEmpty == false ? card.byTitle! : aSession)
    }

    public static func taskTitle(_ title: String) -> String { title.isEmpty ? aTaskRun : title }

    public static func evidenceState(_ card: EvidenceReviewCard, now: Date = Date()) -> OrbitTurnCardStateLine {
        switch card.state {
        case .superseded:
            return .init(text: "Revision \(card.latestRevision) replaced it. Nothing to decide.", tone: .secondary)
        case .decided:
            return card.decision == "CONFIRM" ? .init(text: "Confirmed.", tone: .success)
                : .init(text: "Sent back.", tone: .secondary)
        case .closed:
            return .init(text: "The task is closed. Nothing to decide.", tone: .secondary)
        case .open:
            guard let dueAt = card.dueAt, let due = RelativeTime.parse(dueAt),
                  let time = OwnerConfirmations.receiptTime(dueAt, now: now) else {
                return .init(text: "This session decides it.", tone: .secondary)
            }
            return now < due
                ? .init(text: "This session decides it. If it hasn't by \(time), you're asked.", tone: .secondary)
                : .init(text: "You were asked at \(time).", tone: .warning)
        }
    }

    public static func questionState(_ card: RunQuestionCard, now: Date = Date()) -> OrbitTurnCardStateLine {
        if card.answeredBy == "SESSION" { return .init(text: "Answered by this session.", tone: .success) }
        if card.answeredBy == "OWNER" { return .init(text: "Answered by you.", tone: .success) }
        let time = OwnerConfirmations.receiptTime(card.replyBy, now: now) ?? card.replyBy
        if card.state == "OPEN", let replyBy = RelativeTime.parse(card.replyBy), now < replyBy {
            return .init(text: "The run is waiting. This session answers it; if it hasn't by \(time), you're asked.",
                         tone: .secondary)
        }
        if card.approvalStatus == "PENDING" { return .init(text: "Passed to you at \(time).", tone: .warning) }
        return .init(text: "Closed without an answer.", tone: .secondary)
    }
}
