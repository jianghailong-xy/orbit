import XCTest

// TEMPORARY evidence probe (never merged): the owner exception card's iPhone text rules (task 34yrjHbz0YEakLPGHqDJZ,
// board docs/mocks/owner-card-ios-text, D1–D3 = A), in the iPhone app's own coordinator conversation against stub.py.
// Two escalated items are sent back with the card's own "Ask the coordinator again", which folds them into one row
// above the open one; then Details, the full-output sheet, the fold opened and closed, and the card at an
// accessibility text size. Whatever the app does not draw is a failure, not a note.
final class OwnerCardTextShotTests: ProbeCase {
    private let cause = "Now yours — the coordinator didn’t get to it"
    private let askAgain = "Ask the coordinator again"
    private let returned = "Sent back to the coordinator"

    private func open(_ name: String, typeSize: String? = nil) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.session", "C1",
                               "-ApplePersistenceIgnoreState", "YES", "-probe.fresh",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
            + (typeSize.map { ["-UIPreferredContentSizeCategoryName", $0] } ?? [])
        app.launchEnvironment["TZ"] = "Asia/Shanghai"
        app.launch()
        if !appears(app, cause, timeout: 60) {
            write(app.debugDescription, "missing-cause-\(name).txt")
            XCTFail("\(name): no card says \(cause)")
        }
        settle(3)
        return app
    }

    private var height: CGFloat { XCUIApplication().windows.firstMatch.frame.height }

    /// Drag toward the top of the conversation until the first card's press is on screen.
    private func toTop(_ app: XCUIApplication) {
        let window = app.windows.firstMatch
        for _ in 1...8 {
            let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.3))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 420)),
                        withVelocity: .fast, thenHoldForDuration: 0.3)
        }
        settle(1.5)
    }

    /// The topmost hittable "Ask the coordinator again".
    private func topAsk(_ app: XCUIApplication) -> XCUIElement? {
        app.buttons.matching(NSPredicate(format: "label == %@", askAgain)).allElementsBoundByIndex
            .filter { $0.exists && $0.isHittable }
            .min { $0.frame.minY < $1.frame.minY }
    }

    private func sendBack(_ app: XCUIApplication, _ which: String) {
        toTop(app)
        for attempt in 1...6 {
            if let ask = topAsk(app) {
                note("\(which): pressing \(describe(ask))")
                ask.tap()
                settle(3)
                return
            }
            let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.62))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -200)),
                        withVelocity: .slow, thenHoldForDuration: 0.4)
            settle(1)
            note("\(which): no Ask again on screen, drag \(attempt)")
        }
        write(app.debugDescription, "missing-ask-\(which).txt")
        XCTFail("\(which): never found \(askAgain)")
    }

    private func fold(_ app: XCUIApplication) -> XCUIElement { app.buttons["settled-fold"].firstMatch }

    /// Board part 2 ② and ③, and D1 = A: the fold, closed and opened.
    func test1FoldedCardDetailsAndTheSettledFold() {
        let app = open("card")
        sendBack(app, "s1")
        sendBack(app, "s2")
        expectRequest("/open-items/s1/return-to-coordinator", "s1")
        expectRequest("/open-items/s2/return-to-coordinator", "s2")

        let row = fold(app)
        if !row.waitForExistence(timeout: 20) {
            bring(app, row, between: 110, and: height - 200, missingIsAbove: true, "fold")
        }
        guard row.exists else {
            write(app.debugDescription, "missing-fold.txt")
            return XCTFail("no settled fold above the open card")
        }
        note("fold: \(describe(row))")
        XCTAssertTrue(row.label.contains("2 sent back to the coordinator"), "the fold says \(row.label)")
        XCTAssertTrue(row.label.contains("Show"), "the fold offers Show: \(row.label)")
        XCTAssertFalse(containing(app, "✓ \(returned)").exists, "no settled card is drawn at full size while folded")
        bring(app, row, between: 110, and: 200, missingIsAbove: true, "fold-top")
        tree(app, "1-folded")
        shot("ios-1-folded")

        // ③ Details open.
        let details = button(app, beginning: "Details")
        note("details summary: \(describe(details))")
        XCTAssertTrue(details.label.contains("check failed"), "folded Details says \(details.label)")
        XCTAssertTrue(details.label.contains("1 failing test"), "folded Details says \(details.label)")
        details.tap()
        settle(1.5)
        let copy = button(app, beginning: "Copy command")
        bring(app, copy, between: 300, and: height - 220, missingIsAbove: false, "copy")
        bring(app, button(app, beginning: "Details"), between: 110, and: height - 220, missingIsAbove: true, "details-top")
        for words in ["docs: 排队规则设计稿补「每条结论的来历」一节（情况 · 问题 · 修复）", "exit 1 after 6m 12s",
                      "✖ no spec hand-rolls the $queryRaw calling conventions (158ms)", "Full output (171 lines)",
                      "Open landing", "Copy command"] where !containing(app, words).exists {
            XCTFail("Details holds no \(words)")
        }
        let shownCommand = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "cd src/apiserver")).firstMatch
        note("command line: \(describe(shownCommand))")
        if shownCommand.exists { XCTAssertLessThan(shownCommand.frame.height, 30, "the command is one line") }
        tree(app, "2-details")
        shot("ios-2-details-open")

        // Copy command: the UI-test runner may not read the pasteboard (PBErrorDomain 13, and the read
        // held the test for an hour in round 2), so run.sh reads it host-side with `simctl pbpaste`
        // once the tests end — test 2 copies nothing.
        button(app, beginning: "Copy command").tap()
        settle(1)

        // Full output opens the sheet with every line — tapped where the composer band is not.
        bring(app, button(app, beginning: "Full output"), between: 200, and: height - 260, missingIsAbove: false, "full-output")
        button(app, beginning: "Full output").tap()
        if !appears(app, "Check output", timeout: 10) { XCTFail("no full-output sheet") }
        settle(1.5)
        XCTAssertTrue(appears(app, "queue rule 001", timeout: 5), "the sheet starts at the output's first lines")
        shot("ios-3-full-output-sheet")
        if button(app, beginning: "Done").exists { button(app, beginning: "Done").tap() }
        settle(1.5)

        // The fold opened in place, then closed again.
        bring(app, fold(app), between: 110, and: 220, missingIsAbove: true, "fold-again")
        fold(app).tap()
        settle(2)
        note("fold opened: \(describe(fold(app)))")
        XCTAssertTrue(fold(app).label.contains("Hide"), "opened, the fold offers Hide: \(fold(app).label)")
        XCTAssertTrue(appears(app, "✓ \(returned)", timeout: 5), "opened, the settled cards are drawn")
        tree(app, "4-fold-open")
        shot("ios-4-fold-expanded")
        fold(app).tap()
        settle(2)
        XCTAssertTrue(fold(app).label.contains("Show"), "closed again: \(fold(app).label)")
        bring(app, fold(app), between: 110, and: 220, missingIsAbove: true, "fold-closed")
        shot("ios-5-fold-collapsed")

        // At the tail: the floating band never covers the last card's foot.
        let window = app.windows.firstMatch
        for _ in 1...6 {
            let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.62))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -420)),
                        withVelocity: .fast, thenHoldForDuration: 0.3)
        }
        settle(2)
        let foot = app.staticTexts.matching(NSPredicate(format: "label == %@", "FROM ORBIT")).allElementsBoundByIndex
            .filter(\.exists).max { $0.frame.maxY < $1.frame.maxY }
        note("tail: last FROM ORBIT \(foot.map(describe) ?? "(missing)")")
        tree(app, "6-tail")
        shot("ios-6-tail")
    }

    /// Rule 5: Dynamic Type at an accessibility size still lays the card out.
    func test2AccessibilityLargeText() {
        let app = open("ax", typeSize: "UICTContentSizeCategoryAccessibilityL")
        let width = app.windows.firstMatch.frame.width
        let heading = text(app, cause)
        bring(app, heading, between: 110, and: 260, missingIsAbove: true, "ax-heading")
        shot("ios-7-ax-l-top")
        var checked: [String] = []
        for _ in 1...10 {
            for label in [askAgain, "Fix it myself", "Retry", "or Chat about this first", "Mark as handled"] {
                for b in app.buttons.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
                where b.exists && b.isHittable && !checked.contains("\(label)@\(Int(b.frame.minY))") {
                    checked.append("\(label)@\(Int(b.frame.minY))")
                    note("ax button \(describe(b))")
                    XCTAssertGreaterThanOrEqual(b.frame.minX, 0, "\(label) starts on screen")
                    XCTAssertLessThanOrEqual(b.frame.maxX, width + 0.5, "\(label) ends on screen")
                }
            }
            if button(app, beginning: "Details").isHittable { break }
            let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.62))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -260)),
                        withVelocity: .slow, thenHoldForDuration: 0.5)
            settle(1)
        }
        shot("ios-8-ax-l-doors")
        button(app, beginning: "Details").tap()
        settle(1.5)
        bring(app, button(app, beginning: "Copy command"), between: 200, and: height - 200, missingIsAbove: false, "ax-copy")
        tree(app, "9-ax-details")
        shot("ios-9-ax-l-details")
    }
}
