import XCTest
@testable import OrbitKit

final class CoalescedRefreshQueueTests: XCTestCase {
    private enum Target: Hashable, Sendable {
        case agents
        case tasks
    }

    func testBurstDeduplicatesWorkAndOnlyFirstEnqueueStartsTheWorker() {
        var queue = CoalescedRefreshQueue<Target, String>()

        XCTAssertTrue(queue.enqueueChanged("task-1", for: .tasks))
        XCTAssertFalse(queue.enqueueChanged("task-1", for: .tasks))
        XCTAssertFalse(queue.enqueueChanged("task-2", for: .tasks))
        XCTAssertFalse(queue.enqueueFull(.agents))
        XCTAssertFalse(queue.enqueueFull(.agents))

        let pass = queue.take()
        XCTAssertEqual(pass.fullTargets, [.agents])
        XCTAssertEqual(pass.changedIDs(for: .tasks), ["task-1", "task-2"])
        XCTAssertTrue(pass.changedIDs(for: .agents).isEmpty)
        XCTAssertFalse(pass.isEmpty)
        XCTAssertFalse(queue.finishPass())

        XCTAssertTrue(queue.enqueueChanged("task-3", for: .tasks),
                      "finishing the last pass must return the queue to idle")
    }

    func testAnEnqueueDuringAFlightRequiresATrailingPassWithoutStartingAnotherWorker() {
        var queue = CoalescedRefreshQueue<Target, String>()
        XCTAssertTrue(queue.enqueueChanged("task-1", for: .tasks))
        XCTAssertEqual(queue.take().changedIDs(for: .tasks), ["task-1"])

        XCTAssertFalse(queue.enqueueChanged("task-2", for: .tasks))
        XCTAssertTrue(queue.finishPass())

        let trailing = queue.take()
        XCTAssertEqual(trailing.changedIDs(for: .tasks), ["task-2"])
        XCTAssertFalse(queue.finishPass())
    }

    func testFullRefreshOnlySubsumesIDsForItsTargetThatWerePendingAtTake() {
        var queue = CoalescedRefreshQueue<Target, String>()
        XCTAssertTrue(queue.enqueueChanged("task-before", for: .tasks))
        XCTAssertFalse(queue.enqueueChanged("agent-before", for: .agents))
        XCTAssertFalse(queue.enqueueFull(.tasks))

        let fullPass = queue.take()
        XCTAssertEqual(fullPass.fullTargets, [.tasks])
        XCTAssertTrue(fullPass.changedIDs(for: .tasks).isEmpty,
                      "the full task snapshot subsumes IDs already pending for tasks")
        XCTAssertEqual(fullPass.changedIDs(for: .agents), ["agent-before"],
                       "a full task snapshot must not swallow another target's IDs")

        XCTAssertFalse(queue.enqueueChanged("task-after", for: .tasks))
        XCTAssertTrue(queue.finishPass(), "an ID arriving after take must survive the full pass")
        XCTAssertEqual(queue.take().changedIDs(for: .tasks), ["task-after"])
        XCTAssertFalse(queue.finishPass())
    }

    func testEventsBetweenFinishAndTrailingTakeAreNotLost() {
        var queue = CoalescedRefreshQueue<Target, String>()
        XCTAssertTrue(queue.enqueueFull(.tasks))
        XCTAssertEqual(queue.take().fullTargets, [.tasks])

        XCTAssertFalse(queue.enqueueChanged("task-1", for: .tasks))
        XCTAssertTrue(queue.finishPass())
        XCTAssertFalse(queue.enqueueChanged("task-2", for: .tasks),
                       "the original worker still owns the trailing pass")

        let trailing = queue.take()
        XCTAssertEqual(trailing.changedIDs(for: .tasks), ["task-1", "task-2"])
        XCTAssertFalse(queue.finishPass())
    }
}
