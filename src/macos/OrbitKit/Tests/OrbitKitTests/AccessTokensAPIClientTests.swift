import Foundation
import XCTest
@testable import OrbitKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class AccessTokenDoorURLProtocol: URLProtocol, @unchecked Sendable {
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

/// What reached the wire: the method and the path.
private final class AccessTokenDoorRecorder: @unchecked Sendable {
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

/// Settings → Access tokens' two doors (docs/personal-access-token-design.md §6.5): the account's
/// tokens are one read, and revoking one is a DELETE at its own path — the web page's
/// `listAccessTokens` and `revokeAccessToken`. Issuing, `POST /access-tokens`, is the web's alone.
final class AccessTokensAPIClientTests: XCTestCase {

    override func tearDown() {
        AccessTokenDoorURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AccessTokenDoorURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private func answer(_ json: String, status: Int = 200) -> AccessTokenDoorRecorder {
        let recorder = AccessTokenDoorRecorder()
        AccessTokenDoorURLProtocol.handler = { request in
            recorder.append(request)
            return (status, Data(json.utf8))
        }
        return recorder
    }

    func testTheAccountsTokensAreOneRead() async throws {
        let recorder = answer("""
        {"tokens":[{"id":"34ajTok1","name":"deploy-bot","tokenHint":"k3Fq","scopes":["tasks:read"],
          "workspaceIds":[],"workspaces":[],"expiresAt":null,"createdVia":"WEB","lastUsedAt":null,
          "lastUsedIp":null,"lastUsedUserAgent":null,"revokedAt":null,"revokedReason":null,
          "createdAt":"2026-09-01T12:00:00.000Z","state":"ACTIVE"}]}
        """)
        let tokens = try await client().accessTokens()
        XCTAssertEqual(tokens.map(\.name), ["deploy-bot"])
        XCTAssertEqual(recorder.sent, ["GET /api/access-tokens"])
    }

    func testRevokingIsADeleteAtTheTokensPath() async throws {
        let recorder = answer(#"{"id":"34ajTok1","revokedAt":"2026-10-06T12:00:00.000Z","revokedReason":"USER"}"#)
        let revoked = try await client().revokeAccessToken("34ajTok1")
        XCTAssertEqual(revoked.revokedReason, "USER")
        XCTAssertEqual(recorder.sent, ["DELETE /api/access-tokens/34ajTok1"])
    }

    /// A refusal — a token that isn't the account's — surfaces as the server's own answer.
    func testARefusalSurfacesAsTheServersAnswer() async throws {
        _ = answer(#"{"message":"access token not found","statusCode":404}"#, status: 404)
        do {
            try await client().revokeAccessToken("34ajGone")
            XCTFail("a 404 is not a revoked token")
        } catch APIError.http(let status, let body) {
            XCTAssertEqual(status, 404)
            XCTAssertEqual(APIClient.failureReason(APIError.http(status: status, body: body)), "access token not found")
        }
    }
}
