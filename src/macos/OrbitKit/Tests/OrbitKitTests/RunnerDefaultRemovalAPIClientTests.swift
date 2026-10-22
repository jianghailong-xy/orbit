import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class DefaultRemovalURLProtocol: URLProtocol, @unchecked Sendable {
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

/// Removing a runner's Default from Orbit is the account removal's own route, answered `done` at once;
/// Use again is the restore route beside it (S1: `DELETE /runners/:id/accounts/:engine/default`,
/// `POST …/default/restore`). The control plane's refusal comes back in its own words.
final class RunnerDefaultRemovalAPIClientTests: XCTestCase {
    override func tearDown() {
        DefaultRemovalURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DefaultRemovalURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(), session: URLSession(configuration: configuration))
    }

    func testRemovesDefaultOnTheAccountsOwnRouteAndReadsItsAnswer() async throws {
        let seen = DefaultRemovalSeenRequest()
        DefaultRemovalURLProtocol.handler = { request in
            seen.record(request)
            return (200, Data(#"{"engine":"codex","account":"default","status":"done","message":null}"#.utf8))
        }
        let state = try await client().removeRunnerAccount("runner", engine: .codex, account: CodexAccounts.defaultID)
        let request = try XCTUnwrap(seen.request)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/api/runners/runner/accounts/codex/default")
        XCTAssertEqual(state.status, "done")
        XCTAssertEqual(state.account, "default")
    }

    func testUseAgainPostsTheRestoreRoute() async throws {
        let seen = DefaultRemovalSeenRequest()
        DefaultRemovalURLProtocol.handler = { request in
            seen.record(request)
            return (201, Data(#"{"ok":true}"#.utf8))
        }
        try await client().restoreRunnerDefault("runner", engine: .claude)
        let request = try XCTUnwrap(seen.request)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/runners/runner/accounts/claude/default/restore")
    }

    func testARefusalKeepsTheControlPlanesSentence() async {
        DefaultRemovalURLProtocol.handler = { _ in
            (400, Data(#"{"message":"Add another Codex account to this machine before removing Default."}"#.utf8))
        }
        do {
            _ = try await client().removeRunnerAccount("runner", engine: .codex, account: CodexAccounts.defaultID)
            XCTFail("a refused removal succeeded")
        } catch {
            XCTAssertEqual(APIClient.failureReason(error), "Add another Codex account to this machine before removing Default.")
        }
    }
}

/// The request the stub was handed, read back by the test once the call returned.
private final class DefaultRemovalSeenRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: URLRequest?

    func record(_ request: URLRequest) {
        lock.lock()
        seen = request
        lock.unlock()
    }

    var request: URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }
}
