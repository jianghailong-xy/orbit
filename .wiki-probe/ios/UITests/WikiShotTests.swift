import XCTest

// TEMPORARY evidence probe (see ../../README.md): the Wiki home under the title for every case of the
// status line's fixture, photographed. Every test keeps going after a miss, so one run brings back every
// picture it can.
final class WikiShotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    private func launch(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = arguments
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

    // MARK: the status line's looks — off, up to date, running, behind, failing (mock 12 ④)

    private func home(_ n: Int, _ name: String) {
        let app = launch(["-screen", "home", "-case", String(n)])
        XCTAssertTrue(app.collectionViews.firstMatch.waitForExistence(timeout: 10), "the home page is a list")
        shoot("5-\(n)-\(name)")
    }

    func test0Off() { home(0, "off") }
    func test1UpToDate() { home(1, "up-to-date") }
    func test2NeverRun() { home(2, "on-never-run") }
    func test3Running() { home(3, "running") }
    func test4Behind() { home(4, "behind-daily-limit") }
    func test5BehindQueue() { home(5, "behind-review-queue") }
    func test6Failing() { home(6, "failing-3") }
    func test7FailingOnce() { home(7, "failing-once") }
}
