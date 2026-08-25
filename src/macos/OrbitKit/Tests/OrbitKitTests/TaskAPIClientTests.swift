import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class TaskCancellationRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var didStart = false
    private var didStop = false

    func markStarted() {
        lock.lock()
        didStart = true
        lock.unlock()
    }
    func markStopped() {
        lock.lock()
        didStop = true
        lock.unlock()
    }
    var started: Bool {
        lock.lock()
        defer { lock.unlock() }
        return didStart
    }
    var stopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return didStop
    }
}

private final class TaskAPIURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) throws -> (status: Int, data: Data))?
    static var hangingRecorder: TaskCancellationRecorder?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let recorder = Self.hangingRecorder {
            recorder.markStarted()
            return
        }
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

    override func stopLoading() { Self.hangingRecorder?.markStopped() }
}

private final class TaskRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [URL] = []

    func append(_ request: URLRequest) {
        guard let url = request.url else { return }
        lock.lock()
        storage.append(url)
        lock.unlock()
    }

    var urls: [URL] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

final class TaskAPIClientTests: XCTestCase {
    override func tearDown() {
        TaskAPIURLProtocol.handler = nil
        TaskAPIURLProtocol.hangingRecorder = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TaskAPIURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    func testTaskRowUsesTheLightweightIncrementalEndpoint() async throws {
        let recorder = TaskRequestRecorder()
        TaskAPIURLProtocol.handler = { request in
            recorder.append(request)
            return (200, Data(#"{"id":"t1","title":"Changed","status":"OPEN"}"#.utf8))
        }

        let row = try await client().taskRow("t1")

        XCTAssertEqual(row.id, "t1")
        XCTAssertEqual(recorder.urls.map(\.path), ["/api/tasks/t1/row"])
    }

    func testTaskListHeaderExplicitlyOmitsEmbeddedTasks() async throws {
        let recorder = TaskRequestRecorder()
        TaskAPIURLProtocol.handler = { request in
            recorder.append(request)
            return (200, Data(#"{"id":"l1","title":"Release"}"#.utf8))
        }

        let header = try await client().taskListHeader("l1")

        XCTAssertEqual(header.id, "l1")
        XCTAssertNil(header.counts)
        let url = try XCTUnwrap(recorder.urls.first)
        XCTAssertEqual(url.path, "/api/task-lists/l1")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
                       [URLQueryItem(name: "tasks", value: "none")])
    }

    func testTaskPageSendsReducedCountsModeAndDecodesRowsOnlyResponse() async throws {
        let recorder = TaskRequestRecorder()
        TaskAPIURLProtocol.handler = { request in
            recorder.append(request)
            return (200, Data(#"{"items":[],"nextCursor":null}"#.utf8))
        }

        let page = try await client().taskPage(limit: 7, status: "RUNNING",
                                               counts: TaskPageCountsMode.none)

        XCTAssertNil(page.total)
        XCTAssertNil(page.counts)
        let url = try XCTUnwrap(recorder.urls.first)
        XCTAssertEqual(url.path, "/api/tasks/page")
        XCTAssertEqual(
            Dictionary(uniqueKeysWithValues:
                (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [])
                    .map { ($0.name, $0.value) }),
            ["limit": "7", "status": "RUNNING", "counts": "none"])
    }

    func testTaskPageSendsFilteredTotalModeWithoutScopeCounts() async throws {
        let recorder = TaskRequestRecorder()
        TaskAPIURLProtocol.handler = { request in
            recorder.append(request)
            return (200, Data(#"{"items":[],"nextCursor":null,"total":0}"#.utf8))
        }

        let page = try await client().taskPage(limit: 200, query: "needle", counts: .total)

        XCTAssertEqual(page.total, 0)
        XCTAssertNil(page.counts)
        let url = try XCTUnwrap(recorder.urls.first)
        XCTAssertEqual(
            Dictionary(uniqueKeysWithValues:
                (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [])
                    .map { ($0.name, $0.value) }),
            ["limit": "200", "q": "needle", "counts": "total"])
    }

    func testTaskCountsUsesTheScopeOnlyEndpoint() async throws {
        let recorder = TaskRequestRecorder()
        TaskAPIURLProtocol.handler = { request in
            recorder.append(request)
            return (200, Data(#"{"total":0,"open":0,"inProgress":0,"done":0,"failed":0,"cancelled":0,"running":0,"queued":0,"runnable":0}"#.utf8))
        }

        let counts = try await client().taskCounts(listId: "none")

        XCTAssertEqual(counts.total, 0)
        let url = try XCTUnwrap(recorder.urls.first)
        XCTAssertEqual(url.path, "/api/tasks/counts")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
                       [URLQueryItem(name: "listId", value: "none")])
    }

    func testTaskPageLegacyCallStillOmitsCountsQuery() async throws {
        let recorder = TaskRequestRecorder()
        TaskAPIURLProtocol.handler = { request in
            recorder.append(request)
            return (200, Data(#"{"items":[],"nextCursor":null,"total":0,"counts":{"total":0,"open":0,"inProgress":0,"done":0,"failed":0,"cancelled":0,"running":0,"queued":0,"runnable":0}}"#.utf8))
        }

        let page = try await client().taskPage(limit: 1, listId: "none")

        XCTAssertEqual(page.total, 0)
        XCTAssertEqual(page.counts?.total, 0)
        let url = try XCTUnwrap(recorder.urls.first)
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertFalse(query.contains { $0.name == "counts" })
    }

    func testCancellingCallerCancelsObsoleteHTTPTask() async throws {
        let recorder = TaskCancellationRecorder()
        TaskAPIURLProtocol.hangingRecorder = recorder
        let request = Task { try await client().taskPage(query: "obsolete") }

        for _ in 0..<100 where !recorder.started {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(recorder.started)
        request.cancel()
        do {
            _ = try await request.value
            XCTFail("a cancelled query must not produce a page")
        } catch {
            let nsError = error as NSError
            XCTAssertTrue(error is CancellationError
                          || (nsError.domain == NSURLErrorDomain
                              && nsError.code == NSURLErrorCancelled))
        }
        for _ in 0..<100 where !recorder.stopped {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(recorder.stopped, "URLSession must stop the underlying stale request")
    }
}
