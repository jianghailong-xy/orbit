import XCTest

// TEMPORARY evidence probe (see ../../README.md): open each screen, scroll through it, and photograph
// every step. Every test keeps going after a miss, so one run brings back every picture it can.
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

    // MARK: Recently changed — every run one row, read by its own id

    func test1Home() {
        let app = launch("home")
        shoot("1-1-home")
        let list = app.collectionViews.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 10), "the home page is a list")
        for step in 2...4 {
            scroll(list)
            shoot("1-\(step)-home")
        }
    }

    // MARK: one run nothing of which waits in Review, and its Revert

    func test2Run() {
        let app = launch("run")
        shoot("2-1-run")
        let list = app.collectionViews.firstMatch
        if list.waitForExistence(timeout: 10) {
            scroll(list)
            shoot("2-2-run-groups")
        }
        _ = launch("revert")
        shoot("2-3-revert-alert")
    }

    // MARK: an entry's bar, with the verdict its revision was applied on

    func test3Entry() {
        _ = launch("entry-unreviewed")
        shoot("3-1-entry-checked-by")
    }

    // MARK: an article's entries: the ones it is written from

    func test4Article() {
        let app = launch("article")
        shoot("4-1-article")
        let list = app.collectionViews.firstMatch
        if list.waitForExistence(timeout: 10) {
            for step in 2...3 {
                scroll(list)
                shoot("4-\(step)-article-entries")
            }
        }
    }
}
