import Foundation
import XCTest
@testable import OrbitKit

/// The phone's Plan usage sheet for an Antigravity login as agy 1.4.12 reported one on 2026-11-01:
/// four buckets with all left, and Gemini 4 Argon's own weekly bucket spent. The sheet is tall enough
/// for every bucket's id line, and a spent window's bar is full and red rather than an empty track.
final class PlanUsageSheetTests: XCTestCase {
    private func antigravity() throws -> PlanUsageSnapshot {
        let json = """
        {"provider": "antigravity", "buckets": [
          {"id": "gemini-weekly", "window": "weekly", "remainingFraction": 1, "resetTime": "2026-11-08T01:45:00Z"},
          {"id": "gemini-5h", "window": "5h", "remainingFraction": 1, "resetTime": "2026-11-01T06:45:00Z"},
          {"id": "3p-weekly", "window": "weekly", "remainingFraction": 1, "resetTime": "2026-11-08T01:45:00Z"},
          {"id": "3p-5h", "window": "5h", "remainingFraction": 1, "resetTime": "2026-11-01T06:45:00Z"},
          {"id": "gemini-argon-wtu-weekly", "window": "weekly", "remainingFraction": 0,
           "resetTime": "2026-11-07T17:41:35Z"}]}
        """
        return try JSONDecoder().decode(PlanUsageSnapshot.self, from: Data(json.utf8))
    }

    func testOnlyTheSpentBucketIsSpent() throws {
        let rows = try antigravity().rows
        XCTAssertEqual(rows.map(\.spent), [false, false, false, false, true])
        XCTAssertEqual(rows.last?.percent, 0, "it still reads 0% remaining")
        // A window that counts what is used is spent at 100% used, and not a hair before.
        XCTAssertTrue(PlanUsageRow(key: "five_hour", label: "5h limit", groupLabel: nil,
                                   window: PlanUsageWindow(utilization: 100)).spent)
        XCTAssertFalse(PlanUsageRow(key: "five_hour", label: "5h limit", groupLabel: nil,
                                    window: PlanUsageWindow(utilization: 99.6)).spent)
    }

    func testEveryBucketsIdLineIsInTheSheetsHeight() throws {
        let rows = try antigravity().rows
        XCTAssertEqual(PlanUsageSheetLayout.rowsHeight(rows), 5 * (66 + 24))
        // A row without an id line keeps the height it had.
        XCTAssertEqual(PlanUsageSheetLayout.rowsHeight([
            PlanUsageRow(key: "five_hour", label: "5h limit", groupLabel: nil, window: PlanUsageWindow(utilization: 6)),
            PlanUsageRow(key: "seven_day", label: "Weekly limit", groupLabel: nil, window: PlanUsageWindow(utilization: 40)),
        ]), 2 * 66)
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw NSError(domain: "PlanUsageSheetTests", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "\(relative) not found"])
    }

    func testTheViewsDrawTheSheetAndTheBarsThisWay() throws {
        let views = "src/macos/OrbitApp/Sources/OrbitApp/Views/"
        let composer = try source(views + "ComposerView.swift")
        XCTAssertTrue(composer.contains("120 + PlanUsageSheetLayout.rowsHeight(usage.currentRows())"),
                      "the phone sheet's detent counts each row's id line")
        XCTAssertFalse(composer.contains("usage.rows.count * 66"))
        XCTAssertEqual(composer.components(separatedBy: "spent: row.spent)").count - 1, 2,
                       "the composer pill's bar and the sheet's bars both draw a spent window")
        XCTAssertTrue(composer.contains("private var fraction: CGFloat { spent ? 1 :"))
        XCTAssertTrue(composer.contains("Capsule().fill(spent ? Color.red :"))
        let runner = try source(views + "RunnerPageParts.swift")
        XCTAssertTrue(runner.contains("RunnerGauge(fraction: row.spent ? 1 :"),
                      "and so does the engine page's window row")
        XCTAssertTrue(runner.contains("tint: row.spent ? RunnerInk.red :"))
    }
}
