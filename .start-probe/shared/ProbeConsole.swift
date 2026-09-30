import SwiftUI
import Observation
import OrbitKit

// TEMPORARY evidence probe (see ../README.md). The stand-in for the app's `ConsoleModel`: the members
// the start card, the change card and the receipt read and press — each answered by OrbitKit's own
// derivations (`StartProject.standing`, `StartProject.body`, `CriteriaChanges`…) over the data of
// the mocks, so what is drawn is what the real console would derive from the same reads. The presses
// move the probe to the state the door's answer and the reads after it would leave, and record what
// they would have sent.

enum ProbeData {
    static let projectID = "34WvwUS8YMXfOfWbMqVuu"
    static let title = "Runner 页整页改版（iOS/macOS + web）"
    static let itemID = "35AqStartReq0000000001"
    static let seal = "c2b4e16c4b59" + String(repeating: "0", count: 52)
    static let newSeal = "7d1e03a9c2f4" + String(repeating: "7", count: 52)

    static func iso(_ offset: TimeInterval) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date().addingTimeInterval(offset))
    }

    static let texts = [
        "提醒规则两端同一套，且只在有东西依赖它时提醒：web（TS）与 OrbitKit（Swift）对同一个用例文件算出相同的提醒（种类、顺序、列表短句、详情标题、动作种类）",
        "web：/runners 卡片与 /runners/:id 详情页按效果图 web.png（区块、顺序、文案；桌面 1440 两栏、443px 一栏且顺序同 iOS）",
        "iOS/macOS：设置里的 Runners 列表按效果图 ios-list.png（标题中性色不再是 tint、行尾 N/M 槽位条、第二行主机名 · 版本）",
        "上线：本项目改动合入 main，web 与 apiserver 部署到线上，iOS/macOS 发一个 beta；owner 在 iPhone 与 web 上确认与效果图一致",
    ]
    static let fifth = "macOS：设置 → Runners 与 iOS 同结构（同一套 OrbitKit 视图），截图与 ios-list.png 并排提交"

    static func criteria(_ count: Int) -> [ProjectCriteriaDocument.Item] {
        (texts + [fifth]).prefix(count).enumerated().map {
            ProjectCriteriaDocument.Item(id: "c\($0.offset + 1)", ordinal: $0.offset + 1, text: $0.element)
        }
    }

    static func material(_ count: Int) -> [ConfirmedCriterionVersion] {
        (1...count).map { ConfirmedCriterionVersion(definitionId: "c\($0)", revision: 1, contentHash: "h\($0)") }
    }

    static let tasks = [
        ("task-a", "A · 提醒规则做成两端共用的真源"),
        ("task-b", "B · OrbitKit：提醒规则、文案、DTO 与接口"),
        ("task-c", "C · web：Runners 列表与 runner 详情页按效果图改版"),
        ("task-d", "D · iOS/macOS：Runners 列表、Add Runner、Edit"),
        ("task-e", "E · 上线：合入 main、部署、发 beta"),
    ]

    /// The plan of the mock: A, then B and C, then D after B, then E after C and D.
    static let graph = ProjectDependencyGraph(
        marks: tasks.map { ProjectGraphMark.task(id: $0.0, title: $0.1, status: "OPEN") },
        edges: [("task-a", "task-b"), ("task-a", "task-c"), ("task-b", "task-d"),
                ("task-c", "task-e"), ("task-d", "task-e")]
            .map { ProjectGraphEdge(sourceMarkId: $0.0, targetMarkId: $0.1) },
        taskCount: 5)

    /// The coordinator's request, as the open-items read serves it — B–E really were filed to start
    /// by hand, which is the ready check's warning.
    static func request(mergeCheck: String?) -> ProjectStartRequest {
        ProjectStartRequest(
            settings: ProjectStartSettings(line: .projectBranch,
                                           projectBranchName: "refs/heads/project/\(projectID)",
                                           automatic: true, maxConcurrentTasks: 3,
                                           mergeCheckCommand: mergeCheck),
            why: "B、C 都依赖 A：一条项目分支先把它们放在一起检查，再进 main。",
            criteriaDigest: seal,
            planDigest: String(repeating: "p", count: 64),
            repository: "https://github.com/jianghailong-xy/orbit.git",
            warnings: [ProjectStartFinding(
                code: "START_TASKS_START_BY_HAND",
                message: "4 tasks are set to start by hand",
                tasks: tasks.dropFirst().map { ProjectStartFinding.Task(taskId: $0.0, title: $0.1) })])
    }

    static func row(mergeCheck: String?) -> ProjectOpenItemRow {
        ProjectOpenItemRow(itemId: itemID, kind: .unknown, title: StartProject.title,
                           waitingSince: iso(-20), startRequest: request(mergeCheck: mergeCheck))
    }

    static let coordinatorAsks =
        "计划写好了：5 个任务、4 条判据。A 先把提醒规则做成两端共用的真源，B、C 在 A 上并行，D 等 B，E 最后上线验收。我已经请 Orbit 发起启动，设置按我的建议填好了，你可以直接在卡上改。"
    static let coordinatorStarted =
        "开工了。A 已经在跑；B–E 会在各自的前置落到项目分支后由我启动。要让它们自己开，回我一句就行。"
    static let coordinatorChanged =
        "加了第 5 条（macOS 与 iOS 同结构单独验收），第 2 条的核对从「你确认截图」改成跑 RunnersPage 的测试。活没停，C 还在跑。"
    static let coordinatorConfirmed = "收到。给第 5 条建了任务 F（macOS 视图接线 + 截图），挂在 D 后面。"
}

@MainActor
@Observable
final class ConsoleModel {
    enum Stage: String { case start, started, change, confirmed }

    var stage: Stage
    let projectID: String? = ProbeData.projectID
    let projectTitle = ProbeData.title
    var projectCriteria: [ProjectCriteriaDocument.Item]
    var projectTaskCount = 5
    var projectStarted: Bool? = false
    var openItems: ProjectOpenItemsView?
    var acceptanceConfirmation: StandardSetConfirmationStanding?
    var startRequestRow: ProjectOpenItemRow?
    var projectGraph: ProjectDependencyGraph? = ProbeData.graph
    private var drafts: [String: StartSettingsDraft] = [:]

    /// What the presses would have done, for the report and the pictures.
    var composerPlaceholder: String?
    var composerContext: String?
    var tasksOpened = false
    var sentBody: String?
    var startedRecord: RecordedStandardSetConfirmation?
    var startedCard: ProjectStarted?
    var confirmedRecord: RecordedStandardSetConfirmation?
    var confirmedSummary: String?

    init(stage: Stage, mergeCheck: String? = "cd src/web && npx tsc -b && npx vitest run") {
        self.stage = stage
        switch stage {
        case .start, .started:
            projectCriteria = ProbeData.criteria(4)
            let row = ProbeData.row(mergeCheck: mergeCheck)
            startRequestRow = row
            openItems = ProjectOpenItemsView(startRequest: row)
            acceptanceConfirmation = StandardSetConfirmationStanding(
                state: .unconfirmed, confirmed: false,
                currentVersion: StandardSetVersion(digest: ProbeData.seal,
                                                   material: ProbeData.material(4)))
        case .change, .confirmed:
            projectCriteria = ProbeData.criteria(5)
            projectStarted = true
            projectTaskCount = 6
            acceptanceConfirmation = StandardSetConfirmationStanding(
                state: .stale, confirmed: false,
                currentVersion: StandardSetVersion(digest: ProbeData.newSeal,
                                                   material: ProbeData.material(5)),
                confirmation: RecordedStandardSetConfirmation(
                    criteriaDigest: ProbeData.seal, criteriaMaterial: ProbeData.material(4),
                    confirmedAt: ProbeData.iso(-86_400), confirmedById: "u1"),
                changesSinceConfirmed: CriteriaChangesSinceConfirmed(
                    added: [CriterionAddedSinceConfirmed(key: "c5", ordinal: 5, text: ProbeData.fifth)],
                    stricter: [CriterionStricterSinceConfirmed(
                        key: "c2", ordinal: 2,
                        verificationMethod: "跑 RunnersPage / RunnerDetailPage 的 vitest，断言区块顺序与 Capacity 写入",
                        confirmedVerificationMethod: "owner 看截图确认")],
                    unchanged: [1, 3, 4]))
        }
        if stage == .started { Task { await startProject(itemID: ProbeData.itemID) } }
        if stage == .confirmed { Task { await confirmCriteriaChange() } }
    }

    func startStanding(_ itemID: String) -> StartProject.Standing {
        guard let row = startRequestRow, row.itemId == itemID, let request = row.startRequest
        else { return .gone }
        return StartProject.standing(itemID: itemID, request: request, openItems: openItems,
                                     confirmation: acceptanceConfirmation, started: projectStarted)
    }

    func startDraft(for row: ProjectOpenItemRow) -> StartSettingsDraft {
        if let draft = drafts[row.itemId] { return draft }
        guard let request = row.startRequest else {
            return StartSettingsDraft(line: .projectBranch, automatic: true, maxConcurrentTasks: 3)
        }
        return StartSettingsDraft(request.settings)
    }

    func setStartDraft(_ draft: StartSettingsDraft, for itemID: String) {
        drafts[itemID] = draft
    }

    /// The press: the body OrbitKit builds, recorded, and the state the door's answer leaves — the
    /// start's record with the settings as sent, and the Project started card its coordinator is
    /// shown, with what differs from the request marked.
    func startProject(itemID: String) async {
        guard let row = startRequestRow, let request = row.startRequest else { return }
        let draft = startDraft(for: row)
        let body = StartProject.body(request: request, draft: draft, requestId: itemID)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        sentBody = (try? encoder.encode(body)).flatMap { String(data: $0, encoding: .utf8) }
        try? await Task.sleep(nanoseconds: 300_000_000)
        let settings = ProjectStartSettings(line: body.line,
                                            projectBranchName: body.projectBranchName,
                                            automatic: body.automatic,
                                            maxConcurrentTasks: body.maxConcurrentTasks,
                                            mergeCheckCommand: body.mergeCheckCommand)
        let asked = request.settings
        var differs: [ProjectStartSettingKey] = []
        if asked.line != settings.line { differs.append(.line) }
        if asked.automatic != settings.automatic { differs.append(.automatic) }
        if asked.maxConcurrentTasks != settings.maxConcurrentTasks { differs.append(.maxConcurrentTasks) }
        if (asked.mergeCheckCommand ?? "") != (settings.mergeCheckCommand ?? "") { differs.append(.mergeCheckCommand) }
        let record = ProjectStartRecord(settings: settings, differsFromRequest: differs)
        startedRecord = RecordedStandardSetConfirmation(
            criteriaDigest: request.criteriaDigest, criteriaMaterial: ProbeData.material(4),
            confirmedAt: ProbeData.iso(0), confirmedById: "u1", startedWith: record)
        startedCard = ProjectStarted(
            by: .confirmation, projectId: "0195c0de-0000-7000-8000-000000000001",
            projectTitle: ProbeData.title, criteriaCount: 4,
            held: ProbeData.tasks.dropFirst().enumerated().map {
                ProjectStartedTask(id: "0195c0de-0000-7000-8000-00000000001\($0.offset)", title: $0.element.1)
            },
            heldCount: 4, settings: settings, differsFromRequest: differs)
        projectStarted = true
        stage = .started
    }

    func startPlanChangeReply(criteriaDigest: String, question: SettlementQuestion) {
        composerPlaceholder = AcceptanceConfirmations.planChangePlaceholder(for: question)
        composerContext = AcceptanceConfirmations.planChangeContext(
            projectTitle: projectTitle, criteriaDigest: criteriaDigest,
            criteria: projectCriteria.map(\.text), question: question)
    }

    func startPlanChangeReply(_ standing: StandardSetConfirmationStanding,
                              question: SettlementQuestion = .confirmation) {
        startPlanChangeReply(criteriaDigest: standing.currentVersion.digest, question: question)
    }

    @discardableResult
    func openCreatedTasks() -> Bool {
        tasksOpened = true
        return true
    }

    /// The change card's press: what it confirmed, for the receipt, and the confirmation the door
    /// records — which leaves nothing changed.
    func confirmCriteriaChange() async {
        guard let standing = acceptanceConfirmation, let changes = standing.changesSinceConfirmed
        else { return }
        try? await Task.sleep(nanoseconds: 300_000_000)
        confirmedSummary = CriteriaChanges.counts(changes)
        let record = RecordedStandardSetConfirmation(
            criteriaDigest: standing.currentVersion.digest, criteriaMaterial: ProbeData.material(5),
            confirmedAt: ProbeData.iso(0), confirmedById: "u1")
        confirmedRecord = record
        acceptanceConfirmation = StandardSetConfirmationStanding(
            state: .confirmed, confirmed: true, currentVersion: standing.currentVersion,
            confirmation: record,
            changesSinceConfirmed: CriteriaChangesSinceConfirmed(unchanged: [1, 2, 3, 4, 5]))
        stage = .confirmed
    }

    func confirmedChanges(_ confirmation: RecordedStandardSetConfirmation) -> String? {
        confirmation == confirmedRecord ? confirmedSummary : nil
    }
}

/// The one view of the app's note entry the Project started card can reach, with nothing to show:
/// the probe's cards carry no attached note.
struct AttachedNoteEntry: View {
    let attached: (kind: String, text: String)
    var body: some View { EmptyView() }
}
