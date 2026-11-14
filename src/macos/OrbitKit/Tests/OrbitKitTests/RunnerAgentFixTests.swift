import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class AgentFixURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, body: Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        let result = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: result.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: result.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class AgentFixSeen: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: (request: URLRequest, body: Data?)?

    func record(_ request: URLRequest) {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            stream.close()
            body = data
        }
        lock.lock()
        stored = (request, body)
        lock.unlock()
    }

    var seen: (request: URLRequest, body: Data?)? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

/// Fix with an agent (agent-fix contract; board-attention.png, install-failed-board.png): the button is on
/// an engine not updating, a runner that can't update itself and an engine's Install failed panel, and
/// nowhere else; it is greyed with the server's reason while blocked, and gives way to the fixing line while
/// a session a press started is open.
final class RunnerAgentFixTests: XCTestCase {
    override func tearDown() {
        AgentFixURLProtocol.handler = nil
        super.tearDown()
    }

    /// 2026-09-29T00:15:00Z: 13 days after codex fell behind.
    private static let nowMs: Int64 = 1_790_640_900_000

    private static let signedOut = "An agent can't run here: orbit-dev uses Claude Code, which is signed out on this machine."

    private func agentFix(blocked: (code: String, message: String)? = nil, fixing: String = "") -> String {
        let blockedJSON = blocked.map { #"{"code":"\#($0.code)","message":"\#($0.message)"}"# } ?? "null"
        return #"""
        ,"agentFix":{"workspaceId":"ws1","workspaceName":"orbit-dev","engine":"claude","engineName":"Claude Code",
          "blocked":\#(blockedJSON),"fixing":[\#(fixing)]}
        """#
    }

    /// Online, codex 13 days behind (Needs Attention: engine not updating), updates turned off on a runner
    /// behind 0.1.250 (can't update itself).
    private func machine(_ agentFix: String?) throws -> Runner {
        try JSONDecoder().decode(Runner.self, from: Data(#"""
        {"id":"r","name":"austin","online":true,"version":"0.1.200","lastHeartbeatAt":"2026-09-29T00:14:50Z",
         "selfUpdate":{"state":"disabledByEnv","reason":"ORBIT_NO_SELFUPDATE=1"},
         "engines":[
          {"engine":"claude","installed":true,"version":"2.1.325","auth":"yes"},
          {"engine":"codex","installed":true,"version":"codex-cli 0.159.2","auth":"yes",
           "update":{"status":"failed","at":"2026-09-28T23:50:00Z","okAt":"2026-09-15T00:00:00Z",
                     "latest":"0.169.0","behindSince":"2026-09-16T00:00:00Z"}}]\#(agentFix ?? "")}
        """#.utf8))
    }

    /// Codex's install failed on this machine (install-failed-board.png).
    private func installFailed(_ agentFix: String?) throws -> Runner {
        try JSONDecoder().decode(Runner.self, from: Data(#"""
        {"id":"r","name":"vmi3753066","online":true,"lastHeartbeatAt":"2026-09-29T00:14:50Z",
         "engines":[{"engine":"claude","installed":true,"version":"2.1.325","auth":"yes"},
                    {"engine":"codex","installed":false}],
         "install":{"status":"failed","engine":"codex","command":"npm install -g @openai/codex",
                    "message":"exit status 127: sh: 1: npm: not found"}\#(agentFix ?? "")}
        """#.utf8))
    }

    private func items(_ runner: Runner) -> [RunnerAttentionItem] {
        RunnerAttention.runnerAttention(runner: runner, workspaces: [], nowMs: Self.nowMs, latestVersion: "0.1.250")
    }

    private func item(_ kind: RunnerAttentionKind) -> RunnerAttentionItem {
        RunnerAttentionItem(kind: kind, tone: .warn, short: "", title: "", detail: "", action: nil, params: [:])
    }

    // MARK: decoding

    func testAgentFixDecodesFromTheRunnerList() throws {
        let fixing = #"{"kind":"engineNotUpdating","engine":"codex","sessionId":"s1","workspaceId":"ws1","workspaceName":"orbit-dev"}"#
        let runner = try machine(agentFix(blocked: ("engineSignedOut", Self.signedOut), fixing: fixing))
        let fix = try XCTUnwrap(runner.agentFix)
        XCTAssertEqual(fix.workspaceId, "ws1")
        XCTAssertEqual(fix.workspaceName, "orbit-dev")
        XCTAssertEqual(fix.engine, "claude")
        XCTAssertEqual(fix.engineName, "Claude Code")
        XCTAssertEqual(fix.blocked, RunnerAgentFix.Blocked(code: "engineSignedOut", message: Self.signedOut))
        XCTAssertEqual(fix.fixing, [RunnerAgentFixing(kind: "engineNotUpdating", engine: "codex", sessionId: "s1",
                                                      workspaceId: "ws1", workspaceName: "orbit-dev")])

        let none = try JSONDecoder().decode(RunnerAgentFix.self, from: Data(#"""
        {"workspaceId":null,"workspaceName":null,"engine":null,"engineName":null,
         "blocked":{"code":"noWorkspace","message":"No workspace runs on this machine yet."},"fixing":[]}
        """#.utf8))
        XCTAssertNil(none.workspaceName)
        XCTAssertEqual(none.blocked?.code, "noWorkspace")
        XCTAssertEqual(none.fixing, [])
    }

    func testAnOlderServerWithoutAgentFixDrawsNoButton() throws {
        let old = try machine(nil)
        XCTAssertNil(old.agentFix)
        for item in items(old) { XCTAssertNil(RunnerAgentFixLogic.attentionState(old, item: item), "\(item.kind)") }
        XCTAssertNil(RunnerAgentFixLogic.installFailedState(try installFailed(nil), engine: "codex"))
    }

    // MARK: where the button goes

    func testOnlyAnEngineNotUpdatingAndARunnerThatCantUpdateItselfGetTheButton() throws {
        let runner = try machine(agentFix())
        let cards = items(runner)
        let withButton = cards.filter { RunnerAgentFixLogic.attentionState(runner, item: $0) != nil }.map(\.kind)
        XCTAssertEqual(withButton, [.cannotSelfUpdate, .engineNotUpdating])
        for card in cards where card.kind == .cannotSelfUpdate || card.kind == .engineNotUpdating {
            XCTAssertEqual(RunnerAgentFixLogic.attentionState(runner, item: card), .ready(hint: nil))
        }
        // The cannot-update card here (updates turned off) has no other press, and still gets it.
        XCTAssertNil(cards.first { $0.kind == .cannotSelfUpdate }?.action)

        let never: [RunnerAttentionKind] = [.offline, .noCliSignedIn, .engineSignedOut, .claudeRegionUnsupported,
                                            .checkoutStuck, .quotaNearLimit, .diskLow]
        for kind in never {
            XCTAssertNil(RunnerAgentFixLogic.target(item(kind)), "\(kind)")
            XCTAssertNil(RunnerAgentFixLogic.attentionState(runner, item: item(kind)), "\(kind)")
        }
        let engineCard = try XCTUnwrap(cards.first { $0.kind == .engineNotUpdating })
        XCTAssertEqual(RunnerAgentFixLogic.target(engineCard),
                       RunnerAgentFixTarget(kind: .engineNotUpdating, engine: "codex"))
    }

    func testAnOfflineMachineDrawsNothingOnItsCardsButSaysSoOnTheInstallPanel() throws {
        let offline = agentFix(blocked: ("offline", "This machine is offline."))
        let runner = try machine(offline)
        for card in items(runner) { XCTAssertNil(RunnerAgentFixLogic.attentionState(runner, item: card)) }
        XCTAssertEqual(RunnerAgentFixLogic.installFailedState(try installFailed(offline), engine: "codex"),
                       .blocked(reason: "This machine is offline."))
    }

    func testTheInstallPanelHasItOnlyWhileTheInstallFailed() throws {
        let failed = try installFailed(agentFix())
        XCTAssertEqual(RunnerAgentFixLogic.installFailedState(failed, engine: "codex"),
                       .ready(hint: "Starts a session in orbit-dev on this machine, with Claude Code."))
        XCTAssertNil(RunnerAgentFixLogic.installFailedState(failed, engine: "claude"))
        XCTAssertNil(RunnerAgentFixLogic.installFailedState(try machine(agentFix()), engine: "codex"))
    }

    // MARK: blocked

    func testBlockedGreysTheButtonWithTheServersLine() throws {
        let noWorkspace = "No workspace runs on this machine yet."
        let empty = try machine(agentFix(blocked: ("noWorkspace", noWorkspace)))
        let engineCard = try XCTUnwrap(items(empty).first { $0.kind == .engineNotUpdating })
        XCTAssertEqual(RunnerAgentFixLogic.attentionState(empty, item: engineCard), .blocked(reason: noWorkspace))
        XCTAssertEqual(RunnerAgentFixLogic.installFailedState(
            try installFailed(agentFix(blocked: ("noWorkspace", noWorkspace))), engine: "codex"),
                       .blocked(reason: noWorkspace))

        // Signed out: the card says the server's line alone; the install panel adds where to sign in.
        let signedOut = agentFix(blocked: ("engineSignedOut", Self.signedOut))
        let out = try machine(signedOut)
        let card = try XCTUnwrap(items(out).first { $0.kind == .engineNotUpdating })
        XCTAssertEqual(RunnerAgentFixLogic.attentionState(out, item: card), .blocked(reason: Self.signedOut))
        XCTAssertEqual(RunnerAgentFixLogic.installFailedState(try installFailed(signedOut), engine: "codex"),
                       .blocked(reason: Self.signedOut + " Sign in to Claude Code above to use this."))
    }

    // MARK: fixing

    func testAMatchingSessionTurnsTheButtonIntoTheFixingLine() throws {
        let codex = #"{"kind":"engineNotUpdating","engine":"codex","sessionId":"s1","workspaceId":"ws1","workspaceName":"orbit-dev"}"#
        let runner = try machine(agentFix(fixing: codex))
        let cards = items(runner)
        let engineCard = try XCTUnwrap(cards.first { $0.kind == .engineNotUpdating })
        let cantUpdate = try XCTUnwrap(cards.first { $0.kind == .cannotSelfUpdate })
        XCTAssertEqual(RunnerAgentFixLogic.attentionState(runner, item: engineCard),
                       .fixing(RunnerAgentFixing(kind: "engineNotUpdating", engine: "codex", sessionId: "s1",
                                                 workspaceId: "ws1", workspaceName: "orbit-dev")))
        // Another warning on the same machine keeps its button.
        XCTAssertEqual(RunnerAgentFixLogic.attentionState(runner, item: cantUpdate), .ready(hint: nil))
        XCTAssertEqual(RunnerPageCopy.agentFixFixing(workspace: "orbit-dev"), "An agent is fixing this in orbit-dev · ")

        // The same kind on another engine is not this warning's session.
        let claude = #"{"kind":"engineNotUpdating","engine":"claude","sessionId":"s2","workspaceId":"ws1","workspaceName":"orbit-dev"}"#
        let other = try machine(agentFix(fixing: claude))
        XCTAssertEqual(RunnerAgentFixLogic.attentionState(
            other, item: try XCTUnwrap(items(other).first { $0.kind == .engineNotUpdating })), .ready(hint: nil))

        // A runner that can't update itself matches on kind alone; fixing outranks a blocked line.
        let selfUpdate = #"{"kind":"cannotSelfUpdate","engine":null,"sessionId":"s3","workspaceId":"ws1","workspaceName":"orbit-dev"}"#
        let busy = try machine(agentFix(blocked: ("engineSignedOut", Self.signedOut), fixing: selfUpdate))
        XCTAssertEqual(RunnerAgentFixLogic.attentionState(
            busy, item: try XCTUnwrap(items(busy).first { $0.kind == .cannotSelfUpdate })),
                       .fixing(RunnerAgentFixing(kind: "cannotSelfUpdate", engine: nil, sessionId: "s3",
                                                 workspaceId: "ws1", workspaceName: "orbit-dev")))

        // The install panel: kind installFailed and the same engine.
        let install = #"{"kind":"installFailed","engine":"codex","sessionId":"s4","workspaceId":"ws1","workspaceName":"orbit-develop"}"#
        XCTAssertEqual(RunnerAgentFixLogic.installFailedState(try installFailed(agentFix(fixing: install)),
                                                              engine: "codex"),
                       .fixing(RunnerAgentFixing(kind: "installFailed", engine: "codex", sessionId: "s4",
                                                 workspaceId: "ws1", workspaceName: "orbit-develop")))
        XCTAssertEqual(RunnerAgentFixLogic.installFailedState(try installFailed(agentFix(fixing: codex)),
                                                              engine: "codex"),
                       .ready(hint: "Starts a session in orbit-dev on this machine, with Claude Code."))
    }

    // MARK: the press

    func testTheRequestCarriesTheEngineOrTheLatestRelease() {
        XCTAssertEqual(RunnerAgentFixLogic.request(RunnerAgentFixTarget(kind: .engineNotUpdating, engine: "codex"),
                                                   latestVersion: "0.1.250"),
                       RunnerAttentionFixRequest(engine: "codex"))
        XCTAssertEqual(RunnerAgentFixLogic.request(RunnerAgentFixTarget(kind: .installFailed, engine: "codex"),
                                                   latestVersion: nil),
                       RunnerAttentionFixRequest(engine: "codex"))
        XCTAssertEqual(RunnerAgentFixLogic.request(RunnerAgentFixTarget(kind: .cannotSelfUpdate, engine: nil),
                                                   latestVersion: "0.1.250"),
                       RunnerAttentionFixRequest(latest: "0.1.250"))
        XCTAssertEqual(RunnerAgentFixLogic.request(RunnerAgentFixTarget(kind: .cannotSelfUpdate, engine: nil),
                                                   latestVersion: nil),
                       RunnerAttentionFixRequest())
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AgentFixURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(), session: URLSession(configuration: configuration))
    }

    func testThePressPostsTheFixRouteAndReadsTheSession() async throws {
        let seen = AgentFixSeen()
        AgentFixURLProtocol.handler = { request in
            seen.record(request)
            return (200, Data(#"{"sessionId":"s1","workspaceId":"ws1","workspaceName":"orbit-dev","title":"Fix: Codex update failed on austin"}"#.utf8))
        }
        let result = try await client().fixRunnerAttention("r", kind: .engineNotUpdating,
                                                           body: RunnerAttentionFixRequest(engine: "codex"))
        XCTAssertEqual(result.sessionId, "s1")
        XCTAssertEqual(result.workspaceName, "orbit-dev")
        XCTAssertEqual(result.title, "Fix: Codex update failed on austin")
        let (request, body) = try XCTUnwrap(seen.seen)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/runners/r/attention/engineNotUpdating/fix")
        let sent = try JSONSerialization.jsonObject(with: try XCTUnwrap(body)) as? [String: Any]
        XCTAssertEqual(sent?["engine"] as? String, "codex")
        XCTAssertNil(sent?["latest"], "a nil field is left out")
    }

    func testARefusalReachesTheScreenAsTheServersSentence() async throws {
        let message = "An agent is already fixing this in orbit-dev."
        AgentFixURLProtocol.handler = { _ in
            (409, Data(#"{"code":"AGENT_FIX_RUNNING","message":"\#(message)"}"#.utf8))
        }
        do {
            _ = try await client().fixRunnerAttention("r", kind: .cannotSelfUpdate,
                                                      body: RunnerAttentionFixRequest(latest: "0.1.250"))
            XCTFail("a 409 must throw")
        } catch {
            XCTAssertEqual(APIClient.failureReason(error), message)
        }
    }

    func testTheWords() {
        XCTAssertEqual(RunnerPageCopy.AGENT_FIX_BUTTON, "Fix with an agent")
        XCTAssertEqual(RunnerPageCopy.AGENT_FIX_OPEN_SESSION, "Open session")
        XCTAssertEqual(RunnerPageCopy.agentFixStartsIn(workspace: "orbit-develop", engine: "Claude Code"),
                       "Starts a session in orbit-develop on this machine, with Claude Code.")
        XCTAssertEqual(RunnerPageCopy.agentFixSignInAbove(engine: "Claude Code"), " Sign in to Claude Code above to use this.")
    }
}
