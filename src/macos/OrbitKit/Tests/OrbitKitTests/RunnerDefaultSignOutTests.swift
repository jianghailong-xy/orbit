import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class SignOutURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest, Data?) -> (status: Int, body: Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            stream.close()
            body = data
        }
        let result = handler(request, body)
        let response = HTTPURLResponse(url: request.url!, statusCode: result.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: result.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class SignOutSeen: @unchecked Sendable {
    private let lock = NSLock()
    private var seenRequest: URLRequest?
    private var seenBody: Data?
    func record(_ request: URLRequest, _ body: Data?) {
        lock.lock(); seenRequest = request; seenBody = body; lock.unlock()
    }
    var request: URLRequest? { lock.lock(); defer { lock.unlock() }; return seenRequest }
    var body: Data? { lock.lock(); defer { lock.unlock() }; return seenBody }
}

/// Signing a runner's Default account out (docs/default-sign-out-design.md): the route, its `force`,
/// who is offered it, and the words of its two questions.
final class RunnerDefaultSignOutTests: XCTestCase {
    override func tearDown() {
        SignOutURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SignOutURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(), session: URLSession(configuration: configuration))
    }

    // MARK: the call

    func testSignOutPostsTheDefaultSignOutRouteWithoutForce() async throws {
        let seen = SignOutSeen()
        SignOutURLProtocol.handler = { request, body in
            seen.record(request, body)
            return (201, Data(#"{"engine":"claude","account":"default","status":"pending","message":null}"#.utf8))
        }
        let state = try await client().signOutRunnerDefault("runner", engine: .claude)
        let request = try XCTUnwrap(seen.request)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/runners/runner/accounts/claude/default/sign-out")
        let body = try XCTUnwrap(seen.body)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["force"] as? Bool, false)
        XCTAssertEqual(state.status, "pending")
        XCTAssertEqual(state.account, "default")
    }

    func testTheSecondAskResendsWithForce() async throws {
        let seen = SignOutSeen()
        SignOutURLProtocol.handler = { request, body in
            seen.record(request, body)
            return (201, Data(#"{"engine":"codex","account":"default","status":"pending","message":null}"#.utf8))
        }
        _ = try await client().signOutRunnerDefault("runner", engine: .codex, force: true)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(seen.body)) as? [String: Any])
        XCTAssertEqual(object["force"] as? Bool, true)
        XCTAssertEqual(seen.request?.url?.path, "/api/runners/runner/accounts/codex/default/sign-out")
    }

    func testARefusalKeepsTheControlPlanesSentence() async {
        SignOutURLProtocol.handler = { _, _ in
            (400, Data(#"{"message":"The runner on Mini is too old to sign Codex out. Update the runner on Mini, then try again."}"#.utf8))
        }
        do {
            _ = try await client().signOutRunnerDefault("runner", engine: .codex)
            XCTFail("a refused sign-out succeeded")
        } catch {
            XCTAssertEqual(APIClient.failureReason(error),
                           "The runner on Mini is too old to sign Codex out. Update the runner on Mini, then try again.")
        }
    }

    // MARK: who is offered it

    private func runner(auth: String, capabilities: [String]) throws -> Runner {
        let caps = capabilities.map { "\"\($0)\"" }.joined(separator: ",")
        let json = """
        {"id":"R1","name":"mini","displayName":"Mini","hostname":"mini","status":"ONLINE","online":true,
         "capabilities":[\(caps)],
         "engines":[{"engine":"claude","installed":true,"auth":"\(auth)"}]}
        """
        return try JSONDecoder().decode(Runner.self, from: Data(json.utf8))
    }

    private func defaultLine(_ runner: Runner) throws -> RunnerPageFormat.AccountLine {
        let health = try XCTUnwrap(RunnerPageFormat.engines(runner).first { $0.engine == "claude" })
        return try XCTUnwrap(RunnerPageFormat.accountLines(health).first { $0.isDefault })
    }

    func testOnlyASignedInDefaultOnARunnerThatDeclaredItIsOfferedSignOut() throws {
        let declared = try runner(auth: "yes", capabilities: ["claude-default-sign-out/v1"])
        XCTAssertTrue(RunnerPageFormat.offersSignOut(try defaultLine(declared), engine: "claude", runner: declared))

        let old = try runner(auth: "yes", capabilities: [])
        XCTAssertFalse(RunnerPageFormat.offersSignOut(try defaultLine(old), engine: "claude", runner: old))

        let signedOut = try runner(auth: "no", capabilities: ["claude-default-sign-out/v1"])
        XCTAssertFalse(RunnerPageFormat.offersSignOut(try defaultLine(signedOut), engine: "claude", runner: signedOut))

        let other = try runner(auth: "yes", capabilities: ["codex-default-sign-out/v1"])
        XCTAssertFalse(RunnerPageFormat.offersSignOut(try defaultLine(other), engine: "claude", runner: other))
    }

    func testSignOutIsDisabledOfflineAndWhileARequestIsPending() {
        XCTAssertTrue(RunnerPageFormat.canSignOut(offline: false, pending: false))
        XCTAssertFalse(RunnerPageFormat.canSignOut(offline: true, pending: false))
        XCTAssertFalse(RunnerPageFormat.canSignOut(offline: false, pending: true))
    }

    // MARK: the words

    func testTheConfirmationNamesTheTerminalOnlyForClaudeAndCodex() throws {
        let runner = try runner(auth: "yes", capabilities: ["claude-default-sign-out/v1"])
        let line = try defaultLine(runner)
        let claude = RunnerPageFormat.signOutQuestion(line, engine: "claude", runner: runner)
        XCTAssertEqual(claude.title, "Sign out of Default?")
        XCTAssertEqual(claude.message,
                       "Its login is deleted from Mini. Its history and settings stay. claude in a terminal on Mini is signed out too.")
        let codex = RunnerPageFormat.signOutQuestion(line, engine: "codex", runner: runner)
        XCTAssertTrue(codex.message.hasSuffix("codex in a terminal on Mini is signed out too."), codex.message)
        let cursor = RunnerPageFormat.signOutQuestion(line, engine: "cursor", runner: runner)
        XCTAssertEqual(cursor.message, "Its login is deleted from Mini. Its history and settings stay.")
        XCTAssertEqual(RunnerAccountCopy.RUNNER_DEFAULT_SIGN_OUT, "Sign out…")
    }

    func testASessionsRefusalAsksAgainWithTheCount() throws {
        let runner = try runner(auth: "yes", capabilities: ["claude-default-sign-out/v1"])
        let line = try defaultLine(runner)
        let one = RunnerPageFormat.signOutAgainQuestion(line, count: 1)
        XCTAssertEqual(one.title, "1 session is running on Default. Sign out anyway?")
        XCTAssertEqual(one.message, "They will stop working until you sign in again.")
        XCTAssertEqual(RunnerPageFormat.signOutAgainQuestion(line, count: 3).title,
                       "3 sessions are running on Default. Sign out anyway?")
    }

    func testARefusedSignOutIsSaidInSignOutWordsNotRemovalWords() throws {
        let state = try JSONDecoder().decode(RunnerAccountRemoveState.self, from: Data("""
        {"engine":"claude","account":"default","status":"failed","message":"in use",
         "sessions":[{"id":"S1","title":"Fix it","status":"RUNNING"},{"id":"S2","title":"","status":"AWAITING_INPUT"}]}
        """.utf8))
        let removal = try XCTUnwrap(RunnerPageFormat.removal(state, engine: "claude", account: "default"))
        XCTAssertEqual(removal.blocking.count, 2)
        XCTAssertEqual(removal.refused,
                       "2 sessions are running on Default. Sign out anyway?")
    }
}
