import XCTest

// TEMPORARY evidence probe (never merged): a fact Orbit tells a coordinator, drawn as one line in the iPhone and
// Mac apps' own coordinator conversations, against .cdl-probe/stub.py (task 34pVGFQvGcjxSppunCWTK,
// docs/mocks/coordinator-delivery-line/). Each launch opens one conversation; the line is found by its own words
// (its accessibility label is the whole line: the sentence, then "Sent to the coordinator · time"), opened with
// the app's own tap, and photographed. A line the app does not draw, the agent's words drawn as a message, or an
// offer to put them back in the composer is a failure, not a note.
final class DeliveryLineShotTests: ProbeCase {
    private let sent = "Sent to the coordinator"
    private let evidenceSentence = "Evidence revision 1 submitted: Wiki model queue: one claim can take more requests than the concurrency room"
    private let readySentence = "Can start now: Switch the runner link to WebSocket"
    private let unlandedSentence = "Work not on main yet: 3 tasks"
    /// Words only the agent's message holds: never on screen outside the opened sheet.
    private let evidenceWords = "has a revision of completion evidence for you to decide"
    private let readyWords = "has a downstream task that can start now"
    private let unlandedWords = "has finished work that has not landed on main"
    private let sheetTitle = "What the coordinator was told"
    private let itsTask = "Its task ↗"
    private let undelivered = "The session has not confirmed it received this."

    /// Launch onto one conversation and wait for its line. en_US, as the board's "07:30 PM" clock reads.
    private func open(_ session: String, sentence: String, _ name: String) -> XCUIApplication {
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
        // The conversation's own reply is on screen once its events are read.
        if !appears(app, "orbit-develop", timeout: 5) { note("\(name): no agent name yet") }
        settle(3)
        return app
    }

    /// The line: one button whose label is the sentence, then "Sent to the coordinator · time".
    private func line(_ app: XCUIApplication, _ sentence: String, _ name: String, bring band: Bool = true) -> XCUIElement? {
        let query = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", sentence))
        if !query.firstMatch.waitForExistence(timeout: 30) && band {
            // Opened at its end, a long reply can hold the line above the screen: drag it down into view.
            bring(app, query.firstMatch, between: 120, and: 720, missingIsAbove: true, "\(name)-line")
        }
        guard query.firstMatch.waitForExistence(timeout: 10) else {
            write(app.debugDescription, "missing-line-\(name).txt")
            XCTFail("\(name): no line beginning \(sentence)")
            return nil
        }
        let found = query.firstMatch
        if band && (!found.isHittable || found.frame.minY < 120 || found.frame.maxY > 720) {
            bring(app, found, between: 120, and: 720, missingIsAbove: true, "\(name)-line")
        }
        note("\(name): line \(describe(found))")
        XCTAssertTrue(found.label.contains(" · \(sent) · "), "\(name): the line says \(found.label)")
        return found
    }

    private func expectText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for text in words where !containing(app, text).exists {
            write(app.debugDescription, "missing-text-\(name).txt")
            XCTFail("\(name): nothing says \(text)")
        }
    }

    private func expectNoText(_ app: XCUIApplication, _ words: String, _ name: String) {
        if containing(app, words).exists {
            write(app.debugDescription, "unexpected-text-\(name).txt")
            XCTFail("\(name): the screen holds \(words)")
        }
        #if os(macOS)
        if app.staticTexts.matching(NSPredicate(format: "value CONTAINS %@", words)).firstMatch.exists {
            write(app.debugDescription, "unexpected-value-\(name).txt")
            XCTFail("\(name): a text's value holds \(words)")
        }
        #endif
    }

    /// What is on screen, for the notes beside the picture: the tree, read once as one snapshot. Walking the
    /// elements by index raced the transcript's relayout in round 1 ("No matches found for Element at index 22").
    private func labels(_ app: XCUIApplication, _ name: String) {
        tree(app, "labels-\(name)")
    }

    /// Open a line's sheet with the app's own tap and wait for what it shows: its heading, or — where a
    /// platform draws no navigation title in a sheet — its link to the task.
    private func openSheet(_ app: XCUIApplication, _ found: XCUIElement, _ name: String) -> Bool {
        #if os(iOS)
        found.tap()
        #else
        found.click()
        #endif
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline && !containing(app, sheetTitle).exists && !app.buttons[itsTask].exists {
            settle(0.5)
        }
        guard containing(app, sheetTitle).exists || app.buttons[itsTask].exists else {
            write(app.debugDescription, "missing-sheet-\(name).txt")
            XCTFail("\(name): the line opened no sheet")
            return false
        }
        settle(1.5)
        return true
    }

    #if os(iOS)
    // MARK: iPhone 1 · the line, two rows on a phone, with the coordinator's reply under it

    func test1TheLineOnAPhone() {
        let app = open("C1", sentence: evidenceSentence, "line")
        guard let found = line(app, evidenceSentence, "line") else { shot("ios-01-line"); return }
        // Two rows: a pill as tall as two lines of text, not one.
        note("line: height \(found.frame.height) pt, width \(found.frame.width) pt")
        XCTAssertGreaterThan(found.frame.height, 40, "the line is one row, not two: \(found.frame)")
        expectNoText(app, evidenceWords, "line")
        expectNoText(app, "Put back in the composer", "line")
        expectText(app, ["How is the review of the wiki model queue going?", "I have read revision 1 of the evidence"], "line")
        labels(app, "line")
        shot("ios-01-line")
        shot(found, "ios-01b-the-line-close")
        tree(app, "line")
    }

    // MARK: iPhone 2 · the line opens to the words the coordinator was told, and the task

    func test2TheSheet() {
        let app = open("C1", sentence: evidenceSentence, "sheet")
        guard let found = line(app, evidenceSentence, "sheet"), openSheet(app, found, "sheet") else {
            shot("ios-02-sheet")
            return
        }
        expectText(app, [evidenceWords, "submitted revision 1 of its completion evidence", "task_evidence_decide"], "sheet")
        let task = app.buttons[itsTask]
        if !task.waitForExistence(timeout: 5) {
            // Below the words on a phone: drag the sheet up until the link shows.
            for _ in 1...6 where !task.exists || !task.isHittable {
                let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
                start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -300)),
                            withVelocity: .slow, thenHoldForDuration: 0.4)
                settle(0.8)
            }
        }
        labels(app, "sheet")
        shot("ios-02-sheet")
        if !containing(app, sheetTitle).exists { XCTFail("sheet: nothing says \(sheetTitle)") }
        if task.exists {
            note("sheet: \(describe(task))")
            if !task.isHittable {
                for _ in 1...6 where !task.isHittable {
                    let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
                    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -300)),
                                withVelocity: .slow, thenHoldForDuration: 0.4)
                    settle(0.8)
                }
            }
            shot("ios-02b-sheet-its-task")
        } else {
            write(app.debugDescription, "missing-its-task.txt")
            XCTFail("sheet: no \(itsTask)")
        }
        tree(app, "sheet")
    }

    // MARK: iPhone 3 · still on the queue: the same line, dashed, with the queue's Queued and Cancel

    func test3QueuedIsTheSameLine() {
        let app = open("C3", sentence: unlandedSentence, "queued")
        guard let found = line(app, unlandedSentence, "queued") else { shot("ios-03-queued"); return }
        expectNoText(app, unlandedWords, "queued")
        expectText(app, ["Queued"], "queued")
        if !app.buttons["Cancel"].exists {
            write(app.debugDescription, "missing-cancel.txt")
            XCTFail("queued: no Cancel")
        }
        labels(app, "queued")
        shot("ios-03-queued")
        shot(found, "ios-03b-queued-close")
        tree(app, "queued")
    }

    // MARK: iPhone 4 · never confirmed: says so, and puts nothing back in the composer

    func test4UndeliveredSaysSo() {
        let app = open("C2", sentence: readySentence, "undelivered")
        guard let found = line(app, readySentence, "undelivered") else { shot("ios-04-undelivered"); return }
        expectText(app, [undelivered], "undelivered")
        expectNoText(app, "Put back in the composer", "undelivered")
        expectNoText(app, readyWords, "undelivered")
        note("undelivered: \(describe(found))")
        labels(app, "undelivered")
        shot("ios-04-undelivered")
        tree(app, "undelivered")
    }

    // MARK: iPhone 5 · scrolled past the line, the sticky header names it From Orbit, in its own sentence

    func test5TheStickyHeader() {
        let app = open("C1", sentence: evidenceSentence, "sticky")
        // The conversation opens at its end. Wait until the reply's last lines are on screen, then make sure
        // the line itself is above the top: the header points back at the last turn scrolled past.
        _ = appears(app, "Next up is C2b", timeout: 20)
        let lineQuery = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", evidenceSentence))
        // At the live tail the header is hidden by design (ConsoleView: `!atBottom`): the reader is following
        // the answer. Move back into the history a little — less than the reply is tall, so the line stays
        // above the top and is the turn the header names.
        let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.45))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 160)),
                    withVelocity: .slow, thenHoldForDuration: 0.6)
        settle(2)
        note("sticky: after leaving the tail, line \(lineQuery.firstMatch.exists ? "\(lineQuery.firstMatch.frame)" : "(not on screen)")")
        let capsule = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Jump to your last question")).firstMatch
        if !capsule.waitForExistence(timeout: 15) {
            write(app.debugDescription, "missing-sticky.txt")
            XCTFail("sticky: no header pointing back at the line")
        }
        note("sticky: \(describe(capsule)); line \(lineQuery.firstMatch.exists ? "\(lineQuery.firstMatch.frame)" : "(not on screen)")")
        labels(app, "sticky")
        shot("ios-05-sticky")
        shot(capsule, "ios-05b-sticky-close")
        tree(app, "sticky")
        // Pressing it goes back to the line.
        if capsule.exists && capsule.isHittable {
            capsule.tap()
            settle(2)
            note("sticky pressed: line \(lineQuery.firstMatch.exists ? describe(lineQuery.firstMatch) : "(missing)")")
            shot("ios-05c-sticky-pressed")
        }
    }
    #endif

    #if os(macOS)
    // MARK: Mac 1 · the line in the Mac window, and its sheet

    func test6MacLineAndSheet() {
        let app = open("C4", sentence: evidenceSentence, "mac-line")
        guard let found = line(app, evidenceSentence, "mac-line", bring: false) else { shot("mac-01-line"); return }
        expectNoText(app, evidenceWords, "mac-line")
        expectNoText(app, "Put back in the composer", "mac-line")
        labels(app, "mac-line")
        // The console beside the session list is too narrow for the sentence and the time on one row: the
        // line takes the phone's two rows (round 2 cut the sentence to its first letter on one row).
        note("mac-line: \(describe(found))")
        XCTAssertGreaterThan(found.frame.height, 34, "mac-line: one row in a column too narrow for it: \(found.frame)")
        shot("mac-01-line")
        shot(found, "mac-01b-the-line-close")
        tree(app, "mac-line")
        // The sidebar folded away, the console has room: one row again, the sentence cut short, the time whole.
        app.typeKey("s", modifierFlags: [.command, .control])
        settle(2)
        let wide = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", evidenceSentence)).firstMatch
        note("mac-line-wide: \(describe(wide))")
        shot("mac-01c-line-wide")
        if wide.exists { shot(wide, "mac-01d-the-line-wide-close") }
        app.typeKey("s", modifierFlags: [.command, .control])
        settle(2)
        guard openSheet(app, found, "mac-sheet") else { shot("mac-02-sheet"); return }
        labels(app, "mac-sheet")
        shot("mac-02-sheet")
        tree(app, "mac-sheet")
        // What the sheet has to say, checked after the picture so a miss still leaves one.
        expectText(app, [itsTask], "mac-sheet")
        let heading = containing(app, sheetTitle).exists
            || app.staticTexts.matching(NSPredicate(format: "value CONTAINS %@", sheetTitle)).firstMatch.exists
        note("mac-sheet: heading \(heading ? "shown" : "MISSING")")
        if !heading { XCTFail("mac-sheet: nothing in the sheet says \(sheetTitle)") }
        if !app.staticTexts.matching(NSPredicate(format: "value CONTAINS %@", evidenceWords)).firstMatch.exists
            && !containing(app, evidenceWords).exists {
            write(app.debugDescription, "missing-words-mac.txt")
            XCTFail("mac-sheet: the words the coordinator was told are not in the sheet")
        }
    }
    #endif
}
