import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// Stands in for the network: records what reached it and answers the door's count.
private final class ProjectSessionsCompleteURLProtocol: URLProtocol, @unchecked Sendable {
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

/// Complete on a finished project's row (docs/session-list-projects-design.md §3.6, §4.3) is one
/// press on the server's project door, `POST /projects/:id/sessions/complete`.
final class ProjectSessionsCompleteDoorTests: XCTestCase {
    override func tearDown() {
        ProjectSessionsCompleteURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProjectSessionsCompleteURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [(method: String?, path: String?)] = []
        func record(_ request: URLRequest) {
            lock.lock()
            storage.append((request.httpMethod, request.url?.path))
            lock.unlock()
        }
        var sent: [(method: String?, path: String?)] {
            lock.lock()
            defer { lock.unlock() }
            return storage
        }
    }

    func testCompletePostsTheProjectDoorAndAnswersHowManyMoved() async throws {
        let recorder = Recorder()
        ProjectSessionsCompleteURLProtocol.handler = { request in
            recorder.record(request)
            return (201, Data(#"{"completed":3}"#.utf8))
        }
        let moved = try await client().completeProjectSessions("p1")
        XCTAssertEqual(moved, 3)
        XCTAssertEqual(recorder.sent.count, 1)
        XCTAssertEqual(recorder.sent.first?.method, "POST")
        XCTAssertEqual(recorder.sent.first?.path?.hasSuffix("/projects/p1/sessions/complete"), true)
    }

    func testAnOpenProjectIsRefusedRatherThanCompletedOneByOne() async throws {
        let recorder = Recorder()
        ProjectSessionsCompleteURLProtocol.handler = { request in
            recorder.record(request)
            return (409, Data(#"{"code":"PROJECT_STILL_OPEN"}"#.utf8))
        }
        do {
            _ = try await client().completeProjectSessions("p1")
            XCTFail("an OPEN project's sessions are not completed")
        } catch APIError.http(let status, _) {
            XCTAssertEqual(status, 409)
        }
        XCTAssertEqual(recorder.sent.count, 1, "no fallback to completing sessions one by one")
    }
}
