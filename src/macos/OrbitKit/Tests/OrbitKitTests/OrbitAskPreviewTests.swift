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
        // set; a standing yes is the gate switched off, not a preference. Ending a blocker is the
        // same shape from the other side — the blocker IS the project asking for a person, so
        // "always let this session clear whatever stops its project" would make every card after
        // it a formality. Web refuses all of them too, and the weaker client would otherwise win.
        for tool in ["orbit_task_batch", "orbit_dag_change", "orbit_task_create", "orbit_project_create",
                     "orbit_blocker_resolve"] {
            XCTAssertNil(Approvals.rememberRule(toolName: tool, input: json("{}")),
                         "\(tool) must not offer Allow & remember")
        }
        // An ordinary tool still can — an ordinary orbit MCP tool included, which is the control
        // for this being about those asks and not about the `orbit_` prefix.
        XCTAssertNotNil(Approvals.rememberRule(toolName: "Read", input: json("{}")))
        XCTAssertNotNil(Approvals.rememberRule(toolName: "orbit_task_get", input: json("{}")))
    }

    // MARK: ending a blocker

    /// What the runner puts on the ask: the project, the blocker's own facts from the project read,
    /// and the agent's reason for ending it.
    private func blockerInput() -> JSONValue {
        json("""
            {"projectTitle":"数据管道重建","blockerId":"b1","reason":"权限已在 09-18 由运维补齐，脚本重跑通过。",
             "blocker":{"id":"b1","kind":"owner","owner":"2p7QMFOwEGtL5oaTxZHihm",
                        "requiredAction":"需要你确认新集群的账号权限",
                        "subjectType":"task","subjectTitle":"重跑 09-17 的导入"}}
            """)
    }

    func testABlockerAsksWithWhatItWantedAndWhyThatIsNoLongerSo() {
        let b = Approvals.blockerResolvePreview(toolName: "orbit_blocker_resolve", from: blockerInput())
        XCTAssertEqual(b?.projectTitle, "数据管道重建")
        XCTAssertEqual(b?.requiredAction, "需要你确认新集群的账号权限")
        XCTAssertEqual(b?.reason, "权限已在 09-18 由运维补齐，脚本重跑通过。")
        XCTAssertEqual(b?.about, "About 重跑 09-17 的导入")
        XCTAssertEqual(b?.declineName, "重跑 09-17 的导入")

        // Only this tool answers for this card: every other approval keeps its own.
        XCTAssertNil(Approvals.blockerResolvePreview(toolName: "orbit_task_get", from: blockerInput()))
    }

    func testABlockerWithNothingToNameFallsBackToItsKind() {
        let provider = Approvals.blockerResolvePreview(toolName: "orbit_blocker_resolve", from: json("""
            {"projectTitle":"数据管道重建","blocker":{"kind":"provider","requiredAction":"恢复额度"}}
            """))
        XCTAssertEqual(provider?.about, "provider", "a wait on a provider has no task to name")
        XCTAssertEqual(provider?.declineName, "provider")
        XCTAssertEqual(provider?.reason, "")

        let bare = Approvals.blockerResolvePreview(toolName: "orbit_blocker_resolve", from: json("{}"))
        XCTAssertEqual(bare?.about, "", "with neither subject nor kind the card draws no such line")
        XCTAssertEqual(bare?.declineName, "this blocker")
    }

    /// The card reads those two sentences instead of falling back to the generic "Approve tool
    /// call" chrome. A source scan, because what it checks is wiring — which preview the branch
    /// reads and what it prints — and layout is the one thing these tests cannot see.
    func testABlockerCardIsDrawnFromTheBlockerFacts() throws {
        let card = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift")
        XCTAssertTrue(card.contains("Approvals.blockerResolvePreview(toolName:"),
                      "the card reads the blocker's own facts")
        for shown in ["blocker.requiredAction",
                      "The agent says it no longer blocks",
                      "blocker.reason",
                      "\"Resolve it\""] {
            XCTAssertTrue(card.contains(shown),
                          "\(shown) is part of what this card shows and the press it offers")
        }
    }

    private struct NoSuchFile: Error, CustomStringConvertible {
        let path: String
        var description: String { "\(path) was not found above this test" }
    }

    /// The same walk up from `#filePath` the other wiring tests use, so the check works from
    /// `swift test`'s working directory whatever that is.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw NoSuchFile(path: relative)
    }

    // MARK: single create

    func testSingleCreateShowsWhatWouldBeWritten() {
        let task = Approvals.createPreview(toolName: "orbit_task_create", from: json("""
            {"title":"Fix login redirect","description":"why","acceptanceCriteria":"lands on /home","projectId":"p1"}
            """))!
        XCTAssertFalse(task.isProject)
        XCTAssertEqual(task.title, "Fix login redirect")
        XCTAssertEqual(task.prose, "why")
        XCTAssertEqual(task.criteria, ["lands on /home"])

        let project = Approvals.createPreview(toolName: "orbit_project_create", from: json("""
            {"title":"Checkout","goal":"one page","acceptanceCriteriaItems":[{"text":"p95 < 1s","verificationMethod":"dashboard"}]}
            """))!
        XCTAssertTrue(project.isProject)
        XCTAssertEqual(project.prose, "one page")
        XCTAssertEqual(project.criteria, ["p95 < 1s"])

        // Every other approval keeps its own card.
        XCTAssertNil(Approvals.createPreview(toolName: "orbit_task_batch", from: json("{}")))
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
        XCTAssertEqual(p.tasks.map(\.title), ["step 0", "step 1"])
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

        // The single create card reads these same lines, which is what makes n = 1 a shape they
        // have to survive: "1 wait on a prerequisite" is not a sentence anybody wrote.
        let waiting = Approvals.batchPreview(from: json("""
            {"preview":{"taskCount":1,"blocked":1}}
            """))!
        XCTAssertEqual(Approvals.batchImpactLines(waiting), ["1 waits on a prerequisite"])
    }

    // MARK: a single create wears the batch card's skeleton

    func testASingleCreateLeadsWithTheSameConsequenceTheBatchCardDoes() {
        let task = Approvals.createPreview(toolName: "orbit_task_create", from: json("""
            {"title":"Fix login redirect","description":"why","completionCriterion":"EXECUTABLE",
             "preview":{"taskCount":1,"startingNow":1,"lists":[{"id":"l1","title":"Backlog"}]}}
            """))!

        // The same lines the batch card leads with, from the same server-computed report.
        XCTAssertEqual(task.impact, ["1 starts running within the minute"])
        XCTAssertEqual(task.detail, "into Backlog · EXECUTABLE")
        // The name moves out of the header and onto its own row, where it can wrap.
        XCTAssertEqual(task.titleLine, "Fix login redirect")
        XCTAssertEqual(task.foldNoun, "description")
        XCTAssertEqual(task.descriptionText, "why")
    }

    func testASingleCreateWithoutAPreviewSaysNothingAboutRunning() {
        // An older runner, or a preview read that failed. The card must not invent a count it was
        // never given — "0 start running within the minute" would read as "nothing will happen".
        let task = Approvals.createPreview(toolName: "orbit_task_create", from: json("""
            {"title":"t","completionCriterion":"EXECUTABLE"}
            """))!

        XCTAssertTrue(task.impact.isEmpty)
        XCTAssertEqual(task.detail, "EXECUTABLE")
    }

    func testAProjectKeepsItsNameUpTopAndItsGoalInTheFold() {
        let project = Approvals.createPreview(toolName: "orbit_project_create", from: json("""
            {"title":"Checkout","goal":"one page","acceptanceCriteriaItems":[{"text":"p95 < 1s"}]}
            """))!

        // No count to lead with, no dispatch to report, and never a goal called a description.
        XCTAssertTrue(project.impact.isEmpty)
        XCTAssertEqual(project.detail, "")
        XCTAssertEqual(project.titleLine, "")
        XCTAssertEqual(project.foldNoun, "goal")
        XCTAssertEqual(project.criteriaText, "- p95 < 1s")
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

/// The batch's shape, rendered for a column too narrow to draw a graph in. Web draws real nodes
/// and edges; the structure has to survive the translation, including the places a tree cannot
/// express a DAG and has to say so instead of quietly simplifying.
final class BatchTreeTests: XCTestCase {

    private func task(_ title: String, ref: String? = nil, on refs: [String]? = nil,
                      outside: [String]? = nil) -> BatchPreviewTask {
        BatchPreviewTask(title: title, ref: ref, dependsOnRefs: refs, dependsOnTaskIds: outside)
    }

    func testAChainIndentsOneLevelPerStep() {
        let rows = Approvals.batchTreeRows((0..<4).map {
            task("step \($0)", ref: "s\($0)", on: $0 == 0 ? nil : ["s\($0 - 1)"])
        })

        XCTAssertEqual(rows.map(\.depth), [0, 1, 2, 3])
        XCTAssertEqual(rows[0].text, "step 0")
        XCTAssertEqual(rows[1].text, "└─ step 1")
        XCTAssertEqual(Approvals.describeBatchShape((0..<4).map {
            task("step \($0)", ref: "s\($0)", on: $0 == 0 ? nil : ["s\($0 - 1)"])
        }), "a chain of 4")
    }

    func testAFanOutReadsAsSiblings() {
        let tasks = [task("root", ref: "r"),
                     task("left", ref: "l", on: ["r"]),
                     task("right", ref: "x", on: ["r"])]

        let rows = Approvals.batchTreeRows(tasks)

        XCTAssertEqual(rows.map(\.text), ["root", "├─ left", "└─ right"])
        XCTAssertEqual(Approvals.describeBatchShape(tasks), "2 in parallel after 1")
    }

    func testAJoinSaysItIsASimplification() {
        // A tree cannot draw a task that waits on two things. Dropping the second edge silently
        // would show an order the dispatcher will not follow; counting it is the honest move.
        let tasks = [task("a", ref: "a"),
                     task("b", ref: "b", on: ["a"]),
                     task("join", ref: "j", on: ["a", "b"])]

        let rows = Approvals.batchTreeRows(tasks)

        XCTAssertTrue(rows.last!.text.contains("waits on 1 more"), rows.last!.text)
    }

    func testATaskWaitingOutsideTheBatchSaysSo() {
        // It draws as a root because its prerequisite is not in the window; without the note the
        // picture would say it can start, which is the opposite of true.
        let rows = Approvals.batchTreeRows([task("a", ref: "a", outside: ["existing-1"])])

        XCTAssertTrue(rows[0].text.contains("waits on a task outside"), rows[0].text)
    }

    func testIndentationStopsBeforeItRunsOffTheColumn() {
        // A phone column is ~300pt and each level costs ~14pt; a 12-deep chain would push its last
        // titles off the edge, which crops the shape rather than showing it.
        let deep = (0..<8).map { task("step \($0)", ref: "s\($0)", on: $0 == 0 ? nil : ["s\($0 - 1)"]) }

        let rows = Approvals.batchTreeRows(deep)

        XCTAssertEqual(rows.map(\.depth).max(), maxTreeDepth)
        XCTAssertTrue(rows.last!.text.contains("level 7"), rows.last!.text)
    }

    func testUnrelatedTasksHaveNoTreeAndSaySo() {
        let tasks = [task("a"), task("b"), task("c")]

        XCTAssertEqual(Approvals.batchTreeRows(tasks).map(\.depth), [0, 0, 0])
        XCTAssertEqual(Approvals.describeBatchShape(tasks), "3 independent tasks")
    }

    func testARefPointingPastTheWindowLeavesTheTaskARoot() {
        // The card draws at most a dozen of a fifty-task batch, so refs naming items outside the
        // window are ordinary; they must not produce a row under a parent that is not there.
        let rows = Approvals.batchTreeRows([task("a", ref: "a", on: ["not-shown"])])

        XCTAssertEqual(rows.map(\.depth), [0])
    }

    func testAnEmptyBatchProducesNothing() {
        XCTAssertTrue(Approvals.batchTreeRows([]).isEmpty)
        XCTAssertEqual(Approvals.describeBatchShape([]), "")
    }
}

/// The transcript's record of Orbit's own writes. Reported from the app: once a batch approval is
/// decided, all that survived was a folded `orbit · task_create_batch` — the card was gone and the
/// durable record said only that a decision had happened.
final class OrbitWriteToolDisplayTests: XCTestCase {

    private func json(_ s: String) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8))
    }
    private func describe(_ name: String, _ input: JSONValue) -> ToolDisplay {
        ToolDisplay.describe(name: name, input: input, status: .ok, id: "t1")
    }

    func testABatchSaysWhatItCreatedAndWhatShapeItHad() {
        let d = describe("mcp__orbit__task_create_batch", json("""
            {"tasks":[{"title":"准备分片清单","ref":"r"},
                      {"title":"分片 A","ref":"a","dependsOnRefs":["r"]},
                      {"title":"分片 B","ref":"b","dependsOnRefs":["r"]}]}
            """))

        XCTAssertEqual(d.label, "Create tasks")
        XCTAssertEqual(d.summary, "2 in parallel after 1")
        XCTAssertEqual(d.meta, "3")
        // The tree, so the shape survives into the record and not just into the card.
        guard case .code(let tree) = d.body else { return XCTFail("expected a tree body: \(d.body)") }
        XCTAssertTrue(tree.contains("├─ 分片 A"), tree)
        XCTAssertTrue(tree.contains("└─ 分片 B"), tree)
    }

    func testARestructureIsNamedByItsReason() {
        let d = describe("mcp__orbit__tasklist_propose_dag", json("""
            {"listId":"l1","note":"把 WARC 转换拆开并行跑",
             "ops":[{"op":"remove","taskId":"a","dependsOnTaskId":"b"}]}
            """))

        XCTAssertEqual(d.label, "Restructure dependencies")
        XCTAssertEqual(d.summary, "把 WARC 转换拆开并行跑")
        XCTAssertEqual(d.meta, "1")
    }

    func testARestructureWithoutANoteFallsBackToItsEdgeCounts() {
        let d = describe("mcp__orbit__tasklist_propose_dag", json("""
            {"ops":[{"op":"add","taskId":"a","dependsOnTaskId":"b"},
                    {"op":"remove","taskId":"c","dependsOnTaskId":"d"}]}
            """))

        XCTAssertEqual(d.summary, "+1 / −1 edges")
    }

    func testEveryOtherMCPToolKeepsTheGenericCard() {
        let d = describe("mcp__orbit__task_get", json("{\"taskId\":\"x\"}"))

        XCTAssertEqual(d.label, "orbit · task_get")
    }

    func testAnEmptyBatchDoesNotClaimAShape() {
        let d = describe("mcp__orbit__task_create_batch", json("{\"tasks\":[]}"))

        XCTAssertNil(d.summary)
        XCTAssertNil(d.meta)
        XCTAssertEqual(d.body, .none)
    }
}
