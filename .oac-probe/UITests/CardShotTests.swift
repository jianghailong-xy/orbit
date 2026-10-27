import XCTest

// TEMPORARY evidence probe (never merged): the turn that hands the owner's answer to the coordinator, in the
// iPhone app's own coordinator conversation, against .oac-probe/stub.py (task 34nGWN2Poh34ku8ad93Ud,
// docs/mocks/owner-answer-sent-card/merged.html and tone.html). Each launch opens one conversation. Where the
// conversation holds the question's record, the turn is that one grey Answered card — dashed with its line and
// no Cancel while queued, saying so when unconfirmed — and its View details sheet folds the words the
// coordinator was told; a Not yet… and a question the conversation holds no record of keep the line. What the
// app does not draw that way is a failure, not a note.
final class CardShotTests: ProbeCase {
    private let sent = "Sent to the coordinator"
    private let answer = "批准三条"
    private let viewDetails = "View details"
    private let queuedLine = "Queued — the coordinator reads it when its current turn ends"
    private let unconfirmed = "The session has not confirmed it received this."
    private let toldHeading = "What the coordinator was told"
    private let toldWords = "From Orbit · owner answer: you asked"
    private let asked = "问题已经发出"
    private let reply = "收到：批准三条"

    /// Launch onto one conversation and wait for `words`, in the zone the stub's day is in (run.sh). en_GB is
    /// a 24-hour English locale.
    private func open(_ session: String, until words: String, _ name: String, dark: Bool = false) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.session", session,
                               "-ApplePersistenceIgnoreState", "YES", "-probe.fresh",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_GB"] + (dark ? ["-dark"] : [])
        app.launchEnvironment["TZ"] = ProcessInfo.processInfo.environment["PROBE_TZ"] ?? "Asia/Shanghai"
        app.launch()
        if !appears(app, words, timeout: 60) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(words) never showed — the app did not draw the stub's conversation")
        }
        settle(3)
        return app
    }

    /// The answered question's cards: each is one button, View details and all.
    private func cards(_ app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", viewDetails, answer))
    }

    /// The one card — a failure if there is none, or more than one.
    private func oneCard(_ app: XCUIApplication, _ name: String) -> XCUIElement? {
        guard cards(app).firstMatch.waitForExistence(timeout: 20) else {
            write(app.debugDescription, "missing-card-\(name).txt")
            XCTFail("\(name): no Answered card")
            return nil
        }
        let all = cards(app).allElementsBoundByIndex
        note("\(name): \(all.count) card(s): " + all.map(describe).joined(separator: " | "))
        if all.count != 1 { XCTFail("\(name): \(all.count) Answered cards, not one") }
        return all.first
    }

    /// The line: a button whose words begin with "Sent to the coordinator".
    private func lines(_ app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", sent))
    }

    private func expectNoLine(_ app: XCUIApplication, _ name: String) {
        if lines(app).firstMatch.exists {
            write(app.debugDescription, "unexpected-line-\(name).txt")
            XCTFail("\(name): the conversation still draws \(sent)")
        }
    }

    private func expectNoCancel(_ app: XCUIApplication, _ name: String) {
        if app.buttons.matching(NSPredicate(format: "label == %@", "Cancel")).firstMatch.exists {
            write(app.debugDescription, "unexpected-cancel-\(name).txt")
            XCTFail("\(name): a Cancel is offered for an answer already given")
        }
    }

    /// Wait until the app has read the project's open items — the read the card is drawn from — so a
    /// line seen after it is the line, not the moment before the read came back.
    private func waitForOpenItems(_ project: String, _ name: String) {
        let deadline = Date().addingTimeInterval(20)
        while !requestsLog().contains("/api/projects/\(project)/open-items"), Date() < deadline { settle(1) }
        if !requestsLog().contains("/api/projects/\(project)/open-items") {
            XCTFail("\(name): the app never read \(project)'s open items")
        }
        settle(2)
    }

    /// A text on screen whose label holds these words, other than a button.
    private func onScreen(_ app: XCUIApplication, _ words: String) -> XCUIElement? {
        let window = app.windows.firstMatch.frame
        return app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words))
            .allElementsBoundByIndex
            .first { $0.elementType != .button && window.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) }
    }

    /// The card sits under the coordinator's message that asked and over its reply: where the turn that
    /// told the coordinator is, which is where the line used to be.
    private func expectBetweenTheQuestionAndTheReply(_ app: XCUIApplication, _ card: XCUIElement, _ name: String) {
        guard let above = onScreen(app, asked), let below = onScreen(app, reply) else {
            write(app.debugDescription, "missing-neighbours-\(name).txt")
            XCTFail("\(name): \(asked) or \(reply) is not on screen to place the card against")
            return
        }
        note("\(name): above \(describe(above)) | card \(describe(card)) | below \(describe(below))")
        XCTAssertLessThan(above.frame.minY, card.frame.minY, "\(name): the card is not under the message that asked")
        XCTAssertLessThan(card.frame.minY, below.frame.minY, "\(name): the card is not over the coordinator's reply")
    }

    private func expectText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for text in words where !containing(app, text).exists {
            write(app.debugDescription, "missing-text-\(name).txt")
            XCTFail("\(name): nothing says \(text)")
        }
    }

    /// Every label on screen, for the notes beside the picture.
    private func labels(_ app: XCUIApplication, _ name: String) {
        let texts = app.staticTexts.allElementsBoundByIndex.map(\.label).filter { !$0.isEmpty }
        note("\(name) texts: " + texts.prefix(80).joined(separator: " ¦ "))
        let buttons = app.buttons.allElementsBoundByIndex.map(\.label).filter { !$0.isEmpty }
        note("\(name) buttons: " + buttons.prefix(40).joined(separator: " ¦ "))
    }

    // MARK: 1 · the coordinator was idle: one grey Answered card, where the line used to be

    func test1OneGreyCardWhereTheLineWas() {
        let app = open("C1", until: reply, "one-card")
        guard let card = oneCard(app, "one-card") else { shot("ios-1-one-card"); return }
        expectNoLine(app, "one-card")
        XCTAssertTrue(card.label.contains("Answered"), "one-card: the card says \(card.label)")
        for words in [queuedLine, unconfirmed] where card.label.contains(words) {
            XCTFail("one-card: the delivered card says \(words)")
        }
        expectBetweenTheQuestionAndTheReply(app, card, "one-card")
        labels(app, "one-card")
        shot("ios-1-one-card")
        shot(card, "ios-1b-the-card")
        tree(app, "one-card")
    }

    // MARK: 2 · the coordinator was busy: the card waits on the queue, dashed, saying so, with no Cancel

    func test2TheQueuedCardIsDashedAndSaysSo() {
        let app = open("C3", until: queuedLine, "queued")
        guard let card = oneCard(app, "queued") else { shot("ios-2-queued"); return }
        XCTAssertTrue(card.label.contains(queuedLine), "queued: the card says \(card.label)")
        expectNoLine(app, "queued")
        expectNoCancel(app, "queued")
        if !card.isHittable { bring(app, card, between: 140, and: 760, missingIsAbove: false, "queued") }
        labels(app, "queued")
        shot("ios-2-queued")
        shot(card, "ios-2b-the-queued-card")
        tree(app, "queued")
    }

    // MARK: 3 · View details: the question and its options, then the words the coordinator was told, folded

    func test3TheWordsTheCoordinatorWasToldAreInsideViewDetails() {
        let app = open("C1", until: reply, "details")
        guard let card = oneCard(app, "details") else { shot("ios-3-details"); return }
        if !card.isHittable { bring(app, card, between: 140, and: 700, missingIsAbove: true, "details-card") }
        card.tap()
        guard appears(app, "Answered by you", timeout: 15) else {
            write(app.debugDescription, "missing-sheet-details.txt")
            XCTFail("details: View details opened no sheet saying Answered by you")
            shot("ios-3-details")
            return
        }
        settle(1.5)
        expectText(app, ["FROM COORDINATOR", "asked 11:20", "只批准 ①", "先不动", "Recommended",
                         "Answered by you · 11:52", "Delivered to the current coordinator"], "details")
        let fold = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", toldHeading)).firstMatch
        guard fold.waitForExistence(timeout: 10) else {
            write(app.debugDescription, "missing-fold-details.txt")
            XCTFail("details: the sheet has no \(toldHeading)")
            shot("ios-3-details")
            return
        }
        if containing(app, toldWords).exists { XCTFail("details: the words show before the fold is opened") }
        labels(app, "details-folded")
        shot("ios-3a-details-folded")
        if !fold.isHittable { bring(app, fold, between: 140, and: 600, missingIsAbove: false, "details-fold") }
        fold.tap()
        guard appears(app, toldWords, timeout: 10) else {
            write(app.debugDescription, "missing-told-details.txt")
            XCTFail("details: opening \(toldHeading) showed no words")
            shot("ios-3-details")
            return
        }
        settle(1)
        bring(app, containing(app, toldWords), between: 120, and: 680, missingIsAbove: false, "details-words")
        expectText(app, ["The owner answered: 批准三条"], "details")
        labels(app, "details")
        shot("ios-3-details")
        tree(app, "details")
    }

    // MARK: 4 · a Not yet… to the request to record the project done has no card: the line stays

    func test4ANotYetKeepsTheLine() {
        let app = open("C2", until: sent, "not-yet")
        waitForOpenItems("P2", "not-yet")
        XCTAssertTrue(lines(app).firstMatch.exists, "not-yet: no \(sent) line")
        if app.buttons.matching(NSPredicate(format: "label CONTAINS %@", viewDetails)).firstMatch.exists {
            XCTFail("not-yet: a card where the line should be")
        }
        note("not-yet: line \(describe(lines(app).firstMatch))")
        shot("ios-4-not-yet-line")
    }

    // MARK: 5 · a question whose record the conversation does not hold: the line stays

    func test5AQuestionWithNoRecordKeepsTheLine() {
        let app = open("C4", until: sent, "unheld")
        waitForOpenItems("P4", "unheld")
        XCTAssertTrue(lines(app).firstMatch.exists, "unheld: no \(sent) line")
        if cards(app).firstMatch.exists { XCTFail("unheld: a card drawn from a record the read does not carry") }
        note("unheld: line \(describe(lines(app).firstMatch))")
        shot("ios-5-unheld-line")
    }

    // MARK: 6 · the session has not confirmed it received the answer: the card says so

    func test6AnUnconfirmedAnswerSaysSo() {
        let app = open("C5", until: unconfirmed, "unconfirmed")
        guard let card = oneCard(app, "unconfirmed") else { shot("ios-6-unconfirmed"); return }
        XCTAssertTrue(card.label.contains(unconfirmed), "unconfirmed: the card says \(card.label)")
        XCTAssertFalse(card.label.contains(queuedLine), "unconfirmed: the card says it is queued")
        expectNoLine(app, "unconfirmed")
        expectNoCancel(app, "unconfirmed")
        labels(app, "unconfirmed")
        shot("ios-6-unconfirmed")
    }

    // MARK: 7 · the same card in the dark

    func test7OneCardInTheDark() {
        let app = open("C1", until: reply, "dark", dark: true)
        guard oneCard(app, "dark") != nil else { shot("ios-7-one-card-dark"); return }
        expectNoLine(app, "dark")
        shot("ios-7-one-card-dark")
    }
}
