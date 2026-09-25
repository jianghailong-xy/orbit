import XCTest
@testable import OrbitKit

/// Holds `TaskProgressCopy` to the golden table the web half answers to
/// (`src/shared/src/taskProgressCopy.golden.json`, asserted by `taskProgressCopy.spec.ts`): the two
/// clients have no compiler in common, so this table is what notices a word changed on one side only.
/// Missing table = failure, never a skip: a check that opts out when its subject moves is green on
/// exactly the day it stops checking. If the table moved, move this with it.
final class TaskProgressCopyParityTests: XCTestCase {
    private func golden() throws -> JSONValue {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/shared/src/taskProgressCopy.golden.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: candidate))
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkipFailure()
    }
    private struct XCTSkipFailure: Error, CustomStringConvertible {
        var description: String {
            "src/shared/src/taskProgressCopy.golden.json not found above this file — if it moved, point this test at it; do not delete the check"
        }
    }

    private func array(_ v: JSONValue?) -> [JSONValue] {
        if case .array(let a)? = v { return a }
        return []
    }

    func testEveryCaseOfTheGoldenTable() throws {
        let table = try golden()
        let cases = array(table["cases"])
        XCTAssertGreaterThanOrEqual(cases.count, 4, "the table lost its cases")
        for c in cases {
            let name = c["name"]?.stringValue ?? "?"
            guard let p = TaskProgress.from(c["progress"]) else { return XCTFail("\(name): progress did not parse") }
            XCTAssertEqual(TaskProgressCopy.badge(p), c["badge"]?.stringValue, name)
            XCTAssertEqual(TaskProgressCopy.trayLine(p), c["trayLine"]?.stringValue, name)
            XCTAssertEqual(TaskProgressCopy.footer(p), c["footer"]?.stringValue, name)
            let groups = TaskProgressCopy.phaseGroups(p)
            let expected = array(c["groups"])
            XCTAssertEqual(groups.count, expected.count, name)
            for (g, e) in zip(groups, expected) {
                XCTAssertEqual(g.title, e["title"]?.stringValue, name)
                XCTAssertEqual(g.done, e["done"]?.intValue, name)
                XCTAssertEqual(g.total, e["total"]?.intValue, name)
                let rows = array(e["agents"])
                XCTAssertEqual(g.agents.count, rows.count, name)
                for (a, row) in zip(g.agents, rows) {
                    XCTAssertEqual(a.label, row["label"]?.stringValue, name)
                    XCTAssertEqual(TaskProgressCopy.lane(a).rawValue, row["lane"]?.stringValue, "\(name) · \(a.label)")
                    XCTAssertEqual(TaskProgressCopy.detail(a), row["detail"]?.stringValue, "\(name) · \(a.label)")
                    XCTAssertEqual(TaskProgressCopy.now(a), row["now"]?.stringValue, "\(name) · \(a.label)")
                }
            }
        }
    }

    func testDurations() throws {
        let rows = array(try golden()["durations"])
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let pair = array(row)
            XCTAssertEqual(TaskProgressCopy.duration(ms: pair[0].intValue ?? -1), pair[1].stringValue)
        }
    }

    func testWorkflowTitles() throws {
        let rows = array(try golden()["titles"])
        XCTAssertFalse(rows.isEmpty)
        for t in rows {
            let progress = t["progressDescription"]?.stringValue.flatMap {
                TaskProgress.from(.object(["toolUseId": .string("x"), "description": .string($0)]))
            }
            XCTAssertEqual(TaskProgressCopy.workflowTitle(input: t["input"] ?? .null, result: t["result"]?.stringValue,
                                                          progress: progress),
                           t["title"]?.stringValue, t["name"]?.stringValue ?? "?")
        }
    }
}
