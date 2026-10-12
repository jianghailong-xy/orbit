import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class OpenListURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, headers: [String: String], data: Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        let answer = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status,
                                       httpVersion: nil, headerFields: answer.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// The `If-None-Match` header of each request that reached the wire, in order ("" for none).
private final class TagRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    func append(_ request: URLRequest) {
        lock.lock()
        storage.append(request.value(forHTTPHeaderField: "If-None-Match") ?? "")
        lock.unlock()
    }

    var sent: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

/// The Open list is polled every few seconds and is the app's largest response, so it is asked for
/// against the tag of the copy already held: an unchanged list comes back as an empty 304.
final class OpenListETagAPIClientTests: XCTestCase {
    override func tearDown() {
        OpenListURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OpenListURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    func testAFirstReadAsksUnconditionallyAndKeepsTheTag() async throws {
        let recorder = TagRecorder()
        OpenListURLProtocol.handler = { request in
            recorder.append(request)
            XCTAssertEqual(request.url?.path, "/api/sessions")
            XCTAssertEqual(request.url?.query, "view=open")
            return (200, ["ETag": "W/\"17d4a7-abc\""], Data("[]".utf8))
        }
        let fresh = try await client().listOpenSessions(ifNoneMatch: nil)
        XCTAssertEqual(fresh?.sessions, [])
        XCTAssertEqual(fresh?.etag, "W/\"17d4a7-abc\"")
        XCTAssertEqual(recorder.sent, [""])
    }

    func testAnUnchangedListAnswersNil() async throws {
        let recorder = TagRecorder()
        OpenListURLProtocol.handler = { request in
            recorder.append(request)
            return (304, [:], Data())
        }
        let fresh = try await client().listOpenSessions(ifNoneMatch: "W/\"17d4a7-abc\"")
        XCTAssertNil(fresh)
        XCTAssertEqual(recorder.sent, ["W/\"17d4a7-abc\""])
    }

    /// A 304 is an answer only to a request that asked for one; anywhere else it is still an error.
    func testA304ToAnUnconditionalReadIsStillAnError() async throws {
        OpenListURLProtocol.handler = { _ in (304, [:], Data()) }
        do {
            _ = try await client().listSessions(view: .open)
            XCTFail("expected the 304 to throw")
        } catch APIError.http(let status, _) {
            XCTAssertEqual(status, 304)
        }
    }

    /// A server that turns the query down gets the compatible unconditional read, and no tag is kept.
    func testARejectedQueryFallsBackToTheUnconditionalRead() async throws {
        let recorder = TagRecorder()
        OpenListURLProtocol.handler = { request in
            recorder.append(request)
            return recorder.sent.count == 1 ? (400, [:], Data()) : (200, ["ETag": "W/\"x\""], Data("[]".utf8))
        }
        let fresh = try await client().listOpenSessions(ifNoneMatch: "W/\"old\"")
        XCTAssertEqual(fresh?.sessions, [])
        XCTAssertNil(fresh?.etag)
        XCTAssertEqual(recorder.sent, ["W/\"old\"", ""])
    }
}
