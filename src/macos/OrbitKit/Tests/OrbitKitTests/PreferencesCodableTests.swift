import XCTest
@testable import OrbitKit

/// Pins `GET /users/me` (now with createdAt + preferences) and the partial `me/preferences`
/// PATCH. `jsonObject` is shared from TasksCodableTests (same test target).
final class PreferencesCodableTests: XCTestCase {

    func testMeDecodesWithPreferences() throws {
        let json = """
        {"id":"u1","email":"a@b.com","name":"Jiang","role":"ADMIN","createdAt":"2026-06-01T00:00:00Z",
         "preferences":{"theme":"dark","defaultModel":"claude-opus-4-8","defaultPermissionMode":"dontAsk",
                        "defaultEffort":"high"}}
        """
        let u = try JSONDecoder().decode(User.self, from: Data(json.utf8))
        XCTAssertEqual(u.role, "ADMIN")
        XCTAssertEqual(u.preferences?.theme, "dark")
        XCTAssertEqual(u.preferences?.defaultModel, "claude-opus-4-8")
        XCTAssertEqual(u.preferences?.defaultPermissionMode, "dontAsk")
        XCTAssertEqual(u.preferences?.defaultEffort, "high")
    }

    /// A `me` payload from before the defaultEffort key existed must still decode (→ nil), so an
    /// old server / never-set account falls back to the model default instead of throwing.
    func testPreferencesToleratesMissingEffort() throws {
        let json = #"{"id":"u1","email":"a@b.com","preferences":{"theme":"light"}}"#
        let u = try JSONDecoder().decode(User.self, from: Data(json.utf8))
        XCTAssertNil(u.preferences?.defaultEffort)
    }

    /// The login payload omits createdAt/preferences — must still decode (→ nil).
    func testLoginUserToleratesMissingPrefs() throws {
        let u = try JSONDecoder().decode(User.self, from: Data(#"{"id":"u1","email":"a@b.com"}"#.utf8))
        XCTAssertNil(u.preferences)
        XCTAssertNil(u.createdAt)
    }

    /// The account-level seed for a new agent's orchestration switch. Absent on an account that
    /// never set it (→ nil), which reads as off — a capability is only ever handed out explicitly.
    func testPreferencesDecodesOrchestrationDefault() throws {
        let json = #"{"id":"u1","email":"a@b.com","preferences":{"defaultEnableOrchestration":true}}"#
        let u = try JSONDecoder().decode(User.self, from: Data(json.utf8))
        XCTAssertEqual(u.preferences?.defaultEnableOrchestration, true)

        let bare = #"{"id":"u1","email":"a@b.com","preferences":{"theme":"light"}}"#
        let old = try JSONDecoder().decode(User.self, from: Data(bare.utf8))
        XCTAssertNil(old.preferences?.defaultEnableOrchestration)
    }

    func testUpdatePreferencesIsPartial() throws {
        let obj = try jsonObject(UpdatePreferencesRequest(theme: "dark"))
        XCTAssertEqual(obj["theme"] as? String, "dark")
        XCTAssertFalse(obj.keys.contains("defaultModel"))          // omitted key → server keeps it
        XCTAssertFalse(obj.keys.contains("defaultPermissionMode"))
        XCTAssertFalse(obj.keys.contains("defaultEffort"))
        XCTAssertFalse(obj.keys.contains("defaultEnableOrchestration"))
    }

    /// Turning the seed off has to send `false`, not drop the key: an omitted key means "keep what
    /// you have", which would leave new agents being born with the grant.
    func testUpdatePreferencesOrchestrationOnly() throws {
        let obj = try jsonObject(UpdatePreferencesRequest(defaultEnableOrchestration: false))
        XCTAssertEqual(obj["defaultEnableOrchestration"] as? Bool, false)
        XCTAssertFalse(obj.keys.contains("theme"))
        XCTAssertFalse(obj.keys.contains("defaultPermissionMode"))
    }

    /// Sending only defaultEffort must emit just that key (so the shallow-merge keeps theme/model),
    /// preserve Ultra verbatim, and include "" when the composer clears the effort override.
    func testUpdatePreferencesEffortOnly() throws {
        let selected = try jsonObject(UpdatePreferencesRequest(defaultEffort: "ultra"))
        XCTAssertEqual(selected["defaultEffort"] as? String, "ultra")
        XCTAssertFalse(selected.keys.contains("theme"))
        XCTAssertFalse(selected.keys.contains("defaultModel"))

        let cleared = try jsonObject(UpdatePreferencesRequest(defaultEffort: ""))
        XCTAssertEqual(cleared["defaultEffort"] as? String, "")
    }
}
