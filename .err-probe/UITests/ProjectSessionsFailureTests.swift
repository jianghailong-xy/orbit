import XCTest

// TEMPORARY evidence probe (never merged): the iPhone app against stub.py, whose project-sessions
// read answers a Cloudflare 502 page until this test writes SHOTS_DIR/server-up. The project's
// sessions page must say so in one sentence with Retry — never the page's HTML — keep saying it
// through its 4-second polls, and draw the sessions once the server is back and Retry is pressed.
final class ProjectSessionsFailureTests: XCTestCase {
    private let title = "DeepSeek Harness 首版后续"
    private var notes: [String] = []

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        let file = name.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        write(notes.joined(separator: "\n"), "\(file)-notes.txt")
    }

    func testA502PageIsOneSentenceWithRetryThatStaysUpThroughPolls() {
        let app = launch()
        let row = listRow(app)
        guard row.waitForExistence(timeout: 60) else {
            tree(app, "no-list-row")
            return XCTFail("the workspace list never showed the project row")
        }
        settle(1)
        row.tap()
        let failed = containing(app, "Couldn't load sessions")
        guard failed.waitForExistence(timeout: 30) else {
            shot("00-no-failure")
            tree(app, "no-failure")
            return XCTFail("the project's sessions page never said its read failed")
        }
        settle(1)
        shot("01-failed-read")
        tree(app, "failed-read")
        note("title: \(describe(failed))")

        let reason = containing(app, "The server returned 502.")
        XCTAssertTrue(reason.exists, "the reason is one sentence: the status, not the page")
        note("reason: \(describe(reason))")
        let markup = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "DOCTYPE", "<html")).count
        XCTAssertEqual(markup, 0, "no element shows the 502 page's HTML")
        let retry = app.buttons["Retry"]
        XCTAssertTrue(retry.exists, "the failure offers Retry")
        note("retry: \(describe(retry))")

        // Each poll's 502 takes the stub 1.5 s of every 4: a notice that hid while a read was in
        // flight would be missing from about a third of these samples.
        var missing = 0
        var samples = 0
        let until = Date().addingTimeInterval(12)
        while Date() < until {
            samples += 1
            if !failed.exists { missing += 1 }
            Thread.sleep(forTimeInterval: 0.2)
        }
        note("failure missing in \(missing) of \(samples) samples over 12 s")
        XCTAssertGreaterThan(samples, 5, "enough samples to span the polls")
        XCTAssertEqual(missing, 0, "the failure blinked out while a poll was in flight")

        write("up", "server-up")
        retry.tap()
        let member = containing(app, "Member task of the probe")
        XCTAssertTrue(member.waitForExistence(timeout: 20), "Retry, with the server back, draws the sessions")
        XCTAssertTrue(gone(failed, timeout: 5), "and the failure goes")
        settle(1.5)
        shot("02-after-retry")
        tree(app, "after-retry")
    }

    // MARK: helpers

    private func containing(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES"]
        app.launch()
        return app
    }

    /// The workspace list's project row: its combined label starts with the title and goes on (the
    /// progress chip, the second line). The drawer's row is the title alone.
    private func listRow(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@ AND label != %@", title, title)).firstMatch
    }

    private func gone(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if !element.exists { return true }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        return false
    }

    private func describe(_ element: XCUIElement) -> String {
        guard element.exists else { return "(missing)" }
        return "\(element.elementType.rawValue) label=\"\(element.label)\" id=\"\(element.identifier)\" "
            + "frame=\(element.frame) hittable=\(element.isHittable)"
    }

    private func settle(_ seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func note(_ line: String) {
        notes.append(line)
    }

    private func tree(_ app: XCUIApplication, _ name: String) {
        write(app.debugDescription, "tree-\(name).txt")
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(data: XCUIScreen.main.screenshot().pngRepresentation,
                                       uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? XCUIScreen.main.screenshot().pngRepresentation
            .write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    private func write(_ text: String, _ file: String) {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? text.write(to: URL(fileURLWithPath: dir).appendingPathComponent(file), atomically: true, encoding: .utf8)
    }
}
