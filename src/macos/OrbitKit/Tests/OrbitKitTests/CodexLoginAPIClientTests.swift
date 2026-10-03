import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class CodexLoginURLProtocol: URLProtocol, @unchecked Sendable {
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

/// Signing one of a Codex pool's ChatGPT accounts out names that account to the server by its fingerprint,
/// as web's pool page does (`/account?fingerprint=${encodeURIComponent(login.fingerprint)}`): the pool's
/// other accounts stay. The fingerprint opens with `…`, which goes over the wire percent-encoded.
final class CodexLoginAPIClientTests: XCTestCase {
    override func tearDown() {
        CodexLoginURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CodexLoginURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    func testSignsOutTheOneAccountItNames() async throws {
        let seen = SeenRequest()
        CodexLoginURLProtocol.handler = { request in
            seen.record(request)
            return (200, Data(#"{"removed":1}"#.utf8))
        }
        let answer = try await client().signOutCodexLogin(poolID: "2zQeDGWFFAgN2112jNFD6", fingerprint: "…016a")
        XCTAssertEqual(answer.removed, 1)
        let request = try XCTUnwrap(seen.request)
        XCTAssertEqual(request.httpMethod, "DELETE")
        let url = try XCTUnwrap(request.url)
        XCTAssertEqual(url.path, "/api/providers/pools/2zQeDGWFFAgN2112jNFD6/codex-login/account")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery,
                       "fingerprint=%E2%80%A6016a")
    }

    /// Two accounts of the pool share the last four characters of their id: the server will not guess
    /// which one is meant, and says so in words the page can show.
    func testSaysWhyAnAmbiguousSignOutWasRefused() async {
        CodexLoginURLProtocol.handler = { _ in
            (409, Data(#"{"statusCode":409,"code":"POOL_CODEX_ACCOUNT_AMBIGUOUS","message":"\"My Codex\" holds more than one ChatGPT account named …016a"}"#.utf8))
        }
        do {
            try await client().signOutCodexLogin(poolID: "p", fingerprint: "…016a")
            XCTFail("an ambiguous sign-out went through")
        } catch {
            XCTAssertEqual(APIClient.refusalCode(error), "POOL_CODEX_ACCOUNT_AMBIGUOUS")
            XCTAssertEqual(APIClient.failureReason(error), "\"My Codex\" holds more than one ChatGPT account named …016a")
        }
    }
}

/// The request the stub was handed, read back by the test once the call returned.
private final class SeenRequest: @unchecked Sendable {
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
