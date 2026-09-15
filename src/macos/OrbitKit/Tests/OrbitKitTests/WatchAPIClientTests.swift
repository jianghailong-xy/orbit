import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class WatchAPIURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, body: String))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let result = Self.handler?(request) ?? (status: 500, body: "")
        let response = HTTPURLResponse(url: request.url!, statusCode: result.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(result.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class WatchRequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []

    func record(_ request: URLRequest) {
        guard let url = request.url else { return }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.query.map { "?\($0)" } ?? ""
        lock.lock()
        lines.append("\(request.httpMethod ?? "?") \(url.path)\(query)")
        lock.unlock()
    }

    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }
}

/// Each control hits the route `watches.controller.ts` serves for it, and every one answers with the watch.
final class WatchAPIClientTests: XCTestCase {
    override func tearDown() {
        WatchAPIURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WatchAPIURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private static let watchJSON = """
    {"id":"W1","observerType":"USER","observerSessionId":null,"predicateVersion":1,
     "predicate":{"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_DONE"},"mode":"ONE_SHOT",
     "action":"NOTIFY_USER","state":"PAUSED","generation":0,"expiresAt":"2026-09-15T00:00:00.000Z",
     "nextEvaluateAt":null,"lastEvaluatedAt":null,"idempotencyKey":null,
     "createdAt":"2026-09-14T00:00:00.000Z","updatedAt":"2026-09-14T00:00:00.000Z",
     "targets":[],"matches":[],"expiryDeliveries":[]}
    """

    func testEveryControlHitsItsRoute() async throws {
        let log = WatchRequestLog()
        let body = Self.watchJSON
        WatchAPIURLProtocol.handler = { request in
            log.record(request)
            return (status: 200, body: request.url?.path == "/api/watches" ? "[\(body)]" : body)
        }
        let api = client()
        let listed = try await api.watches()
        _ = try await api.watches(state: .active)
        _ = try await api.watch("W1")
        let paused = try await api.pauseWatch("W1")
        _ = try await api.resumeWatch("W1")
        _ = try await api.cancelWatch("W1")
        _ = try await api.updateWatch("W1", UpdateWatchRequest(ttlSeconds: 3_600))

        XCTAssertEqual(listed.map(\.id), ["W1"])
        XCTAssertEqual(paused.state, .paused)
        XCTAssertEqual(log.all, [
            "GET /api/watches",
            "GET /api/watches?state=ACTIVE",
            "GET /api/watches/W1",
            "POST /api/watches/W1/pause",
            "POST /api/watches/W1/resume",
            "POST /api/watches/W1/cancel",
            "PATCH /api/watches/W1",
        ])
    }

    /// A watch as `GET /watches` sends it: ended, with the one delivery its Match caused when `deadLetter` says so.
    private static func row(_ id: String, state: String, createdAt: String, deadLetter: String? = nil) -> String {
        let deliveries = deadLetter.map {
            """
            [{"id":"\(id)-d","action":"RESUME_SESSION","state":"DEAD_LETTER","attempts":1,"nextAttemptAt":null,
              "lastError":"\($0)","deliveredAt":null,"deadLetteredAt":"\(createdAt)","createdAt":"\(createdAt)",
              "updatedAt":"\(createdAt)"}]
            """
        } ?? "[]"
        let matches = state == "MATCHED"
            ? """
              [{"id":"\(id)-m","generation":1,"matchedAt":"\(createdAt)","reason":"ALL TASK_TERMINAL 1/1",
                "predicateVersion":1,"perTargetSnapshot":{"evaluatedAt":"\(createdAt)","targets":[]},
                "deliveries":\(deliveries)}]
              """
            : "[]"
        return """
        {"id":"\(id)","observerType":"USER","observerSessionId":null,"predicateVersion":1,
         "predicate":{"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_TERMINAL"},"mode":"ONE_SHOT",
         "action":"NOTIFY_USER","state":"\(state)","generation":\(state == "MATCHED" ? 1 : 0),
         "expiresAt":"2026-09-16T00:00:00.000Z","nextEvaluateAt":null,"lastEvaluatedAt":null,
         "idempotencyKey":null,"createdAt":"\(createdAt)","updatedAt":"\(createdAt)","targets":[],
         "matches":\(matches),"expiryDeliveries":[]}
        """
    }

    /// What the app's list is built from. A hundred watches ended after the two that need attention, so the newest
    /// list holds neither of them: only the read of its own keeps them on Needs attention, and what it does not
    /// answer with — a wake withdrawn before it ran — stays in history where the newest list found it.
    func testTheFollowedListReadsTheLiveStatesTheNewestAndWhatNeedsAttention() async throws {
        let log = WatchRequestLog()
        let newest = (0..<99).map { Self.row("E\($0)", state: "MATCHED", createdAt: "2026-09-14T09:00:00.000Z") }
            + [Self.row("WITHDRAWN", state: "MATCHED", createdAt: "2026-09-14T09:00:00.000Z",
                        deadLetter: "WAKE_WITHDRAWN: the wake was withdrawn before a runner took it")]
        let needing = [
            Self.row("R_OLD", state: "REVOKED", createdAt: "2026-09-12T09:00:00.000Z"),
            Self.row("D_OLD", state: "MATCHED", createdAt: "2026-09-12T08:00:00.000Z",
                     deadLetter: "PERMISSION_REVOKED: the observer session no longer belongs to the watch's owner"),
        ]
        WatchAPIURLProtocol.handler = { request in
            log.record(request)
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.query
            switch query {
            case "state=ACTIVE", "state=PAUSED": return (status: 200, body: "[]")
            case "needsAttention=true": return (status: 200, body: "[\(needing.joined(separator: ","))]")
            default: return (status: 200, body: "[\(newest.joined(separator: ","))]")
            }
        }
        let watches = try await client().followedWatches()

        XCTAssertEqual(log.all, [
            "GET /api/watches?state=ACTIVE",
            "GET /api/watches?state=PAUSED",
            "GET /api/watches",
            "GET /api/watches?needsAttention=true",
        ])
        let sections = WatchProjection.sections(watches)
        XCTAssertEqual(sections.first { $0.group == .needsAttention }?.watches.map(\.id), ["R_OLD", "D_OLD"])
        XCTAssertEqual(sections.first { $0.group == .history }?.watches.count, 100)
        XCTAssertNil(sections.first { $0.group == .active })
    }

    func testARefusalSurfacesTheServersSentence() async {
        WatchAPIURLProtocol.handler = { _ in
            (status: 400, body: #"{"code":"TTL_OUT_OF_RANGE","kind":"REFUSAL","message":"ttlSeconds is between 60 and 2592000"}"#)
        }
        do {
            _ = try await client().updateWatch("W1", UpdateWatchRequest(ttlSeconds: 1))
            XCTFail("a refused edit has to throw")
        } catch {
            XCTAssertEqual(WatchProjection.failureMessage(error, verb: "save"),
                           "Couldn't save the watch — ttlSeconds is between 60 and 2592000.")
        }
    }
}
