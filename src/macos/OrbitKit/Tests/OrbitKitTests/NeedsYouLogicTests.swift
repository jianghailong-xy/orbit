import XCTest
@testable import OrbitKit

final class NeedsYouLogicTests: XCTestCase {

    private func session(_ id: String, approvals: Int = 0, agentID: String? = nil,
                         agentName: String? = nil, title: String? = nil,
                         lastTurnAt: String? = nil, waitingSince: String? = nil) -> Session {
        Session(id: id, title: title, status: .running, agentId: agentID, assignedRunnerId: nil,
                pendingApprovals: approvals, branch: nil, updatedAt: nil,
                oldestPendingApprovalAt: waitingSince,
                agent: agentName.map { SessionAgentRef(id: agentID ?? "a", name: $0, provider: nil,
                                                       model: nil, effort: nil) },
                lastTurnAt: lastTurnAt)
    }

    // MARK: byAgent

    func testByAgentCountsOnlyBlockedSessionsAndOmitsZeros() {
        let counts = NeedsYouLogic.byAgent([
            session("a", approvals: 1, agentID: "dev"),
            session("b", approvals: 2, agentID: "dev"),     // two blocked SESSIONS, not three approvals
            session("c", approvals: 0, agentID: "dev"),
            session("d", approvals: 1, agentID: "prod"),
            session("e", approvals: 0, agentID: "idle"),
        ])
        XCTAssertEqual(counts, ["dev": 2, "prod": 1])
        XCTAssertNil(counts["idle"])
    }

    /// The list payload nests the agent; `POST /sessions` answers with a flat `agentId` instead.
    /// Both shapes must land on the same agent (see `SessionFilter.forAgent`).
    func testByAgentPrefersNestedAgentAndFallsBackToFlatID() {
        let nested = session("a", approvals: 1, agentID: "flat", agentName: "Dev")
        let flatOnly = session("b", approvals: 1, agentID: "flat")
        XCTAssertEqual(NeedsYouLogic.byAgent([nested, flatOnly]), ["flat": 2])
    }

    func testByAgentSkipsSessionsWithNoAgent() {
        XCTAssertEqual(NeedsYouLogic.byAgent([session("a", approvals: 1)]), [:])
    }

    // MARK: banner

    func testBannerIsNilWhenNothingIsWaiting() {
        XCTAssertNil(NeedsYouLogic.banner(waiting: []))
    }

    /// The session on screen shows its own approval card inline, so the bar must not point at it.
    func testBannerExcludesTheFocusedSession() {
        let waiting = [session("focused", approvals: 1, agentID: "dev", agentName: "wikova-develop")]
        XCTAssertNil(NeedsYouLogic.banner(waiting: waiting, excluding: "focused"))
    }

    func testSingleWaitingSessionNamesItsWorkspace() {
        let waiting = [session("s1", approvals: 1, agentID: "dev", agentName: "wikova-develop")]
        let banner = NeedsYouLogic.banner(waiting: waiting)
        XCTAssertEqual(banner?.count, 1)
        XCTAssertEqual(banner?.text, "wikova-develop needs you")
        XCTAssertEqual(banner?.target.id, "s1")
    }

    func testSeveralWaitingSessionsCollapseToACount() {
        let waiting = [
            session("s1", approvals: 1, agentID: "dev", agentName: "wikova-develop"),
            session("s2", approvals: 1, agentID: "prod", agentName: "wikova-prod"),
        ]
        XCTAssertEqual(NeedsYouLogic.banner(waiting: waiting)?.text, "2 sessions need you")
    }

    /// Excluding the focused session drops the count too — two waiting, one of them on screen,
    /// reads as the single remaining workspace rather than "2 sessions".
    func testCountAndCopyBothDropTheFocusedSession() {
        let waiting = [
            session("focused", approvals: 1, agentID: "dev", agentName: "wikova-develop"),
            session("other", approvals: 1, agentID: "prod", agentName: "wikova-prod"),
        ]
        let banner = NeedsYouLogic.banner(waiting: waiting, excluding: "focused")
        XCTAssertEqual(banner?.count, 1)
        XCTAssertEqual(banner?.text, "wikova-prod needs you")
        XCTAssertEqual(banner?.target.id, "other")
    }

    /// A tap opens the one that has waited longest, whatever order the snapshot arrives in.
    func testTargetIsTheLongestWaitingSessionRegardlessOfInputOrder() {
        let newest = session("newest", approvals: 1, agentID: "a", agentName: "A",
                             lastTurnAt: "2026-08-14T10:00:00.000Z")
        let oldest = session("oldest", approvals: 1, agentID: "b", agentName: "B",
                             lastTurnAt: "2026-08-14T08:00:00.000Z")
        let middle = session("middle", approvals: 1, agentID: "c", agentName: "C",
                             lastTurnAt: "2026-08-14T09:00:00.000Z")
        XCTAssertEqual(NeedsYouLogic.banner(waiting: [newest, oldest, middle])?.target.id, "oldest")
        XCTAssertEqual(NeedsYouLogic.banner(waiting: [oldest, middle, newest])?.target.id, "oldest")
    }

    /// An agent-less / unnamed session still gets a sentence rather than an empty one.
    func testSingleSessionFallsBackToTitleThenAGenericNoun() {
        let titled = session("s1", approvals: 1, agentID: "dev", title: "Backfill worktree fences")
        XCTAssertEqual(NeedsYouLogic.banner(waiting: [titled])?.text,
                       "Backfill worktree fences needs you")
        let bare = session("s2", approvals: 1, agentID: "dev")
        XCTAssertEqual(NeedsYouLogic.banner(waiting: [bare])?.text, "A session needs you")
    }

    /// The bar and the cross-project inbox must agree about what is most overdue, so the target is
    /// picked on the same key the inbox is ordered by: when the approval was raised, not when the
    /// session last ran. A session streaming output since it asked is exactly the one whose recency
    /// hides how long it has been blocked.
    func testTargetIsTheLongestBLOCKEDSessionNotTheLeastRecentlyActive() {
        let asked = [
            session("recentlyActiveButOldAsk", approvals: 1, agentID: "a", agentName: "A",
                    lastTurnAt: "2026-08-22T11:59:00.000Z",
                    waitingSince: "2026-08-22T09:00:00.000Z"),
            session("idleButFreshAsk", approvals: 1, agentID: "b", agentName: "B",
                    lastTurnAt: "2026-08-22T08:00:00.000Z",
                    waitingSince: "2026-08-22T11:00:00.000Z"),
        ]
        XCTAssertEqual(NeedsYouLogic.banner(waiting: asked)?.target.id, "recentlyActiveButOldAsk")
        XCTAssertEqual(NeedsYouLogic.banner(waiting: asked.reversed())?.target.id,
                       "recentlyActiveButOldAsk")
    }

    /// An older control plane serves no wait timestamp; those rows keep the recency ordering, and
    /// sort behind every row that does carry a real wait.
    func testRowsWithNoWaitTimestampSortBehindThoseThatHaveOne() {
        let stamped = session("stamped", approvals: 1, agentID: "a", agentName: "A",
                              lastTurnAt: "2026-08-22T11:00:00.000Z",
                              waitingSince: "2026-08-22T10:00:00.000Z")
        let legacyOld = session("legacyOld", approvals: 1, agentID: "b", agentName: "B",
                                lastTurnAt: "2026-08-22T07:00:00.000Z")
        let legacyNew = session("legacyNew", approvals: 1, agentID: "c", agentName: "C",
                                lastTurnAt: "2026-08-22T09:00:00.000Z")
        XCTAssertEqual(NeedsYouLogic.banner(waiting: [legacyOld, stamped, legacyNew])?.target.id,
                       "stamped")
        XCTAssertEqual(NeedsYouLogic.banner(waiting: [legacyNew, legacyOld])?.target.id, "legacyOld")
    }
}
