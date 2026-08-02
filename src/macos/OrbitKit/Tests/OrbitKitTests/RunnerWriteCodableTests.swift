import XCTest
@testable import OrbitKit

/// Pins the runner write DTOs + the skills/commands that ride the GET /runners payload
/// (the Skills page's only data source) and the enrollment/rotate responses.
final class RunnerWriteCodableTests: XCTestCase {

    func testRunnerDecodesSkillsAndCommands() throws {
        let json = """
        {"id":"r1","name":"wikova","displayName":"Wikova","status":"ONLINE","online":true,
         "version":"0.1.34","maxConcurrent":8,
         "runtimeDefaultModels":{"claude":"claude-opus-5","codex":"gpt-5.6-sol"},
         "skills":[{"name":"deep-research","description":"fan-out research","type":"skill","agentId":"a1"}],
         "commands":[{"name":"commit","description":"smart commit","type":"command","provider":"kimi"}]}
        """
        let r = try JSONDecoder().decode(Runner.self, from: Data(json.utf8))
        XCTAssertEqual(r.displayName, "Wikova")
        XCTAssertEqual(r.skills?.first?.name, "deep-research")
        XCTAssertEqual(r.skills?.first?.type, "skill")
        XCTAssertEqual(r.skills?.first?.agentId, "a1")            // project-scoped
        XCTAssertNil(r.commands?.first?.agentId)                  // host-level
        XCTAssertEqual(r.commands?.first?.name, "commit")
        XCTAssertEqual(r.runtimeDefaultModels?["claude"], "claude-opus-5")
        XCTAssertEqual(r.runtimeDefaultModels?["codex"], "gpt-5.6-sol")
        XCTAssertNil(r.skills?.first?.provider)                   // legacy Claude payload
        XCTAssertEqual(r.commands?.first?.provider, "kimi")
        // Identity is stable & distinguishes provider plus host/agent scope.
        XCTAssertEqual(r.skills?.first?.id, "legacy:a1:skill:deep-research")
        XCTAssertEqual(r.commands?.first?.id, "kimi:host:command:commit")
    }

    /// An older runner payload without skills/commands/displayName still decodes.
    func testRunnerTolerantOfMissingExtras() throws {
        let r = try JSONDecoder().decode(Runner.self, from: Data(#"{"id":"r1","name":"box"}"#.utf8))
        XCTAssertNil(r.skills)
        XCTAssertNil(r.displayName)
        XCTAssertNil(r.runtimeDefaultModels)
    }

    func testRunnerDecodesOpenCodeModelCatalog() throws {
        let json = """
        {"id":"r1","name":"box","modelCatalog":{"opencode":[
          {"value":"anthropic/claude-sonnet-4","label":"Claude Sonnet 4",
           "contextWindow":200000,"reasoningLevels":["low","high"]}
        ]}}
        """
        let runner = try JSONDecoder().decode(Runner.self, from: Data(json.utf8))
        let model = try XCTUnwrap(runner.modelCatalog?.opencode?.first)
        XCTAssertEqual(model.value, "anthropic/claude-sonnet-4")
        XCTAssertEqual(model.contextWindow, 200_000)
        XCTAssertEqual(model.reasoningLevels, ["low", "high"])
    }

    func testUpdateRunnerEncoding() throws {
        let clear = try jsonObject(UpdateRunnerRequest(displayName: ""))
        XCTAssertEqual(clear["displayName"] as? String, "")       // "" clears the alias (sent, not omitted)
        XCTAssertFalse(clear.keys.contains("maxConcurrent"))

        let cap = try jsonObject(UpdateRunnerRequest(maxConcurrent: 12))
        XCTAssertEqual(cap["maxConcurrent"] as? Int, 12)
        XCTAssertFalse(cap.keys.contains("displayName"))          // nil omits
    }

    func testCreateEnrollmentTokenEncoding() throws {
        let obj = try jsonObject(CreateEnrollmentTokenRequest(label: "mac", ttlHours: 24))
        XCTAssertEqual(obj["label"] as? String, "mac")
        XCTAssertEqual(obj["ttlHours"] as? Int, 24)
    }

    func testResponsesDecode() throws {
        let rot = try JSONDecoder().decode(RotateTokenResponse.self, from: Data(#"{"token":"abc"}"#.utf8))
        XCTAssertEqual(rot.token, "abc")

        // create returns the token once…
        let created = try JSONDecoder().decode(EnrollmentTokenInfo.self,
            from: Data(#"{"id":"e1","token":"secret","label":"mac","expiresAt":"2026-07-01T00:00:00Z"}"#.utf8))
        XCTAssertEqual(created.token, "secret")
        // …the list omits it.
        let listed = try JSONDecoder().decode(EnrollmentTokenInfo.self,
            from: Data(#"{"id":"e1","label":"mac","expiresAt":"2026-07-01T00:00:00Z"}"#.utf8))
        XCTAssertNil(listed.token)

        let ok = try JSONDecoder().decode(OkResponse.self, from: Data(#"{"ok":true}"#.utf8))
        XCTAssertEqual(ok.ok, true)
    }
}
