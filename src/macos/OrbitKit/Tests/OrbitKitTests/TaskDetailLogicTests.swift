import Foundation
import XCTest
@testable import OrbitKit

/// The task detail page's rules (`TaskDetailLogic`), read against payloads shaped like the ones the
/// server sent on 2026-09-26: the self-hosted provider task (Running, owner-confirmed, no
/// dependencies) and T9 of the Wiki project (seven upstream tasks, two runs, four comments).
final class TaskDetailLogicTests: XCTestCase {

    private func task(_ json: String) -> TaskItem {
        try! JSONDecoder().decode(TaskItem.self, from: Data(json.utf8))
    }

    private let utc = TimeZone(identifier: "UTC")!
    private let us = Locale(identifier: "en_US")

    /// ICU puts a narrow no-break space before AM/PM, as the browser's `toLocaleString` does; the
    /// words are what is compared.
    private func plain(_ s: String?) -> String? { s?.replacingOccurrences(of: "\u{202F}", with: " ") }

    /// The detail `GET /tasks/34VKXbmdz1NYtDiNoqnHl` answered, cut to the fields the page reads.
    private lazy var vllm = task("""
    {"id":"34VKXbmdz1NYtDiNoqnHl","title":"支持配置自托管（本地 vLLM）provider","status":"OPEN",
     "completionCriterion":"OWNER_CONFIRMED","acceptanceCriteria":"由账号所有者亲自验证并确认。",
     "acceptanceCommand":null,"acceptanceExpectedExitCode":null,"runAt":null,"attachments":[],
     "dependencyState":"NONE","createdAt":"2026-09-26T04:48:27.341Z","updatedAt":"2026-09-26T04:48:27.341Z",
     "assignee":{"id":"3CuIHiSJZBQ7nLVUwc7ekz","name":"orbit","model":"claude-opus-5"},
     "comments":[],"dependsOn":[],"dependedOnBy":[],
     "sessions":[{"id":"5WAUMMyHJRbGucpvcgNs8U","title":"执行任务：支持配置自托管（本地 vLLM）provider",
                  "status":"RUNNING","runState":"RUNNING","createdAt":"2026-09-26T04:49:03.610Z",
                  "agent":{"name":"orbit"}}],
     "creatorSession":{"id":"34SF0thNvXNfDZGqPqmIq","title":"wiki.ingest 开源模型第一轮筛选（契约 + 工具纪律）"}}
    """)

    // MARK: payload

    func testTheDetailCarriesItsScheduleAndItsInputs() {
        XCTAssertNil(vllm.runAt)
        XCTAssertEqual(vllm.attachments, [])
        let scheduled = task("""
        {"id":"T","title":"t","status":"OPEN","runAt":"2026-09-27T07:00:00.000Z",
         "attachments":[{"id":"A1","mimeType":"image/png","sizeBytes":20480,"fileName":"mock.png",
                         "createdAt":"2026-09-26T05:00:00.000Z"},
                        {"id":"A2","mimeType":"application/pdf","sizeBytes":3145728,"fileName":null,
                         "createdAt":"2026-09-26T05:00:00.000Z"}]}
        """)
        XCTAssertEqual(scheduled.runAt, "2026-09-27T07:00:00.000Z")
        XCTAssertEqual(scheduled.attachments?.map(\.id), ["A1", "A2"])
        XCTAssertEqual(scheduled.attachments?.map(\.isImage), [true, false])
        XCTAssertNil(scheduled.attachments?[1].fileName)
    }

    func testTheScheduleAndTheAcceptanceWriteTheirFieldsThreeStates() throws {
        func json(_ request: UpdateTaskRequest) throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any]
        }
        XCTAssertTrue(try json(UpdateTaskRequest()).isEmpty, "nothing named, nothing sent")
        let set = try json(UpdateTaskRequest(runAt: .set("2026-09-27T07:00:00.000Z")))
        XCTAssertEqual(set["runAt"] as? String, "2026-09-27T07:00:00.000Z")
        let cleared = try json(UpdateTaskRequest(runAt: .clear))
        XCTAssertTrue(cleared.keys.contains("runAt"))
        XCTAssertTrue(cleared["runAt"] is NSNull, "Cancel schedule sends null, not an absent key")
        let pair = try json(UpdateTaskRequest(acceptanceCommand: .set("npm test"), acceptanceExpectedExitCode: .set(0)))
        XCTAssertEqual(pair["acceptanceCommand"] as? String, "npm test")
        XCTAssertEqual(pair["acceptanceExpectedExitCode"] as? Int, 0)
        XCTAssertNil(pair["acceptanceCriteria"])
    }

    // MARK: actions

    private func entry(_ task: TaskItem) -> TaskRunHandoff.Entry { TaskRunHandoff.entry(for: task) }

    func testARunningOwnerConfirmedTaskOffersConfirmDoneAndTheRun() {
        let row = TaskDetailLogic.actionRow(owner: .confirm, reopenable: false, status: vllm.status, gate: false,
                                            entry: entry(vllm))
        XCTAssertEqual(row.leading, .confirmDone)
        XCTAssertEqual(row.trailing, .openRun(sessionID: "5WAUMMyHJRbGucpvcgNs8U"))
        XCTAssertFalse(row.stacked, "two short labels share one line")
    }

    func testARunWaitingOnTheOwnerPointsAtItsCardAndStacks() {
        let idle = task(#"{"id":"T","title":"t","status":"OPEN","sessions":[{"id":"S","status":"AWAITING_INPUT"}]}"#)
        let row = TaskDetailLogic.actionRow(owner: .pointer(sessionId: "S"), reopenable: false, status: .open,
                                            gate: false, entry: entry(idle))
        XCTAssertEqual(row.leading, .waitingForConfirmation(sessionID: "S"))
        XCTAssertEqual(row.trailing, .runNow)
        XCTAssertTrue(row.stacked, "the pointer's label does not fit half a phone's width")
    }

    func testAStoppedTaskIsReopenedBesideItsRetry() {
        let failed = task(#"{"id":"T","title":"t","status":"FAILED"}"#)
        let row = TaskDetailLogic.actionRow(owner: nil, reopenable: true, status: .failed, gate: false,
                                            entry: entry(failed))
        XCTAssertEqual(row.leading, .reopen)
        XCTAssertEqual(row.trailing, .retry)
        let done = task(#"{"id":"T","title":"t","status":"DONE"}"#)
        let settled = TaskDetailLogic.actionRow(owner: nil, reopenable: true, status: .done, gate: false,
                                                entry: entry(done))
        XCTAssertEqual(settled.leading, .reopen)
        XCTAssertNil(settled.trailing, "a done task offers no run")
    }

    func testAGateRowSaysWhatItCannotDoAndAPlainTaskOnlyRuns() {
        let open = task(#"{"id":"T","title":"t","status":"OPEN"}"#)
        XCTAssertEqual(TaskDetailLogic.actionRow(owner: nil, reopenable: false, status: .open, gate: true,
                                                 entry: entry(open)).trailing, .gate)
        let plain = TaskDetailLogic.actionRow(owner: nil, reopenable: false, status: .open, gate: false,
                                              entry: entry(open))
        XCTAssertNil(plain.leading)
        XCTAssertEqual(plain.trailing, .runNow)
        XCTAssertFalse(plain.isEmpty)
    }

    // MARK: details

    func testTheFootnoteSaysWhoMadeTheTaskAndWhen() {
        XCTAssertEqual(plain(TaskDetailLogic.createdFootnote(creatorName: "rocm", createdAt: vllm.createdAt,
                                                             timeZone: utc, locale: us)),
                       "Created by rocm · Sep 26, 4:48 AM")
        XCTAssertEqual(plain(TaskDetailLogic.createdFootnote(creatorName: nil, createdAt: vllm.createdAt,
                                                             timeZone: utc, locale: us)),
                       "Created Sep 26, 4:48 AM")
        XCTAssertEqual(TaskDetailLogic.createdFootnote(creatorName: "rocm", createdAt: nil), "Created by rocm")
        XCTAssertNil(TaskDetailLogic.createdFootnote(creatorName: " ", createdAt: "not a date"))
    }

    func testTheStartAtRowAndItsHint() {
        XCTAssertEqual(TaskDetailLogic.scheduleValue(nil), TaskDetailCopy.scheduleNotSet)
        XCTAssertEqual(TaskDetailLogic.scheduleHint(nil), TaskDetailCopy.scheduleHintUnscheduled)
        let at = "2026-09-27T07:00:00.000Z"
        XCTAssertEqual(plain(TaskDetailLogic.scheduleValue(at, timeZone: utc, locale: us)), "Sep 27, 7:00 AM")
        XCTAssertEqual(plain(TaskDetailLogic.scheduleHint(at, timeZone: utc, locale: us)),
                       "Starts once, on Sep 27, 7:00 AM, in your own time zone. Run now starts immediately and clears this scheduled start.")
        XCTAssertEqual(TaskDetailLogic.scheduleHint("tomorrow-ish"), TaskDetailCopy.scheduleHintUnreadable,
                       "a stored start this client cannot read is still live")
        XCTAssertEqual(TaskDetailLogic.scheduleValue("tomorrow-ish"), "tomorrow-ish")
        let picked = ISO8601DateFormatter().date(from: "2026-09-27T07:00:00Z")!
        XCTAssertEqual(TaskDetailLogic.runAtISO(picked), "2026-09-27T07:00:00.000Z")
    }

    // MARK: acceptance

    func testTheAcceptanceDraftRefusesHalfAPair() {
        var draft = TaskAcceptanceDraft(task: vllm)
        XCTAssertEqual(draft.criteria, "由账号所有者亲自验证并确认。")
        XCTAssertNil(draft.problem)
        draft.command = "npm test"
        XCTAssertEqual(draft.problem, TaskDetailCopy.acceptancePairIncomplete)
        draft.exitCode = "zero"
        XCTAssertEqual(draft.problem, TaskDetailCopy.acceptanceExitCodeNotAnInteger)
        draft.exitCode = "-1"
        XCTAssertNil(draft.problem)
        draft.command = "  "
        XCTAssertEqual(draft.problem, TaskDetailCopy.acceptancePairIncomplete)
    }

    func testTheAcceptancePatchSendsOnlyWhatMoved() throws {
        let current = TaskAcceptanceDraft(task: vllm)
        XCTAssertFalse(current.canSave(over: current), "an unchanged draft stays shut")
        XCTAssertFalse(TaskAcceptanceDraft(criteria: current.criteria + "  ").changed(from: current),
                       "trailing whitespace is not a change")

        var pair = current
        pair.command = "npm test -w @orbit/web"
        pair.exitCode = " 0 "
        XCTAssertTrue(pair.canSave(over: current))
        let request = pair.patch(over: current)
        XCTAssertEqual(request.acceptanceCriteria, .keep)
        XCTAssertEqual(request.acceptanceCommand, .set("npm test -w @orbit/web"))
        XCTAssertEqual(request.acceptanceExpectedExitCode, .set(0))

        var blank = current
        blank.criteria = "   "
        let cleared = blank.patch(over: current)
        XCTAssertEqual(cleared.acceptanceCriteria, .clear, "blank is not a value: it clears")
        XCTAssertEqual(cleared.acceptanceCommand, .keep)

        let judged = task(#"{"id":"T","title":"t","status":"OPEN","acceptanceCommand":"make","acceptanceExpectedExitCode":0}"#)
        var drop = TaskAcceptanceDraft(task: judged)
        XCTAssertEqual(drop.exitCode, "0")
        drop.command = ""
        drop.exitCode = ""
        let dropped = drop.patch(over: TaskAcceptanceDraft(task: judged))
        XCTAssertEqual(dropped.acceptanceCommand, .clear)
        XCTAssertEqual(dropped.acceptanceExpectedExitCode, .clear, "the pair is cleared together")
    }

    // MARK: dependencies

    private lazy var t9 = task("""
    {"id":"34UuATNwKhQurgfvdeVE5","title":"T9 web 会话接触点","status":"DONE","dependencyState":"READY",
     "dependsOn":[{"dependsOnTask":{"id":"T6","title":"T6 会话开场推送","status":"DONE"}},
                  {"dependsOnTask":{"id":"T8","title":"T8 web：Wiki 侧栏入口","status":"DONE"}}],
     "dependedOnBy":[{"task":{"id":"T10","title":"T10 iOS / macOS","status":"DONE"}},
                     {"task":{"id":"T11","title":"T11 灰度开关","status":"OPEN"}}]}
    """)

    /// The shape `GET /tasks/34UuATNwKhQurgfvdeVE5/dependency-graph` answered, with short ids.
    private let t9Graph: TaskDependencyGraph = try! JSONDecoder().decode(TaskDependencyGraph.self, from: Data("""
    {"focusTaskId":"34UuATNwKhQurgfvdeVE5","direction":"both","truncated":false,"truncatedEdges":false,
     "counts":{"upstream":7,"downstream":0,"connected":7,"lateral":0,"total":8,"done":7,"remaining":0,"failed":0},
     "limits":{"maxDepth":8,"maxNodes":500},"collapsedGroups":[],
     "nodes":[{"id":"34UuATNwKhQurgfvdeVE5","title":"T9 web 会话接触点","status":"DONE","depth":0},
              {"id":"T6","title":"T6 会话开场推送","status":"DONE","depth":1},
              {"id":"T8","title":"T8 web：Wiki 侧栏入口","status":"DONE","depth":1},
              {"id":"T3","title":"T3 WikiService","status":"DONE","depth":2},
              {"id":"T4","title":"T4 检索","status":"DONE","depth":2},
              {"id":"T7","title":"T7 wiki.changed","status":"DONE","depth":2},
              {"id":"T1","title":"T1 共享脱敏器","status":"DONE","depth":3},
              {"id":"T2","title":"T2 wiki 契约","status":"DONE","depth":3}],
     "edges":[{"sourceTaskId":"T1","targetTaskId":"T3"},{"sourceTaskId":"T2","targetTaskId":"T3"},
              {"sourceTaskId":"T3","targetTaskId":"T4"},{"sourceTaskId":"T3","targetTaskId":"T6"},
              {"sourceTaskId":"T4","targetTaskId":"T6"},{"sourceTaskId":"T3","targetTaskId":"T7"},
              {"sourceTaskId":"T3","targetTaskId":"T8"},{"sourceTaskId":"T4","targetTaskId":"T8"},
              {"sourceTaskId":"T7","targetTaskId":"T8"},{"sourceTaskId":"T6","targetTaskId":"34UuATNwKhQurgfvdeVE5"},
              {"sourceTaskId":"T8","targetTaskId":"34UuATNwKhQurgfvdeVE5"}]}
    """.utf8))

    func testATaskWithNoDependenciesSaysSoAndCountsNothing() {
        XCTAssertFalse(TaskDetailLogic.hasDependencies(vllm))
        let graph = TaskDetailLogic.dependencyGraph(for: vllm, loaded: nil)
        XCTAssertEqual(graph.nodes.map(\.id), ["34VKXbmdz1NYtDiNoqnHl"])
        XCTAssertNil(TaskDetailLogic.dependencySummary(for: vllm, graph: graph))
        XCTAssertNil(TaskDetailLogic.blockedNotice(for: vllm))
        XCTAssertFalse(TaskDetailLogic.prefersGraph(graph))
    }

    func testUntilTheComponentArrivesTheDirectEdgesStandIn() {
        let graph = TaskDetailLogic.dependencyGraph(for: t9, loaded: nil)
        XCTAssertEqual(graph.nodes.count, 5)
        XCTAssertTrue(graph.edges.contains(.init(sourceTaskId: "T6", targetTaskId: t9.id)), "prerequisite → task")
        XCTAssertTrue(graph.edges.contains(.init(sourceTaskId: t9.id, targetTaskId: "T11")), "task → dependent")
        XCTAssertEqual(TaskDetailLogic.dependencySummary(for: t9, graph: graph),
                       "4 connected · 2 upstream · 2 downstream")
        XCTAssertTrue(TaskDetailLogic.prefersGraph(graph))
    }

    func testTheLoadedComponentIsCountedAsTheBrowserCountsIt() {
        let graph = TaskDetailLogic.dependencyGraph(for: t9, loaded: t9Graph)
        XCTAssertEqual(graph, t9Graph)
        XCTAssertEqual(TaskDetailLogic.dependencySummary(for: t9, graph: graph),
                       "7 connected · 7 upstream · 0 downstream")
        let other = TaskDependencyGraph(focusTaskId: "someone-else", nodes: [], edges: [])
        XCTAssertEqual(TaskDetailLogic.dependencyGraph(for: t9, loaded: other).focusTaskId, t9.id,
                       "a component read for another task is not this one's")
    }

    func testTheListReadsEachTasksNeighboursAndOnlyDirectPrerequisitesCanBeRemoved() {
        let rows = TaskDetailLogic.dependencyRows(t9Graph)
        XCTAssertEqual(rows.count, 8)
        let focus = rows[0]
        XCTAssertTrue(focus.isFocus)
        XCTAssertFalse(focus.removable)
        XCTAssertEqual(focus.relationships, "Depends on T6 会话开场推送, T8 web：Wiki 侧栏入口")
        let t3 = rows.first { $0.id == "T3" }!
        XCTAssertEqual(t3.relationships,
                       "Depends on T1 共享脱敏器, T2 wiki 契约 · Required by T4 检索, T6 会话开场推送, T7 wiki.changed, T8 web：Wiki 侧栏入口")
        XCTAssertFalse(t3.removable, "not a direct prerequisite")
        XCTAssertEqual(rows.filter(\.removable).map(\.id), ["T6", "T8"])
        let lone = TaskDependencyGraph(focusTaskId: "F", nodes: [.init(id: "F", title: "F", status: "OPEN")], edges: [])
        XCTAssertEqual(TaskDetailLogic.dependencyRows(lone).first?.relationships, TaskDetailCopy.noAdjacentRelationships)
    }

    func testTheGraphIsDrawnWithTheProjectGraphsMarksAndNothingFolds() {
        let (marks, edges) = TaskDetailLogic.graphMarks(t9Graph)
        XCTAssertEqual(marks.count, 8, "seven finished prerequisites stay seven marks around the task")
        XCTAssertTrue(marks.allSatisfy { $0.kind == .task && $0.taskId == $0.id })
        XCTAssertEqual(edges.count, 11)
        let layout = ProjectGraph.layout(marks: marks, edges: edges, availableWidth: 329)
        XCTAssertEqual(layout.placements.count, 8)
        let dangling = TaskDependencyGraph(focusTaskId: "F", nodes: [.init(id: "F", title: "F", status: "OPEN")],
                                           edges: [.init(sourceTaskId: "gone", targetTaskId: "F")])
        XCTAssertTrue(TaskDetailLogic.graphMarks(dangling).edges.isEmpty, "an edge to a task not drawn is not drawn")
    }

    func testAComponentTasksPillIsTheListsRule() {
        XCTAssertEqual(TaskDetailLogic.pill(.init(id: "A", title: "a", status: "DONE")).label, "Done")
        XCTAssertEqual(TaskDetailLogic.pill(.init(id: "A", title: "a", status: "FAILED", running: true)).kind, .running,
                       "a live run wins over the status that lags")
        XCTAssertEqual(TaskDetailLogic.pill(.init(id: "A", title: "a", status: "OPEN", queued: true)).label, "Queued")
        XCTAssertEqual(TaskDetailLogic.pill(.init(id: "A", title: "a", status: "SOMETHING_NEW")).kind, .open)
    }

    func testABlockedTaskSaysHowFarItsPrerequisitesGot() {
        let waiting = task("""
        {"id":"T","title":"t","status":"OPEN","dependencyState":"BLOCKED",
         "dependsOn":[{"dependsOnTask":{"id":"A","title":"a","status":"DONE"}},
                      {"dependsOnTask":{"id":"B","title":"b","status":"IN_PROGRESS"}}]}
        """)
        XCTAssertEqual(TaskDetailLogic.blockedNotice(for: waiting)?.text,
                       "1 of 2 direct prerequisites complete. All are required.")
        XCTAssertEqual(TaskDetailLogic.blockedNotice(for: waiting)?.failed, false)
        let failed = task("""
        {"id":"T","title":"t","status":"OPEN","dependencyState":"BLOCKED_FAILED",
         "dependsOn":[{"dependsOnTask":{"id":"A","title":"a","status":"FAILED"}},
                      {"dependsOnTask":{"id":"B","title":"b","status":"CANCELLED"}}]}
        """)
        XCTAssertEqual(TaskDetailLogic.blockedNotice(for: failed)?.text,
                       "2 direct prerequisites failed or were cancelled — resolve them before running.")
        XCTAssertEqual(TaskDetailLogic.blockedNotice(for: failed)?.failed, true)
    }

    func testTheTruncationNoticeNamesTheLimitItHit() {
        XCTAssertNil(TaskDetailLogic.truncationNotice(t9Graph))
        let expandable = TaskDependencyGraph(focusTaskId: "F", nodes: [], edges: [],
                                             limits: .init(maxDepth: 8, maxNodes: 100, maxEdges: 400),
                                             collapsedGroups: [.init(hiddenCount: 3, cursor: "c1")])
        XCTAssertEqual(TaskDetailLogic.truncationNotice(expandable),
                       "The initial snapshot is limited to 8 hops or 100 tasks or 400 relationships.")
        let limit = TaskDependencyGraph(focusTaskId: "F", nodes: [], edges: [], truncatedEdges: true)
        XCTAssertEqual(TaskDetailLogic.truncationNotice(limit), TaskDetailCopy.graphLimitReached)
    }

    // MARK: long text, inputs

    func testLongTextFoldsFromItsOwnLengthNotFromAMeasurement() {
        XCTAssertFalse(TaskDetailLogic.folds("One line."))
        XCTAssertTrue(TaskDetailLogic.folds(String(repeating: "字", count: 601)))
        XCTAssertTrue(TaskDetailLogic.folds((1...11).map(String.init).joined(separator: "\n")))
        XCTAssertFalse(TaskDetailLogic.folds((1...10).map(String.init).joined(separator: "\n")))
    }

    func testInputSizesReadLikeTheBrowsers() {
        XCTAssertEqual(TaskDetailLogic.humanSize(512), "512 B")
        XCTAssertEqual(TaskDetailLogic.humanSize(20_480), "20 KB")
        XCTAssertEqual(TaskDetailLogic.humanSize(1_536), "2 KB")
        XCTAssertEqual(TaskDetailLogic.humanSize(3_145_728), "3.0 MB")
    }

    // MARK: attribution

    /// `GET /tasks/34VKXbmdz1NYtDiNoqnHl/attribution` as it answered.
    private let vllmAttribution: TaskAttribution = try! JSONDecoder().decode(TaskAttribution.self, from: Data("""
    {"taskId":"34VKXbmdz1NYtDiNoqnHl","owning":null,"owningAbsentReason":"FILED_UNDER_NO_PROJECT",
     "discovery":{"project":null,"triggerEvent":"agent.session_filed","task":null,
                  "session":{"sessionId":"34SF0thNvXNfDZGqPqmIq","title":"wiki.ingest 开源模型第一轮筛选（契约 + 工具纪律）",
                             "sessionPublicId":"34SF0thNvXNfDZGqPqmIq"},
                  "recorded":true,"absentReason":null,"authority":"EVIDENCE_ONLY"},
     "crossing":null,"crossingAbsentReason":"NO_CROSSING_DECLARED",
     "blocker":null,"blockerAbsentReason":"NOTHING_BLOCKING_ATTRIBUTION","taskPublicId":"34VKXbmdz1NYtDiNoqnHl"}
    """.utf8))

    func testAttributionSaysEachFactOrWhyItIsAbsent() {
        let rows = TaskDetailLogic.attributionRows(vllmAttribution)
        XCTAssertEqual(rows.map(\.label), ["Counts towards", "Noticed in", "Crossing", "Blocked by"])
        XCTAssertEqual(rows[0], TaskAttributionRow(label: "Counts towards", text: "This task is filed under no project.",
                                                   absent: true))
        XCTAssertEqual(rows[1].text, "Trigger agent.session_filed")
        XCTAssertEqual(rows[1].notes, ["Session: wiki.ingest 开源模型第一轮筛选（契约 + 工具纪律）"])
        XCTAssertEqual(rows[1].tags, ["EVIDENCE ONLY"])
        XCTAssertEqual(rows[1].link, .session("34SF0thNvXNfDZGqPqmIq"))
        XCTAssertFalse(rows[1].absent)
        XCTAssertEqual(rows[2].text, "No declared crossing touches this task.")
        XCTAssertEqual(rows[3].text, "Nothing is blocking where this work counts.")
    }

    func testAnAttributionFactThatIsPresentIsReadInFull() {
        let project = AttributionProjectRef(projectId: "P1", title: "Orbit Wiki · 阶段 1（MVP）", status: "OPEN")
        let view = TaskAttribution(taskId: "T", owning: project,
                                   discovery: AttributionDiscovery(recorded: false, absentReason: nil),
                                   crossing: AttributionCrossing(state: "PENDING", from: project,
                                                                 to: AttributionProjectRef(projectId: "P2", title: "Other", status: "OPEN"),
                                                                 code: "CROSSING_PENDING", requiredAction: "ANSWER"),
                                   blocker: AttributionBlocker(kind: "OWNER_DECISION", owner: "USER",
                                                               requiredAction: "Answer the crossing",
                                                               nextCheckAt: "2026-09-27T07:00:00.000Z"))
        let rows = TaskDetailLogic.attributionRows(view)
        XCTAssertEqual(rows[0].text, "Orbit Wiki · 阶段 1（MVP）")
        XCTAssertEqual(rows[0].tags, ["OPEN"])
        XCTAssertEqual(rows[0].link, .project("P1"))
        XCTAssertEqual(rows[1].text, TaskDetailCopy.notReported, "a server that says nothing is not guessed for")
        XCTAssertEqual(rows[2].text, "Waiting for your answer")
        XCTAssertEqual(rows[2].notes, ["the work is not filed anywhere until you answer",
                                       "Orbit Wiki · 阶段 1（MVP） → Other", "CROSSING_PENDING ANSWER"])
        XCTAssertEqual(rows[3].text, "Answer the crossing")
        XCTAssertEqual(rows[3].notes.first, "UNKNOWN · owner USER")
    }

    // MARK: followed by

    func testFollowersAreTheWatchesNamingThisTaskAndEndedOnesAreCounted() {
        let uuid = PublicID.storageKey(vllm.id)
        let live = WatchFixture.watch(id: "W1", action: "NOTIFY_USER", observer: nil,
                                      targets: [WatchFixture.target(vllm.id)])
        let byUUID = WatchFixture.watch(id: "W2", state: "PAUSED", targets: [WatchFixture.target(uuid)])
        let ended = WatchFixture.watch(id: "W3", state: "MATCHED", targets: [WatchFixture.target(vllm.id)])
        let session = WatchFixture.watch(id: "W4", targets: [WatchFixture.target(vllm.id, kind: "SESSION")])
        let other = WatchFixture.watch(id: "W5", targets: [WatchFixture.target("somebody-else")])
        let (followers, endedCount) = TaskDetailLogic.followers(of: vllm.id, in: [live, byUUID, ended, session, other])
        XCTAssertEqual(followers.map(\.id), ["W1", "W2"], "either spelling of the id, live states only")
        XCTAssertEqual(endedCount, 1)
        XCTAssertEqual(TaskDetailCopy.endedWatches(1), "1 ended watch")
        XCTAssertEqual(TaskDetailCopy.endedWatches(3), "3 ended watches")
        XCTAssertEqual(TaskDetailLogic.followedToast(ended), TaskDetailCopy.followMatchedAtOnce)
        XCTAssertEqual(TaskDetailLogic.followedToast(live), TaskDetailCopy.following)
    }

    func testFollowingATaskSendsTheBrowsersCreateBody() throws {
        XCTAssertEqual(TaskDetailLogic.followConditions.first, .all(.taskTerminal), "the web's default leaf first")
        XCTAssertEqual(TaskDetailLogic.defaultFollowDeadline, 86_400)
        XCTAssertEqual(TaskDetailLogic.followDeadlines, [3_600, 21_600, 86_400, 259_200, 604_800, 2_592_000])
        let request = CreateWatchRequest(taskID: vllm.id, predicate: .all(.taskTerminal), ttlSeconds: 86_400,
                                         idempotencyKey: "k1")
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any]
        XCTAssertEqual(body["predicateVersion"] as? Int, 1)
        XCTAssertEqual(body["action"] as? String, "NOTIFY_USER")
        XCTAssertEqual(body["ttlSeconds"] as? Int, 86_400)
        XCTAssertEqual(body["idempotencyKey"] as? String, "k1")
        XCTAssertEqual(body["targets"] as? [[String: String]], [["kind": "TASK", "id": vllm.id]])
        let predicate = body["predicate"] as? [String: Any]
        XCTAssertEqual(predicate?["kind"] as? String, "ALL")
        XCTAssertEqual(predicate?["leaf"] as? String, "TASK_TERMINAL")
        XCTAssertNil(body["observerSessionId"], "Notify me names no session")
    }
}
