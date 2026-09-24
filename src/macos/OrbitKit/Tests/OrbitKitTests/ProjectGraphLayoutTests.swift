import XCTest
@testable import OrbitKit

/// The project's dependency picture: the web's folds and words, and a layout that fits a phone.
final class ProjectGraphLayoutTests: XCTestCase {

    // The shape of a real project: one finished baseline task four finished tasks and seven open or
    // cancelled ones hang off, and one task nothing is linked to.
    private let baseline = ProjectGraphMark.task(id: "t00", title: "Baseline", status: "DONE", workState: "DONE")
    private func done(_ id: String) -> ProjectGraphMark {
        .task(id: id, title: "Done \(id)", status: "DONE", workState: "DONE")
    }
    private func ready(_ id: String) -> ProjectGraphMark {
        .task(id: id, title: "Ready \(id)", status: "OPEN", workState: "READY")
    }
    private func edge(_ a: String, _ b: String) -> ProjectGraphEdge {
        ProjectGraphEdge(sourceMarkId: a, targetMarkId: b)
    }

    private var realShape: ProjectDependencyGraph {
        let doneIDs = ["t01", "t02", "t03", "t04"]
        let readyIDs = ["t05", "t06", "t07", "t08", "t09", "t10"]
        let cancelled = ProjectGraphMark.task(id: "t11", title: "Bound seen", status: "CANCELLED", workState: "CANCELLED")
        let loose = ready("t12")
        let marks = [baseline] + doneIDs.map(done) + readyIDs.map(ready) + [cancelled, loose]
        let edges = (doneIDs + readyIDs + ["t11"]).map { edge("t00", $0) } + [edge("t01", "t06")]
        return ProjectDependencyGraph(marks: marks, edges: edges, taskCount: 13)
    }

    // MARK: folding

    func testAConnectedBlockOfFinishedWorkFoldsIntoOneMark() {
        let folded = ProjectGraph.prepare(realShape, expanded: [])
        let fold = try? XCTUnwrap(folded.marks.first { $0.kind == .settled })
        XCTAssertEqual(fold?.title, "5 done")
        XCTAssertEqual(fold?.taskCount, 5)
        XCTAssertEqual(fold?.id, "settled:t00", "named after its smallest member, so it keeps its id")
        XCTAssertEqual(folded.marks.count, 9, "one fold, six ready, the cancelled task, the loose one")
        XCTAssertFalse(folded.marks.contains { $0.id == "t11" && $0.kind != .task })
        let fromFold = folded.edges.filter { $0.sourceMarkId == "settled:t00" }.map(\.targetMarkId)
        XCTAssertEqual(Set(fromFold), ["t05", "t06", "t07", "t08", "t09", "t10", "t11"],
                       "two edges into t06 collapse into one from the fold")
        XCTAssertEqual(fromFold.count, 7)
    }

    func testAFoldTheReaderOpenedIsDrawnInFull() {
        let opened = ProjectGraph.prepare(realShape, expanded: ["settled:t00"])
        XCTAssertFalse(opened.marks.contains { $0.kind == .settled })
        XCTAssertEqual(opened.marks.count, 13)
    }

    func testOneFinishedTaskOrTwoUnderDifferentParentsAreNotFolded() {
        let lone = ProjectGraph.foldSettled(marks: [done("a"), ready("b")], edges: [edge("a", "b")], expanded: [])
        XCTAssertEqual(lone.marks.map(\.id), ["a", "b"])
        let a = ProjectGraphMark.task(id: "a", title: "a", status: "DONE", parentTaskId: "p1")
        let b = ProjectGraphMark.task(id: "b", title: "b", status: "DONE", parentTaskId: "p2")
        let split = ProjectGraph.foldSettled(marks: [a, b], edges: [edge("a", "b")], expanded: [])
        XCTAssertEqual(split.marks.map(\.id), ["a", "b"])
    }

    func testAnOpenedRunIsItsStepsInOrderWithItsEdgesMovedOntoThem() {
        let run = ProjectGraphMark(kind: .run, id: "run:1", title: "3 steps", taskCount: 3,
                                   statusCounts: ["OPEN": 3],
                                   members: [.init(taskId: "s1", title: "one", status: "OPEN"),
                                             .init(taskId: "s2", title: "two", status: "OPEN"),
                                             .init(taskId: "s3", title: "three", status: "OPEN")],
                                   expandable: true)
        let graph = ProjectDependencyGraph(marks: [ready("a"), run, ready("z")],
                                           edges: [edge("a", "run:1"), edge("run:1", "z")])
        XCTAssertEqual(ProjectGraph.prepare(graph, expanded: []).marks.map(\.id), ["a", "run:1", "z"])
        let opened = ProjectGraph.prepare(graph, expanded: ["run:1"])
        XCTAssertEqual(opened.marks.map(\.id), ["a", "s1", "s2", "s3", "z"])
        XCTAssertEqual(Set(opened.edges), [edge("a", "s1"), edge("s3", "z"), edge("s1", "s2"), edge("s2", "s3")])
        XCTAssertTrue(ProjectGraph.canOpen(run))
    }

    // MARK: words

    func testTheSummarySaysHowBigHowFarAndWhatCanStart() {
        let folded = ProjectGraph.prepare(realShape, expanded: [])
        XCTAssertEqual(ProjectGraph.summary(taskCount: 13, marks: folded.marks),
                       "13 tasks · 7 ready to run · 5 done · dashed marks are folded")
        let open = ProjectGraph.prepare(realShape, expanded: ["settled:t00"])
        XCTAssertEqual(ProjectGraph.summary(taskCount: 13, marks: open.marks), "13 tasks · 7 ready to run · 5 done")
    }

    func testEachMarkSaysTheOneThingWorthReadingAboutIt() {
        XCTAssertEqual(ProjectGraph.meta(of: ready("a"), waitingOn: 0), "Ready to run")
        let blocked = ProjectGraphMark.task(id: "b", title: "b", status: "OPEN", workState: "BLOCKED")
        XCTAssertEqual(ProjectGraph.meta(of: blocked, waitingOn: 2), "Waiting on 2")
        XCTAssertEqual(ProjectGraph.meta(of: blocked, waitingOn: 0), "Blocked")
        let cancelled = ProjectGraphMark.task(id: "c", title: "c", status: "CANCELLED")
        XCTAssertEqual(ProjectGraph.meta(of: cancelled, waitingOn: 0), "Cancelled")
        XCTAssertEqual(ProjectGraph.tone(of: cancelled), .failed)
        let running = ProjectGraphMark.task(id: "r", title: "r", status: "OPEN", workState: "RUNNING", running: true)
        XCTAssertEqual(ProjectGraph.meta(of: running, waitingOn: 0), "Running")
        let verifying = ProjectGraphMark.task(id: "v", title: "v", status: "OPEN", workState: "AWAITING_VERIFICATION",
                                              verificationState: "RUNNING")
        XCTAssertEqual(ProjectGraph.meta(of: verifying, waitingOn: 0), "Awaiting verification · verifier running")
    }

    func testAFoldSaysWhatItHoldsAndSettledWorkSaysOnlyThatItIsFinished() throws {
        let folded = ProjectGraph.prepare(realShape, expanded: [])
        let fold = try XCTUnwrap(folded.marks.first { $0.kind == .settled })
        XCTAssertEqual(ProjectGraph.foldTitle(fold), "5 done")
        XCTAssertEqual(ProjectGraph.foldLegend(fold), "Finished · tap to open")
        XCTAssertEqual(ProjectGraph.state(of: fold), .complete)
        let motif = ProjectGraphMark(kind: .motif, id: "m", title: "Review", taskCount: 6,
                                     statusCounts: ["DONE": 4, "FAILED": 1, "OPEN": 1])
        XCTAssertEqual(ProjectGraph.foldLegend(motif), "4 done · 1 failed · 1 open")
        XCTAssertEqual(ProjectGraph.state(of: motif), .failed, "a fold is as done as its least done task")
        XCTAssertFalse(ProjectGraph.canOpen(motif))
    }

    func testWaitingCountsOnlyPrerequisitesThatHaveNotReleasedTheTask() {
        let marks = [done("a"), ready("b"), ProjectGraphMark.task(id: "c", title: "c", status: "OPEN", workState: "BLOCKED")]
        let waiting = ProjectGraph.waitingOn(marks: marks, edges: [edge("a", "c"), edge("b", "c")])
        XCTAssertEqual(waiting["c"], 1)
    }

    // MARK: layout

    private func assertNoOverlap(_ layout: ProjectGraph.Layout, file: StaticString = #filePath, line: UInt = #line) {
        let boxes = layout.placements.map(\.box)
        for (i, a) in boxes.enumerated() {
            for b in boxes[(i + 1)...] {
                let apart = a.maxX <= b.x || b.maxX <= a.x || a.maxY <= b.y || b.maxY <= a.y
                XCTAssertTrue(apart, "\(a) overlaps \(b)", file: file, line: line)
            }
        }
    }

    func testAWideShallowPlanReadsLeftToRightInOneScreenWidth() throws {
        let folded = ProjectGraph.prepare(realShape, expanded: [])
        let layout = ProjectGraph.layout(marks: folded.marks, edges: folded.edges, availableWidth: 361)
        XCTAssertEqual(layout.direction, .leftToRight)
        XCTAssertLessThanOrEqual(layout.width, 361, "the whole plan at full size on a phone")
        XCTAssertEqual(layout.fit(width: 361), 1)
        assertNoOverlap(layout)
        let fold = try XCTUnwrap(layout.placements.first { $0.mark.kind == .settled }?.box)
        let dependents = layout.placements.filter { ["t05", "t06", "t07", "t08", "t09", "t10", "t11"].contains($0.id) }
        XCTAssertEqual(dependents.count, 7)
        XCTAssertTrue(dependents.allSatisfy { $0.box.x > fold.maxX }, "prerequisite on the left, dependents right")
        let loose = try XCTUnwrap(layout.placements.first { $0.id == "t12" }?.box)
        XCTAssertTrue(dependents.allSatisfy { $0.box.maxY < loose.y }, "the unlinked task is set out after the plan")
        XCTAssertEqual(layout.routes.count, 7)
        for route in layout.routes {
            let target = try XCTUnwrap(layout.placements.first { $0.id == route.target }?.box)
            XCTAssertEqual(route.points.first?.x, fold.maxX)
            XCTAssertEqual(route.points.last?.x, target.x)
            XCTAssertEqual(route.points.last?.y, target.midY)
        }
    }

    func testADeepChainReadsTopToBottom() {
        let ids = (0..<6).map { "c\($0)" }
        let marks = ids.map(ready)
        let edges = zip(ids, ids.dropFirst()).map { edge($0, $1) }
        let layout = ProjectGraph.layout(marks: marks, edges: edges, availableWidth: 361)
        XCTAssertEqual(layout.direction, .topToBottom)
        XCTAssertLessThanOrEqual(layout.width, 361)
        let ys = layout.placements.map(\.box.y)
        XCTAssertEqual(ys, ys.sorted(), "each step below the one before it")
        assertNoOverlap(layout)
    }

    func testAnEdgeThatSkipsARankPassesThroughASlotOfItsOwn() throws {
        let marks = [ready("a"), ready("b"), ready("c")]
        let layout = ProjectGraph.layout(marks: marks, edges: [edge("a", "b"), edge("b", "c"), edge("a", "c")],
                                         direction: .leftToRight, availableWidth: 800)
        let middle = try XCTUnwrap(layout.placements.first { $0.id == "b" }?.box)
        let long = try XCTUnwrap(layout.routes.first { $0.source == "a" && $0.target == "c" })
        // No segment of the long edge runs through the middle mark.
        for (p, q) in zip(long.points, long.points.dropFirst()) {
            let minX = min(p.x, q.x), maxX = max(p.x, q.x), minY = min(p.y, q.y), maxY = max(p.y, q.y)
            let crosses = minX < middle.maxX && maxX > middle.x && minY < middle.maxY && maxY > middle.y
            XCTAssertFalse(crosses, "segment \(p)→\(q) runs through \(middle)")
        }
        assertNoOverlap(layout)
    }

    func testMarksWithNoEdgesAtAllAreSetOutInRows() {
        let marks = (0..<5).map { ready("m\($0)") }
        let layout = ProjectGraph.layout(marks: marks, edges: [], availableWidth: 361)
        XCTAssertEqual(layout.placements.count, 5)
        XCTAssertLessThanOrEqual(layout.width, 361)
        XCTAssertTrue(layout.routes.isEmpty)
        assertNoOverlap(layout)
    }

    func testTheTruncationNoticeNamesTheLimit() {
        XCTAssertEqual(ProjectGraph.truncatedNotice(maxTasks: 500).title,
                       "This project is larger than one graph request reads (500 tasks).")
    }
}
