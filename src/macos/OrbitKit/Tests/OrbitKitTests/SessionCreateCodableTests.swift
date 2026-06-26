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
        for key in ["title", "assignedRunnerId", "model", "permissionMode", "effort", "shell", "attachmentIds"] {
            XCTAssertFalse(obj.keys.contains(key), "expected \(key) omitted")
        }
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
}
