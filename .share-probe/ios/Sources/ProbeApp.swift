import Foundation
import Observation
import OrbitKit
import SwiftUI

// TEMPORARY evidence probe (see ../../README.md). One throwaway iPhone app with three pages, each
// built around code gen.py cuts verbatim out of the app's own views — the project page's ⋯ menu, the
// task page's ⋯ menu, the session page's Share button — and the one ShareSheet all three open,
// copied in whole. `-probe project|task|session` picks the page.

@main
struct ShareProbeApp: App {
    var body: some Scene {
        WindowGroup {
            switch UserDefaults.standard.string(forKey: "probe") ?? "project" {
            case "task": TaskPageProbe()
            case "session": SessionPageProbe()
            default: ProjectPageProbe()
            }
        }
    }
}

/// What the menus, the reads and the sheets use off `AppModel`: the server (the stub), the token
/// store, the two signed-in addresses, and the toast a copy raises.
@Observable
final class ProbeAppModel {
    let baseURL: URL? = URL(string: "http://127.0.0.1:8787")
    let tokenStore: TokenStore = {
        let store = InMemoryTokenStore()
        store.setToken("probe", for: URL(string: "http://127.0.0.1:8787")!)
        return store
    }()
    var toast: String?

    func showToast(_ message: String) { toast = message }

    /// As `AppModel.projectWebURL` / `taskWebURL` build them, on the mock's host.
    func projectWebURL(_ projectID: String) -> URL? {
        URL(string: "https://orbitd.io")?.appendingPathComponent("projects").appendingPathComponent(projectID)
    }

    func taskWebURL(_ taskID: String) -> URL? {
        URL(string: "https://orbitd.io")?.appendingPathComponent("tasks").appendingPathComponent(taskID)
    }
}

/// What the project menu reads off the page's store: whether a write is out, and what the Work
/// overview and Tasks blocks have read (Copy as Markdown writes them out).
final class ProjectDetailModel {
    let busy = false
    let panorama: ProjectPanorama? = ProjectPanorama(buckets: ProjectPanoramaBuckets(running: 2, done: 10))
    let tasks: [ProjectTaskRow] = [
        ProjectTaskRow(id: "t8", title: "T8 收尾", status: "OPEN", workState: "RUNNING"),
        ProjectTaskRow(id: "t6", title: "T6 安全边界", status: "DONE", workState: "DONE"),
    ]
}

/// What the task menu reads off the Tasks store: the task on screen, and whether a write to it is out.
final class TasksModel {
    let detail: TaskItem? = ProbeFixtures.task
    func isMutating(_ id: String) -> Bool { false }
}

enum ProbeFixtures {
    static let projectID = "34UonbgOiq9ajX8aH3JPz"
    static let project = ProjectDocument(
        id: projectID, title: "Claude 账号池：按订阅配额均衡派发", status: .open,
        goal: "把一组同厂商的 Claude 订阅凭据表达成一个可派发的池身份，在派发时按 5 小时窗口占用率选出额度最松的成员。",
        taskCount: 12,
        acceptanceCriteriaItems: [
            ProjectCriterion(id: "c1", ordinal: 1, text: "同一 owner 的多行订阅可以归入一个池。", satisfied: true,
                             landing: "LANDED"),
            ProjectCriterion(id: "c2", ordinal: 2, text: "派发时选中窗口占用最低的那一行。", satisfied: true,
                             landing: "ON_INTEGRATION_LINE"),
            ProjectCriterion(id: "c3", ordinal: 3, text: "客户端能看到每个成员的占用。", satisfied: false,
                             landing: "UNKNOWN"),
        ])

    static let taskID = "34UozoiaJIsxCZj728bfe"
    /// `GET /tasks/:id` as the web test's fixture has it.
    static let task: TaskItem? = try? JSONDecoder().decode(TaskItem.self, from: Data("""
        {"id":"34UozoiaJIsxCZj728bfe","title":"T6 安全边界：跨 owner、准入与凭据不外泄的回归断言",
         "status":"DONE","terminalReason":null,"completionCriterion":"EVIDENCE_JUDGMENT",
         "acceptanceCriteria":"新增的安全边界断言全部为绿。","acceptanceCommand":"npm test",
         "acceptanceExpectedExitCode":0,"description":"What to do.","comments":[],
         "sessions":[{"id":"s1","title":"Run","status":"SUCCEEDED","createdAt":"2026-09-25T02:12:20.000Z",
                      "agent":{"name":"orbit"}}],
         "dependsOn":[{"dependsOnTask":{"id":"a","title":"T3b 放开池 slug 的写入口","status":"DONE"}}],
         "dependedOnBy":[{"task":{"id":"b","title":"T7 合并边界","status":"OPEN"}}]}
        """.utf8))
}

/// Where `AppModel.showToast` lands in the app (ToastHost): here, a plain card under the bar.
struct ToastStandIn: View {
    let text: String?

    var body: some View {
        if let text {
            Label(text, systemImage: "checkmark.circle.fill")
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.regularMaterial, in: Capsule())
                .padding(.top, 64)
                .accessibilityIdentifier("toast")
        }
    }
}

/// What a copy left on the pasteboard — read only after this app's own write, so iOS asks nothing.
struct PasteboardSection: View {
    let text: String

    var body: some View {
        Section("Pasteboard") {
            Text(text.isEmpty ? "—" : text)
                .font(.footnote.monospaced())
                .lineLimit(8)
                .accessibilityIdentifier("pasteboard")
        }
    }
}
