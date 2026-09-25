import XCTest
@testable import OrbitKit

/// Pins the "Tasks created here" DTOs against what `GET /sessions/:id/created-tasks` returns
/// (`SessionCreatedTasksService.read`, typed by `@orbit/shared`'s `sessionCreatedTasks.ts`), and the
/// little the card decides from them. The JSON is shaped exactly like the apiserver's answer, so
/// these catch drift between OrbitKit and the wire, not just self-consistency.
final class SessionCreatedTasksTests: XCTestCase {

    private let taskID = "34TcwNgAIo6tGUiIKjqnQ"
    private let taskUUID = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"

    private func row(_ id: String, status: String = "OPEN", running: Bool = false,
                     queued: Bool = false,
                     replaces: SessionCreatedTasks.Named? = nil) -> SessionCreatedTaskRow {
        SessionCreatedTaskRow(id: id, title: "Task \(id)", status: status, running: running,
                              queued: queued, createdAt: "2026-09-25T02:12:44.959Z", projectId: nil,
                              replaces: replaces)
    }

    private func tasks(_ items: [SessionCreatedTaskRow], running: Int = 0) -> SessionCreatedTasks {
        SessionCreatedTasks(total: items.count, running: running, failed: 0, done: 0, items: items,
                            projects: [])
    }

    /// The whole answer: the four tallies, rows in the server's order (not re-sorted here), a row
    /// that took another task over naming it, and the projects the rows belong to.
    func testTheAnswerDecodes() throws {
        let json = """
        {
          "total":8,"running":2,"failed":1,"done":4,
          "items":[
            {"id":"34UhNfsqMZEZelvIoInhl","title":"iOS 离线空态重做","status":"FAILED",
             "running":false,"queued":false,"createdAt":"2026-09-25T02:12:44.959Z",
             "projectId":null,"replaces":null},
            {"id":"34UhNfowVchQs2JQxKV4n","title":"未登录的引擎不再探测模型目录","status":"OPEN",
             "running":true,"queued":false,"createdAt":"2026-09-25T01:12:44.959Z",
             "projectId":"34JNIW4b31ujSVqEG784v","replaces":null},
            {"id":"34UhNfkAVLmW3TwECylvR","title":"修复登录重定向循环（重跑）","status":"DONE",
             "running":false,"queued":false,"createdAt":"2026-09-24T02:12:44.959Z",
             "projectId":"34JNIW4b31ujSVqEG784v",
             "replaces":{"id":"34TcwNgAIo6tGUiIKjqnQ","title":"修复 token 过期后登录重定向循环"}}
          ],
          "projects":[{"id":"34JNIW4b31ujSVqEG784v","title":"Orbit"}]
        }
        """
        let decoded = try JSONDecoder().decode(SessionCreatedTasks.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.total, 8)
        XCTAssertEqual(decoded.running, 2)
        XCTAssertEqual(decoded.failed, 1)
        XCTAssertEqual(decoded.done, 4)
        XCTAssertEqual(decoded.items.map(\.id),
                       ["34UhNfsqMZEZelvIoInhl", "34UhNfowVchQs2JQxKV4n", "34UhNfkAVLmW3TwECylvR"])
        XCTAssertEqual(decoded.items[0].status, "FAILED")
        XCTAssertNil(decoded.items[0].projectId)
        XCTAssertNil(decoded.items[0].replaces)
        XCTAssertTrue(decoded.items[1].running)
        XCTAssertFalse(decoded.items[1].queued)
        XCTAssertEqual(decoded.items[2].replaces,
                       SessionCreatedTasks.Named(id: "34TcwNgAIo6tGUiIKjqnQ",
                                                 title: "修复 token 过期后登录重定向循环"))
        XCTAssertEqual(decoded.items[2].createdAt, "2026-09-24T02:12:44.959Z")
        XCTAssertEqual(decoded.projects, [SessionCreatedTasks.Named(id: "34JNIW4b31ujSVqEG784v",
                                                                    title: "Orbit")])
    }

    /// A session that created nothing is an answer too, not an error.
    func testAnEmptyAnswerDecodes() throws {
        let json = #"{"total":0,"running":0,"failed":0,"done":0,"items":[],"projects":[]}"#
        let decoded = try JSONDecoder().decode(SessionCreatedTasks.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.total, 0)
        XCTAssertTrue(decoded.items.isEmpty)
        XCTAssertEqual(SessionCreatedTasksCopy.line(decoded), .hidden)
    }

    /// The row's pill is the task list's: a live run outranks the lifecycle, and the lifecycle words
    /// are the ones `TaskStatusPill` draws everywhere else. A status this build has no word for is
    /// drawn under its own name rather than failing the whole card.
    func testTheRowPillIsTheTaskListsWord() {
        XCTAssertEqual(row("a", status: "OPEN", running: true).pill, TaskPill(kind: .running, label: "Running"))
        XCTAssertEqual(row("a", status: "OPEN", queued: true).pill, TaskPill(kind: .queued, label: "Queued"))
        XCTAssertEqual(row("a", status: "FAILED").pill, TaskPill(kind: .failed, label: "Failed"))
        XCTAssertEqual(row("a", status: "DONE").pill, TaskPill(kind: .done, label: "Done"))
        XCTAssertEqual(row("a", status: "IN_PROGRESS").pill, TaskPill(kind: .inProgress, label: "In progress"))
        XCTAssertEqual(row("a", status: "CANCELLED").pill, TaskPill(kind: .cancelled, label: "Cancelled"))
        XCTAssertEqual(row("a", status: "OPEN").pill, TaskPill(kind: .open, label: "Open"))
        XCTAssertEqual(row("a", status: "PARKED").pill, TaskPill(kind: .open, label: "PARKED"))

        let decoded = try? JSONDecoder().decode(
            SessionCreatedTaskRow.self,
            from: Data(#"{"id":"a","title":"T","status":"PARKED","running":false,"queued":false,"createdAt":"2026-09-25T02:12:44.959Z","projectId":null,"replaces":null}"#.utf8))
        XCTAssertEqual(decoded?.status, "PARKED", "an unknown status decodes rather than dropping the card")
    }

    /// Only a running or queued row keeps the card reading every 15 seconds; a settled card waits for
    /// the task events instead.
    func testOnlyALiveRowKeepsTheCardPolling() {
        XCTAssertFalse(tasks([row("a", status: "DONE"), row("b", status: "FAILED")]).hasLiveRows)
        XCTAssertTrue(tasks([row("a", running: true)], running: 1).hasLiveRows)
        XCTAssertTrue(tasks([row("a", queued: true)]).hasLiveRows)
        // Past `limit` a running row may not be among the items; the tally still says so.
        XCTAssertTrue(tasks([row("a", status: "DONE")], running: 1).hasLiveRows)
    }

    /// Which task ids the card draws — its rows' tasks, and the ones those rows replace — in either
    /// spelling of the id, since a push and a list row do not spell ids the same way.
    func testDrawsKnowsARowsTaskAndTheTaskItReplacesInEitherSpelling() {
        let drawn = tasks([row(taskID, status: "DONE")])
        XCTAssertTrue(drawn.draws(taskID: taskID))
        XCTAssertTrue(drawn.draws(taskID: taskUUID))
        XCTAssertTrue(drawn.draws(taskID: taskUUID.uppercased()))
        XCTAssertFalse(drawn.draws(taskID: "34TYUP5wb87XfuYCInJRY"))

        let replacing = tasks([row("34UhNfkAVLmW3TwECylvR", status: "DONE",
                                   replaces: SessionCreatedTasks.Named(id: taskID, title: "first try"))])
        XCTAssertTrue(replacing.draws(taskID: taskUUID))
        XCTAssertTrue(replacing.draws(taskID: "34UhNfkAVLmW3TwECylvR"))
        XCTAssertFalse(tasks([]).draws(taskID: taskID))
    }
}
