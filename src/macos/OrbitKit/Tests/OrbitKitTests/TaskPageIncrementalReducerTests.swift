import XCTest
@testable import OrbitKit

final class TaskPageIncrementalReducerTests: XCTestCase {
    private func task(_ id: String,
                      title: String = "Task",
                      status: String = "OPEN",
                      createdAt: String,
                      listID: String? = nil,
                      runnable: Bool = false,
                      creatorSessionID: String? = nil) -> TaskItem {
        let list = listID.map { ",\"listId\":\"\($0)\"" } ?? ""
        let assignee = runnable
            ? ",\"assignee\":{\"id\":\"agent\",\"runner\":{\"id\":\"runner\"}}"
            : ""
        let creator = creatorSessionID.map { ",\"creatorSessionId\":\"\($0)\"" } ?? ""
        let json = "{\"id\":\"\(id)\",\"title\":\"\(title)\",\"status\":\"\(status)\"," +
            "\"createdAt\":\"\(createdAt)\"\(list)\(assignee)\(creator)}"
        return try! JSONDecoder().decode(TaskItem.self, from: Data(json.utf8))
    }

    private let newest = "2026-08-25T12:00:00.000Z"
    private let middle = "2026-08-25T11:00:00.000Z"
    private let oldest = "2026-08-25T10:00:00.000Z"

    func testMatchingLoadedRowIsReplacedAndServerOrderIsPreserved() {
        let old = task("a", title: "Old", createdAt: middle)
        let first = task("z", createdAt: newest)
        let changed = task("a", title: "Updated", createdAt: middle)

        let result = TaskPageIncrementalReducer.reduce(
            items: [old, first], changed: changed, taskID: "a",
            scope: .all, filter: .all, search: "", hasMore: false
        )

        XCTAssertEqual(result.items.map(\.id), ["z", "a"])
        XCTAssertEqual(result.items.last?.title, "Updated")
        XCTAssertEqual(result.filteredTotalDelta, 0)
        XCTAssertFalse(result.needsPageReconcile)
    }

    func testLoadedRowLeavingTheFilterIsRemoved() {
        let old = task("a", status: "OPEN", createdAt: newest)
        let changed = task("a", status: "DONE", createdAt: newest)

        let result = TaskPageIncrementalReducer.reduce(
            items: [old], changed: changed, taskID: "a",
            scope: .all, filter: .ongoing, search: "", hasMore: true
        )

        XCTAssertTrue(result.items.isEmpty)
        XCTAssertEqual(result.filteredTotalDelta, -1)
    }

    func testAuthoritative404RemovesALoadedRow() {
        let result = TaskPageIncrementalReducer.reduce(
            items: [task("a", createdAt: newest), task("b", createdAt: middle)],
            changed: nil, taskID: "a", scope: .all, filter: .all, search: "", hasMore: true
        )

        XCTAssertEqual(result.items.map(\.id), ["b"])
        XCTAssertEqual(result.filteredTotalDelta, -1)
    }

    func testMissingRowEnteringACompleteFilteredScopeIsInserted() {
        let listID = "11111111-1111-1111-1111-111111111111"
        let changed = task("b", title: "Needle task", status: "OPEN", createdAt: middle,
                           listID: listID, runnable: true)
        let result = TaskPageIncrementalReducer.reduce(
            items: [task("a", title: "Needle first", createdAt: newest,
                         listID: listID, runnable: true)],
            changed: changed, taskID: "b", scope: .list(listID), filter: .runnable,
            search: "  needle  ", hasMore: false
        )

        XCTAssertEqual(result.items.map(\.id), ["a", "b"])
        XCTAssertEqual(result.filteredTotalDelta, 1)
    }

    /// A page scoped to one session's created tasks ("View all in Tasks ›") takes a changed row only
    /// when that session created it — in either spelling of the session's id — and lets go of a
    /// loaded row the moment the server says it is somebody else's.
    func testCreatorSessionScopeDecidesMembership() {
        let sessionID = "34TYUP5wb87XfuYCInJRY"
        let sessionUUID = "01a0cc01-771c-767d-846b-8fddfa669490"
        let mine = task("a", createdAt: middle, creatorSessionID: sessionUUID)
        let inserted = TaskPageIncrementalReducer.reduce(
            items: [task("z", createdAt: newest, creatorSessionID: sessionID)],
            changed: mine, taskID: "a", scope: .all, filter: .all, search: "", hasMore: false,
            creatorSessionID: sessionID
        )
        XCTAssertEqual(inserted.items.map(\.id), ["z", "a"])
        XCTAssertEqual(inserted.filteredTotalDelta, 1)

        let elsewhere = task("b", createdAt: newest, creatorSessionID: "34TcwNgAIo6tGUiIKjqnQ")
        let kept = TaskPageIncrementalReducer.reduce(
            items: [mine], changed: elsewhere, taskID: "b", scope: .all, filter: .all, search: "",
            hasMore: false, creatorSessionID: sessionID
        )
        XCTAssertEqual(kept.items.map(\.id), ["a"], "another session's task is not on this page")
        XCTAssertEqual(kept.filteredTotalDelta, 0)

        let unattributed = TaskPageIncrementalReducer.reduce(
            items: [mine], changed: task("a", createdAt: middle), taskID: "a", scope: .all,
            filter: .all, search: "", hasMore: false, creatorSessionID: sessionID
        )
        XCTAssertTrue(unattributed.items.isEmpty, "a row no session created leaves the page")
        XCTAssertEqual(unattributed.filteredTotalDelta, -1)

        // Unscoped, the creator is nobody's business: the same row belongs.
        let unscoped = TaskPageIncrementalReducer.reduce(
            items: [], changed: elsewhere, taskID: "b", scope: .all, filter: .all, search: "",
            hasMore: false
        )
        XCTAssertEqual(unscoped.items.map(\.id), ["b"])
    }

    func testMissingOlderRowIsNotInsertedPastAPaginatedTail() {
        let current = [
            task("a", createdAt: newest),
            task("b", createdAt: middle),
        ]
        let changed = task("c", createdAt: oldest)

        let result = TaskPageIncrementalReducer.reduce(
            items: current, changed: changed, taskID: "c",
            scope: .all, filter: .all, search: "", hasMore: true
        )

        XCTAssertEqual(result.items, current)
        XCTAssertNil(result.filteredTotalDelta)
        XCTAssertFalse(result.needsPageReconcile)
    }

    func testMissingNewerRowBeforePaginatedTailRequestsRowsOnlyPageReconcile() {
        let current = [
            task("b", createdAt: middle),
            task("c", createdAt: oldest),
        ]
        let changed = task("a", createdAt: newest)

        let result = TaskPageIncrementalReducer.reduce(
            items: current, changed: changed, taskID: "a",
            scope: .all, filter: .all, search: "", hasMore: true
        )

        XCTAssertEqual(result.items, current, "the opaque old cursor must remain paired with its window")
        XCTAssertNil(result.filteredTotalDelta)
        XCTAssertTrue(result.needsPageReconcile,
                      "the caller needs one rows-only page to obtain the new bounded cursor")
    }
}
