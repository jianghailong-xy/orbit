import Foundation

// What the bar pinned to the top of a console says about the turn it points back at.
//
// The bar names the last turn that has scrolled above the fold, so a reader halfway down a long
// answer still knows what it is answering. It called every one of them "↑ Your question" and drew
// the turn's text beside it — which for a wake is the head line's raw UUID, under a label saying
// the person typed it. On the account owner's screenshot (2026-09-17) that label sat directly above
// the card reading "Queued by a watch, not typed by you": one screen saying both.
//
// A turn the control plane opened for a watch, a background job's news or a wakeup coming due is no
// round of its own at all: it is a line inside the answer the agent is still giving
// (`WatchWakeCard`, `BackgroundWakeCard`), so the bar does not point at it and keeps naming the
// question that answer belongs to (`isAnchor`). Named in its own words it took the bar for the rest
// of the answer — a watch's wake drew "↑ Watch triggered" over the reply to the person's question —
// and a run of them kept the question off the screen altogether.
//
// This is the whole rule, and it is here rather than in the view so both clients can share it and
// Linux can test it: `ConsoleView.stickyQuestion` draws what it returns and `recomputeStuck` skips
// what `isAnchor` refuses, and the browser stamps the same pair onto a card's root
// (`data-sticky-label` / `data-sticky-text`) for `WorkspaceView`'s scanner to read — and stamps none
// on a wake's line. `WatchWakeCopyParityTests` / `BackgroundWakeCopyParityTests` hold the two ends to
// the same rule.

/// The two words the sticky bar draws for one turn: what kind of turn it was, and what it said.
public enum StickySummary {
    /// The arrow every label opens with — the bar points up at the turn it names.
    public static let arrow = "↑ "

    /// The label over a turn the person actually typed. The one label that is not a card's title,
    /// and the only wording on this bar that predates the wakes.
    public static let yourQuestion = "\(arrow)Your question"

    /// Whether the bar may point back at this turn at all — every turn may but a watch's wake, a
    /// background job's news, a wakeup coming due or the owner's answer handed to the coordinator,
    /// each a line inside the answer rather than the head of one (web: the line carries no
    /// `data-sticky-label`). Where somebody also typed words on a background wake's turn, those are a bubble
    /// under the line, and the bar names them the way it names any question; a watch's wake is the
    /// whole of its turn's words, so nobody's are there.
    ///
    /// A fact told to this session (`coordinatorDelivery`) is a line too, but it IS the head of a round:
    /// the reply under it answers it, so the bar points back at it, as the browser's line carries its
    /// `data-sticky-label`.
    ///
    /// Read in `of`'s order, so a turn a card earlier in it claims is never taken for a wake here.
    public static func isAnchor(text: String, note: String? = nil,
                                itemCard: OpenItemDelivery? = nil,
                                taskStart: TaskStart? = nil,
                                startedCard: ProjectStarted? = nil,
                                sessionMessage: SessionMessage? = nil,
                                ownerAnswer: OwnerAnswer? = nil,
                                coordinatorDelivery: CoordinatorDelivery? = nil) -> Bool {
        if sessionMessage != nil || itemCard != nil || taskStart != nil || startedCard != nil { return true }
        if ownerAnswer != nil { return false }
        if coordinatorDelivery != nil { return true }
        if WatchWakeText.parse(text) != nil { return false }
        guard BackgroundWakeText.carriesWake(note) else { return true }
        return BackgroundWakeCard.drawsBubble(text: text)
    }

    /// What the bar says about one user turn, read off the same fields the transcript reads a card
    /// out of: who sent another session's message, an exception item's delivery, a task run's opening
    /// and a project's start, in the payload recorded beside it (`sessionMessage`, `itemCard`,
    /// `taskStart`, `startedCard`). A turn that is none of them is the person's, unchanged — which,
    /// for a turn the bar may name at all (`isAnchor`), includes the words somebody typed on a
    /// background wake's turn. A wake itself is never handed here: `isAnchor` refuses it. `note` is
    /// taken so a caller hands both functions the same turn; only `isAnchor` reads it.
    ///
    /// The order is the transcript's (`TranscriptItemView`, web's `NodeView`): another session's
    /// message first, then the item card, then a task run's opening, then a project's start, then the
    /// person's words — so the bar can never name a turn something other than what the card under it
    /// is.
    public static func of(text: String, note: String? = nil,
                          itemCard: OpenItemDelivery? = nil,
                          taskStart: TaskStart? = nil,
                          startedCard: ProjectStarted? = nil,
                          sessionMessage: SessionMessage? = nil,
                          coordinatorDelivery: CoordinatorDelivery? = nil) -> (label: String, text: String) {
        // Another Orbit session's message: somebody's question, but not the reader's, and the card
        // under the bar names who asked it (`SessionMessageCard`).
        if let card = sessionMessage {
            let summary = SessionMessageCard.sticky(card, text: text)
            return (arrow + summary.label, summary.text)
        }
        if let card = itemCard {
            let summary = OpenItemDeliveryCard.sticky(card)
            return (arrow + summary.label, summary.text)
        }
        // A fact told to this session: nobody's question, and the line under the bar says what it was
        // (`CoordinatorDeliveryCard`) — `↑ From Orbit`, never `Your question` over words nobody typed.
        if let card = coordinatorDelivery {
            let summary = CoordinatorDeliveryCard.sticky(card)
            return (arrow + summary.label, summary.text)
        }
        // A task run's opening turn: the brief is nobody's question, and the card under the bar
        // names the task (`TaskStartCard`).
        if let card = taskStart {
            let summary = TaskStartCard.sticky(card)
            return (arrow + summary.label, summary.text)
        }
        // The message telling the coordinator its project was started: the card names the project.
        if let card = startedCard {
            let summary = ProjectStartedCard.sticky(card)
            return (arrow + summary.label, summary.text)
        }
        return (yourQuestion, text)
    }

    /// Whether Orbit, not a person, opened this turn: one of the control plane's cards stands in for
    /// the bubble. Such a turn still heads the round under it (`isAnchor`), so the question above it no
    /// longer names what is on screen — but the bar never names a machine's message either (the owner,
    /// 2026-11-14: "↑ Evidence to review" over a coordinator's reply), so over it the bar is hidden
    /// (`StickyQuestions`). Web: a card carrying `data-sticky-label` hides `WorkspaceView`'s bar.
    /// A watch's wake, a job's news and the owner's answer are lines inside an answer, not rounds, and
    /// are left to `isAnchor`.
    public static func isOrbits(_ b: UserBubble) -> Bool {
        b.itemCard != nil || b.coordinatorDelivery != nil || b.taskStart != nil || b.startedCard != nil
            || b.sessionMessage != nil || !(b.sessionReplies ?? []).isEmpty
            || b.reviewRequest != nil || b.reviewReturn != nil || b.reviewAnswers != nil
            || b.evidenceReview != nil || b.evidenceSendBack != nil || b.runQuestion != nil
            || b.runNotice != nil || b.sessionOpening != nil
    }

    /// The label as the iPhone draws it, in a capsule between the nav bar's back and menu buttons
    /// (`ConsoleView.stickyQuestion`): the arrow alone over the person's own words — the capsule has
    /// no room to say whose they are, and needs none — and a card's title as it stands over anything
    /// else, so the capsule can't pass a card off as something the reader typed.
    public static func compactLabel(_ label: String) -> String {
        label == yourQuestion ? arrow.trimmingCharacters(in: .whitespaces) : label
    }
}

/// Which turn the sticky bar names for each place the reader can be, read off the items once.
///
/// The bar names the last question above the item under the viewport top (`recomputeStuck`), and
/// that item changes on every scroll — which walked the transcript from its head and read every
/// user turn's text (`isAnchor`, `WatchWakeText.parse`) again each time. Which turns are questions
/// changes only when the items do, so it is answered here once per published state and a scroll
/// is a lookup.
public struct StickyQuestions {
    /// Each item's position, by id — the first one, as the walk stopped at the first.
    private let position: [String: Int]
    /// `above[i]`: the last question before item `i` — nil where a round Orbit opened came after it;
    /// `above[items.count]`, the last of them all.
    private let above: [String?]

    /// `isQuestion` is the console's own test of one user turn (`namesAQuestion`).
    public init(_ items: [TranscriptItem], isQuestion: (UserBubble) -> Bool) {
        var position: [String: Int] = [:]
        var above: [String?] = []
        above.reserveCapacity(items.count + 1)
        var last: String?
        for (index, item) in items.enumerated() {
            if position[item.id] == nil { position[item.id] = index }
            above.append(last)
            // A round Orbit opened ends the question's reach without taking the bar (`isOrbits`).
            if case .user(let b) = item, isQuestion(b) { last = StickySummary.isOrbits(b) ? nil : b.id }
        }
        above.append(last)
        self.position = position
        self.above = above
    }

    /// The last question above the item `anchor` names — every question, when no item has that id.
    public func above(_ anchor: String) -> String? {
        above[position[anchor] ?? above.count - 1]
    }

    /// The last question in the transcript.
    public var last: String? { above[above.count - 1] }
}
