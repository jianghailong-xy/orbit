import Foundation
import XCTest
@testable import OrbitKit

/// "Start this project?" — what the card derives, held to the browser's own examples
/// (`StartProjectCard.test.tsx`): the plan in levels, what still comes to the owner under the
/// Automatic switch, the line under Start, the body a press sends, and when the card is asked at all. The words are held by
/// `StartProjectCardCopyParityTests`; this is the logic under them, which a copy check cannot see.
final class StartProjectTests: XCTestCase {

    private static let project = "34WvwUS8YMXfOfWbMqVuu"
    private static let seal = "c2b4e16c4b59" + String(repeating: "0", count: 52)
    private static let moved = "9c4f7a1bb001" + String(repeating: "2", count: 52)

    private func request(line: IntegrationLine = .projectBranch,
                         warnings: [ProjectStartFinding]? = nil) -> ProjectStartRequest {
        ProjectStartRequest(
            settings: ProjectStartSettings(line: line,
                                           projectBranchName: "refs/heads/project/\(Self.project)",
                                           automatic: true, maxConcurrentTasks: 3,
                                           mergeCheckCommand: "cd src/web && npx tsc -b && npx vitest run"),
            why: "B and C both build on A — one branch checks them together before main.",
            criteriaDigest: Self.seal,
            planDigest: String(repeating: "p", count: 64),
            repository: "https://github.com/jianghailong-xy/orbit.git",
            // Filed empty since 2026-10-07: the check's warnings are the coordinator's.
            warnings: warnings ?? [])
    }

    /// The plan of the mock: A, then B and C, then D after B, then E after C and D — four tasks
    /// settled on their evidence and the last one, the go-live, confirmed by the owner.
    private func graph(folded: Bool = false) -> ProjectDependencyGraph {
        var marks = [
            ("task-a", "A · 提醒规则做成两端共用的真源", "EVIDENCE_JUDGMENT"),
            ("task-b", "B · OrbitKit：提醒规则、文案、DTO 与接口", "EVIDENCE_JUDGMENT"),
            ("task-c", "C · web：Runners 列表与 runner 详情页", "EVIDENCE_JUDGMENT"),
            ("task-d", "D · iOS/macOS：Runners 列表、Add Runner、Edit", "EVIDENCE_JUDGMENT"),
            ("task-e", "E · 上线", "OWNER_CONFIRMED"),
        ].map { ProjectGraphMark.task(id: $0.0, title: $0.1, status: "OPEN", completionCriterion: $0.2,
                                      autoRunWhenReady: true) }
        if folded {
            marks.append(ProjectGraphMark(kind: .motif, id: "motif-1", title: "12 more", taskCount: 12))
        }
        let edges = [("task-a", "task-b"), ("task-a", "task-c"), ("task-b", "task-d"),
                     ("task-c", "task-e"), ("task-d", "task-e")]
            .map { ProjectGraphEdge(sourceMarkId: $0.0, targetMarkId: $0.1) }
        return ProjectDependencyGraph(marks: marks, edges: edges, taskCount: folded ? 900 : 5)
    }

    // MARK: the plan, by level

    func testATaskIsNamedByTheMarkerItsTitleOpensWith() {
        XCTAssertEqual(StartProject.planTaskLabel("A · 提醒规则做成两端共用的真源"), "A")
        XCTAssertEqual(StartProject.planTaskLabel("① 服务端 · 开工门"), "①")
        XCTAssertEqual(StartProject.planTaskLabel("B：OrbitKit 接口"), "B")
        XCTAssertEqual(StartProject.planTaskLabel("12) wire the card"), "12")
        XCTAssertEqual(StartProject.planTaskLabel("Fix login redirect"), "Fix login redirect")
        // "A new card" opens with a word, not a marker.
        XCTAssertEqual(StartProject.planTaskLabel("A new card for the start"), "A new card for the start")
        XCTAssertEqual(StartProject.planTaskLabel(String(repeating: "x", count: 40)),
                       String(repeating: "x", count: 23) + "…")
        // Three digits are not a marker, and a dash with no space after it is part of a word.
        XCTAssertEqual(StartProject.planTaskLabel("123) three"), "123) three")
        XCTAssertEqual(StartProject.planTaskLabel("E -mail"), "E -mail")
        XCTAssertEqual(StartProject.planTaskLabel("E - mail"), "E")
        // A capital, one or two digits and at most one small letter is a code, and a space after it
        // is enough.
        XCTAssertEqual(StartProject.planTaskLabel("P1 Web：合并 Runners 与 Providers 为 Infrastructure 页"), "P1")
        XCTAssertEqual(StartProject.planTaskLabel("P5：接通 Web、macOS 和 iOS 的 DeepSeek Harness 操作链"), "P5")
        XCTAssertEqual(StartProject.planTaskLabel("D12. wire the card"), "D12")
        XCTAssertEqual(StartProject.planTaskLabel("P1a · wiki-worker 服务骨架与 System model 客户端"), "P1a")
        XCTAssertEqual(StartProject.planTaskLabel("P12c: the third part"), "P12c")
        XCTAssertEqual(StartProject.planTaskLabel("v2 API changes"), "v2 API changes")
        XCTAssertEqual(StartProject.planTaskLabel("P123 three"), "P123 three")
        XCTAssertEqual(StartProject.planTaskLabel("P1ab two letters"), "P1ab two letters")
        // The rest of a title, once the plan names it by its label.
        XCTAssertEqual(StartProject.planTaskRest("P1a · wiki-worker 服务骨架", label: "P1a"), "wiki-worker 服务骨架")
        XCTAssertEqual(StartProject.planTaskRest("B：OrbitKit 接口", label: "B"), "OrbitKit 接口")
        XCTAssertEqual(StartProject.planTaskRest("Fix login redirect", label: "Fix login redirect"),
                       "Fix login redirect")
    }

    func testEachTaskSitsOneLevelAfterTheDeepestOfWhatItWaitsOn() {
        let graph = self.graph()
        let tasks = graph.marks.map { mark in
            StartPlanTask(id: mark.id, title: mark.title,
                          after: graph.edges.filter { $0.targetMarkId == mark.id }.map(\.sourceMarkId),
                          completionCriterion: mark.completionCriterion,
                          autoRunWhenReady: mark.autoRunWhenReady)
        }
        let levels = StartProject.planLevels(tasks)
        XCTAssertEqual(levels.map { $0.map(\.label) }, [["A"], ["B", "C"], ["D"], ["E"]])
        XCTAssertEqual(levels.first?.first?.now, true, "the first level starts with the project")
        XCTAssertEqual(levels.last?.first?.you, true, "the go-live is the owner's to confirm")
        // A task set to start by hand does not start with the project.
        XCTAssertEqual(StartProject.planLevels([
            StartPlanTask(id: "x", title: "X · one", autoRunWhenReady: false),
        ]).first?.first?.now, false)
        // A prerequisite outside the plan — settled work, another project — waits on nothing here.
        XCTAssertEqual(StartProject.planLevels([
            StartPlanTask(id: "x", title: "X · one", after: ["elsewhere"]),
        ]).count, 1)
        // A cycle the server would never have allowed is cut rather than followed.
        XCTAssertFalse(StartProject.planLevels([
            StartPlanTask(id: "x", title: "X · one", after: ["y"]),
            StartPlanTask(id: "y", title: "Y · two", after: ["x"]),
        ]).isEmpty)
        XCTAssertEqual(StartProject.planHead(5, levels: 4), "Plan · 5 tasks in 4 levels")
        XCTAssertEqual(StartProject.planHead(5), "Plan · 5 tasks")
        XCTAssertEqual(StartProject.planHead(1), "Plan · 1 task")
        XCTAssertEqual(StartProject.inParallel(5), "5 in parallel")
    }

    func testThePlanIsReadOffTheGraphWithWhoConfirmsWhatAndWhatStartsNow() {
        let view = StartProject.planView(graph: graph(), fallbackCount: 0)
        XCTAssertEqual(view.count, 5)
        XCTAssertEqual(view.levels?.map { $0.map(\.label) }, [["A"], ["B", "C"], ["D"], ["E"]])
        XCTAssertEqual(view.ownerConfirmed, [StartPlanNamedTask(label: "E", title: "上线")])
        XCTAssertEqual(view.evidenceJudged, 4)
        XCTAssertEqual(view.startsNow, ["A"])
    }

    /// A folded plan is too big to list: it says how many and nothing about their order.
    func testAFoldedPlanSaysHowManyAndNothingAboutTheirOrder() {
        let folded = StartProject.planView(graph: graph(folded: true), fallbackCount: 0)
        XCTAssertEqual(folded.count, 900)
        XCTAssertNil(folded.levels)
        XCTAssertEqual(folded.startsNow, [])
        // …and a graph that has not been read says the project's own count.
        let unread = StartProject.planView(graph: nil, fallbackCount: 5)
        XCTAssertEqual(unread.count, 5)
        XCTAssertNil(unread.levels)
        // Cancelled work is not part of the plan; settled work runs nothing, so has no place in it.
        let settled = ProjectDependencyGraph(marks: [
            .task(id: "a", title: "A · one", status: "DONE"),
            .task(id: "b", title: "B · two", status: "OPEN"),
            .task(id: "c", title: "C · three", status: "CANCELLED"),
        ], edges: [ProjectGraphEdge(sourceMarkId: "a", targetMarkId: "b")])
        let view = StartProject.planView(graph: settled, fallbackCount: 0)
        XCTAssertEqual(view.count, 2)
        XCTAssertEqual(view.levels?.map { $0.map(\.label) }, [["B"]])
        XCTAssertEqual(view.startsNow, ["B"])
    }

    /// The plan is the project page's task graph while the whole of it fits the card at
    /// `planGraphMinFit` or better, top to bottom; otherwise the card lists it by level
    /// (docs/mocks/start-card-web-width, board 02).
    func testThePlanIsDrawnAsTheTaskGraphOnlyWhileTheWholeOfItFitsTheCard() throws {
        let drawn = try XCTUnwrap(StartProject.planGraph(graph(), availableWidth: 700))
        XCTAssertEqual(drawn.layout.direction, .topToBottom)
        XCTAssertEqual(Set(drawn.layout.placements.map(\.mark.id)),
                       ["task-a", "task-b", "task-c", "task-d", "task-e"])
        XCTAssertEqual(drawn.edges.count, 5)
        XCTAssertGreaterThanOrEqual(drawn.scale, StartProject.planGraphMinFit)
        // A card that would have to shrink it past the line lists it; one that just reaches the line
        // draws it.
        let width = drawn.layout.width
        XCTAssertNil(StartProject.planGraph(graph(), availableWidth: width * (StartProject.planGraphMinFit - 0.05)))
        XCTAssertNotNil(StartProject.planGraph(graph(), availableWidth: width * StartProject.planGraphMinFit))
        // Never a plan the server folded or cut short, nor one not read yet or a card not measured yet.
        XCTAssertNil(StartProject.planGraph(graph(folded: true), availableWidth: 700))
        let cut = ProjectDependencyGraph(marks: graph().marks, edges: graph().edges, truncated: true)
        XCTAssertNil(StartProject.planGraph(cut, availableWidth: 700))
        XCTAssertNil(StartProject.planGraph(nil, availableWidth: 700))
        XCTAssertNil(StartProject.planGraph(graph(), availableWidth: 0))
    }

    // MARK: what still comes to the owner

    func testWithAutomaticOnTheOwnerKeepsTheTasksTheyConfirmTheCriteriaAndWhatCannotBeResolved() {
        let p10 = [StartPlanNamedTask(label: "P10", title: "本部署切换到服务端执行")]
        XCTAssertEqual(StartProject.comesToYou(automatic: true, line: .projectBranch, ownerConfirmed: p10,
                                               evidenceJudged: 11, escalationSeconds: 7_200), [
            .init(text: "P10 · 本部署切换到服务端执行", detail: "you confirm it"),
            .init(text: "Any change to the criteria"),
            .init(text: "Problems it can’t resolve within 2 h"),
        ])
        // Directly into main, every merge asks the owner whoever runs the project.
        XCTAssertEqual(StartProject.comesToYou(automatic: true, line: .main, ownerConfirmed: [],
                                               evidenceJudged: 0, escalationSeconds: 1_800).map(\.text),
                       ["Each merge into main", "Any change to the criteria",
                        "Problems it can’t resolve within 30 min"])
    }

    func testWithAutomaticOffEveryDecisionTheCoordinatorWouldHaveMadeComesToTheOwner() {
        let p10 = [StartPlanNamedTask(label: "P10", title: "本部署切换到服务端执行")]
        XCTAssertEqual(StartProject.comesToYou(automatic: false, line: .projectBranch, ownerConfirmed: p10,
                                               evidenceJudged: 11, escalationSeconds: 7_200), [
            .init(text: "Whether each task is done", detail: "11 reviews"),
            .init(text: "P10 · 本部署切换到服务端执行", detail: "you confirm it"),
            .init(text: "Problems along the way", detail: "conflicts, failed checks"),
            .init(text: "Merging the branch into main"),
            .init(text: "Any change to the criteria"),
        ])
        XCTAssertEqual(StartProject.comesToYou(automatic: false, line: .main, ownerConfirmed: [],
                                               evidenceJudged: 0, escalationSeconds: 7_200).first,
                       .init(text: "Whether each task is done"))
        let many = ["A", "B", "C", "D"].map { StartPlanNamedTask(label: $0, title: "\($0) task") }
        XCTAssertEqual(StartProject.comesToYou(automatic: true, line: .projectBranch, ownerConfirmed: many,
                                               evidenceJudged: 0, escalationSeconds: 7_200).first,
                       .init(text: "4 tasks you confirm"))
        XCTAssertEqual(StartProject.within(seconds: 7_200), "2 h")
        XCTAssertEqual(StartProject.within(seconds: 5_400), "2 h")
        XCTAssertEqual(StartProject.within(seconds: 600), "10 min")
        XCTAssertEqual(StartProject.reviews(1), "1 review")
    }

    // MARK: the words that are built

    func testTheHeaderTheNoteAndTheLineUnderStartMatchTheBrowsersExamples() {
        XCTAssertEqual(StartProject.askedLine("56m ago"), "The coordinator asked 56m ago")
        XCTAssertEqual(StartProject.nobodyAskedLine(hasCoordinator: true), "Nobody asked yet")
        XCTAssertEqual(StartProject.nobodyAskedLine(hasCoordinator: false), "Nobody asked yet · no coordinator yet")
        XCTAssertEqual(StartProject.howItRunsNote(asked: true, suggestedOff: true),
                       "Automatic is on by default (the coordinator suggested off). The rest is the "
                           + "coordinator’s suggestion. You can change any of these later on the project page.")
        XCTAssertEqual(StartProject.howItRunsNote(asked: false, suggestedOff: false),
                       "Automatic is on by default. You can change any of these later on the project page.")
        XCTAssertEqual(StartProject.barCaption(opensCoordinator: false, startsNow: ["P1a"], criteria: 7,
                                               seal: "7c1e9a42"),
                       "Starts P1a now · confirms these 7 criteria · seal 7c1e9a42")
        XCTAssertEqual(StartProject.barCaption(opensCoordinator: true, startsNow: ["P1a"], criteria: 7,
                                               seal: "7c1e9a42"),
                       "Opens a coordinator · starts P1a now · confirms these 7 criteria")
        XCTAssertEqual(StartProject.barCaption(opensCoordinator: false, startsNow: [], criteria: 1, seal: "abc"),
                       "Confirms this criterion · seal abc")
        XCTAssertEqual(StartProject.barCaption(opensCoordinator: false, startsNow: ["A", "B", "C"],
                                               criteria: 2, seal: "abc"),
                       "Starts A, B and C now · confirms these 2 criteria · seal abc")
        XCTAssertEqual(StartProject.doneWhenHead(4), "Done when · 4 criteria")
        XCTAssertEqual(StartProject.doneWhenHead(1), "Done when · 1 criterion")
    }

    func testTheSettingsAStartLeftAreSaidInOneLine() {
        XCTAssertEqual(RunSettings.shortBranch("refs/heads/project/34WvwUS8YMXfOfWbMqVuu"),
                       "project/34Wvw…")
        XCTAssertEqual(RunSettings.shortBranch("refs/heads/release/next"), "release/next")
        XCTAssertEqual(RunSettings.shortBranch("project/short"), "project/short")
        XCTAssertEqual(RunSettings.line(request().settings),
                       "project/34Wvw… · Automatic on · 3 tasks at a time · merge check set")
        XCTAssertEqual(RunSettings.line(ProjectStartSettings(line: .main, automatic: false,
                                                             maxConcurrentTasks: 1)),
                       "Directly into main · Automatic off · 1 task at a time · no merge check")
        XCTAssertEqual(RunSettings.line(ProjectStartSettings(line: .projectBranch, automatic: true,
                                                             maxConcurrentTasks: 2)),
                       "A project branch · Automatic on · 2 tasks at a time · no merge check")
        // What the owner changed is marked where it stands, and said aloud for a reader who cannot
        // see which part is bold.
        let parts = RunSettings.parts(request().settings, differs: [.automatic])
        XCTAssertEqual(parts.map(\.differs), [false, true, false, false])
        XCTAssertEqual(RunSettings.spokenLine(request().settings, differs: [.automatic]),
                       "project/34Wvw… · Automatic on (Not what the coordinator suggested) · "
                           + "3 tasks at a time · merge check set")
    }

    func testTheAutomaticSentenceFollowsTheLineAndTheMergeCheck() {
        // The start card's own sentence, for the switch, the line and the merge check.
        XCTAssertEqual(RunSettings.automaticSays(automatic: true, line: .projectBranch, hasMergeCheck: true),
                       RunSettings.automaticOnChecked)
        XCTAssertEqual(RunSettings.automaticSays(automatic: true, line: .projectBranch, hasMergeCheck: false),
                       RunSettings.automaticOnUnchecked)
        XCTAssertEqual(RunSettings.automaticSays(automatic: true, line: .main, hasMergeCheck: true),
                       RunSettings.automaticOnMain)
        XCTAssertEqual(RunSettings.automaticSays(automatic: false, line: .projectBranch, hasMergeCheck: true),
                       RunSettings.automaticOff)
        XCTAssertEqual(RunSettings.automaticSays(automatic: false, line: .main, hasMergeCheck: false),
                       RunSettings.automaticOffMain)
        // How it runs after the start keeps its own sentence and its amber row.
        XCTAssertEqual(RunSettings.automaticHint(.projectBranch), RunSettings.automaticHintProjectBranch)
        XCTAssertEqual(RunSettings.automaticHint(.main), RunSettings.automaticHintMain)
        XCTAssertTrue(RunSettings.mergeCheckMissing(line: .projectBranch, automatic: true,
                                                    mergeCheckCommand: "   "))
        XCTAssertFalse(RunSettings.mergeCheckMissing(line: .main, automatic: true, mergeCheckCommand: nil))
        XCTAssertEqual(RunSettings.tasksAtATime(1), "task at a time")
        XCTAssertEqual(RunSettings.tasksAtATime(3), "tasks at a time")
        // An empty merge check is a setting like any other on the start card.
        var draft = StartSettingsDraft(request().settings)
        XCTAssertTrue(draft.hasMergeCheck)
        draft.mergeCheckCommand = "   "
        XCTAssertFalse(draft.hasMergeCheck)
    }

    /// Delegating is the owner's default: the draft opens with Automatic on whatever was suggested.
    func testTheDraftOpensWithAutomaticOnWhateverTheCoordinatorSuggested() {
        let suggestedOff = ProjectStartSettings(line: .projectBranch, automatic: false, maxConcurrentTasks: 3,
                                                mergeCheckCommand: "npm test")
        XCTAssertEqual(StartSettingsDraft(suggestedOff),
                       StartSettingsDraft(line: .projectBranch, automatic: true, maxConcurrentTasks: 3,
                                          mergeCheckCommand: "npm test"))
    }

    // MARK: what a press sends

    private func object(_ body: StartProjectRequestBody) throws -> [String: Any] {
        let data = try JSONEncoder().encode(body)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// The seal it was asked about, every setting as the card shows it, and the request — with the
    /// merge check and the request sent either way (the door requires the key), and the branch only
    /// with a project branch (the door refuses it otherwise).
    func testAPressSendsTheSealEverySettingAndTheRequest() throws {
        var draft = StartSettingsDraft(request().settings)
        draft.automatic = false
        draft.maxConcurrentTasks = 5
        draft.mergeCheckCommand = "  npm test  "
        let branch = try object(StartProject.body(request: request(), draft: draft,
                                                  requestId: "item-1"))
        XCTAssertEqual(branch["criteriaDigest"] as? String, Self.seal)
        XCTAssertEqual(branch["line"] as? String, "PROJECT_BRANCH")
        XCTAssertEqual(branch["projectBranchName"] as? String, "refs/heads/project/\(Self.project)")
        XCTAssertEqual(branch["automatic"] as? Bool, false)
        XCTAssertEqual(branch["maxConcurrentTasks"] as? Int, 5)
        XCTAssertEqual(branch["mergeCheckCommand"] as? String, "npm test")
        XCTAssertEqual(branch["requestId"] as? String, "item-1")
        XCTAssertEqual(Set(branch.keys), ["criteriaDigest", "line", "projectBranchName", "automatic",
                                          "maxConcurrentTasks", "mergeCheckCommand", "requestId"])

        draft = StartSettingsDraft(line: .main, automatic: true, maxConcurrentTasks: 3,
                                   mergeCheckCommand: "   ")
        let main = try object(StartProject.body(request: request(), draft: draft,
                                                requestId: nil))
        XCTAssertEqual(main["line"] as? String, "MAIN")
        XCTAssertNil(main["projectBranchName"], "directly into main names no branch")
        XCTAssertTrue(main["mergeCheckCommand"] is NSNull, "a blank check is none, and says so")
        XCTAssertTrue(main["requestId"] is NSNull)
    }

    func testTheDraftIsCompleteOnlyInsideTheDoorsLimits() {
        var draft = StartSettingsDraft(request().settings)
        XCTAssertTrue(draft.complete)
        draft.maxConcurrentTasks = 0
        XCTAssertFalse(draft.complete)
        draft.maxConcurrentTasks = StartProject.maxConcurrentTasks + 1
        XCTAssertFalse(draft.complete)
        draft.maxConcurrentTasks = StartProject.maxConcurrentTasks
        XCTAssertTrue(draft.complete)
        XCTAssertEqual(StartProject.branch(request(), projectID: Self.project), "project/\(Self.project)")
    }

    // MARK: the reads

    private func openItems(_ json: String) throws -> ProjectOpenItemsView {
        try JSONDecoder().decode(ProjectOpenItemsView.self, from: Data(json.utf8))
    }

    private func requestRow(_ itemId: String, line: String = "PROJECT_BRANCH",
                            digest: String = seal) -> String {
        """
        {"itemId":"\(itemId)","kind":"START_REQUEST","title":"Start this project?","detailLine":"",
         "assignee":"OWNER","assigneeReason":"DEFAULT","waitingSince":"2026-09-29T08:24:00.000Z",
         "escalateAt":null,"escalatedAt":null,"taskId":null,"sessionId":null,"promotionId":null,
         "fuseEpisodeId":null,"delivery":{"state":"NOT_REQUIRED","sessionId":null,"at":null},
         "actions":[],"question":null,"facts":null,
         "startRequest":{"settings":{"line":"\(line)","projectBranchName":"refs/heads/project/p1",
           "automatic":true,"maxConcurrentTasks":3,"mergeCheckCommand":null},
           "why":"B and C build on A","criteriaDigest":"\(digest)","planDigest":"pp",
           "repository":null,"warnings":[{"severity":"WARN","code":"START_TASKS_START_BY_HAND",
             "message":"m","requiredAction":"r","criterion":null,
             "tasks":[{"taskId":"t1","title":"B · two"}]}]}}
        """
    }

    func testTheOpenItemsReadCarriesTheRequestBesideTheOtherItems() throws {
        let read = try openItems(#"{"needsYou":[],"withCoordinator":[],"startRequest":"#
                                 + requestRow("item-1") + "}")
        let row = try XCTUnwrap(read.startRequest)
        XCTAssertEqual(row.itemId, "item-1")
        let asked = try XCTUnwrap(row.startRequest)
        XCTAssertEqual(asked.settings.line, .projectBranch)
        XCTAssertNil(asked.settings.mergeCheckCommand)
        XCTAssertEqual(asked.warnings.first?.tasks, [ProjectStartFinding.Task(taskId: "t1", title: "B · two")])

        // A server that predates start requests, and a request naming a line this build does not
        // know: neither takes the read down — the second is an item with no request on it.
        XCTAssertNil(try openItems(#"{"needsYou":[],"withCoordinator":[]}"#).startRequest)
        let unknown = try openItems(#"{"needsYou":[],"withCoordinator":[],"startRequest":"#
                                    + requestRow("item-2", line: "SIDEWAYS") + "}")
        XCTAssertEqual(unknown.startRequest?.itemId, "item-2")
        XCTAssertNil(unknown.startRequest?.startRequest)
        XCTAssertNil(StartProject.live(openItems: unknown, started: false),
                     "a request this build cannot read is not a card it can draw")
    }

    func testTheCardIsAskedOnlyOfAProjectNobodyHasStartedAndOnlyOnARequest() throws {
        let read = try openItems(#"{"needsYou":[],"withCoordinator":[],"startRequest":"#
                                 + requestRow("item-1") + "}")
        XCTAssertEqual(StartProject.live(openItems: read, started: false)?.itemId, "item-1")
        XCTAssertNil(StartProject.live(openItems: read, started: true),
                     "a started project has nothing to start")
        XCTAssertNil(StartProject.live(openItems: read, started: nil),
                     "and a project nobody could read is not one to offer a start to")
        XCTAssertNil(StartProject.live(openItems: nil, started: false))
        XCTAssertNil(StartProject.live(openItems: ProjectOpenItemsView(), started: false),
                     "no request, no card — however many tasks the project holds")
    }

    private func standing(_ digest: String) -> StandardSetConfirmationStanding {
        StandardSetConfirmationStanding(
            state: .unconfirmed, confirmed: false,
            currentVersion: StandardSetVersion(digest: digest, material: []))
    }

    func testADeliveredCardGoesStaleWhenItsRequestNoLongerStands() throws {
        let read = try openItems(#"{"needsYou":[],"withCoordinator":[],"startRequest":"#
                                 + requestRow("item-1") + "}")
        let asked = try XCTUnwrap(read.startRequest?.startRequest)
        func standingOf(_ item: String, _ items: ProjectOpenItemsView?,
                        _ confirmation: StandardSetConfirmationStanding?,
                        _ started: Bool?) -> StartProject.Standing {
            StartProject.standing(itemID: item, request: asked, openItems: items,
                                  confirmation: confirmation, started: started)
        }
        XCTAssertEqual(standingOf("item-1", read, standing(Self.seal), false), .live)
        // Replaced by a newer request, withdrawn, or naming a seal the criteria have moved past.
        XCTAssertEqual(standingOf("item-0", read, standing(Self.seal), false), .gone)
        XCTAssertEqual(standingOf("item-1", ProjectOpenItemsView(), standing(Self.seal), false), .gone)
        XCTAssertEqual(standingOf("item-1", read, standing(Self.moved), false), .gone)
        // A read that has not answered names no version to start on.
        XCTAssertEqual(standingOf("item-1", nil, standing(Self.seal), false), .unread)
        XCTAssertEqual(standingOf("item-1", read, nil, false), .unread)
        XCTAssertEqual(standingOf("item-1", read, standing(Self.seal), nil), .unread)

        XCTAssertNil(StartProject.staleExplanation(.live))
        XCTAssertEqual(StartProject.staleExplanation(.gone), StartProject.requestGone)
        XCTAssertEqual(StartProject.staleExplanation(.unread), AcceptanceConfirmations.staleExplanation(nil))
        XCTAssertTrue(StartProject.isOpen(.live))
        XCTAssertTrue(StartProject.isOpen(.unread), "a failed read is this device's problem, not an answer")
        XCTAssertFalse(StartProject.isOpen(.gone), "a request that no longer stands is not pointed at")
    }

    // MARK: what a start leaves, read back

    func testAStartsRecordIsReadOffTheConfirmationAndSaysStarted() throws {
        let json = """
        {"criteriaDigest":"\(Self.seal)","criteriaMaterial":[{"definitionId":"d1","revision":1,"contentHash":"h1"}],
         "confirmedAt":"2026-09-29T08:26:00.000Z","confirmedById":"u1",
         "startedWith":{"settings":{"line":"PROJECT_BRANCH","projectBranchName":"refs/heads/project/\(Self.project)",
           "automatic":true,"maxConcurrentTasks":3,"mergeCheckCommand":"npm test"},
           "differsFromRequest":["automatic","somethingNew","line"]}}
        """
        let record = try JSONDecoder().decode(RecordedStandardSetConfirmation.self, from: Data(json.utf8))
        let started = try XCTUnwrap(record.startedWith)
        XCTAssertEqual(started.differsFromRequest, [.line, .automatic],
                       "in card order, and nothing this build has no words for")
        XCTAssertEqual(AcceptanceConfirmations.receiptLine(record),
                       "You started the project on 1 criteria at seal c2b4e16c4b59")
        XCTAssertEqual(AcceptanceConfirmations.receiptLine(record, changed: "1 new"),
                       AcceptanceConfirmations.confirmedLine(record),
                       "what a re-confirmation changed is not said on a start")

        // One that started nothing — or one a server older than this build wrote — says confirmed.
        let plain = try JSONDecoder().decode(RecordedStandardSetConfirmation.self, from: Data("""
        {"criteriaDigest":"\(Self.seal)","criteriaMaterial":[],"confirmedAt":"2026-09-29T10:13:00.000Z",
         "confirmedById":"u1","startedWith":null}
        """.utf8))
        XCTAssertNil(plain.startedWith)
        XCTAssertEqual(AcceptanceConfirmations.receiptLine(plain, changed: "1 new, 1 stricter"),
                       "You confirmed 0 criteria at seal c2b4e16c4b59 — 1 new, 1 stricter")
        XCTAssertEqual(AcceptanceConfirmations.receiptLine(plain),
                       "You confirmed 0 criteria at seal c2b4e16c4b59")
        // Settings this build cannot read are a record without them, never a read that fails.
        let odd = try JSONDecoder().decode(RecordedStandardSetConfirmation.self, from: Data("""
        {"criteriaDigest":"\(Self.seal)","criteriaMaterial":[],"confirmedAt":"2026-09-29T10:13:00.000Z",
         "confirmedById":"u1","startedWith":{"settings":{"line":"SIDEWAYS"}}}
        """.utf8))
        XCTAssertNil(odd.startedWith)
    }

    func testTheProjectStartedCardCarriesTheSettingsItWasStartedWith() {
        let card = ProjectStarted.parseCard(.object([
            "by": .string("CONFIRMATION"),
            "projectId": .string("p1"),
            "projectTitle": .string("Aurora"),
            "criteriaCount": .int(4),
            "held": .array([]),
            "heldCount": .int(0),
            "settings": .object([
                "line": .string("PROJECT_BRANCH"),
                "projectBranchName": .string("refs/heads/project/\(Self.project)"),
                "automatic": .bool(true),
                "maxConcurrentTasks": .int(3),
                "mergeCheckCommand": .null,
            ]),
            "differsFromRequest": .array([.string("maxConcurrentTasks"), .string("line")]),
        ]))
        XCTAssertEqual(card?.settings?.line, .projectBranch)
        XCTAssertEqual(card?.differsFromRequest, [.line, .maxConcurrentTasks])
        XCTAssertEqual(card.flatMap { $0.settings.map(RunSettings.line) },
                       "project/34Wvw… · Automatic on · 3 tasks at a time · no merge check")

        // Settings it cannot read are left off whole, and the card is still the card.
        let odd = ProjectStarted.parseCard(.object([
            "by": .string("CONFIRMATION"), "projectId": .string("p1"), "projectTitle": .string("Aurora"),
            "settings": .object(["line": .string("MAIN"), "automatic": .string("yes")]),
            "differsFromRequest": .array([.string("line")]),
        ]))
        XCTAssertNotNil(odd)
        XCTAssertNil(odd?.settings)
        XCTAssertEqual(odd?.differsFromRequest, [])

        // A card the cache wrote before settings existed still reads back.
        let cached = try? JSONDecoder().decode(ProjectStarted.self, from: Data("""
        {"by":"CONFIRMATION","projectId":"p1","projectTitle":"Aurora","criteriaCount":4,
         "held":[],"heldCount":0}
        """.utf8))
        XCTAssertEqual(cached?.projectTitle, "Aurora")
        XCTAssertNil(cached?.settings)
    }

    /// "Started" is the project's own `startedAt`, with a third answer for a read that did not say.
    func testStartedIsReadOffStartedAtAndNotOffAutomatic() throws {
        func document(_ json: String) throws -> ProjectCriteriaDocument {
            try JSONDecoder().decode(ProjectCriteriaDocument.self, from: Data(json.utf8))
        }
        XCTAssertEqual(try document(#"{"id":"p1","coordinatorEnabled":true,"startedAt":null}"#).started,
                       false, "Automatic on is not started")
        XCTAssertEqual(try document(#"{"id":"p1","coordinatorEnabled":false,"startedAt":"2026-09-29T08:26:00.000Z"}"#).started,
                       true, "and Automatic off is not unstarted")
        XCTAssertNil(try document(#"{"id":"p1","coordinatorEnabled":true}"#).started,
                     "a read that did not carry the field says neither")
    }

    func testASessionWaitingOnAStartSaysReadyToStart() throws {
        let kind = try JSONDecoder().decode([SessionWaitingKind].self,
                                            from: Data(#"["START_REQUEST"]"#.utf8))
        XCTAssertEqual(kind, [.startRequest])
        let waiting = Session(id: "s", title: "t", status: .awaitingInput, runStatus: nil,
                              sessionState: nil, runState: nil, lifecycleState: nil, agentId: nil,
                              assignedRunnerId: nil, pendingApprovals: 1, waitingKind: .startRequest,
                              ownerItems: nil, branch: nil, updatedAt: nil)
        XCTAssertEqual(SessionHeader.waitingWord(for: waiting), StartProject.readyToStart)
        XCTAssertEqual(SessionLine.make(for: waiting, live: true).text, "Ready to start")
    }
}
