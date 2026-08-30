import XCTest
@testable import OrbitKit

final class ModelsCodableTests: XCTestCase {

    func testRunEventDecodesWithNestedPayload() throws {
        let json = #"{"seq":4,"type":"tool_use","ts":"2026-06-25T00:00:00Z","turnId":"tr1","payload":{"toolUseId":"t1","name":"Bash","input":{"command":"ls -la"}}}"#
        let ev = try JSONDecoder().decode(RunEvent.self, from: Data(json.utf8))
        XCTAssertEqual(ev.seq, 4)
        XCTAssertEqual(ev.type, .toolUse)
        XCTAssertEqual(ev.turnId, "tr1")
        XCTAssertEqual(ev.payload["name"]?.stringValue, "Bash")
        XCTAssertEqual(ev.payload["input"]?["command"]?.stringValue, "ls -la")
    }

    func testUnknownEventTypeFallsBackNotThrows() throws {
        let json = #"{"seq":9,"type":"some_future_event","payload":{}}"#
        let ev = try JSONDecoder().decode(RunEvent.self, from: Data(json.utf8))
        XCTAssertEqual(ev.type, .unknown)
        XCTAssertTrue(ev.type.isDurable)   // unknown is treated as durable for seq bookkeeping
    }

    func testRunEventToleratesMissingPayload() throws {
        let ev = try JSONDecoder().decode(RunEvent.self, from: Data(#"{"seq":1,"type":"system"}"#.utf8))
        XCTAssertEqual(ev.type, .system)
        XCTAssertEqual(ev.payload, .null)
    }

    func testEnumRawValuesMatchWireStrings() {
        XCTAssertEqual(RunStatus.awaitingInput.rawValue, "AWAITING_INPUT")
        XCTAssertEqual(SessionRunState.succeeded.rawValue, "SUCCEEDED")
        XCTAssertEqual(SessionRunState.ended.rawValue, "ENDED")
        XCTAssertEqual(SessionLifecycleState.completed.rawValue, "COMPLETED")
        XCTAssertEqual(PermissionMode.bypass.rawValue, "bypassPermissions")
        XCTAssertEqual(RunEventType.toolResult.rawValue, "tool_result")
        XCTAssertEqual(RunEventType.toolOutput.rawValue, "tool_output")
        XCTAssertFalse(RunEventType.toolOutput.isDurable)
        XCTAssertEqual(TaskStatus.inProgress.rawValue, "IN_PROGRESS")
    }

    func testNewSessionStateEnumsDecodeUnknownValuesLeniently() throws {
        XCTAssertEqual(try JSONDecoder().decode(SessionRunState.self,
                                                from: Data(#""FUTURE_RUN_STATE""#.utf8)), .unknown)
        XCTAssertEqual(try JSONDecoder().decode(SessionLifecycleState.self,
                                                from: Data(#""FUTURE_FILING_STATE""#.utf8)), .unknown)
        XCTAssertEqual(try JSONDecoder().decode(SessionResumeBlockedReason.self,
                                                from: Data(#""FUTURE_REASON""#.utf8)), .unknown)
    }

    func testLegacyArchivedValueNormalizesToCompletedLifecycle() throws {
        XCTAssertEqual(try JSONDecoder().decode(SessionLifecycleState.self,
                                                from: Data(#""ARCHIVED""#.utf8)), .completed)
        XCTAssertEqual(try JSONDecoder().decode(SessionLifecycleState.self,
                                                from: Data(#""COMPLETED""#.utf8)), .completed)
    }

    func testSessionDecodesCapabilitiesAndOldPayloadStillWorks() throws {
        let json = #"""
        {"id":"s1","title":"Done","status":"SUCCEEDED",
         "capabilities":{"canSend":false,"canResume":false,
           "resumeBlockedReason":"MISSING_CONTEXT","canComplete":true,"canRestore":false}}
        """#
        let session = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertFalse(try XCTUnwrap(session.capabilities).canSend)
        XCTAssertFalse(try XCTUnwrap(session.capabilities).canResume)
        XCTAssertEqual(session.capabilities?.resumeBlockedReason, .missingContext)
        XCTAssertTrue(try XCTUnwrap(session.capabilities).canComplete)
        XCTAssertFalse(try XCTUnwrap(session.capabilities).canRestore)

        let old = try JSONDecoder().decode(
            Session.self, from: Data(#"{"id":"s2","title":null,"status":"RUNNING"}"#.utf8))
        XCTAssertNil(old.capabilities)
        XCTAssertEqual(old.effectiveLifecycleState, .open)

        // Old control planes omit lifecycleState but already expose the legacy completion timestamp. It is a
        // safer compatibility source than sessionState=COMPLETED, which can also mean Succeeded + Open.
        let legacyCompleted = try JSONDecoder().decode(
            Session.self,
            from: Data(#"{"id":"s3","title":"Filed","status":"SUCCEEDED","sessionState":"COMPLETED","archivedAt":"2026-08-01T00:00:00Z","deletedAt":null}"#.utf8))
        XCTAssertEqual(legacyCompleted.effectiveLifecycleState, .completed)
        XCTAssertEqual(legacyCompleted.completedAt, "2026-08-01T00:00:00Z")
        let oldTrash = try JSONDecoder().decode(
            Session.self,
            from: Data(#"{"id":"s4","title":"Trash","status":"FAILED","archivedAt":"2026-07-01T00:00:00Z","deletedAt":"2026-08-01T00:00:00Z"}"#.utf8))
        XCTAssertEqual(oldTrash.effectiveLifecycleState, .trash)
    }


    func testLegacyCanArchiveCapabilityNormalizesToCanComplete() throws {
        let capabilities = try JSONDecoder().decode(
            SessionCapabilities.self,
            from: Data(#"{"canSend":false,"canResume":false,"canArchive":true,"canRestore":false}"#.utf8))
        XCTAssertTrue(capabilities.canComplete)
    }

    func testCompletedModelsEncodeOnlyCanonicalNames() throws {
        XCTAssertEqual(String(decoding: try JSONEncoder().encode(SessionLifecycleState.completed),
                              as: UTF8.self), #""COMPLETED""#)

        let capabilities = SessionCapabilities(canSend: false, canResume: false,
                                               canComplete: true, canRestore: false)
        let capabilityObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(capabilities)) as? [String: Any])
        XCTAssertEqual(capabilityObject["canComplete"] as? Bool, true)
        XCTAssertNil(capabilityObject["canArchive"])

        let session = Session(id: "s5", title: "Done", status: .succeeded,
                              lifecycleState: .completed, completedAt: "2026-08-01T00:00:00Z",
                              agentId: nil, assignedRunnerId: nil,
                              pendingApprovals: nil, branch: nil, updatedAt: nil)
        let sessionObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(session)) as? [String: Any])
        XCTAssertEqual(sessionObject["lifecycleState"] as? String, "COMPLETED")
        XCTAssertNil(sessionObject["filingState"])
        XCTAssertEqual(sessionObject["completedAt"] as? String, "2026-08-01T00:00:00Z")
        XCTAssertNil(sessionObject["archivedAt"])
    }

    func testSessionRunStateLiveIncludesQueuedWork() {
        for state: SessionRunState in [.queued, .running, .awaitingInput, .interrupted] {
            XCTAssertTrue(state.isLive, state.rawValue)
        }
        for state: SessionRunState in [.succeeded, .failed, .ended] {
            XCTAssertFalse(state.isLive, state.rawValue)
        }
    }

    func testJSONValueScalarCoercions() {
        let obj: JSONValue = .object(["n": .int(42), "b": .bool(true), "s": .string("x")])
        XCTAssertEqual(obj["n"]?.intValue, 42)
        XCTAssertEqual(obj["n"]?.asString, "42")
        XCTAssertEqual(obj["b"]?.boolValue, true)
        XCTAssertNil(obj["missing"]?.stringValue)
    }

    func testConfiguredProviderDecodesToleratingUnknownAndMissingFields() throws {
        // The GET /api/providers Phase 1 shape, plus an unknown future field (must be ignored)
        // and a model row without contextWindow (optional).
        let json = #"""
        [{"slug":"deepseek","label":"DeepSeek","runtime":"claude",
          "models":[{"value":"deepseek-v4-pro","label":"DeepSeek V4 Pro","contextWindow":128000},
                    {"value":"deepseek-v4-lite","label":"DeepSeek V4 Lite"}],
          "defaultModel":"deepseek-v4-pro","presetSlug":"deepseek","futureField":true},
         {"slug":"my-endpoint","label":"my endpoint","runtime":"claude","models":[],
          "defaultModel":null,"presetSlug":null}]
        """#
        let list = try JSONDecoder().decode([ConfiguredProvider].self, from: Data(json.utf8))
        XCTAssertEqual(list.count, 2)
        XCTAssertEqual(list[0].slug, "deepseek")
        XCTAssertEqual(list[0].label, "DeepSeek")
        XCTAssertEqual(list[0].runtime, "claude")
        XCTAssertEqual(list[0].defaultModel, "deepseek-v4-pro")
        XCTAssertEqual(list[0].models.map(\.value), ["deepseek-v4-pro", "deepseek-v4-lite"])
        XCTAssertEqual(list[0].models[0].contextWindow, 128_000)
        XCTAssertNil(list[0].models[1].contextWindow)
        // The preset is what the new-session picker brands the row with; a self-maintained
        // endpoint has none and falls back to the neutral glyph.
        XCTAssertEqual(list[0].presetSlug, "deepseek")
        XCTAssertNil(list[1].presetSlug)
        // A third-party vendor keeps its own list; the flag is absent (→ nil, treated as false).
        XCTAssertNil(list[0].modelsFromRuntime)
    }

    /// A server that predates `presetSlug` must still decode — the field is additive.
    func testConfiguredProviderDecodesWithoutPresetSlug() throws {
        let json = #"[{"slug":"deepseek","label":"DeepSeek","models":[],"defaultModel":null}]"#
        let list = try JSONDecoder().decode([ConfiguredProvider].self, from: Data(json.utf8))
        XCTAssertNil(list[0].presetSlug)
    }

    /// An Anthropic/OpenAI BYOK row carries `modelsFromRuntime:true`, telling the pickers to follow
    /// the borrowed runtime's live catalog instead of the shipped fallback `models`.
    func testConfiguredProviderDecodesModelsFromRuntime() throws {
        let json = #"""
        [{"slug":"anthropic","label":"Anthropic (Claude)","runtime":"claude",
          "models":[{"value":"claude-opus-4-8","label":"Claude Opus 4.8"}],
          "defaultModel":"claude-opus-4-8","presetSlug":"anthropic","modelsFromRuntime":true}]
        """#
        let list = try JSONDecoder().decode([ConfiguredProvider].self, from: Data(json.utf8))
        XCTAssertEqual(list[0].modelsFromRuntime, true)
    }

    func testLoginResponseDecodes() throws {
        let json = #"{"accessToken":"jwt.abc.def","user":{"id":"u1","email":"a@b.com","name":"A","role":"ADMIN"}}"#
        let res = try JSONDecoder().decode(LoginResponse.self, from: Data(json.utf8))
        XCTAssertEqual(res.accessToken, "jwt.abc.def")
        XCTAssertEqual(res.user.email, "a@b.com")
    }
}
