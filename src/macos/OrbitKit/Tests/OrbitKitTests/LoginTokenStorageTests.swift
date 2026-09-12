import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// Sign-in must not report success when the token store didn't keep the tokens. An unsigned simulator
/// build's Keychain refuses every write: the login "succeeded", the next request went out without a
/// token and 401'd, and the app dropped back to the login screen with no reason shown.
private final class LoginURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = #"{"accessToken":"access-1","refreshToken":"refresh-1","user":{"id":"u1","email":"a@b.test"}}"#
        let response = HTTPURLResponse(url: request.url!, statusCode: 201,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// A store whose writes don't stick for the token kinds named — the Keychain of an unsigned build.
/// Clearing (a nil write) still goes through, so a test can see what a failed sign-in leaves behind.
private final class DroppingTokenStore: TokenStore, @unchecked Sendable {
    private let inner = InMemoryTokenStore()
    private let dropsAccess: Bool
    private let dropsRefresh: Bool

    init(dropsAccess: Bool, dropsRefresh: Bool) {
        self.dropsAccess = dropsAccess
        self.dropsRefresh = dropsRefresh
    }

    func token(for serverURL: URL) -> String? { inner.token(for: serverURL) }
    func setToken(_ token: String?, for serverURL: URL) {
        if token == nil || !dropsAccess { inner.setToken(token, for: serverURL) }
    }
    func refreshToken(for serverURL: URL) -> String? { inner.refreshToken(for: serverURL) }
    func setRefreshToken(_ token: String?, for serverURL: URL) {
        if token == nil || !dropsRefresh { inner.setRefreshToken(token, for: serverURL) }
    }
}

final class LoginTokenStorageTests: XCTestCase {
    private let baseURL = URL(string: "https://orbit.test")!

    private func client(_ store: TokenStore) -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LoginURLProtocol.self]
        return APIClient(baseURL: baseURL, tokenStore: store,
                         session: URLSession(configuration: configuration))
    }

    func testLoginKeepsBothTokensWhenTheStoreHoldsThem() async throws {
        let store = InMemoryTokenStore()

        _ = try await client(store).login(email: "a@b.test", password: "pw")

        XCTAssertEqual(store.token(for: baseURL), "access-1")
        XCTAssertEqual(store.refreshToken(for: baseURL), "refresh-1")
    }

    func testLoginFailsWhenTheStoreDropsTheTokens() async {
        let store = DroppingTokenStore(dropsAccess: true, dropsRefresh: true)

        do {
            _ = try await client(store).login(email: "a@b.test", password: "pw")
            XCTFail("login reported success with no token stored")
        } catch {
            XCTAssertEqual(error as? TokenNotStoredError, TokenNotStoredError())
        }
    }

    func testLoginLeavesNoHalfSessionWhenOnlyTheRefreshTokenIsDropped() async {
        let store = DroppingTokenStore(dropsAccess: false, dropsRefresh: true)

        do {
            _ = try await client(store).login(email: "a@b.test", password: "pw")
            XCTFail("login reported success with no refresh token stored")
        } catch {
            XCTAssertEqual(error as? TokenNotStoredError, TokenNotStoredError())
        }
        XCTAssertNil(store.token(for: baseURL))
    }
}
