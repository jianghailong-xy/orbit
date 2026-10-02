import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md): the iOS session list's rows — the shipped
// `AgentSessionRow`, wrapped in the compact list's push `Button` — with their swipe actions, picked by
// `-variant native|open|completed|trash|three`; `-dark` for dark. The list is built the way
// `AgentPanes` builds it: a headerless first section whose first row drops its top separator, then a
// titled one.

@main
struct SwipeProbeApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            Group {
                if Probe.arg("-variant") == "notes" { NotesProbe() } else { ProbeRoot() }
            }
                .environment(model)
                .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("-dark") ? .dark : .light)
        }
    }
}

struct ProbeRoot: View {
    private let variant = Probe.arg("-variant") ?? "open"
    @State private var rowSwipe = RowSwipeState()
    @State private var log: [String] = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(Probe.today) { session in
                        if session.id == Probe.today.first?.id {
                            row(session).listRowSeparator(.hidden, edges: .top)
                        } else {
                            row(session)
                        }
                    }
                }
                Section {
                    ForEach(Probe.earlier) { row($0) }
                } header: {
                    Text("Previous 7 Days").textCase(nil)
                }
            }
            .listStyle(.plain)
            .rowSwipeList(rowSwipe)
            .navigationTitle("orbit")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                Text("log: " + (log.isEmpty ? "-" : log.joined(separator: " | ")))
                    .font(.caption.monospaced())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.bar)
                    .accessibilityIdentifier("log")
            }
        }
    }

    @ViewBuilder private func row(_ session: Session) -> some View {
        let label = Button { log.append("open \(session.id)") } label: {
            AgentSessionRow(session: session, deleted: variant == "trash",
                            showsPin: variant != "trash" && variant != "completed")
                .foregroundStyle(.primary)
        }
        switch variant {
        case "native":
            // The shipped (pre-circle) row actions, verbatim in what they draw.
            label
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    Button { log.append("Complete \(session.id)") } label: {
                        Label("Complete", systemImage: "checkmark.circle")
                    }
                    .tint(.green)
                    Button { log.append("Pin \(session.id)") } label: { Label("Pin", systemImage: "pin") }
                        .tint(.indigo)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) { log.append("Delete \(session.id)") } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
                .contextMenu { Button("Rename…") {} }
        case "three":
            if #available(iOS 26.0, *) {
                label
                    .contextMenu { Button("Rename…") {} }
                    .circleSwipeActions(id: session.id, leading: [
                        RowSwipeAction(title: "Complete", systemImage: "checkmark.circle", tint: .green) {
                            log.append("Complete \(session.id)")
                        },
                        RowSwipeAction(title: "Pin", systemImage: "pin", tint: .indigo) {
                            log.append("Pin \(session.id)")
                        },
                    ], trailing: [
                        RowSwipeAction(title: "Delete", systemImage: "trash", tint: .red, role: .destructive) {
                            log.append("Delete \(session.id)")
                        },
                        RowSwipeAction(title: "Move", systemImage: "folder", tint: .indigo) {
                            log.append("Move \(session.id)")
                        },
                        RowSwipeAction(title: "Share", systemImage: "square.and.arrow.up", tint: .blue) {
                            log.append("Share \(session.id)")
                        },
                    ], leadingFullSwipe: true)
            } else {
                label
            }
        case "completed":
            label.sessionRowActions(session, scope: .completed, onTag: {})
        case "trash":
            label.sessionRowActions(session, scope: .trash, onTag: {})
        default:
            label.sessionRowActions(session, scope: .open, onTag: {})
        }
    }
}

@MainActor
enum Probe {
    static func arg(_ key: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: key), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static func ago(_ hours: Double) -> String {
        ISO8601DateFormatter().string(from: Date().addingTimeInterval(-hours * 3600))
    }

    static func session(_ id: String, _ title: String, _ preview: String, hoursAgo: Double,
                        tags: [(String, String)] = []) -> Session {
        let json: [String: Any] = [
            "id": id, "title": title, "status": "SUCCEEDED", "lastAssistantText": preview,
            "lastTurnAt": ago(hoursAgo), "updatedAt": ago(hoursAgo), "createdAt": ago(hoursAgo + 1),
            "tags": tags.enumerated().map { i, tag in
                ["id": "\(id)-tag-\(i)", "name": tag.0, "color": tag.1, "isSystem": false, "position": i]
            },
        ]
        return try! JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: json))
    }

    static let today: [Session] = [
        session("s1", "执行任务：整理发布清单", "I've finished the release checklist and posted the summary.",
                hoursAgo: 8),
        session("s2", "检查错误提示的显示", "对，原生 iOS 也会用这套样式，下一步对齐 web。", hoursAgo: 9,
                tags: [("界面", "#FF9500"), ("审查", "#FF9500")]),
        session("s3", "梳理导入流程，避免覆盖用户设置", "已确认：后续默认直接合入 main，不再单独开分支。",
                hoursAgo: 13, tags: [("架构", "#FF9500"), ("审查", "#FF9500")]),
    ]

    static let earlier: [Session] = [
        session("s4", "设置页整体改版（iOS/macOS + web）", "没有新情况。这是回归之后的例行检查。", hoursAgo: 30,
                tags: [("配置", "#AF52DE"), ("交互", "#FFCC00")]),
        session("s5", "判断：设置页改版的下一步", "已完成判断并处理：上一会话因工作树变化而停止。", hoursAgo: 50),
        session("s6", "判断：首页文案优化", "已完成这次判断：唤醒的旧会话已失败，已重新启动。", hoursAgo: 52),
        session("s7", "判断：设置页改版的验收", "我已重新启动任务 D，新一轮正常推进。", hoursAgo: 54),
        session("s8", "数据库性能与容量治理", "CONFIRM 已判，再跑一轮基准。", hoursAgo: 56,
                tags: [("性能", "#AF52DE"), ("配置", "#AF52DE")]),
    ]
}

/// The reference: Notes' list as the system draws it — inset grouped, ~80pt two-line rows, and the
/// system's own swipe actions (Share / Move / Delete to the left, Pin to the right), whose buttons come
/// out round at that height. Recorded mid-swipe to see how the system grows and drops its buttons.
struct NotesProbe: View {
    @State private var log: [String] = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(Probe.notes, id: \.self) { title in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(title).font(.headline).lineLimit(1)
                            Text("09:41  The quick brown fox jumps over the lazy dog")
                                .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                        }
                        .padding(.vertical, 3)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { log.append("Delete") } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            Button { log.append("Move") } label: { Label("Move", systemImage: "folder") }
                                .tint(.indigo)
                            Button { log.append("Share") } label: {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }
                            .tint(.blue)
                        }
                        .swipeActions(edge: .leading) {
                            Button { log.append("Pin") } label: { Label("Pin", systemImage: "pin") }
                                .tint(.orange)
                        }
                    }
                } header: {
                    Text("Today")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Notes")
            .safeAreaInset(edge: .bottom) {
                Text("log: " + (log.isEmpty ? "-" : log.joined(separator: " | ")))
                    .font(.caption.monospaced())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.bar)
                    .accessibilityIdentifier("log")
            }
        }
    }
}

extension Probe {
    static let notes = ["Shopping list", "梳理导入流程，避免覆盖用户设置", "Trip ideas", "Meeting notes",
                        "Book recommendations", "Recipes to try"]
}
