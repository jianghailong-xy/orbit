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

    /// The account's one orchestration switch. Absent on an account that never touched it (→ nil),
    /// which reads as on — only turning it off is ever written.
    func testPreferencesDecodesTheOrchestrationSwitch() throws {
        let json = #"{"id":"u1","email":"a@b.com","preferences":{"enableOrchestration":false}}"#
        let u = try JSONDecoder().decode(User.self, from: Data(json.utf8))
        XCTAssertEqual(u.preferences?.enableOrchestration, false)

        let bare = #"{"id":"u1","email":"a@b.com","preferences":{"theme":"light"}}"#
        let old = try JSONDecoder().decode(User.self, from: Data(bare.utf8))
        XCTAssertNil(old.preferences?.enableOrchestration)
    }

    /// The two alert switches Settings shows on every client. Absent means on — only opting out is
    /// ever written — so an account that never touched them decodes nil, which reads as on.
    func testPreferencesDecodesTheAlertSwitches() throws {
        let json = #"{"id":"u1","email":"a@b.com","preferences":{"notifySessionFinished":false,"notifyAgentMessage":true}}"#
        let u = try JSONDecoder().decode(User.self, from: Data(json.utf8))
        XCTAssertEqual(u.preferences?.notifySessionFinished, false)
        XCTAssertEqual(u.preferences?.notifyAgentMessage, true)

        let bare = #"{"id":"u1","email":"a@b.com","preferences":{"theme":"light"}}"#
        let old = try JSONDecoder().decode(User.self, from: Data(bare.utf8))
        XCTAssertNil(old.preferences?.notifySessionFinished)
        XCTAssertNil(old.preferences?.notifyAgentMessage)
    }

    /// Flipping one switch sends that key alone, `false` included: an omitted key keeps what the
    /// server has, so the other switch — and every other preference — is left alone.
    func testUpdatePreferencesSendsOnlyTheSwitchThatMoved() throws {
        let obj = try jsonObject(UpdatePreferencesRequest(notifySessionFinished: false))
        XCTAssertEqual(obj["notifySessionFinished"] as? Bool, false)
        XCTAssertFalse(obj.keys.contains("notifyAgentMessage"))
        XCTAssertFalse(obj.keys.contains("theme"))
        XCTAssertEqual(obj.count, 1)
    }

    func testUpdatePreferencesIsPartial() throws {
        let obj = try jsonObject(UpdatePreferencesRequest(theme: "dark"))
        XCTAssertEqual(obj["theme"] as? String, "dark")
        XCTAssertFalse(obj.keys.contains("defaultModel"))          // omitted key → server keeps it
        XCTAssertFalse(obj.keys.contains("defaultPermissionMode"))
        XCTAssertFalse(obj.keys.contains("defaultEffort"))
        XCTAssertFalse(obj.keys.contains("enableOrchestration"))
        XCTAssertFalse(obj.keys.contains("notifySessionFinished"))
        XCTAssertFalse(obj.keys.contains("notifyAgentMessage"))
    }

    /// Turning the switch off has to send `false`, not drop the key: an omitted key means "keep what
    /// you have", which would leave every session able to orchestrate.
    func testUpdatePreferencesOrchestrationOnly() throws {
        let obj = try jsonObject(UpdatePreferencesRequest(enableOrchestration: false))
        XCTAssertEqual(obj["enableOrchestration"] as? Bool, false)
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

    /// The account's switch for smart model selection: off unless it is exactly `true`. Absent (an
    /// account that never touched it) and anything but a boolean decode nil — never a failed `me`.
    func testPreferencesDecodesTheModelRoutingSwitchLeniently() throws {
        func prefs(_ body: String) throws -> UserPreferences? {
            try JSONDecoder().decode(User.self, from: Data(#"{"id":"u1","email":"a@b.com","preferences":\#(body)}"#.utf8)).preferences
        }
        XCTAssertEqual(try prefs(#"{"modelRouting":true}"#)?.modelRouting, true)
        XCTAssertEqual(try prefs(#"{"modelRouting":true}"#)?.smartModelSelection, true)
        XCTAssertEqual(try prefs(#"{"modelRouting":false}"#)?.smartModelSelection, false)
        let bare = try prefs(#"{"theme":"light"}"#)
        XCTAssertNil(bare?.modelRouting)
        XCTAssertEqual(bare?.smartModelSelection, false, "absent is off")
        for odd in [#""true""#, "1", "null", #"{"on":true}"#] {
            let p = try prefs(#"{"theme":"dark","modelRouting":\#(odd)}"#)
            XCTAssertNil(p?.modelRouting, odd)
            XCTAssertEqual(p?.smartModelSelection, false, odd)
            XCTAssertEqual(p?.theme, "dark", "the rest of the preferences still decode")
        }
    }

    /// The account's Session recaps switch: on unless it is exactly `false`. Absent (an account that
    /// never touched it) and anything but a boolean decode nil — never a failed `me` — and both read
    /// as on, so only opting out is ever written.
    func testPreferencesDecodesTheSessionRecapsSwitchLeniently() throws {
        func prefs(_ body: String) throws -> UserPreferences? {
            try JSONDecoder().decode(User.self, from: Data(#"{"id":"u1","email":"a@b.com","preferences":\#(body)}"#.utf8)).preferences
        }
        XCTAssertEqual(try prefs(#"{"recaps":false}"#)?.showRecaps, false)
        XCTAssertEqual(try prefs(#"{"recaps":true}"#)?.showRecaps, true)
        let bare = try prefs(#"{"theme":"light"}"#)
        XCTAssertNil(bare?.recaps)
        XCTAssertEqual(bare?.showRecaps, true, "absent is on")
        for odd in [#""true""#, "1", "null", #"{"on":true}"#] {
            let p = try prefs(#"{"theme":"dark","recaps":\#(odd)}"#)
            XCTAssertNil(p?.recaps, odd)
            XCTAssertEqual(p?.showRecaps, true, odd)
            XCTAssertEqual(p?.theme, "dark", "the rest of the preferences still decode")
        }
    }

    /// Flipping it sends `recaps` alone, `false` included — PATCH /users/me/preferences {recaps}, as
    /// the web Settings page does.
    func testUpdatePreferencesSessionRecapsOnly() throws {
        for value in [true, false] {
            let obj = try jsonObject(UpdatePreferencesRequest(recaps: value))
            XCTAssertEqual(obj["recaps"] as? Bool, value)
            XCTAssertEqual(obj.count, 1)
        }
        XCTAssertFalse(try jsonObject(UpdatePreferencesRequest(theme: "dark")).keys.contains("recaps"))
    }

    /// Flipping it sends `modelRouting` alone, `false` included — PATCH /users/me/preferences
    /// {modelRouting}, as the web Settings page does.
    func testUpdatePreferencesModelRoutingOnly() throws {
        for value in [true, false] {
            let obj = try jsonObject(UpdatePreferencesRequest(modelRouting: value))
            XCTAssertEqual(obj["modelRouting"] as? Bool, value)
            XCTAssertEqual(obj.count, 1)
        }
        XCTAssertFalse(try jsonObject(UpdatePreferencesRequest(theme: "dark")).keys.contains("modelRouting"))
    }

    func testModelPreferencesRoundTripAndRemainOptional() throws {
        let json = #"{"preferences":{"defaultModels":{"codex":"gpt-6.1-sol","claude":"claude-sonnet-5"}},"id":"u1","email":"a@b.com"}"#
        let user = try JSONDecoder().decode(User.self, from: Data(json.utf8))
        XCTAssertEqual(user.preferences?.defaultModels?["codex"], "gpt-6.1-sol")
        let old = try JSONDecoder().decode(UserPreferences.self, from: Data("{}".utf8))
        XCTAssertNil(old.defaultModels)
        let patch = try jsonObject(UpdatePreferencesRequest(defaultModels: ["codex": "gpt-6.1-sol"]))
        XCTAssertEqual(patch["defaultModels"] as? [String: String], ["codex": "gpt-6.1-sol"])
        XCTAssertEqual(patch.count, 1)
    }
}
