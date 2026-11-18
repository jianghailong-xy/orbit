import Foundation
import XCTest
@testable import OrbitKit

/// The guest view followed over the guest door's stream (docs/session-viewer-stream-design.md §3, §4, §7):
/// the frames it reads, what it draws of them, the cursor it reconnects from, and when it falls back to
/// GuestFollow polling.
final class GuestStreamTests: XCTestCase {
    private func frame(_ json: String) -> GuestStreamFrame? {
        GuestStreamFrame.decode(SSEEvent(id: nil, event: nil, data: json))
    }

    private func delta(_ text: String) -> RunEvent {
        RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string(text)]))
    }

    private func replies(_ reducer: TranscriptReducer) -> [AssistantBubble] {
        reducer.state.items.compactMap { item -> AssistantBubble? in
            if case .assistant(let bubble) = item { return bubble } else { return nil }
        }
    }

    // MARK: frames on the wire

    func testTheStreamsFramesAreReadAsEventsHeadsGoneAndPings() {
        guard case .event(let stored)? = frame(#"{"seq":7,"type":"assistant","payload":{"text":"On it."},"turnId":"t1","ts":"2026-11-16T09:00:00.000Z"}"#) else {
            return XCTFail("an assistant event")
        }
        XCTAssertEqual(stored.seq, 7)
        XCTAssertEqual(stored.turnId, "t1")
        // A delta rides the reduced envelope: seq, type and payload only.
        guard case .event(let typed)? = frame(#"{"seq":0,"type":"text_delta","payload":{"delta":"On "}}"#) else {
            return XCTFail("a delta")
        }
        XCTAssertEqual(typed.type, .textDelta)
        // The head as the events?after answer states it, waitingOnOwner included.
        guard case .head(let head)? = frame(#"{"seq":0,"type":"head","payload":{"title":"Ship it","runState":"RUNNING","sessionState":"RUNNING","waitingOnOwner":true}}"#) else {
            return XCTFail("a head frame")
        }
        XCTAssertEqual(head.title, "Ship it")
        XCTAssertEqual(head.state.resolvedRunState, .running)
        XCTAssertTrue(head.state.waitingOnOwner)
        XCTAssertEqual(frame(#"{"type":"gone"}"#), .gone)
        XCTAssertEqual(frame(#"{"type":"ping"}"#), .ping)
        guard case .event(let resync)? = frame(#"{"seq":0,"type":"resync","payload":{}}"#) else { return XCTFail("a resync") }
        XCTAssertEqual(resync.type, .resync)
        // A type nobody knows, or no JSON at all, is not drawn.
        XCTAssertNil(frame(#"{"seq":0,"type":"something_new","payload":{}}"#))
        XCTAssertNil(frame("not json"))
    }

    // MARK: deltas

    func testDeltasAreDrawnAsTheOwnersTranscriptDrawsThemAndNeverMoveTheCursor() {
        var follow = GuestStreamFollow(after: 4)
        var reducer = TranscriptReducer()
        for event in [delta("Shipping "), delta("on Friday.")] {
            guard case .apply(let drawn) = follow.read(.event(event)) else { return XCTFail("a delta is drawn") }
            reducer.apply(drawn)
        }
        XCTAssertEqual(follow.cursor, 4, "a delta is live-only: the cursor stays on the last stored event")
        XCTAssertEqual(replies(reducer).map(\.displayText), ["Shipping on Friday."])
        XCTAssertFalse(replies(reducer)[0].isFinalized)

        // The stored reply replaces the typed-out one: one bubble, final.
        let stored = RunEvent(seq: 5, type: .assistant, payload: .object(["text": .string("Shipping on Friday.")]))
        guard case .apply(let final) = follow.read(.event(stored)) else { return XCTFail("a stored event is drawn") }
        reducer.apply(final)
        XCTAssertEqual(replies(reducer).map(\.displayText), ["Shipping on Friday."])
        XCTAssertTrue(replies(reducer)[0].isFinalized)
        XCTAssertEqual(follow.cursor, 5)
    }

    // MARK: head

    func testAHeadFrameRedrawsTheStatusAndTheWaitingLine() {
        var follow = GuestStreamFollow()
        let waiting = GuestSessionState(runState: .running, runStatus: nil, sessionState: nil, lifecycleState: nil, waitingOnOwner: true)
        guard case .head(let head) = follow.read(.head(GuestSessionHead(title: "Ship it", state: waiting))) else {
            return XCTFail("a head frame redraws the head")
        }
        XCTAssertEqual(head.state.hint(owner: "Ravi"), GuestCopy.waitsItsTurn)
        XCTAssertEqual(head.state.tone, .running)
        let ended = GuestSessionState(runState: .ended, runStatus: nil, sessionState: nil, lifecycleState: nil, waitingOnOwner: false)
        guard case .head(let after) = follow.read(.head(GuestSessionHead(title: nil, state: ended))) else { return XCTFail() }
        XCTAssertEqual(after.state.hint(owner: "Ravi"), GuestCopy.restarts("Ravi"))
        XCTAssertEqual(follow.cursor, 0, "a head moves no cursor")
    }

    // MARK: gone

    func testGoneShowsTheNotSharedState() {
        var follow = GuestStreamFollow(after: 9)
        XCTAssertEqual(follow.read(.gone), .gone)
    }

    // MARK: reconnect cursor

    func testTheCursorIsTheNewestStoredSeqAndAReplayAlreadyHeldIsSkipped() {
        var follow = GuestStreamFollow()
        follow.reseeded(after: 10)
        XCTAssertEqual(follow.cursor, 10, "the first read's tail page")
        let replayed = RunEvent(seq: 10, type: .user, turnId: "t1", payload: .object(["text": .string("hi")]))
        XCTAssertEqual(follow.read(.event(replayed)), .skip)
        let newer = RunEvent(seq: 11, type: .assistant, payload: .object(["text": .string("hello")]))
        XCTAssertEqual(follow.read(.event(newer)), .apply(newer))
        XCTAssertEqual(follow.cursor, 11)
        // A settlement's status rides the sentinel seq: drawn, but it must never become the cursor.
        let settled = RunEvent(seq: RunEvent.sentinelSeq, type: .status, payload: .object(["status": .string("SUCCEEDED")]))
        XCTAssertEqual(follow.read(.event(settled)), .apply(settled))
        XCTAssertEqual(follow.cursor, 11)
        // A poll that read further moves it too; an older seq does not move it back.
        follow.held(14)
        follow.held(12)
        follow.held(RunEvent.sentinelSeq)
        XCTAssertEqual(follow.cursor, 14)
    }

    func testADroppedStreamReconnectsFromTheCursorOnTheRamp() {
        var follow = GuestStreamFollow(after: 3)
        _ = follow.read(.ping)
        XCTAssertEqual(follow.next(after: .failed), .reconnect(afterMs: 1_000))
        XCTAssertEqual(follow.mode, .stream)
        XCTAssertEqual(follow.cursor, 3, "the next connection asks sinceSeq=3")
        // A drop before anything arrived ramps.
        XCTAssertEqual(follow.next(after: .failed), .reconnect(afterMs: 2_000))
        // An apiserver stopping closes it cleanly after frames: a beat, then again.
        _ = follow.read(.ping)
        XCTAssertEqual(follow.next(after: .ended), .reconnect(afterMs: 300))
    }

    func testAResyncReseedsAndReconnects() {
        var follow = GuestStreamFollow(after: 3)
        XCTAssertEqual(follow.read(.event(RunEvent(seq: 0, type: .resync))), .reseed)
        follow.reseeded(after: 2_400)
        XCTAssertEqual(follow.next(after: .resync), .reconnect(afterMs: 300))
        XCTAssertEqual(follow.cursor, 2_400)
    }

    // MARK: background and foreground

    func testTheStreamIsClosedInTheBackgroundAndReopenedFromTheCursorInTheForeground() {
        var follow = GuestStreamFollow(after: 8)
        XCTAssertEqual(follow.next(after: .background), .waitForeground)
        XCTAssertEqual(follow.mode, .stream)
        follow.foreground()
        XCTAssertEqual(follow.mode, .stream)
        XCTAssertEqual(follow.cursor, 8)
    }

    func testTheViewGoingStopsTheFollow() {
        var follow = GuestStreamFollow()
        XCTAssertEqual(follow.next(after: .cancelled), .stop)
        XCTAssertEqual(GuestStreamFollow.end(of: CancellationError()), .cancelled)
    }

    // MARK: fallback to GuestFollow

    func testAStreamTheDoorRefusesFallsBackToPolling() {
        // A server without the route (404) or a stream over a cap (429): the door answered, so poll.
        for status in [404, 429, 503] {
            var follow = GuestStreamFollow(after: 5)
            XCTAssertEqual(GuestStreamFollow.end(of: APIError.http(status: status, body: nil)), .refused(status: status))
            XCTAssertEqual(follow.next(after: .refused(status: status)), .poll)
            XCTAssertEqual(follow.mode, .polling)
            XCTAssertEqual(follow.cursor, 5, "the poll asks after the same seq")
        }
        XCTAssertEqual(GuestStreamFollow.end(of: URLError(.timedOut)), .failed)
    }

    func testAStreamThatNeverDeliversFallsBackAfterThreeAttempts() {
        var follow = GuestStreamFollow()
        XCTAssertEqual(follow.next(after: .failed), .reconnect(afterMs: 1_000))
        XCTAssertEqual(follow.next(after: .ended), .reconnect(afterMs: 2_000))
        XCTAssertEqual(follow.next(after: .failed), .poll)
        XCTAssertEqual(follow.mode, .polling)
    }

    func testAStreamThatDeliveredKeepsReconnectingRatherThanPolling() {
        var follow = GuestStreamFollow()
        for _ in 0..<10 {
            _ = follow.read(.ping)
            guard case .reconnect = follow.next(after: .failed) else { return XCTFail("a healthy stream reconnects") }
        }
        XCTAssertEqual(follow.mode, .stream)
    }

    func testWhilePollingTheStreamIsTriedAgainAfterAMinuteOrInTheForeground() {
        var follow = GuestStreamFollow()
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(follow.next(after: .refused(status: 429), at: start), .poll)
        // Polling follows GuestFollow's cadence meanwhile.
        let working = GuestSessionState(runState: .running, runStatus: nil, sessionState: nil, lifecycleState: nil, waitingOnOwner: false)
        XCTAssertEqual(GuestFollow.delay(working, moved: false, expecting: false), 4)
        XCTAssertFalse(follow.retryStream(at: start.addingTimeInterval(59)))
        XCTAssertEqual(follow.mode, .polling)
        XCTAssertTrue(follow.retryStream(at: start.addingTimeInterval(60)))
        XCTAssertEqual(follow.mode, .stream)
        XCTAssertFalse(follow.retryStream(at: start.addingTimeInterval(120)), "only while polling")

        _ = follow.next(after: .refused(status: 404), at: start)
        follow.foreground()
        XCTAssertEqual(follow.mode, .stream)
    }

    // MARK: the draw-on-send of 98922820c over the stream

    func testAMessageDrawnOnSendIsReplacedByItsEchoOnTheStream() {
        var sent = GuestSentTurns()
        let key = sent.draw("Ship it on Friday")
        var reducer = TranscriptReducer()
        reducer.appendNewer(EventPage(events: sent.events, hasMore: false))
        guard case .user(let bubble)? = reducer.state.items.last else { return XCTFail("no user bubble") }
        XCTAssertEqual(bubble.text, "Ship it on Friday")

        sent.accepted(key, turnId: "T")
        var follow = GuestStreamFollow(after: 3)
        let echo = RunEvent(seq: 4, type: .user, turnId: "T", payload: .object(["text": .string("Ship it on Friday")]))
        guard case .apply(let event) = follow.read(.event(echo)) else { return XCTFail("the echo is drawn") }
        sent.read([event])
        XCTAssertTrue(sent.isEmpty)
    }
}
