import XCTest

// TEMPORARY evidence probe (never merged): the owner's answer to a criteria proposal, drawn as one line in the iPhone
// and Mac apps' own conversations, against .crs-probe/stub.py (task 34pWyIeaPCCHGAznSK97W). R1 is a task's run that
// filed the proposal: its card says `toCoordinator: false`, and the line must say it was sent to this session and open
// to what this session was told. C2 is the project's coordinator: its line must say what every delivery says. Each
// launch opens one conversation; the line is found by its own words (its accessibility label is the whole line: the
// sentence, then where it was sent and when), opened with the app's own tap, and photographed. A wrong word on the
// line or in its sheet is a failure, not a note.
final class ReplyLineShotTests: ProbeCase {
    private let rejected = "Criteria proposal rejected"
    private let approved = "Criteria proposal approved"
    private let toSession = "Sent to this session"
    private let toCoordinator = "Sent to the coordinator"
    private let sessionTold = "What this session was told"
    private let coordinatorTold = "What the coordinator was told"
    private let sessionHint = "Opens what this session was told"
    private let coordinatorHint = "Opens what the coordinator was told"
    /// Words only each reply's message holds: never on screen outside the opened sheet.
    private let rejectedWords = "was refused by the account owner"
    private let approvedWords = "was approved by the account owner"

    /// Launch onto one conversation and wait for its reply under the line. en_US, as the board's "07:30 PM" clock reads.
    private func open(_ session: String, until reply: String, _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.session", session,
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
        if !appears(app, reply, timeout: 45) {
            write(app.debugDescription, "missing-reply-\(name).txt")
            XCTFail("\(name): the conversation's reply \(reply) never showed — the app did not render the stub's turns")
        }
        settle(3)
        return app
    }

    /// The line: one button whose label is the sentence, then where it was sent and when.
    private func line(_ app: XCUIApplication, _ sentence: String, _ name: String) -> XCUIElement? {
        let query = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", sentence))
        guard query.firstMatch.waitForExistence(timeout: 30) else {
            write(app.debugDescription, "missing-line-\(name).txt")
            XCTFail("\(name): no line beginning \(sentence)")
            return nil
        }
        let found = query.firstMatch
        #if os(iOS)
        if !found.isHittable || found.frame.minY < 120 || found.frame.maxY > 720 {
            bring(app, found, between: 120, and: 720, missingIsAbove: true, "\(name)-line")
        }
        #endif
        note("\(name): line \(describe(found))")
        return found
    }

    /// Anything on screen holding these words, by label — and on macOS by a text's value too.
    private func shows(_ app: XCUIApplication, _ words: String) -> Bool {
        if containing(app, words).exists { return true }
        #if os(macOS)
        let byValue = NSPredicate(format: "value CONTAINS %@", words)
        if app.staticTexts.matching(byValue).firstMatch.exists || app.textViews.matching(byValue).firstMatch.exists {
            return true
        }
        #endif
        return false
    }

    private func expectText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for text in words where !shows(app, text) {
            write(app.debugDescription, "missing-text-\(name).txt")
            XCTFail("\(name): nothing says \(text)")
        }
    }

    private func expectNoText(_ app: XCUIApplication, _ words: String, _ name: String) {
        if shows(app, words) {
            write(app.debugDescription, "unexpected-text-\(name).txt")
            XCTFail("\(name): the screen holds \(words)")
        }
    }

    /// Whether the element tree spells the line's hint: XCUITest has no property for one, so this is a note.
    private func noteHint(_ app: XCUIApplication, _ hint: String, _ name: String) {
        let text = app.debugDescription
        note("\(name): the tree \(text.contains(hint) ? "spells" : "does not spell") the hint \"\(hint)\"")
    }

    /// Open a line's sheet with the app's own tap and wait for what only the sheet shows: the message's own words.
    private func openSheet(_ app: XCUIApplication, _ found: XCUIElement, words: String, _ name: String) -> Bool {
        #if os(iOS)
        found.tap()
        #else
        found.click()
        #endif
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline && !shows(app, words) { settle(0.5) }
        guard shows(app, words) else {
            write(app.debugDescription, "missing-sheet-\(name).txt")
            XCTFail("\(name): the line opened no sheet")
            return false
        }
        settle(1.5)
        return true
    }

    /// The task's run: the line, then its sheet.
    private func taskRun(_ prefix: String) {
        let app = open("R1", until: "Understood: criterion 2 stays", "\(prefix)-run")
        guard let found = line(app, rejected, "\(prefix)-run") else { shot("\(prefix)-01-run-line"); return }
        XCTAssertTrue(found.label.contains(" · \(toSession) · "), "\(prefix)-run: the line says \(found.label)")
        XCTAssertFalse(found.label.contains(toCoordinator), "\(prefix)-run: the line says \(found.label)")
        expectNoText(app, toCoordinator, "\(prefix)-run")
        expectNoText(app, rejectedWords, "\(prefix)-run")
        expectNoText(app, "Put back in the composer", "\(prefix)-run")
        noteHint(app, sessionHint, "\(prefix)-run")
        if app.debugDescription.contains(coordinatorHint) { XCTFail("\(prefix)-run: the tree spells \(coordinatorHint)") }
        shot("\(prefix)-01-run-line")
        shot(found, "\(prefix)-01b-run-line-close")
        tree(app, "\(prefix)-run-line")
        guard openSheet(app, found, words: rejectedWords, "\(prefix)-run-sheet") else { shot("\(prefix)-02-run-sheet"); return }
        shot("\(prefix)-02-run-sheet")
        tree(app, "\(prefix)-run-sheet")
        expectText(app, [sessionTold, rejectedWords, "Keep criterion 2: the link test is what proves the switch."],
                   "\(prefix)-run-sheet")
        expectNoText(app, coordinatorTold, "\(prefix)-run-sheet")
        expectNoText(app, toCoordinator, "\(prefix)-run-sheet")
    }

    /// The project's coordinator: the same kind of line, as every delivery says it.
    private func coordinator(_ prefix: String) {
        let app = open("C2", until: "Criterion 3 is now revision 2", "\(prefix)-coordinator")
        guard let found = line(app, approved, "\(prefix)-coordinator") else { shot("\(prefix)-03-coordinator-line"); return }
        XCTAssertTrue(found.label.contains(" · \(toCoordinator) · "), "\(prefix)-coordinator: the line says \(found.label)")
        expectNoText(app, toSession, "\(prefix)-coordinator")
        noteHint(app, coordinatorHint, "\(prefix)-coordinator")
        shot("\(prefix)-03-coordinator-line")
        shot(found, "\(prefix)-03b-coordinator-line-close")
        tree(app, "\(prefix)-coordinator-line")
        guard openSheet(app, found, words: approvedWords, "\(prefix)-coordinator-sheet") else {
            shot("\(prefix)-04-coordinator-sheet")
            return
        }
        shot("\(prefix)-04-coordinator-sheet")
        tree(app, "\(prefix)-coordinator-sheet")
        expectText(app, [coordinatorTold, approvedWords], "\(prefix)-coordinator-sheet")
        expectNoText(app, sessionTold, "\(prefix)-coordinator-sheet")
    }

    #if os(iOS)
    func test1TheTaskRunsLineAndSheetOnAPhone() { taskRun("ios") }
    func test2TheCoordinatorsLineAndSheetOnAPhone() { coordinator("ios") }
    #endif

    #if os(macOS)
    func test3TheTaskRunsLineAndSheetOnTheMac() { taskRun("mac") }
    func test4TheCoordinatorsLineAndSheetOnTheMac() { coordinator("mac") }
    #endif
}
