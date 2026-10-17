import XCTest
@testable import OrbitKit

/// The tray above the composer (docs/mocks/steer-tray, decided 2026-10-16): the reader's messages
/// nothing has read yet, out of the conversation until the engine reads them, one row each. Web
/// parity: `PendingTray.tsx`, `Transcript.tsx`'s `UnreadSteer`, `WorkspaceView.tsx`'s `inPendingTray`.
final class PendingTrayTests: XCTestCase {

    // MARK: - a steer waits in the tray until it is read

    private func steer(_ seq: Int, turn: String, text: String = "then push it to main",
                       delivery: String = "written", withdrawable: Bool = true,
                       extra: [String: JSONValue] = [:]) -> RunEvent {
        var payload: [String: JSONValue] = ["text": .string(text), "steer": .bool(true),
                                            "delivery": .string(delivery), "withdrawable": .bool(withdrawable)]
        payload.merge(extra) { _, new in new }
        return RunEvent(seq: seq, type: .user, ts: "2026-10-16T09:4\(seq):00Z", turnId: turn, payload: .object(payload))
    }

    private func delivery(_ seq: Int, turn: String, _ state: String) -> RunEvent {
        RunEvent(seq: seq, type: .userDelivery,
                 payload: .object(["turnId": .string(turn), "delivery": .string(state)]))
    }

    private func said(_ seq: Int, _ text: String) -> RunEvent {
        RunEvent(seq: seq, type: .assistant, payload: .object(["text": .string(text)]))
    }

    private func running() -> TranscriptReducer {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .user, turnId: "t0", payload: .object(["text": .string("fix the export")])))
        return r
    }

    private func userTexts(_ r: TranscriptReducer) -> [String] {
        r.state.items.compactMap(\.asUser).map(\.text)
    }

    func testASteerNothingHasReadWaitsInTheTrayNotTheConversation() {
        var r = running()
        r.apply(steer(2, turn: "t1"))

        XCTAssertEqual(userTexts(r), ["fix the export"])
        XCTAssertEqual(r.state.unreadSteers.map(\.turnId), ["t1"])
        let rows = TranscriptRows.build(state: r.state, statusCards: [], canPageOlder: false, showWorkingIndicator: false)
        XCTAssertFalse(rows.contains { if case .item(.user(let b)) = $0 { return b.turnId == "t1" }; return false })
    }

    func testOnceReadItIsDrawnWhereItWasReadAfterWhatCameBefore() {
        var r = running()
        r.apply(steer(2, turn: "t1"))
        r.apply(said(3, "the suite is still running"))
        r.apply(delivery(4, turn: "t1", "acknowledged"))
        r.apply(said(5, "pushing it to main"))

        XCTAssertTrue(r.state.unreadSteers.isEmpty)
        let order = r.state.items.map { item -> String in
            if let user = item.asUser { return "user:\(user.text)" }
            return "said:\(item.asAssistant?.displayText ?? "")"
        }
        XCTAssertEqual(order, ["user:fix the export", "said:the suite is still running",
                               "user:then push it to main", "said:pushing it to main"])
        XCTAssertEqual(r.state.items[2].asUser?.delivery, "acknowledged")
    }

    func testOneFoundUndeliveredIsDrawnWhereThatBecameKnown() {
        var r = running()
        r.apply(steer(2, turn: "t1"))
        r.apply(delivery(3, turn: "t1", "failed"))

        XCTAssertTrue(r.state.unreadSteers.isEmpty)
        XCTAssertEqual(r.state.items.last?.asUser?.undelivered, true)
    }

    func testOneTheEngineDroppedIsNeverDrawn() {
        var r = running()
        r.apply(steer(2, turn: "t1"))
        r.apply(delivery(3, turn: "t1", "withdrawn"))

        XCTAssertTrue(r.state.unreadSteers.isEmpty)
        XCTAssertEqual(userTexts(r), ["fix the export"])
    }

    func testOneHandedBackRunsAsATurnOfItsOwnAndIsDrawnOnce() {
        var r = running()
        r.apply(steer(2, turn: "t1"))
        r.apply(delivery(3, turn: "t1", "requeued"))
        XCTAssertEqual(r.state.unreadSteers.map(\.delivery), ["requeued"], "queued now, still in the tray")

        r.apply(said(4, "the suite is green"))
        r.apply(RunEvent(seq: 5, type: .user, turnId: "t1",
                         payload: .object(["text": .string("then push it to main"), "delivery": .string("enqueued")])))

        XCTAssertTrue(r.state.unreadSteers.isEmpty)
        XCTAssertEqual(userTexts(r), ["fix the export", "then push it to main"])
        XCTAssertEqual(r.state.items.last?.asUser?.steer, false)
    }

    func testASteerOrbitFiledStaysWhereItsEchoLands() {
        var r = running()
        r.apply(steer(2, turn: "t1", text: "from the other session", extra: [
            "sessionMessage": .object(["fromSessionId": .string("session-2"), "fromTitle": .string("the other session")]),
        ]))
        XCTAssertTrue(r.state.unreadSteers.isEmpty)
        XCTAssertEqual(r.state.items.last?.asUser?.turnId, "t1")
    }

    func testTheRowAQueuedSendDrewIsTheRowItsEchoWaitsIn() {
        var r = running()
        r.addOptimisticUser(clientTurnId: "c1", text: "then push it to main", queued: true)
        r.setOptimisticTurnId(clientTurnId: "c1", turnId: "t1", steer: true)
        let id = r.state.queued[0].id
        r.apply(steer(2, turn: "t1"))

        XCTAssertTrue(r.state.queued.isEmpty)
        XCTAssertEqual(r.state.unreadSteers.map(\.id), [id], "the same row, from Sending… to Waiting to be read")
    }

    func testTheServersReceiptSettlesOneNoRunnerWillSpeakFor() {
        var r = running()
        r.apply(steer(2, turn: "t1"))
        r.reconcileQueuedTurns([
            QueuedTurnInfo(turnId: "t1", kind: "steer", content: "then push it to main", placement: "steer",
                           delivery: "unconfirmed"),
        ], knownBefore: [])

        XCTAssertTrue(r.state.unreadSteers.isEmpty)
        XCTAssertEqual(r.state.items.last?.asUser?.delivery, "unconfirmed")
        XCTAssertTrue(r.state.queued.isEmpty)
    }

    func testAnOlderPageDrawsItsSteersWhereTheyWereSent() {
        var r = TranscriptReducer()
        r.apply(said(10, "the newest reply"))
        r.prependOlder(EventPage(events: [
            RunEvent(seq: 1, type: .user, turnId: "t0", payload: .object(["text": .string("fix the export")])),
            steer(2, turn: "t1"),
        ], hasMore: false))

        XCTAssertTrue(r.state.unreadSteers.isEmpty)
        XCTAssertEqual(userTexts(r), ["fix the export", "then push it to main"])
    }

    func testTheTrayOutlivesASnapshot() throws {
        var r = running()
        r.apply(steer(2, turn: "t1"))
        let restored = try JSONDecoder().decode(TranscriptReducer.self, from: JSONEncoder().encode(r))
        XCTAssertEqual(restored.state.unreadSteers.map(\.turnId), ["t1"])
        // …and a snapshot from before the tray existed rehydrates with nothing in it.
        var older = try JSONSerialization.jsonObject(with: JSONEncoder().encode(r.state)) as! [String: Any]
        older.removeValue(forKey: "unreadSteers")
        let state = try JSONDecoder().decode(TranscriptState.self, from: JSONSerialization.data(withJSONObject: older))
        XCTAssertTrue(state.unreadSteers.isEmpty)
    }

    // MARK: - the rows

    private func queuedBubble(_ id: String, text: String, steer: Bool = false, shell: Bool = false,
                              ts: String? = nil, turnId: String? = nil) -> UserBubble {
        UserBubble(id: id, text: text, ts: ts, turnId: turnId ?? "turn-\(id)", pending: true, queued: true,
                   steer: steer, shell: shell)
    }

    func testEachRowSaysWhereItIsGoingHowItStandsAndOffersOnlyWhatItCanDo() {
        var state = TranscriptState()
        state.unreadSteers = [
            // Claude: in its queue, and its runner said it can drop it unread.
            UserBubble(id: "a", text: "then push it to main", ts: "2026-10-16T09:41:00Z", turnId: "ta",
                       pending: false, steer: true, delivery: "written", withdrawable: true),
            // Codex: has it, and cannot give it back.
            UserBubble(id: "b", text: "use the other endpoint", ts: "2026-10-16T09:42:00Z", turnId: "tb",
                       pending: false, steer: true, delivery: "written", withdrawable: false),
        ]
        state.queued = [
            queuedBubble("c", text: "and update the changelog", ts: "2026-10-16T09:43:00Z"),
            queuedBubble("d", text: "npm test", shell: true, ts: "2026-10-16T09:44:00Z"),
            // Filed as a steer, no runner has taken it yet.
            queuedBubble("e", text: "and tag the release", steer: true, ts: "2026-10-16T09:45:00Z"),
        ]

        let rows = PendingTray.rows(state: state, withdrawing: [], steering: [], steerOffered: true)
        XCTAssertEqual(rows.map(\.id), ["a", "b", "c", "d", "e"])
        XCTAssertEqual(rows.map(\.heading), [.currentTurn, .currentTurn, .nextTurn, .nextTurn, .currentTurn])
        XCTAssertEqual(rows.map(\.state), ["Waiting to be read", "Waiting to be read", "Queued for next turn",
                                           "Queued for next turn", "Sending…"])
        XCTAssertEqual(rows.map(\.offersWithdraw), [true, false, true, true, true])
        XCTAssertEqual(rows.map(\.offersSteer), [false, false, true, false, false])
        XCTAssertEqual(rows[3].text, "!npm test")

        // Steer is offered only while a turn runs on an engine that can take a message into one.
        XCTAssertFalse(PendingTray.rows(state: state, withdrawing: [], steering: [], steerOffered: false)
            .contains(where: \.offersSteer))
    }

    func testARowAPressIsOutForOffersNothingToPressTwice() {
        var state = TranscriptState()
        state.unreadSteers = [UserBubble(id: "a", text: "then push it to main", turnId: "ta", pending: false,
                                         steer: true, delivery: "written", withdrawable: true)]
        state.queued = [queuedBubble("c", text: "and update the changelog")]

        let rows = PendingTray.rows(state: state, withdrawing: ["ta"], steering: ["turn-c"], steerOffered: true)
        XCTAssertEqual(rows.map(\.state), ["Withdrawing…", "Sending…"])
        XCTAssertEqual(rows.map(\.heading), [.currentTurn, .currentTurn])
        XCTAssertEqual(rows.map(\.busy), [true, true])
        XCTAssertFalse(rows.contains { $0.offersWithdraw || $0.offersSteer })
    }

    func testAHandedBackSteerIsQueuedWithNothingToPress() {
        var state = TranscriptState()
        state.unreadSteers = [UserBubble(id: "a", text: "then push it to main", turnId: "ta", pending: false,
                                         steer: true, delivery: "requeued", withdrawable: true)]
        let row = PendingTray.rows(state: state, withdrawing: [], steering: [], steerOffered: true)[0]
        XCTAssertEqual(row.heading, .nextTurn)
        XCTAssertEqual(row.state, "Queued for next turn")
        XCTAssertFalse(row.offersWithdraw || row.offersSteer)
    }

    func testTheTrayHoldsOnlyTheReadersOwnWordsStillOnTheirWay() {
        XCTAssertTrue(PendingTray.holds(queuedBubble("a", text: "and update the changelog")))
        var orbit = queuedBubble("b", text: "a brief")
        orbit.authoredByOrbit = true
        XCTAssertFalse(PendingTray.holds(orbit))
        var failed = queuedBubble("c", text: "never made it", steer: true)
        failed.undelivered = true
        XCTAssertFalse(PendingTray.holds(failed), "a message that settled undelivered stays in the conversation")

        var state = TranscriptState()
        state.queued = [queuedBubble("a", text: "and update the changelog"), orbit]
        let rows = TranscriptRows.build(state: state, statusCards: [], canPageOlder: false, showWorkingIndicator: false)
        XCTAssertEqual(rows.compactMap { if case .queued(let b) = $0 { return b.id }; return nil }, ["b"],
                       "what Orbit queued keeps its card in the tail; the reader's message is the tray's")
    }

    func testARowOfAttachmentsAloneSaysWhatItCarries() {
        XCTAssertEqual(PendingTray.summary(images: 1, files: 0), "1 image")
        XCTAssertEqual(PendingTray.summary(images: 2, files: 1), "2 images, 1 file")
        let bubble = UserBubble(id: "a", text: "", attachments: [TurnAttachment(id: "i1", mime: "image/png")],
                                turnId: "ta", pending: true, queued: true)
        XCTAssertEqual(PendingTray.text(of: bubble), "1 image")
    }

    // MARK: - sent the other way

    func testQueueingForTheNextTurnSaysSoAndASendOtherwiseLeavesItToTheServer() throws {
        let queued = ComposerLogic.makeTurn(clientTurnId: "c1", text: "then push", shell: false, attachmentIds: [],
                                            queueForNextTurn: true)
        XCTAssertEqual(queued.intent, "NEXT_TURN")
        let plain = ComposerLogic.makeTurn(clientTurnId: "c2", text: "then push", shell: false, attachmentIds: [])
        XCTAssertNil(plain.intent)
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plain)) as! [String: Any]
        XCTAssertNil(body["intent"], "no intent goes out unless asked for")
    }

    func testOnlyTheRuntimesThatTakeAMessageMidTurnOfferSteer() {
        XCTAssertTrue(SteerDelivery.runtimeTakesMidTurnSteer("claude"))
        XCTAssertTrue(SteerDelivery.runtimeTakesMidTurnSteer("codex"))
        for runtime in ["kimi", "dsh", "opencode", "antigravity"] {
            XCTAssertFalse(SteerDelivery.runtimeTakesMidTurnSteer(runtime), runtime)
        }
    }
}
