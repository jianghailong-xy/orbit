import Foundation
import XCTest
@testable import OrbitKit

/// `GET /projects` decodes the way the server serves it (`ProjectsService.loadList`), and a row an
/// older or newer server shapes differently still decodes rather than failing the whole list.
final class ProjectsCodableTests: XCTestCase {

    private func decode(_ json: String) throws -> [ProjectSummary] {
        try JSONDecoder().decode([ProjectSummary].self, from: Data(json.utf8))
    }

    func testDecodesAListRowAsTheServerServesIt() throws {
        let rows = try decode("""
        [{
          "id": "349JYGz6JEe6uAs7SW24g",
          "title": "Orbit iOS Project 支持",
          "status": "OPEN",
          "goal": "让 Orbit iOS 客户端完整支持 Project",
          "createdAt": "2026-08-18T13:47:40.662Z",
          "updatedAt": "2026-08-19T15:15:03.687Z",
          "coordinatorAgentId": "3CuIHiSJZBQ7nLVUwc7ekz",
          "coordinatorGeneration": "2",
          "_count": { "tasks": 34 },
          "buckets": { "running": 4, "ready": 1, "blocked": 2, "awaitingVerification": 0,
                       "done": 27, "failed": 0, "cancelled": 0 },
          "lastActivityAt": "2026-09-24T12:00:50.720Z",
          "attention": {
            "userBlockers": 0, "coordinatorBlockers": 0, "systemBlockers": 0,
            "maxSeverity": null, "attentionSinceAt": null, "nextCheckAt": null,
            "ownerItems": [
              { "kind": "PROMOTION_APPROVAL", "count": 1, "oldestWaitingSince": "2026-09-24T10:00:00.000Z" }
            ],
            "coordinatorItems": { "count": 2, "leadKind": "INTEGRATION_CONFLICT",
                                  "oldestWaitingSince": "2026-09-24T11:45:17.284Z",
                                  "nextEscalationAt": "2026-09-24T13:45:17.284Z" }
          },
          "integration": { "line": "PROJECT_BRANCH", "ref": "project/bg-jobs" }
        }]
        """)
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row.id, "349JYGz6JEe6uAs7SW24g")
        XCTAssertEqual(row.status, .open)
        XCTAssertEqual(row.taskCount, 34)
        XCTAssertEqual(row.buckets, ProjectBuckets(running: 4, ready: 1, blocked: 2, done: 27,
                                                   failed: 0, cancelled: 0))
        XCTAssertEqual(row.lastActivityAt, "2026-09-24T12:00:50.720Z")
        XCTAssertEqual(row.attention?.ownerItems.first?.kind, .promotionApproval)
        XCTAssertEqual(row.attention?.coordinatorItems?.leadKind, .integrationConflict)
        XCTAssertEqual(row.attention?.coordinatorItems?.count, 2)
        XCTAssertEqual(row.integration, ProjectListIntegration(line: .projectBranch, ref: "project/bg-jobs"))
    }

    func testAnOlderServersRowStillDecodes() throws {
        // No failed lane, no attention, no integration, no activity: the shape before those reads.
        let row = try XCTUnwrap(try decode("""
        [{ "id": "p1", "title": "Old", "status": "OPEN", "goal": null,
           "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-02T00:00:00.000Z",
           "_count": { "tasks": 3 }, "buckets": { "running": 1, "ready": 1, "blocked": 0,
                                                  "done": 0, "cancelled": 0 } }]
        """).first)
        XCTAssertNil(row.buckets.failed)
        XCTAssertEqual(ProjectAttention.failedTaskCount(row), 1)
        XCTAssertNil(row.attention)
        XCTAssertNil(row.integration)
        XCTAssertNil(row.lastActivityAt)
        XCTAssertNil(row.goal)
    }

    func testValuesThisBuildDoesNotKnowDecodeToTheirFloor() throws {
        let row = try XCTUnwrap(try decode("""
        [{ "id": "p2", "title": "New", "status": "ARCHIVED", "createdAt": "2026-01-01T00:00:00.000Z",
           "attention": { "userBlockers": 1, "maxSeverity": "SEVERE",
                          "ownerItems": [ { "kind": "SOMETHING_NEW", "count": 1,
                                            "oldestWaitingSince": "2026-01-01T00:00:00.000Z" } ],
                          "coordinatorItems": { "count": 1, "leadKind": "NEW_KIND",
                                                "oldestWaitingSince": "2026-01-01T00:00:00.000Z" } },
           "integration": { "line": "ELSEWHERE", "ref": "x" } }]
        """).first)
        XCTAssertEqual(row.status, .unknown)
        XCTAssertEqual(row.attention?.maxSeverity, .unknown)
        XCTAssertEqual(row.attention?.ownerItems.first?.kind, .unknown)
        XCTAssertEqual(row.attention?.coordinatorItems?.leadKind, .unknown)
        XCTAssertEqual(row.integration?.line, .unknown)
        XCTAssertEqual(row.taskCount, 0)
        XCTAssertEqual(row.buckets, ProjectBuckets())
    }

    func testRoundTripsThroughItsOwnEncoding() throws {
        let row = ProjectSummary(id: "p3", title: "T", status: .done, goal: "G",
                                 createdAt: "2026-01-01T00:00:00.000Z", taskCount: 2,
                                 buckets: ProjectBuckets(done: 2), lastActivityAt: nil,
                                 attention: ProjectListAttention(userBlockers: 1),
                                 integration: ProjectListIntegration(line: .main, ref: "main"))
        let data = try JSONEncoder().encode([row])
        XCTAssertEqual(try JSONDecoder().decode([ProjectSummary].self, from: data), [row])
    }
}
