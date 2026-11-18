import Foundation
import XCTest
@testable import OrbitKit

/// A session a full runner, run or batch holds (docs/mocks/queued-card-runner-full), case for case with
/// web `queuedCapacity.test.ts`: HPC on 11-15, 10 turns and 6 slots held by bg_run jobs, of 16.
final class QueuedCapacityTests: XCTestCase {
    static func row(_ reason: String?, active: Int? = 16, limit: Int? = 16, held: Int? = 6,
                    lastTurnAt: String? = "2026-11-14T17:14:54.436Z", status: String = "PENDING",
                    runState: String = "QUEUED") throws -> Session {
        var fields: [String: Any] = ["id": "S1", "status": status, "runState": runState]
        if let reason { fields["queuedReason"] = reason }
        if let active { fields["queuedActive"] = active }
        if let limit { fields["queuedLimit"] = limit }
        if let held { fields["queuedHeldByJobs"] = held }
        if let lastTurnAt { fields["lastTurnAt"] = lastTurnAt }
        return try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: fields))
    }

    func testHeldByTheThreeCapacityGatesAndNoOther() throws {
        XCTAssertTrue(QueuedCapacity.holds(try Self.row("runner_at_capacity")))
        XCTAssertTrue(QueuedCapacity.holds(try Self.row("tree_at_capacity")))
        XCTAssertTrue(QueuedCapacity.holds(try Self.row("batch_at_capacity")))
        for reason in ["runner_updating", "runner_offline", "worktree_op_pending", nil] {
            XCTAssertFalse(QueuedCapacity.holds(try Self.row(reason)), String(describing: reason))
        }
        // Only while queued: a row that has started is held by nothing.
        XCTAssertFalse(QueuedCapacity.holds(try Self.row("runner_at_capacity", status: "RUNNING", runState: "RUNNING")))
    }

    func testTheListHeaderAndTagNameWhatIsFull() throws {
        let hpc = try Self.row("runner_at_capacity")
        XCTAssertEqual([QueuedCapacity.tag(hpc), QueuedCapacity.title(hpc)], ["runner full", "Runner full"])
        XCTAssertEqual(SessionLine.make(for: hpc, live: true).text, "Waiting for a free slot")
        let run = try Self.row("tree_at_capacity")
        XCTAssertEqual([QueuedCapacity.tag(run), QueuedCapacity.title(run)], ["run full", "Run full"])
        let batch = try Self.row("batch_at_capacity")
        XCTAssertEqual([QueuedCapacity.tag(batch), QueuedCapacity.title(batch)], ["batch full", "Batch full"])
    }

    func testTheHeldRowCarriesItsCountsThroughDecoding() throws {
        let hpc = try Self.row("runner_at_capacity")
        XCTAssertEqual(hpc.queuedHeldByJobs, 6)
        XCTAssertNil(try Self.row("runner_at_capacity", held: nil).queuedHeldByJobs)
    }

    static func sentences() throws -> [String] {
        [
            QueuedCapacity.messageText(try row("runner_at_capacity"), machine: "HPC"),
            QueuedCapacity.messageText(try row("runner_at_capacity", active: 2, limit: 2, held: 1), machine: "HPC"),
            QueuedCapacity.messageText(try row("runner_at_capacity", held: 0), machine: "HPC"),
            QueuedCapacity.messageText(try row("runner_at_capacity", held: nil), machine: "  "),
            QueuedCapacity.messageText(try row("runner_at_capacity", active: nil, limit: nil, held: nil), machine: "HPC"),
            QueuedCapacity.messageText(try row("tree_at_capacity", active: 13, limit: 13, held: nil), machine: "HPC"),
            QueuedCapacity.messageText(try row("batch_at_capacity", active: 4, limit: 4, held: nil), machine: nil),
        ]
    }

    func testThePopoverCountsTurnsAndSlotsHeldByJobsApart() throws {
        XCTAssertEqual(try Self.sentences(), [
            "HPC is using all 16 slots: 10 sessions are running a turn and 6 hold a slot with a background job. This message is sent as soon as one frees up.",
            "HPC is using all 2 slots: 1 session is running a turn and 1 holds a slot with a background job. This message is sent as soon as one frees up.",
            "HPC is running 16 of 16 sessions. This message is sent as soon as one finishes.",
            "The runner is running 16 of 16 sessions. This message is sent as soon as one finishes.",
            "HPC is using all its slots. This message is sent as soon as one frees up.",
            "This run is already using all its slots (13/13). This message is sent as soon as one of its sessions finishes.",
            "This batch is running its maximum (4/4). This message is sent as soon as one of its sessions finishes.",
        ])
    }

    func testTheWaitCountsFromWhenTheSessionWentPending() throws {
        let hpc = try Self.row("runner_at_capacity")
        let at = try XCTUnwrap(RelativeTime.parse("2026-11-14T17:14:54.436Z"))
        XCTAssertEqual(QueuedCapacity.waited(hpc, now: at.addingTimeInterval(15 * 60 + 30)), "Waiting 15 min")
        XCTAssertEqual(QueuedCapacity.waited(hpc, now: at.addingTimeInterval(20)), "Waiting less than a minute")
        XCTAssertEqual(QueuedCapacity.waited(hpc, now: at.addingTimeInterval(75 * 60)), "Waiting 1 h 15 min")
        XCTAssertNil(QueuedCapacity.waited(try Self.row("runner_at_capacity", lastTurnAt: nil), now: at))
        XCTAssertNil(QueuedCapacity.waited(hpc, now: at.addingTimeInterval(-1)))
    }

    /// The Mac row's tooltip (board session-row-runner-full): web `capacityHeldHint`'s three lines.
    func testTheRowTooltipNamesTheGateTheSlotsAndTheWait() throws {
        let hpc = try Self.row("runner_at_capacity")
        let at = try XCTUnwrap(RelativeTime.parse("2026-11-14T17:14:54.436Z"))
        XCTAssertEqual(QueuedCapacity.rowHint(hpc, machine: "HPC", now: at.addingTimeInterval(15 * 60 + 5)),
                       "Runner full\nHPC is using all 16 slots: 10 sessions are running a turn and 6 hold a slot with a background job. This message is sent as soon as one frees up.\nWaiting 15 min")
        XCTAssertNil(QueuedCapacity.rowHint(try Self.row("runner_offline"), machine: "HPC", now: at))
    }
}
