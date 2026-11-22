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

/// The approve-terminal card and the machine page's Terminals (docs/terminal-session-design.md): the server's doors as the
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
                       "It can start sessions in your workspaces on this machine and answer their approval cards for 30 days. You can revoke it on this machine's page in Settings.")
        XCTAssertEqual([Terminals.deny, Terminals.approve], ["Deny", "Approve"])
    }

    func testARowSaysApprovedLastUsedAndExpires() throws {
        let now = try XCTUnwrap(RelativeTime.parse("2026-11-12T10:00:00.000Z"))
        XCTAssertEqual(Terminals.approvedLine(terminal()), "Approved Nov 10, 2026")
        XCTAssertEqual(Terminals.lastUsedLine(terminal(), now: now), "Last used 3m ago")
        XCTAssertEqual(Terminals.lastUsedLine(terminal(lastUsedAt: nil), now: now), "Never used")
        XCTAssertEqual(Terminals.expiresLine(terminal(), now: now), "Expires Dec 10, 2026 · in 28 days")
        XCTAssertEqual(Terminals.usedAndExpiresLine(terminal(), now: now),
                       "Last used 3m ago · Expires Dec 10, 2026 · in 28 days")
        XCTAssertEqual(Terminals.usedAndExpiresLine(terminal(lastUsedAt: nil), now: now),
                       "Never used · Expires Dec 10, 2026 · in 28 days")
        XCTAssertEqual(Terminals.revokeTitle(terminal()), "Revoke the terminal on dev-laptop?")
    }

    /// The web declares every word once in `lib/terminals.ts`; this end says them byte for byte.
    func testTheWordsAreTheWebsWords() throws {
        let web = try webSource("src/web/src/lib/terminals.ts")
        for (name, value) in [("APPROVE_TERMINAL_TITLE", Terminals.approveTitle),
                              ("APPROVE_TERMINAL_DETAIL", Terminals.approveDetail),
                              ("DENY", Terminals.deny), ("APPROVE", Terminals.approve),
                              ("TERMINALS_TITLE", Terminals.title),
                              ("MACHINE_TERMINALS_HINT", Terminals.machineHint),
                              ("REVOKE", Terminals.revoke),
                              ("REVOKE_TERMINAL_DETAIL", Terminals.revokeDetail)] {
            XCTAssertTrue(web.contains("\(name) = '\(value)'"), "\(name) drifted from \(value.debugDescription)")
        }
        for template in ["`Terminal on ${machineName} · code ${code}`", "`Revoke the terminal on ${machineName}?`",
                         "`Approved ${fullDate(terminal.approvedAt)}`", "`Last used ${ago(terminal.lastUsedAt, now)}`",
                         "'Never used'", "`Expires ${fullDate(terminal.expiresAt)} · ${untilLine(terminal.expiresAt, now)}`"] {
            XCTAssertTrue(web.contains(template), "the web no longer says \(template)")
        }
        let card = try webSource("src/web/src/components/TerminalRequests.tsx")
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

    /// The machine page lists its own terminals, newest approval first, and nothing of another machine's
    /// (docs/mocks/terminals-on-machine-page/01-board.html ②) — web `machineTerminals`, Android `Terminals.on`.
    func testAMachinePageListsItsOwnTerminalsNewestFirst() {
        let older = Terminal(id: "34term2", machineName: "dev-laptop", runnerId: "run1",
                             createdAt: "2026-11-10T10:00:00.000Z", approvedAt: "2026-11-10T10:00:00.000Z",
                             lastUsedAt: nil, expiresAt: "2026-12-10T10:00:00.000Z")
        let newer = Terminal(id: "34term9", machineName: "dev-laptop", runnerId: "run1",
                             createdAt: "2026-11-14T10:00:00.000Z", approvedAt: "2026-11-14T10:00:00.000Z",
                             lastUsedAt: nil, expiresAt: "2026-12-14T10:00:00.000Z")
        let otherMachine = Terminal(id: "34term5", machineName: "build-box", runnerId: "run2",
                                    createdAt: "2026-11-15T10:00:00.000Z", approvedAt: "2026-11-15T10:00:00.000Z",
                                    lastUsedAt: nil, expiresAt: "2026-12-15T10:00:00.000Z")
        XCTAssertEqual(Terminals.machineTerminals([older, newer, otherMachine], on: "run1").map(\.id),
                       ["34term9", "34term2"], "this machine's only, newest approval first")
        XCTAssertTrue(Terminals.machineTerminals([otherMachine], on: "run1").isEmpty,
                      "a machine with no approved terminal draws no section")
    }

    /// Settings → Terminals is gone on the Apple clients (the owner, 2026-11-16): no row, no page, no value.
    func testSettingsHasNoTerminalsRowOrPage() throws {
        XCTAssertFalse(SettingsHome.Row.allCases.map(\.rawValue).contains("terminals"))
        XCTAssertFalse(SettingsHome.rows(.personal).map(\.rawValue).contains("terminals"))
        XCTAssertFalse(SettingsPage.allCases.map(\.rawValue).contains("terminals"))
        let settings = try webSource("src/macos/OrbitApp/Sources/OrbitApp/Views/SettingsSheet.swift")
        XCTAssertFalse(settings.contains("TerminalsSettingsPage"), "the Settings page is gone")
        XCTAssertFalse(settings.contains("Terminals.revoke"), "Revoke lives on the machine page now")
        let home = try webSource("src/macos/OrbitKit/Sources/OrbitKit/App/SettingsHome.swift")
        XCTAssertFalse(home.contains("case terminals"), "no Settings row of its own remains")
        XCTAssertFalse(home.contains("case .terminals"), "no Settings page of its own remains")
    }

    /// OrbitApp does not build on Linux, so where the app draws and reads these is checked in its source: the card and
    /// the requests' read and doors (drawn on the machine page by the macOS + iOS task, board waiting-on-you-removal 02);
    /// the machine page's own Terminals, between Workspaces and About, with Revoke and main's confirm — Settings has
    /// neither the row nor the page; the event re-reads both.
    func testTheAppDrawsTheCardAndTheMachineTerminals() throws {
        let views = try webSource("src/macos/OrbitApp/Sources/OrbitApp/Views/OwnerRequestViews.swift")
        XCTAssertTrue(views.contains("struct TerminalApproveCard: View {"))
        XCTAssertTrue(views.contains("try await model.decideTerminal(request, approve: approve)"))
        let requests = try webSource("src/macos/OrbitApp/Sources/OrbitApp/OwnerRequestsModel.swift")
        XCTAssertTrue(requests.contains("private(set) var terminalRequests: [TerminalRequest] = []"))
        XCTAssertTrue(requests.contains("await loadTerminalRequests()"))
        let model = try webSource("src/macos/OrbitApp/Sources/OrbitApp/TerminalsModel.swift")
        XCTAssertTrue(model.contains("try await api.revokeTerminal(terminal.id)\n            await load()"),
                      "a revoke reads the list again, so the revoked terminal leaves it")
        let app = try webSource("src/macos/OrbitApp/Sources/OrbitApp/AppModel.swift")
        XCTAssertTrue(app.contains("case .terminals:\n            whenSeen(\"terminals\") { app in\n                Task {\n"
                                   + "                    await app.ownerRequests?.loadTerminalRequests()\n                    await app.terminals?.load()"))
        // The card is on Machines & models' Needs you section and on the machine's own page; the
        // needs-you line, the push and the link all land there (board 02 ①③④).
        let machines = try webSource("src/macos/OrbitApp/Sources/OrbitApp/Views/SkillsRunnersView.swift")
        XCTAssertTrue(machines.contains("MachinesAndModelsNeedsYouSection(\n                            items: attention, terminals: terminals"))
        XCTAssertTrue(machines.contains("TerminalRequestsSection(runnerID: runner.id, onSaid: show)"))
        let section = try webSource("src/macos/OrbitApp/Sources/OrbitApp/Views/MachinesAndModelsSections.swift")
        XCTAssertTrue(section.contains("TerminalRequestCards(model: ownerRequests, requests: terminals, lit: lit, onSaid: onSaid)"))
        let block = try webSource("src/macos/OrbitApp/Sources/OrbitApp/Views/TerminalRequestsView.swift")
        XCTAssertTrue(block.contains("RunnerSectionHeader(Terminals.toApprove, trailing: Terminals.requestLasts)"))
        // The machine page's Terminals (docs/mocks/terminals-on-machine-page ②③): its own terminals,
        // between Workspaces and About, hidden when it has none, with main's Revoke and confirm.
        XCTAssertTrue(machines.contains("Terminals.machineTerminals(model.terminals?.terminals ?? [], on: runner.id)"))
        XCTAssertTrue(machines.contains("RunnerSectionHeader(Terminals.title)"))
        XCTAssertTrue(machines.contains("Text(Terminals.machineHint)"))
        XCTAssertTrue(machines.contains("Text(Terminals.approvedLine(terminal))"))
        XCTAssertTrue(machines.contains("Text(Terminals.usedAndExpiresLine(terminal, now: now))"))
        XCTAssertTrue(machines.contains("Terminals.revokeTitle(terminal)"))
        XCTAssertTrue(machines.contains("Text(Terminals.revokeDetail)"))
        XCTAssertTrue(machines.contains("await terminals.revoke(terminal)"))
        XCTAssertTrue(machines.contains(".task { await model.terminals?.load() }"))
        let workspaces = try XCTUnwrap(machines.range(of: "workspacesSection(workspaces)"))
        let terminals = try XCTUnwrap(machines.range(of: "terminalsSection(now: now)"))
        let about = try XCTUnwrap(machines.range(of: "aboutSection(now: now)",
                                                 range: terminals.upperBound..<machines.endIndex))
        XCTAssertLessThan(workspaces.lowerBound, terminals.lowerBound, "Terminals comes after Workspaces")
        XCTAssertLessThan(terminals.lowerBound, about.lowerBound, "Terminals comes before About")
        // The Mac's session list keeps its resident "Needs you" line — the phone has the one-time
        // notice instead, because there is no session list there to put a line on.
        let list = try webSource("src/macos/OrbitApp/Sources/OrbitApp/Views/AgentsView.swift")
        XCTAssertTrue(list.contains("if let terminal = app.terminalNeedsYou(now: terminalNow)"))
        XCTAssertTrue(list.contains("TerminalNeedsYouRow(line: terminal) { app.openTerminalNeedsYou(terminal) }"))
        XCTAssertTrue(app.contains("nav.settingsPath = [.settingsPage(.machines)]"),
                      "the phone raises Settings on the Machines page, where its pending terminals are")
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

    /// A new request is announced once, as a toast (the owner, 2026-11-16: the resident needs-you bar
    /// is gone). One notice per request, keyed by its own id, so a read that still holds an answered
    /// request says nothing again; the words are the approve card's, and a press knows which machine.
    func testATerminalRequestIsNoticedOnceAsAToast() throws {
        let now = try XCTUnwrap(RelativeTime.parse("2026-11-12T10:05:00.000Z"))
        let other = TerminalRequest(id: "34req2", userCode: "AAAA-1111", machineName: "build-box", runnerId: "run2",
                                    createdAt: "2026-11-12T10:02:00.000Z", expiresAt: "2026-11-12T10:12:00.000Z")
        let fresh = Terminals.newNotices([other, request], seen: [], now: now)
        XCTAssertEqual(fresh.map(\.id), ["34req1", "34req2"], "one notice each, oldest first")
        let notice = try XCTUnwrap(fresh.first)
        XCTAssertEqual(notice.title, "Approve a terminal")
        XCTAssertEqual(notice.line, "dev-laptop · code 7KQ-4MZ")
        XCTAssertEqual(notice.glyph, .terminal)
        XCTAssertEqual(notice.terminal?.id, "34req1", "the press goes to this machine's section")
        XCTAssertNil(notice.target, "a terminal is no conversation")

        // The same request, read again, is not announced again — however many times it is read.
        let seen = Set([request.id])
        XCTAssertEqual(Terminals.newNotices([request, other], seen: seen, now: now).map(\.id), ["34req2"])
        XCTAssertTrue(Terminals.newNotices([request], seen: seen, now: now).isEmpty, "once per request id")

        // A request past its deadline waits on nobody, so it is never announced.
        let after = try XCTUnwrap(RelativeTime.parse("2026-11-12T10:11:00.000Z"))
        XCTAssertTrue(Terminals.newNotices([request], seen: [], now: after).isEmpty)

        // Two on one machine are two notices, each naming the machine and its own code.
        let sameMachine = TerminalRequest(id: "34req3", userCode: "BBBB-2222", machineName: "dev-laptop", runnerId: "run1",
                                          createdAt: "2026-11-12T10:04:00.000Z", expiresAt: "2026-11-12T10:14:00.000Z")
        XCTAssertEqual(Terminals.newNotices([request, sameMachine], seen: [], now: now).map(\.line),
                       ["dev-laptop · code 7KQ-4MZ", "dev-laptop · code BBBB-2222"])
    }

    /// OrbitApp does not build on Linux, so the notice's wiring is read out of its source: the store's
    /// change is noticed, the first look only takes stock, a request answered or expired takes its
    /// notice with it, and a press opens that machine's pending section on the machine page.
    func testTheTerminalNoticeIsWiredToTheMachinePage() throws {
        let app = try webSource("src/macos/OrbitApp/Sources/OrbitApp/AppModel.swift")
        XCTAssertTrue(app.contains("ownerRequestsModel.onTerminalRequestsRead = { [weak self] in self?.noticeNewlyWaitingTerminals() }"))
        let notice = try slice(app, from: "private func noticeNewlyWaitingTerminals() {", to: "\n    }\n")
        XCTAssertTrue(notice.contains("guard let seen = terminalsSeen else { return }"), "the first look only takes stock")
        XCTAssertTrue(notice.contains("Terminals.newNotices(live, seen: seen)"))
        XCTAssertTrue(notice.contains("needsYouToasts.removeAll { $0.terminal != nil && !ids.contains($0.id) }"),
                      "answered or expired, the notice goes")
        XCTAssertTrue(app.contains("terminalsSeen = nil"))
        let press = try slice(app, from: "func openNeedsYouToast(", to: "\n    }\n")
        XCTAssertTrue(press.contains("if let request = notice.terminal {\n            return openTerminalRequests(request.id)"),
                      "a terminal's notice lands on that machine's pending section")
        let model = try webSource("src/macos/OrbitApp/Sources/OrbitApp/OwnerRequestsModel.swift")
        XCTAssertTrue(model.contains("var onTerminalRequestsRead: (() -> Void)?"))
        XCTAssertTrue(model.contains("onTerminalRequestsRead?()"),
                      "every read of the waiting terminals is noticed, the first one only taking stock")
        let card = try webSource("src/macos/OrbitApp/Sources/OrbitApp/Views/NeedsYouToast.swift")
        XCTAssertTrue(card.contains("case .terminal: return \"terminal\""), "the notice draws the terminal's mark")
        XCTAssertTrue(card.contains("notice.terminal != nil ? Terminals.needsYouHint"))
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

    /// From the first `start` through the next `end` after it, in a source read above.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    private func webSource(_ path: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let url = dir.appendingPathComponent(path)
            if let text = try? String(contentsOf: url, encoding: .utf8) {
                return text.replacingOccurrences(of: "=\\s*\\n\\s*'", with: "= '", options: .regularExpression)
                    .replacingOccurrences(of: "\\'", with: "'")
            }
            dir = dir.deletingLastPathComponent()
        }
        // A failure, not a skip: a parity check that opts out reports green on the day its other half moved.
        throw NSError(domain: "TerminalsTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(path) not found"])
    }
}
