import XCTest
@testable import OrbitKit

final class TaskListLogicTests: XCTestCase {

    private func task(_ json: String) -> TaskItem {
        try! JSONDecoder().decode(TaskItem.self, from: Data(json.utf8))
    }

    func testFilterMatches() {
        XCTAssertTrue(TaskFilter.ongoing.matches(task(#"{"id":"1","title":"a","status":"OPEN"}"#)))
        XCTAssertTrue(TaskFilter.ongoing.matches(task(#"{"id":"1","title":"a","status":"IN_PROGRESS"}"#)))
        XCTAssertFalse(TaskFilter.ongoing.matches(task(#"{"id":"1","title":"a","status":"DONE"}"#)))
        XCTAssertTrue(TaskFilter.failed.matches(task(#"{"id":"1","title":"a","status":"FAILED"}"#)))
        XCTAssertTrue(TaskFilter.all.matches(task(#"{"id":"1","title":"a","status":"CANCELLED"}"#)))
    }

    func testReadyUsesTheSameRunnablePredicateAsWebAndServer() {
        let ready = task(#"{"id":"1","title":"a","status":"OPEN","assignee":{"id":"a","runner":{"id":"r"}}}"#)
        let done = task(#"{"id":"2","title":"a","status":"DONE","assignee":{"id":"a","runner":{"id":"r"}}}"#)
        let unassigned = task(#"{"id":"3","title":"a","status":"OPEN"}"#)
        let noRunner = task(#"{"id":"4","title":"a","status":"OPEN","assignee":{"id":"a"}}"#)
        let running = task(#"{"id":"5","title":"a","status":"OPEN","running":true,"assignee":{"id":"a","runner":{"id":"r"}}}"#)
        let queued = task(#"{"id":"6","title":"a","status":"OPEN","queued":true,"assignee":{"id":"a","runner":{"id":"r"}}}"#)
        let blocked = task(#"{"id":"7","title":"a","status":"OPEN","dependencyState":"BLOCKED","assignee":{"id":"a","runner":{"id":"r"}}}"#)
        let failed = task(#"{"id":"8","title":"a","status":"FAILED","assignee":{"id":"a","runner":{"id":"r"}}}"#)
        let cancelled = task(#"{"id":"9","title":"a","status":"CANCELLED","assignee":{"id":"a","runner":{"id":"r"}}}"#)

        XCTAssertTrue(TaskListLogic.canStart(ready))
        for item in [done, unassigned, noRunner, running, queued, blocked] {
            XCTAssertFalse(TaskListLogic.canStart(item), "\(item.id) must not be runnable")
        }
        XCTAssertTrue(TaskListLogic.canStart(failed), "failed tasks can be retried")
        XCTAssertTrue(TaskListLogic.canStart(cancelled), "cancelled tasks can be retried")
        XCTAssertEqual(TaskListLogic.filtered([ready, done, failed], .runnable).map(\.id), ["1", "8"])
    }

    func testDetailDerivesBusyAndBlockedFromSessionsAndDependencyState() {
        let pending = task(#"{"id":"1","title":"a","status":"OPEN","sessions":[{"id":"s","status":"PENDING"}]}"#)
        let running = task(#"{"id":"2","title":"a","status":"OPEN","sessions":[{"id":"s","status":"RUNNING"}]}"#)
        let waiting = task(#"{"id":"3","title":"a","status":"OPEN","sessions":[{"id":"s","status":"AWAITING_INPUT"}]}"#)
        let blockedFailed = task(#"{"id":"4","title":"a","status":"OPEN","dependencyState":"BLOCKED_FAILED"}"#)

        XCTAssertTrue(TaskListLogic.isQueued(pending))
        XCTAssertTrue(TaskListLogic.isRunning(running))
        XCTAssertFalse(TaskListLogic.isBusy(waiting), "awaiting input is resumable, not task execution busy")
        XCTAssertTrue(TaskListLogic.isBlocked(blockedFailed))
        XCTAssertEqual(TaskListLogic.pill(pending).kind, .queued)
        XCTAssertEqual(TaskListLogic.pill(running).kind, .running)
    }

    func testScopeFiltering() {
        let unlisted = task(#"{"id":"1","title":"a","status":"OPEN"}"#)
        let listed = task(#"{"id":"2","title":"b","status":"OPEN","listId":"l1"}"#)
        XCTAssertEqual(TaskListLogic.scoped([unlisted, listed], to: .unlisted).map(\.id), ["1"])
        XCTAssertEqual(TaskListLogic.scoped([unlisted, listed], to: .list("l1")).map(\.id), ["2"])
    }

    /// running outranks queued outranks any lifecycle status; a running DONE task still sorts
    /// above an OPEN one — the live overlay wins.
    func testStatusRankOrder() {
        let running = task(#"{"id":"1","title":"r","status":"DONE","running":true}"#)
        let queued  = task(#"{"id":"2","title":"q","status":"OPEN","queued":true}"#)
        let prog    = task(#"{"id":"3","title":"p","status":"IN_PROGRESS"}"#)
        let open    = task(#"{"id":"4","title":"o","status":"OPEN"}"#)
        let done    = task(#"{"id":"5","title":"d","status":"DONE"}"#)
        XCTAssertLessThan(TaskListLogic.statusRank(running), TaskListLogic.statusRank(queued))
        XCTAssertLessThan(TaskListLogic.statusRank(queued), TaskListLogic.statusRank(prog))
        XCTAssertLessThan(TaskListLogic.statusRank(prog), TaskListLogic.statusRank(open))
        XCTAssertLessThan(TaskListLogic.statusRank(open), TaskListLogic.statusRank(done))
    }

    func testSortByStatusPutsLiveFirst() {
        let items = [
            task(#"{"id":"1","title":"done","status":"DONE"}"#),
            task(#"{"id":"2","title":"run","status":"OPEN","running":true}"#),
            task(#"{"id":"3","title":"open","status":"OPEN"}"#),
        ]
        let sorted = TaskListLogic.sorted(items, by: .status, descending: false)
        // running(rank 0) first; then OPEN(rank 4) before DONE(rank 5).
        XCTAssertEqual(sorted.map(\.id), ["2", "3", "1"])
    }

    func testTitleSortIsNumeric() {
        let items = [
            task(#"{"id":"1","title":"Unit 73","status":"OPEN"}"#),
            task(#"{"id":"2","title":"Unit 9","status":"OPEN"}"#),
        ]
        let sorted = TaskListLogic.sorted(items, by: .title, descending: false)
        XCTAssertEqual(sorted.map(\.title), ["Unit 9", "Unit 73"])   // 9 before 73, not lexicographic
    }

    func testFilteredAllIsIdentity() {
        let items = [task(#"{"id":"1","title":"a","status":"DONE"}"#)]
        XCTAssertEqual(TaskListLogic.filtered(items, .all).count, 1)
        XCTAssertEqual(TaskListLogic.filtered(items, .ongoing).count, 0)
    }

    func testPillOverlayWinsOverLifecycle() {
        XCTAssertEqual(TaskListLogic.pill(task(#"{"id":"1","title":"a","status":"DONE","running":true}"#)).kind, .running)
        XCTAssertEqual(TaskListLogic.pill(task(#"{"id":"1","title":"a","status":"OPEN","queued":true}"#)).kind, .queued)
        XCTAssertEqual(TaskListLogic.pill(task(#"{"id":"1","title":"a","status":"IN_PROGRESS"}"#)).kind, .inProgress)
        XCTAssertEqual(TaskListLogic.pill(task(#"{"id":"1","title":"a","status":"FAILED"}"#)).label, "Failed")
    }
}
