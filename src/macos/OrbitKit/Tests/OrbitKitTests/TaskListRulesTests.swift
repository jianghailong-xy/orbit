import XCTest
@testable import OrbitKit

/// The Tasks list's page rules that the phone and the browser share: which tab it opens on, which
/// tasks a scope lists, when Happening now is pinned, and what a row's second line says.
final class TaskListRulesTests: XCTestCase {

    private func task(_ json: String) -> TaskItem {
        try! JSONDecoder().decode(TaskItem.self, from: Data(json.utf8))
    }

    // MARK: the tab it opens on

    func testThePageOpensOnAllUnlessTheReaderLastPickedATab() {
        XCTAssertEqual(TaskListLogic.initialFilter(remembered: nil), .all)
        XCTAssertEqual(TaskListLogic.initialFilter(remembered: "failed"), .failed)
        // A value some older build stored, or garbage, is not a tab.
        XCTAssertEqual(TaskListLogic.initialFilter(remembered: "somewhere"), .all)
    }

    func testTheTabsRunInTheWebsOrder() {
        let overview = TaskListLogic.overview([])
        XCTAssertEqual(TaskListLogic.availableFilters(overview: overview, current: .all),
                       [.all, .ongoing, .runnable, .running, .failed, .done])
        XCTAssertEqual(TaskListLogic.availableFilters(overview: overview, current: .cancelled).last, .cancelled)
    }

    // MARK: which tasks a scope lists

    func testTheBrowsingScopesListOnlyTheTasksOutsideProjects() {
        XCTAssertEqual(TaskListLogic.projectScope(.all, creatorSessionID: nil), "none")
        XCTAssertEqual(TaskListLogic.projectScope(.unlisted, creatorSessionID: nil), "none")
    }

    // NEGATIVE CONTROL: a scope somebody picked lists its members whoever filed them.
    func testAnOpenedListAndOneConversationsTasksAreNotNarrowed() {
        XCTAssertNil(TaskListLogic.projectScope(.list("L"), creatorSessionID: nil))
        XCTAssertNil(TaskListLogic.projectScope(.all, creatorSessionID: "S"))
    }

    func testHappeningNowIsPinnedOnlyOverTheUnfilteredPage() {
        XCTAssertTrue(TaskListLogic.pinsHappeningNow(filter: .all, creatorSessionID: nil, labels: []))
        XCTAssertFalse(TaskListLogic.pinsHappeningNow(filter: .failed, creatorSessionID: nil, labels: []))
        XCTAssertFalse(TaskListLogic.pinsHappeningNow(filter: .all, creatorSessionID: "S", labels: []))
        XCTAssertFalse(TaskListLogic.pinsHappeningNow(filter: .all, creatorSessionID: nil, labels: ["release"]))
    }

    // MARK: a live update

    func testAProjectsTaskChangingDoesNotEnterTheOutsideProjectsPage() {
        let mine = task(#"{"id":"a","title":"Mine","status":"OPEN","createdAt":"2026-09-26T08:00:00.000Z"}"#)
        let shard = task(#"{"id":"b","title":"Shard","status":"OPEN","projectId":"P","createdAt":"2026-09-26T09:00:00.000Z"}"#)

        let outside = TaskPageIncrementalReducer.reduce(
            items: [mine], changed: shard, taskID: "b",
            scope: .all, filter: .all, search: "", hasMore: false, outsideProjectsOnly: true)
        XCTAssertEqual(outside.items.map(\.id), ["a"])

        // NEGATIVE CONTROL: the same event on an opened list's page does enter it.
        let listed = TaskPageIncrementalReducer.reduce(
            items: [mine], changed: shard, taskID: "b",
            scope: .all, filter: .all, search: "", hasMore: false, outsideProjectsOnly: false)
        XCTAssertEqual(listed.items.map(\.id), ["b", "a"])
    }

    func testATaskFiledIntoAProjectLeavesTheOutsideProjectsPage() {
        let before = task(#"{"id":"a","title":"Mine","status":"OPEN","createdAt":"2026-09-26T08:00:00.000Z"}"#)
        let after = task(#"{"id":"a","title":"Mine","status":"OPEN","projectId":"P","createdAt":"2026-09-26T08:00:00.000Z"}"#)

        let result = TaskPageIncrementalReducer.reduce(
            items: [before], changed: after, taskID: "a",
            scope: .all, filter: .all, search: "", hasMore: false, outsideProjectsOnly: true)
        XCTAssertEqual(result.items, [])
        XCTAssertEqual(result.filteredTotalDelta, -1)
    }

    // MARK: the header over the rest of the rows

    func testTheRestHeaderNamesTheOrder() {
        XCTAssertEqual(TaskListCopy.restHeader(sort: .created, descending: true), "Newest first")
        XCTAssertEqual(TaskListCopy.restHeader(sort: .created, descending: false), "Oldest first")
        XCTAssertEqual(TaskListCopy.restHeader(sort: .status, descending: false), "By status")
    }

    // MARK: a row's second line: one phrase, the first that is true

    private let utc = TimeZone(identifier: "UTC")!
    private let us = Locale(identifier: "en_US")

    private func phrase(_ json: String) -> TaskRowPhrase? {
        TaskListLogic.rowPhrase(task(json), timeZone: utc, locale: us)
    }

    func testWaitingOnTheOwnerOutranksEverythingElseTheRowCouldSay() {
        XCTAssertEqual(phrase(#"{"id":"a","title":"t","status":"IN_PROGRESS","awaitingOwnerConfirmation":true,"dependencyState":"BLOCKED_FAILED","runAt":"2026-09-27T07:00:00.000Z"}"#),
                       .waitingForConfirmation)
    }

    func testALockSaysWhichOfItsTwoSentences() {
        XCTAssertEqual(phrase(#"{"id":"a","title":"t","status":"OPEN","dependencyState":"BLOCKED_FAILED","runAt":"2026-09-27T07:00:00.000Z"}"#),
                       .prerequisiteCancelled)
        XCTAssertEqual(phrase(#"{"id":"a","title":"t","status":"OPEN","dependencyState":"BLOCKED"}"#),
                       .waitingForPrerequisites)
    }

    func testAScheduledStartIsNamedInTheReadersTime() {
        guard case .starts(let local)? = phrase(#"{"id":"a","title":"t","status":"OPEN","runAt":"2026-09-27T07:00:00.000Z"}"#) else {
            return XCTFail("a scheduled task says when it starts")
        }
        XCTAssertEqual(local.replacingOccurrences(of: "\u{202F}", with: " "), "Sep 27, 7:00 AM")
    }

    // NEGATIVE CONTROL: a finished task will not start, whatever its old schedule said; and a row
    // with nothing to say names its assignee (nil).
    func testAFinishedTaskOrAPlainOneNamesItsAssignee() {
        XCTAssertNil(phrase(#"{"id":"a","title":"t","status":"DONE","runAt":"2026-09-27T07:00:00.000Z"}"#))
        XCTAssertNil(phrase(#"{"id":"a","title":"t","status":"OPEN","awaitingOwnerConfirmation":false}"#))
    }

    // MARK: the time slot

    func testARunningRowCountsFromItsRunAndOtherRowsSayWhenTheyChanged() {
        let now = ISO8601DateFormatter().date(from: "2026-09-26T10:00:00Z")!
        let running = task(#"{"id":"a","title":"t","status":"IN_PROGRESS","running":true,"runningSince":"2026-09-26T09:48:00.000Z","updatedAt":"2026-09-26T08:00:00.000Z"}"#)
        XCTAssertEqual(TaskListLogic.rowTime(running, now: now), "12m")
        let idle = task(#"{"id":"a","title":"t","status":"OPEN","updatedAt":"2026-09-26T08:00:00.000Z"}"#)
        XCTAssertEqual(TaskListLogic.rowTime(idle, now: now), "2h ago")
        // An older server sends no start: the row says when it changed rather than nothing.
        let unstamped = task(#"{"id":"a","title":"t","status":"IN_PROGRESS","running":true,"updatedAt":"2026-09-26T08:00:00.000Z"}"#)
        XCTAssertEqual(TaskListLogic.rowTime(unstamped, now: now), "2h ago")
    }

    // MARK: which lists the title switcher offers

    private func list(_ json: String) -> TaskListSummary {
        try! JSONDecoder().decode(TaskListSummary.self, from: Data(json.utf8))
    }

    func testAListWhoseEveryTaskIsAProjectsIsLeftToThatProject() {
        XCTAssertTrue(TaskListLogic.isProjectOnlyList(list(#"{"id":"l","title":"FineWeb shards","tasksOutsideProjects":0,"_count":{"tasks":27468}}"#)))
        XCTAssertFalse(TaskListLogic.isProjectOnlyList(list(#"{"id":"l","title":"Mixed","tasksOutsideProjects":1,"_count":{"tasks":2}}"#)))
    }

    // NEGATIVE CONTROL: an empty list is the owner's to fill, and a server that does not say is not
    // taken to have said "all of them".
    func testAnEmptyListOrAnOlderServersListStaysOffered() {
        XCTAssertFalse(TaskListLogic.isProjectOnlyList(list(#"{"id":"l","title":"Planned","tasksOutsideProjects":0,"_count":{"tasks":0}}"#)))
        XCTAssertFalse(TaskListLogic.isProjectOnlyList(list(#"{"id":"l","title":"NCE3","_count":{"tasks":32}}"#)))
    }
}
