import XCTest
@testable import OrbitKit

/// The iOS Agent-console list's recency sections: Pinned first, then Today / Yesterday /
/// 2–7 days ago / 8–30 days ago / Older bucketed by the calendar day of the list's `listedAt`.
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
    private func session(_ id: String, listedAt: String? = nil, createdAt: String? = nil,
                         pinnedAt: String? = nil) -> Session {
        Session(id: id, title: id, status: .awaitingInput, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: nil, branch: nil, updatedAt: nil,
                pinnedAt: pinnedAt, createdAt: createdAt, listedAt: listedAt)
    }

    private let now = "2026-07-08T12:00:00Z"

    private func sections(_ sessions: [Session]) -> [SessionTimeSection] {
        SessionTimeGrouping.sections(sessions, now: date(now), calendar: utc)
    }

    func testBucketsByCalendarDay() {
        let s = [
            session("today", listedAt: "2026-07-08T09:00:00Z"),
            session("yesterday", listedAt: "2026-07-07T23:00:00Z"),
            session("prev7", listedAt: "2026-07-05T12:00:00Z"),   // 3 days
            session("prev30", listedAt: "2026-06-18T12:00:00Z"),  // 20 days
            session("older", listedAt: "2026-05-09T12:00:00Z"),   // 60 days
        ]
        let out = sections(s)
        XCTAssertEqual(out.map(\.title),
                       ["Today", "Yesterday", "2–7 days ago", "8–30 days ago", "Older"])
        XCTAssertEqual(out.map { $0.sessions.map(\.id) },
                       [["today"], ["yesterday"], ["prev7"], ["prev30"], ["older"]])
    }

    func testPinnedLiftedToLeadingSectionRegardlessOfDate() {
        let s = [
            session("pin-old", listedAt: "2026-05-01T00:00:00Z", pinnedAt: "2026-01-01T00:00:00Z"),
            session("today", listedAt: "2026-07-08T09:00:00Z"),
        ]
        let out = sections(s)
        XCTAssertEqual(out.map(\.title), ["Pinned", "Today"])
        XCTAssertEqual(out[0].sessions.map(\.id), ["pin-old"])
    }

    func testPinnedFirstDisabledBucketsPinnedByTime() {
        // Completed/Trash views (pinnedFirst: false): a stale pinnedAt must NOT spawn a "Pinned"
        // section — the session just buckets by its time like any other.
        let s = [session("pin", listedAt: "2026-07-08T09:00:00Z", pinnedAt: "2026-01-01T00:00:00Z")]
        let out = SessionTimeGrouping.sections(s, pinnedFirst: false, now: date(now), calendar: utc)
        XCTAssertEqual(out.map(\.title), ["Today"])
    }

    func testEmptyBucketsDropped() {
        let out = sections([session("a", listedAt: "2026-07-08T08:00:00Z")])
        XCTAssertEqual(out.map(\.title), ["Today"])
    }

    func testOrderWithinBucketPreserved() {
        // Input is already recency-sorted; the bucket must keep that order.
        let s = [
            session("newer", listedAt: "2026-07-08T11:00:00Z"),
            session("older", listedAt: "2026-07-08T07:00:00Z"),
        ]
        XCTAssertEqual(sections(s).first?.sessions.map(\.id), ["newer", "older"])
    }

    func testFallsBackToCreatedAtThenOlder() {
        // No listedAt → uses createdAt.
        let created = session("queued", createdAt: "2026-07-08T06:00:00Z")
        XCTAssertEqual(sections([created]).map(\.title), ["Today"])
        // Neither timestamp → Older.
        let none = session("ghost")
        XCTAssertEqual(sections([none]).map(\.title), ["Older"])
    }

    func testDayBoundaries() {
        let s = [
            session("d7", listedAt: "2026-07-01T12:00:00Z"),  // exactly 7 days → 2–7 days ago
            session("d8", listedAt: "2026-06-30T12:00:00Z"),  // 8 days → 8–30 days ago
            session("d31", listedAt: "2026-06-07T12:00:00Z"), // 31 days → Older
        ]
        XCTAssertEqual(sections(s).map(\.title), ["2–7 days ago", "8–30 days ago", "Older"])
    }

    // MARK: Needs you reads a failure from the session facts

    private func failed(_ fields: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(#"{"id":"s","title":"s","status":"FAILED","runStatus":"FAILED","createdAt":"2026-07-08T09:00:00Z",\#(fields)}"#.utf8))
    }
    private func needsYou(_ fields: String) throws -> Bool {
        sections([try failed(fields)]).first?.title == "Needs you"
    }
    private let released = #""phase":"IDLE","released":true,"lastTurnOutcome":"FAILED""#

    func testEndNeverConfirmedIsNotUnderNeedsYou() throws {
        XCTAssertFalse(try needsYou(released + #","endReason":"user_ended""#))
    }
    func testRealFailureIsUnderNeedsYou() throws {
        XCTAssertTrue(try needsYou(released))
    }
    func testFailureBeingRetriedIsNotUnderNeedsYou() throws {
        XCTAssertFalse(try needsYou(released + #","retryAt":"2026-07-08T13:00:00Z""#))
    }
    func testFactsAbsentGroupsAsBefore() throws {
        XCTAssertTrue(try needsYou(#""endReason":"user_ended""#))
        XCTAssertFalse(try needsYou(#""retryAt":"2026-07-08T13:00:00Z""#))
    }
}
