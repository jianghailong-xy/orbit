import XCTest

// TEMPORARY evidence probe (see ../README.md). Project P1's page — "Runner hardening" — on the iPhone
// and on the Mac, against stub.py: the crossings card with a request to move a task into this project,
// its second step, the move confirmed through the real controls — which sends the real
// `POST /api/projects/P1/handoffs/X1/decision` with the crossing key — and the row read back moved;
// then a confirmation the door refuses (its task is being landed), shown with the door's code and
// reason, and the second step of a refusal, cancelled.
final class CrossingsShotTests: ProbeCase {
    private let card = "Cross-project crossings"
    private let moveQuestion =
        "Approve moving “Wire the drain watchdog” from Coordinator control loop to Runner hardening?"
    private let moveConsequence =
        "Confirming is the move: the task joins the target project as soon as you answer, and nobody has to send the request again."
    private let moved = "the task was moved when this request was confirmed"
    private let landingQuestion =
        "Approve moving “Pin the runner image digest” from Runner hardening to Release train?"
    private let refuseQuestion =
        "Refuse moving “Pin the runner image digest” from Runner hardening to Release train?"
    private let moveKey = String(repeating: "8f3c1d2e", count: 8)

    #if os(iOS)
    func testIPhoneConfirmsAMoveInTwoPresses() {
        drive("ios", bottom: 780)
    }
    #endif

    #if os(macOS)
    func testMacConfirmsAMoveInTwoPresses() {
        drive("mac", bottom: 660)
    }
    #endif

    /// Buttons labelled exactly this, top-most first — the crossings' questions lead, oldest first.
    private func exactly(_ app: XCUIApplication, _ label: String) -> [XCUIElement] {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
            .filter { $0.exists }
            .sorted { $0.frame.minY < $1.frame.minY }
    }

    private func picture(_ app: XCUIApplication, _ name: String) {
        settle(1.2)
        shot(app, name)
        write(app.debugDescription, "tree-\(name).txt")
    }

    private func drive(_ p: String, bottom: CGFloat) {
        let app = launch(until: "Runner hardening", "\(p)-page")
        // The card is the page's last section: bring its head up, so the first row under it — the
        // oldest question, the move into this project — fills the screen below.
        bring(app, element(app, containing: card), between: 70, and: 260, "\(p)-card")
        guard appears(app, "Wire the drain watchdog", timeout: 20) else {
            write(app.debugDescription, "missing-\(p)-card.txt")
            return XCTFail("the crossings card never listed the move into this project")
        }
        for words in ["MOVE_TASK", "Waiting for your answer", "Task to move:", "Coordinator control loop",
                      "the task stays in its project until you answer, and confirming moves it",
                      "Target criterion requested: A wedged drain restarts within a minute.",
                      "Reason given: the watchdog belongs to the runner goal", "3 waiting"]
        where !appears(app, words, timeout: 3) {
            XCTFail("the card does not say \(words)")
        }
        picture(app, "\(p)-1-move-request")

        // First press: it only asks.
        guard let ask = exactly(app, "Approve…").first else {
            write(app.debugDescription, "missing-\(p)-approve.txt")
            return XCTFail("the move offered no Approve…")
        }
        bring(app, ask, between: 120, and: bottom, "\(p)-approve")
        press(ask)
        guard appears(app, moveQuestion, timeout: 10) else {
            write(app.debugDescription, "missing-\(p)-question.txt")
            return XCTFail("Approve… did not ask the second question")
        }
        bring(app, element(app, containing: moveQuestion), between: 110, and: 460, "\(p)-question")
        for words in [moveConsequence, "Crossing", String(moveKey.prefix(12))] where !appears(app, words, timeout: 3) {
            XCTFail("the second step does not say \(words)")
        }
        XCTAssertFalse(requestsLog().contains("POST /api/projects/P1/handoffs"), "nothing is answered by the first press")
        picture(app, "\(p)-2-second-step")

        // Second press: the answer, with the crossing key it was given on.
        guard let yes = exactly(app, "Yes, approve").first else {
            write(app.debugDescription, "missing-\(p)-yes.txt")
            return XCTFail("the second step had no Yes, approve")
        }
        bring(app, yes, between: 120, and: bottom, "\(p)-yes")
        press(yes)
        guard appears(app, moved, timeout: 20) else {
            write(app.debugDescription, "missing-\(p)-moved.txt")
            return XCTFail("the confirmed move never read back as moved")
        }
        bring(app, element(app, containing: moved), between: 140, and: 520, "\(p)-moved")
        picture(app, "\(p)-3-moved")
        let log = requestsLog()
        XCTAssertTrue(log.contains("\"POST /api/projects/P1/handoffs/X1/decision HTTP/1.1\" 201"),
                      "the app never confirmed the move at the decision door")
        XCTAssertTrue(log.contains("BODY /api/projects/P1/handoffs/X1/decision {\"decision\":\"APPROVE\",\"acknowledgedCrossingKey\":\"\(moveKey)\"}")
                      || log.contains("BODY /api/projects/P1/handoffs/X1/decision {\"acknowledgedCrossingKey\":\"\(moveKey)\",\"decision\":\"APPROVE\"}"),
                      "the answer did not carry the decision and the crossing key")
        note("after the move: 4 tasks shown = \(appears(app, "4 tasks", timeout: 5))")

        // A confirmation the door refuses: the task is being landed. The reason is the door's own,
        // and the second step stays open.
        bring(app, element(app, containing: card), between: 70, and: 260, "\(p)-card-again")
        guard let askLanding = exactly(app, "Approve…").first else {
            write(app.debugDescription, "missing-\(p)-approve-2.txt")
            return XCTFail("the second move offered no Approve…")
        }
        press(askLanding)
        guard appears(app, landingQuestion, timeout: 10), let yesLanding = exactly(app, "Yes, approve").first else {
            write(app.debugDescription, "missing-\(p)-question-2.txt")
            return XCTFail("the second move's Approve… did not ask")
        }
        bring(app, yesLanding, between: 120, and: bottom, "\(p)-yes-2")
        press(yesLanding)
        guard appears(app, "That answer was not recorded", timeout: 15) else {
            write(app.debugDescription, "missing-\(p)-refused.txt")
            return XCTFail("a refused confirmation said nothing")
        }
        bring(app, element(app, containing: "That answer was not recorded"), between: 110, and: 420, "\(p)-refused")
        for words in ["MOVE_TASK_LANDING_IN_FLIGHT", "the request is still waiting", landingQuestion]
        where !appears(app, words, timeout: 3) {
            XCTFail("the refusal does not say \(words)")
        }
        picture(app, "\(p)-4-refused")

        // The second step of a refusal, read and cancelled: nothing is sent.
        if let cancel = exactly(app, "Cancel").first { press(cancel) }
        settle(1)
        if let refuse = exactly(app, "Refuse…").first {
            bring(app, refuse, between: 120, and: bottom, "\(p)-refuse")
            press(refuse)
            if appears(app, refuseQuestion, timeout: 10) {
                bring(app, element(app, containing: refuseQuestion), between: 110, and: 460, "\(p)-refuse-question")
                picture(app, "\(p)-5-refuse-step")
            } else {
                XCTFail("Refuse… did not ask the second question")
            }
            if let cancel = exactly(app, "Cancel").first { press(cancel) }
        } else {
            XCTFail("no Refuse… on the second move")
        }
        settle(1)
        let after = requestsLog()
        XCTAssertFalse(after.contains("\"decision\":\"DENY\""), "a cancelled refusal sent nothing")
        write(after.components(separatedBy: "\n").filter { $0.contains("handoffs") }.joined(separator: "\n"),
              "\(p)-crossing-requests.txt")
    }
}
