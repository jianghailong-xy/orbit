import XCTest

// Evidence probe (see ../README.md): the iPhone pass. Each test launches the probe app at one scene
// against stub.py, waits for the words that scene must show, and keeps a picture of the screen. The
// last one types into the guest composer and presses Send — the real control — and waits for the
// message and the agent's reply to come back through the follow read.
final class GuestShotTests: XCTestCase {
    override func setUp() { continueAfterFailure = true }

    private func launch(_ scene: String) -> XCUIApplication {
        reset()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.fresh", "-probe.scene", scene]
        app.launch()
        return app
    }

    private func reset() {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__reset")!)
        request.httpMethod = "POST"
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in done.signal() }.resume()
        _ = done.wait(timeout: .now() + 10)
    }

    private func shows(_ app: XCUIApplication, _ words: String, timeout: TimeInterval = 40) -> Bool {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words))
            .firstMatch.waitForExistence(timeout: timeout)
    }

    private func expect(_ app: XCUIApplication, _ words: [String]) {
        for w in words { XCTAssertTrue(shows(app, w), "never showed: \(w)") }
    }

    private func shot(_ name: String) {
        Thread.sleep(forTimeInterval: 2)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func test1Drawer() {
        let app = launch("drawer")
        expect(app, ["Shared with me", "Fix the flaky login redirect test", "Ana Ruiz · Running",
                     "Ana Ruiz · Awaiting reply", "Draft the Q4 release notes"])
        shot("ios-1-shared-with-me")
    }

    func test2Running() {
        let app = launch("running")
        expect(app, ["Shared by Ana Ruiz", "Guest", "Running", "Runs on Ana Ruiz’s machine",
                     "The redirect races the session cookie", "You"])
        shot("ios-2-running")
    }

    func test3Waiting() {
        let app = launch("waiting")
        expect(app, ["Waiting for Ana Ruiz to approve", "Your message waits its turn", "Awaiting reply"])
        shot("ios-3-waiting-on-owner")
    }

    func test4Ended() {
        let app = launch("ended")
        expect(app, ["Ended", "Send to continue — this restarts the session on Ana Ruiz’s machine."])
        shot("ios-4-ended")
    }

    func test5NotShared() {
        let app = launch("gone")
        expect(app, ["This conversation is no longer shared with you."])
        shot("ios-5-no-longer-shared")
    }

    func test6Sends() {
        let app = launch("running")
        XCTAssertTrue(shows(app, "Runs on Ana Ruiz’s machine"))
        let field = app.textFields.matching(NSPredicate(format: "placeholderValue CONTAINS %@", "agent")).firstMatch
        let input = field.exists ? field : app.textViews.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 10), "no composer")
        input.tap()
        input.typeText("Please also add a test for the logout redirect.")
        app.buttons["Send"].tap()
        expect(app, ["Please also add a test for the logout redirect.", "Got it — I’ll take that on next."])
        shot("ios-6-sent")
    }
}
