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
    private var payloads: [Data?] = []

    func append(_ request: URLRequest) {
        // On macOS URLProtocol receives the body as a stream rather than as `httpBody`; a request
        // that carried none has neither, and that absence is asserted about below.
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer[0..<count])
            }
            body = data
        }
        lock.lock()
        storage.append(request.url?.path(percentEncoded: false) ?? "")
        if let query = request.url?.query { storage[storage.count - 1] += "?\(query)" }
        verbs.append(request.httpMethod ?? "")
        payloads.append(body)
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

    var bodies: [Data?] {
        lock.lock()
        defer { lock.unlock() }
        return payloads
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

    func testQueuedTurnsUsesDurableQueueEndpointAndDecodesAttachments() async throws {
        let recorder = RequestPathRecorder()
        SessionLifecycleURLProtocol.handler = { request in
            recorder.append(request)
            return (200, Data(#"[{"turnId":"turn-1","kind":"message","content":"from web","attachments":[{"id":"att-1","mimeType":"image/png"}]}]"#.utf8))
        }

        let turns = try await client().queuedTurns(sessionID: "session-1")

        XCTAssertEqual(recorder.paths, ["/api/sessions/session-1/turns"])
        XCTAssertEqual(recorder.methods, ["GET"])
        XCTAssertEqual(turns.first?.turnId, "turn-1")
        XCTAssertEqual(turns.first?.content, "from web")
        XCTAssertEqual(turns.first?.attachments?.first?.id, "att-1")
        XCTAssertEqual(turns.first?.attachments?.first?.mimeType, "image/png")
    }

    func testRefreshDiffPostsToLiveRefreshEndpoint() async throws {
        let recorder = RequestPathRecorder()
        SessionLifecycleURLProtocol.handler = { request in
            recorder.append(request)
            return (204, Data())
        }

        try await client().refreshDiff(sessionID: "session-1")

        XCTAssertEqual(recorder.paths, ["/api/sessions/session-1/diff/refresh"])
        XCTAssertEqual(recorder.methods, ["POST"])
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

    /// The composer's Stop, on the wire: the same POST an interrupt has always been, carrying the
    /// one explicit field that also ends the session's background work. Absent, the runner reads
    /// the turn as a plain interrupt — which kills nothing, the difference from `end` — so the flag
    /// being present here is what makes Stop what it is.
    func testStopCarriesTheBackgroundWorkFlagOnItsInterrupt() async throws {
        let recorder = RequestPathRecorder()
        SessionLifecycleURLProtocol.handler = { request in
            recorder.append(request)
            return (200, Data(#"{"ok":true}"#.utf8))
        }

        try await client().interrupt(sessionID: "session-1", stopBackgroundWork: true)

        XCTAssertEqual(recorder.paths, ["/api/sessions/session-1/interrupt"])
        XCTAssertEqual(recorder.methods, ["POST"])
        let body = try XCTUnwrap(recorder.bodies.first ?? nil)
        XCTAssertEqual(
            String(decoding: body, as: UTF8.self),
            #"{"stopBackgroundWork":true}"#,
            "the body is the flag and nothing else — a follow-up would be its own field, and there is none")
    }

    /// And every caller that did not ask for it gets the bodyless interrupt, byte for byte: the
    /// engine's own `session_interrupt`, the MCP tool, the CLI and the browser's plain stop all
    /// still mean "stop the turn, kill nothing".
    func testAPlainInterruptStaysBodyless() async throws {
        let recorder = RequestPathRecorder()
        SessionLifecycleURLProtocol.handler = { request in
            recorder.append(request)
            return (200, Data(#"{"ok":true}"#.utf8))
        }

        try await client().interrupt(sessionID: "session-1")

        XCTAssertEqual(recorder.paths, ["/api/sessions/session-1/interrupt"])
        XCTAssertEqual(recorder.methods, ["POST"])
        XCTAssertNil(recorder.bodies.first ?? nil, "a plain interrupt must not carry a body at all")
    }
}
