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
        let row = cardRow(app)
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
            // The rest of the replay: its last options, and the words typed or replied, if any.
            scrollTranscript(app, by: -320)
            shot("\(name)-d-tapped-lower")
        } else {
            note("\(name): the row is not hittable: \(describe(row))")
        }
        app.terminate()
    }

    /// The card's row, found by its "Question" text: a label on iOS, a static text's value on macOS
    /// (the first round's Mac pass looked for a label and found none).
    private func cardRow(_ app: XCUIApplication) -> XCUIElement {
        #if os(iOS)
        return text(app, label)
        #else
        return app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH %@", label)).firstMatch
        #endif
    }

    /// Move the transcript by `points` (negative: toward its end) with no momentum, from a point clear of
    /// its rows' controls: the left margin on iOS, the console column on the Mac.
    private func scrollTranscript(_ app: XCUIApplication, by points: CGFloat) {
        let window = app.windows.firstMatch
        #if os(iOS)
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: 0.62))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: points)),
                    withVelocity: .slow, thenHoldForDuration: 0.6)
        #else
        let pane = window.coordinate(withNormalizedOffset: CGVector(dx: 0.82, dy: 0.5))
        pane.hover()
        pane.scroll(byDeltaX: 0, deltaY: points)
        #endif
        settle(1.5)
    }
}
