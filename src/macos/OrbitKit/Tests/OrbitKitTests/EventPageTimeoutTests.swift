import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// The transcript pages' per-request timeout — the seam the console uses to make the reads that
/// gate a first paint (the tail seed, a record link) and a reconnect's catch-up fail fast on a
/// dead socket, so their retry opens a fresh connection instead of waiting out the 60s session
/// default. Every other request must keep that default (see `APIClient.makeRequest`).
private final class EventPageURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw APIError.invalidResponse }
            let (status, bytes) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status,
                                           httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: bytes)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}

final class EventPageTimeoutTests: XCTestCase {
    override func tearDown() {
        EventPageURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EventPageURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private static let emptyPage = Data(#"{"events":[],"hasMore":false}"#.utf8)

    func testTailSeedTimeoutReachesTheRequestAndTheQueryKeepsItsShape() async throws {
        EventPageURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/sessions/session-1/events/page")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(query, [URLQueryItem(name: "tail", value: "200"),
                                   URLQueryItem(name: "maxPayload", value: "2048")])
            XCTAssertEqual(request.timeoutInterval, 20)
            return (200, Self.emptyPage)
        }

        let page = try await client().eventPage(sessionID: "session-1", tail: 200, timeout: 20)
        XCTAssertTrue(page.events.isEmpty)
    }

    func testCatchUpPagePassesAfterCursorAndTimeout() async throws {
        EventPageURLProtocol.handler = { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(query, [URLQueryItem(name: "after", value: "41"),
                                   URLQueryItem(name: "limit", value: "200"),
                                   URLQueryItem(name: "maxPayload", value: "2048")])
            XCTAssertEqual(request.timeoutInterval, 20)
            return (200, Self.emptyPage)
        }

        _ = try await client().eventPageAfter(sessionID: "session-1", after: 41, limit: 200, timeout: 20)
    }

    /// Every other page read — history paging, a window opened at a record — keeps the session
    /// default: only the reads whose failure has a fast retry behind them are shortened.
    func testOmittedTimeoutLeavesTheSessionDefault() async throws {
        EventPageURLProtocol.handler = { request in
            XCTAssertEqual(request.timeoutInterval, 60)
            return (200, Self.emptyPage)
        }

        _ = try await client().eventPage(sessionID: "session-1", before: 500, limit: 200)
    }
}
