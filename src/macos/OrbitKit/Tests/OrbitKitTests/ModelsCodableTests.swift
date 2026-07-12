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
        XCTAssertEqual(PermissionMode.bypass.rawValue, "bypassPermissions")
        XCTAssertEqual(RunEventType.toolResult.rawValue, "tool_result")
        XCTAssertEqual(TaskStatus.inProgress.rawValue, "IN_PROGRESS")
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
          "defaultModel":"deepseek-v4-pro","futureField":true}]
        """#
        let list = try JSONDecoder().decode([ConfiguredProvider].self, from: Data(json.utf8))
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list[0].slug, "deepseek")
        XCTAssertEqual(list[0].label, "DeepSeek")
        XCTAssertEqual(list[0].runtime, "claude")
        XCTAssertEqual(list[0].defaultModel, "deepseek-v4-pro")
        XCTAssertEqual(list[0].models.map(\.value), ["deepseek-v4-pro", "deepseek-v4-lite"])
        XCTAssertEqual(list[0].models[0].contextWindow, 128_000)
        XCTAssertNil(list[0].models[1].contextWindow)
    }

    func testLoginResponseDecodes() throws {
        let json = #"{"accessToken":"jwt.abc.def","user":{"id":"u1","email":"a@b.com","name":"A","role":"ADMIN"}}"#
        let res = try JSONDecoder().decode(LoginResponse.self, from: Data(json.utf8))
        XCTAssertEqual(res.accessToken, "jwt.abc.def")
        XCTAssertEqual(res.user.email, "a@b.com")
    }
}
