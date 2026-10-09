import Foundation
import XCTest
@testable import OrbitKit

/// The batch-create review as approved in docs/mocks/batch-create-review-ios: the consequence split
/// at its dash, a detail line that does not open on a separator, the tasks by level with every
/// prerequisite named by its number, and a page per task read off the bodies the runner sends.
final class BatchReviewTests: XCTestCase {

    private func json(_ s: String) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8))
    }

    private func task(_ title: String, ref: String? = nil, on refs: [String]? = nil,
                      outside: [String]? = nil) -> BatchPreviewTask {
        BatchPreviewTask(title: title, ref: ref, dependsOnRefs: refs, dependsOnTaskIds: outside)
    }

    /// 1 → 2, 3 → 4, and 1 also waits on a task that already exists: the board's own example.
    private var diamond: [BatchPreviewTask] {
        [task("oauth", ref: "a", outside: ["existing-1"]),
         task("button", ref: "b", on: ["a"]),
         task("signup", ref: "c", on: ["a"]),
         task("e2e", ref: "d", on: ["b", "c"])]
    }

    // MARK: levels

    func testIndependentTasksAreOneNumberedLevel() {
        // The batch in the screenshot that started this: three tasks, no edges, no list.
        let levels = Approvals.batchLevels([task("管理员共享模型提供方的 API key"), task("池网关原样转发"),
                                            task("T1 用户路由普查")])

        XCTAssertEqual(levels.count, 1, "no edges, so one level — the review draws it as a plain list")
        XCTAssertEqual(levels[0].rows.map(\.number), [1, 2, 3])
        XCTAssertTrue(levels[0].rows.allSatisfy { $0.waitsOn.isEmpty && !$0.waitsOutside })
    }

    func testADiamondIsListedByLevelAndNamesEveryPrerequisite() {
        let levels = Approvals.batchLevels(diamond)

        XCTAssertEqual(levels.map { $0.rows.map(\.title) }, [["oauth"], ["button", "signup"], ["e2e"]])
        XCTAssertEqual(levels.flatMap(\.rows).map(\.number), [1, 2, 3, 4])
        // The join names both prerequisites. The tree could only say "waits on 1 more".
        XCTAssertEqual(levels[2].rows[0].waitsOn, [2, 3])
        XCTAssertEqual(levels[1].rows.map(\.waitsOn), [[1], [1]])
        XCTAssertTrue(levels[0].rows[0].waitsOutside)
        XCTAssertFalse(levels[2].rows[0].waitsOutside)

        XCTAssertEqual(levels.map(Approvals.batchLevelName), ["Level 1", "Level 2", "Level 3"])
        XCTAssertEqual(levels.map(Approvals.batchLevelParallel), [nil, "2 in parallel", nil])
        XCTAssertEqual(Approvals.describeBatchShape(diamond), "3 levels, up to 2 in parallel")
    }

    func testNumbersFollowTheLevelsSoAPrerequisiteAlwaysComesFirst() {
        // Batch order puts the waiting task second. Reading order puts it last, under the level it
        // waits on, and its prerequisite keeps the smaller number.
        let levels = Approvals.batchLevels([task("a", ref: "a"), task("b", ref: "b", on: ["a"]), task("c")])

        XCTAssertEqual(levels.map { $0.rows.map(\.title) }, [["a", "c"], ["b"]])
        XCTAssertEqual(levels.flatMap(\.rows).map(\.number), [1, 2, 3])
        XCTAssertEqual(levels[1].rows[0].waitsOn, [1])
        // `index` stays the batch position, which is what the task page reads the body by.
        XCTAssertEqual(levels.flatMap(\.rows).map(\.index), [0, 2, 1])
    }

    func testAJoinSitsUnderItsDeepestPrerequisite() {
        // Longest path, as web layers it: under the leaf, not the root, or the picture would claim an
        // order the dispatcher will not follow.
        let tasks = [task("a", ref: "a"), task("b", ref: "b", on: ["a"]), task("j", ref: "j", on: ["a", "b"])]
        let levels = Approvals.batchLevels(tasks)

        XCTAssertEqual(levels.count, 3)
        XCTAssertEqual(levels[2].rows[0].waitsOn, [1, 2])
        XCTAssertEqual(Approvals.describeBatchShape(tasks), "a chain of 3")
    }

    func testARefNamingNothingInTheWindowLeavesTheTaskOnTheFirstLevel() {
        let levels = Approvals.batchLevels([task("a", ref: "a", on: ["not-shown", "a"])])

        XCTAssertEqual(levels.count, 1)
        XCTAssertEqual(levels[0].rows[0].waitsOn, [], "nor does a task wait on itself")
    }

    func testNeededByIsWhatWaitsOnARow() {
        let levels = Approvals.batchLevels(diamond)
        let rows = levels.flatMap(\.rows)

        XCTAssertEqual(Approvals.batchNeededBy(rows[0], in: levels).map(\.number), [2, 3])
        XCTAssertEqual(Approvals.batchNeededBy(rows[1], in: levels).map(\.number), [4])
        XCTAssertEqual(Approvals.batchNeededBy(rows[3], in: levels), [])
    }

    func testAnEmptyWindowHasNoLevels() {
        XCTAssertEqual(Approvals.batchLevels([]), [])
    }

    // MARK: the shape sentence

    func testAfterOneIsSaidOnlyWhenOneTaskReleasesTheRest() {
        let fanOut = [task("r", ref: "r"), task("x", ref: "x", on: ["r"]), task("y", ref: "y", on: ["r"]),
                      task("z", ref: "z", on: ["r"])]
        XCTAssertEqual(Approvals.describeBatchShape(fanOut), "3 in parallel after 1")

        // Three tasks that release a fourth: "3 in parallel after 1" would read backwards.
        let fanIn = [task("a", ref: "a"), task("b", ref: "b"), task("c", ref: "c"),
                     task("d", ref: "d", on: ["a", "b"])]
        XCTAssertEqual(Approvals.describeBatchShape(fanIn), "2 levels, up to 3 in parallel")
    }

    // MARK: the card's lines

    func testTheDetailLineDoesNotOpenOnASeparator() {
        func preview(_ body: String) -> BatchApprovalPreview {
            Approvals.batchPreview(from: json("{\"preview\":\(body)}"))!
        }
        // The screenshot's line was "· 3 independent tasks": no list, no edges, and the shape still
        // brought its own separator.
        XCTAssertEqual(Approvals.batchDetailLine(preview("""
            {"taskCount":3,"needsManualStart":3,"tasks":[{"title":"a"},{"title":"b"},{"title":"c"}]}
            """)), "3 independent tasks")
        XCTAssertEqual(Approvals.batchDetailLine(preview("""
            {"taskCount":2,"lists":[{"title":"Backlog"}],"tasks":[{"title":"a"},{"title":"b"}]}
            """)), "into Backlog · 2 independent tasks")
        XCTAssertEqual(Approvals.batchDetailLine(preview("""
            {"taskCount":2,"internalEdges":1,"externalEdges":0,
             "tasks":[{"title":"a","ref":"a"},{"title":"b","ref":"b","dependsOnRefs":["a"]}]}
            """)), "1 dependency edge · a chain of 2")
        XCTAssertEqual(Approvals.batchDetailLine(preview("{\"taskCount\":0}")), "")
    }

    func testImpactRowsKeepTheSentenceAndSplitItAtTheDash() {
        let p = Approvals.batchPreview(from: json("""
            {"preview":{"taskCount":6,"startingNow":1,"blocked":2,"needsManualStart":2,"notDispatchable":1}}
            """))!
        let rows = Approvals.batchImpactRows(p)

        XCTAssertEqual(rows.map(\.kind), [.starting, .waiting, .manualStart, .cannotRun])
        XCTAssertEqual(rows.map(\.text), Approvals.batchImpactLines(p), "one set of sentences, not two")

        XCTAssertEqual(rows[0].head, "1 starts running within the minute")
        XCTAssertNil(rows[0].reason)
        XCTAssertEqual(rows[2].head, "2 need a manual start")
        XCTAssertEqual(rows[2].reason, "Nothing will trigger them")
        XCTAssertEqual(rows[3].head, "1 cannot run")
        XCTAssertEqual(rows[3].reason, "Unassigned, no runner, auto-run off, or the list is paused")
    }

    func testASingleCreateCarriesTheSameRows() {
        let create = Approvals.createPreview(toolName: "orbit_task_create", from: json("""
            {"title":"t","preview":{"taskCount":1,"needsManualStart":1}}
            """))!

        XCTAssertEqual(create.impactRows.map(\.kind), [.manualStart])
        XCTAssertEqual(create.impactRows.map(\.text), create.impact)
        XCTAssertEqual(create.impactRows[0].reason, "Nothing will trigger it")
    }

    // MARK: task pages

    func testATaskPageReadsTheBodyTheRunnerSends() {
        let input = json("""
            {"tasks":[
              {"title":"oauth","description":"## 背景\\nwhy","acceptanceCriteria":"done when",
               "completionCriterion":"EVIDENCE_JUDGMENT","labels":["google-sign-in"]},
              {"title":"button"}],
             "preview":{"taskCount":2,"tasks":[{"title":"oauth"},{"title":"button"}]}}
            """)
        let details = Approvals.batchTaskDetails(from: input)
        let rows = Approvals.batchLevels(Approvals.batchPreview(from: input)!.tasks).flatMap(\.rows)

        let first = Approvals.batchTaskDetail(for: rows[0], in: details)
        XCTAssertEqual(first?.description, "## 背景\nwhy")
        XCTAssertEqual(first?.acceptanceCriteria, "done when")
        XCTAssertEqual(first?.labels, ["google-sign-in"])
        XCTAssertEqual(first?.judgedBy, "Judged by · submitted evidence")

        let second = Approvals.batchTaskDetail(for: rows[1], in: details)
        XCTAssertEqual(second?.description, "")
        XCTAssertNil(second?.judgedBy, "no criterion declared, no chip")
    }

    func testATaskPageNeverShowsAnotherTasksBody() {
        let details = [BatchTaskDetail(title: "b", description: "b's", acceptanceCriteria: "",
                                       completionCriterion: "", labels: []),
                       BatchTaskDetail(title: "a", description: "a's", acceptanceCriteria: "",
                                       completionCriterion: "", labels: [])]
        let row = BatchLevelRow(index: 0, number: 1, title: "a", waitsOn: [], waitsOutside: false)

        XCTAssertEqual(Approvals.batchTaskDetail(for: row, in: details)?.description, "a's",
                       "the position disagrees with the title, so the title decides")
        XCTAssertNil(Approvals.batchTaskDetail(
            for: BatchLevelRow(index: 0, number: 1, title: "z", waitsOn: [], waitsOutside: false), in: details))
        XCTAssertEqual(Approvals.batchTaskDetails(from: json("{}")), [])
    }

    // MARK: copy

    func testTheCardSaysHowManyItCreates() {
        XCTAssertEqual(Approvals.batchCreateAction(3), "Create 3 tasks")
        XCTAssertEqual(Approvals.batchCreateAction(1), "Create 1 task")
        XCTAssertEqual(Approvals.batchTaskPageTitle(1, of: 3), "Task 1 of 3")
        XCTAssertEqual(Approvals.batchTaskPageTitle(4, of: nil), "Task 4",
                       "a window that does not hold the whole batch has no total to name")
        XCTAssertEqual(Approvals.batchMore(38), "+38 more")
    }
}
