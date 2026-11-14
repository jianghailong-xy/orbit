import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// The session Settings sheet (docs/mocks/session-settings native.html ①–④): the new fields of
/// `GET /sessions/:id` decode, the writes go where the server takes them, and the sheet's model
/// saves each change at once and puts it back when the server refuses.
final class SessionSettingsTests: XCTestCase {
    // MARK: decoding

    private let detailJSON = #"""
    {
      "id": "s1", "status": "AWAITING_INPUT", "engine": "claude",
      "workspace": { "id": "w1", "name": "orbit", "workDir": "/root/.orbit/worktrees/01a1c927", "env": { "X": "1" } },
      "assignedRunner": { "id": "r1", "name": "HPC", "engines": [
        { "engine": "claude", "version": "2.4.1", "accounts": [ { "id": "default" }, { "id": "a2", "name": "Max (2)" } ] },
        { "engine": "future-engine", "version": 7 }
      ] },
      "settings": {
        "env": { "DEBUG": "orbit:*", "LOG_LEVEL": "trace" },
        "workspaceEnv": { "NODE_OPTIONS": "--max-old-space-size=6144", "LOG_LEVEL": "info" },
        "notifyTurnFinished": "on", "notifyNeedsYou": "someday", "muted": true, "envPendingRestart": true
      },
      "usage": { "inputTokens": 1710000, "outputTokens": 108000, "cacheReadTokens": 1500000,
                 "cacheCreationTokens": 20000, "costUsd": 4.37, "numTurns": 23 },
      "engineVersion": "2.4.1"
    }
    """#

    func testDecodesSettingsUsageAndEngineVersionOffTheDetail() throws {
        let d = try JSONDecoder().decode(SessionSettingsDetail.self, from: Data(detailJSON.utf8))
        let s = try XCTUnwrap(d.settings)
        XCTAssertEqual(s.env, ["DEBUG": "orbit:*", "LOG_LEVEL": "trace"])
        XCTAssertEqual(s.workspaceEnv["NODE_OPTIONS"], "--max-old-space-size=6144")
        XCTAssertEqual(s.notifyTurnFinished, .on)
        XCTAssertEqual(s.notifyNeedsYou, .inherit, "an unknown value reads as inherit")
        XCTAssertTrue(s.muted)
        XCTAssertTrue(s.envPendingRestart)
        XCTAssertEqual(d.usage, SessionUsage(inputTokens: 1_710_000, outputTokens: 108_000, cacheReadTokens: 1_500_000,
                                            cacheCreationTokens: 20_000, costUsd: 4.37, numTurns: 23))
        XCTAssertEqual(d.engineVersion, "2.4.1")
        XCTAssertEqual(d.workspace?.workDir, "/root/.orbit/worktrees/01a1c927")
        XCTAssertEqual(d.assignedRunner?.name, "HPC")
        XCTAssertEqual(d.assignedRunner?.engines?.map(\.engine), ["claude"], "an unreadable engine is dropped, not the runner")
    }

    func testAnOlderServerDecodesToNils() throws {
        let d = try JSONDecoder().decode(SessionSettingsDetail.self, from: Data(#"{"id":"s1","status":"RUNNING"}"#.utf8))
        XCTAssertNil(d.settings)
        XCTAssertNil(d.usage)
        XCTAssertNil(d.engineVersion)
        XCTAssertNil(d.assignedRunner)
        // And the full Session row still decodes off the same payload.
        XCTAssertNoThrow(try JSONDecoder().decode(Session.self, from: Data(detailJSON.utf8)))
    }

    func testPatchSendsOnlyTheFieldsSet() throws {
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(SessionSettingsPatch(muted: false)))
        XCTAssertEqual(body as? [String: Bool], ["muted": false])
        let env = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            SessionSettingsPatch(env: ["A": "1"], notifyNeedsYou: .off))) as? [String: Any]
        XCTAssertEqual(env?["env"] as? [String: String], ["A": "1"])
        XCTAssertEqual(env?["notifyNeedsYou"] as? String, "off")
        XCTAssertEqual(env?.count, 2)
    }

    // MARK: API paths

    func testClientCallsTheSettingsAndRestartEndpoints() async throws {
        let seen = SettingsSeenRequests()
        SettingsURLProtocol.handler = { request in
            seen.record(request)
            if request.url?.path.hasSuffix("/restart") == true {
                return (202, Data(#"{"queued":true,"afterTurn":true}"#.utf8))
            }
            return (200, Data(#"{"env":{"A":"1"},"workspaceEnv":{},"notifyTurnFinished":"inherit","notifyNeedsYou":"inherit","muted":false,"envPendingRestart":true}"#.utf8))
        }
        defer { SettingsURLProtocol.handler = nil }
        let api = client()
        let settings = try await api.patchSessionSettings("s1", SessionSettingsPatch(env: ["A": "1"]))
        XCTAssertTrue(settings.envPendingRestart)
        let restart = try await api.restartSession("s1")
        XCTAssertEqual(restart, SessionRestartResponse(afterTurn: true))
        let requests = seen.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["PATCH", "POST"])
        XCTAssertEqual(requests.map { $0.url?.path }, ["/api/sessions/s1/settings", "/api/sessions/s1/restart"])
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SettingsURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(), session: URLSession(configuration: configuration))
    }

    // MARK: the panel's words and rows

    func testCompactAtIsTheSessionsOwnAutoCompactVariable() {
        XCTAssertEqual(SessionSettingsPanel.compactValue([:]), "default")
        XCTAssertEqual(SessionSettingsPanel.compactValue(["CLAUDE_CODE_AUTO_COMPACT_WINDOW": "500000"]), "500000")
        XCTAssertEqual(SessionSettingsPanel.env(["A": "1"], compactAt: "300000"),
                       ["A": "1", "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "300000"])
        XCTAssertEqual(SessionSettingsPanel.env(["A": "1", "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "300000"], compactAt: "default"),
                       ["A": "1"])
        XCTAssertEqual(SessionSettingsPanel.compactOptions(current: "123456").last?.label, "123456 tokens")
        XCTAssertEqual(SessionSettingsPanel.compactOptions(current: "700000").count, 4)
    }

    func testVariableRowsMarkTheWorkspaceOnesASessionVariableReplaces() {
        let s = SessionSettingsValues(env: ["LOG_LEVEL": "trace", "DEBUG": "orbit:*"], workspaceEnv: ["LOG_LEVEL": "info", "GOCACHE": "/mnt"])
        XCTAssertEqual(SessionSettingsPanel.sessionRows(s).map(\.key), ["DEBUG", "LOG_LEVEL"])
        XCTAssertEqual(SessionSettingsPanel.workspaceRows(s).map { "\($0.key):\($0.replaced)" }, ["GOCACHE:false", "LOG_LEVEL:true"])
        XCTAssertEqual(SessionSettingsPanel.variablesCount(s), "2")
    }

    func testVariableNamesFollowTheServersRule() {
        XCTAssertNil(SessionSettingsPanel.nameProblem("LOG_LEVEL"))
        XCTAssertNil(SessionSettingsPanel.nameProblem("_x1"))
        XCTAssertNotNil(SessionSettingsPanel.nameProblem(""))
        XCTAssertNotNil(SessionSettingsPanel.nameProblem("1ABC"))
        XCTAssertNotNil(SessionSettingsPanel.nameProblem("A-B"))
        XCTAssertEqual(SessionSettingsPanel.nameProblem("orbit_token"), "ORBIT_ variables are set by Orbit.")
    }

    func testRestartBannerFollowsTheEngine() {
        XCTAssertNil(SessionSettingsPanel.restartBanner(pending: false, turnRunning: true, queued: nil),
                     "an ended or already-fresh engine shows no banner")
        let running = SessionSettingsPanel.restartBanner(pending: true, turnRunning: true, queued: nil, changedKeys: ["LOG_LEVEL"])
        XCTAssertEqual(running?.title, "LOG_LEVEL is waiting for the engine to restart.")
        XCTAssertEqual(running?.button, "Restart after this turn")
        let idle = SessionSettingsPanel.restartBanner(pending: true, turnRunning: false, queued: nil, changedKeys: ["A", "B"])
        XCTAssertEqual(idle?.title, "The new variables are waiting for the engine to restart.")
        XCTAssertEqual(idle?.button, "Restart")
        let queued = SessionSettingsPanel.restartBanner(pending: true, turnRunning: true, queued: SessionRestartResponse(afterTurn: true))
        XCTAssertNil(queued?.button)
        XCTAssertEqual(queued?.body, "Orbit restarts it when this turn ends. The conversation is kept.")
    }

    func testInfoRowsReadAsTheBoardDoes() {
        let u = SessionUsage(inputTokens: 1_710_000, outputTokens: 108_000, cacheReadTokens: 1_500_000,
                             cacheCreationTokens: 20_000, costUsd: 4.371, numTurns: 23)
        XCTAssertEqual(SessionSettingsPanel.tokensTotal(u), "1.82M")
        XCTAssertEqual(SessionSettingsPanel.tokensSplit(u), "in 1.71M · out 108K · cache 1.52M")
        XCTAssertEqual(SessionSettingsPanel.cost(u), "$4.37")
        XCTAssertEqual(SessionSettingsPanel.turns(u), "23 turns")
        XCTAssertEqual(SessionSettingsPanel.tokenCount(9_500), "9.5K")
        XCTAssertEqual(SessionSettingsPanel.tokenCount(2_000_000), "2M")
        XCTAssertEqual(SessionSettingsPanel.tokenCount(640), "640")
        XCTAssertEqual(SessionSettingsPanel.engineLabel("claude", version: "2.4.1 (Claude Code)"), "Claude Code 2.4.1")
        XCTAssertEqual(SessionSettingsPanel.engineLabel("codex", version: nil), "Codex")
        XCTAssertNil(SessionSettingsPanel.engineLabel(nil, version: "1"))
        XCTAssertEqual(SessionSettingsPanel.shortID("1c0e7b3e-55aa-4d2f-9b1e-ac2e648c946c"), "…ac2e648c946c")
        XCTAssertEqual(SessionSettingsPanel.shortPath("/root/.orbit/worktrees/01a1c927"), "…/01a1c927")
        XCTAssertEqual(SessionSettingsPanel.created("2026-09-28T20:00:00Z", timeZone: TimeZone(identifier: "UTC")!),
                       "Sep 28, 20:00")
        let accounts = [RunnerEngineAccount(id: "a2", name: "Max (2)")]
        XCTAssertEqual(SessionSettingsPanel.accountLabel(engine: "claude", provider: "claude", accountID: "a2",
                                                         accounts: accounts, poolLogin: nil), "Claude Code · Max (2)")
        XCTAssertEqual(SessionSettingsPanel.accountLabel(engine: "claude", provider: nil, accountID: nil,
                                                         accounts: nil, poolLogin: nil), "Claude Code · Default")
        XCTAssertNil(SessionSettingsPanel.accountLabel(engine: "claude", provider: "my-key", accountID: nil,
                                                       accounts: nil, poolLogin: nil))
    }

    // MARK: the model

    @MainActor
    func testModelLoadsTheDetailAndTheLink() async {
        let api = FakeSettingsAPI()
        api.link = Self.link(state: .active)
        let model = SessionSettingsModel(sessionID: "s1", api: api)
        await model.load()
        XCTAssertEqual(model.settings?.env["DEBUG"], "orbit:*")
        XCTAssertTrue(model.publicLinkOn)
        XCTAssertNil(model.loadError)
    }

    @MainActor
    func testEachChangeIsSentAtOnceAndAdoptsTheServersAnswer() async {
        let api = FakeSettingsAPI()
        let model = SessionSettingsModel(sessionID: "s1", api: api)
        await model.load()
        await model.setMuted(true)
        await model.setNotifyTurnFinished(.off)
        await model.setCompactAt("500000")
        await model.setVariable("LOG_LEVEL", value: "debug")
        await model.removeVariable("DEBUG")
        XCTAssertEqual(api.patches.map(\.muted), [true, nil, nil, nil, nil])
        XCTAssertEqual(api.patches[1].notifyTurnFinished, .off)
        XCTAssertEqual(api.patches[2].env?["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "500000")
        XCTAssertEqual(api.patches[4].env, ["LOG_LEVEL": "debug", "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "500000"])
        XCTAssertTrue(model.settings?.muted ?? false)
        XCTAssertEqual(model.compactAt, "500000")
        XCTAssertEqual(model.changedKeys, ["CLAUDE_CODE_AUTO_COMPACT_WINDOW", "LOG_LEVEL", "DEBUG"])
        XCTAssertTrue(model.settings?.envPendingRestart ?? false, "the server says a live engine now owes a restart")
    }

    @MainActor
    func testARefusedChangeIsPutBackWithTheServersReason() async {
        let api = FakeSettingsAPI()
        let model = SessionSettingsModel(sessionID: "s1", api: api)
        await model.load()
        api.refuse = APIError.http(status: 400, body: #"{"message":"env value of \"BIG\" is longer than 32 KB"}"#)
        await model.setVariable("BIG", value: "x")
        XCTAssertNil(model.settings?.env["BIG"])
        XCTAssertEqual(model.saveError, #"env value of "BIG" is longer than 32 KB"#)
        XCTAssertTrue(model.changedKeys.isEmpty)
    }

    @MainActor
    func testRenamingAVariableDropsTheOldName() async {
        let api = FakeSettingsAPI()
        let model = SessionSettingsModel(sessionID: "s1", api: api)
        await model.load()
        await model.setVariable("TRACE", value: "1", replacing: "DEBUG")
        XCTAssertEqual(model.settings?.env, ["LOG_LEVEL": "trace", "TRACE": "1"])
    }

    @MainActor
    func testRestartQueuesAfterTheTurnAndAnEndedEngineHidesTheBanner() async {
        let api = FakeSettingsAPI()
        let model = SessionSettingsModel(sessionID: "s1", api: api)
        await model.load()
        model.turnRunning = true
        XCTAssertEqual(model.restartBanner?.button, "Restart after this turn")
        await model.restart()
        XCTAssertEqual(api.restarts, 1)
        XCTAssertNil(model.restartBanner?.button)

        let ended = FakeSettingsAPI()
        ended.restartError = APIError.http(status: 409, body: #"{"code":"ENGINE_NOT_RUNNING"}"#)
        let other = SessionSettingsModel(sessionID: "s1", api: ended)
        await other.load()
        await other.restart()
        XCTAssertNil(other.restartBanner)
        XCTAssertNil(other.saveError)
    }

    @MainActor
    func testPublicLinkTurnsOnAndOff() async {
        let api = FakeSettingsAPI()
        let model = SessionSettingsModel(sessionID: "s1", api: api)
        await model.load()
        XCTAssertFalse(model.publicLinkOn)
        await model.setPublicLink(true)
        XCTAssertTrue(model.publicLinkOn)
        await model.setPublicLink(false)
        XCTAssertFalse(model.publicLinkOn)
        XCTAssertEqual(api.shareCalls, ["put", "delete"])
    }

    static func link(state: ShareLinkState) -> ShareLink {
        ShareLink(id: "l1", kind: .session, token: "k3Rw9Tq2", state: state, root: ShareRootSummary(id: "s1"))
    }
}

private final class FakeSettingsAPI: SessionSettingsAPI, @unchecked Sendable {
    var settings = SessionSettingsValues(env: ["DEBUG": "orbit:*", "LOG_LEVEL": "trace"],
                                   workspaceEnv: ["NODE_OPTIONS": "--max-old-space-size=6144"],
                                   envPendingRestart: true)
    var link: ShareLink?
    var patches: [SessionSettingsPatch] = []
    var refuse: Error?
    var restartError: Error?
    var restarts = 0
    var shareCalls: [String] = []

    func sessionSettingsDetail(_ id: String) async throws -> SessionSettingsDetail {
        SessionSettingsDetail(settings: settings, usage: SessionUsage(numTurns: 1), engineVersion: "2.4.1")
    }

    func patchSessionSettings(_ id: String, _ patch: SessionSettingsPatch) async throws -> SessionSettingsValues {
        if let refuse { throw refuse }
        patches.append(patch)
        if let env = patch.env { settings.env = env; settings.envPendingRestart = true }
        if let v = patch.notifyTurnFinished { settings.notifyTurnFinished = v }
        if let v = patch.notifyNeedsYou { settings.notifyNeedsYou = v }
        if let v = patch.muted { settings.muted = v }
        return settings
    }

    func restartSession(_ id: String) async throws -> SessionRestartResponse {
        if let restartError {
            settings.envPendingRestart = false
            throw restartError
        }
        restarts += 1
        return SessionRestartResponse(afterTurn: true)
    }

    func shareLink(_ kind: ShareRootKind, _ id: String) async throws -> ShareLinkRead { ShareLinkRead(link: link) }

    func putShareLink(_ kind: ShareRootKind, _ id: String, _ body: PutShareLinkRequest) async throws -> ShareLink {
        shareCalls.append("put")
        link = SessionSettingsTests.link(state: .active)
        return link!
    }

    func turnOffShareLink(_ kind: ShareRootKind, _ id: String) async throws {
        shareCalls.append("delete")
        link = nil
    }
}

private final class SettingsURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, body: Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        let result = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: result.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: result.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class SettingsSeenRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [URLRequest] = []
    func record(_ r: URLRequest) { lock.lock(); seen.append(r); lock.unlock() }
    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return seen }
}
