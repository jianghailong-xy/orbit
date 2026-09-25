import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class WikiAPIURLProtocol: URLProtocol, @unchecked Sendable {
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

private final class WikiRequestLog: @unchecked Sendable {
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

/// Each read and write hits the route `wiki.controller.ts` serves for it — the user door, which is
/// the only one that decides.
final class WikiAPIClientTests: XCTestCase {
    override func tearDown() {
        WikiAPIURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WikiAPIURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    func testEveryCallHitsItsRoute() async throws {
        let log = WikiRequestLog()
        WikiAPIURLProtocol.handler = { request in
            log.record(request)
            switch request.url?.path ?? "" {
            case "/api/wiki/spaces": return (200, WikiFixtures.spaces)
            case "/api/wiki/spaces/S1": return (200, WikiFixtures.space)
            case "/api/wiki/spaces/S1/entries": return (200, WikiFixtures.entries)
            case "/api/wiki/spaces/S1/timeline": return (200, WikiFixtures.timeline)
            case "/api/wiki/review": return (200, WikiFixtures.review)
            case "/api/wiki/entries/E1": return (200, WikiFixtures.entryDetail)
            case "/api/wiki/search": return (200, #"{"q":"redaction","semantic":false,"hits":[]}"#)
            case "/api/wiki/changesets/C1/decide": return (200, #"{"id":"C1","status":"settled","ops":[]}"#)
            case "/api/wiki/spaces/S1/changesets": return (200, #"{"changesetId":"C2","replayed":false,"ops":[]}"#)
            default: return (404, "")
            }
        }
        let api = client()
        let spaces = try await api.wikiSpaces()
        _ = try await api.wikiSpace("S1")
        _ = try await api.wikiEntries(spaceID: "S1")
        _ = try await api.wikiTimeline(spaceID: "S1")
        _ = try await api.wikiReview()
        _ = try await api.wikiReview(spaceID: "S1")
        let detail = try await api.wikiEntry("E1")
        _ = try await api.wikiSearch("redaction", spaceID: "S1")
        let decided = try await api.decideWikiChangeset(
            "C1", WikiDecideRequest(decisions: [WikiDecision(opId: "O1", action: .accept)]))
        _ = try await api.submitWikiChangeset(
            spaceID: "S1", WikiChangesetRequest(ops: [.retire(entryId: "E1", baseRevision: 2, reason: "r")],
                                                rationale: "Retired from the iOS app"))

        XCTAssertEqual(spaces.count, 2)
        XCTAssertEqual(detail.entry.id, WikiFixtures.pitfallID)
        XCTAssertEqual(decided.status, .settled)
        XCTAssertEqual(log.all, [
            "GET /api/wiki/spaces",
            "GET /api/wiki/spaces/S1?include=usage",
            "GET /api/wiki/spaces/S1/entries?limit=200",
            "GET /api/wiki/spaces/S1/timeline",
            "GET /api/wiki/review",
            "GET /api/wiki/review?space=S1",
            "GET /api/wiki/entries/E1?include=sources,history,exposure",
            "GET /api/wiki/search?q=redaction&include=topics&space=S1",
            "POST /api/wiki/changesets/C1/decide",
            "POST /api/wiki/spaces/S1/changesets",
        ])
    }
}
