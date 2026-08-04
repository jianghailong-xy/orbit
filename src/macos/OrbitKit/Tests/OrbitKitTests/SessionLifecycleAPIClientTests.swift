import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class SessionLifecycleURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) throws -> (status: Int, data: Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw APIError.invalidResponse }
            let result = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: result.status,
                                           httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: result.data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private final class RequestPathRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []
    private var verbs: [String] = []

    func append(_ request: URLRequest) {
        lock.lock()
        storage.append(request.url?.path(percentEncoded: false) ?? "")
        if let query = request.url?.query { storage[storage.count - 1] += "?\(query)" }
        verbs.append(request.httpMethod ?? "")
        lock.unlock()
    }

    var paths: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    var methods: [String] {
        lock.lock()
        defer { lock.unlock() }
        return verbs
    }
}

final class SessionLifecycleAPIClientTests: XCTestCase {
    override func tearDown() {
        SessionLifecycleURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionLifecycleURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    func testCompleteSessionUsesCanonicalEndpoint() async throws {
        let recorder = RequestPathRecorder()
        SessionLifecycleURLProtocol.handler = { request in
            recorder.append(request)
            return (204, Data())
        }

        try await client().completeSession("session-1")

        XCTAssertEqual(recorder.paths, ["/api/sessions/session-1/complete"])
    }

    func testCompleteSessionFallsBackToLegacyEndpointOnOldServer() async throws {
        let recorder = RequestPathRecorder()
        SessionLifecycleURLProtocol.handler = { request in
            recorder.append(request)
            let isCanonical = request.url?.path.hasSuffix("/complete") == true
            return (isCanonical ? 404 : 204, Data())
        }

        try await client().completeSession("session-1")

        XCTAssertEqual(recorder.paths, [
            "/api/sessions/session-1/complete",
            "/api/sessions/session-1/archive",
        ])
    }

    /// Rename is a PATCH on the session itself — not on `:id/config`, which is a different endpoint
    /// with a terminal-state guard and a runner reload behind it.
    func testRenameSessionPatchesTheSessionResource() async throws {
        let recorder = RequestPathRecorder()
        SessionLifecycleURLProtocol.handler = { request in
            recorder.append(request)
            return (200, Data(#"{"ok":true,"title":"New name"}"#.utf8))
        }

        try await client().renameSession("session-1", title: "New name")

        XCTAssertEqual(recorder.paths, ["/api/sessions/session-1"])
        XCTAssertEqual(recorder.methods, ["PATCH"])
    }

    func testCompletedListFallsBackWhenOldServerTreatsUnknownViewAsOpen() async throws {
        let recorder = RequestPathRecorder()
        SessionLifecycleURLProtocol.handler = { request in
            recorder.append(request)
            if request.url?.query == "view=completed" {
                return (200, Data(#"[{"id":"open","status":"RUNNING","filingState":"OPEN"}]"#.utf8))
            }
            return (200, Data(#"[{"id":"done","status":"SUCCEEDED","archivedAt":"2026-08-01T00:00:00Z"}]"#.utf8))
        }

        let sessions = try await client().listSessions(view: .completed)

        XCTAssertEqual(sessions.map(\.id), ["done"])
        XCTAssertEqual(sessions.first?.effectiveLifecycleState, .completed)
        XCTAssertEqual(recorder.paths, [
            "/api/sessions?view=completed",
            "/api/sessions?view=archived",
        ])
    }
}
