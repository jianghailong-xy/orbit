import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// Stands in for the doors a settings change uses: records what reached it and answers as the server does.
private final class SettingsDoorProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, data: Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let answer = Self.handler?(request) ?? (status: 500, data: Data())
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// docs/settings-from-conversation-design.md §8 on the Apple clients: the SETTINGS_CHANGE payload, `changedBy` on
/// `/users/me`, apply, Undo, the link and the row line.
final class SettingsFromConversationTests: XCTestCase {
    private let requestID = "0195f3a2-0000-7000-8000-000000000001"

    override func tearDown() {
        SettingsDoorProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SettingsDoorProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private func request(state: String = "PENDING") throws -> OwnerRequest {
        let json = """
        {"id":"\(requestID)","kind":"SETTINGS_CHANGE","state":"\(state)","title":"Change 2 settings?",
         "why":"You asked to read replies in Chinese.","blocksTaskIds":[],"askedBySessionId":"s1",
         "createdAt":"2026-11-20T10:00:00.000Z",
         "payload":{"changes":[
           {"key":"translationEnabled","from":false,"to":true,"tier":1},
           {"key":"translationLanguage","from":"en","to":"zh-Hans","tier":1},
           {"key":"notAKey","from":1,"to":2,"tier":1},
           {"key":"defaultPermissionMode","from":"default","to":"plan","tier":2}]}}
        """
        return try JSONDecoder().decode(OwnerRequest.self, from: Data(json.utf8))
    }

    func testSettingsChangeKindAndPayloadDecode() throws {
        let decoded = try request()
        XCTAssertEqual(decoded.kind, .settingsChange)
        let entries = SettingsFromConversation.entries(decoded.payload)
        XCTAssertEqual(entries.map(\.key), ["translationEnabled", "translationLanguage", "defaultPermissionMode"],
                       "an entry naming no known key is left out")
        XCTAssertEqual(entries[0].from, .bool(false))
        XCTAssertEqual(entries[2].tier, 2)
    }

    func testValuesReadAsSettingsShowThem() {
        XCTAssertEqual(SettingsFromConversation.valueLabel("translationEnabled", .bool(true)), "On")
        XCTAssertEqual(SettingsFromConversation.valueLabel("translationEnabled", .bool(false)), "Off")
        XCTAssertEqual(SettingsFromConversation.valueLabel("translationLanguage", .string("zh-Hans")), "Chinese (Simplified)")
        XCTAssertEqual(SettingsFromConversation.valueLabel("theme", .string("dark")), "Dark")
        XCTAssertEqual(SettingsFromConversation.valueLabel("optimizeFor", .string("cost")), "Cost")
        XCTAssertEqual(SettingsFromConversation.valueLabel("defaultPermissionMode", .string("acceptEdits")), "Accept Edits")
        XCTAssertEqual(SettingsFromConversation.valueLabel("subagentBlockedProviders", .array([])), "None")
        XCTAssertEqual(SettingsFromConversation.valueLabel("cardFreeTaskCreates", .int(3)), "3")
    }

    func testRowsShareAPathLineAndTheCardNamesWhereTheyAre() throws {
        let groups = SettingsFromConversation.groups(SettingsFromConversation.entries(try request().payload))
        XCTAssertEqual(groups.map(\.path), ["Settings › General › Translation", "Settings › General › New sessions"])
        XCTAssertEqual(groups[0].entries.count, 2)
        XCTAssertEqual(SettingsFromConversation.place("agentLanguage")?.key, "translationAgentLanguage")
        XCTAssertNil(SettingsFromConversation.place("nonsense"))
        XCTAssertEqual(SettingsFromConversation.pathLabel(forKey: "notifyAgentMessage"), "Settings › Notifications")
        XCTAssertNil(SettingsFromConversation.pathLabel(forKey: "defaultModel"))
    }

    func testCopyCountsSettings() {
        XCTAssertEqual(SettingsChangeCopy.heading(1), "⚙️ Confirm: change 1 setting?")
        XCTAssertEqual(SettingsChangeCopy.heading(2), "⚙️ Confirm: change 2 settings?")
        XCTAssertEqual(SettingsChangeCopy.changed(2), "✓ Changed 2 settings")
        XCTAssertEqual(OwnerRequests.primaryLabel(.settingsChange), "Save changes")
    }

    func testChangedByDecodesLeniently() throws {
        let json = """
        {"id":"u1","email":"a@b.c","changedBy":{"translationEnabled":{"sessionId":"s1","requestId":"\(requestID)",
         "at":"2026-11-20T10:00:00.000Z","from":false,"sessionTitle":"Reading replies"}}}
        """
        let user = try JSONDecoder().decode(User.self, from: Data(json.utf8))
        let mark = try XCTUnwrap(user.changedBy?["translationEnabled"])
        XCTAssertEqual(mark.sessionTitle, "Reading replies")
        let now = try XCTUnwrap(RelativeTime.parse("2026-11-20T10:02:00.000Z"))
        XCTAssertEqual(SettingsFromConversation.changedLine(mark, now: now), "Turned on from Reading replies · 2m ago · ")
        let bare = try JSONDecoder().decode(User.self, from: Data(#"{"id":"u1","email":"a@b.c"}"#.utf8))
        XCTAssertNil(bare.changedBy)
    }

    func testTheRowLineLeadAndConversationName() {
        func mark(_ from: JSONValue?, title: String?) -> SettingChangedBy {
            SettingChangedBy(sessionId: "s", requestId: "r", at: "2026-11-20T10:00:00Z", from: from, sessionTitle: title)
        }
        XCTAssertEqual(SettingsFromConversation.changedLead(mark(.bool(true), title: "x")), "Turned off from")
        XCTAssertEqual(SettingsFromConversation.changedLead(mark(.bool(false), title: "x")), "Turned on from")
        XCTAssertEqual(SettingsFromConversation.changedLead(mark(.string("en"), title: "x")), "Set from")
        XCTAssertEqual(SettingsFromConversation.changedConversation(mark(nil, title: nil)), "a conversation")
        XCTAssertEqual(SettingsFromConversation.changedConversation(mark(nil, title: "")), "Untitled conversation")
    }

    func testUndoPutsBackOnlyWhatThisCardStillMarks() throws {
        let decoded = try request(state: "DONE")
        let json = """
        {"id":"u1","email":"a@b.c","changedBy":{
          "translationEnabled":{"sessionId":"s1","requestId":"\(requestID)","at":"2026-11-20T10:00:00Z","from":false},
          "translationLanguage":{"sessionId":"s1","requestId":"another-request","at":"2026-11-20T10:00:00Z","from":"en"}}}
        """
        let user = try JSONDecoder().decode(User.self, from: Data(json.utf8))
        XCTAssertEqual(SettingsFromConversation.undoBody(request: decoded, user: user), ["translationEnabled": .bool(false)])
        XCTAssertTrue(SettingsFromConversation.undoBody(request: decoded, user: nil).isEmpty)
    }

    func testApplyAndUndoGoToTheirDoors() async throws {
        final class Seen: @unchecked Sendable { var rows: [(String, String, Data)] = [] }
        let seen = Seen()
        SettingsDoorProtocol.handler = { request in
            var body = request.httpBody ?? Data()
            if body.isEmpty, let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let read = stream.read(&buffer, maxLength: buffer.count)
                    if read <= 0 { break }
                    body.append(buffer, count: read)
                }
            }
            seen.rows.append((request.httpMethod ?? "", request.url?.path ?? "", body))
            if request.url?.path.hasSuffix("apply-settings") == true {
                return (200, Data(#"{"id":"r1","kind":"SETTINGS_CHANGE","state":"DONE","title":"t","askedBySessionId":"s","createdAt":"2026-11-20T10:00:00Z"}"#.utf8))
            }
            return (200, Data(#"{"id":"u1","email":"a@b.c"}"#.utf8))
        }
        let applied = try await client().applyOwnerRequestSettings("r1")
        XCTAssertEqual(applied.state, .done)
        _ = try await client().undoSettingsChange(["translationEnabled": .bool(false), "translationLanguage": .string("en")])
        XCTAssertEqual(seen.rows[0].0, "POST")
        XCTAssertEqual(seen.rows[0].1, "/api/owner-requests/r1/apply-settings")
        XCTAssertEqual(seen.rows[1].0, "PATCH")
        XCTAssertEqual(seen.rows[1].1, "/api/users/me/preferences")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: seen.rows[1].2) as? [String: Any])
        XCTAssertEqual(body["translationEnabled"] as? Bool, false)
        XCTAssertEqual(body["translationLanguage"] as? String, "en")
    }

    func testAStaleApplyIsRecognised() {
        XCTAssertTrue(SettingsFromConversation.isStale(
            APIError.http(status: 409, body: #"{"code":"SETTINGS_STALE","message":"x"}"#)))
        XCTAssertFalse(SettingsFromConversation.isStale(APIError.http(status: 409, body: #"{"code":"OTHER"}"#)))
        XCTAssertFalse(SettingsFromConversation.isStale(APIError.http(status: 500, body: "SETTINGS_STALE")))
    }

    /// A value moved since the card was proposed: the door answers 409 SETTINGS_STALE, the card stays PENDING and folds
    /// to the stale line with a Decline link (design §5.2, §8.1).
    func testAStaleApplyThrowsTheRefusalTheCardFoldsOn() async throws {
        SettingsDoorProtocol.handler = { _ in
            (409, Data(#"{"code":"SETTINGS_STALE","message":"This setting changed since it was proposed."}"#.utf8))
        }
        do {
            _ = try await client().applyOwnerRequestSettings("r1")
            XCTFail("a stale apply must be refused")
        } catch {
            XCTAssertTrue(SettingsFromConversation.isStale(error))
        }
        SettingsDoorProtocol.handler = { _ in (500, Data("boom".utf8)) }
        do {
            _ = try await client().applyOwnerRequestSettings("r1")
            XCTFail("a server error must throw")
        } catch {
            XCTAssertFalse(SettingsFromConversation.isStale(error), "only SETTINGS_STALE folds the card")
        }
        XCTAssertEqual(SettingsChangeCopy.stale, "This setting changed since it was proposed.")
    }

    func testALoneSettingsLinkBecomesTheOpenInSettingsRow() {
        let linked = OrbitLinkPlacement.place(
            [.paragraph(text: "[Let sessions orchestrate](orbit-settings:enableOrchestration)")], host: "https://orbit.test")
        guard case .settings(let place)? = linked.first else { return XCTFail("not a settings row: \(linked)") }
        XCTAssertEqual(place.title, "Let sessions orchestrate")
        XCTAssertEqual(SettingsFromConversation.pathLabel(place), "Settings › General › Orchestration")
        XCTAssertEqual(place.page, .general)
        let unknown = OrbitLinkPlacement.place([.paragraph(text: "[x](orbit-settings:nonsense)")], host: "https://orbit.test")
        XCTAssertEqual(unknown, [.markdown(.paragraph(text: "[x](orbit-settings:nonsense)"))])
    }
}
