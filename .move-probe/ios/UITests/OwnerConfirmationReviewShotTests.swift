import XCTest

// TEMPORARY evidence probe (never merged): the owner-confirmation card's REVIEW bar on a phone, against
// `ocr-stub.py` — one conversation per state of docs/mocks/owner-confirmation-review-ios.html phones
// ③ ④ and its second row, plus the answer blocks, the returned record and the two turn cards. Each
// test opens its conversation from the real session list, brings the part that matters into view
// and photographs it. Soft failures: whatever cannot be found is noted beside the pictures with the
// element tree, and the run moves on.
final class OwnerConfirmationReviewShotTests: ProbeCase {

    // MARK: helpers

    /// Launch, let the list settle, and open the conversation whose row's title contains `key` (or
    /// begins with it, for the reviewer's own conversation, whose title the other rows quote).
    func open(_ key: String, beginsWith: Bool = false, dark: Bool = false, until label: String,
              _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765"] + (dark ? ["-dark"] : [])
        app.launch()
        let predicate = NSPredicate(format: beginsWith ? "label BEGINSWITH %@" : "label CONTAINS %@", key)
        let cell = app.cells.containing(predicate).firstMatch
        if !cell.waitForExistence(timeout: 60) {
            note("\(name): the list never showed \(key)")
            write(app.debugDescription, "missing-list-\(name).txt")
        }
        settle(4)
        if cell.exists {
            cell.tap()
        } else {
            let button = app.buttons.matching(predicate).firstMatch
            if button.exists { button.tap() } else { note("\(name): no row to tap for \(key)") }
        }
        if !text(app, label).waitForExistence(timeout: 45) {
            note("\(name): \(label) never showed")
            write(app.debugDescription, "missing-\(name).txt")
        }
        settle(3)
        return app
    }

    /// A text, a button or anything else whose label begins with these words.
    func text(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
    }

    /// Drag the transcript until `element` sits inside the band between `top` and `bottom` (points
    /// from the window's top), holding at the end of each drag so it carries no momentum. The drag
    /// starts in the screen's margin, off the card, so it can never press one of its buttons.
    func bring(_ app: XCUIApplication, _ element: XCUIElement, between top: CGFloat, and bottom: CGFloat,
               missingIsAbove: Bool, _ name: String) {
        let window = app.windows.firstMatch
        for attempt in 1...12 {
            if element.exists, element.isHittable, element.frame.minY >= top, element.frame.maxY <= bottom {
                note("\(name): in view after \(attempt - 1) drag(s) at \(element.frame)")
                return
            }
            let below = element.exists ? element.frame.maxY > bottom : !missingIsAbove
            let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: below ? 0.62 : 0.3))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: below ? -150 : 150)),
                        withVelocity: .slow, thenHoldForDuration: 0.6)
            settle(1)
        }
        note("\(name): never in the band \(top)–\(bottom); last frame \(element.frame)")
        write(app.debugDescription, "missing-band-\(name).txt")
    }

    /// The screen at the press: Confirm done low on the screen, so what is above it — the review
    /// bar, then If you confirm — is what the owner sees as they press (the mock's phones ③ ④).
    func pressView(_ app: XCUIApplication, _ name: String) {
        let height = app.windows.firstMatch.frame.height
        bring(app, app.buttons["Confirm done"], between: height * 0.45, and: height * 0.80,
              missingIsAbove: false, name)
        settle(1.5)
        shot(name)
        tree(app, name)
    }

    /// The part a shot is about, in the upper half of the screen.
    func upper(_ app: XCUIApplication, _ element: XCUIElement, _ name: String) {
        let height = app.windows.firstMatch.frame.height
        bring(app, element, between: 165, and: height * 0.55, missingIsAbove: true, name)
        settle(1.5)
        shot(name)
        tree(app, name)
    }

    // MARK: phones ③ and ④

    /// ③: the report is with its reviewer. Drawn and pressable, not counted: no bar under the header,
    /// and the header says Under review.
    func test1UnderReview() {
        let app = open("修复 P1 审查", until: "Confirm done", "3-under-review")
        pressView(app, "3-under-review")
        XCTAssertTrue(text(app, "Reviewing since").exists, "the bar says since when")
        XCTAssertTrue(text(app, "Orbit will ask you once the review is in.").exists)
        XCTAssertTrue(app.buttons["Confirm done"].isEnabled, "the door is not locked while it is reviewed")
        XCTAssertFalse(text(app, "1 open question").exists, "an open question bar does not count it")
        XCTAssertTrue(text(app, "Under review").exists, "the header says Under review")
        app.terminate()
    }

    /// ④: reviewed, option B's first line over the reviewer's lists and its own words.
    func test2Reviewed() {
        let app = open("P1 审查发现的问题已修复", until: "Confirm done", "4-reviewed")
        pressView(app, "4-reviewed")
        XCTAssertTrue(text(app, "1 not checked · nothing needs you").exists, "option B's first line")
        let reviewHead = text(app, "REVIEW · ")
        upper(app, reviewHead, "4-reviewed-bar")
        app.terminate()
    }

    func test3ReviewedInDark() {
        let app = open("P1 审查发现的问题已修复", dark: true, until: "Confirm done", "4-reviewed-dark")
        pressView(app, "4-reviewed-dark")
        app.terminate()
    }

    // MARK: the second row

    /// Option B with a question for the owner: the question is the first line, its options follow
    /// with the recommendation chosen, and an Other with no words yet disables Confirm done alone.
    func test4NeedsYou() {
        let app = open("50 条每小时", until: "Confirm done", "B-needs-you")
        upper(app, text(app, "Needs you:"), "B-needs-you")
        pressView(app, "B-needs-you-press")
        // The first question's Other sits above the press view, under the header's bars: bring it into
        // the open before the tap, or the synthesized tap lands on the header instead.
        let other = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Other — say it")).firstMatch
        if other.waitForExistence(timeout: 5) {
            let height = app.windows.firstMatch.frame.height
            bring(app, other, between: 220, and: height * 0.6, missingIsAbove: true, "B-needs-you-other-row")
            other.tap()
            settle(1.5)
            shot("B-needs-you-other-field")
            tree(app, "B-needs-you-other-field")
            XCTAssertTrue(app.textFields.firstMatch.exists || app.textViews.firstMatch.exists,
                          "choosing Other opens a box for the owner's words")
            pressView(app, "B-needs-you-other")
            XCTAssertFalse(app.buttons["Confirm done"].isEnabled, "an Other with no words holds Confirm done")
            XCTAssertTrue(app.buttons["Chat about this"].isEnabled, "and only Confirm done")
        } else {
            note("no Other row")
            write(app.debugDescription, "missing-other.txt")
        }
        app.terminate()
    }

    func test5NotReviewed() {
        let app = open("导出发票汇总表", until: "Confirm done", "timed-out")
        pressView(app, "timed-out")
        XCTAssertTrue(text(app, "No answer within 30 min.").exists)
        app.terminate()
    }

    func test6Outdated() {
        let app = open("登录跳转保留", until: "Confirm done", "outdated")
        pressView(app, "outdated")
        XCTAssertTrue(text(app, "Written for 59d9815.").exists)
        let fold = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Show the old review")).firstMatch
        if fold.waitForExistence(timeout: 5) {
            fold.tap()
            settle(1.5)
            upper(app, text(app, "REVIEW · "), "outdated-open")
        } else {
            note("no Show the old review")
        }
        app.terminate()
    }

    /// You confirmed first, the review came later: the receipt, the problem, Reopen task — and the
    /// task panel's own question behind it.
    func test7ConfirmedFirst() {
        let app = open("重发按钮", until: "Reopen task", "confirmed-first")
        let height = app.windows.firstMatch.frame.height
        bring(app, app.buttons["Reopen task"], between: height * 0.40, and: height * 0.82,
              missingIsAbove: false, "confirmed-first")
        settle(1.5)
        shot("confirmed-first")
        tree(app, "confirmed-first")
        XCTAssertTrue(text(app, "Before the review came in").exists)
        XCTAssertTrue(text(app, "1 problem found after you confirmed").exists)
        app.buttons["Reopen task"].tap()
        settle(1.5)
        shot("confirmed-first-reopen-question")
        let cancel = app.buttons["Cancel"]
        if cancel.waitForExistence(timeout: 5) { cancel.tap() }
        app.terminate()
    }

    /// The reviewer sent the report back: the card is a record with nothing to press, and the run's
    /// conversation shows what reached it.
    func test8Returned() {
        let app = open("退回的 P1-3", until: "Returned to the agent", "returned")
        // The record is the transcript's last card, so it can rise no higher than the end of the scroll.
        let record = text(app, "Returned to the agent")
        bring(app, record, between: 165, and: app.windows.firstMatch.frame.height * 0.7,
              missingIsAbove: true, "returned-record")
        settle(1.5)
        shot("returned-record")
        tree(app, "returned-record")
        XCTAssertFalse(app.buttons["Confirm done"].exists, "a record has no buttons")
        let card = text(app, "Sent back by the reviewer")
        let height = app.windows.firstMatch.frame.height
        bring(app, card, between: 165, and: height * 0.7, missingIsAbove: false, "returned-turn")
        settle(1.5)
        shot("returned-turn")
        app.terminate()
    }

    /// The reviewer's own conversation: the turn that asked it to review.
    func test9ReviewRequested() {
        let app = open("会话间消息参数与回复设计", beginsWith: true, until: "Review requested", "review-requested")
        upper(app, text(app, "Review requested"), "review-requested")
        app.terminate()
    }

    /// The session list: the row under review in the quiet tone with who has it, the row waiting on
    /// you in amber below or above it (the mock's last snippet).
    func test10SessionList() {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765"]
        app.launch()
        let cell = app.cells.containing(NSPredicate(format: "label CONTAINS %@", "修复 P1 审查")).firstMatch
        if !cell.waitForExistence(timeout: 60) {
            note("the list never showed the row under review")
            write(app.debugDescription, "missing-list.txt")
        }
        settle(4)
        shot("session-list")
        tree(app, "session-list")
        XCTAssertTrue(text(app, "Under review · 会话间消息参数与回复设计").exists, "the row says who has it")
        app.terminate()
    }
}
