import XCTest
@testable import OrbitKit

/// Pins the Task DTOs against the real `tasks.service` include shapes (list vs. detail) and the
/// PATCH three-state encoding. The decode JSON below is shaped exactly like what the apiserver
/// emits — so these tests catch drift between OrbitKit and the wire, not just self-consistency.
final class TasksCodableTests: XCTestCase {

    /// `GET /tasks` row: scalar columns + inlined `assignee` (with runner) + `_count` + the
    /// computed `running`/`queued`/`blocked`/`dependencyState`.
    func testListRowDecodes() throws {
        let json = """
        {
          "id":"t1","title":"Ship macOS","description":"do it","status":"IN_PROGRESS",
          "assigneeId":"a1","listId":null,"dueDate":null,"autoRunWhenReady":true,
          "creatorSessionId":null,"createdAt":"2026-06-26T00:00:00Z","updatedAt":"2026-06-26T01:00:00Z",
          "running":true,"queued":false,"blocked":false,"dependencyState":"NONE",
          "assignee":{"id":"a1","name":"wikova-develop","model":"claude-opus-4-8","runnerId":"r1",
            "runner":{"id":"r1","name":"wikova","displayName":"Wikova","maxConcurrent":8}},
          "_count":{"comments":3}
        }
        """
        let t = try JSONDecoder().decode(TaskItem.self, from: Data(json.utf8))
        XCTAssertEqual(t.id, "t1")
        XCTAssertEqual(t.status, .inProgress)
        XCTAssertEqual(t.running, true)
        XCTAssertEqual(t.blocked, false)
        XCTAssertEqual(t.assignee?.name, "wikova-develop")
        XCTAssertEqual(t.assignee?.runner?.displayName, "Wikova")
        XCTAssertEqual(t.assignee?.runner?.maxConcurrent, 8)
        XCTAssertEqual(t.commentCount, 3)   // from _count
    }

    /// `GET /tasks/:id`: adds `comments` (author-resolved), `sessions` (with agent name),
    /// `creatorSession`, and the `dependsOn`/`dependedOnBy` edges (different inner keys).
    func testDetailDecodes() throws {
        let json = """
        {
          "id":"t1","title":"Ship","status":"DONE",
          "assignee":{"id":"a1","name":"dev","model":"claude-opus-4-8"},
          "comments":[{"id":"c1","body":"hi","authorType":"USER","authorId":"u1","authorName":"Jiang","createdAt":"2026-06-26T00:00:00Z"}],
          "sessions":[{"id":"s1","title":"run","status":"SUCCEEDED","createdAt":"2026-06-26T00:00:00Z","agent":{"name":"dev"}}],
          "creatorSession":{"id":"s0","title":"orig","status":"SUCCEEDED"},
          "dependsOn":[{"dependsOnTask":{"id":"t0","title":"prep","status":"DONE"}}],
          "dependedOnBy":[{"task":{"id":"t2","title":"next","status":"OPEN"}}],
          "dependencyState":"READY"
        }
        """
        let t = try JSONDecoder().decode(TaskItem.self, from: Data(json.utf8))
        XCTAssertEqual(t.status, .done)
        XCTAssertEqual(t.comments?.first?.authorName, "Jiang")
        XCTAssertEqual(t.sessions?.first?.agent?.name, "dev")
        XCTAssertEqual(t.sessions?.first?.status, .succeeded)
        XCTAssertEqual(t.creatorSession?.title, "orig")
        XCTAssertEqual(t.dependsOn?.first?.dependsOnTask?.status, .done)   // prerequisite edge
        XCTAssertEqual(t.dependedOnBy?.first?.task?.id, "t2")             // dependent edge
        XCTAssertEqual(t.commentCount, 1)   // falls back to comments.count (no _count on detail)
    }

    /// The crux of PATCH parity: omit (keep) vs. explicit null (clear) vs. value (set). Getting
    /// this wrong silently fails to clear an assignment — exactly the bug FieldUpdate prevents.
    func testUpdateThreeStateEncoding() throws {
        let keep = try jsonObject(UpdateTaskRequest(title: "x"))
        XCTAssertEqual(keep["title"] as? String, "x")
        XCTAssertFalse(keep.keys.contains("assigneeId"))        // keep → key omitted

        let clear = try jsonObject(UpdateTaskRequest(assigneeId: .clear))
        XCTAssertTrue(clear["assigneeId"] is NSNull)            // clear → explicit null

        let set = try jsonObject(UpdateTaskRequest(assigneeId: .set("a1"), dueDate: .set("2026-07-01")))
        XCTAssertEqual(set["assigneeId"] as? String, "a1")     // set → value
        XCTAssertEqual(set["dueDate"] as? String, "2026-07-01")
        XCTAssertFalse(set.keys.contains("listId"))            // untouched stays omitted

        let status = try jsonObject(UpdateTaskRequest(status: .done))
        XCTAssertEqual(status["status"] as? String, "DONE")    // enum → wire string
    }

    /// Dependency PATCH uses replacement semantics: omitted keeps the graph, an empty array
    /// clears every prerequisite, and a populated array becomes the complete new set.
    func testUpdateDependencyReplacementEncoding() throws {
        let keep = try jsonObject(UpdateTaskRequest(title: "x"))
        XCTAssertFalse(keep.keys.contains("dependsOnTaskIds"))

        let clear = try jsonObject(UpdateTaskRequest(dependsOnTaskIds: []))
        XCTAssertEqual(clear["dependsOnTaskIds"] as? [String], [])

        let replace = try jsonObject(UpdateTaskRequest(dependsOnTaskIds: ["t0", "t1"]))
        XCTAssertEqual(replace["dependsOnTaskIds"] as? [String], ["t0", "t1"])
    }

    func testBatchAssignAlwaysSendsKey() throws {
        let set = try jsonObject(BatchAssignRequest(taskIds: ["t1"], assigneeId: "a1"))
        XCTAssertEqual(set["assigneeId"] as? String, "a1")
        let clear = try jsonObject(BatchAssignRequest(taskIds: ["t1"], assigneeId: nil))
        XCTAssertTrue(clear["assigneeId"] is NSNull)           // clear sent as null, not omitted
    }

    func testCreateEncodesOnlySetFields() throws {
        let obj = try jsonObject(CreateTaskRequest(title: "T", dependsOnTaskIds: ["t0"]))
        XCTAssertEqual(obj["title"] as? String, "T")
        XCTAssertEqual(obj["dependsOnTaskIds"] as? [String], ["t0"])
        XCTAssertFalse(obj.keys.contains("assigneeId"))
        XCTAssertFalse(obj.keys.contains("dueDate"))
    }
}

/// Encode a value and reflect it back as a JSON object so tests can assert key presence,
/// explicit nulls (`NSNull`), and values — the distinctions PATCH semantics hinge on.
func jsonObject<T: Encodable>(_ value: T) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
}
