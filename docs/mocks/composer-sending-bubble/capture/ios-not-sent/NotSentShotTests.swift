import XCTest

// The built iPhone app's Not sent frames, for 04-native-parity.html: a send the stub never answers (it holds the
// POST 45 s; the app ends it at 20 s) and one it refuses with 409. Takes the harness's class name, so its scheme
// runs it unchanged.
final class RegionShotTests: ProbeCase {
    private func open() -> (XCUIApplication, XCUIElement)? {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.fresh", "-probe.session", "S1", "-AppleLanguages", "(en)",
                               "-AppleLocale", "en_GB"]
        app.launch()
        guard appears(app, "neither test sleeps", timeout: 90) else {
            write(app.debugDescription, "missing-transcript.txt")
            XCTFail("the transcript never showed")
            return nil
        }
        settle(2)
        return (app, app.textViews.firstMatch)
    }

    private func send(_ app: XCUIApplication, _ box: XCUIElement, _ words: String) {
        box.tap()
        box.typeText(words)
        var send = app.buttons["arrow.up.circle.fill"].firstMatch
        if !send.exists {
            send = app.buttons.matching(NSPredicate(format: "label IN {'Send', 'Up', 'Arrow Up Circle'}")).firstMatch
        }
        send.tap()
    }

    func testNotSentAfterTwentySeconds() {
        guard let (app, box) = open() else { return }
        send(app, box, "Ship the quarterly report")
        let pressed = Date()
        XCTAssertTrue(appears(app, "Sending…", timeout: 8), "no Sending… first")
        XCTAssertTrue(appears(app, "Not sent", timeout: 45), "the bubble never read Not sent")
        let after = Date().timeIntervalSince(pressed)
        note("Not sent \(after) s after the press")
        XCTAssertGreaterThan(after, 18, "Not sent before the 20 s were up")
        settle(1.5)
        write(app.debugDescription, "not-sent-unanswered-tree.txt")
        XCTAssertTrue(containing(app, "Retry").exists)
        XCTAssertTrue(containing(app, "Put back in the composer").exists)
        XCTAssertTrue(appears(app, "The server didn't answer in 20 seconds", timeout: 3), "the reason is not printed")
        XCTAssertFalse(containing(app, "Couldn't send").exists, "a Couldn't send line")
        XCTAssertNotEqual(box.value as? String, "Ship the quarterly report", "the words went back by themselves")
        shot("ios-built-not-sent-unanswered")
        expectRequest("Ship the quarterly report", "not-sent")
    }

    func testRefusedThenPutBack() {
        guard let (app, box) = open() else { return }
        send(app, box, "Archive last year's tickets")
        XCTAssertTrue(appears(app, "Not sent", timeout: 15), "the bubble never read Not sent")
        settle(1.5)
        write(app.debugDescription, "refused-tree.txt")
        XCTAssertTrue(appears(app, "the session has ended", timeout: 3), "the server's reason is not printed")
        XCTAssertFalse(containing(app, "Couldn't send").exists, "a Couldn't send line")
        shot("ios-built-refused")
        let putBack = app.buttons.matching(NSPredicate(format: "label == 'Put back in the composer'")).firstMatch
        guard putBack.exists else { return XCTFail("no Put back to press") }
        putBack.tap()
        settle(1.5)
        write(app.debugDescription, "put-back-tree.txt")
        XCTAssertFalse(containing(app, "Not sent").exists, "the bubble stayed")
        XCTAssertEqual(box.value as? String, "Archive last year's tickets", "the words did not come back")
        shot("ios-built-put-back")
    }
}
