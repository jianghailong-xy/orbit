import XCTest

// TEMPORARY evidence probe (never merged): an agent's answered question (AskUserQuestion) in the
// conversation, on the tree before the change (the card opens on its bold question, bullets and OUTPUT)
// and after it (folded to what was asked and how it was answered; a tap replays every option). The same
// launches, waits and taps run on both trees, so each pair of pictures shows the same rows.
final class QuestionCardShotTests: ProbeCase {
    /// The card's row: a transcript-only label, so its arrival means the transcript has loaded.
    private let label = "Question"

    func test1OneQuestion() { photograph("Q1", "1-one-question") }
    func test2TwoQuestions() { photograph("Q2", "2-two-questions") }
    func test3TypedAnswer() { photograph("Q3", "3-typed-answer") }
    func test4MultipleChoice() { photograph("Q4", "4-multiple-choice") }
    func test5ReplyInChat() { photograph("Q5", "5-reply-in-chat") }

    private func photograph(_ session: String, _ name: String) {
        let app = launch(session: session, until: label, name)
        settle(1.5)
        let row = text(app, label)
        // As it opens: where the conversation puts the card, its tail in view.
        shot("\(name)-a-as-opened")
        tree(app, "\(name)-as-opened")
        note("\(name) as opened, row: \(describe(row))")
        // The row near the top, so whatever the card draws under it is in view.
        bring(app, row, between: 150, and: 330, missingIsAbove: true, "\(name)-row")
        shot("\(name)-b-card")
        note("\(name) card, row: \(describe(row))")
        // A tap on the row: before the change it folds the card, after it the card opens its replay.
        if row.exists, row.isHittable {
            #if os(iOS)
            row.tap()
            #else
            row.click()
            #endif
            settle(1.5)
            bring(app, row, between: 150, and: 330, missingIsAbove: true, "\(name)-row-tapped")
            shot("\(name)-c-tapped")
            tree(app, "\(name)-tapped")
            note("\(name) tapped, row: \(describe(row))")
        } else {
            note("\(name): the row is not hittable: \(describe(row))")
        }
        app.terminate()
    }
}
