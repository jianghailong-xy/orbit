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
        XCTAssertTrue(before.contains { $0.phase != nil }, "a row carries phase, so the summary's must survive")
        var rows = before
        for (i, row) in before.enumerated() {
            let json = ##"{"id":"\##(row.id)","status":"\##(row.status.rawValue)","pendingApprovals":\##(row.pendingApprovals ?? 0),"lastTurnAt":"2026-11-20T12:00:\##(String(format: "%02d", i)).000Z","listedAt":"\##(row.listedAt ?? "")"}"##
                .replacingOccurrences(of: ",\"listedAt\":\"\"", with: "")
                // The server's summary carries phase (realtime.service.ts); a row that has one keeps it.
                .replacingOccurrences(of: "}", with: row.phase.map { ",\"phase\":\"\($0.rawValue)\"}" } ?? "}")
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

    /// A settled row dates its listing, so its time agrees with its place (owner 2026-11-26).
    func testRowTimeLabelShowsListedAt() throws {
        let row = try JSONDecoder().decode(Session.self, from: Data(
            ##"{"id":"a","title":"a","status":"AWAITING_INPUT","listedAt":"2026-11-20T11:00:00.000Z","lastTurnAt":"2026-11-20T11:59:30.000Z","createdAt":"2026-09-01T00:00:00.000Z"}"##.utf8))
        XCTAssertEqual(SessionListTime.format(for: row, now: date("2026-11-20T12:00:00.000Z")), "1h ago")
    }

    /// Every settled fixture row (a date section's) shows `listedAt`, `createdAt` when null.
    func testEverySettledFixtureRowShowsItsListing() throws {
        let fx = try fixture()
        let now = date(try XCTUnwrap(fx["now"] as? String))
        let dated = Set((try XCTUnwrap(fx["expected"] as? [[String: Any]]))
            .filter { ["Pinned", "Needs you", "Working"].contains($0["section"] as! String) == false }
            .flatMap { $0["ids"] as! [String] })
        for row in try sessions(fx) where dated.contains(row.id) {
            XCTAssertEqual(SessionListTime.format(for: row, now: now),
                           RelativeTime.format(try XCTUnwrap(row.listedAt ?? row.createdAt), now: now), row.id)
        }
    }

    private func shape(_ out: [SessionTimeSection]) -> [[String]] { out.map { [$0.title] + $0.sessions.map(\.id) } }
    private func shape(_ expected: Any?) throws -> [[String]] {
        try XCTUnwrap(expected as? [[String: Any]]).map { [$0["section"] as! String] + ($0["ids"] as! [String]) }
    }

    /// With a tag filter on, Open draws no Pinned section, keeps Needs you and Working, and orders a
    /// pinned row like any other (the options the workspace list passes, `AgentsView.timeSections`).
    func testTagFilteredOpenMatchesTheSharedFixture() throws {
        let fx = try fixture()
        let rows = SessionFilter.consoleSorted(openList(try sessions(fx)).reversed())
        let out = SessionTimeGrouping.sections(rows, pinnedFirst: false, attention: true,
                                               now: date(try XCTUnwrap(fx["now"] as? String)), calendar: try calendar(fx))
        XCTAssertEqual(shape(out), try shape(fx["expectedTagFilter"]))
    }

    /// Trash: date sections by listedAt, no pin, no attention sections, through the path the list takes.
    func testTrashMatchesTheSharedFixture() throws {
        let fx = try fixture()
        let all = try sessions(fx)
        let trashed = all.filter { $0.deletedAt != nil && $0.completedAt == nil }.reversed()
        let rows = SessionFilter.consoleSorted(Array(trashed), pinnedFirst: false)
        let out = SessionTimeGrouping.sections(rows, pinnedFirst: false,
                                               now: date(try XCTUnwrap(fx["now"] as? String)), calendar: try calendar(fx))
        XCTAssertEqual(shape(out), try shape(fx["expectedTrash"]))
    }

    /// The list the phone draws goes through `SessionProjectGrouping`, whose entries are what the
    /// sections are cut from: a busier session (fresher lastTurnAt) must not sit above one listed later,
    /// and a feed of activity-only changes (lastTurnAt and preview text) must leave the order as it was.
    func testListingEntriesAreOrderedByListedAtNotActivity() throws {
        func row(_ id: String, listed: String, turn: String, text: String) throws -> Session {
            try JSONDecoder().decode(Session.self, from: Data(
                ##"{"id":"\##(id)","title":"\##(id)","status":"RUNNING","runState":"RUNNING","listedAt":"\##(listed)","lastTurnAt":"\##(turn)","createdAt":"2026-09-01T00:00:00.000Z","lastAssistantText":"\##(text)"}"##.utf8))
        }
        func order(_ rows: [Session]) -> [String] {
            SessionProjectGrouping.listing(rows, folders: [], projects: [], view: .open, byTag: false)
                .entries.map(\.id)
        }
        let before = [
            try row("a", listed: "2026-11-20T09:20:00.000Z", turn: "2026-11-20T09:20:00.000Z", text: "start"),
            try row("b", listed: "2026-11-20T09:10:00.000Z", turn: "2026-11-20T09:10:00.000Z", text: "start"),
            try row("c", listed: "2026-11-20T09:00:00.000Z", turn: "2026-11-20T09:00:00.000Z", text: "start"),
        ]
        XCTAssertEqual(order(before), ["a", "b", "c"])
        // Activity only: c streams most recently, then b; listedAt unchanged, previews change.
        let after = [
            try row("a", listed: "2026-11-20T09:20:00.000Z", turn: "2026-11-20T09:20:05.000Z", text: "reading logs"),
            try row("b", listed: "2026-11-20T09:10:00.000Z", turn: "2026-11-20T11:59:00.000Z", text: "running tests"),
            try row("c", listed: "2026-11-20T09:00:00.000Z", turn: "2026-11-20T12:00:00.000Z", text: "waiting on CI"),
        ]
        XCTAssertEqual(order(after), order(before))
        XCTAssertEqual(after.map { $0.lastAssistantText }, ["reading logs", "running tests", "waiting on CI"])
        XCTAssertNotEqual(before.map { $0.lastAssistantText }, after.map { $0.lastAssistantText })
    }
}
