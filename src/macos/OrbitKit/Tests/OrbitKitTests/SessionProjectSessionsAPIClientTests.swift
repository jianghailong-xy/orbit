import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class ProjectSessionsURLProtocol: URLProtocol, @unchecked Sendable {
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

private final class ProjectSessionsRecorder: @unchecked Sendable {
    struct Sent: Equatable {
        let method: String?
        let path: String?
        let query: [String: String]
    }
    private let lock = NSLock()
    private var storage: [Sent] = []

    func append(_ request: URLRequest) {
        let items = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems } ?? []
        let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        lock.lock()
        storage.append(Sent(method: request.httpMethod, path: request.url?.path, query: query))
        lock.unlock()
    }

    var sent: [Sent] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

/// The project sessions request spans workspaces, and retains projectId on the lifecycle
/// compatibility request so an older server cannot silently widen the list's scope.
final class SessionProjectSessionsAPIClientTests: XCTestCase {
    override func tearDown() {
        ProjectSessionsURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProjectSessionsURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    func testProjectListIncludesMembersAcrossWorkspacesWithoutAWorkspaceFilter() async throws {
        let recorder = ProjectSessionsRecorder()
        ProjectSessionsURLProtocol.handler = { request in
            recorder.append(request)
            return (200, Data(#"[{"id":"coordinator","status":"RUNNING","agentId":"w1"},{"id":"worker","status":"RUNNING","agentId":"w2"}]"#.utf8))
        }

        let rows = try await client().listSessions(view: .open, projectId: "p1")

        XCTAssertEqual(rows.map(\.agentId), ["w1", "w2"])
        XCTAssertEqual(recorder.sent, [.init(method: "GET", path: "/api/sessions",
                                            query: ["view": "open", "projectId": "p1"])])
    }

    func testCompletedProjectListPreservesTheFilterWhenAnOldServerTreatsTheViewAsOpen() async throws {
        let recorder = ProjectSessionsRecorder()
        ProjectSessionsURLProtocol.handler = { request in
            recorder.append(request)
            if request.url?.query?.contains("view=completed") == true {
                return (200, Data(#"[{"id":"open","status":"RUNNING","filingState":"OPEN"}]"#.utf8))
            }
            return (200, Data(#"[{"id":"done","status":"SUCCEEDED","archivedAt":"2026-08-01T00:00:00Z"}]"#.utf8))
        }

        let rows = try await client().listSessions(view: .completed, projectId: "p1")

        XCTAssertEqual(rows.map(\.id), ["done"])
        XCTAssertEqual(rows.first?.effectiveLifecycleState, .completed)
        XCTAssertEqual(recorder.sent.map(\.query), [["view": "completed", "projectId": "p1"],
                                                   ["view": "archived", "projectId": "p1"]])
    }

    func testCompletedProjectListPreservesTheFilterWhenCanonicalViewIsRejected() async throws {
        let recorder = ProjectSessionsRecorder()
        ProjectSessionsURLProtocol.handler = { request in
            recorder.append(request)
            if request.url?.query?.contains("view=completed") == true { return (422, Data()) }
            return (200, Data(#"[{"id":"done","status":"SUCCEEDED","archivedAt":"2026-08-01T00:00:00Z"}]"#.utf8))
        }

        let rows = try await client().listSessions(view: .completed, runnerId: "r1", projectId: "p1")

        XCTAssertEqual(rows.map(\.id), ["done"])
        XCTAssertEqual(recorder.sent.map(\.query), [["view": "completed", "runnerId": "r1", "projectId": "p1"],
                                                   ["view": "archived", "runnerId": "r1", "projectId": "p1"]])
    }
}
