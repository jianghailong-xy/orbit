import SwiftUI
import UIKit
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md). One screen per launch (`-screen <name>`), drawn by
// the app's own Wiki pages (Generated/WikiView.swift, copied whole) over the OrbitKit test fixtures,
// and the drawer's rows cut out of CompactShell.swift (Generated/DrawerProbe.swift).

@main
struct WikiProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeRoot() }
    }
}

/// The reads every screen draws, and the one "now" their times are measured from — the mocks' own
/// afternoon, so "12m ago" reads as it does there.
enum ProbeData {
    static let now = RelativeTime.parse("2026-09-25T13:00:00.000Z")!
    static let spaces = try! WikiFixtures.decode([WikiSpace].self, WikiFixtures.spaces)
    static let home = WikiHomeContent(
        space: try! WikiFixtures.decode(WikiSpace.self, WikiFixtures.space),
        spaces: spaces,
        entries: try! WikiFixtures.decode([WikiEntry].self, WikiFixtures.entries),
        timeline: (try! WikiFixtures.decode(WikiTimeline.self, WikiFixtures.timeline)).items ?? [],
        proposals: WikiLogic.proposalsToReview(spaces))
    static let detail = try! WikiFixtures.decode(WikiEntryDetail.self, WikiFixtures.entryDetail)
    static let cards = WikiLogic.reviewCards(try! WikiFixtures.decode([WikiChangeset].self, WikiFixtures.review))
    /// What the app's card store answers for the task and sessions the entry names (mock 08 ③ ⑤).
    static let sourceTitles: [String: String] = [
        "0196e000-0000-7000-8000-0000000000c1": "runner-go suite hit prod",
        "0196e000-0000-7000-8000-0000000000c2": "runner-go 的 task/project CLI 测试会串到线上：在 Orbit 会话里跑整包，11 个红、其中 1 个永远挂",
    ]
    static let sessionTitles: [String: String] = [
        "34TYUP5wb87XfuYCInJRY": "执行任务：runner 自动更新不得驱逐在跑回合",
        "34TcwNgAIo6tGUiIKjqnQ": "Orbit：给任务加优先级，让派发器看它",
    ]
    /// The entries the RETIRE and the AMEND name, as Review reads them.
    static let named: [String: WikiEntry] = [
        "34UDFnrgM4q5oWakeLost": WikiEntry(
            id: "34UDFnrgM4q5oWakeLost", kind: .pitfall, status: .active, trust: .confirmed, currentRevision: 1,
            title: "Claude's ScheduleWakeup is lost when the engine is recycled",
            summary: "A wakeup scheduled inside the engine dies with it."),
        "34UDFnrgM4q5oDeployXX": WikiEntry(
            id: "34UDFnrgM4q5oDeployXX", kind: .recipe, status: .active, trust: .confirmed, currentRevision: 3,
            title: "Deploy apiserver and web",
            summary: "Run /upgrade from a clean checkout.",
            fields: .object(["steps": .array([.string("Run /upgrade from a clean checkout")]),
                             "verify": .object(["command": .string("curl -fsS https://orbitd.io/api/health"),
                                                "expectedExit": .int(0)])])),
    ]
}

struct ProbeRoot: View {
    private var screen: String {
        let args = ProcessInfo.processInfo.arguments
        guard let at = args.firstIndex(of: "-screen"), at + 1 < args.count else { return "home" }
        return args[at + 1]
    }

    var body: some View {
        switch screen {
        case "drawer":        DrawerScreen()
        case "drawer-states": DrawerStatesScreen()
        case "entry":
            Pushed {
                WikiEntryPage(detail: ProbeData.detail, now: ProbeData.now,
                              sessionTitle: { ProbeData.sessionTitles[$0] },
                              sourceTitle: { source in source.ref.flatMap { ProbeData.sourceTitles[$0] } })
            }
        case "review":
            Pushed {
                WikiReviewPage(cards: ProbeData.cards, entry: { ProbeData.named[$0] }, now: ProbeData.now)
            }
        default:
            NavigationStack {
                WikiHomePage(content: ProbeData.home, now: ProbeData.now)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Image(systemName: "line.3.horizontal").accessibilityLabel("Open navigation")
                        }
                    }
            }
        }
    }
}

/// A page one level into its section's stack, so the bar carries the back button it has in the app.
struct Pushed<Page: View>: View {
    @ViewBuilder let page: () -> Page
    @State private var path = ["page"]

    var body: some View {
        NavigationStack(path: $path) {
            Text(WikiCopy.title)
                .navigationTitle(WikiCopy.title)
                .navigationDestination(for: String.self) { _ in page() }
        }
    }
}

// MARK: - the drawer

/// What the cut rows read off `AppModel`, and nothing else.
@Observable
final class ProbeDrawerModel {
    struct Nav { mutating func popToRoot() {} }
    final class Projects { var needsYouCount = 2 }
    final class Wiki {
        var proposalsToReview: Int
        init(_ count: Int) { proposalsToReview = count }
    }
    final class Tasks { func selectScope(_ scope: TaskScope) {} }

    var selectedSection: AppSection
    var sectionAtRoot = true
    var nav = Nav()
    var projects: Projects? = Projects()
    var wiki: Wiki?
    var selectedTaskID: String?
    var taskListsDirectoryPresented = false
    var tasks: Tasks? = Tasks()

    init(section: AppSection, proposals: Int) {
        selectedSection = section
        wiki = Wiki(proposals)
    }

    struct Workspace: Hashable {
        let name: String
        let runner: String
        let badge: Int
    }

    static let workspaces = [Workspace(name: "orbit", runner: "wikova", badge: 1),
                             Workspace(name: "wikids", runner: "wikova", badge: 0),
                             Workspace(name: "wikova-develop", runner: "mac-mini", badge: 0)]
    static let projects = ["把「什么算完成」从项目…", "Postgres 性能与容量治理", "落地可靠性：做出来的成…",
                           "Wikids AI 游戏模块：狼人杀 MVP"]
}

/// Mock 06 ①: the drawer open over the section, three proposals waiting.
struct DrawerScreen: View {
    var body: some View {
        GeometryReader { geo in
            let width = min(324, geo.size.width * 0.76)
            ZStack(alignment: .leading) {
                DrawerRail(model: ProbeDrawerModel(section: .agents, proposals: 3))
                    .frame(width: width)
                    .ignoresSafeArea(edges: .bottom)
                peek
                    .frame(width: geo.size.width)
                    .background(Color(uiColor: .systemBackground),
                                in: RoundedRectangle(cornerRadius: 36, style: .continuous))
                    .shadow(color: .black.opacity(0.45), radius: 26)
                    .offset(x: width)
                    .ignoresSafeArea()
            }
        }
    }

    /// The section the drawer opened over: the workspace's sessions (stand-in).
    private var peek: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: "line.3.horizontal").font(.title3).padding(.top, 70)
            Text("Search p…").foregroundStyle(.secondary)
            Text("Needs attention").font(.headline)
            ForEach(["把「什么算…", "Postgres 性…", "Wikids AI 游…"], id: \.self) { title in
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                    Text("Needs you ·").font(.subheadline).foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(.leading, 22)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Mock 06 ②: the row's three states — proposals waiting, none, and on the Wiki's page.
struct DrawerStatesScreen: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            state("有 3 条提议等你", ProbeDrawerModel(section: .agents, proposals: 3))
            state("没有提议 —— 不画数字", ProbeDrawerModel(section: .agents, proposals: 0))
            state("正在 Wiki 页 —— 选中底色，数字仍是橙色", ProbeDrawerModel(section: .wiki, proposals: 3))
            Spacer()
        }
        .padding(.top, 60)
        .background(Color(uiColor: UIColor(white: 0.976, alpha: 1)).ignoresSafeArea())
    }

    private func state(_ caption: String, _ model: ProbeDrawerModel) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(caption).font(.footnote).foregroundStyle(.secondary).padding(.leading, 22)
            DrawerRowProbe(model: model).frame(height: 56)
        }
    }
}
