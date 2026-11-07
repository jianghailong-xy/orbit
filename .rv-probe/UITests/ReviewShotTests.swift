import XCTest
#if os(macOS)
import AppKit
#endif

// TEMPORARY evidence probe (never merged), task 34tDf8rxHzhwoGyK6r0kj: the challenge card the owner approved
// (docs/mocks/wiki-challenge-answers/02-proposal.png, D1-D5) as the iPhone app's own CompactShell and the Mac app's own
// MainView draw it, against .rv-probe/stub.py, which answers with what a real apiserver built from this tree answered
// (one changeset, four pending `challenge` ops). Pictures:
//   01 Review as it opens; 02 the first card's foot: the After row, Keep, Amend…, Retire… and the note under them;
//   03 the fourth card's foot, a decision's: no Amend…, two After lines (reached with Next, so the page went back up);
//   04 Retire… pressed: the dialog, its reason filled in from the challenge; 05 after Cancel;
//   06 Keep pressed: frames from the host (capture.py), the toast and the next card from its top;
//   07 Retire… confirmed with the filled-in reason: the decide carries it as its note, the toast says Retired.
// The Mac pass photographs 01 and 02. What XCUITest reads — labels, frames, isEnabled — goes to the notes beside them.
final class ReviewShotTests: ProbeCase {
    #if os(iOS)
    private let platform = "iphone"
    #else
    private let platform = "mac"
    #endif

    /// All four entries, as this data names them, and the four cards' titles in the queue's order.
    private let entries = ["34tET9EjbYwX7laXtwrTg", "34tET9eT3M4Rq8I65iwj9", "34tET9jXOfPPMzGxWA6Sp", "34tET9mMkTx1nAiAnY9Da"]
    private let titles = ["部署生产走 orbit-prod 升级流程，无需所有者确认",
                          "session.sum_cache_read 是 int4，大会话会溢出卡死 turn-complete",
                          "session sum_* 列是 int4，长会话 cache read 累加会溢出",
                          "Claims feature deferred to wiki-claims-replay branch"]
    /// The first card's challenge reason, as the dialog should be filled in with.
    private let firstReason = "Wrong as a standing rule. Production deploys need the account owner's approval;"
    private let waitsNote = "Agents stop getting this entry until you answer."
    private let answers = ["Keep", "Amend\u{2026}", "Retire\u{2026}"]

    // MARK: the cases

    /// 01 and 02: Review as it opens on the first card, then that card's foot with its After row and answers.
    func test1ReviewOpened() {
        let tag = "\(platform)-review"
        let app = open(until: "1 of 4", tag)
        waitForEntryReads(app, tag)
        pageFacts(app, tag)
        tree(app, "\(tag)-top")
        shot("\(platform)-01-review-top")
        let foot = bringFoot(app, tag)
        answerFacts(app, "\(tag)-foot")
        afterFacts(app, "\(tag)-foot")
        note("\(tag)-foot: the note under the answers: \(facts(foot))")
        tree(app, "\(tag)-foot")
        shot("\(platform)-02-card-foot")
    }

    /// 03: a decision's card offers no Amend… and its After row two lines. Next ×3 moves to it, and each move takes the
    /// page back to its top.
    func test2DecisionCardHasNoAmend() throws {
        try XCTSkipIf(platform == "mac", "the decision card is photographed on the iPhone")
        let tag = "iphone-decision"
        let app = open(until: "1 of 4", tag)
        waitForEntryReads(app, tag)
        bringFoot(app, tag)
        let next = button(app, exactly: "Next")
        for step in 1...3 {
            next.tap()
            settle(1.5)
            note("\(tag): after Next ×\(step): pager \(facts(pagerText(app)))")
        }
        XCTAssertTrue(text(app, "==", titles[3]).waitForExistence(timeout: 10), "\(tag): the fourth card never showed")
        let pager = pagerText(app)
        note("\(tag): the page after the moves: pager \(facts(pager)) (at the top it sits at y 177)")
        shot("iphone-03a-decision-top")
        bringFoot(app, tag)
        answerFacts(app, tag)
        afterFacts(app, tag)
        XCTAssertFalse(button(app, exactly: answers[1]).exists, "\(tag): a decision's card offers Amend…")
        XCTAssertTrue(button(app, exactly: answers[0]).exists, "\(tag): no Keep")
        XCTAssertTrue(button(app, exactly: answers[2]).exists, "\(tag): no Retire…")
        tree(app, "\(tag)-foot")
        shot("iphone-03-decision-foot")
    }

    /// 04, 05, 06: Retire… opens the dialog with the challenge's reason; Cancel; then Keep, photographed from the host.
    func test3RetireDialogThenKeep() throws {
        try XCTSkipIf(platform == "mac", "the press is photographed on the iPhone")
        #if os(iOS)
        let tag = "iphone-retire-then-keep"
        let app = open(until: "1 of 4", tag)
        waitForEntryReads(app, tag)
        bringFoot(app, tag)
        answerFacts(app, "\(tag) before")
        let retire = button(app, exactly: answers[2])
        guard retire.exists else { XCTFail("\(tag): no Retire…"); return shot("iphone-04-missing") }
        retire.tap()
        let alert = app.alerts.firstMatch
        guard alert.waitForExistence(timeout: 10) else {
            write(app.debugDescription, "missing-alert-\(tag).txt")
            XCTFail("\(tag): Retire… opened no dialog")
            return shot("iphone-04-retire-dialog")
        }
        settle(1.5)
        dialogFacts(alert, tag)
        let field = alert.textFields.firstMatch
        let filled = (field.value as? String) ?? ""
        note("\(tag): the reason the dialog opened with: \(filled.debugDescription)")
        XCTAssertTrue(filled.hasPrefix(firstReason), "\(tag): the dialog's reason is not the challenge's")
        let writesBefore = decideLines().count
        tree(app, "\(tag)-dialog")
        shot("iphone-04-retire-dialog")
        let cancel = alert.buttons.matching(NSPredicate(format: "label == %@", "Cancel")).firstMatch
        if cancel.exists { cancel.tap() } else { XCTFail("\(tag): the dialog has no Cancel") }
        settle(1.5)
        note("\(tag): after Cancel: a dialog still up: \(app.alerts.firstMatch.exists); decides sent: \(decideLines().count - writesBefore)")
        XCTAssertEqual(decideLines().count, writesBefore, "\(tag): Cancel sent a decide")
        shot("iphone-05-after-cancel")
        press(app, answers[0], capture: "keep", prefix: "iphone-06-keep", toast: "Kept")
        #endif
    }

    /// 07: Retire… confirmed with the reason it was filled in with: the decide carries it as its note.
    func test4RetireConfirmed() throws {
        try XCTSkipIf(platform == "mac", "the press is photographed on the iPhone")
        #if os(iOS)
        let tag = "iphone-retire-confirmed"
        let app = open(until: "1 of 4", tag)
        waitForEntryReads(app, tag)
        bringFoot(app, tag)
        button(app, exactly: answers[2]).tap()
        let alert = app.alerts.firstMatch
        guard alert.waitForExistence(timeout: 10) else {
            XCTFail("\(tag): Retire… opened no dialog")
            return shot("iphone-07-missing")
        }
        settle(1.2)
        let confirm = alert.buttons.matching(NSPredicate(format: "label == %@", "Retire")).firstMatch
        note("\(tag): the dialog's Retire: \(facts(confirm))")
        let running = askCapture("retire")
        note("\(tag): the host's capture \(running ? "was running" : "had NOT started") before the press")
        let t0 = epochMS()
        confirm.tap()
        note("\(tag): Retire tapped at \(t0) ms")
        let toast = toastElement(app)
        let toastShown = toast.waitForExistence(timeout: 8)
        note("\(tag): +\(epochMS() - t0) ms: the toast: \(toastShown ? facts(toast) : "(not in the tree)")")
        shot("iphone-07-retired")
        settle(4)
        note("\(tag): after: pager \(facts(pagerText(app)))")
        shot("iphone-07-retired-after")
        waitCapture("retire")
        let decides = decideLines()
        note("\(tag): the stub's decide lines:\n" + decides.joined(separator: "\n"))
        let retired = requestsLog().split(separator: "\n").filter { $0.contains("stub: retired") }
        note("\(tag): what the stub recorded:\n" + retired.joined(separator: "\n"))
        XCTAssertTrue(decides.contains { $0.contains("\"action\":\"retire\"") && $0.contains("\"note\":\"Wrong as a standing rule.") },
                      "\(tag): the decide did not carry the dialog's reason as its note")
        #endif
    }

    // MARK: steps

    private func open(until words: String, _ tag: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.page", "review", "-probe.fresh",
                               "-ApplePersistenceIgnoreState", "YES", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        if !app.windows.firstMatch.waitForExistence(timeout: 20) {
            note("\(tag): no window after launch; File > New Window")
            app.typeKey("n", modifierFlags: .command)
        }
        #endif
        if !seen(app, words, timeout: 60) {
            write(app.debugDescription, "missing-\(tag).txt")
            XCTFail("\(tag): \(words) never showed — the app did not render the stub's state")
        }
        settle(2)
        return app
    }

    /// The first card's entry has been read once its Keep and Retire… show and Amend… is enabled (disabled until
    /// then). The page reads the other three entries one after another; the iPhone waits for all four in the log.
    private func waitForEntryReads(_ app: XCUIApplication, _ tag: String) {
        let amend = button(app, exactly: answers[1])
        var deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !(amend.exists && amend.isEnabled) { settle(1) }
        if !(amend.exists && amend.isEnabled) { note("\(tag): Amend… never enabled: \(facts(amend))") }
        #if os(iOS)
        deadline = Date().addingTimeInterval(20)
        var missing = entries
        while Date() < deadline {
            let log = requestsLog()
            missing = entries.filter { !log.contains("GET /api/wiki/entries/\($0)") }
            if missing.isEmpty { break }
            settle(1)
        }
        note("\(tag): entry reads not yet in the stub's log: \(missing.isEmpty ? "none" : missing.joined(separator: ", "))")
        #endif
        settle(1)
    }

    private func pageFacts(_ app: XCUIApplication, _ tag: String) {
        note("\(tag): window \(app.windows.firstMatch.frame)")
        note("\(tag): subtitle: \(facts(text(app, "CONTAINS", "proposals from")))")
        note("\(tag): pager: \(facts(pagerText(app)))")
        note("\(tag): challenged line: \(facts(text(app, "BEGINSWITH", "Challenged")))")
        answerFacts(app, tag)
    }

    private func answerFacts(_ app: XCUIApplication, _ tag: String) {
        for label in answers { note("\(tag): \(label): \(facts(button(app, exactly: label)))") }
        let filled = app.buttons.matching(NSPredicate(format: "label == %@", "Re-confirm")).firstMatch
        note("\(tag): an old Re-confirm button: \(filled.exists)")
    }

    /// The After row: its label and one text per answer it describes.
    private func afterFacts(_ app: XCUIApplication, _ tag: String) {
        note("\(tag): After label: \(facts(text(app, "==", "After")))")
        for word in ["Keep · ", "Amend · ", "Retire · "] {
            note("\(tag): After line \(word.debugDescription): \(facts(text(app, "BEGINSWITH", word)))")
        }
    }

    private func dialogFacts(_ alert: XCUIElement, _ tag: String) {
        note("\(tag): dialog: \(facts(alert))")
        for one in alert.staticTexts.allElementsBoundByIndex { note("\(tag): dialog text: \(facts(one))") }
        for one in alert.textFields.allElementsBoundByIndex {
            note("\(tag): dialog field: \(facts(one)) placeholder=\"\(one.placeholderValue ?? "")\"")
        }
        for one in alert.buttons.allElementsBoundByIndex { note("\(tag): dialog button: \(facts(one))") }
    }

    @discardableResult
    private func bringFoot(_ app: XCUIApplication, _ tag: String) -> XCUIElement {
        let foot = text(app, "==", waitsNote)
        let window = app.windows.firstMatch.frame
        #if os(iOS)
        bring(app, foot, between: window.minY + 120, and: window.maxY - 110, missingIsAbove: false, "\(tag)-foot")
        #else
        macBring(app, foot, between: window.minY + 80, and: window.maxY - 24, "\(tag)-foot")
        #endif
        settle(1.2)
        return foot
    }

    #if os(macOS)
    /// The detail column, where Review is, by the wheel. On the CI Mac a wheel unit moves a page about 0.3 pt.
    private func macBring(_ app: XCUIApplication, _ element: XCUIElement, between top: CGFloat, and bottom: CGFloat,
                          _ name: String) {
        let window = app.windows.firstMatch
        for attempt in 1...30 {
            if element.exists, element.frame.minY >= top, element.frame.maxY <= bottom {
                note("\(name): in view after \(attempt - 1) wheel move(s) at \(element.frame)")
                return
            }
            let below = element.exists ? element.frame.maxY > bottom : true
            let pane = window.coordinate(withNormalizedOffset: CGVector(dx: 0.82, dy: 0.5))
            pane.hover()
            pane.scroll(byDeltaX: 0, deltaY: below ? -300 : 100)
            settle(0.8)
        }
        note("\(name): never in the band \(top)–\(bottom); last frame \(element.exists ? "\(element.frame)" : "(missing)")")
        write(app.debugDescription, "missing-band-\(name).txt")
    }
    #endif

    #if os(iOS)
    /// Press an answer where an owner who scrolled to the card's foot finds it, and photograph what follows without
    /// touching the page again: the host's frames (capture.py) from just before the press, XCUITest's own pictures once
    /// its tap returns, then what XCUITest reads: the toast, the pager and the next card's head, and the finger's spot.
    private func press(_ app: XCUIApplication, _ answer: String, capture name: String, prefix: String, toast words: String) {
        let tag = prefix
        bringFoot(app, tag)
        let target = button(app, exactly: answer)
        guard target.exists else {
            XCTFail("\(tag): the card has no \(answer)")
            return shot("\(prefix)-missing")
        }
        let frame = target.frame
        let finger = CGPoint(x: frame.midX, y: frame.midY)
        note("\(tag): the finger: \(finger), the centre of \(answer) \(frame), where XCUITest taps")
        note("\(tag) before: pager: \(facts(pagerText(app)))")
        shot("\(prefix)-0-before")
        let running = askCapture(name)
        note("\(tag): the host's capture \(running ? "was running" : "had NOT started") before the press")
        let t0 = epochMS()
        target.tap()
        let t1 = epochMS()
        note("\(tag): tap() called at \(t0) ms, returned at \(t1) ms (+\(t1 - t0) ms)")
        save(XCUIScreen.main.screenshot().pngRepresentation, String(format: "\(prefix)-xc-%05lldms", epochMS() - t0))
        let toast = toastElement(app)
        let toastLine = toast.exists ? facts(toast) : "(gone before XCUITest looked: see the host's frames)"
        note("\(tag): +\(epochMS() - t0) ms: the toast: \(toastLine)")
        if toast.exists { XCTAssertTrue(toast.label.hasPrefix(words), "\(tag): the toast does not say \(words)") }
        while epochMS() - t0 < 6500 {
            save(XCUIScreen.main.screenshot().pngRepresentation, String(format: "\(prefix)-xc-%05lldms", epochMS() - t0))
        }
        let at = epochMS() - t0
        let pager = pagerText(app)
        note("\(tag): +\(at) ms: pager: \(facts(pager))")
        if pager.exists {
            XCTAssertLessThan(pager.frame.minY, 300, "\(tag): the next card is not shown from the top of the page")
        }
        for (index, title) in titles.enumerated() {
            note("\(tag): +\(at) ms: card \(index + 1)'s title: \(facts(text(app, "==", title)))")
        }
        note("\(tag): +\(at) ms: challenged line: \(facts(text(app, "BEGINSWITH", "Challenged")))")
        var under: [String] = []
        for label in answers {
            let one = button(app, exactly: label)
            if one.exists, one.frame.contains(finger) { under.append(facts(one)) }
            note("\(tag) after: \(label): \(facts(one))")
        }
        let underLine = under.isEmpty ? "no answer button" : under.joined(separator: " | ")
        note("\(tag): under the finger \(finger) after the press: \(underLine)")
        tree(app, "\(tag)-after")
        shot("\(prefix)-9-after")
        waitCapture(name)
        let decides = decideLines()
        note("\(tag): the stub's decide lines:\n" + decides.joined(separator: "\n"))
        if decides.isEmpty { XCTFail("\(tag): the app never sent the decide") }
    }
    #endif

    private func toastElement(_ app: XCUIApplication) -> XCUIElement {
        let words = NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Kept", "Retired")
        #if os(iOS)
        return app.descendants(matching: .any).matching(words).firstMatch
        #else
        return app.staticTexts.matching(words).firstMatch
        #endif
    }

    private func decideLines() -> [String] {
        requestsLog().split(separator: "\n").filter { $0.contains("/decide body:") }.map(String.init)
    }

    // MARK: the host's capture

    private func epochMS() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    /// Ask capture.py for frames and wait until it is taking them.
    private func askCapture(_ name: String) -> Bool {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return false }
        let base = URL(fileURLWithPath: dir)
        try? String(epochMS()).write(to: base.appendingPathComponent("capture-\(name).req"), atomically: true, encoding: .utf8)
        let started = base.appendingPathComponent("capture-\(name).started").path
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if FileManager.default.fileExists(atPath: started) {
                Thread.sleep(forTimeInterval: 0.5)
                return true
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return false
    }

    private func waitCapture(_ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        let done = URL(fileURLWithPath: dir).appendingPathComponent("capture-\(name).done").path
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline, !FileManager.default.fileExists(atPath: done) { Thread.sleep(forTimeInterval: 0.5) }
        note("capture \(name): \(FileManager.default.fileExists(atPath: done) ? "done" : "not done after 45 s")")
    }

    // MARK: finding

    /// Whether these words show within `timeout`, in a text's label (iPhone) or value (Mac, whose `.any` queries time
    /// out once a three-column window is up).
    private func seen(_ app: XCUIApplication, _ words: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if text(app, "CONTAINS", words).exists { return true }
            Thread.sleep(forTimeInterval: 1)
        } while Date() < deadline
        return false
    }

    /// A text by its words: `==`, `CONTAINS` or `BEGINSWITH`.
    private func text(_ app: XCUIApplication, _ comparison: String, _ words: String) -> XCUIElement {
        #if os(iOS)
        return app.staticTexts.matching(NSPredicate(format: "label \(comparison) %@", words)).firstMatch
        #else
        return app.staticTexts.matching(NSPredicate(format: "value \(comparison) %@ OR label \(comparison) %@", words, words)).firstMatch
        #endif
    }

    /// The pager's "1 of 4".
    private func pagerText(_ app: XCUIApplication) -> XCUIElement {
        let pattern = "^[0-9]+ of [0-9]+$"
        #if os(iOS)
        return app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", pattern)).firstMatch
        #else
        return app.staticTexts.matching(NSPredicate(format: "value MATCHES %@ OR label MATCHES %@", pattern, pattern)).firstMatch
        #endif
    }

    private func button(_ app: XCUIApplication, exactly label: String) -> XCUIElement {
        #if os(iOS)
        return app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
        #else
        return app.buttons.matching(NSPredicate(format: "label == %@ OR title == %@", label, label)).firstMatch
        #endif
    }

    /// One element as XCUITest reads it.
    private func facts(_ element: XCUIElement) -> String {
        guard element.exists else { return "(missing)" }
        let value = element.value.map { "\($0)" } ?? ""
        return "type=\(element.elementType.rawValue) label=\"\(element.label)\" title=\"\(element.title)\" "
            + "id=\"\(element.identifier)\" value=\"\(value)\" frame=\(element.frame) enabled=\(element.isEnabled) "
            + "hittable=\(element.isHittable)"
    }
}
