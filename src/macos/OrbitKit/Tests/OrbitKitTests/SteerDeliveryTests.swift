import XCTest
@testable import OrbitKit

/// A message sent while a turn is already running is written INTO that turn (a steer) instead of
/// queued behind it. The two are different promises to the person who sent one, and the console
/// has to keep them apart: a queued message is waiting and withdrawable, a steer is already on its
/// way and cannot be taken back. These cover what the clients show for one, and prove the queued
/// behaviour they sit next to still works exactly as it did.
final class SteerDeliveryTests: XCTestCase {

    private func userEvent(_ seq: Int, turn: String, text: String,
                           delivery: String? = "enqueued", steer: Bool = false) -> RunEvent {
        var payload: [String: JSONValue] = ["text": .string(text)]
        if let delivery { payload["delivery"] = .string(delivery) }
        if steer { payload["steer"] = .bool(true) }
        return RunEvent(seq: seq, type: .user, turnId: turn, payload: .object(payload))
    }

    private func deliveryEvent(_ seq: Int, turn: String, _ delivery: String,
                               reason: String? = nil) -> RunEvent {
        var payload: [String: JSONValue] = ["turnId": .string(turn), "delivery": .string(delivery)]
        if let reason {
            payload["reason"] = .string(reason)
            payload["retryable"] = .bool(true)
        }
        return RunEvent(seq: seq, type: .userDelivery, payload: .object(payload))
    }

    private func bubbles(_ r: TranscriptReducer) -> [UserBubble] {
        r.state.items.compactMap { if case .user(let b) = $0 { return b } else { return nil } }
    }

    // MARK: - the states themselves

    func testNamesEveryStageTheRunnerReports() {
        // The window between "the control plane took it" and "the runner took it" reads the same
        // as the runner's own acceptance: both are a promise it will be offered to the engine.
        XCTAssertEqual(SteerDelivery.state(nil).label, "Sending…")
        XCTAssertEqual(SteerDelivery.state("enqueued").label, "Sending…")
        XCTAssertEqual(SteerDelivery.state("written").label, "Delivering…")
        XCTAssertEqual(SteerDelivery.state("acknowledged").label, "Sent into this turn")
        XCTAssertEqual(SteerDelivery.state("failed").label, "Not delivered")
        // Same vocabulary as web: a message re-filed as its own turn is on its way, not lost.
        XCTAssertEqual(SteerDelivery.state("requeued").label, "Queued for next turn instead")
        XCTAssertEqual(SteerDelivery.state("requeued").tone, .progress)
    }

    func testSeparatesOnItsWayFromArrivedFromLost() {
        XCTAssertEqual(SteerDelivery.state("written").tone, .progress)
        XCTAssertEqual(SteerDelivery.state("acknowledged").tone, .delivered)
        XCTAssertEqual(SteerDelivery.state("failed").tone, .failed)
        // A stage a newer runner reports and this client has never heard of is still in flight.
        // Reading it as arrived would claim the engine has a message that may still be queued.
        XCTAssertEqual(SteerDelivery.state("teleported").tone, .progress)
    }

    func testRecognisesOnlyTheKindTheServerFilesAMidTurnMessageAs() {
        XCTAssertTrue(SteerDelivery.isSteerKind("steer"))
        XCTAssertFalse(SteerDelivery.isSteerKind("message"))
        XCTAssertFalse(SteerDelivery.isSteerKind("shell"))
        // An older server omits the kind: that is the pre-steer behaviour (queued), and reading it
        // as a steer would drop the withdraw from a message that really can be withdrawn.
        XCTAssertFalse(SteerDelivery.isSteerKind(nil))
    }

    // MARK: - what a reload rebuilds

    func testRebuildsASteersStateFromTheDurableEventsAlone() {
        // Exactly what a refresh or a reconnect replays. The send that produced this bubble is
        // long gone, so everything shown for it has to survive in the transcript itself.
        var r = TranscriptReducer()
        r.apply(userEvent(1, turn: "t0", text: "refactor the parser"))
        r.apply(userEvent(2, turn: "t1", text: "use the other endpoint", steer: true))
        r.apply(deliveryEvent(3, turn: "t1", "written"))
        r.apply(deliveryEvent(4, turn: "t1", "acknowledged"))

        let all = bubbles(r)
        XCTAssertEqual(all.count, 2)
        XCTAssertFalse(all[0].steer, "an ordinary message is not a steer")
        XCTAssertTrue(all[1].steer)
        XCTAssertEqual(SteerDelivery.state(all[1].delivery).label, "Sent into this turn")
    }

    func testAdvancesOneMessageWithoutTouchingTheOther() {
        // The delivery names its turn in the payload, not through the event's own attribution: it
        // settles on the writer's schedule, so the turn in progress by then is often another one.
        var r = TranscriptReducer()
        r.apply(userEvent(1, turn: "t1", text: "first", steer: true))
        r.apply(userEvent(2, turn: "t2", text: "second", steer: true))
        r.apply(deliveryEvent(3, turn: "t1", "acknowledged"))

        let all = bubbles(r)
        XCTAssertEqual(all[0].delivery, "acknowledged")
        XCTAssertEqual(all[1].delivery, "enqueued", "the second message has not moved")
    }

    func testMarksASteerTheEngineNeverReceived() {
        var r = TranscriptReducer()
        r.apply(userEvent(1, turn: "t1", text: "use the other endpoint", steer: true))
        r.apply(deliveryEvent(2, turn: "t1", "failed", reason: "no turn is running"))

        let bubble = bubbles(r)[0]
        XCTAssertEqual(SteerDelivery.state(bubble.delivery).label, "Not delivered")
        // The same fact the drained-on-terminal path records, so both read the same to the person
        // and neither is left looking like a message that is still on its way.
        XCTAssertTrue(bubble.undelivered)
    }

    func testARefusedSteerEntersTheTranscriptAsAFailureNotAsASentMessage() {
        // The runner refuses a steer that reaches an idle engine, and files the refusal on the
        // `user` event itself. Without that the sender watches a bubble wait for nothing.
        var r = TranscriptReducer()
        r.apply(userEvent(1, turn: "t1", text: "use the other endpoint",
                          delivery: "failed", steer: true))

        let bubble = bubbles(r)[0]
        XCTAssertTrue(bubble.undelivered)
        XCTAssertEqual(SteerDelivery.state(bubble.delivery).label, "Not delivered")
    }

    func testIgnoresADeliveryForATurnThisWindowNeverLoaded() {
        // After a resync the bubble may be off the loaded page. There is nothing to amend, and
        // inventing a row for it would put a message in the transcript nobody sent here.
        var r = TranscriptReducer()
        r.apply(userEvent(1, turn: "t1", text: "use the other endpoint", steer: true))
        r.apply(deliveryEvent(2, turn: "gone", "acknowledged"))

        XCTAssertEqual(bubbles(r).count, 1)
        XCTAssertEqual(bubbles(r)[0].delivery, "enqueued")
    }

    func testDeliveryReportsAreDurableAndReplayed() {
        // They carry a real seq and are persisted: a client that treated them as live-only nudges
        // would dedup them against seq 0 and lose every state a reconnect replays.
        XCTAssertTrue(RunEventType.userDelivery.isDurable)
        XCTAssertEqual(RunEventType(rawValue: "user_delivery"), .userDelivery)
    }

    // MARK: - landing in the middle of a reply

    func testASteerDoesNotCloseTheReplyItLandsIn() {
        // The reply is mid-sentence when the steer arrives — that is the whole point of steering.
        // Closing its bubble would leave it holding half a sentence, and the authoritative
        // `assistant` event for that same block would then append the reply a SECOND time under
        // the partial copy, because there is no open bubble left to fill.
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("Renaming the ")])))
        r.apply(userEvent(1, turn: "t1", text: "actually, call it gadget", steer: true))
        r.apply(RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("widget.")])))
        r.apply(RunEvent(seq: 2, type: .assistant, payload: .object(["text": .string("Renaming the widget.")])))

        let replies = r.state.items.compactMap { item -> AssistantBubble? in
            if case .assistant(let b) = item { return b } else { return nil }
        }
        XCTAssertEqual(replies.count, 1, "the reply was rendered twice around the steer")
        XCTAssertEqual(replies[0].displayText, "Renaming the widget.")
        XCTAssertEqual(bubbles(r).count, 1, "and the steer is still there, exactly once")
    }

    func testAnOrdinaryMessageStillClosesWhateverWasLeftOpen() {
        // The regression guard for the line above: a message that opens a turn is a boundary, and
        // anything still streaming when it arrives was left dangling and must be closed.
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("half a thought")])))
        r.apply(userEvent(1, turn: "t1", text: "never mind"))
        r.apply(RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("a new one")])))

        let replies = r.state.items.compactMap { item -> AssistantBubble? in
            if case .assistant(let b) = item { return b } else { return nil }
        }
        XCTAssertEqual(replies.count, 2, "the dangling bubble was reopened instead of closed")
        XCTAssertEqual(replies[0].displayText, "half a thought")
    }

    // MARK: - the optimistic bubble, before any event exists

    func testTheServersKindOverridesTheSendsOwnGuess() {
        // The send labels its bubble from a status the stream may not have caught up with; the
        // server decided the kind under the Session row lock. A bubble that says "Queued" while
        // the message is already on its way into the running turn is the confusion to avoid.
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "use the other endpoint", queued: true)
        r.setOptimisticTurnId(clientTurnId: "c1", turnId: "t1", steer: true)

        XCTAssertEqual(r.state.queued.count, 1)
        XCTAssertTrue(r.state.queued[0].steer)
        XCTAssertEqual(r.state.queued[0].turnId, "t1")
    }

    func testAnOrdinaryQueuedSendIsUnchanged() {
        // The regression guard for everything this sits beside: a message queued behind the
        // running turn is still queued, still tagged with its turn id, and still withdrawable.
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "and then deploy", queued: true)
        r.setOptimisticTurnId(clientTurnId: "c1", turnId: "t1")

        XCTAssertEqual(r.state.queued.count, 1)
        XCTAssertTrue(r.state.queued[0].queued)
        XCTAssertFalse(r.state.queued[0].steer, "nothing filed it as a steer")
        XCTAssertEqual(r.state.queued[0].turnId, "t1")
    }

    func testASteerLeavesTheQueueWhenItsOwnEventArrives() {
        // Same handoff a queued message makes: the durable event becomes the real row, in order,
        // and the placeholder goes — a steer must not be shown twice.
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "use the other endpoint", queued: true)
        r.setOptimisticTurnId(clientTurnId: "c1", turnId: "t1", steer: true)
        r.apply(userEvent(1, turn: "t1", text: "use the other endpoint", steer: true))

        XCTAssertTrue(r.state.queued.isEmpty)
        XCTAssertEqual(bubbles(r).count, 1)
        XCTAssertTrue(bubbles(r)[0].steer)
        XCTAssertFalse(bubbles(r)[0].pending)
    }

    func testAFailedSendLeavesNoBubbleBehind() {
        // A POST that never landed must take its bubble with it, steer or not: a message the
        // server never accepted has to leave the composer holding it, not the transcript.
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "use the other endpoint", queued: true)
        r.setOptimisticTurnId(clientTurnId: "c1", turnId: "t1", steer: true)
        r.removeOptimisticUser(clientTurnId: "c1")

        XCTAssertTrue(r.state.queued.isEmpty)
        XCTAssertTrue(bubbles(r).isEmpty)
    }

    // MARK: - restoring the queue from the server

    func testTheQueueListTellsASteerFromAQueuedMessage() {
        // GET /sessions/:id/turns lists a still-PENDING steer too — until the runner leases it
        // there is nothing else to render it from, and a message that vanishes on refresh is the
        // one outcome mid-turn sending must not produce. `kind` is how they stay apart.
        var r = TranscriptReducer()
        r.reconcileQueuedTurns([
            QueuedTurnInfo(turnId: "t1", kind: "steer", content: "use the other endpoint",
                           attachments: nil),
            QueuedTurnInfo(turnId: "t2", kind: "message", content: "and then deploy",
                           attachments: nil),
        ], knownBefore: [])

        XCTAssertEqual(r.state.queued.count, 2)
        XCTAssertTrue(r.state.queued[0].steer)
        XCTAssertFalse(r.state.queued[1].steer, "a queued message is still withdrawable")
    }

    // MARK: - the same steer, delivered by codex

    // Nothing about the bubble changes — one vocabulary, both engines — but the ORDER the events
    // arrive in does. claude's runner opens the bubble the moment it accepts the message, so it
    // always starts at `enqueued` and walks forward. codex cannot: its steer is an RPC whose
    // answer and whose echo are read by different goroutines, and un-filing a message the engine
    // provably never read has to leave no bubble behind at all. So the `user` event is held back
    // until the FIRST KNOWN OUTCOME, and a codex steer's bubble is born at whatever that turned
    // out to be — including, for one that never landed, at the failure itself.

    func testACodexSteersBubbleOpensAtWhateverHappenedFirst() {
        // `turn/steer` returned OK before anything else was known: codex has the message and the
        // model has not read it yet. There was never an `enqueued` event for this one.
        var written = TranscriptReducer()
        written.apply(userEvent(1, turn: "t1", text: "use the other endpoint",
                                delivery: "written", steer: true))

        XCTAssertEqual(SteerDelivery.state(bubbles(written)[0].delivery).label, "Delivering…")
        XCTAssertFalse(bubbles(written)[0].undelivered)

        // …and the other way round: codex has been seen echoing a steer back before the response
        // to the request was observed, so `acknowledged` can be the first word about it.
        var echoed = TranscriptReducer()
        echoed.apply(userEvent(1, turn: "t1", text: "use the other endpoint",
                               delivery: "acknowledged", steer: true))

        XCTAssertEqual(SteerDelivery.state(bubbles(echoed)[0].delivery).label, "Sent into this turn")
        XCTAssertFalse(bubbles(echoed)[0].undelivered)
    }

    func testACodexSteerStrandedByADeadRunnerOpensAsTheFailureItIs() {
        // A steer is delivered once and never re-delivered, so a runner killed while holding one
        // leaves a row nothing else will ever come back for. The process taking the session over
        // answers for it on the event stream: the bubble it was never given, then the report.
        // Both say failed, and the second must not read as a message that is still on its way.
        var r = TranscriptReducer()
        r.apply(userEvent(1, turn: "t1", text: "use the other endpoint",
                          delivery: "failed", steer: true))
        r.apply(deliveryEvent(2, turn: "t1", "failed",
                              reason: "the runner stopped while this message was on its way"))

        XCTAssertEqual(bubbles(r).count, 1, "the report opened a second bubble")
        XCTAssertTrue(bubbles(r)[0].undelivered)
        XCTAssertEqual(SteerDelivery.state(bubbles(r)[0].delivery).label, "Not delivered")
    }

    func testACodexSteerCarriesItsAttachmentsIntoTheBubbleItOpens() {
        // The bubble is opened from the runner's own record of the message, long after the send:
        // whatever it does not carry there is lost, and an image-only steer would open empty.
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .user, turnId: "t1", payload: .object([
            "text": .string("like this one"), "steer": .bool(true),
            "delivery": .string("written"),
            "attachments": .array([.object(["id": .string("att-1"), "mime": .string("image/png")])]),
        ])))

        XCTAssertEqual(bubbles(r)[0].attachments.map(\.id), ["att-1"])
        XCTAssertTrue(bubbles(r)[0].steer)
    }

    func testARefiledSteerComesBackAsAWithdrawableQueuedMessage() {
        // A codex steer the engine provably never read is un-filed onto the same row — same seq,
        // same clientTurnId — and runs as the ordinary message it would have been had it been
        // sent a moment later. That path publishes nothing at all, so the queued list IS the
        // announcement: the row reappears as kind `message`, and the withdraw has to come back
        // with it or the message is stuck un-cancellable for the rest of the session.
        var r = TranscriptReducer()
        r.reconcileQueuedTurns([
            QueuedTurnInfo(turnId: "t1", kind: "steer", content: "use the other endpoint",
                           attachments: nil),
        ], knownBefore: [])
        XCTAssertTrue(r.state.queued[0].steer)

        r.reconcileQueuedTurns([
            QueuedTurnInfo(turnId: "t1", kind: "message", content: "use the other endpoint",
                           attachments: nil),
        ], knownBefore: ["t1"])

        XCTAssertEqual(r.state.queued.count, 1, "the same row, not a second copy of the message")
        XCTAssertFalse(r.state.queued[0].steer, "it is a queued message again — it can be withdrawn")
        XCTAssertTrue(r.state.queued[0].queued)
        XCTAssertEqual(r.state.queued[0].turnId, "t1")
    }

    func testAQueueSnapshotTakenBeforeTheLeaseDoesNotResurrectASteer() {
        // The REST list only holds a steer while it is still PENDING; the moment the runner takes
        // it, it leaves. A snapshot read just before that can arrive after the steer's own `user`
        // event, and re-adding the row would put the same message on screen twice — once in the
        // transcript where it landed, once below it still saying "Sending…".
        var r = TranscriptReducer()
        r.apply(userEvent(1, turn: "t1", text: "use the other endpoint",
                          delivery: "written", steer: true))
        r.reconcileQueuedTurns([
            QueuedTurnInfo(turnId: "t1", kind: "steer", content: "use the other endpoint",
                           attachments: nil),
        ], knownBefore: [])

        XCTAssertTrue(r.state.queued.isEmpty)
        XCTAssertEqual(bubbles(r).count, 1)
    }

    func testAPendingSteerCanFailBeforeItEverHasATranscriptRow() {
        // The refusal can arrive while the bubble is still in the queued tail. It must settle
        // there rather than sit on "Sending…" for the life of the session.
        var r = TranscriptReducer()
        r.reconcileQueuedTurns([
            QueuedTurnInfo(turnId: "t1", kind: "steer", content: "use the other endpoint",
                           attachments: nil),
        ], knownBefore: [])
        r.apply(deliveryEvent(1, turn: "t1", "failed", reason: "no turn is running"))

        XCTAssertEqual(r.state.queued.count, 1)
        XCTAssertTrue(r.state.queued[0].undelivered)
        XCTAssertFalse(r.state.queued[0].pending)
    }
}
