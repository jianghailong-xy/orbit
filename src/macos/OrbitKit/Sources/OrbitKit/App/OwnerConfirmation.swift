import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE OWNER-CONFIRMATION CARD — THE NATIVE HALF OF WEB'S `OwnerConfirmationCard.tsx`
   ─────────────────────────────────────────────────────────────────────────────────────────────

   AN OWNER_CONFIRMED TASK IS SETTLED BY ITS OWNER, AND BY NOBODY ELSE
   ------------------------------------------------------------------
   The fourth completion criterion ends a run the way the other three end a verification: a run of
   the task finishes its turn, the server records that as a question addressed to the account owner
   (`owner-confirmation-read.ts`), and the answer is one `POST /tasks/:taskId/owner-confirmation`
   with the owner's own sign-in — no `x-orbit-session-id`, no agent in the path. So this is not an
   approval: nothing stops the turn for it, and the card is drawn from the read the same way the
   evidence card is (`EvidenceDecision.swift`), in the run's own session, in whatever project the
   task is filed under — including none.

   ONE PLACE TO ANSWER
   -------------------
   While a run of the task is waiting, the card in that run's session is the only place it is
   answered; the task's own panel only points at it. With no run waiting — a task that never ran, or
   one whose report was already answered — the panel carries `Confirm done` itself. Never both: a
   second place to answer is a second answer racing the first.

   NOTHING IS FROZEN INTO THE CARD EXCEPT THE ADDRESS
   --------------------------------------------------
   A delivered card keeps one thing across renders — the `requestId` it was drawn for, which is the
   door's compare-and-set — and re-derives everything else from the read. So a request answered in a
   browser, displaced by a later run's report, or not readable right now is a conclusion about the
   read rather than local state somebody has to remember to clear, and the two buttons below are
   live in exactly one of those cases.

   The mirror on the other side is `src/web/src/components/OwnerConfirmationCard.tsx`.
   `OwnerConfirmationCopyParityTests` reads that file and fails when the words drift.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

// MARK: - the read, as the server publishes it

/// What the run said when it ended the turn the owner is being asked about: its last message.
public struct OwnerConfirmationReport: Codable, Equatable, Sendable {
    public let text: String
    /// ISO-8601, as JSON carries it. Never parsed here.
    public let reportedAt: String

    public init(text: String, reportedAt: String) {
        self.text = text
        self.reportedAt = reportedAt
    }
}

/// The question in front of the owner now. `sessionId` is where the card is drawn and where a
/// send-back's reason is delivered.
public struct OwnerConfirmationWaiting: Codable, Equatable, Sendable {
    public let requestId: String
    public let sessionId: String
    public let requestedAt: String
    public let report: OwnerConfirmationReport?

    public init(requestId: String, sessionId: String, requestedAt: String,
                report: OwnerConfirmationReport? = nil) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.requestedAt = requestedAt
        self.report = report
    }
}

/// One decision the owner recorded, as its receipt draws it back.
public struct RecordedOwnerDecision: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let decision: OwnerDecision
    public let note: String?
    public let decidedAt: String
    public let decidedByType: String?
    /// The request it answered; nil for a confirmation pressed while no run was waiting.
    public let requestId: String?
    /// The session the answered run reported in, where its receipt is drawn; nil with `requestId`.
    public let sessionId: String?
    /// What that run had reported, so a receipt can say what was confirmed.
    public let report: OwnerConfirmationReport?

    public init(id: String, decision: OwnerDecision, note: String? = nil, decidedAt: String,
                decidedByType: String? = nil, requestId: String? = nil, sessionId: String? = nil,
                report: OwnerConfirmationReport? = nil) {
        self.id = id
        self.decision = decision
        self.note = note
        self.decidedAt = decidedAt
        self.decidedByType = decidedByType
        self.requestId = requestId
        self.sessionId = sessionId
        self.report = report
    }
}

/// `GET /tasks/:taskId/owner-confirmation`.
public struct OwnerConfirmationView: Codable, Equatable, Sendable {
    public let taskId: String
    public let title: String
    public let status: String
    public let projectId: String?
    public let completionCriterion: String
    /// What settles the task, in its own words.
    public let acceptanceCriteria: String?
    /// Null unless the task declares OWNER_CONFIRMED, has not settled, and a run is waiting on it.
    public let waiting: OwnerConfirmationWaiting?
    /// Every decision recorded about this task, oldest first.
    public let decisions: [RecordedOwnerDecision]

    public init(taskId: String, title: String, status: String, projectId: String? = nil,
                completionCriterion: String, acceptanceCriteria: String? = nil,
                waiting: OwnerConfirmationWaiting? = nil,
                decisions: [RecordedOwnerDecision] = []) {
        self.taskId = taskId
        self.title = title
        self.status = status
        self.projectId = projectId
        self.completionCriterion = completionCriterion
        self.acceptanceCriteria = acceptanceCriteria
        self.waiting = waiting
        self.decisions = decisions
    }
}

// MARK: - the door

/// The two answers the door takes. As with the evidence door there is deliberately no third that
/// leaves the question pending: not deciding yet is simply not pressing.
public enum OwnerDecision: String, Codable, Equatable, Sendable {
    case confirm = "CONFIRM"
    case sendBack = "SEND_BACK"
}

/// The body one press sends to `POST /tasks/:taskId/owner-confirmation`.
///
/// `requestId` is the report the card was drawn for — the compare-and-set the door holds a press
/// to — and nil for the task panel, which answers "no run is waiting". It is always written, null
/// included, so what reaches the door says which question was answered rather than leaving it
/// implied; `note` rides with a send-back and with nothing else.
public struct OwnerDecisionRequest: Codable, Equatable, Sendable {
    public let decision: OwnerDecision
    public let requestId: String?
    public let note: String?

    public init(decision: OwnerDecision, requestId: String? = nil, note: String? = nil) {
        self.decision = decision
        self.requestId = requestId
        self.note = note
    }

    private enum CodingKeys: String, CodingKey { case decision, requestId, note }

    public func encode(to encoder: Encoder) throws {
        var box = encoder.container(keyedBy: CodingKeys.self)
        try box.encode(decision, forKey: .decision)
        try box.encode(requestId, forKey: .requestId)
        try box.encodeIfPresent(note, forKey: .note)
    }
}

/// What the door returns once it recorded one — read back, never recomputed by a client.
public struct OwnerDecisionResult: Codable, Equatable, Sendable {
    public let id: String
    public let taskId: String
    public let decision: OwnerDecision
    public let note: String?
    public let decidedAt: String
    public let decidedByType: String?
    public let requestId: String?
    /// The session whose run the decision answered; nil for a confirmation that answered none.
    public let sessionId: String?
    /// Whether this decision settled the task DONE.
    public let completed: Bool?

    public init(id: String, taskId: String, decision: OwnerDecision, note: String? = nil,
                decidedAt: String, decidedByType: String? = nil, requestId: String? = nil,
                sessionId: String? = nil, completed: Bool? = nil) {
        self.id = id
        self.taskId = taskId
        self.decision = decision
        self.note = note
        self.decidedAt = decidedAt
        self.decidedByType = decidedByType
        self.requestId = requestId
        self.sessionId = sessionId
        self.completed = completed
    }
}

// MARK: - where one delivered card stands right now

/// The shapes a delivered card can be in, derived from the read and from nothing else.
public struct OwnerConfirmationStanding: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        /// The request is still the one waiting in THIS session, so the door would take an answer.
        case waiting(OwnerConfirmationWaiting)
        /// A decision answering this request is in the read: the card is a receipt now.
        case answered(RecordedOwnerDecision)
        /// Something else is waiting — a later report, or a report in another session. Every answer
        /// this card could send would be refused as stale; the newer question has its own card.
        case superseded(OwnerConfirmationWaiting)
        /// Nothing is waiting and nothing answers this request: the task settled, or was reopened.
        case notWaiting
        /// The read has not come back.
        case unread
    }

    public let taskId: String
    public let requestId: String
    public let state: State

    public init(taskId: String, requestId: String, state: State) {
        self.taskId = taskId
        self.requestId = requestId
        self.state = state
    }

    /// The report being asked about, or nil when the read no longer publishes this request as the
    /// question. A card that can no longer be answered shows its address and no report: see the
    /// file header.
    public var waiting: OwnerConfirmationWaiting? {
        if case .waiting(let waiting) = state { return waiting }
        return nil
    }

    /// The decision this card became, when it has been answered.
    public var receipt: RecordedOwnerDecision? {
        if case .answered(let decided) = state { return decided }
        return nil
    }

    /// Whether the door would take an answer from this card: true for exactly one state.
    public var answerable: Bool { waiting != nil }
}

/// The send-back half of the action area, as state a view holds and a test can assert on — the same
/// value-not-three-booleans shape `EvidenceSendBackState` takes, and for the same reason: "the send
/// control is dead until a reason exists" is one testable predicate instead of a condition spelled
/// into a view modifier. The rule belongs to the server: the door refuses a SEND_BACK carrying no
/// note and writes nothing at all, so a control that would send one cannot be pressable.
public struct OwnerSendBackState: Equatable, Sendable {
    /// Whether the reason box is open. Closed until `Send back…` is pressed: a permanently visible
    /// box reads like an invitation to say something rather than like the one thing that makes the
    /// button work.
    public var open: Bool
    public var note: String

    public init(open: Bool = false, note: String = "") {
        self.open = open
        self.note = note
    }

    /// The note as it would be sent: trimmed, because whitespace is not a reason.
    public var trimmedNote: String {
        note.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Whether the send control may be pressed — the reason half of it. Whether the QUESTION may be
    /// answered at all is the standing's `answerable`, and both are required.
    public var canSend: Bool { !trimmedNote.isEmpty }
}

// MARK: - the logic

public enum OwnerConfirmations {

    // MARK: which session gets the card, and where one stands

    /// The question waiting in THIS session, or nil — the card is drawn in the session that
    /// reported, in no other (`ownerConfirmationWaitingIn` on the web side).
    public static func waitingIn(_ view: OwnerConfirmationView?,
                                 sessionID: String?) -> OwnerConfirmationWaiting? {
        guard let waiting = view?.waiting, let sessionID else { return nil }
        return waiting.sessionId == sessionID ? waiting : nil
    }

    /// The decisions whose receipts belong in this session: the ones that answered its run.
    public static func receiptsIn(_ view: OwnerConfirmationView?,
                                  sessionID: String?) -> [RecordedOwnerDecision] {
        guard let view, let sessionID else { return [] }
        return view.decisions.filter { $0.sessionId == sessionID }
    }

    /// Where one delivered card stands RIGHT NOW. A nil read is `unread` and never "nothing is
    /// waiting": a card that could not re-derive itself cannot say the door would accept anything.
    public static func standing(_ view: OwnerConfirmationView?, sessionID: String?,
                                requestID: String) -> OwnerConfirmationStanding {
        OwnerConfirmationStanding(taskId: view?.taskId ?? "", requestId: requestID,
                                  state: state(view, sessionID: sessionID, requestID: requestID))
    }

    private static func state(_ view: OwnerConfirmationView?, sessionID: String?,
                              requestID: String) -> OwnerConfirmationStanding.State {
        guard let view else { return .unread }
        // Answered first: a request a decision answers is over, whatever has been asked since — the
        // new question has its own card and this one has become its receipt.
        if let decided = view.decisions.first(where: { $0.requestId == requestID }) {
            return .answered(decided)
        }
        guard let waiting = view.waiting else { return .notWaiting }
        guard waiting.requestId == requestID, waiting.sessionId == sessionID else {
            return .superseded(waiting)
        }
        return .waiting(waiting)
    }

    /// The receipt for one recorded decision, when the read still publishes it — the row a receipt
    /// card renders, re-derived rather than kept.
    public static func receipt(_ view: OwnerConfirmationView?,
                               decisionID: String) -> RecordedOwnerDecision? {
        view?.decisions.first(where: { $0.id == decisionID })
    }

    /// Whether this card is still a QUESTION — which is not the same as whether it can be answered.
    /// The difference is one case, for the reason `EvidenceDecisions.isOpen` gives: a card this
    /// device could not re-derive is unanswerable and still open.
    public static func isOpen(_ standing: OwnerConfirmationStanding) -> Bool {
        switch standing.state {
        case .waiting, .unread:            return true
        case .answered, .superseded, .notWaiting: return false
        }
    }

    /// The row a receipt is drawn after: the last transcript item recorded at or before the
    /// decision. Nil when every item loaded so far is later — the moment is on a page that is not
    /// loaded, and this client trails the receipt at the tail rather than drawing it above things
    /// that happened first. Web parity: `decisionReceiptAnchor`.
    public static func receiptAnchor(items: [(id: String, ts: String?)],
                                     decidedAt: String) -> String? {
        guard let at = RelativeTime.parse(decidedAt) else { return nil }
        var anchor: String?
        var anchorAt: Date?
        for item in items {
            guard let ts = item.ts, let when = RelativeTime.parse(ts), when <= at else { continue }
            if anchorAt == nil || when > anchorAt! {
                anchor = item.id
                anchorAt = when
            }
        }
        return anchor
    }

    // MARK: the copy
    //
    // Every string below is the one its web twin declares, and `OwnerConfirmationCopyParityTests`
    // checks that by reading `OwnerConfirmationCard.tsx` / `WorkspaceView.tsx`. Two clients wording
    // one confirmation differently is two answers that happen to write the same row.

    /// The card's heading (`OWNER_CONFIRMATION_HEADING`).
    public static let heading = "Confirm this task is done?"
    public static let confirmAction = "Confirm done"
    public static let sendBackAction = "Send back…"
    /// The send-back's own submit, behind the reason box rather than beside it.
    public static let sendAction = "Send back"
    public static let sendBackLabel = "What's missing?"
    /// Why the reason is required rather than a placeholder somebody may ignore: the door refuses a
    /// send-back carrying no note and writes nothing at all.
    public static let sendBackHint = "Sent to this session as your next message. The task stays open."
    public static let whatSettlesIt = "WHAT SETTLES IT"
    public static let whatTheRunReported = "WHAT THE RUN REPORTED"
    public static let showAll = "Show all"
    public static let showLess = "Show less"
    public static let noCriteria = "This task states no acceptance criteria."
    public static let noReport = "The run ended its turn without a message."
    public static let confirmedHeading = "Confirmed done"
    public static let sentBackHeading = "Sent back"
    public static let showWhatSettledIt = "Show what settled it"
    public static let hideWhatSettledIt = "Hide what settled it"
    /// What a session row and the session header say while one of these cards is waiting — the one
    /// string the list and the console share with the browser.
    public static let waitingForConfirmation = "Waiting for your confirmation"

    /// Where the report starts being folded (`REPORT_CLAMP`): long enough for a sentence or two,
    /// short enough that the buttons stay on a phone's screen.
    public static let reportClamp = 240

    /// The door's refusals that mean "this card is out of date", in the door's own spelling
    /// (`OWNER_CONFIRMATION_STALE_CODES`).
    public static let staleCodes: [String] = [
        "OWNER_CONFIRMATION_STALE",
        "OWNER_CONFIRMATION_NOTHING_TO_SEND_BACK",
        "OWNER_CONFIRMATION_TASK_SETTLED",
    ]

    /// The statuses an OWNER_CONFIRMED task can still be confirmed from: the door's own two.
    public static let confirmableStatuses: [String] = ["OPEN", "IN_PROGRESS"]

    /// A refusal of a press, said as staleness when that is what the door's code means
    /// (`ownerDecisionRefusal`). `code` is read off the error body when the client kept one.
    public static func refusalTitle(code: String?) -> String {
        guard let code, staleCodes.contains(code) else { return "Not recorded" }
        return "Not recorded: this card is out of date"
    }

    // MARK: the standing, in words

    /// Why this card cannot be answered, addressed to the reader looking at its dead buttons. Each
    /// sentence names the refusal the door would give, because that is the fact: a reader told only
    /// "you cannot" has been told the button is broken.
    public static func staleExplanation(_ standing: OwnerConfirmationStanding) -> String? {
        switch standing.state {
        case .waiting, .answered:
            return nil
        case .superseded:
            return "A later report is waiting on you now, so the report this card was drawn for is "
                + "not the one waiting. Nothing here would be recorded; the newer report has its own "
                + "card in the session it reported in. (OWNER_CONFIRMATION_STALE)"
        case .notWaiting:
            return "No run of this task is waiting on you, so there is nothing to confirm or send "
                + "back here. Nothing was recorded — run the task to give it another turn, or "
                + "confirm it from the task's own page. (OWNER_CONFIRMATION_NOTHING_TO_SEND_BACK)"
        case .unread:
            return "This card could not re-read the task just now, so it cannot say what is waiting. "
                + "Nothing on it is kept from an earlier read: an answer the door might refuse is not "
                + "offered. The task itself is unaffected."
        }
    }

    // MARK: the answer

    /// The request one press from the CARD makes, as data, so what goes to the door can be asserted
    /// without a network — the same tactic `EvidenceDecisions.request` takes.
    ///
    /// Nil for a send-back without a reason: the door refuses one carrying no note and writes
    /// nothing at all, so there is no request worth making. The reason is trimmed, because
    /// whitespace is not one, and it rides with a send-back and with nothing else.
    public static func request(waiting: OwnerConfirmationWaiting, decision: OwnerDecision,
                               note: String? = nil) -> OwnerDecisionRequest? {
        switch decision {
        case .confirm:
            return OwnerDecisionRequest(decision: .confirm, requestId: waiting.requestId)
        case .sendBack:
            let reason = note?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !reason.isEmpty else { return nil }
            return OwnerDecisionRequest(decision: .sendBack, requestId: waiting.requestId,
                                        note: reason)
        }
    }

    /// The request a press in the task's PANEL makes: it answers no run, which is what a null
    /// `requestId` says, and is refused the moment a run starts waiting — a question that has a card
    /// keeps one place to be answered.
    public static func panelRequest() -> OwnerDecisionRequest {
        OwnerDecisionRequest(decision: .confirm, requestId: nil)
    }

    // MARK: the task panel — one state, one place to answer

    /// What a task's panel offers about its own confirmation: the pointer while a run is waiting,
    /// `Confirm done` when nothing is, and nothing at all otherwise.
    public enum PanelAction: Equatable, Sendable {
        /// A run is waiting: the panel takes the reader to the card in that run's session.
        case pointer(sessionId: String)
        case confirm
    }

    /// The rule both ends are under (web `TaskDetailPanel.confirmHere`): while a run of the task is
    /// waiting on the owner, the card in that session is where it is answered and the panel only
    /// points there; with no run waiting, the panel confirms it directly.
    ///
    /// `view` nil is the read not having come back. That is not "nothing is waiting" — but a task
    /// with no runs at all cannot have a run waiting on the owner, so it may confirm from the task's
    /// own row alone. The statuses are the door's own, and the criterion is checked from whichever
    /// end knows it.
    public static func panelAction(_ view: OwnerConfirmationView?, taskIsOwnerConfirmed: Bool,
                                   taskUnsettled: Bool, taskHasRuns: Bool) -> PanelAction? {
        if let waiting = view?.waiting { return .pointer(sessionId: waiting.sessionId) }
        if let view {
            guard view.completionCriterion == ownerConfirmedCriterion,
                  confirmableStatuses.contains(view.status) else { return nil }
            return .confirm
        }
        guard taskIsOwnerConfirmed, taskUnsettled, !taskHasRuns else { return nil }
        return .confirm
    }

    /// The criterion this whole file is about, in the wire's own spelling.
    public static let ownerConfirmedCriterion = "OWNER_CONFIRMED"

    // MARK: what an answer leaves behind

    /// The receipt's line: which answer, by whom, and when (`ownerDecisionReceiptLine`). The time is
    /// passed in — the browser formats it with `toLocaleTimeString`, which is a locale's business
    /// and not a contract between the two ends — and a moment this client cannot read is left out
    /// rather than rendered as a dangling separator.
    public static func receiptLine(_ decided: RecordedOwnerDecision, time: String?) -> String {
        let action = decided.decision == .confirm ? confirmedHeading : sentBackHeading
        guard let time else { return "\(action) by you" }
        return "\(action) by you · \(time)"
    }

    /// A box's heading for the report: when the run said it, when it said anything
    /// (`whatTheRunReported`).
    public static func reportHeading(_ report: OwnerConfirmationReport?, time: String?) -> String {
        guard let report, let time else { return whatTheRunReported }
        return "\(whatTheRunReported) · \(time)"
    }

    // MARK: the words as a reader sees them

    /// A field written as Markdown, degraded to the line a reader would see — the native half of the
    /// browser's `markdownToPlainText`, which the card applies to both boxes.
    ///
    /// A task's acceptance criteria and a run's report are written as prompts: headings, bullets,
    /// fenced commands, `paths/like/this.ts:521`. The browser shows them flattened in this card, and
    /// showing the same field as its source on a phone would be the two ends disagreeing about what
    /// the owner is deciding from — `**一个依赖字段都没有**` is not a sentence anybody wrote in a
    /// box that says WHAT SETTLES IT.
    ///
    /// Deliberately not a Markdown parser, for the reason the web one gives: the failure mode is
    /// cosmetic — an exotic construct that survives is a stray character, not a broken render — so
    /// what matters is that the marks anyone actually writes are gone and the words survive in
    /// order.
    public static func plainText(_ markdown: String?) -> String {
        guard var text = markdown, !text.isEmpty else { return "" }
        // Fence lines only: the code between them is text a reader still recognises.
        text = text.replacingOccurrences(of: "^[ \\t]*(?:`{3,}|~{3,}).*$", with: "",
                                         options: [.regularExpression])
        // Thematic breaks, before the list rule below would read `- - -` as a bullet.
        text = text.replacingOccurrences(
            of: "^[ \\t]*(?:(?:\\*[ \\t]*){3,}|(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,})$", with: "",
            options: [.regularExpression])
        text = text.replacingOccurrences(of: "^[ \\t]*=+[ \\t]*$", with: "",
                                         options: [.regularExpression])
        // Headings: the opening run, and the optional one that mirrors it.
        text = text.replacingOccurrences(of: "^[ \\t]{0,3}#{1,6}[ \\t]+", with: "",
                                         options: [.regularExpression])
        text = text.replacingOccurrences(of: "[ \\t]+#+[ \\t]*$", with: "",
                                         options: [.regularExpression])
        // Blockquotes, however deeply nested, then list markers of both kinds.
        text = text.replacingOccurrences(of: "^[ \\t]*(?:>[ \\t]?)+", with: "",
                                         options: [.regularExpression])
        text = text.replacingOccurrences(of: "^[ \\t]*(?:[-*+]|\\d{1,9}[.)])[ \\t]+", with: "",
                                         options: [.regularExpression])
        // Images before links: `![alt](src)` is a link whose text is its alt, and taking the link
        // syntax first would leave the `!` behind with nothing attached to it.
        text = text.replacingOccurrences(of: "!\\[([^\\]]*)\\]\\([^)]*\\)", with: "$1",
                                         options: [.regularExpression])
        text = text.replacingOccurrences(of: "\\[([^\\]]*)\\]\\([^)]*\\)", with: "$1",
                                         options: [.regularExpression])
        text = text.replacingOccurrences(of: "\\[([^\\]]*)\\]\\[[^\\]]*\\]", with: "$1",
                                         options: [.regularExpression])
        text = text.replacingOccurrences(of: "<((?:https?|mailto):[^>\\s]+)>", with: "$1",
                                         options: [.regularExpression])
        // Inline code, where the closing run must be as long as the opening one.
        text = text.replacingOccurrences(of: "(`+)([^`]*?)\\1", with: "$2",
                                         options: [.regularExpression])
        // Asterisk emphasis, longest run first so `***x***` does not leave a stray mark — and only
        // when the content has no space at either end, which keeps `2 * 3 * 4` a multiplication.
        text = text.replacingOccurrences(of: "(\\*{1,3})(\\S(?:[^*]*\\S)?)\\1", with: "$2",
                                         options: [.regularExpression])
        text = text.replacingOccurrences(of: "~~(\\S(?:[^~]*\\S)?)~~", with: "$1",
                                         options: [.regularExpression])
        // Underscore emphasis ONLY where it is not inside a word: `file_path` and `snake_case` are
        // identifiers. \p{L}\p{N} rather than \w because the boundary has to hold for CJK too.
        text = text.replacingOccurrences(
            of: "(^|[^\\p{L}\\p{N}_])(_{1,2})(\\S(?:[^_]*\\S)?)\\2(?![\\p{L}\\p{N}_])",
            with: "$1$3", options: [.regularExpression])
        // Whatever backticks are left are an unpaired mark, never punctuation somebody meant.
        text = text.replacingOccurrences(of: "`", with: "")
        // Every run of whitespace becomes the one space that separates two paragraphs here.
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: [.regularExpression])
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A box's body as it is shown at rest: folded at `reportClamp` when it is longer, with whether
    /// anything was folded away — so the card can offer the rest (`EvidenceDecisions.foldedClaim`).
    public static func foldedBody(_ markdown: String?) -> (text: String, folded: Bool) {
        let said = plainText(markdown)
        guard said.count > reportClamp else { return (said, false) }
        return (String(said.prefix(reportClamp)) + "…", true)
    }

    /// The moment, in the words both receipts use: "16:00", or "9/10 16:00" when it was another
    /// day. Fixed 24-hour clock rather than the browser's locale-formatted one — the two ends say
    /// the same thing, each in its own reader's convention.
    public static func receiptTime(_ iso: String, now: Date = Date(),
                                   calendar: Calendar = .current,
                                   timeZone: TimeZone = .current) -> String? {
        guard let at = RelativeTime.parse(iso) else { return nil }
        var cal = calendar
        cal.timeZone = timeZone
        let parts = cal.dateComponents([.hour, .minute], from: at)
        guard let hour = parts.hour, let minute = parts.minute else { return nil }
        let clock = String(format: "%02d:%02d", hour, minute)
        guard !cal.isDate(at, inSameDayAs: now) else { return clock }
        let day = cal.dateComponents([.month, .day], from: at)
        guard let month = day.month, let dayOfMonth = day.day else { return clock }
        return "\(month)/\(dayOfMonth) \(clock)"
    }
}
