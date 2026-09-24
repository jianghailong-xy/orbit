import XCTest
@testable import OrbitKit

/// The three plan reads decode from what the server sends — shapes copied from a live project.
final class ProjectPlanCodableTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func testTheProjectDocumentCarriesItsBlockersAndItsTallyByStatus() throws {
        let document = try decode(ProjectDocument.self, """
        {"id":"34B3oMDNcPv6okwPtIy3d","title":"iOS 客户端性能与内存优化","status":"OPEN",
         "_count":{"tasks":13},"tasksByStatus":{"OPEN":7,"DONE":5,"CANCELLED":1},
         "blockers":{"open":[{"id":"ujX6C3fsCGpbDw7xL5eLc","kind":"WHO_NOT_IN_TEAM","owner":"USER",
            "severity":"CRITICAL","requiredAction":"Add the assigned agent to this project team, or reassign the task.",
            "subjectType":"TASK","subjectId":"34B3thqT6yN8r9m4ONAW9","subjectTitle":"合并 TasksView 的两个独立轮询循环",
            "criterionOrdinal":null,"criterionRevision":null,
            "detail":{"taskId":"34B3thqT6yN8r9m4ONAW9","refusalCode":"WHO_NOT_IN_TEAM"},
            "firstSeenAt":"2026-08-21T17:20:23.000Z","resolvedAt":null,"resolvedBy":null,"resolutionNote":null}],
          "resolved":[{"id":"9sHnMFfIugQBinm6u8c58","kind":"WHO_NOT_IN_TEAM","owner":"USER","requiredAction":"x",
            "detail":{"paths":["src/a.ts",3]},"resolvedAt":"2026-08-23T14:44:11.558Z","resolvedBy":"AUTO"}],
          "resolvedCount":4}}
        """)
        XCTAssertEqual(document.tasksByStatus?["OPEN"], 7)
        let blockers = try XCTUnwrap(document.blockers)
        XCTAssertEqual(blockers.open.count, 1)
        XCTAssertEqual(blockers.open[0].subjectTitle, "合并 TasksView 的两个独立轮询循环")
        XCTAssertNil(blockers.open[0].detail.reason)
        XCTAssertEqual(blockers.resolvedCount, 4)
        XCTAssertEqual(blockers.resolved[0].detail.paths, [], "a malformed file list reads as none, not as a failure")

        let older = try decode(ProjectDocument.self, #"{"id":"p","title":"t"}"#)
        XCTAssertNil(older.blockers)
        XCTAssertNil(older.tasksByStatus, "absent is not zero")
    }

    func testTheRunQueueDecodesAndReadsAnUnknownStateAsReady() throws {
        let queue = try decode(ProjectReadyToRun.self, """
        {"readyCount":7,"queuedCount":0,"runningCount":0,"pausedCount":1,"impactTruncated":null,
         "items":[{"taskId":"a","title":"图片缩略图降采样","status":"OPEN","runState":"READY","sessionId":null,
                   "pausedList":null,"downstreamBlocked":0},
                  {"taskId":"b","title":"B","status":"OPEN","runState":"PAUSED","sessionId":null,
                   "pausedList":{"id":"l","title":"Backlog","readyCount":2,"autoRunReadyCount":0},"downstreamBlocked":null},
                  {"taskId":"c","title":"C","status":"OPEN","runState":"SOMETHING_NEW"}]}
        """)
        XCTAssertEqual(queue.readyCount, 7)
        XCTAssertEqual(queue.items.map(\.runState), [.ready, .paused, .ready])
        XCTAssertEqual(queue.items[1].pausedList?.title, "Backlog")
        XCTAssertNil(queue.items[1].downstreamBlocked)
    }

    func testTheDependencyGraphDecodesItsMarksEdgesAndLimit() throws {
        let graph = try decode(ProjectDependencyGraph.self, """
        {"marks":[{"kind":"TASK","id":"a","taskId":"a","title":"A","status":"DONE","parentTaskId":null,
                   "workState":"DONE","verificationState":null,"running":false,"queued":false},
                  {"kind":"RUN","id":"run:1","title":"3 steps","taskCount":3,"statusCounts":{"OPEN":3},
                   "parentTaskId":null,"expandable":true,
                   "members":[{"taskId":"s1","title":"one","status":"OPEN","running":true}]},
                  {"kind":"LATER","id":"x","title":"X"}],
         "edges":[{"sourceMarkId":"a","targetMarkId":"run:1"}],
         "taskCount":5,"folded":true,"truncated":true,"limits":{"maxTasks":500,"maxMarks":300}}
        """)
        XCTAssertEqual(graph.marks.map(\.kind), [.task, .run, .unknown])
        XCTAssertEqual(graph.marks[1].members.first?.running, true)
        XCTAssertEqual(graph.marks[1].statusCounts["OPEN"], 3)
        XCTAssertEqual(graph.edges, [ProjectGraphEdge(sourceMarkId: "a", targetMarkId: "run:1")])
        XCTAssertEqual(graph.taskCount, 5)
        XCTAssertTrue(graph.truncated)
        XCTAssertEqual(graph.maxTasks, 500)
    }

    func testTheResumeWriteLiftsThePauseAndSaysWhere() throws {
        let body = try JSONEncoder().encode(ResumeTaskListRequest(note: ProjectPage.resumeListNote))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["paused"] as? Bool, false)
        XCTAssertEqual(object["note"] as? String, "Resumed from the project Run queue")
    }
}
