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
         "data":{"id":"s1","taskId":"t1","title":"Fix bug","status":"PENDING","runStatus":"RUNNING","sessionState":"RUNNING","runState":"RUNNING","lifecycleState":"OPEN",
                 "capabilities":{"canSend":false,"canResume":false,"resumeBlockedReason":"ENDING","canComplete":true,"canRestore":false},"agentId":"a1",
                 "agent":{"id":"a1","name":"builder","provider":"opencode","model":"openai/gpt-5","effort":"high"},
                 "projectId":"p1","projectTitle":"Fix the project",
                 "pendingApprovals":2,"lastTurnAt":"2026-07-05T00:00:00.000Z"}}
        """)
        XCTAssertEqual(ev.type, .sessionUpdated)
        XCTAssertEqual(ev.sessionId, "s1")
        XCTAssertEqual(ev.agentId, "a1")
        let s = try XCTUnwrap(ev.payload(ControlSessionSummary.self))
        XCTAssertEqual(s.id, "s1")
        XCTAssertEqual(s.taskId, "t1")
        XCTAssertEqual(s.title, "Fix bug")
        XCTAssertEqual(s.status, .pending)
        XCTAssertEqual(s.runStatus, .running)
        XCTAssertEqual(s.effectiveRunStatus, .running)
        XCTAssertEqual(s.sessionState, .running)
        XCTAssertEqual(s.runState, .running)
        XCTAssertEqual(s.effectiveRunState, .running)
        XCTAssertEqual(s.lifecycleState, .open)
        XCTAssertEqual(s.effectiveLifecycleState, .open)
        XCTAssertFalse(try XCTUnwrap(s.capabilities).canSend)
        XCTAssertEqual(s.capabilities?.resumeBlockedReason, .ending)
        XCTAssertTrue(try XCTUnwrap(s.capabilities).canComplete)
        XCTAssertEqual(s.pendingApprovals, 2)
        XCTAssertEqual(s.agent?.name, "builder")
        XCTAssertEqual(s.agent?.effort, "high")
        XCTAssertEqual(s.projectId!, "p1")
        XCTAssertEqual(s.projectTitle!, "Fix the project")
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
        XCTAssertNil(s.taskId, "ordinary/legacy session summaries remain compatible")
        XCTAssertNil(s.runStatus)
        XCTAssertEqual(s.effectiveRunStatus, .pending)
        XCTAssertNil(s.sessionState)
        XCTAssertNil(s.runState)
        XCTAssertEqual(s.effectiveRunState, .queued)
        XCTAssertNil(s.lifecycleState)
        XCTAssertNil(s.effectiveLifecycleState)
        XCTAssertNil(s.title)
        XCTAssertNil(s.agent)
        if s.projectId != nil {
            XCTFail("Expected an absent projectId field to preserve the current relation")
        }
        if s.projectTitle != nil {
            XCTFail("Expected an absent projectTitle field to preserve the current relation")
        }
    }

    func testProjectRelationDistinguishesExplicitNullFromAbsent() throws {
        let ev = try decode("""
        {"type":"session.updated","sessionId":"s1","agentId":null,"ts":"t",
         "data":{"id":"s1","status":"RUNNING","pendingApprovals":0,
                 "projectId":null,"projectTitle":null}}
        """)
        let summary = try XCTUnwrap(ev.payload(ControlSessionSummary.self))
        switch summary.projectId {
        case .some(.none): break
        default: XCTFail("an explicit projectId null must survive as outer some / inner none")
        }
        switch summary.projectTitle {
        case .some(.none): break
        default: XCTFail("an explicit projectTitle null must survive as outer some / inner none")
        }
    }

    func testDecodesSessionEndedAndLegacyLifecycleAlias() throws {
        let ev = try decode("""
        {"type":"session.ended","sessionId":"s1","agentId":"a1","ts":"t",
         "data":{"status":"CANCELLED","runStatus":"CANCELLED","sessionState":"COMPLETED","runState":"CANCELLED","filingState":"ARCHIVED","endReason":"completed"}}
        """)
        XCTAssertEqual(ev.type, .sessionEnded)
        let d = try XCTUnwrap(ev.payload(ControlSessionEnded.self))
        XCTAssertEqual(d.status, .cancelled)
        XCTAssertEqual(d.runStatus, .cancelled)
        XCTAssertEqual(d.effectiveRunStatus, .cancelled)
        XCTAssertEqual(d.sessionState, .completed)
        // CANCELLED is a pre-collapse run state, so it decodes to the forward-compatibility
        // case and the legacy CANCELLED status resolves it to the single neutral terminal one.
        XCTAssertEqual(d.runState, .unknown)
        XCTAssertEqual(d.effectiveRunState, .ended)
        XCTAssertEqual(d.lifecycleState, .completed)
        XCTAssertEqual(d.effectiveLifecycleState, .completed)
        XCTAssertEqual(d.endReason, "completed")

        let natural = try decode("""
        {"type":"session.ended","sessionId":"s2","agentId":null,"ts":"t",
         "data":{"status":"SUCCEEDED","runStatus":"SUCCEEDED","sessionState":"COMPLETED",
                 "runState":"SUCCEEDED","lifecycleState":"OPEN","endReason":null}}
        """)
        let naturalPayload = try XCTUnwrap(natural.payload(ControlSessionEnded.self))
        XCTAssertNil(naturalPayload.endReason)
        XCTAssertEqual(naturalPayload.effectiveRunState, .succeeded)
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

    func testDecodesTheListNudgeEvents() throws {
        let agent = try decode("""
        {"type":"agent.changed","sessionId":"s1","agentId":"a1","ts":"t","data":{"agentId":"new"}}
        """)
        XCTAssertEqual(agent.type, .agentChanged)
        // The changed agent is in `data`; the envelope's agentId stays the calling session's.
        XCTAssertEqual(agent.agentId, "a1")
        let legacyAgentChange = try XCTUnwrap(agent.payload(ControlAgentChanged.self))
        XCTAssertEqual(legacyAgentChange.agentId, "new")
        XCTAssertNil(legacyAgentChange.affectsTaskRows,
                     "an older server is decoded conservatively during rolling upgrades")

        let task = try decode("""
        {"type":"task.changed","sessionId":"s1","agentId":null,"ts":"t","data":{"taskId":"t1"}}
        """)
        XCTAssertEqual(task.type, .taskChanged)
        let taskChange = try XCTUnwrap(task.payload(ControlTaskChanged.self))
        XCTAssertEqual(taskChange.taskId, "t1")
        XCTAssertNil(taskChange.taskIds)
        XCTAssertNil(taskChange.resync)
        XCTAssertEqual(taskChange.effectiveTaskIds, ["t1"])
        XCTAssertFalse(taskChange.canRefreshIncrementally,
                       "legacy taskId-only servers do not have the lightweight row endpoint")
    }

    func testAgentChangedCanExcludeProviderDefaultOnlyNudgesFromTaskRefresh() throws {
        let ev = try decode("""
        {"type":"agent.changed","sessionId":"s1","agentId":"a1","ts":"t",
         "data":{"agentId":"a1","affectsTaskRows":false}}
        """)

        let change = try XCTUnwrap(ev.payload(ControlAgentChanged.self))
        XCTAssertEqual(change.agentId, "a1")
        XCTAssertEqual(change.affectsTaskRows, false)
    }

    func testTaskChangedPayloadSupportsBulkIdsAndResync() throws {
        let bulk = try decode("""
        {"type":"task.changed","sessionId":"","agentId":null,"ts":"t",
         "data":{"taskId":"t1","taskIds":["t1","t2","", "t2"],"resync":true}}
        """)

        let change = try XCTUnwrap(bulk.payload(ControlTaskChanged.self))
        XCTAssertEqual(change.taskId, "t1")
        XCTAssertEqual(change.taskIds, ["t1", "t2", "", "t2"])
        XCTAssertEqual(change.resync, true)
        XCTAssertEqual(change.effectiveTaskIds, ["t1", "t2"],
                       "singular/bulk ids are normalized and deduplicated before scheduling")
        XCTAssertFalse(change.canRefreshIncrementally, "an explicit resync always wins")

        let bounded = ControlTaskChanged(taskIds: ["t1", "t2"], resync: false)
        XCTAssertTrue(bounded.canRefreshIncrementally)
        XCTAssertFalse(ControlTaskChanged(taskId: "t1", resync: false).canRefreshIncrementally,
                       "an explicit bounded array is the incremental protocol marker")
    }

    func testDecodesUserScopedLibraryEventsWithAnEmptySessionId() throws {
        // These belong to the owner, not to a session, so the server ships sessionId "". The field
        // is still PRESENT, which is what keeps them decodable while the ping (no field) isn't.
        for (raw, expected) in [("task.list.changed", ControlEventType.taskListChanged),
                                ("tag.changed", .tagChanged),
                                ("provider.changed", .providerChanged)] {
            let ev = try decode("""
            {"type":"\(raw)","sessionId":"","agentId":null,"ts":"t","data":{"id":"x1"}}
            """)
            XCTAssertEqual(ev.type, expected)
            XCTAssertEqual(ev.sessionId, "")
            XCTAssertNil(ev.agentId)
        }
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
