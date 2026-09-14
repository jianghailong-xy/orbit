import Foundation
import XCTest
@testable import OrbitKit

/// The Edit sheet: conditions that fit the watch's targets, its current one leading, and a PATCH that
/// carries only what changed (the server refuses an empty one).
final class WatchEditingTests: XCTestCase {
    private typealias F = WatchFixture

    func testConditionsFitTheTargetKind() {
        XCTAssertTrue(WatchEditing.conditions(for: .task).allSatisfy { $0.leaves.allSatisfy { $0.targetKind == .task } })
        XCTAssertTrue(WatchEditing.conditions(for: .session)
            .allSatisfy { $0.leaves.allSatisfy { $0.targetKind == .session } })
        XCTAssertEqual(WatchEditing.conditions(for: .unknown), [])
        // The canonical agent request is on offer (contract vector `all-terminal-or-any-failed`).
        XCTAssertTrue(WatchEditing.conditions(for: .task).contains(.anyOf([.all(.taskTerminal), .any(.taskFailed)])))
    }

    func testTheCurrentConditionLeadsSoOpeningAndSavingChangesNothing() {
        let conditions = WatchEditing.conditions(for: F.watch(predicate: F.any("TASK_FAILED")))
        XCTAssertEqual(conditions.first, .any(.taskFailed))
        XCTAssertEqual(conditions.filter { $0 == .any(.taskFailed) }.count, 1)
        // One the sheet doesn't offer still leads.
        let custom: [String: Any] = ["kind": "ALL_OF", "operands": [F.all("TASK_DONE"), F.any("TASK_FAILED")]]
        XCTAssertEqual(WatchEditing.conditions(for: F.watch(predicate: custom)).first,
                       .allOf([.all(.taskDone), .any(.taskFailed)]))
        // One this build can't read isn't offered back.
        let unreadable = F.watch(predicate: ["kind": "NONE_OF", "operands": [] as [Any]])
        XCTAssertEqual(WatchEditing.conditions(for: unreadable), WatchEditing.conditions(for: .task))
    }

    func testRequestCarriesOnlyWhatChanged() {
        let watch = F.watch(predicate: F.all("TASK_TERMINAL"))
        XCTAssertNil(WatchEditing.request(for: watch, condition: .all(.taskTerminal), ttlSeconds: nil))
        XCTAssertEqual(WatchEditing.request(for: watch, condition: .any(.taskFailed), ttlSeconds: nil),
                       UpdateWatchRequest(predicate: .any(.taskFailed)))
        XCTAssertEqual(WatchEditing.request(for: watch, condition: .all(.taskTerminal), ttlSeconds: 3_600),
                       UpdateWatchRequest(ttlSeconds: 3_600))
        XCTAssertEqual(WatchEditing.request(for: watch, condition: .all(.taskDone), ttlSeconds: 86_400),
                       UpdateWatchRequest(predicate: .all(.taskDone), ttlSeconds: 86_400))
        // A term this build can't read is never sent.
        XCTAssertNil(WatchEditing.request(for: watch, condition: .unknown("NONE_OF"), ttlSeconds: nil))
    }

    func testDeadlineTitles() {
        XCTAssertEqual(WatchEditing.deadlineChoices.map(WatchEditing.deadlineTitle),
                       ["1 hour", "6 hours", "1 day", "3 days", "7 days", "30 days"])
    }
}
