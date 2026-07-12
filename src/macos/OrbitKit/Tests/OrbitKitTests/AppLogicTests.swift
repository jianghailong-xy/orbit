import XCTest
@testable import OrbitKit

final class AppLogicTests: XCTestCase {

    func testServerURLNormalization() {
        XCTAssertEqual(ServerURL.normalize("orbitd.io")?.absoluteString, "https://orbitd.io")
        XCTAssertEqual(ServerURL.normalize("  https://x.example.com/  ")?.absoluteString, "https://x.example.com")
        XCTAssertEqual(ServerURL.normalize("http://orbit.local:2086")?.absoluteString, "http://orbit.local:2086")
        XCTAssertEqual(ServerURL.normalize("localhost:2086")?.absoluteString, "http://localhost:2086")
        XCTAssertNil(ServerURL.normalize(""))
        XCTAssertNil(ServerURL.normalize("   "))
        XCTAssertNil(ServerURL.normalize("ftp://nope.com"))
    }

    private func session(_ id: String, _ status: RunStatus, approvals: Int = 0,
                         source: String? = nil) -> Session {
        Session(id: id, title: id, status: status, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: approvals, branch: nil, updatedAt: nil, source: source, agent: nil)
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

    /// System (auto-created) sessions ride the `view=active` payload but must not show in the Active
    /// list — they have their own System tab (web parity). Excluded from every bucket.
    func testActiveGroupingExcludesSystemSessions() {
        let sessions = [
            session("live", .running),
            session("sysRun", .running, source: "system"),               // live but system → dropped
            session("sysNeeds", .running, approvals: 3, source: "system"), // even with approvals
            session("queued", .pending),
            session("sysQueued", .pending, source: "system"),            // queued but system → dropped
        ]
        let g = SessionGrouping.group(sessions)
        XCTAssertEqual(g.needsYou.map(\.id), [])
        XCTAssertEqual(g.running.map(\.id), ["live"])
        XCTAssertEqual(g.queued.map(\.id), ["queued"])
    }

    func testEmptyGrouping() {
        XCTAssertTrue(SessionGrouping.group([]).isEmpty)
        XCTAssertTrue(SessionGrouping.group([session("x", .succeeded)]).isEmpty)
    }
}
