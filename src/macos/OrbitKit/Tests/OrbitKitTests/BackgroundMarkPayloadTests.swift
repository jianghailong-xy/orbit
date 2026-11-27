import Foundation
import XCTest
@testable import OrbitKit

/// The Background row icon (a mark until the owner's 2026-11-27 change) against web on the paths that hand
/// `runningBgCount` and `activity` to `SessionDisplay`: search,
/// the task run label, shared Markdown and the live `session.updated`, on the cross-client check's server-built payloads
/// (scripts/acceptance/session-three-state-check/background/background-payloads.json: 23 cases, and one session as a
/// background job is added and cleared; `web` is what web's `sessionDisplayState` / `sessionMarks` / `sessionRowIcons`
/// answer for the same payload).
final class BackgroundMarkPayloadTests: XCTestCase {
    private static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    /// The cases web draws Background on.
    private static let backgroundCases = ["job running", "parked, background process left up",
                                          "approval beside a background job", "interrupted, a process up, retry armed"]

    private func fixture() throws -> [String: Any] {
        let url = Self.root.appendingPathComponent(
            "scripts/acceptance/session-three-state-check/background/background-payloads.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }

    private func cases() throws -> [[String: Any]] { try fixture()["cases"] as! [[String: Any]] }

    private struct Answer {
        let payload: [String: Any]
        let state: String
        let marks: [String]
        let rowIcons: [String]

        init(_ read: Any?) throws {
            let read = try XCTUnwrap(read as? [String: Any])
            payload = read["payload"] as! [String: Any]
            let web = read["web"] as! [String: Any]
            state = web["state"] as! String
            marks = web["marks"] as! [String]
            rowIcons = web["rowIcons"] as! [String]
        }

        var written: String { ([state] + marks).joined(separator: " \u{00B7} ") }
    }

    /// Web's name for a row icon: BACKGROUND, WILL_RESUME.
    private static func webName(_ icon: SessionRowIcon) -> String {
        switch icon {
        case .background: return "BACKGROUND"
        case .willResume: return "WILL_RESUME"
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ payload: [String: Any]) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    private func assert(_ facts: SessionDisplayFacts, matches web: Answer, _ message: String,
                        file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(SessionDisplay.state(facts)?.word, web.state, "\(message) state", file: file, line: line)
        XCTAssertEqual(SessionDisplay.marks(facts)?.map(\.word), web.marks, "\(message) marks", file: file, line: line)
        XCTAssertEqual(SessionDisplay.rowIcons(facts).map(Self.webName), web.rowIcons, "\(message) row icons",
                       file: file, line: line)
    }

    func testTheFixtureHoldsThe23CasesAndWebDrawsBackgroundOnFour() throws {
        let all = try cases()
        XCTAssertEqual(all.count, 23)
        for kind in ["listRow", "sessionSummary", "taskRun", "searchHit"] {
            let drawn = try all.compactMap { c -> String? in
                guard c[kind] is [String: Any] else { return nil }
                return try Answer(c[kind]).rowIcons.contains("BACKGROUND") ? c["name"] as? String : nil
            }
            XCTAssertEqual(drawn, Self.backgroundCases, kind)
        }
    }

    func testSearchDrawsWebsStateAndMarksOnEveryCase() throws {
        var read = 0
        for c in try cases() where c["searchHit"] is [String: Any] {
            let web = try Answer(c["searchHit"])
            let hit = try decode(SessionSearchHit.self, web.payload)
            assert(hit.displayFacts, matches: web, "\(c["name"]!)")
            XCTAssertEqual(web.marks, try Answer(c["listRow"]).marks, "\(c["name"]!) as the list row")
            read += 1
        }
        XCTAssertEqual(read, 22)
    }

    func testTheTaskRunLabelAndSharedMarkdownWriteWebsStateAndMarksOnEveryCase() throws {
        for c in try cases() {
            let web = try Answer(c["taskRun"])
            let run = try decode(SessionRef.self, web.payload)
            assert(run.displayFacts, matches: web, "\(c["name"]!)")
            XCTAssertEqual(ShareMarkdown.runLabel(run), web.written, "\(c["name"]!)")
            XCTAssertEqual(web.marks, try Answer(c["listRow"]).marks, "\(c["name"]!) as the list row")
        }
    }

    /// The summary folded into the row as listed before any background work showed, as the Open list takes it.
    func testASessionUpdatedBringsWebsMarksToARowListedBeforeTheWorkShowed() throws {
        var merged: [String] = []
        for c in try cases() {
            let name = c["name"] as! String
            let web = try Answer(c["sessionSummary"])
            var listed = try Answer(c["listRow"]).payload
            listed["activity"] = nil
            listed["runningBgCount"] = 0
            let held = try decode(Session.self, listed)
            let summary = try decode(ControlSessionSummary.self, web.payload)
            switch OpenRowChange.merging(summary, into: [held]) {
            case .replace(_, let row): assert(row.displayFacts, matches: web, name)
            case .unchanged: assert(held.displayFacts, matches: web, name)
            case .needsSnapshot: continue
            }
            merged.append(name)
        }
        for name in Self.backgroundCases { XCTAssertTrue(merged.contains(name), "\(name) is folded, not re-read") }
    }

    func testASessionUpdatedAddsABackgroundJobAndTheNextOneClearsIt() throws {
        let steps = try fixture()["live"] as! [[String: Any]]
        XCTAssertEqual(steps.map { $0["name"] as! String }, ["before", "job added", "job cleared"])
        var rows = [try decode(Session.self, try Answer(steps[0]["listRow"]).payload)]
        XCTAssertEqual(SessionDisplay.marks(rows[0].displayFacts), [])

        for (step, icons) in [(steps[1], [SessionRowIcon.background]), (steps[2], [])] {
            let name = step["name"] as! String
            let web = try Answer(step["sessionSummary"])
            let summary = try decode(ControlSessionSummary.self, web.payload)
            guard case .replace(let index, let row) = OpenRowChange.merging(summary, into: rows) else {
                return XCTFail("\(name): the row was not replaced")
            }
            rows[index] = row
            assert(row.displayFacts, matches: web, name)
            XCTAssertEqual(SessionDisplay.rowIcons(row.displayFacts), icons, name)
            // The row then reads as the list would send it.
            let listed = try decode(Session.self, try Answer(step["listRow"]).payload)
            XCTAssertEqual(row.activity, listed.activity, name)
            XCTAssertEqual(row.runningBgCount, listed.runningBgCount, name)
        }
    }

    /// A server too old to send the two inputs on `session.updated` leaves the row's.
    func testASessionUpdatedWithoutTheInputsKeepsTheRows() throws {
        let steps = try fixture()["live"] as! [[String: Any]]
        let row = try decode(Session.self, try Answer(steps[1]["listRow"]).payload)
        var payload = try Answer(steps[2]["sessionSummary"]).payload
        payload["activity"] = nil
        payload["runningBgCount"] = nil
        let merged = row.applying(try decode(ControlSessionSummary.self, payload))
        XCTAssertEqual(merged.activity, "BACKGROUND_JOB")
        XCTAssertEqual(merged.runningBgCount, 1)
        XCTAssertEqual(SessionDisplay.rowIcons(merged.displayFacts), [.background])
    }
}
