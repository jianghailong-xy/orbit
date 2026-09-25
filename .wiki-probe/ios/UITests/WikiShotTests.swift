import XCTest

// TEMPORARY evidence probe (see ../../README.md): open each Wiki screen, scroll through it, open its
// menus, and photograph every step. Every test keeps going after a miss, so one run brings back every
// picture it can.
final class WikiShotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    private func launch(_ screen: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", screen]
        app.launch()
        Thread.sleep(forTimeInterval: 2)
        return app
    }

    private func shoot(_ name: String) {
        Thread.sleep(forTimeInterval: 0.8)
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        do {
            try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        } catch {
            print("could not write \(name): \(error)")
        }
    }

    /// A slow swipe, so a list moves about one screen and settles rather than flinging.
    private func scroll(_ element: XCUIElement) {
        let start = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.82))
        let end = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.22))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.3)
    }

    // MARK: 06 — the drawer

    func test06DrawerRow() {
        _ = launch("drawer")
        shoot("06-1-drawer-open")
        _ = launch("drawer-states")
        shoot("06-2-row-states")
    }

    // MARK: 07 — the home page

    func test07Home() {
        let app = launch("home")
        shoot("07-1-home")
        let list = app.collectionViews.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 10), "the home page is a list")
        for step in 2...6 {
            scroll(list)
            shoot("07-\(step)-home")
        }
        // The space picker, opened (mock 07 ⑥).
        let app2 = launch("home")
        let picker = app2.buttons["The codebase this wiki describes"]
        if picker.waitForExistence(timeout: 5) {
            picker.tap()
            shoot("07-7-space-picker")
        } else {
            XCTFail("no space picker; buttons: \(app2.buttons.allElementsBoundByIndex.map(\.label))")
        }
        // Typing in the search under the title.
        let app3 = launch("home")
        let field = app3.textFields["Search the wiki"]
        if field.waitForExistence(timeout: 5) {
            field.tap()
            shoot("07-8-search-focused")
        }
    }

    // MARK: 08 — one entry

    func test08Entry() {
        let app = launch("entry")
        shoot("08-1-entry")
        let list = app.collectionViews.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 10), "the entry page is a list")
        for step in 2...6 {
            scroll(list)
            shoot("08-\(step)-entry")
        }
        // The ⋯ menu (mock 08 ⑦).
        let app2 = launch("entry")
        let more = app2.buttons["More actions"]
        if more.waitForExistence(timeout: 5) {
            more.tap()
            shoot("08-7-more-menu")
        } else {
            XCTFail("no More actions; buttons: \(app2.buttons.allElementsBoundByIndex.map(\.label))")
        }
    }

    // MARK: 09 — Review

    func test09Review() {
        let app = launch("review")
        shoot("09-1-review-first-card")
        let scrollView = app.scrollViews.firstMatch
        XCTAssertTrue(scrollView.waitForExistence(timeout: 10), "Review scrolls")
        scroll(scrollView)
        shoot("09-2-review-answers")
        let reject = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reject'")).firstMatch
        if reject.waitForExistence(timeout: 5) {
            reject.tap()
            shoot("09-3-reject-reasons")
            app.tap()
            Thread.sleep(forTimeInterval: 0.6)
        } else {
            XCTFail("no Reject; buttons: \(app.buttons.allElementsBoundByIndex.map(\.label))")
        }
        scroll(scrollView)
        shoot("09-4-auto-accept")

        // The next two cards: the RETIRE, then the web-derived AMEND.
        let app2 = launch("review")
        let next = app2.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Next'")).firstMatch
        if next.waitForExistence(timeout: 5) {
            next.tap()
            shoot("09-5-retire-card")
            let scroll2 = app2.scrollViews.firstMatch
            scroll(scroll2)
            shoot("09-6-retire-answers")
            let next2 = app2.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Next'")).firstMatch
            next2.tap()
            let top = app2.scrollViews.firstMatch
            top.swipeDown(velocity: .fast)
            top.swipeDown(velocity: .fast)
            shoot("09-7-amend-card")
            scroll(top)
            shoot("09-8-amend-answers")
        } else {
            XCTFail("no Next; buttons: \(app2.buttons.allElementsBoundByIndex.map(\.label))")
        }
    }
}
