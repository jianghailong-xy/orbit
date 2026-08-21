import XCTest
@testable import OrbitKit

/// Pins the `CreateSessionRequest` encode used by the macOS "New session" draft composer. It
/// relies on synthesized `encodeIfPresent`, so nil fields omit the key — the server reads omitted
/// `effort`/`shell` as "model default" / "normal message", while sending nulls would be wrong.
final class SessionCreateCodableTests: XCTestCase {

    /// A minimal draft (prompt + agent only) must omit every optional override.
    func testCreateOmitsNilOverrides() throws {
        let obj = try jsonObject(CreateSessionRequest(prompt: "do it", agentId: "ag1"))
        XCTAssertEqual(obj["prompt"] as? String, "do it")
        XCTAssertEqual(obj["agentId"] as? String, "ag1")
        for key in ["title", "assignedRunnerId", "provider", "model", "permissionMode", "effort", "shell", "attachmentIds"] {
            XCTAssertFalse(obj.keys.contains(key), "expected \(key) omitted")
        }
    }

    /// The new-session provider pick. Omitted means "inherit the agent's" server-side, so sending
    /// it only when the user actually picked is what keeps an untouched draft behaving as before.
    func testCreateSendsThePickedProviderOnlyWhenChosen() throws {
        let picked = try jsonObject(CreateSessionRequest(
            prompt: "do it", agentId: "ag1", provider: "deepseek"))
        XCTAssertEqual(picked["provider"] as? String, "deepseek")

        let inherited = try jsonObject(CreateSessionRequest(prompt: "do it", agentId: "ag1"))
        XCTAssertFalse(inherited.keys.contains("provider"))
    }

    /// A fully-configured draft sends every pill plus the shell flag.
    func testCreateEncodesAllFields() throws {
        let obj = try jsonObject(CreateSessionRequest(
            prompt: "ls", agentId: "ag1", model: "claude-opus-4-8",
            permissionMode: "dontAsk", effort: "high", shell: true))
        XCTAssertEqual(obj["model"] as? String, "claude-opus-4-8")
        XCTAssertEqual(obj["permissionMode"] as? String, "dontAsk")
        XCTAssertEqual(obj["effort"] as? String, "high")
        XCTAssertEqual(obj["shell"] as? Bool, true)
    }

    /// OpenCode's empty model is an intentional sentinel, not an omitted override; its broad
    /// fallback effort set must likewise reach the runner unchanged.
    func testOpenCodeDefaultModelAndEffortPassThrough() throws {
        let obj = try jsonObject(CreateSessionRequest(
            prompt: "do it", agentId: "ag1", model: "", effort: "max"))
        XCTAssertTrue(obj.keys.contains("model"))
        XCTAssertEqual(obj["model"] as? String, "")
        XCTAssertEqual(obj["effort"] as? String, "max")
    }

    /// Ultra is a real Codex wire value, not a display-only alias. Every session write path used by
    /// the composer must preserve it verbatim rather than folding it into the adjacent Max level.
    func testCodexUltraPassesThroughEverySessionWrite() throws {
        let created = try jsonObject(CreateSessionRequest(
            prompt: "do it", agentId: "ag1", model: "gpt-5.6-sol", effort: "ultra"))
        XCTAssertEqual(created["effort"] as? String, "ultra")

        let resumed = try jsonObject(ResumeRequest(
            clientTurnId: "c1", content: "continue", model: "gpt-5.6-sol", effort: "ultra"))
        XCTAssertEqual(resumed["effort"] as? String, "ultra")

        let updated = try jsonObject(ConfigUpdateRequest(effort: "ultra"))
        XCTAssertEqual(updated["effort"] as? String, "ultra")
    }
}
