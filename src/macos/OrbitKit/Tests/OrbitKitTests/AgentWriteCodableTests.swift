import XCTest
@testable import OrbitKit

/// Pins the extended `Agent` decode (detail/form fields) and the create/update encode. Update
/// relies on synthesized `encodeIfPresent` so nil omits the key — verified here so a future
/// hand-rolled `encode(to:)` can't silently start sending nulls the server would misread.
final class AgentWriteCodableTests: XCTestCase {

    func testAgentDecodesFormFields() throws {
        let json = """
        {"id":"a1","name":"dev","model":"claude-opus-4-8","permissionMode":"dontAsk","workDir":"/repo",
         "description":"d","appendSystemPrompt":"be nice","allowedTools":["Bash","Edit"],
         "disallowedTools":[],"maxTurns":40,"maxBudgetUsd":5.0,"runnerId":"r1","targetLabels":["mac"],
         "env":{"FOO":"bar"},"enabled":true,"autoInitGit":false}
        """
        let a = try JSONDecoder().decode(Agent.self, from: Data(json.utf8))
        XCTAssertEqual(a.allowedTools, ["Bash", "Edit"])
        XCTAssertEqual(a.maxTurns, 40)
        XCTAssertEqual(a.maxBudgetUsd, 5.0)
        XCTAssertEqual(a.env?["FOO"], "bar")
        XCTAssertEqual(a.enabled, true)
        XCTAssertEqual(a.autoInitGit, false)
        XCTAssertEqual(a.targetLabels, ["mac"])
    }

    /// A list payload that omits the form fields must still decode (all optional → nil).
    func testAgentTolerantOfMissingFields() throws {
        let a = try JSONDecoder().decode(Agent.self, from: Data(#"{"id":"a1","name":"dev"}"#.utf8))
        XCTAssertEqual(a.name, "dev")
        XCTAssertNil(a.allowedTools)
        XCTAssertNil(a.enabled)
    }

    /// The orchestration grant rides the list payload so Settings can count what actually holds
    /// it. Absent on a server too old to send it — which reads as not granted, never as unknown.
    func testAgentDecodesOrchestrationGrant() throws {
        let json = #"{"id":"a1","name":"dev","enableOrchestration":true}"#
        let granted = try JSONDecoder().decode(Agent.self, from: Data(json.utf8))
        XCTAssertEqual(granted.enableOrchestration, true)

        let old = try JSONDecoder().decode(Agent.self, from: Data(#"{"id":"a1","name":"dev"}"#.utf8))
        XCTAssertNil(old.enableOrchestration)
    }

    func testUpdateOmitsNilKeys() throws {
        let obj = try jsonObject(UpdateAgentRequest(name: "new", enabled: false))
        XCTAssertEqual(obj["name"] as? String, "new")
        XCTAssertEqual(obj["enabled"] as? Bool, false)   // false is sent (present, non-nil)
        XCTAssertFalse(obj.keys.contains("model"))       // nil omitted
        XCTAssertFalse(obj.keys.contains("allowedTools"))
    }

    func testCreateEncodes() throws {
        let obj = try jsonObject(CreateAgentRequest(name: "dev", model: "gpt-5.6-sol",
                                                    allowedTools: ["Bash"], env: ["K": "V"]))
        XCTAssertEqual(obj["name"] as? String, "dev")
        XCTAssertEqual(obj["model"] as? String, "gpt-5.6-sol")
        XCTAssertEqual(obj["allowedTools"] as? [String], ["Bash"])
        XCTAssertEqual((obj["env"] as? [String: String])?["K"], "V")
        XCTAssertFalse(obj.keys.contains("description"))
    }

    /// An agent holds no provider, so no agent write may carry one — a client that still sent it
    /// would be asking the server to ignore it.
    func testAgentWritesNeverCarryAProvider() throws {
        let created = try jsonObject(CreateAgentRequest(name: "dev", model: "gpt-5.6-sol"))
        let updated = try jsonObject(UpdateAgentRequest(name: "new", model: "gpt-5.6-sol"))
        XCTAssertFalse(created.keys.contains("provider"))
        XCTAssertFalse(updated.keys.contains("provider"))
    }

    func testReorderEncodes() throws {
        let obj = try jsonObject(ReorderAgentsRequest(ids: ["a", "b", "c"]))
        XCTAssertEqual(obj["ids"] as? [String], ["a", "b", "c"])
    }
}
