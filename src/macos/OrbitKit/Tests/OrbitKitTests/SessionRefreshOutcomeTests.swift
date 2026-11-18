import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class RefreshStubURLProtocol: URLProtocol, @unchecked Sendable {
    enum Answer { case status(Int, Data), fail(URLError.Code) }
    static var handler: ((URLRequest) -> Answer)?
    static var requests: [(path: String, auth: String?)] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append((request.url?.path ?? "", request.value(forHTTPHeaderField: "Authorization")))
        switch Self.handler?(request) ?? .fail(.unknown) {
        case .fail(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .status(let status, let body):
            let response = HTTPURLResponse(url: request.url!, statusCode: status,
                                           httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

/// A 401 sends the client through one refresh. Only the server refusing that refresh (401/403) ends
/// the session; a refresh that times out or meets a 5xx/429 must leave both tokens stored and
/// surface a transient error the app keeps its last good state on, never `.unauthorized` (which it
/// answers by signing out and revoking the refresh token).
final class SessionRefreshOutcomeTests: XCTestCase {
    private var store: InMemoryTokenStore!
    private var baseURL: URL!

    override func setUp() {
        super.setUp()
        RefreshStubURLProtocol.requests = []
        store = InMemoryTokenStore()
        // The refresher registry is process-wide and keyed by host: a fresh host per test keeps each
        // test on its own refresher, session and store.
        baseURL = URL(string: "https://\(UUID().uuidString.lowercased()).orbit.test")!
        store.setToken("old-access", for: baseURL)
        store.setRefreshToken("old-refresh", for: baseURL)
    }

    override func tearDown() {
        RefreshStubURLProtocol.handler = nil
        RefreshStubURLProtocol.requests = []
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RefreshStubURLProtocol.self]
        return APIClient(baseURL: baseURL, tokenStore: store,
                         session: URLSession(configuration: configuration))
    }

    /// Every request but the refresh answers 401 with the old token and 200 with a new one.
    private func answer(refresh: RefreshStubURLProtocol.Answer) {
        RefreshStubURLProtocol.handler = { req in
            if req.url?.path == "/api/auth/refresh" { return refresh }
            let auth = req.value(forHTTPHeaderField: "Authorization")
            return auth == "Bearer new-access" ? .status(200, Data()) : .status(401, Data())
        }
    }

    private func callAfterRefresh(_ refresh: RefreshStubURLProtocol.Answer) async -> Error? {
        answer(refresh: refresh)
        do {
            try await client().refreshDiff(sessionID: "s1")
            return nil
        } catch {
            return error
        }
    }

    private func assertTransientKeepingTokens(_ refresh: RefreshStubURLProtocol.Answer,
                                              file: StaticString = #filePath, line: UInt = #line) async {
        let error = await callAfterRefresh(refresh)
        XCTAssertEqual(error as? APIError, .refreshUnavailable, file: file, line: line)
        XCTAssertNotEqual(error as? APIError, .unauthorized, file: file, line: line)
        XCTAssertEqual(store.token(for: baseURL), "old-access", file: file, line: line)
        XCTAssertEqual(store.refreshToken(for: baseURL), "old-refresh", file: file, line: line)
        XCTAssertEqual(RefreshStubURLProtocol.requests.map(\.path),
                       ["/api/sessions/s1/diff/refresh", "/api/auth/refresh"], file: file, line: line)
    }

    func testRefreshThatTimesOutIsTransientAndKeepsBothTokens() async {
        await assertTransientKeepingTokens(.fail(.timedOut))
    }

    func testRefreshWithNoNetworkIsTransientAndKeepsBothTokens() async {
        await assertTransientKeepingTokens(.fail(.notConnectedToInternet))
    }

    func testRefreshAnswered503IsTransientAndKeepsBothTokens() async {
        await assertTransientKeepingTokens(.status(503, Data("<html>Service Unavailable</html>".utf8)))
    }

    func testRefreshAnswered429IsTransientAndKeepsBothTokens() async {
        await assertTransientKeepingTokens(.status(429, Data()))
    }

    func testRefreshWithAnUnreadableBodyIsTransientAndKeepsBothTokens() async {
        await assertTransientKeepingTokens(.status(200, Data("not json".utf8)))
    }

    func testRefreshAnswered401IsUnauthorized() async {
        let error = await callAfterRefresh(.status(401, Data(#"{"error":"invalid refresh token"}"#.utf8)))
        XCTAssertEqual(error as? APIError, .unauthorized)
    }

    func testRefreshAnswered403IsUnauthorized() async {
        let error = await callAfterRefresh(.status(403, Data()))
        XCTAssertEqual(error as? APIError, .unauthorized)
    }

    func testNoStoredRefreshTokenIsUnauthorized() async {
        store.setRefreshToken(nil, for: baseURL)
        let error = await callAfterRefresh(.status(200, Data()))
        XCTAssertEqual(error as? APIError, .unauthorized)
        XCTAssertEqual(RefreshStubURLProtocol.requests.map(\.path), ["/api/sessions/s1/diff/refresh"])
    }

    func testSuccessfulRefreshRetriesOnceAndSucceeds() async {
        let pair = Data(#"{"accessToken":"new-access","refreshToken":"new-refresh"}"#.utf8)
        let error = await callAfterRefresh(.status(200, pair))
        XCTAssertNil(error)
        XCTAssertEqual(store.token(for: baseURL), "new-access")
        XCTAssertEqual(store.refreshToken(for: baseURL), "new-refresh")
        XCTAssertEqual(RefreshStubURLProtocol.requests.map(\.path),
                       ["/api/sessions/s1/diff/refresh", "/api/auth/refresh", "/api/sessions/s1/diff/refresh"])
        XCTAssertEqual(RefreshStubURLProtocol.requests.last?.auth, "Bearer new-access")
    }

    /// The control-plane stream's refresh: false on both failure kinds, and an unreachable server
    /// leaves the tokens where they were.
    func testRefreshSessionIsFalseOnBothFailureKindsAndKeepsTokensWhenUnreachable() async {
        answer(refresh: .status(503, Data()))
        let unreachable = await client().refreshSession()
        XCTAssertFalse(unreachable)
        XCTAssertEqual(store.token(for: baseURL), "old-access")
        XCTAssertEqual(store.refreshToken(for: baseURL), "old-refresh")

        answer(refresh: .status(401, Data()))
        let refused = await client().refreshSession()
        XCTAssertFalse(refused)
    }
}
