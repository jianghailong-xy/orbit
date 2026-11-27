import XCTest

// TEMPORARY evidence probe (never merged): `Queued · runner full · Cancel` under a message no runner has taken, in the
// iPhone and Mac apps' own conversations, against .hc-probe/stub.py (task 350Wz6vjlg4mgTMX8AYaq). S1 is queued behind a
// full runner and its last message is the accepted head of GET …/turns?view=active. The foot is photographed, Cancel
// is pressed with the app's own tap, and the DELETE the stub logged and the words back in the composer are checked.
// A missing word or request is a failure, not a note.
final class HeldCancelShotTests: ProbeCase {
    private let waiting = "Why is task 6 still queued?"
    private let reply = "Task 5 is running on HPC"

    private func open(_ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.session", "S1",
                               "-ApplePersistenceIgnoreState", "YES", "-probe.fresh",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launchEnvironment["TZ"] = "Asia/Shanghai"
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        if !app.windows.firstMatch.waitForExistence(timeout: 20) {
            note("\(name): no window after launch; File > New Window")
            app.typeKey("n", modifierFlags: .command)
        }
        #endif
        for words in [reply, waiting, "runner full"] where !appears(app, words, timeout: 45) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(words) never showed — the app did not render the stub's state")
        }
        settle(3)
        return app
    }

    /// The Cancel on the foot row: the one button labelled Cancel level with the `runner full` tag.
    private func heldCancel(_ app: XCUIApplication) -> XCUIElement? {
        let tag = app.buttons.matching(NSPredicate(format: "label == %@", "runner full")).firstMatch
        guard tag.exists else { return nil }
        let cancels = app.buttons.matching(NSPredicate(format: "label == %@", "Cancel")).allElementsBoundByIndex
        return cancels.first { $0.exists && abs($0.frame.midY - tag.frame.midY) < 12 && $0.frame.minX > tag.frame.maxX }
    }

    /// The composer's text: the lowest text input on screen. On iOS a bubble's selectable words are a
    /// text view too (the first run's pre-press check matched the bubble itself), so only the lowest counts.
    private func composerHolds(_ app: XCUIApplication, _ words: String) -> Bool {
        let inputs = (app.textViews.allElementsBoundByIndex + app.textFields.allElementsBoundByIndex).filter(\.exists)
        guard let composer = inputs.max(by: { $0.frame.minY < $1.frame.minY }) else { return false }
        note("composer: \(describe(composer))")
        return (composer.value as? String)?.contains(words) == true
    }

    private func run(_ prefix: String) {
        let app = open(prefix)
        guard let cancel = heldCancel(app) else {
            write(app.debugDescription, "missing-cancel-\(prefix).txt")
            shot("\(prefix)-01-held-foot")
            XCTFail("\(prefix): no Cancel after `Queued · runner full`")
            return
        }
        note("\(prefix): Cancel \(describe(cancel))")
        shot("\(prefix)-01-held-foot")
        tree(app, "\(prefix)-held-foot")
        XCTAssertFalse(composerHolds(app, waiting), "\(prefix): the words are in the composer before the press")
        #if os(iOS)
        cancel.tap()
        #else
        cancel.click()
        #endif
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline && !composerHolds(app, waiting) { settle(0.5) }
        settle(1.5)
        shot("\(prefix)-02-after-cancel")
        tree(app, "\(prefix)-after-cancel")
        // The Mac runner may not read the stub's log; then writes.txt beside the pictures is the record.
        if requestsLog().isEmpty { note("\(prefix): requests.log unreadable here; see writes.txt") }
        else { expectRequest("DELETE /api/sessions/S1/turns/t6", "\(prefix)-cancel") }
        XCTAssertTrue(composerHolds(app, waiting), "\(prefix): the words did not come back to the composer")
        XCTAssertNil(heldCancel(app), "\(prefix): the foot still offers Cancel after the withdraw")
    }

    #if os(iOS)
    func test1HeldCancelOnAPhone() { run("ios") }
    #endif

    #if os(macOS)
    func test2HeldCancelOnTheMac() { run("mac") }
    #endif
}
