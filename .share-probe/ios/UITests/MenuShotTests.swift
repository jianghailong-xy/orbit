import XCTest

// TEMPORARY evidence probe (see ../../README.md): open the project menu, photograph it, press Copy
// Link, and read what landed on the pasteboard.
final class MenuShotTests: XCTestCase {
    func testTheProjectMenuCopiesTheLinkInsteadOfSharingIt() throws {
        let app = XCUIApplication()
        app.launch()
        let bar = app.navigationBars.firstMatch
        XCTAssertTrue(bar.waitForExistence(timeout: 60))
        let more = bar.buttons["More"]
        XCTAssertTrue(more.waitForExistence(timeout: 20),
                      "no More button; the bar has: \(bar.buttons.allElementsBoundByIndex.map(\.label))")
        Thread.sleep(forTimeInterval: 1)
        shoot("1-ios-project-page")

        more.tap()
        let copy = app.buttons["Copy Link"]
        XCTAssertTrue(copy.waitForExistence(timeout: 10), "the open menu offers Copy Link")
        XCTAssertFalse(app.buttons["Share link"].exists, "and no longer offers Share link")
        Thread.sleep(forTimeInterval: 1.5)
        shoot("2-ios-project-menu-open")

        copy.tap()
        let pasted = app.staticTexts["pasteboard"]
        expectation(for: NSPredicate(format: "label == %@", "https://orbitd.io/projects/34UonbgOiq9ajX8aH3JPz"),
                    evaluatedWith: pasted)
        waitForExpectations(timeout: 10)
        XCTAssertFalse(app.otherElements["ActivityListView"].waitForExistence(timeout: 3),
                       "Copy Link opens no system share sheet")
        shoot("3-ios-after-copy-link")
    }

    private func shoot(_ name: String) {
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
}
