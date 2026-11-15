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
        let card = try webSource("src/web/src/pages/TerminalsPage.tsx")
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

    /// The server's push for a terminal asking (`PushService.notifyTerminalLogin`) names no session: its tap opens where
    /// the card is (the machine page's Needs you section, docs/mocks/waiting-on-you-removal/02 ④), and
    /// the push's own id is the card it lights.
    func testTheTerminalLoginPushOpensTheTerminalRequests() {
        XCTAssertEqual(Notifications.intent(actionId: "com.apple.UNNotificationDefaultActionIdentifier",
                                            userInfo: ["kind": "terminal-login", "terminalLoginID": "34req1", "runnerID": "r1"]),
                       .openTerminalRequests(requestID: "34req1"))
        XCTAssertEqual(Notifications.intent(actionId: "com.apple.UNNotificationDefaultActionIdentifier",
                                            userInfo: ["kind": "terminal-login", "runnerID": "r1"]),
                       .openTerminalRequests(requestID: nil))
    }

    /// `orbit://terminal-login/<id>` is a route now, and it round-trips; a host with no id names nothing.
    func testTheTerminalLoginLinkIsARoute() throws {
        let url = try XCTUnwrap(URL(string: "orbit://terminal-login/34req1"))
        XCTAssertEqual(DeepLink.parse(url), .terminalLogin("34req1"))
        XCTAssertEqual(DeepLink.url(for: .terminalLogin("34req1")), url)
        XCTAssertEqual(AppSection.forRoute(.terminalLogin("34req1")), .runners)
        let noID = try XCTUnwrap(URL(string: "orbit://terminal-login"))
        XCTAssertNil(DeepLink.parse(noID), "a link with no id names nothing")
    }

    func testSettingsHasATerminalsRowThatOpensItsPage() {
        XCTAssertTrue(SettingsHome.rows(.account, isAdmin: false).contains(.terminals))
        XCTAssertEqual(SettingsHome.title(.terminals), "Terminals")
        XCTAssertEqual(SettingsHome.page(.terminals), .terminals)
        XCTAssertEqual(SettingsPage.terminals.title, "Terminals")
    }

    /// OrbitApp does not build on Linux, so where the app draws and reads these is checked in its source: the card and
    /// the requests' read and doors (drawn on the machine page by the macOS + iOS task, board waiting-on-you-removal 02);
    /// Settings has the row, its page with Revoke, and its read; the event re-reads both.
    func testTheAppDrawsTheCardAndThePage() throws {
        let views = try webSource("src/macos/OrbitApp/Sources/OrbitApp/Views/OwnerRequestViews.swift")
        XCTAssertTrue(views.contains("struct TerminalApproveCard: View {"))
        XCTAssertTrue(views.contains("try await model.decideTerminal(request, approve: approve)"))
        let requests = try webSource("src/macos/OrbitApp/Sources/OrbitApp/OwnerRequestsModel.swift")
        XCTAssertTrue(requests.contains("private(set) var terminalRequests: [TerminalRequest] = []"))
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
        // The card is on Machines & models' Needs you section and on the machine's own page; the
        // needs-you line, the push and the link all land there (board 02 ①③④).
        let machines = try webSource("src/macos/OrbitApp/Sources/OrbitApp/Views/SkillsRunnersView.swift")
        XCTAssertTrue(machines.contains("MachinesAndModelsNeedsYouSection(\n                            items: attention, terminals: terminals"))
        XCTAssertTrue(machines.contains("TerminalRequestsSection(runnerID: runner.id, onSaid: show)"))
        let section = try webSource("src/macos/OrbitApp/Sources/OrbitApp/Views/MachinesAndModelsSections.swift")
        XCTAssertTrue(section.contains("TerminalRequestCards(model: ownerRequests, requests: terminals, lit: lit, onSaid: onSaid)"))
        let block = try webSource("src/macos/OrbitApp/Sources/OrbitApp/Views/TerminalRequestsView.swift")
        XCTAssertTrue(block.contains("RunnerSectionHeader(Terminals.toApprove, trailing: Terminals.requestLasts)"))
        let bar = try webSource("src/macos/OrbitApp/Sources/OrbitApp/Views/NeedsYouBannerView.swift")
        XCTAssertTrue(bar.contains("model.terminalNeedsYou(now: terminalNow)"))
        XCTAssertTrue(bar.contains("model.openTerminalNeedsYou(terminal)"))
        XCTAssertTrue(app.contains("nav.settingsPath = [.settingsPage(.machinesAndModels)]"))
        XCTAssertTrue(app.contains("case .openTerminalRequests(let requestID):"))
        let links = try webSource("src/macos/OrbitKit/Sources/OrbitKit/App/DeepLink.swift")
        XCTAssertTrue(links.contains("case \"terminal-login\": return id.map(Route.terminalLogin)"))
    }

    /// The needs-you line: one request names its machine and code; several count on a machine or name
    /// the machines, oldest first (board ③ choice 5).
    func testTheNeedsYouLine() throws {
        let now = try XCTUnwrap(RelativeTime.parse("2026-11-12T10:05:00.000Z"))
        let one = Terminals.liveRequests([request], now: now)
        XCTAssertEqual(Terminals.approveNeedsYou(count: 1), "Approve a terminal")
        XCTAssertEqual(Terminals.approveNeedsYou(count: 2), "Approve 2 terminals")
        XCTAssertEqual(Terminals.needsYouDetail(one), "dev-laptop · code 7KQ-4MZ")
        let line = try XCTUnwrap(TerminalNeedsYou.banner([request], now: now))
        XCTAssertEqual(line.text, "Approve a terminal")
        XCTAssertEqual(line.detail, "dev-laptop · code 7KQ-4MZ")
        XCTAssertEqual(line.glyph, .terminal)
        XCTAssertEqual(line.count, 1)
        XCTAssertEqual(line.oldest.id, "34req1")
        XCTAssertEqual(line.since, request.createdAt)

        let other = TerminalRequest(id: "34req2", userCode: "AAAA-1111", machineName: "build-box", runnerId: "run2",
                                    createdAt: "2026-11-12T10:02:00.000Z", expiresAt: "2026-11-12T10:12:00.000Z")
        let twoMachines = Terminals.liveRequests([other, request], now: now)
        XCTAssertEqual(twoMachines.map(\.id), ["34req1", "34req2"], "oldest first")
        XCTAssertEqual(Terminals.needsYouDetail(twoMachines), "dev-laptop, build-box")
        XCTAssertEqual(Terminals.approveNeedsYou(count: twoMachines.count), "Approve 2 terminals")

        let sameMachine = TerminalRequest(id: "34req3", userCode: "BBBB-2222", machineName: "dev-laptop", runnerId: "run1",
                                          createdAt: "2026-11-12T10:04:00.000Z", expiresAt: "2026-11-12T10:14:00.000Z")
        XCTAssertEqual(Terminals.needsYouDetail([request, sameMachine]), "dev-laptop · 2 waiting")
    }

    /// A request folds at its own deadline, not at the next read; one machine's page draws its own.
    func testOnlyAnswerableRequestsAreDrawn() throws {
        let after = try XCTUnwrap(RelativeTime.parse("2026-11-12T10:11:00.000Z"))
        XCTAssertTrue(Terminals.liveRequests([request], now: after).isEmpty)
        XCTAssertNil(TerminalNeedsYou.banner([request], now: after))
        let before = try XCTUnwrap(RelativeTime.parse("2026-11-12T10:09:00.000Z"))
        XCTAssertEqual(Terminals.liveRequests([request], now: before).map(\.id), ["34req1"])
        XCTAssertEqual(Terminals.nextDeadline([request], after: before),
                       try XCTUnwrap(RelativeTime.parse(request.expiresAt)))
        XCTAssertEqual(Terminals.requests([request], on: "run1").map(\.id), ["34req1"])
        XCTAssertTrue(Terminals.requests([request], on: "run2").isEmpty)
    }

    /// The web declares the needs-you words once in `lib/terminals.ts`; this end says them byte for byte.
    func testTheNeedsYouWordsAreTheWebsWords() throws {
        let web = try webSource("src/web/src/lib/terminals.ts")
        for (name, value) in [("TERMINALS_TO_APPROVE", Terminals.toApprove),
                              ("TERMINAL_REQUEST_LASTS", Terminals.requestLasts),
                              ("TERMINAL_APPROVED", Terminals.approvedToast),
                              ("TERMINAL_DENIED", Terminals.deniedToast),
                              ("TERMINALS_NEEDS_YOU", Terminals.needsYou)] {
            XCTAssertTrue(web.contains("\(name) = '\(value)'"), "\(name) drifted from \(value.debugDescription)")
        }
        for template in ["count === 1 ? 'Approve a terminal' : `Approve ${count} terminals`",
                         "`${requests[0].machineName} · code ${requests[0].userCode}`",
                         "`${machines[0]} · ${requests.length} waiting`", "machines.join(', ')"] {
            XCTAssertTrue(web.contains(template), "the web no longer says \(template)")
        }
    }

    /// No Waiting on you entry or sheet comes back (the project removes them): the card's own
    /// header still says "Waiting on you", as main's card does, but nothing navigates to a summary
    /// page or raises an inbox.
    func testThereIsNoWaitingOnYouEntryOrSheet() throws {
        for path in ["src/macos/OrbitApp/Sources/OrbitApp/AppModel.swift",
                     "src/macos/OrbitApp/Sources/OrbitApp/Views/CompactShell.swift",
                     "src/macos/OrbitApp/Sources/OrbitApp/Views/MainView.swift",
                     "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift",
                     "src/macos/OrbitApp/Sources/OrbitApp/Views/OwnerRequestViews.swift",
                     "src/macos/OrbitKit/Sources/OrbitKit/App/Navigation.swift"] {
            let source = try webSource(path)
            for symbol in ["OwnerRequestInboxSheet", "WaitingOnYouPage", "Destination.WAITING_ON_YOU",
                           "waitingOnYouSheet", "openWaitingOnYou"] {
                XCTAssertFalse(source.contains(symbol), "\(path) still has \(symbol)")
            }
        }
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
