import XCTest
@testable import OrbitKit

/// The iOS Agent-console list's recency sections: Pinned first, then Today / Yesterday /
/// Previous 7 Days / Previous 30 Days / Older bucketed by the calendar day of last activity.
final class SessionTimeGroupingTests: XCTestCase {
    /// UTC so `startOfDay` boundaries are deterministic regardless of the test host's timezone.
    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }
    private func date(_ iso: String) -> Date {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)!
    }
    private func session(_ id: String, lastTurnAt: String? = nil, createdAt: String? = nil,
                         pinnedAt: String? = nil) -> Session {
        Session(id: id, title: id, status: .awaitingInput, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: nil, branch: nil, updatedAt: nil,
                pinnedAt: pinnedAt, createdAt: createdAt, lastTurnAt: lastTurnAt)
    }

    private let now = "2026-07-08T12:00:00Z"

    private func sections(_ sessions: [Session]) -> [SessionTimeSection] {
        SessionTimeGrouping.sections(sessions, now: date(now), calendar: utc)
    }

    func testBucketsByCalendarDay() {
        let s = [
            session("today", lastTurnAt: "2026-07-08T09:00:00Z"),
            session("yesterday", lastTurnAt: "2026-07-07T23:00:00Z"),
            session("prev7", lastTurnAt: "2026-07-05T12:00:00Z"),   // 3 days
            session("prev30", lastTurnAt: "2026-06-18T12:00:00Z"),  // 20 days
            session("older", lastTurnAt: "2026-05-09T12:00:00Z"),   // 60 days
        ]
        let out = sections(s)
        XCTAssertEqual(out.map(\.title),
                       ["Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", "Older"])
        XCTAssertEqual(out.map { $0.sessions.map(\.id) },
                       [["today"], ["yesterday"], ["prev7"], ["prev30"], ["older"]])
    }

    func testPinnedLiftedToLeadingSectionRegardlessOfDate() {
        let s = [
            session("pin-old", lastTurnAt: "2026-05-01T00:00:00Z", pinnedAt: "2026-01-01T00:00:00Z"),
            session("today", lastTurnAt: "2026-07-08T09:00:00Z"),
        ]
        let out = sections(s)
        XCTAssertEqual(out.map(\.title), ["Pinned", "Today"])
        XCTAssertEqual(out[0].sessions.map(\.id), ["pin-old"])
    }

    func testPinnedFirstDisabledBucketsPinnedByTime() {
        // Completed/System views (pinnedFirst: false): a stale pinnedAt must NOT spawn a "Pinned"
        // section — the session just buckets by its time like any other.
        let s = [session("pin", lastTurnAt: "2026-07-08T09:00:00Z", pinnedAt: "2026-01-01T00:00:00Z")]
        let out = SessionTimeGrouping.sections(s, pinnedFirst: false, now: date(now), calendar: utc)
        XCTAssertEqual(out.map(\.title), ["Today"])
    }

    func testEmptyBucketsDropped() {
        let out = sections([session("a", lastTurnAt: "2026-07-08T08:00:00Z")])
        XCTAssertEqual(out.map(\.title), ["Today"])
    }

    func testOrderWithinBucketPreserved() {
        // Input is already recency-sorted; the bucket must keep that order.
        let s = [
            session("newer", lastTurnAt: "2026-07-08T11:00:00Z"),
            session("older", lastTurnAt: "2026-07-08T07:00:00Z"),
        ]
        XCTAssertEqual(sections(s).first?.sessions.map(\.id), ["newer", "older"])
    }

    func testFallsBackToCreatedAtThenOlder() {
        // No lastTurnAt → uses createdAt.
        let created = session("queued", createdAt: "2026-07-08T06:00:00Z")
        XCTAssertEqual(sections([created]).map(\.title), ["Today"])
        // Neither timestamp → Older.
        let none = session("ghost")
        XCTAssertEqual(sections([none]).map(\.title), ["Older"])
    }

    func testDayBoundaries() {
        let s = [
            session("d7", lastTurnAt: "2026-07-01T12:00:00Z"),  // exactly 7 days → Previous 7 Days
            session("d8", lastTurnAt: "2026-06-30T12:00:00Z"),  // 8 days → Previous 30 Days
            session("d31", lastTurnAt: "2026-06-07T12:00:00Z"), // 31 days → Older
        ]
        XCTAssertEqual(sections(s).map(\.title), ["Previous 7 Days", "Previous 30 Days", "Older"])
    }
}
