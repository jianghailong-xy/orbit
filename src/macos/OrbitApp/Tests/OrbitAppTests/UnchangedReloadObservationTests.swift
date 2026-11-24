import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Observation
import XCTest
import OrbitKit
@testable import OrbitApp

/// One stub transport for every store: each path answers with what it answered the first time.
private final class UnchangedReloadURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var routes: [String: String] = [:]

    static func answer(_ routes: [String: String]) {
        lock.lock()
        defer { lock.unlock() }
        self.routes = routes
    }

    private static func body(for path: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return routes[path]
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let body = Self.body(for: url.path)
        let response = HTTPURLResponse(url: url, statusCode: body == nil ? 404 : 200,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((body ?? "").utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// `onChange` can arrive from whichever thread performed the write, so the count is lock-guarded.
private final class ChangeCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func bump() {
        lock.lock()
        defer { lock.unlock() }
        value += 1
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

/// The four stores behind the Mac sidebar and the Lists, reloaded against a server that answers
/// exactly what it answered the first time. `@Observable` announces every assignment — equal value or
/// not — so a reload that changed nothing must fire no `onChange` at all. Each test reads only its
/// own store's values inside `withObservationTracking`, so a write elsewhere in the app cannot make
/// one pass or fail by accident.
@MainActor
final class UnchangedReloadObservationTests: XCTestCase {
    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UnchangedReloadURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    func testAnUnchangedAgentsReloadWritesNothing() async {
        UnchangedReloadURLProtocol.answer([
            "/api/agents": #"[{"id":"A1","name":"work","runnerId":"R1"}]"#,
            "/api/runners": #"[{"id":"R1","name":"mac","online":true}]"#,
            "/api/providers": #"[{"slug":"anthropic","label":"Anthropic","models":[]}]"#,
            "/api/providers/pools": "[]",
            "/api/providers/shared-pools": "[]",
        ])
        let model = AgentsModel(api: client())
        await model.load()
        XCTAssertEqual(model.items.map(\.id), ["A1"])
        XCTAssertEqual(model.runnerNames["R1"], "mac")

        let changes = ChangeCounter()
        withObservationTracking {
            _ = model.items
            _ = model.runnerOrder
            _ = model.runnerNames
            _ = model.runnerOnline
            _ = model.runnerModelCatalog
            _ = model.runnerRuntimeDefaultModels
            _ = model.runnerRows
            _ = model.machinesToSetUp
            _ = model.firstOnlineMachine
            _ = model.configuredProviders
            _ = model.configuredProvidersLoaded
            _ = model.providerPools
            _ = model.poolsState
            _ = model.loadState
        } onChange: {
            changes.bump()
        }

        await model.load()

        XCTAssertEqual(changes.count, 0, "an unchanged AgentsModel reload wrote observable state")
    }

    func testAnUnchangedProjectsReloadWritesNothing() async {
        let list = #"[{"id":"P1","title":"List safety","status":"OPEN"}]"#
        UnchangedReloadURLProtocol.answer([
            "/api/projects": list,
            "/api/projects/sidebar": list,
        ])
        let model = ProjectsModel(api: client())
        await model.load()
        XCTAssertEqual(model.projects.map(\.id), ["P1"])
        XCTAssertEqual(model.sidebarProjects.map(\.id), ["P1"])

        let changes = ChangeCounter()
        withObservationTracking {
            _ = model.projects
            _ = model.sidebarProjects
            _ = model.loadState
        } onChange: {
            changes.bump()
        }

        await model.load()

        XCTAssertEqual(changes.count, 0, "an unchanged ProjectsModel reload wrote observable state")
    }

    func testAnUnchangedWikiSpacesReloadWritesNothing() async {
        UnchangedReloadURLProtocol.answer([
            "/api/wiki/spaces": #"[{"id":"S1","slug":"orbit","title":"Orbit"}]"#,
            "/api/wiki/trash": #"{"spaces":[]}"#,
        ])
        let model = WikiModel(api: client())
        await model.loadSpaces()
        XCTAssertEqual(model.spaces.map(\.slug), ["orbit"])

        let changes = ChangeCounter()
        withObservationTracking {
            _ = model.spaces
            _ = model.spacesState
            _ = model.disabled
            _ = model.trash
        } onChange: {
            changes.bump()
        }

        await model.loadSpaces()

        XCTAssertEqual(changes.count, 0, "an unchanged WikiModel.loadSpaces wrote observable state")
    }

    func testAnUnchangedOwnerRequestsReloadWritesNothing() async {
        let request = #"{"id":"Q1","kind":"DECISION","state":"PENDING","title":"Pick one","#
            + #""why":"It blocks the work","blocksTaskIds":[],"askedBySessionId":"S1","#
            + #""createdAt":"2026-01-01T00:00:00Z"}"#
        UnchangedReloadURLProtocol.answer([
            "/api/owner-requests": #"{"requests":["# + request + "]}",
            "/api/projects": "[]",
            "/api/terminals/requests": #"{"requests":[]}"#,
        ])
        let suite = "orbit.observation.tests"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let model = OwnerRequestsModel(api: client(),
                                       store: OwnerRequestSnoozes(defaults: defaults))
        await model.load()
        XCTAssertEqual(model.open.map(\.id), ["Q1"])

        let changes = ChangeCounter()
        withObservationTracking {
            _ = model.open
            _ = model.all
            _ = model.terminalRequests
            _ = model.snoozes
            _ = model.taskTitles
            _ = model.savedSecrets
        } onChange: {
            changes.bump()
        }

        await model.load()

        XCTAssertEqual(changes.count, 0, "an unchanged OwnerRequestsModel reload wrote observable state")
    }
}
