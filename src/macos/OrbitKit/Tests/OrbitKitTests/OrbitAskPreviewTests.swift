import XCTest
@testable import OrbitKit

/// Orbit's own approvals — a batch of new tasks, a restructure of a list's graph — carry a
/// server-computed preview. The native clients rendered the generic "Approve tool call" chrome
/// instead, so somebody was being asked to approve fifty tasks they could not see, with an
/// "Allow & remember" button that would have switched the gate off permanently.
final class OrbitAskPreviewTests: XCTestCase {

    private func json(_ s: String) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8))
    }

    // MARK: the standing grant

    func testOrbitsOwnAsksCannotBeRemembered() {
        // Every batch creates a different set of tasks and every restructure releases a different
        // set; a standing yes is the gate switched off, not a preference. Web refuses it too, and
        // the weaker client would otherwise win.
        for tool in ["orbit_task_batch", "orbit_dag_change"] {
            XCTAssertNil(Approvals.rememberRule(toolName: tool, input: json("{}")),
                         "\(tool) must not offer Allow & remember")
        }
        // An ordinary tool still can.
        XCTAssertNotNil(Approvals.rememberRule(toolName: "Read", input: json("{}")))
    }

    // MARK: batch preview

    func testBatchPreviewLeadsWithWhatActuallyStarts() {
        let p = Approvals.batchPreview(from: json("""
            {"preview":{"taskCount":50,"startingNow":2,"blocked":47,"needsManualStart":1,
                        "notDispatchable":0,"internalEdges":49,"externalEdges":0,
                        "lists":[{"title":"FineWeb"}],
                        "tasks":[{"title":"step 0"},{"title":"step 1"}],"titlesTruncated":48}}
            """))!

        XCTAssertEqual(p.taskCount, 50)
        XCTAssertEqual(p.startingNow, 2)
        XCTAssertEqual(p.edges, 49)
        XCTAssertEqual(p.lists, ["FineWeb"])
        XCTAssertEqual(p.titles, ["step 0", "step 1"])
        XCTAssertEqual(p.titlesTruncated, 48)

        let lines = Approvals.batchImpactLines(p)
        XCTAssertEqual(lines.first, "2 start running within the minute")
        XCTAssertTrue(lines.contains("47 wait on a prerequisite"))
    }

    func testABatchOfRootsPromisesNothing() {
        // The bug the real approval flow caught, in the shape a fresh DAG actually has: auto-run
        // triggers on a prerequisite finishing, so tasks with none are never picked up.
        let p = Approvals.batchPreview(from: json("""
            {"preview":{"taskCount":50,"startingNow":0,"blocked":0,"needsManualStart":50}}
            """))!

        let lines = Approvals.batchImpactLines(p)
        XCTAssertFalse(lines.contains { $0.contains("start running within the minute") })
        XCTAssertEqual(lines.first, "50 need a manual start — nothing will trigger them")
    }

    func testBatchSingularReads() {
        let p = Approvals.batchPreview(from: json("""
            {"preview":{"taskCount":1,"startingNow":1,"needsManualStart":1}}
            """))!

        let lines = Approvals.batchImpactLines(p)
        XCTAssertEqual(lines[0], "1 starts running within the minute")
        XCTAssertEqual(lines[1], "1 needs a manual start — nothing will trigger it")
    }

    // MARK: dag preview

    func testDagPreviewDescribesEdgesByTitle() {
        let p = Approvals.dagPreview(from: json("""
            {"note":"拆开并行","preview":{"listTitle":"FineWeb","becomingRunnable":0,
             "becomingManual":2,"becomingBlocked":0,"edgesBefore":312,"edgesAfter":311,
             "ops":[{"op":"remove","taskTitle":"C","dependsOnTitle":"B","noop":false},
                    {"op":"add","taskTitle":"D","dependsOnTitle":"A","noop":true}],
             "cycle":null}}
            """))!

        XCTAssertEqual(p.listTitle, "FineWeb")
        XCTAssertEqual(p.note, "拆开并行")
        XCTAssertEqual(p.ops.first?.sentence, "C no longer waits on B")
        XCTAssertEqual(p.ops.last?.sentence, "D waits on A")
        XCTAssertTrue(p.ops.last!.noop)
        // Freed is not started: nothing is left to trigger them.
        XCTAssertEqual(Approvals.dagImpactLines(p),
                       ["2 stop waiting, but now need a manual start"])
    }

    func testDagCycleIsReportedInsteadOfImpact() {
        let p = Approvals.dagPreview(from: json("""
            {"preview":{"listTitle":"L","cycle":[{"title":"A"},{"title":"B"},{"title":"A"}]}}
            """))!

        XCTAssertEqual(Approvals.dagImpactLines(p).first,
                       "Rejected: these changes would create a cycle — A → B → A")
    }

    func testDagSaysSoWhenNothingMoves() {
        let p = Approvals.dagPreview(from: json("""
            {"preview":{"listTitle":"L","becomingRunnable":0,"becomingManual":0,"becomingBlocked":0}}
            """))!

        XCTAssertEqual(Approvals.dagImpactLines(p),
                       ["No task changes state — this only rewrites edges"])
    }

    func testAnApprovalWithoutAPreviewParsesAsNil() {
        // An older runner raising the approval without one must fall back to the generic card
        // rather than rendering an empty typed one.
        XCTAssertNil(Approvals.batchPreview(from: json("{\"tasks\":[]}")))
        XCTAssertNil(Approvals.dagPreview(from: json("{\"ops\":[]}")))
    }
}
