import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

final class SessionProjectCodableTests: XCTestCase {
    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    func testOlderServersAndExplicitNullHaveNoMembership() throws {
        XCTAssertNil(try session(#"{"id":"s1","status":"RUNNING"}"#).projectMembership)
        XCTAssertNil(try session(#"{"id":"s1","status":"RUNNING","projectMembership":null}"#).projectMembership)
    }

    func testEveryMembershipRoleDecodesWithoutChangingTheCoordinatorRelation() throws {
        let roles: [SessionProjectMembership.Role] = [.coordinator, .task, .context, .judgment, .child]
        for role in roles {
            let row = try session(#"""
            {"id":"s1","status":"RUNNING","projectId":"coordinated","projectTitle":"Coordinator title",
             "projectMembership":{"projectId":"member","projectTitle":"Member title","projectStatus":"OPEN","role":"\#(role.rawValue)"}}
            """#)
            XCTAssertEqual(row.projectMembership, SessionProjectMembership(
                projectId: "member", projectTitle: "Member title", projectStatus: .open, role: role))
            XCTAssertEqual(row.projectId, "coordinated")
            XCTAssertEqual(row.projectTitle, "Coordinator title")
            XCTAssertEqual(try JSONDecoder().decode(Session.self, from: JSONEncoder().encode(row)), row)
        }
    }

    func testTaskMembershipDoesNotMakeASessionACoordinator() throws {
        let row = try session(#"""
        {"id":"s1","status":"RUNNING","projectMembership":{
          "projectId":"p1","projectTitle":"Project","projectStatus":"DONE","role":"TASK"}}
        """#)
        XCTAssertEqual(row.projectMembership?.projectStatus, .done)
        XCTAssertNil(row.projectId)
        XCTAssertNil(row.projectTitle)
    }

    func testUnknownMembershipValuesDoNotBreakTheSessionList() throws {
        let row = try session(#"""
        {"id":"s1","status":"RUNNING","projectMembership":{
          "projectId":"p1","projectTitle":"Project","projectStatus":"FUTURE","role":"FUTURE"}}
        """#)
        XCTAssertEqual(row.projectMembership?.projectStatus, .unknown)
        XCTAssertEqual(row.projectMembership?.role, .unknown)
    }

    func testSidebarTaskCountsDecodeAndRoundTripWithTheSlimPayload() throws {
        let row = try JSONDecoder().decode(ProjectSummary.self, from: Data(#"""
        {"id":"p1","title":"Project","status":"OPEN","createdAt":"2026-10-04T00:00:00Z",
         "buckets":{"running":2},"taskCounts":{"done":3,"failed":1,"total":8},
         "attention":{"ownerItems":[],"startRequest":null}}
        """#.utf8))
        XCTAssertEqual(row.taskCounts, ProjectSidebarTaskCounts(done: 3, failed: 1, total: 8))
        XCTAssertEqual(row.buckets.running, 2)
        XCTAssertEqual(try JSONDecoder().decode(ProjectSummary.self, from: JSONEncoder().encode(row)), row)
    }

    func testOlderSidebarRowsHaveNoCountsAndEmptyProjectsKeepZeroCounts() throws {
        for extra in ["", #","taskCounts":null"#] {
            let json = #"{"id":"p1","title":"Project","status":"OPEN"\#(extra)}"#
            let row = try JSONDecoder().decode(ProjectSummary.self, from: Data(json.utf8))
            XCTAssertNil(row.taskCounts)
        }
        let empty = try JSONDecoder().decode(ProjectSummary.self, from: Data(#"""
        {"id":"p1","title":"Project","status":"OPEN","taskCounts":{"done":0,"failed":0,"total":0}}
        """#.utf8))
        XCTAssertEqual(empty.taskCounts, ProjectSidebarTaskCounts(done: 0, failed: 0, total: 0))
    }

    func testSidebarRowsSayWhetherTheProjectStartedAndOlderReadsDoNot() throws {
        func row(_ extra: String) throws -> ProjectSummary {
            try JSONDecoder().decode(ProjectSummary.self, from: Data(
                #"{"id":"p1","title":"Project","status":"OPEN"\#(extra)}"#.utf8))
        }
        XCTAssertEqual(try row(#","startedAt":"2026-10-05T16:00:00.000Z""#).started, true)
        XCTAssertEqual(try row(#","startedAt":null"#).started, false)
        XCTAssertNil(try row("").started, "a read that does not carry the field says neither")
        for extra in [#","startedAt":null"#, #","startedAt":"2026-10-05T16:00:00.000Z""#, ""] {
            let decoded = try row(extra)
            XCTAssertEqual(try JSONDecoder().decode(ProjectSummary.self, from: JSONEncoder().encode(decoded)),
                           decoded, "a null survives the round trip as a null, and an absent field as absent")
        }
    }

    func testProjectChangedIsRecognizedAsAUserScopedEvent() throws {
        let event = try JSONDecoder().decode(ControlEvent.self, from: Data(#"""
        {"type":"project.changed","sessionId":"","agentId":null,"ts":"2026-10-04T00:00:00Z","data":{"projectId":"p1"}}
        """#.utf8))
        XCTAssertEqual(event.type, .projectChanged)
        XCTAssertEqual(ControlEventType.projectChanged.rawValue, "project.changed")
        XCTAssertEqual(event.sessionId, "")
    }

    func testDeliveryReviewCoordinatorItemIsRecognized() throws {
        let row = try JSONDecoder().decode(ProjectSummary.self, from: Data(#"""
        {"id":"p1","title":"Project","status":"OPEN","attention":{"coordinatorItems":{
          "count":1,"leadKind":"DELIVERY_REVIEW","oldestWaitingSince":"2026-10-04T00:00:00Z"}}}
        """#.utf8))
        XCTAssertEqual(row.attention?.coordinatorItems?.leadKind, .deliveryReview)
    }
}

final class SessionProjectUpsertTests: XCTestCase {
    private let membership = SessionProjectMembership(
        projectId: "p1", projectTitle: "Project", projectStatus: .open, role: .task)

    private func row(membership: SessionProjectMembership? = nil) -> Session {
        Session(id: "s1", title: "Fix bug", status: .running, agentId: "w1",
                assignedRunnerId: nil, pendingApprovals: 0, branch: nil, updatedAt: nil,
                projectMembership: membership)
    }

    private func summary(_ extra: String) throws -> ControlSessionSummary {
        try JSONDecoder().decode(ControlSessionSummary.self, from: Data(#"""
        {"id":"s1","status":"RUNNING","pendingApprovals":0\#(extra)}
        """#.utf8))
    }

    func testSummaryDistinguishesAbsentNullAndMembership() throws {
        XCTAssertNil(try summary("").projectMembership)
        switch try summary(#","projectMembership":null"#).projectMembership {
        case .some(.none): break
        default: XCTFail("an explicit null must remove a loaded membership")
        }
        let supplied = try summary(#"""
        ,"projectMembership":{"projectId":"p1","projectTitle":"Project","projectStatus":"OPEN","role":"TASK"}
        """#)
        XCTAssertEqual(try XCTUnwrap(supplied.projectMembership), membership)
    }

    func testSummaryAddsChangesAndRemovesMembership() throws {
        let supplied = try summary(#"""
        ,"projectMembership":{"projectId":"p1","projectTitle":"Project","projectStatus":"OPEN","role":"TASK"}
        """#)
        XCTAssertEqual(row().applying(supplied).projectMembership, membership)
        let changed = try summary(#"""
        ,"projectMembership":{"projectId":"p2","projectTitle":"Renamed","projectStatus":"CANCELLED","role":"CHILD"}
        """#)
        let merged = row(membership: membership).applying(changed)
        XCTAssertEqual(merged.projectMembership?.projectId, "p2")
        XCTAssertEqual(merged.projectMembership?.projectTitle, "Renamed")
        XCTAssertEqual(merged.projectMembership?.projectStatus, .cancelled)
        XCTAssertEqual(merged.projectMembership?.role, .child)
        XCTAssertNil(row(membership: membership).applying(try summary(#","projectMembership":null"#)).projectMembership)
        XCTAssertEqual(row(membership: membership).applying(try summary("")).projectMembership, membership)
    }

    func testMetadataPatchUpdatesMembershipOutsideOpen() throws {
        let member = row(membership: membership)
        XCTAssertNil(member.applyingProjectRelation(try summary(#","projectMembership":null"#)).projectMembership)
        XCTAssertEqual(member.applyingProjectRelation(try summary(#","projectId":null"#)).projectMembership,
                       membership)
    }

    func testChangesWithoutMembershipKeepIt() throws {
        let member = row(membership: membership)
        XCTAssertEqual(member.settingTitle("Renamed").projectMembership, membership)
        XCTAssertEqual(member.settingPendingApprovals(2).projectMembership, membership)
        XCTAssertEqual(member.settingFolder("f1").projectMembership, membership)
        XCTAssertEqual(member.settingWorkspace(id: "w2", name: "Elsewhere", model: nil,
                                             effort: nil, folder: nil).projectMembership, membership)
    }
}

private final class SessionProjectURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let matches = request.httpMethod == "GET" && request.url?.path == "/api/projects/sidebar"
            && request.url?.query == nil
        let response = HTTPURLResponse(url: request.url!, statusCode: matches ? 200 : 404,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"""
        [{"id":"p1","title":"Project","status":"OPEN","buckets":{"running":2},
          "taskCounts":{"done":3,"failed":1,"total":8}}]
        """#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class SessionProjectAPIClientTests: XCTestCase {
    func testSidebarUsesItsDedicatedRouteAndReadsProgress() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionProjectURLProtocol.self]
        let api = APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                            session: URLSession(configuration: configuration))
        let projects = try await api.sidebarProjects()
        XCTAssertEqual(projects.map(\.id), ["p1"])
        XCTAssertEqual(projects.first?.taskCounts, ProjectSidebarTaskCounts(done: 3, failed: 1, total: 8))
    }
}

/// The app model is shared with iOS but excluded from Linux OrbitKit builds. Verify that the wire
/// event reaches the sidebar read, and member summaries schedule the same coalesced refresh.
final class SessionProjectRefreshWiringTests: XCTestCase {
    private func appSource(_ file: String) throws -> String {
        let macos = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: macos.appendingPathComponent("OrbitApp/Sources/OrbitApp/\(file)"),
                          encoding: .utf8)
    }

    func testProjectChangedRefreshesSummariesWithoutRefetchingSessions() throws {
        let app = try appSource("AppModel.swift")
        let start = try XCTUnwrap(app.range(of: "case .projectChanged:"))
        let end = try XCTUnwrap(app.range(of: "case .wikiChanged:", range: start.upperBound..<app.endIndex))
        let branch = String(app[start.upperBound..<end.lowerBound])
        XCTAssertTrue(branch.contains("projects?.nudge()"))
        XCTAssertFalse(branch.contains("scheduleControlRefresh()"))
        let model = try appSource("ProjectsModel.swift")
        XCTAssertTrue(model.contains("async let sidebarRead = api.sidebarProjects()"))
        XCTAssertTrue(model.contains("if let list = try? await sidebarRead, list != sidebarProjects { sidebarProjects = list }"))
        XCTAssertTrue(model.contains("2_000_000_000"))
    }

    func testMemberSummariesRefreshProgressAndPatchEveryLoadedRelation() throws {
        let app = try appSource("AppModel.swift")
        let start = try XCTUnwrap(app.range(of: "case .sessionCreated, .sessionUpdated:"))
        let end = try XCTUnwrap(app.range(of: "case .approvalRequested, .approvalResolved:",
                                         range: start.upperBound..<app.endIndex))
        let branch = String(app[start.upperBound..<end.lowerBound])
        XCTAssertTrue(branch.contains("summary.projectMembership.flatMap({ $0 }) != nil"))
        XCTAssertTrue(branch.contains("$0.id == summary.id && $0.projectMembership != nil"))
        XCTAssertTrue(branch.contains("projects?.nudge()"))
        XCTAssertTrue(app.contains("summary.projectTitle != nil || summary.projectMembership != nil"))
    }
}
