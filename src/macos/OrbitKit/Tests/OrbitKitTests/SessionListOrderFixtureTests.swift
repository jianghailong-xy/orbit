import Foundation
import XCTest
@testable import OrbitKit

/// The shared session-list order contract (contracts/session-list-order.fixtures.json): the web,
/// Apple and Android clients each assert the same sections and order against the same rows.
final class SessionListOrderFixtureTests: XCTestCase {
    private struct FixtureMissing: Error {}

    private func fixture() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("contracts/session-list-order.fixtures.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: candidate)) as? [String: Any])
            }
            dir.deleteLastPathComponent()
        }
        throw FixtureMissing()
    }

    private func date(_ iso: String) -> Date {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso)!
    }

    private func sessions(_ fixture: [String: Any]) throws -> [Session] {
        try XCTUnwrap(fixture["sessions"] as? [[String: Any]]).map { row in
            var row = row
            row["title"] = row["id"]
            return try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: row))
        }
    }

    private func calendar(_ fixture: [String: Any]) throws -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = try XCTUnwrap(TimeZone(identifier: try XCTUnwrap(fixture["timeZone"] as? String)))
        return c
    }

    private func openList(_ all: [Session]) -> [Session] {
        all.filter { $0.completedAt == nil && $0.deletedAt == nil }
    }

    func testSectionsAndOrderMatchTheSharedFixture() throws {
        let fx = try fixture()
        let now = date(try XCTUnwrap(fx["now"] as? String))
        // Feed the rows in reverse, so the order under test is the client's, not the file's.
        let sorted = SessionFilter.consoleSorted(openList(try sessions(fx)).reversed())
        let out = SessionTimeGrouping.sections(sorted, now: now, calendar: try calendar(fx))
        let expected = try XCTUnwrap(fx["expected"] as? [[String: Any]])
        XCTAssertEqual(out.map(\.title), expected.map { $0["section"] as! String })
        XCTAssertEqual(out.map { $0.sessions.map(\.id) }, expected.map { $0["ids"] as! [String] })
        XCTAssertEqual(out.map(\.title), (fx["sectionTitles"] as! [String]).filter { t in
            expected.contains { $0["section"] as? String == t }
        })
    }

    func testStreamedActivityDoesNotReorderRows() throws {
        let fx = try fixture()
        let now = date(try XCTUnwrap(fx["now"] as? String))
        let cal = try calendar(fx)
        let before = SessionFilter.consoleSorted(openList(try sessions(fx)))
        let titles = SessionTimeGrouping.sections(before, now: now, calendar: cal).map { $0.sessions.map(\.id) }

        // A live summary for every row that moves lastTurnAt (and nothing else the owner sees).
        var rows = before
        for (i, row) in before.enumerated() {
            let json = ##"{"id":"\##(row.id)","status":"\##(row.status.rawValue)","pendingApprovals":\##(row.pendingApprovals ?? 0),"lastTurnAt":"2026-11-20T12:00:\##(String(format: "%02d", i)).000Z","listedAt":"\##(row.listedAt ?? "")"}"##
                .replacingOccurrences(of: ",\"listedAt\":\"\"", with: "")
            let summary = try JSONDecoder().decode(ControlSessionSummary.self, from: Data(json.utf8))
            rows[i] = row.applying(summary)
            XCTAssertEqual(rows[i].lastTurnAt, summary.lastTurnAt)
            XCTAssertEqual(rows[i].listedAt, row.listedAt)
        }
        let after = SessionFilter.consoleSorted(rows.reversed())
        XCTAssertEqual(SessionTimeGrouping.sections(after, now: now, calendar: cal).map { $0.sessions.map(\.id) }, titles)
    }

    func testSummaryWithNewListedAtMovesTheRow() throws {
        let row = try JSONDecoder().decode(Session.self, from: Data(
            ##"{"id":"a","title":"a","status":"AWAITING_INPUT","listedAt":"2026-11-20T01:00:00.000Z"}"##.utf8))
        let summary = try JSONDecoder().decode(ControlSessionSummary.self, from: Data(
            ##"{"id":"a","status":"AWAITING_INPUT","pendingApprovals":0,"listedAt":"2026-11-20T02:00:00.000Z"}"##.utf8))
        XCTAssertEqual(row.applying(summary).listedAt, "2026-11-20T02:00:00.000Z")
    }

    func testRowTimeLabelShowsListedAt() throws {
        let row = try JSONDecoder().decode(Session.self, from: Data(
            ##"{"id":"a","title":"a","status":"AWAITING_INPUT","listedAt":"2026-11-20T11:00:00.000Z","lastTurnAt":"2026-11-20T11:59:30.000Z","createdAt":"2026-09-01T00:00:00.000Z"}"##.utf8))
        XCTAssertEqual(SessionListTime.format(for: row, now: date("2026-11-20T12:00:00.000Z")), "1h ago")
    }
}
