import XCTest

// TEMPORARY evidence probe (see ../../README.md): open each review-mode screen, scroll through it, open
// its menus, and photograph every step. Every test keeps going after a miss, so one run brings back
// every picture it can.
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

    private func missing(_ what: String, _ app: XCUIApplication) {
        XCTFail("no \(what); buttons: \(app.buttons.allElementsBoundByIndex.map(\.label))")
        if let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] {
            try? app.debugDescription.write(toFile: "\(dir)/missing-\(what).txt", atomically: true, encoding: .utf8)
        }
    }

    // MARK: 20 — Wiki settings

    func test20Settings() {
        let app = launch("settings")
        shoot("20-1-settings")
        let form = app.collectionViews.firstMatch
        if form.waitForExistence(timeout: 10) {
            scroll(form)
            shoot("20-2-settings-maintenance")
        }
        let on = launch("settings-on")
        shoot("20-3-settings-on")
        let formOn = on.collectionViews.firstMatch
        if formOn.waitForExistence(timeout: 10) {
            scroll(formOn)
            shoot("20-4-settings-on-maintenance")
        }
        _ = launch("setup")
        shoot("20-5-set-up-maintenance")
    }

    // MARK: 18 — an entry a mode applied

    func test18Entries() {
        let app = launch("entry-unreviewed")
        shoot("18-1-unreviewed")
        let reject = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reject'")).firstMatch
        if reject.waitForExistence(timeout: 5) {
            reject.tap()
            shoot("18-2-reject-reasons")
        } else {
            missing("reject", app)
        }
        let list = launch("entry-unreviewed").collectionViews.firstMatch
        if list.waitForExistence(timeout: 10) {
            scroll(list)
            shoot("18-3-unreviewed-sections")
        }
        _ = launch("entry-auto")
        shoot("18-4-auto")
        _ = launch("entry-web")
        shoot("18-5-web-derived")
    }

    // MARK: 18 — one run

    func test18Run() {
        let app = launch("run")
        shoot("18-6-run")
        let list = app.collectionViews.firstMatch
        if list.waitForExistence(timeout: 10) {
            scroll(list)
            shoot("18-7-run-groups")
        }
        _ = launch("revert")
        shoot("18-8-revert-alert")
    }

    // MARK: Review — a system challenge

    func testReviewChallenge() {
        let app = launch("review")
        shoot("review-1-challenge")
        let scrollView = app.scrollViews.firstMatch
        if scrollView.waitForExistence(timeout: 10) {
            scroll(scrollView)
            shoot("review-2-challenge-answers")
        }
    }

    // MARK: 12 — the home page's Recently changed

    func test12Home() {
        let app = launch("home")
        shoot("12-1-home")
        let list = app.collectionViews.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 10), "the home page is a list")
        for step in 2...5 {
            scroll(list)
            shoot("12-\(step)-home")
        }
    }
}
