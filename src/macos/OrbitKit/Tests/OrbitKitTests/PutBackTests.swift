import XCTest
@testable import OrbitKit

/// A message that never reached the engine, and the way its words come back to the composer
/// (docs/mocks/put-back-ios, decided 2026-10-17). The server's receipt for a steer no runner ever echoed is drawn at
/// the tail with why it did not land; "Put back in the composer" is offered under every message the
/// reader typed that never arrived. Web parity: `Transcript.tsx`'s `UserBubble`, `WorkspaceView.tsx`'s
/// `QueuedTurnMeta` and `takeBackUndelivered`, `steerDelivery.ts`'s `deliveryFailureExplanation`.
final class PutBackTests: XCTestCase {

    private func running() -> TranscriptReducer {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .user, turnId: "t0", payload: .object(["text": .string("fix the export")])))
        return r
    }

    private func receipt(_ turn: String, _ words: String = "英文版也要，放在同一个目录", delivery: String = "failed",
                         code: String? = "CURRENT_WORK_TARGET_COMPLETED", authoredByOrbit: Bool? = nil) -> QueuedTurnInfo {
        QueuedTurnInfo(turnId: turn, kind: "steer", content: words, authoredByOrbit: authoredByOrbit,
                       placement: "steer", createdAt: "2026-10-17T03:00:00Z", delivery: delivery,
                       deliveryCode: code, deliveryReason: "the target turn completed before CURRENT_WORK could be delivered")
    }

    private func tail(_ r: TranscriptReducer) -> [UserBubble] {
        TranscriptRows.build(state: r.state, statusCards: [], canPageOlder: false, showWorkingIndicator: false)
            .compactMap { row in if case .queued(let b) = row { return b }; return nil }
    }

    // MARK: - the receipt is drawn

    func testAReceiptAloneIsDrawnAtTheTailAfterWhatStillWaitsWithWhy() throws {
        var r = running()
        r.reconcileQueuedTurns([
            receipt("t9"),
            QueuedTurnInfo(turnId: "t2", kind: "message", content: "and write the notes", placement: "queued"),
        ], knownBefore: [])

        XCTAssertEqual(r.state.queued.map(\.turnId), ["t2", "t9"], "after everything still waiting")
        let row = try XCTUnwrap(r.state.queued.last)
        XCTAssertTrue(row.receipt)
        XCTAssertTrue(row.undelivered)
        XCTAssertFalse(row.pending)
        XCTAssertEqual(row.delivery, "failed")
        XCTAssertEqual(row.text, "英文版也要，放在同一个目录")
        XCTAssertEqual(SteerDelivery.failureExplanation(code: row.deliveryCode, reason: row.deliveryReason),
                       "The turn finished before it was read.")
        XCTAssertFalse(PendingTray.holds(row), "it has an outcome: not the tray's")
        XCTAssertTrue(SteerDelivery.offersPutBack(row))
        XCTAssertEqual(tail(r).last?.turnId, "t9", "the tail draws it")
    }

    func testAnUnconfirmedReceiptIsDrawnAndOffersPutBackButWasNotFailed() throws {
        var r = running()
        r.reconcileQueuedTurns([receipt("t9", delivery: "unconfirmed", code: nil)], knownBefore: [])

        let row = try XCTUnwrap(r.state.queued.first)
        XCTAssertTrue(row.receipt)
        XCTAssertFalse(row.undelivered)
        XCTAssertEqual(SteerDelivery.state(row.delivery).tone, .failed, "said in the warning tone")
        XCTAssertTrue(SteerDelivery.offersPutBack(row))
        XCTAssertEqual(SteerDelivery.failureExplanation(code: row.deliveryCode, reason: row.deliveryReason),
                       row.deliveryReason, "no code these words cover: the receipt's own reason")
    }

    func testWhatOrbitFiledStaysOutOfSight() {
        var r = running()
        r.reconcileQueuedTurns([receipt("t9", "[Background job finished]", authoredByOrbit: true)], knownBefore: [])
        XCTAssertTrue(r.state.queued.isEmpty)
    }

    func testAReceiptForAMessageTheConversationDrawsIsNotDrawnTwice() {
        var r = running()
        r.apply(RunEvent(seq: 2, type: .user, turnId: "t9", payload: .object([
            "text": .string("英文版也要，放在同一个目录"), "steer": .bool(true), "delivery": .string("failed"),
        ])))
        r.reconcileQueuedTurns([receipt("t9")], knownBefore: [])

        XCTAssertTrue(r.state.queued.isEmpty, "its echo says how it came out")
        XCTAssertEqual(r.state.items.compactMap(\.asUser).filter { $0.turnId == "t9" }.count, 1)
    }

    func testAReceiptThatSettlesASteerInTheTrayIsNotDrawnTwice() {
        var r = running()
        r.apply(RunEvent(seq: 2, type: .user, turnId: "t9", payload: .object([
            "text": .string("英文版也要"), "steer": .bool(true), "delivery": .string("written"),
        ])))
        XCTAssertEqual(r.state.unreadSteers.map(\.turnId), ["t9"])
        r.reconcileQueuedTurns([receipt("t9")], knownBefore: [])

        XCTAssertTrue(r.state.unreadSteers.isEmpty)
        XCTAssertEqual(r.state.items.last?.asUser?.turnId, "t9", "settled into the conversation")
        XCTAssertTrue(r.state.queued.isEmpty, "and not drawn again at the tail")
    }

    func testAPlaceholderARunnerMarkedFailedKeepsItsRowWhenItsReceiptIsListed() {
        var r = running()
        r.addOptimisticUser(clientTurnId: "c1", text: "英文版也要", queued: true)
        r.setOptimisticTurnId(clientTurnId: "c1", turnId: "t9", steer: true)
        let id = r.state.queued[0].id
        r.apply(RunEvent(seq: 2, type: .userDelivery, payload: .object([
            "turnId": .string("t9"), "delivery": .string("failed"), "reason": .string("no turn to steer into"),
        ])))
        XCTAssertTrue(r.state.queued[0].undelivered)

        r.reconcileQueuedTurns([receipt("t9", "英文版也要")], knownBefore: ["t9"])
        XCTAssertEqual(r.state.queued.map(\.id), [id], "the same row, now the receipt's")
        XCTAssertTrue(r.state.queued[0].receipt)
    }

    // MARK: - who offers Put back

    func testPutBackIsForWordsTheReaderTypedThatNeverArrived() {
        let failed = UserBubble(id: "a", text: "英文版也要", turnId: "t1", pending: false, undelivered: true,
                                steer: true, delivery: "failed")
        XCTAssertTrue(SteerDelivery.offersPutBack(failed))

        let drained = UserBubble(id: "b", text: "and write the notes", turnId: "t2", pending: false, undelivered: true)
        XCTAssertTrue(SteerDelivery.offersPutBack(drained), "drained unrun when the run ended")

        let unconfirmed = UserBubble(id: "c", text: "英文版也要", turnId: "t3", pending: false,
                                     steer: true, delivery: "unconfirmed")
        XCTAssertFalse(SteerDelivery.offersPutBack(unconfirmed), "it may have been acted on")

        let read = UserBubble(id: "d", text: "好，导出一份给我", turnId: "t4", pending: false,
                              steer: true, delivery: "acknowledged")
        XCTAssertFalse(SteerDelivery.offersPutBack(read))

        let orbits = UserBubble(id: "e", text: "[Background job finished]", turnId: "t5", pending: false,
                                undelivered: true, authoredByOrbit: true)
        XCTAssertFalse(SteerDelivery.offersPutBack(orbits), "nobody typed it")

        let picturesAlone = UserBubble(id: "f", text: "", turnId: "t6", pending: false, undelivered: true)
        XCTAssertFalse(SteerDelivery.offersPutBack(picturesAlone), "no words to put back")
    }

    // MARK: - why, in the sender's words

    func testEachCodeIsSaidInTheSendersWords() {
        let words: [String: String] = [
            "CURRENT_WORK_TARGET_COMPLETED": "The turn finished before it was read.",
            "CURRENT_WORK_INTERRUPTED": "The turn was interrupted before it was read.",
            "CURRENT_WORK_SESSION_ENDED": "The session ended before it was read.",
            "CURRENT_WORK_SESSION_FINALIZED": "The session ended before it was read.",
            "CURRENT_WORK_SESSION_REAPED": "The runner disappeared while it was being delivered.",
            "CURRENT_WORK_RUNTIME_REJECTED": "The engine rejected it.",
        ]
        for (code, said) in words {
            XCTAssertEqual(SteerDelivery.failureExplanation(code: code, reason: "raw"), said, code)
        }
        XCTAssertEqual(SteerDelivery.failureExplanation(code: "SOMETHING_NEW", reason: "the server's reason"),
                       "the server's reason")
        XCTAssertNil(SteerDelivery.failureExplanation(code: nil, reason: nil))
    }

    // MARK: - snapshots

    func testABubbleFromBeforeReceiptsStillDecodes() throws {
        let old = #"{"id":"a","text":"hi","pending":false}"#.data(using: .utf8)!
        let bubble = try JSONDecoder().decode(UserBubble.self, from: old)
        XCTAssertFalse(bubble.receipt)
        XCTAssertNil(bubble.deliveryCode)
        XCTAssertNil(bubble.deliveryReason)

        let receipt = UserBubble(id: "r", text: "英文版也要", turnId: "t9", pending: false, undelivered: true,
                                 steer: true, delivery: "failed", receipt: true,
                                 deliveryCode: "CURRENT_WORK_TARGET_COMPLETED", deliveryReason: "raw")
        XCTAssertEqual(try JSONDecoder().decode(UserBubble.self, from: JSONEncoder().encode(receipt)), receipt)
    }
}
