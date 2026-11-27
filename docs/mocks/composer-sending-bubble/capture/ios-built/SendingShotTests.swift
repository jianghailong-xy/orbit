import XCTest

// The built iPhone app's Sending… and Sent frames, for 04-native-parity.html. The stub holds the send's
// POST for 25 s, then accepts it. Takes the harness's class name, so its scheme runs it unchanged.
final class RegionShotTests: ProbeCase {
    func testSendingThenSent() {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.fresh", "-probe.session", "S1", "-AppleLanguages", "(en)",
                               "-AppleLocale", "en_GB"]
        app.launch()
        guard appears(app, "neither test sleeps", timeout: 90) else {
            write(app.debugDescription, "missing-transcript.txt")
            return XCTFail("the transcript never showed")
        }
        settle(2)
        let box = app.textViews.firstMatch
        box.tap()
        box.typeText("Ship the quarterly report")
        var send = app.buttons["arrow.up.circle.fill"].firstMatch
        if !send.exists {
            send = app.buttons.matching(NSPredicate(format: "label IN {'Send', 'Up', 'Arrow Up Circle'}")).firstMatch
        }
        write(app.debugDescription, "before-send-tree.txt")
        send.tap()
        let pressed = Date()
        XCTAssertTrue(appears(app, "Sending…", timeout: 8), "no Sending… in the foot")
        settle(1)
        write(app.debugDescription, "sending-tree.txt")
        XCTAssertFalse(containing(app, "Working").exists, "something says it is working")
        shot("ios-built-sending")
        box.typeText("Then tag the release")
        settle(1)
        XCTAssertTrue(containing(app, "Sending…").exists, "the answer came before the typing was done")
        shot("ios-built-sending-typed")
        note("typed while sending, \(Date().timeIntervalSince(pressed)) s after the press")
        XCTAssertTrue(appears(app, "just now", timeout: 60), "the accepted bubble never read its time")
        settle(2)
        write(app.debugDescription, "sent-tree.txt")
        XCTAssertFalse(containing(app, "Sending…").exists)
        XCTAssertEqual(box.value as? String, "Then tag the release", "the answer touched the box")
        shot("ios-built-sent")
        expectRequest("Ship the quarterly report", "sent")
    }
}
