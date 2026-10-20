import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// Stands in for the network: records what reached it and answers the door's empty receipt.
private final class LandingRerunURLProtocol: URLProtocol, @unchecked Sendable {
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

/// URLProtocol hands back a request whose body has been moved to `httpBodyStream`, so the bytes are
/// read off the stream rather than off `httpBody` (which is nil by then).
private func landingSentBody(_ request: URLRequest) -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        if read <= 0 { break }
        data.append(contentsOf: buffer[0..<read])
    }
    return data
}

/// THE LANDING PAGE'S Re-run the check CARRIES A REASON, BECAUSE THE OWNER ROUTE REQUIRES ONE.
///
/// `POST /projects/:id/promotions/:promotionId/integration/retry` takes `RetryIntegrationDto`, whose
/// `reason` is `@MinLength(1)`. A bodyless press is refused before the queue sees it — so the page
/// sends the same sentence web and Android send, naming the page the door was pressed on, and this
/// pins the request the client actually makes.
final class LandingRerunDoorTests: XCTestCase {
    override func tearDown() {
        LandingRerunURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LandingRerunURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    /// What reached the wire, recorded off the protocol's own thread.
    private final class Recorder: @unchecked Sendable {
        struct Sent {
            let method: String?
            let path: String?
            let body: [String: Any]
        }
        private let lock = NSLock()
        private var storage: [Sent] = []
        func record(_ request: URLRequest) {
            let body = (try? JSONSerialization.jsonObject(with: landingSentBody(request))) as? [String: Any]
            lock.lock()
            storage.append(Sent(method: request.httpMethod, path: request.url?.path, body: body ?? [:]))
            lock.unlock()
        }
        var sent: [Sent] {
            lock.lock()
            defer { lock.unlock() }
            return storage
        }
    }

    func testReRunPostsTheReasonTheOwnerRouteRequires() async throws {
        let recorder = Recorder()
        LandingRerunURLProtocol.handler = { request in
            recorder.record(request)
            return (200, Data("{}".utf8))
        }

        try await client().rerunPromotionCheck(projectID: "project1", promotionID: "promo1")

        let sent = recorder.sent
        XCTAssertEqual(sent.count, 1, "one press is one request")
        let press = try XCTUnwrap(sent.first)
        XCTAssertEqual(press.method, "POST")
        XCTAssertEqual(press.path, "/api/projects/project1/promotions/promo1/integration/retry")
        XCTAssertEqual(press.body["reason"] as? String, LandingPageCopy.rerunLandingCheckReason,
                       "a bodyless press is refused by RetryIntegrationDto before the queue is asked")
        XCTAssertEqual(press.body["reason"] as? String,
                       "Re-run the timed-out check from the landing page.",
                       "the sentence web and Android send, verbatim")
    }
}
