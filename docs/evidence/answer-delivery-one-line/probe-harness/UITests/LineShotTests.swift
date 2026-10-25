import XCTest

// TEMPORARY evidence probe (never merged): the owner's answer handed to the coordinator, drawn as one line in
// the iPhone app's own coordinator conversation, against .oal-probe/stub.py (task 34dQVoIQtWgVP0Ol03o3x,
// docs/mocks/coordinator-question-answered step 4). Each launch opens one conversation; the line is found
// by its own words, opened with the app's own tap, and photographed with its sheet. A line the app does not
// draw — or the agent's words drawn in the conversation as a bubble — is a failure, not a note.
final class LineShotTests: ProbeCase {
    private let sent = "Sent to the coordinator"
    private let told = "From Orbit · owner answer: you asked"
    private let notYet = "From Orbit · owner says not yet"
    private let sheetTitle = "What the coordinator was told"

    /// Launch onto one conversation and wait for `words`. The clock follows the device's locale, as every
    /// receipt's does; en_GB is a 24-hour English one, the board's "08:29".
    private func open(_ session: String, until words: String, _ name: String,
                      locale: String = "en_GB") -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.session", session,
                               "-ApplePersistenceIgnoreState", "YES", "-probe.fresh",
                               "-AppleLanguages", "(en)", "-AppleLocale", locale]
        app.launchEnvironment["TZ"] = "Asia/Shanghai"
        app.launch()
        if !appears(app, words, timeout: 60) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(words) never showed — the app did not draw the stub's turn")
        }
        settle(3)
        return app
    }

    /// The line: one button whose words begin with "Sent to the coordinator".
    private func line(_ app: XCUIApplication, _ name: String) -> XCUIElement? {
        let query = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", sent))
        guard query.firstMatch.waitForExistence(timeout: 20) else {
            write(app.debugDescription, "missing-line-\(name).txt")
            XCTFail("\(name): no line saying \(sent)")
            return nil
        }
        let found = query.firstMatch
        note("\(name): line \(describe(found))")
        return found
    }

    /// Open the line's sheet and wait for its title.
    private func openSheet(_ app: XCUIApplication, _ line: XCUIElement, _ name: String) -> Bool {
        if !line.isHittable { bring(app, line, between: 140, and: 700, missingIsAbove: true, name) }
        line.tap()
        guard appears(app, sheetTitle, timeout: 15) else {
            write(app.debugDescription, "missing-sheet-\(name).txt")
            XCTFail("\(name): the line opened no sheet saying \(sheetTitle)")
            return false
        }
        settle(1.5)
        return true
    }

    private func close(_ app: XCUIApplication) {
        let close = app.buttons["Close"]
        if close.waitForExistence(timeout: 5) { close.tap() } else { note("no Close button") }
        settle(1.2)
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
            XCTFail("\(name): the conversation draws \(words) — the agent's words as a message")
        }
    }

    /// Every label on screen, for the notes beside the picture.
    private func labels(_ app: XCUIApplication, _ name: String) {
        let texts = app.staticTexts.allElementsBoundByIndex.map(\.label).filter { !$0.isEmpty }
        note("\(name) texts: " + texts.prefix(80).joined(separator: " ¦ "))
        let buttons = app.buttons.allElementsBoundByIndex.map(\.label).filter { !$0.isEmpty }
        note("\(name) buttons: " + buttons.prefix(40).joined(separator: " ¦ "))
    }

    // MARK: 1 · the Answered card, and under it the one line

    func test1TheLineUnderTheAnsweredCard() {
        let app = open("C1", until: sent, "line")
        guard let found = line(app, "line") else { shot("ios-01-answered-then-line"); return }
        XCTAssertTrue(found.label.hasPrefix("\(sent) · 08:29"), "the line says \(found.label)")
        expectNoText(app, told, "line")
        expectText(app, ["Answered", "现在重开，接受这个代价（推荐）", "收到：现在重开灰度"], "line")
        labels(app, "line")
        shot("ios-01-answered-then-line")
        shot(found, "ios-01b-the-line")
        tree(app, "line")
    }

    // MARK: 2 · the line opens to the words the coordinator read

    func test2TheLineOpensToTheWords() {
        let app = open("C1", until: sent, "sheet")
        guard let found = line(app, "sheet"), openSheet(app, found, "sheet") else {
            shot("ios-02-told-sheet")
            return
        }
        expectText(app, [told, "灰度回退之后的收尾都做完了", "The owner answered: 现在重开，接受这个代价（推荐）",
                         "\(sent) · 08:29"], "sheet")
        labels(app, "sheet")
        shot("ios-02-told-sheet")
        tree(app, "sheet")
        close(app)
        expectNoText(app, told, "after-close")
    }

    // MARK: 3 · the owner's Not yet… to a request to record the project done

    func test3NotYetIsTheSameLine() {
        let app = open("C2", until: sent, "not-yet")
        guard let found = line(app, "not-yet") else { shot("ios-03-not-yet-line"); return }
        XCTAssertTrue(found.label.hasPrefix("\(sent) · 08:41"), "the line says \(found.label)")
        expectNoText(app, notYet, "not-yet")
        labels(app, "not-yet")
        shot("ios-03-not-yet-line")
        guard openSheet(app, found, "not-yet-sheet") else { return }
        expectText(app, [notYet, "What’s missing before it’s done?"], "not-yet-sheet")
        shot("ios-03b-not-yet-sheet")
        close(app)
    }

    // MARK: 4 · still on the queue: the same line, dashed, with the queue's way out

    func test4AQueuedAnswerIsTheSameLine() {
        let app = open("C3", until: sent, "queued")
        guard let found = line(app, "queued") else { shot("ios-04-queued-line"); return }
        XCTAssertTrue(found.label.hasPrefix("\(sent) · 08:29"), "the line says \(found.label)")
        expectNoText(app, told, "queued")
        expectText(app, ["Queued", "Cancel"], "queued")
        labels(app, "queued")
        shot("ios-04-queued-line")
        tree(app, "queued")
    }

    // MARK: 5 · the same line on a 12-hour English device

    func test5TheClockFollowsTheDevice() {
        let app = open("C1", until: sent, "en-us", locale: "en_US")
        guard let found = line(app, "en-us") else { shot("ios-05-line-en-us"); return }
        XCTAssertTrue(found.label.hasPrefix("\(sent) · 8:29"), "the line says \(found.label)")
        shot("ios-05-line-en-us")
    }
}
