import XCTest

// The built iPhone app's new-session first-message frames, for 03-new-session.html: the words leave the box and
// wait as the Sending… bubble in the engine picker's place; unanswered for 20 s they read Not sent; refused (409)
// they read Not sent with the server's reason, and Put back returns the words. Takes the harness's class name,
// so its scheme runs it unchanged.
final class RegionShotTests: ProbeCase {
    private func open() -> (XCUIApplication, XCUIElement)? {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.fresh", "-probe.compose", "a1", "-AppleLanguages", "(en)", "-AppleLocale", "en_GB"]
        app.launch()
        guard app.textViews.firstMatch.waitForExistence(timeout: 60) else {
            write(app.debugDescription, "missing-composer.txt")
            XCTFail("the new-session composer never showed")
            return nil
        }
        settle(2)
        return (app, app.textViews.firstMatch)
    }

    private func press(_ app: XCUIApplication, _ box: XCUIElement, _ words: String) {
        box.tap()
        box.typeText(words)
        var send = app.buttons["arrow.up.circle.fill"].firstMatch
        if !send.exists {
            send = app.buttons.matching(NSPredicate(format: "label IN {'Send', 'Up', 'Arrow Up Circle'}")).firstMatch
        }
        send.tap()
    }

    func testSendingThenNotSentAfterTwentySeconds() {
        guard let (app, box) = open() else { return }
        shot("ios-new-session-empty")
        press(app, box, "Ship the quarterly report")
        let pressed = Date()
        XCTAssertTrue(appears(app, "Sending…", timeout: 8), "no Sending… first")
        settle(1)
        write(app.debugDescription, "sending-tree.txt")
        XCTAssertNotEqual(box.value as? String, "Ship the quarterly report", "the words stayed in the box")
        shot("ios-new-session-sending")
        XCTAssertTrue(appears(app, "Not sent", timeout: 45), "the bubble never read Not sent")
        let after = Date().timeIntervalSince(pressed)
        note("Not sent \(after) s after the press")
        XCTAssertGreaterThan(after, 18, "Not sent before the 20 s were up")
        settle(1.5)
        write(app.debugDescription, "not-sent-unanswered-tree.txt")
        XCTAssertTrue(containing(app, "Retry").exists)
        XCTAssertTrue(containing(app, "Put back in the composer").exists)
        shot("ios-new-session-not-sent")
    }

    func testRefusedThenPutBack() {
        guard let (app, box) = open() else { return }
        press(app, box, "Archive last year's tickets")
        XCTAssertTrue(appears(app, "Not sent", timeout: 15), "the bubble never read Not sent")
        settle(1.5)
        XCTAssertTrue(appears(app, "the machine is offline", timeout: 3), "the server's reason is not printed")
        shot("ios-new-session-refused")
        let putBack = app.buttons.matching(NSPredicate(format: "label == 'Put back in the composer'")).firstMatch
        guard putBack.exists else { return XCTFail("no Put back to press") }
        putBack.tap()
        settle(1.5)
        XCTAssertFalse(containing(app, "Not sent").exists, "the bubble stayed")
        XCTAssertEqual((box.value as? String)?.replacingOccurrences(of: "’", with: "'"),
                       "Archive last year's tickets", "the words did not come back")
        shot("ios-new-session-put-back")
    }
}
