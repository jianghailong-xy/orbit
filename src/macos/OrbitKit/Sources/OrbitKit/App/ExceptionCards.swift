import Foundation

/// The exception-todo cards a project's coordinator conversation draws (§7.5, mock 5): the item the
/// coordinator is working through (`OpenItemCard`), the same item once it is the owner's
/// (`EscalatedItemCard`), and the pause that stopped the coordinator in the first place
/// (`FusePauseCard`, mock 6 ①). Pure logic and words: which card a row is, what it says, and what
/// may be pressed on it — the view half lives in `Views/ApprovalCards.swift`.
///
/// WHY THE WORDS ARE HERE AND NOT IN THE VIEW. They are the web's words
/// (`src/web/src/components/ProjectProgressStatus.tsx`), and the two clients must not drift: an owner
/// who reads "Now yours — no one acted on this for 2h" in a banner, opens the card on a phone and
/// finds a paraphrase has been told the same fact twice. Every string below names the web export it
/// copies, and `ExceptionCardCopyParityTests` reads that file to hold them together — which is also
/// what makes them testable on Linux, where no SwiftUI exists.
///
/// WHY A STANDING RATHER THAN A ROW. Same rule as `CoordinatorQuestions` and `CriteriaDecision`: a
/// card is delivered once and re-derived from the read on every render, and "the read has not
/// answered yet" is a third state that must never be drawn as "the item went away". The web host can
/// simply stop drawing a row; this client's cards have already been filed into a transcript, so the
/// card stays and says which way it went stale.
///
/// WHAT IS DRAWN IS WHAT THE SERVER SERVED. A row's `title` and `detailLine` are the server's own
/// sentences about the fact that opened it, and `actions` is the set of presses that have a door on
/// the other side today (§4.8). Neither is re-derived here: a card that composed its own sentence
/// would be a second rendering of one fact, free to disagree with the row beside it, and a button
/// this file invented would be one the reader presses to no effect.

// MARK: - which card a row is

/// Which of the three cards a row is drawn as — web's `ItemAsCard`, as an answer rather than as a
/// branch inside a view. Nil for the two kinds that already have a card of their own.
public enum ExceptionCardKind: Equatable, Sendable {
    /// An exception the coordinator is handling.
    case openItem
    /// The same exception once it is the owner's: the heading says how it got here.
    case escalatedItem
    /// The coordinator paused itself. Its own card because it is the one here with a WRITE behind
    /// it — the press that starts the coordinator again.
    case fusePause
}

/// What the read says about one exception right now.
public enum ExceptionItemStanding: Equatable, Sendable {
    /// No read has come back. The card draws with dead buttons rather than claiming anything.
    case unread
    /// The item, as the same read serves it.
    case open(ProjectOpenItemRow)
    /// The read came back and this item is not in it: landed, resolved, cancelled, or handed back
    /// and re-opened as its own row. The card stays on screen saying so — it is the only thing left
    /// that can explain it.
    case gone
}

public enum ExceptionCards {

    // MARK: the mark every one of these cards carries

    /// §7.5's mark: Orbit filed this, an agent turn did not write it. The wording the criteria and
    /// question cards already carry, so the three read as one family.
    public static let fromOrbit = "FROM ORBIT"
    public static let fromOrbitTitle =
        "Orbit filed this from the fact that opened it. It is not something an agent turn wrote "
        + "into this page."

    // MARK: the cards' own words

    /// `MARK_HANDLED`, its dialog, and the prompt over the reason. The label the press wears and its
    /// dialog's confirm repeats, as the cancel press does.
    public static let markHandled = "Mark as handled"
    public static let markHandledModalTitle = "Mark this item as handled?"
    public static let markHandledModalBody =
        "It stops being something this project owes anyone. The reason is what the record gains, "
        + "because nothing on the line could verify the ending for itself — the task, its branch "
        + "and its history stay where they are."
    /// The label over the reason box. Its own export on the web only as a literal; named here so it
    /// has one home.
    public static let markHandledReasonPrompt = "Why is it no longer open?"

    /// `CANCEL_TASK_MODAL_*`: what the confirm says, in the two facts a reader weighing it needs —
    /// what it stops, and what it does not touch.
    public static let cancelTaskModalTitle = "Cancel this task?"
    public static let cancelTaskModalOk = "Cancel task"
    public static let cancelTaskModalBody =
        "It is recorded as cancelled: no further run starts on it, and the failed-attempt notices "
        + "it opened close with it. Its branch and history stay where they are."

    /// What this client says about a card whose read has not come back, and about one the read
    /// answered without it. The web host has neither: it draws nothing until its read answers, and
    /// a row that leaves the read simply stops being a card. Here the card was filed into a
    /// transcript the moment it arrived, so it stays and explains itself — the same rule, and the
    /// same shape of wording, as `CoordinatorQuestions.unreadable` / `.gone`.
    public static let unreadable = "Couldn’t read this item — pull to retry."
    public static let gone = "This item is no longer open."
    /// The head such a card wears: normally the row's own title, and there is no row to wear when
    /// the read has not answered. "Paused" is the word this app's needs-you banner already gives
    /// that kind (`NeedsYouLogic.ownerItemText`), and "Open item" is the project page's own name
    /// for the list these come from.
    public static let unreadHeading = "Open item"
    public static let unreadFuseHeading = "Paused"

    // MARK: what each press is called

    /// The label each door wears. An action this map has no label for is not drawn at all, which is
    /// what stops a name the server has not listed from becoming a press nobody can answer.
    public static let actionLabel: [ProjectOpenItemAction: String] = [
        .review: "Review",
        .answer: "Answer",
        .resume: "Resume",
        .openCoordinator: "Open coordinator",
        .openTaskSession: "Open task session",
        .retry: "Retry",
        .cancelTask: "Cancel task",
        .askCoordinatorAgain: "Ask the coordinator again",
    ]

    /// The presses that WRITE, and the only ones. Everything else an item lists is a way in.
    public static let writeActions: Set<ProjectOpenItemAction> = [
        .retry, .cancelTask, .askCoordinatorAgain,
    ]

    /// The kinds an owner closes by hand (§4.7's "标记已处理"): the exceptions, which are the ones a
    /// person sometimes answers in a way the platform cannot read. A question is the owner's to
    /// ANSWER rather than to close, and a merge approval and a paused project each have a press of
    /// their own — the server's own door refuses all three (`HAND_CLOSABLE_RESOLUTIONS`, which names
    /// the same set).
    public static let handClosableKinds: Set<ProjectOpenItemKind> = [
        .integrationConflict, .integrationCheckFailed, .integrationError, .taskFailed,
    ]

    // MARK: which card

    /// Which card an item is drawn as. Nil for the two kinds that already have a card of their own:
    /// a question is drawn by `CoordinatorQuestionCardView`, and a merge approval by
    /// `PromotionApprovalCardView` — drawing either again here would be two cards about one
    /// decision, and only one of them could win.
    public static func card(_ row: ProjectOpenItemRow) -> ExceptionCardKind? {
        switch row.kind {
        case .fusePaused: return .fusePause
        case .coordinatorQuestion, .promotionApproval: return nil
        // Everything else is one of the four exceptions — including a kind this build has never
        // heard of, which the web draws too: the row exists, the server listed its presses, and a
        // card that refused to show it would be hiding work somebody has to do.
        default: return escalationHeading(row) != nil ? .escalatedItem : .openItem
        }
    }

    /// The rows this client files as cards, in the order the transcript should carry them: the pause
    /// first, then everything else oldest first (§7.2 V5, mock 6 ①).
    ///
    /// The pause is pinned because it is the only item that is ABOUT the coordinator rather than
    /// about a piece of work: while it holds, every other item on this list is waiting on a
    /// conversation that has stopped, and a reader who resolved them one by one without seeing it
    /// would be working around the thing that stopped the project.
    public static func drawable(_ items: ProjectOpenItemsView?) -> [ProjectOpenItemRow] {
        let all = (items?.needsYou ?? []) + (items?.withCoordinator ?? [])
        let carded = all.filter { card($0) != nil }
        let paused = carded.filter { $0.kind == .fusePaused }
        let rest = carded.filter { $0.kind != .fusePaused }.sorted { lhs, rhs in
            // An unreadable stamp sorts last rather than first, as it does in `NeedsYouLogic`: it
            // must not beat an item whose wait is known, and it is still drawn when it is the only
            // one. The web's `Date.parse` gives NaN here and its sort leaves such a row where it is;
            // this is the same intent with an order rather than a coin toss.
            let left = RelativeTime.parse(lhs.waitingSince) ?? Date.distantFuture
            let right = RelativeTime.parse(rhs.waitingSince) ?? Date.distantFuture
            return left < right
        }
        return paused + rest
    }

    /// Where one item stands, by the address the card was delivered under.
    public static func standing(items: ProjectOpenItemsView?, itemId: String) -> ExceptionItemStanding {
        guard let items else { return .unread }
        let all = items.needsYou + items.withCoordinator
        guard let row = all.first(where: { $0.itemId == itemId }) else { return .gone }
        return .open(row)
    }

    // MARK: what it says

    /// §7.5's heading for an item that BECAME the owner's, one per way it happened — web's
    /// `escalationHeading`, word for word.
    ///
    /// Each says the thing the owner has to know before deciding anything: nobody acted, the
    /// conversation that had it is over, the chain ran out of attempts, or somebody put it here on
    /// purpose. Nil is not "unknown": it is an item that was the owner's from birth — a question, a
    /// merge approval, a pause — which is not an escalation and says so in its own title.
    public static func escalationHeading(_ row: ProjectOpenItemRow, now: Date = Date()) -> String? {
        switch row.assigneeReason {
        case .escalated:
            return "Now yours — no one acted on this for \(waitedBeforeEscalation(row))"
        case .coordinatorEnded:
            return "Now yours — the coordinator conversation ended"
        case .chainLimit:
            return "Now yours — the 3rd failure in this chain"
        case .handedOver:
            return "Now yours — the coordinator handed it over"
        case .noCoordinator:
            return "Now yours — this project has no coordinator (waiting \(span(row, now: now)))"
        default:
            return nil
        }
    }

    /// The card's heading: how it got here, or — for an item that was the owner's from birth, and
    /// for the kinds whose sentence is their own — the server's title.
    public static func heading(_ row: ProjectOpenItemRow, now: Date = Date()) -> String {
        escalationHeading(row, now: now) ?? row.title
    }

    /// The time under an item, in the words its group uses (§7.2 V5) — web's `waitingLabel`.
    ///
    /// The coordinator's items are the ones with two numbers on them, and both matter: how long it
    /// has had it, and how long before it stops being its problem. The owner's items have one —
    /// except an escalated one, where WHEN it arrived is what the reader is orienting by.
    public static func waitingLabel(_ row: ProjectOpenItemRow, now: Date = Date()) -> String {
        let waited = span(row, now: now)
        if row.assignee == .coordinator {
            guard let escalateAt = row.escalateAt else { return "waiting \(waited)" }
            guard let until = RelativeTime.parse(escalateAt) else { return "waiting \(waited)" }
            let left = until.timeIntervalSince(now)
            return left > 0
                ? "\(waited) · goes to you in \(RelativeTime.span(left))"
                : "\(waited) · due to come to you"
        }
        if let escalatedAt = row.escalatedAt {
            return "escalated \(RelativeTime.ago(escalatedAt, now: now) ?? "a while ago")"
        }
        return "waiting \(waited)"
    }

    /// §7.5's footer: who has it, how long, and when it stops being theirs — web's `ownerLine`.
    public static func ownerLine(_ row: ProjectOpenItemRow, now: Date = Date()) -> String {
        let waited = "waiting \(span(row, now: now))"
        if row.assignee == .owner { return "Owner: you · \(waited)" }
        guard let escalateAt = row.escalateAt, let until = RelativeTime.parse(escalateAt) else {
            return "Owner: coordinator · \(waited)"
        }
        let left = until.timeIntervalSince(now)
        return left > 0
            ? "Owner: coordinator · \(waited) · goes to the owner in \(RelativeTime.span(left))"
            : "Owner: coordinator · \(waited)"
    }

    /// How long the coordinator had it before the clock took it away — the window the project set,
    /// read off the two instants rather than off the setting, so a window that was changed
    /// afterwards cannot make this sentence lie about what happened. "a while" is the web's own word
    /// for an escalation instant it does not have.
    private static func waitedBeforeEscalation(_ row: ProjectOpenItemRow) -> String {
        guard let escalatedAt = row.escalatedAt, let from = RelativeTime.parse(row.waitingSince),
              let until = RelativeTime.parse(escalatedAt) else { return "a while" }
        return RelativeTime.span(until.timeIntervalSince(from))
    }

    /// How long this row has waited, in the web's own units. "a while" rather than a number when
    /// the instant cannot be read: that is the web's own word for a span it does not have, and the
    /// alternative — printing a span computed from nothing — would be a number this client made up.
    private static func span(_ row: ProjectOpenItemRow, now: Date) -> String {
        guard let since = RelativeTime.parse(row.waitingSince) else { return "a while" }
        return RelativeTime.span(now.timeIntervalSince(since))
    }

    // MARK: what may be pressed

    /// The presses a CARD offers, in the server's own order — web's `cardActions`. Never more than
    /// the server listed, so a card cannot come to offer something no door answers.
    public static func presses(_ row: ProjectOpenItemRow) -> [ExceptionPress] {
        row.actions.compactMap { action in
            guard let label = actionLabel[action] else { return nil }
            if writeActions.contains(action) {
                guard let target = writeTarget(row, action) else { return nil }
                return .write(action: action, label: label, target: target)
            }
            guard action == .resume else {
                guard let destination = link(row, action) else { return nil }
                return .link(action: action, label: label, destination: destination)
            }
            // Drawn even when the row names no episode, and drawn DEAD there: this is the one press
            // the pause exists to offer, and hiding it would leave the card with nothing to do (web
            // draws it `disabled` for the same case).
            return .resumeFuse(label: label, episodeID: row.fuseEpisodeId)
        }
    }

    /// The press a reader is expected to make: the FIRST of the writing ones the row lists, which is
    /// the mock's own emphasis on both cards — Retry where the coordinator owns the work, "Ask the
    /// coordinator again" where the owner does. One rule rather than a list of exceptions.
    public static func primary(_ row: ProjectOpenItemRow) -> ProjectOpenItemAction? {
        presses(row).first { $0.writes }?.action
    }

    /// Whether this row is one the owner ends by hand (§4.7): the exceptions, and only where the
    /// owner is the one who has it. Not on the server's `actions` list (see the web module's head),
    /// which is why it is drawn from the KIND rather than from the row's own list.
    public static func markHandled(_ row: ProjectOpenItemRow) -> Bool {
        row.assignee == .owner && handClosableKinds.contains(row.kind)
    }

    /// Whether this row is still a question waiting on the reader — what the "needs you" bar counts.
    /// An unreadable standing is NOT counted: pointing somebody at a card that cannot say what it is
    /// asking is worse than saying nothing. An item the COORDINATOR has is not counted either: it is
    /// drawn for the reader to see, and the bar is about what is theirs to act on.
    public static func isOpen(_ standing: ExceptionItemStanding) -> Bool {
        guard case .open(let row) = standing else { return false }
        return row.assignee == .owner
    }

    // MARK: the two lookups the presses are drawn from

    /// Where a writing press goes, or nil when this row does not carry what it would act on — web's
    /// `writeTarget`: the two task presses act on the task the item is about, and the third is about
    /// the item itself, which every row carries.
    public static func writeTarget(_ row: ProjectOpenItemRow,
                                   _ action: ProjectOpenItemAction) -> ExceptionWriteTarget? {
        switch action {
        case .askCoordinatorAgain:
            return .item(row.itemId)
        case .retry, .cancelTask:
            return row.taskId.map(ExceptionWriteTarget.task)
        default:
            return nil
        }
    }

    /// Where a way-in goes, or nil when this row does not carry the address it would need — web's
    /// `actionHref`, in this client's own vocabulary: the browser's two in-page anchors are rows in
    /// this same conversation, and its two session routes are the app's session page.
    public static func link(_ row: ProjectOpenItemRow,
                            _ action: ProjectOpenItemAction) -> ExceptionLink? {
        switch action {
        case .review:
            // The merge card, drawn beside these by the same console — the same anchor the
            // question's press uses, and for the same reason: one merge, confirmed in one place.
            return row.promotionId.map { .card("promotion-\($0)") }
        case .answer:
            // The question's own card, already in this conversation. An anchor rather than a second
            // copy of the card: one question, answered in one place.
            return .card("question-\(row.itemId)")
        case .openCoordinator:
            return row.delivery.sessionId.map(ExceptionLink.session)
        case .openTaskSession:
            if let sessionId = row.sessionId { return .session(sessionId) }
            return row.taskId.map(ExceptionLink.task)
        default:
            return nil
        }
    }
}

/// One press a card draws, as an answer rather than as a branch in a view. Each case carries
/// exactly what its door needs, which is what lets a view be a switch and nothing more.
public enum ExceptionPress: Equatable, Sendable {
    /// A way in: what it is called, and where it goes in this app.
    case link(action: ProjectOpenItemAction, label: String, destination: ExceptionLink)
    /// A press that writes against a task or against the item itself.
    case write(action: ProjectOpenItemAction, label: String, target: ExceptionWriteTarget)
    /// The owner lifting the coordinator's pause. A case of its own rather than a `write`, because
    /// it is the one press drawn even when the address it needs is missing — dead, not absent.
    case resumeFuse(label: String, episodeID: String?)
    /// The owner's own ending for an exception they dealt with themselves. Not one of the server's
    /// actions — see `ExceptionCards.markHandled`.
    case markHandled(label: String)

    /// The action this press is the server's, or nil for the one press the server never listed.
    public var action: ProjectOpenItemAction? {
        switch self {
        case .link(let action, _, _), .write(let action, _, _): return action
        case .resumeFuse: return .resume
        case .markHandled: return nil
        }
    }

    public var label: String {
        switch self {
        case .link(_, let label, _), .write(_, let label, _): return label
        case .resumeFuse(let label, _): return label
        case .markHandled(let label): return label
        }
    }

    /// Whether this press writes on the other end of it — the browser's own split, which is what
    /// decides button versus link. "Mark as handled" is a button there too, and it still never
    /// wears the card's primary emphasis: that is decided by `presses(_:)`, which does not carry it.
    public var writes: Bool {
        switch self {
        case .write, .resumeFuse, .markHandled: return true
        case .link: return false
        }
    }
}

/// Where a way-in leads, in this client's own vocabulary.
public enum ExceptionLink: Equatable, Sendable {
    /// A row of this same conversation — the browser's in-page anchors (`#question-…`,
    /// `#promotion-…`), which is why both ends name a row id rather than a route.
    case card(String)
    /// A conversation: the run this item is about, or the one coordinating the project.
    case session(String)
    /// A task's page, when the item names no run to open instead.
    case task(String)
}

/// What a writing press acts on.
public enum ExceptionWriteTarget: Equatable, Sendable {
    /// A task: retry it, or stop it.
    case task(String)
    /// The item itself: hand it back to the coordinator, or close it by hand.
    case item(String)
}
