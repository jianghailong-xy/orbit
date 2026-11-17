import Foundation
import XCTest
@testable import OrbitKit

/// A new session Keep Free holds (queuedReason `disk_below_floor`), case for case with Android
/// `QueuedDiskLowTest`. Its words are web `runnerSlots.ts`'s, read back as text.
final class QueuedDiskLowTests: XCTestCase {
    func testHeldByKeepFreeAndNoOtherGate() throws {
        XCTAssertTrue(QueuedDiskLow.holds(try QueuedCapacityTests.row("disk_below_floor")))
        for reason in ["runner_at_capacity", "runner_updating", "runner_offline", nil] {
            XCTAssertFalse(QueuedDiskLow.holds(try QueuedCapacityTests.row(reason)), String(describing: reason))
        }
        // Only while queued: a row that has started is held by nothing.
        XCTAssertFalse(QueuedDiskLow.holds(try QueuedCapacityTests.row("disk_below_floor", status: "RUNNING", runState: "RUNNING")))
    }

    func testTheListAndHeaderSayLowDiskSpace() throws {
        let row = try QueuedCapacityTests.row("disk_below_floor")
        XCTAssertEqual(SessionLine.make(for: row, live: true).text, "Low disk space")
        XCTAssertEqual(SessionHeader.statusWord(for: row), "Low disk space")
    }

    func testTheWordsAreTheWebs() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var copy: String?
        for _ in 0..<12 {
            let file = dir.appendingPathComponent("src/web/src/lib/runnerSlots.ts")
            if FileManager.default.fileExists(atPath: file.path) { copy = try String(contentsOf: file, encoding: .utf8); break }
            dir = dir.deletingLastPathComponent()
        }
        let web = try XCTUnwrap(copy, "src/web/src/lib/runnerSlots.ts was not found above this test file")
        XCTAssertTrue(web.contains("export const DISK_LOW_TITLE = '\(QueuedDiskLow.title)';"))
        XCTAssertTrue(web.contains("export const DISK_LOW_WAIT = '\(QueuedDiskLow.wait)';"))
        XCTAssertTrue(web.contains("case '\(QueuedDiskLow.reason)':"))
    }
}
