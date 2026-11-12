import Foundation
import XCTest
@testable import OrbitKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class TerminalDoorURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, data: Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        let answer = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class TerminalDoorRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    func append(_ request: URLRequest) {
        lock.lock()
        storage.append("\(request.httpMethod ?? "") \(request.url?.path ?? "")")
        lock.unlock()
    }

    var sent: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

/// The approve-terminal card and Settings → Terminals (docs/terminal-session-design.md): the server's doors as the
/// app calls them, the words — the web's `lib/terminals.ts`, read back out of it — and where a row and an event go.
final class TerminalsTests: XCTestCase {

    override func tearDown() {
        TerminalDoorURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TerminalDoorURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private func answer(_ json: String, status: Int = 200) -> TerminalDoorRecorder {
        let recorder = TerminalDoorRecorder()
        TerminalDoorURLProtocol.handler = { request in
            recorder.append(request)
            return (status, Data(json.utf8))
        }
        return recorder
    }

    private let request = TerminalRequest(id: "34req1", userCode: "7KQ-4MZ", machineName: "dev-laptop", runnerId: "run1",
                                          createdAt: "2026-11-12T10:00:00.000Z", expiresAt: "2026-11-12T10:10:00.000Z")

    private func terminal(lastUsedAt: String? = "2026-11-12T09:57:00.000Z") -> Terminal {
        Terminal(id: "34term1", machineName: "dev-laptop", runnerId: "run1", createdAt: "2026-11-10T10:00:00.000Z",
                 approvedAt: "2026-11-10T10:00:00.000Z", lastUsedAt: lastUsedAt, expiresAt: "2026-12-10T10:00:00.000Z")
    }

    // MARK: the doors

    func testPendingRequestsAreOneRead() async throws {
        let recorder = answer("""
        {"requests":[{"id":"34req1","userCode":"7KQ-4MZ","machineName":"dev-laptop","runnerId":"run1",
          "createdAt":"2026-11-12T10:00:00.000Z","expiresAt":"2026-11-12T10:10:00.000Z"}]}
        """)
        let requests = try await client().terminalRequests()
        XCTAssertEqual(requests, [request])
        XCTAssertEqual(recorder.sent, ["GET /api/terminals/requests"])
    }

    func testApproveAndDenyArePostsAtTheRequestsPath() async throws {
        let recorder = answer(#"{"id":"34req1","status":"APPROVED","machineName":"dev-laptop","userCode":"7KQ-4MZ"}"#)
        try await client().approveTerminalRequest("34req1")
        try await client().denyTerminalRequest("34req1")
        XCTAssertEqual(recorder.sent, ["POST /api/terminals/requests/34req1/approve",
                                       "POST /api/terminals/requests/34req1/deny"])
    }

    func testTheListIsOneReadAndRevokeIsADelete() async throws {
        let recorder = answer("""
        {"terminals":[{"id":"34term1","machineName":"dev-laptop","runnerId":"run1","createdAt":"2026-11-10T10:00:00.000Z",
          "approvedAt":"2026-11-10T10:00:00.000Z","lastUsedAt":null,"expiresAt":"2026-12-10T10:00:00.000Z"}]}
        """)
        let terminals = try await client().terminals()
        XCTAssertEqual(terminals, [terminal(lastUsedAt: nil)])
        try await client().revokeTerminal("34term1")
        XCTAssertEqual(recorder.sent, ["GET /api/terminals", "DELETE /api/terminals/34term1"])
    }

    func testARefusalSurfacesAsTheServersAnswer() async throws {
        _ = answer(#"{"message":"terminal not found","statusCode":404}"#, status: 404)
        do {
            try await client().revokeTerminal("34gone")
            XCTFail("a 404 is not a revoked terminal")
        } catch APIError.http(let status, let body) {
            XCTAssertEqual(status, 404)
            XCTAssertEqual(APIClient.failureReason(APIError.http(status: status, body: body)), "terminal not found")
        }
    }

    // MARK: the words

    func testTheCardSaysWhatTheBoardSays() {
        XCTAssertEqual(Terminals.approveTitle, "Approve a terminal?")
        XCTAssertEqual(Terminals.requestLine(request), "Terminal on dev-laptop · code 7KQ-4MZ")
        XCTAssertEqual(Terminals.approveDetail,
                       "It can start sessions in your workspaces on this machine and answer their approval cards for 30 days. You can revoke it in Settings → Terminals.")
        XCTAssertEqual([Terminals.deny, Terminals.approve], ["Deny", "Approve"])
    }

    func testARowSaysApprovedLastUsedAndExpires() throws {
        let now = try XCTUnwrap(RelativeTime.parse("2026-11-12T10:00:00.000Z"))
        XCTAssertEqual(Terminals.approvedLine(terminal()), "Approved Nov 10, 2026")
        XCTAssertEqual(Terminals.lastUsedLine(terminal(), now: now), "Last used 3m ago")
        XCTAssertEqual(Terminals.lastUsedLine(terminal(lastUsedAt: nil), now: now), "Never used")
        XCTAssertEqual(Terminals.expiresLine(terminal(), now: now), "Expires Dec 10, 2026 · in 28 days")
        XCTAssertEqual(Terminals.revokeTitle(terminal()), "Revoke the terminal on dev-laptop?")
        XCTAssertEqual(Terminals.settingsValue(count: 2), "2 signed in")
        XCTAssertEqual(Terminals.settingsValue(count: 0), "None")
    }

    /// The web declares every word once in `lib/terminals.ts`; this end says them byte for byte.
    func testTheWordsAreTheWebsWords() throws {
        let web = try webSource("src/web/src/lib/terminals.ts")
        for (name, value) in [("APPROVE_TERMINAL_TITLE", Terminals.approveTitle),
                              ("APPROVE_TERMINAL_DETAIL", Terminals.approveDetail),
                              ("DENY", Terminals.deny), ("APPROVE", Terminals.approve),
                              ("TERMINALS_TITLE", Terminals.title), ("TERMINALS_HINT", Terminals.hint),
                              ("NO_TERMINALS", Terminals.empty), ("REVOKE", Terminals.revoke),
                              ("REVOKE_TERMINAL_DETAIL", Terminals.revokeDetail)] {
            XCTAssertTrue(web.contains("\(name) = '\(value)'"), "\(name) drifted from \(value.debugDescription)")
        }
        for template in ["`Terminal on ${machineName} · code ${code}`", "`Revoke the terminal on ${machineName}?`",
                         "`Approved ${fullDate(terminal.approvedAt)}`", "`Last used ${ago(terminal.lastUsedAt, now)}`",
                         "'Never used'", "`Expires ${fullDate(terminal.expiresAt)} · ${untilLine(terminal.expiresAt, now)}`"] {
            XCTAssertTrue(web.contains(template), "the web no longer says \(template)")
        }
        let card = try webSource("src/web/src/components/TerminalsCard.tsx")
        XCTAssertTrue(card.contains("message.success('Terminal revoked')"))
        XCTAssertEqual(Terminals.revoked, "Terminal revoked")
    }

    // MARK: where it goes

    func testTerminalsChangedReadsTheTerminalsAndNothingElse() throws {
        let event = try JSONDecoder().decode(ControlEvent.self, from: Data("""
        {"type":"terminals.changed","sessionId":"","agentId":null,"ts":"t","data":{"id":"x1"}}
        """.utf8))
        XCTAssertEqual(event.type, .terminalsChanged)
        XCTAssertEqual(ControlEventRoute.of(event), .terminals)
        XCTAssertFalse(ControlEventRoute.terminals.readsOpenList)
    }

    /// The server's push for a terminal asking (`PushService.notifyTerminalLogin`) names no session: its tap opens the
    /// inbox the card is in.
    func testTheTerminalLoginPushOpensTheInbox() {
        XCTAssertEqual(Notifications.intent(actionId: "com.apple.UNNotificationDefaultActionIdentifier",
                                            userInfo: ["kind": "terminal-login", "terminalLoginID": "34req1", "runnerID": "r1"]),
                       .openTerminalRequests)
    }

    func testSettingsHasATerminalsRowThatOpensItsPage() {
        XCTAssertTrue(SettingsHome.rows(.account, isAdmin: false).contains(.terminals))
        XCTAssertEqual(SettingsHome.title(.terminals), "Terminals")
        XCTAssertEqual(SettingsHome.page(.terminals), .terminals)
        XCTAssertEqual(SettingsPage.terminals.title, "Terminals")
    }

    /// OrbitApp does not build on Linux, so where the app draws and reads these is checked in its source: the card heads
    /// the inbox's Open tab and counts with the requests; Settings has the row, its page with Revoke, and its read; the
    /// event re-reads both.
    func testTheAppDrawsTheCardAndThePage() throws {
        let views = try webSource("src/macos/OrbitApp/Sources/OrbitApp/Views/OwnerRequestViews.swift")
        XCTAssertTrue(views.contains("ForEach(model.terminalRequests) { request in"))
        XCTAssertTrue(views.contains("TerminalApproveCard(model: model, request: request)"))
        XCTAssertTrue(views.contains("entries.isEmpty && model.terminalRequests.isEmpty"))
        XCTAssertTrue(views.contains("try await model.decideTerminal(request, approve: approve)"))
        let requests = try webSource("src/macos/OrbitApp/Sources/OrbitApp/OwnerRequestsModel.swift")
        XCTAssertTrue(requests.contains("OwnerRequests.waitingCount(open, questions: questions, snoozes: snoozes) + terminalRequests.count"))
        XCTAssertTrue(requests.contains("await loadTerminalRequests()"))
        let settings = try webSource("src/macos/OrbitApp/Sources/OrbitApp/Views/SettingsSheet.swift")
        XCTAssertTrue(settings.contains("case .terminals:      TerminalsSettingsPage()"))
        XCTAssertTrue(settings.contains(".task { await model.terminals?.load() }"))
        XCTAssertTrue(settings.contains("Button(Terminals.revoke, role: .destructive) { Task { await revoke(terminal) } }"))
        let model = try webSource("src/macos/OrbitApp/Sources/OrbitApp/TerminalsModel.swift")
        XCTAssertTrue(model.contains("try await api.revokeTerminal(terminal.id)\n            await load()"),
                      "a revoke reads the list again, so the revoked terminal leaves it")
        let app = try webSource("src/macos/OrbitApp/Sources/OrbitApp/AppModel.swift")
        XCTAssertTrue(app.contains("case .terminals:\n            Task {\n                await ownerRequests?.loadTerminalRequests()\n                await terminals?.load()"))
    }

    private func webSource(_ path: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let url = dir.appendingPathComponent(path)
            if let text = try? String(contentsOf: url, encoding: .utf8) {
                return text.replacingOccurrences(of: "=\\s*\\n\\s*'", with: "= '", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        // A failure, not a skip: a parity check that opts out reports green on the day its other half moved.
        throw NSError(domain: "TerminalsTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(path) not found"])
    }
}
