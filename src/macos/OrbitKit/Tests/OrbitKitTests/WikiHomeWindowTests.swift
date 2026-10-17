import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class WikiWindowURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, body: Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let result = Self.handler?(request) ?? (status: 500, body: Data())
        let response = HTTPURLResponse(url: request.url!, statusCode: result.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: result.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class WikiWindowRequests: @unchecked Sendable {
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

/// The home's principles and Activity's decisions in a space whose principles and decisions are all OLDER
/// than its 200 newest entries — the orbit space's shape, eleven thousand entries deep — read through
/// `APIClient` from a fake `/api` whose entries read answers the way `WikiService.listEntries` does: filtered
/// by `kind` and `status`, newest record first, between 1 and 200 of them (50 when no limit is asked).
///
/// Out of the 200 newest entries of every kind the home used to pick both bands, so this space drew no
/// principle and no decision. Each band now reads its own kind, exactly as `WikiModel.loadHome` (the
/// principles) and `WikiModel.loadActivity` (the decisions) ask for it — `WikiWiringTests` holds the model to
/// these two reads — and the web's `WikiHome.window.test.tsx` drives the same space through its pages.
final class WikiHomeWindowTests: XCTestCase {
    private static let spaceID = "34UAq0rbitSpaceOrbit01"

    /// `2026-MM-DDT00:MM:00.000Z`: the server writes `validFrom` and `recordedAt` together, once.
    private static func at(_ month: Int, _ day: Int, minute: Int = 0) -> String {
        String(format: "2026-%02d-%02dT%02d:%02d:00.000Z", month, day, minute / 60, minute % 60)
    }

    private static func entry(_ id: String, _ kind: WikiEntryKind, _ title: String, _ at: String,
                              status: WikiEntryStatus = .active) -> WikiEntry {
        WikiEntry(id: id, spaceId: spaceID, kind: kind, status: status, trust: kind == .principle ? .owner : .confirmed,
                  currentRevision: 1, title: title, summary: "\(title), in one line.", validFrom: at, recordedAt: at)
    }

    private static let principles = [
        entry("P1", .principle, "A clock never starts agent work", at(1, 1)),
        entry("P2", .principle, "Delete means forget", at(1, 2)),
        entry("P3", .principle, "Completion is adjudicated, not claimed", at(1, 3), status: .retired),
    ]
    /// Six decisions, oldest first: the home shows the newest four.
    private static let decisions = (1...6).map { entry("D\($0)", .decision, "Decision \($0)", at(2, $0)) }
    /// 250 entries newer than every principle and decision.
    private static let newer = (0..<250).map { n in
        entry(String(format: "N%03d", n), n.isMultiple(of: 2) ? .pitfall : .recipe, "Newer entry \(n)", at(9, 1, minute: n))
    }

    /// `WikiService.listEntries`, over the fixture.
    private static func listEntries(_ store: [WikiEntry], _ query: [URLQueryItem]) -> [WikiEntry] {
        let kind = query.first { $0.name == "kind" }?.value
        let status = query.first { $0.name == "status" }?.value
        let asked = query.first { $0.name == "limit" }?.value.flatMap(Int.init)
        let limit = min(max(asked ?? 50, 1), 200)
        return Array(store
            .filter { (kind == nil || $0.kind?.rawValue == kind) && (status == nil || $0.status?.rawValue == status) }
            .sorted { ($0.recordedAt ?? "", $0.id) > ($1.recordedAt ?? "", $1.id) }
            .prefix(limit))
    }

    override func tearDown() {
        WikiWindowURLProtocol.handler = nil
        super.tearDown()
    }

    private func client(serving store: [WikiEntry], log: WikiWindowRequests) -> APIClient {
        let entriesPath = "/api/wiki/spaces/\(Self.spaceID)/entries"
        WikiWindowURLProtocol.handler = { request in
            log.record(request)
            guard let url = request.url, url.path == entriesPath else { return (404, Data()) }
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let body = (try? JSONEncoder().encode(Self.listEntries(store, query))) ?? Data()
            return (200, body)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WikiWindowURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private func activity(window: [WikiEntry], decisions: [WikiEntry]) -> WikiHomeContent {
        WikiHomeContent(space: WikiSpace(id: Self.spaceID, slug: "orbit"), spaces: [], entries: window,
                        decisions: decisions, timeline: [])
    }

    func testTheNewest200EntriesOfThisSpaceHoldNoPrincipleAndNoDecision() async throws {
        let log = WikiWindowRequests()
        let api = client(serving: Self.principles + Self.decisions + Self.newer, log: log)
        let window = try await api.wikiEntries(spaceID: Self.spaceID)
        XCTAssertEqual(window.count, 200)
        XCTAssertTrue(window.allSatisfy { $0.kind != .principle && $0.kind != .decision })
        XCTAssertEqual(log.all, ["GET /api/wiki/spaces/\(Self.spaceID)/entries?limit=200"])
    }

    /// Every principle on the home, of any status, oldest recorded first; the four newest decisions on
    /// Activity, newest first.
    func testTheHomeStillShowsEveryPrincipleAndActivityTheNewestDecisions() async throws {
        let log = WikiWindowRequests()
        let api = client(serving: Self.principles + Self.decisions + Self.newer, log: log)
        let window = try await api.wikiEntries(spaceID: Self.spaceID)
        let principles = try await api.wikiEntries(spaceID: Self.spaceID, kind: .principle,
                                                   limit: WikiLogic.principlesRead)
        let decisions = try await api.wikiEntries(spaceID: Self.spaceID, kind: .decision,
                                                  limit: WikiHomeContent.recentDecisionCount)
        XCTAssertEqual(WikiLogic.principles(principles).map(\.title), ["A clock never starts agent work", "Delete means forget",
                                                                       "Completion is adjudicated, not claimed"])
        XCTAssertEqual(activity(window: window, decisions: decisions).recentDecisions.map(\.title),
                       ["Decision 6", "Decision 5", "Decision 4", "Decision 3"])
        XCTAssertEqual(log.all, [
            "GET /api/wiki/spaces/\(Self.spaceID)/entries?limit=200",
            "GET /api/wiki/spaces/\(Self.spaceID)/entries?kind=principle&limit=200",
            "GET /api/wiki/spaces/\(Self.spaceID)/entries?kind=decision&limit=4",
        ])
        // Picked out of the window, as the home used to, the same space had nothing to show.
        XCTAssertTrue(WikiLogic.principles(window).isEmpty)
        XCTAssertTrue(activity(window: window, decisions: window).recentDecisions.isEmpty)
    }

    /// A space with entries and decisions but no principle: the home has no principle to list, so it draws no
    /// band and says nothing of them (design §12.3.1) — while Activity still lists its decisions.
    func testASpaceWithNoPrincipleHasNoPrinciplesToList() async throws {
        let log = WikiWindowRequests()
        let api = client(serving: Self.decisions + Self.newer, log: log)
        let principles = try await api.wikiEntries(spaceID: Self.spaceID, kind: .principle,
                                                   limit: WikiLogic.principlesRead)
        let decisions = try await api.wikiEntries(spaceID: Self.spaceID, kind: .decision,
                                                  limit: WikiHomeContent.recentDecisionCount)
        XCTAssertTrue(WikiLogic.principles(principles).isEmpty)
        XCTAssertEqual(activity(window: [], decisions: decisions).recentDecisions.count, 4)
    }
}
