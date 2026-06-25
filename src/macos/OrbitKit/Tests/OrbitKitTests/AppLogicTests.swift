import XCTest
@testable import OrbitKit

final class AppLogicTests: XCTestCase {

    func testServerURLNormalization() {
        XCTAssertEqual(ServerURL.normalize("orbit.wikova.com")?.absoluteString, "https://orbit.wikova.com")
        XCTAssertEqual(ServerURL.normalize("  https://x.example.com/  ")?.absoluteString, "https://x.example.com")
        XCTAssertEqual(ServerURL.normalize("http://orbit.local:2086")?.absoluteString, "http://orbit.local:2086")
        XCTAssertEqual(ServerURL.normalize("localhost:2086")?.absoluteString, "http://localhost:2086")
        XCTAssertNil(ServerURL.normalize(""))
        XCTAssertNil(ServerURL.normalize("   "))
        XCTAssertNil(ServerURL.normalize("ftp://nope.com"))
    }

    private func session(_ id: String, _ status: RunStatus, approvals: Int = 0) -> Session {
        Session(id: id, title: id, status: status, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: approvals, branch: nil, updatedAt: nil)
    }

    func testActiveGroupingOrdersAndBuckets() {
        let sessions = [
            session("a", .running),
            session("b", .running, approvals: 2),   // needs you
            session("c", .pending),
            session("d", .awaitingInput),            // live → running bucket
            session("e", .succeeded),                // terminal → excluded
            session("f", .awaitingInput, approvals: 1), // needs you (approvals win over live)
        ]
        let g = SessionGrouping.group(sessions)
        XCTAssertEqual(g.needsYou.map(\.id), ["b", "f"])
        XCTAssertEqual(g.running.map(\.id), ["a", "d"])
        XCTAssertEqual(g.queued.map(\.id), ["c"])
        XCTAssertFalse(g.isEmpty)
    }

    func testEmptyGrouping() {
        XCTAssertTrue(SessionGrouping.group([]).isEmpty)
        XCTAssertTrue(SessionGrouping.group([session("x", .succeeded)]).isEmpty)
    }
}
