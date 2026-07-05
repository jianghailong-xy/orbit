import XCTest
@testable import OrbitKit

/// The Swift mirror of shared/src/realtime.ts — envelope decode, per-type payload decode, the
/// `.unknown` forward-compat floor, and the keepalive frame being discarded by the SSE decoder.
final class ControlEventCodableTests: XCTestCase {

    private func decode(_ json: String) throws -> ControlEvent {
        try JSONDecoder().decode(ControlEvent.self, from: Data(json.utf8))
    }

    func testDecodesSessionUpdatedWithFullSummary() throws {
        let ev = try decode("""
        {"type":"session.updated","sessionId":"s1","agentId":"a1","ts":"2026-07-05T00:00:00.000Z",
         "data":{"id":"s1","title":"Fix bug","status":"RUNNING","agentId":"a1",
                 "agent":{"id":"a1","name":"builder","model":"opus"},
                 "pendingApprovals":2,"lastTurnAt":"2026-07-05T00:00:00.000Z"}}
        """)
        XCTAssertEqual(ev.type, .sessionUpdated)
        XCTAssertEqual(ev.sessionId, "s1")
        XCTAssertEqual(ev.agentId, "a1")
        let s = try XCTUnwrap(ev.payload(ControlSessionSummary.self))
        XCTAssertEqual(s.id, "s1")
        XCTAssertEqual(s.title, "Fix bug")
        XCTAssertEqual(s.status, .running)
        XCTAssertEqual(s.pendingApprovals, 2)
        XCTAssertEqual(s.agent?.name, "builder")
        XCTAssertEqual(s.lastTurnAt, "2026-07-05T00:00:00.000Z")
    }

    func testDecodesSessionCreatedSharingTheSummaryShape() throws {
        let ev = try decode("""
        {"type":"session.created","sessionId":"s2","agentId":null,"ts":"t",
         "data":{"id":"s2","title":null,"status":"PENDING","agentId":null,"agent":null,
                 "pendingApprovals":0,"lastTurnAt":null}}
        """)
        XCTAssertEqual(ev.type, .sessionCreated)
        XCTAssertNil(ev.agentId)
        let s = try XCTUnwrap(ev.payload(ControlSessionSummary.self))
        XCTAssertEqual(s.status, .pending)
        XCTAssertNil(s.title)
        XCTAssertNil(s.agent)
    }

    func testDecodesSessionEnded() throws {
        let ev = try decode("""
        {"type":"session.ended","sessionId":"s1","agentId":"a1","ts":"t",
         "data":{"status":"SUCCEEDED","endReason":"completed"}}
        """)
        XCTAssertEqual(ev.type, .sessionEnded)
        let d = try XCTUnwrap(ev.payload(ControlSessionEnded.self))
        XCTAssertEqual(d.status, .succeeded)
        XCTAssertEqual(d.endReason, "completed")
    }

    func testDecodesSessionError() throws {
        let ev = try decode("""
        {"type":"session.error","sessionId":"s1","agentId":null,"ts":"t",
         "data":{"message":"API Error: boom","recoverable":true}}
        """)
        let d = try XCTUnwrap(ev.payload(ControlSessionError.self))
        XCTAssertEqual(d.message, "API Error: boom")
        XCTAssertTrue(d.recoverable)
    }

    func testDecodesApprovalCounts() throws {
        let ev = try decode("""
        {"type":"approval.requested","sessionId":"s1","agentId":"a1","ts":"t",
         "data":{"approvalId":"ap1","pendingApprovals":3}}
        """)
        XCTAssertEqual(ev.type, .approvalRequested)
        let d = try XCTUnwrap(ev.payload(ControlApproval.self))
        XCTAssertEqual(d.approvalId, "ap1")
        XCTAssertEqual(d.pendingApprovals, 3)
    }

    func testDecodesBackgroundTaskWithOptionalExitCode() throws {
        let ev = try decode("""
        {"type":"background.task","sessionId":"s1","agentId":null,"ts":"t",
         "data":{"name":"npm test","status":"completed","exitCode":0}}
        """)
        let d = try XCTUnwrap(ev.payload(ControlBackgroundTask.self))
        XCTAssertEqual(d.exitCode, 0)

        let noExit = try decode("""
        {"type":"background.task","sessionId":"s1","agentId":null,"ts":"t",
         "data":{"name":"sleep","status":"killed"}}
        """)
        XCTAssertNil(try XCTUnwrap(noExit.payload(ControlBackgroundTask.self)).exitCode)
    }

    func testUnknownTypeDecodesToUnknownNotError() throws {
        // A newer server shipping a new event type must not break this client.
        let ev = try decode("""
        {"type":"totally.new.thing","sessionId":"s1","agentId":null,"ts":"t","data":{"x":1}}
        """)
        XCTAssertEqual(ev.type, .unknown)
    }

    func testMismatchedPayloadDecodesToNilNotCrash() throws {
        let ev = try decode("""
        {"type":"session.updated","sessionId":"s1","agentId":null,"ts":"t","data":{"nope":true}}
        """)
        XCTAssertNil(ev.payload(ControlSessionSummary.self))
    }

    func testSSEDecodingDiscardsThePingKeepalive() {
        // The server's ~20s keepalive is a data frame `{"type":"ping"}` (Nest can't emit `:`
        // comments); it has no sessionId, so the decoder drops it — its bytes only feed the
        // watchdog clock.
        let ping = SSEEvent(id: nil, event: nil, data: #"{"type":"ping"}"#)
        XCTAssertNil(SSEDecoding.controlEvent(from: ping))

        let real = SSEEvent(id: nil, event: nil, data:
            #"{"type":"session.ended","sessionId":"s1","agentId":null,"ts":"t","data":{"status":"SUCCEEDED","endReason":"completed"}}"#)
        XCTAssertEqual(SSEDecoding.controlEvent(from: real)?.type, .sessionEnded)
    }

    func testByteClockStarvation() {
        let clock = ByteClock()
        XCTAssertFalse(clock.starved(timeout: 60))   // just pulsed at init
        XCTAssertTrue(clock.starved(timeout: -1))    // any elapsed time exceeds a negative window
        clock.pulse()
        XCTAssertFalse(clock.starved(timeout: 60))
    }

    func testMockControlStreamYieldsConnectedThenEvents() async throws {
        let ev = ControlEvent(type: .sessionEnded, sessionId: "s1", agentId: nil, ts: "t", data: nil)
        var got: [ControlStreamEvent] = []
        for try await item in MockControlStream([ev]).events() { got.append(item) }
        XCTAssertEqual(got, [.connected, .event(ev)])
    }
}
