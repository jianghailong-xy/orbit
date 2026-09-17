import XCTest
@testable import OrbitKit

final class RelativeTimeTests: XCTestCase {
    private func at(_ iso: String) -> Date {
        let p = ISO8601DateFormatter()
        p.formatOptions = [.withInternetDateTime]
        return p.date(from: iso)!
    }

    func testBuckets() {
        let now = at("2026-06-26T12:00:00Z")
        XCTAssertEqual(RelativeTime.format("2026-06-26T11:59:30Z", now: now), "just now")
        XCTAssertEqual(RelativeTime.format("2026-06-26T11:55:00Z", now: now), "5m ago")
        XCTAssertEqual(RelativeTime.format("2026-06-26T09:00:00Z", now: now), "3h ago")
        XCTAssertEqual(RelativeTime.format("2026-06-24T12:00:00Z", now: now), "2d ago")
        XCTAssertEqual(RelativeTime.format("2026-06-19T12:00:00Z", now: now), "1w ago")
    }

    func testFallsBackToAbsoluteBeyondFourWeeks() {
        let now = at("2026-06-26T12:00:00Z")
        // ~5 weeks earlier → short month/day (local tz), not "Nw ago".
        let out = RelativeTime.format("2026-05-20T12:00:00Z", now: now)
        XCTAssertNotNil(out)
        XCTAssertFalse(out!.hasSuffix("ago"))
        XCTAssertEqual(out!.range(of: #"^\d{1,2}/\d{1,2}$"#, options: .regularExpression) != nil, true,
                       "expected M/d, got \(out!)")
    }

    func testParsesFractionalSeconds() {
        let now = at("2026-06-26T12:00:00Z")
        // 5m30s ago — confirms the fractional-seconds string parses (doesn't return nil) and buckets.
        XCTAssertEqual(RelativeTime.format("2026-06-26T11:54:30.500Z", now: now), "5m ago")
    }

    func testInvalidStringReturnsNil() {
        XCTAssertNil(RelativeTime.format("not-a-date"))
    }

    /// `elapsed` is a duration still running, so it carries no "ago" and no "just now" floor —
    /// the first minute is exactly where a turn about to come straight back differs from one
    /// settling in, and a bucket named "just now" would erase that.
    func testElapsedReportsADurationRatherThanAnAge() {
        let now = at("2026-06-26T12:00:00Z")
        XCTAssertEqual(RelativeTime.elapsed("2026-06-26T11:59:52Z", now: now), "8s")
        XCTAssertEqual(RelativeTime.elapsed("2026-06-26T11:48:00Z", now: now), "12m")
        XCTAssertEqual(RelativeTime.elapsed("2026-06-26T10:00:00Z", now: now), "2h")
        XCTAssertEqual(RelativeTime.elapsed("2026-06-23T12:00:00Z", now: now), "3d")
        for out in [RelativeTime.elapsed("2026-06-26T11:59:52Z", now: now),
                    RelativeTime.elapsed("2026-06-26T11:48:00Z", now: now)] {
            XCTAssertFalse(try! XCTUnwrap(out).hasSuffix("ago"))
        }
    }

    /// Clock skew between the runner and the device must not render as a negative age.
    func testElapsedClampsAFutureStart() {
        let now = at("2026-06-26T12:00:00Z")
        XCTAssertEqual(RelativeTime.elapsed("2026-06-26T12:00:30Z", now: now), "0s")
    }

    func testElapsedRejectsAnInvalidString() {
        XCTAssertNil(RelativeTime.elapsed("not-a-date"))
    }
}
