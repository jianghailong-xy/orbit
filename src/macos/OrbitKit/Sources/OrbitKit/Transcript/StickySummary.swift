import Foundation

// What the bar pinned to the top of a console says about the turn it points back at.
//
// The bar names the last turn that has scrolled above the fold, so a reader halfway down a long
// answer still knows what it is answering. It called every one of them "↑ Your question" and drew
// the turn's text beside it — which for a wake is the head line's raw UUID, under a label saying
// the person typed it. On the account owner's screenshot (2026-09-17) that label sat directly above
// the card reading "Queued by a watch, not typed by you": one screen saying both.
//
// A watch's wake is still the turn the bar points at — tapping it is how you get back to this
// round — so what changes is only the two words in place: the label becomes the card's own title
// and the text the line under it, which is the same sentence the card underneath already reads.
// Nothing new is written here; both come from `WatchWakeCard`, so a wake reads the same in the bar
// as in the card it points at.
//
// A background job's news or a wakeup coming due is no round of its own at all: it is a line inside
// the answer the agent is still giving (`BackgroundWakeCard`), so the bar does not point at it and
// keeps naming the question that answer belongs to (`isAnchor`). Named in its own words it took the
// bar for the rest of the answer, and a run of jobs kept the question off the screen altogether.
//
// This is the whole rule, and it is here rather than in the view so both clients can share it and
// Linux can test it: `ConsoleView.stickyQuestion` draws what it returns and `recomputeStuck` skips
// what `isAnchor` refuses, and the browser stamps the same pair onto a card's root
// (`data-sticky-label` / `data-sticky-text`) for `WorkspaceView`'s scanner to read — and stamps none
// on a background wake's line. `WatchWakeCopyParityTests` / `BackgroundWakeCopyParityTests` hold the
// two ends to the same rule.

/// The two words the sticky bar draws for one turn: what kind of turn it was, and what it said.
public enum StickySummary {
    /// The arrow every label opens with — the bar points up at the turn it names.
    public static let arrow = "↑ "

    /// The label over a turn the person actually typed. The one label that is not a card's title,
    /// and the only wording on this bar that predates the wakes.
    public static let yourQuestion = "\(arrow)Your question"

    /// Whether the bar may point back at this turn at all — every turn may but a background job's
    /// news or a wakeup coming due, which is a line inside the answer rather than the head of one.
    /// Where somebody also typed words on that same turn, those are a bubble under the line, and the
    /// bar names them the way it names any question.
    ///
    /// Read in `of`'s order, so a turn a card earlier in it claims is never taken for a wake here.
    public static func isAnchor(text: String, note: String? = nil,
                                itemCard: OpenItemDelivery? = nil,
                                taskStart: TaskStart? = nil,
                                startedCard: ProjectStarted? = nil,
                                sessionMessage: SessionMessage? = nil) -> Bool {
        if sessionMessage != nil || itemCard != nil || taskStart != nil || startedCard != nil { return true }
        if WatchWakeText.parse(text) != nil { return true }
        guard BackgroundWakeText.carriesWake(note) else { return true }
        return BackgroundWakeCard.drawsBubble(text: text)
    }

    /// What the bar says about one user turn, read off the same fields the transcript reads a card
    /// out of: a watch's wake is in the turn's own `text`, and who sent another session's message, an
    /// exception item's delivery, a task run's opening and a project's start in the payload recorded
    /// beside it (`sessionMessage`, `itemCard`, `taskStart`, `startedCard`). A turn that is none of
    /// them is the person's, unchanged — which,
    /// for a turn the bar may name at all (`isAnchor`), includes the words somebody typed on a
    /// background wake's turn. `note` is taken so a caller hands both functions the same turn; only
    /// `isAnchor` reads it.
    ///
    /// The order is the transcript's (`TranscriptItemView`, web's `NodeView`): another session's
    /// message first, then the item card, then a task run's opening, then a project's start, then a
    /// watch's wake, then the person's words — so the bar can never name a turn something other than
    /// what the card under it is.
    public static func of(text: String, note: String? = nil,
                          itemCard: OpenItemDelivery? = nil,
                          taskStart: TaskStart? = nil,
                          startedCard: ProjectStarted? = nil,
                          sessionMessage: SessionMessage? = nil) -> (label: String, text: String) {
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
        if let wake = WatchWakeText.parse(text) {
            return (arrow + WatchWakeCard.title(wake.kind), WatchWakeCard.why(wake))
        }
        return (yourQuestion, text)
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
    /// `above[i]`: the last question before item `i`; `above[items.count]`, the last of them all.
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
            if case .user(let b) = item, isQuestion(b) { last = b.id }
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
