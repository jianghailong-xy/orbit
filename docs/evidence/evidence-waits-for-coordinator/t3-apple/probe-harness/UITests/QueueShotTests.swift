import XCTest

// TEMPORARY evidence probe (never merged): an evidence revision waiting for its paused coordinator, in the
// iPhone app's own coordinator conversation, against .ewc-probe/stub.py
// (docs/mocks/evidence-waits-for-coordinator/phone-queued.png, phone-sheet.png, phone-back.png). Every state
// is reached by the app's own reads and presses: the folded card from the pending read, the sheet from Decide
// it myself, the Sent line from the session row and the pending read the console re-reads once the stub says
// the coordinator is back. A state the app does not reach is a failure, not a note.
final class QueueShotTests: ProbeCase {
    private let heading = "Waiting for the coordinator"
    private let decide = "Decide it myself"
    private let task = "B07c · 卡片增量与会话提醒条"
    private let pauseLine = "Coordinator paused · weekly limit · resets "
    private let queuedNote = "It goes to the coordinator when it’s back. You can still decide now."
    private let openNote = "It gets this when it’s back. Decide here only if you don’t want to wait."
    private let sent = "Sent to the coordinator · "

    /// Launch onto the coordinator conversation with the revision waiting, and wait for its folded card.
    private func open(dark: Bool, _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.session", "C1",
                               "-ApplePersistenceIgnoreState", "YES", "-probe.fresh"] + (dark ? ["-dark"] : [])
        app.launchEnvironment["TZ"] = "Asia/Shanghai"
        app.launch()
        if !appears(app, heading, timeout: 60) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): the folded card never showed — the app did not draw the stub's queue")
        }
        settle(3)
        return app
    }

    private func expectText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for text in words where !containing(app, text).exists {
            write(app.debugDescription, "missing-text-\(name).txt")
            XCTFail("\(name): nothing says \(text)")
        }
    }

    private func expectNoText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for text in words where containing(app, text).exists {
            write(app.debugDescription, "unexpected-text-\(name).txt")
            XCTFail("\(name): something says \(text)")
        }
    }

    /// Every label on screen, for the notes beside the picture.
    private func labels(_ app: XCUIApplication, _ name: String) {
        let texts = app.staticTexts.allElementsBoundByIndex.map(\.label).filter { !$0.isEmpty }
        note("\(name) texts: " + texts.prefix(90).joined(separator: " ¦ "))
        let buttons = app.buttons.allElementsBoundByIndex.map(\.label).filter { !$0.isEmpty }
        note("\(name) buttons: " + buttons.prefix(40).joined(separator: " ¦ "))
    }

    /// The folded card, as the conversation draws it, and nothing counting it.
    private func queued(_ app: XCUIApplication, _ name: String) {
        expectText(app, [heading, task, pauseLine, queuedNote, decide, "Weekly limit reached", "Retrying"], name)
        // Not counted (project 34cygPTQe5LPUT7tdUAzG): no "open question" bar over the transcript, and the
        // header says the coordinator is retrying, not that anything waits for approval.
        expectNoText(app, ["open question", "Waiting for approval", "waiting below", "waiting above"], name)
        // The card is delivered by the read that follows the first paint, and the transcript follows its
        // own rows, not delivered cards: the folded card's last row can sit under the composer. Bring it up
        // the way a reader would, by dragging the transcript, so the whole card is in the picture.
        bring(app, button(app, beginning: decide), between: 120, and: 690, missingIsAbove: false, name)
        settle(1.5)
        labels(app, name)
    }

    /// Decide it myself, and the sheet it opens: today's card, with why it waits on top.
    private func openSheet(_ app: XCUIApplication, _ name: String) -> Bool {
        let button = button(app, beginning: decide)
        guard button.waitForExistence(timeout: 10) else {
            write(app.debugDescription, "missing-decide-\(name).txt")
            XCTFail("\(name): no Decide it myself")
            return false
        }
        note("\(name): \(describe(button))")
        if !button.isHittable { bring(app, button, between: 140, and: 700, missingIsAbove: true, name) }
        button.tap()
        guard appears(app, openNote, timeout: 15) else {
            write(app.debugDescription, "missing-sheet-\(name).txt")
            XCTFail("\(name): the sheet never said \(openNote)")
            return false
        }
        settle(1.5)
        expectText(app, ["Does this evidence settle the task?", pauseLine, "WHAT IT HAS TO SATISFY",
                         "WHAT THIS EVIDENCE DOES NOT ESTABLISH · 9", "Confirm done", "Chat about this",
                         "Your next message is sent back as the reason"], name)
        labels(app, name)
        return true
    }

    private func closeSheet(_ app: XCUIApplication) {
        let close = app.buttons["Close"]
        if close.waitForExistence(timeout: 5) { close.tap() } else { note("no Close button") }
        settle(1.5)
    }

    /// The coordinator comes back and is handed the revision: the app hears it through its own reads —
    /// the session row it lists every 4 s, the pending read the console re-reads every 20 s — and the
    /// folded card becomes the Sent line in its place, above the delivery the coordinator got.
    private func handedOver(_ app: XCUIApplication, suffix: String) {
        setStub("{\"stage\": \"sent\"}")
        if appears(app, "Coordinator is back", timeout: 12) {
            settle(0.5)
            note("back\(suffix): the folded card said the coordinator is back before the read moved it")
            shot("ios-03a-back\(suffix)")
        }
        guard appears(app, sent, timeout: 75) else {
            write(app.debugDescription, "missing-sent\(suffix).txt")
            XCTFail("sent\(suffix): the folded card never became the Sent line")
            return
        }
        guard appears(app, "while you were unavailable", timeout: 20) else {
            write(app.debugDescription, "missing-delivery\(suffix).txt")
            XCTFail("sent\(suffix): the delivery the coordinator got never showed")
            return
        }
        settle(2.5)
        // Closing the sheet took the reader off the live tail, so what arrived since sits below them:
        // follow it with the transcript's own Scroll to latest, as a reader would.
        let latest = app.buttons["Scroll to latest"]
        if latest.exists, latest.isHittable {
            latest.tap()
            settle(2)
        }
        // …and keep the line in the picture if the latest rows pushed it up past the top.
        let pill = containing(app, sent)
        if !pill.exists || pill.frame.minY < 120 {
            bring(app, pill, between: 120, and: 690, missingIsAbove: true, "sent\(suffix)")
            settle(1.5)
        }
        expectNoText(app, [heading, decide, "open question", "Waiting for approval"], "sent\(suffix)")
        let line = containing(app, sent)
        let delivery = containing(app, "while you were unavailable")
        note("sent\(suffix): line \(describe(line))")
        note("sent\(suffix): delivery \(describe(delivery))")
        if line.exists, delivery.exists, line.frame.minY > delivery.frame.minY {
            XCTFail("sent\(suffix): the Sent line is not where the folded card was (above the delivery)")
        }
        labels(app, "sent\(suffix)")
        shot("ios-03-sent\(suffix)")
        tree(app, "sent\(suffix)")
    }

    // MARK: 1 · light: queued, the sheet, handed over

    func test1QueuedSheetAndSentLight() {
        let app = open(dark: false, "queued")
        queued(app, "queued")
        shot("ios-01-queued")
        tree(app, "queued")
        guard openSheet(app, "sheet") else { shot("ios-02-sheet"); return }
        shot("ios-02-sheet")
        tree(app, "sheet")
        closeSheet(app)
        handedOver(app, suffix: "")
    }

    // MARK: 2 · dark: the same three

    func test2QueuedSheetAndSentDark() {
        let app = open(dark: true, "queued-dark")
        queued(app, "queued-dark")
        shot("ios-01-queued-dark")
        guard openSheet(app, "sheet-dark") else { shot("ios-02-sheet-dark"); return }
        shot("ios-02-sheet-dark")
        closeSheet(app)
        handedOver(app, suffix: "-dark")
    }

    // MARK: 3 · deciding from the sheet goes to the door, from this conversation

    func test3ConfirmFromTheSheet() {
        let app = open(dark: false, "decide")
        guard openSheet(app, "decide-sheet") else { return }
        let confirm = button(app, beginning: "Confirm done")
        guard confirm.exists else { XCTFail("decide: no Confirm done"); return }
        confirm.tap()
        guard appears(app, "Decision recorded", timeout: 20) else {
            write(app.debugDescription, "missing-decided.txt")
            XCTFail("decide: no record of the decision")
            return
        }
        // The door's body, field by field (the encoder's key order is its own): from this conversation, on
        // the revision that waited, the owner's CONFIRM.
        let body = requestsLog().components(separatedBy: "\n")
            .first { $0.contains("POST /api/tasks/34dB07cTabletCardsRev01/evidence/decision body:") } ?? ""
        note("decide: \(body)")
        for field in ["\"decidingSessionId\":\"C1\"", "\"evidenceRevision\":\"1\"", "\"decision\":\"CONFIRM\""]
            where !body.contains(field) {
            XCTFail("decide: the door's body has no \(field): \(body)")
        }
        // The sheet leaves with its receipt; the conversation keeps the record, and the folded card is gone.
        settle(4)
        if app.buttons["Close"].exists { closeSheet(app) }
        guard appears(app, "Confirm done · rev 1 · ", timeout: 30) else {
            write(app.debugDescription, "missing-receipt.txt")
            XCTFail("decide: the receipt never showed in the conversation")
            return
        }
        settle(1.5)
        expectNoText(app, [heading, decide], "decided")
        labels(app, "decided")
        shot("ios-04-decided")
        note("requests: " + requestsLog().components(separatedBy: "\n")
            .filter { $0.contains("evidence") }.suffix(12).joined(separator: " | "))
    }
}
