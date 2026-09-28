import XCTest

// TEMPORARY evidence probe (see ../../README.md): open each article screen, scroll through it, press a
// footnote and a topic's chevron, and photograph every step. Every test keeps going after a miss, so
// one run brings back every picture it can.
final class WikiShotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    private func launch(_ screen: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", screen]
        app.launch()
        Thread.sleep(forTimeInterval: 2.5)
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
        XCTFail("no \(what); links: \(app.links.allElementsBoundByIndex.map(\.label)); buttons: \(app.buttons.allElementsBoundByIndex.map(\.label))")
        if let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] {
            try? app.debugDescription.write(toFile: "\(dir)/missing-\(what).txt", atomically: true, encoding: .utf8)
        }
    }

    // MARK: 12 — the home page and its Contents sheet

    func test12Home() {
        let app = launch("home")
        shoot("12-1-home")
        let list = app.collectionViews.firstMatch
        if list.waitForExistence(timeout: 10) {
            scroll(list)
            shoot("12-2-home")
        }
        _ = launch("contents")
        shoot("12-3-contents")
        let sheet = launch("contents-article").collectionViews.element(boundBy: 1)
        if sheet.waitForExistence(timeout: 10) {
            scroll(sheet)
            scroll(sheet)
            shoot("12-4-contents-open-topic")
        }
    }

    // MARK: 14 — a topic's article

    func test14Article() {
        let app = launch("article")
        shoot("14-1-article")
        let list = app.collectionViews.firstMatch
        if list.waitForExistence(timeout: 10) {
            for step in 2...6 {
                scroll(list)
                shoot("14-\(step)-article")
            }
        }
        // A footnote is a link inside the text: press [7] where the page draws it.
        let fresh = launch("article")
        let marker = fresh.links["[7]"].firstMatch
        if marker.waitForExistence(timeout: 5) {
            marker.tap()
            shoot("14-7-footnote-pressed")
        } else {
            missing("footnote-link", fresh)
        }
        _ = launch("article-card")
        shoot("14-8-footnote-card")
    }

    // MARK: 16 — Browse by category and the A–Z index

    func test16BrowseAndIndex() {
        let app = launch("browse")
        shoot("16-1-browse")
        let chevron = app.buttons.matching(NSPredicate(format: "label == '会话'")).element(boundBy: 1)
        if chevron.waitForExistence(timeout: 5) {
            chevron.tap()
            shoot("16-2-browse-open-topic")
        } else {
            missing("browse-chevron", app)
        }
        let list = app.collectionViews.firstMatch
        if list.waitForExistence(timeout: 5) {
            scroll(list)
            shoot("16-3-browse")
        }
        let index = launch("index")
        shoot("16-4-index")
        let indexList = index.collectionViews.firstMatch
        if indexList.waitForExistence(timeout: 10) {
            scroll(indexList)
            shoot("16-5-index")
        }
    }
}
