import SwiftUI
import UIKit
import Observation
import OrbitKit

// TEMPORARY (shots branch only). The needs-you bar over rows that have scrolled up under it, on an
// iPhone simulator — the frame of the owner's screenshot of 2026-09-28, where "HPC needs you" was
// drawn over the reply beneath it and a vertical line ran down the middle of the bar.
//
// `run.sh` copies the app's own NeedsYouBannerView in twice: as this branch has it, and as the
// shipped commit had it (renamed NeedsYouBannerViewShipped). Both halves are the app's view, not a
// redrawing of it. The nav bar, the transcript rows, the composer and the session rows are the
// probe's stand-ins for the console and the list; what is being looked at is only what the bar
// does to the rows under it.

/// The three members of `AppModel` the bar reads, answered the way the app answers them: the
/// snapshot narrowed by `SessionGrouping.group(list).needsYou` first, then `NeedsYouLogic.banner`.
@Observable
final class AppModel {
    let sessions: [Session]

    init(_ sessions: [Session]) { self.sessions = sessions }

    func needsYouBanner(excluding focused: String?) -> NeedsYouBanner? {
        NeedsYouLogic.banner(waiting: SessionGrouping.group(sessions).needsYou, excluding: focused)
    }

    func openNeedsYouSession(_ s: Session) {}
    func openNeedsYouItem(_ s: Session, _ item: SessionOwnerItem) {}
}

/// One session in the workspace "HPC" blocked on an approval, so the bar reads "HPC needs you".
/// Decoded rather than built: `SessionAgentRef`'s memberwise init is internal to OrbitKit.
let waitingInHPC: Session = {
    let json = #"""
    {"id":"s-hpc","title":"Nightly sweep","status":"AWAITING_INPUT","agentId":"hpc",
     "assignedRunnerId":"r1","pendingApprovals":1,"lastTurnAt":"2026-09-28T10:00:00Z",
     "agent":{"id":"hpc","name":"HPC"}}
    """#
    return try! JSONDecoder().decode(Session.self, from: Data(json.utf8))
}()

@main
struct ProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeRoot() }
    }
}

private let shot: String = {
    let args = ProcessInfo.processInfo.arguments
    guard let i = args.firstIndex(of: "-shot"), i + 1 < args.count else { return "console-new" }
    return args[i + 1]
}()

/// The bar under test: the shipped file or this branch's, by the shot's name.
struct BarUnderTest: View {
    var excluding: String?

    var body: some View {
        if shot.contains("shipped") {
            NeedsYouBannerViewShipped(excluding: excluding)
        } else {
            NeedsYouBannerView(excluding: excluding)
        }
    }
}

struct ProbeRoot: View {
    @State private var path: [Int] = [1]

    var body: some View {
        Group {
            if shot.hasPrefix("list") {
                SessionListStandIn()
            } else {
                // Pushed onto a stack, as the console is, so the bar has the back button beside it.
                NavigationStack(path: $path) {
                    Text("Sessions")
                        .navigationTitle("HPC")
                        .navigationDestination(for: Int.self) { _ in ConsoleStandIn() }
                }
            }
        }
        .environment(AppModel([waitingInHPC]))
        .preferredColorScheme(shot.hasSuffix("-dark") ? .dark : .light)
    }
}

// MARK: the console

private let reply: [String] = [
    "先说结论：现在的排队状态大体合理，但有两处口径不一致，读的人会以为有一边写错了。",
    "一、卡片在 QUEUED 时，列表写的是「等前置」，详情页写的是「排队中」。同一件事两个说法。",
    "二、前置已经 DONE、但成果还没合进项目线的卡，现在也算「等前置」。它其实在等合并，不是在等人，也不是在等别的卡。",
    "建议的标准：一张卡停着只有三种原因——等前置、等合并、等你。每种一个词，列表、详情页和推送用同一个词。",
    "等前置：还有没完成的依赖。等合并：依赖都完成了，但成果还没进项目线。等你：卡上有要你拍板的事。",
    "这样改不动派发逻辑，只动文案和分组，风险很小；两端的文案测试各补一条就能锁住。",
    "你认可这个标准，我就建卡。",
]

struct ConsoleStandIn: View {
    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                List {
                    ForEach(Array(reply.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.body)
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                    }
                    VStack(alignment: .trailing, spacing: 6) {
                        Text("你需要评估下和 steer 哪个更合理")
                            .font(.body)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(Color.accentColor.opacity(0.15),
                                        in: RoundedRectangle(cornerRadius: 12))
                        Text("55m ago").font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 10, leading: 76, bottom: 10, trailing: 16))
                    .id("tail")
                }
                .listStyle(.plain)
                .task {
                    // At the tail, as a console opens: the reply above it has scrolled up under
                    // the bar and the nav bar.
                    try? await Task.sleep(for: .milliseconds(400))
                    proxy.scrollTo("tail", anchor: .bottom)
                }
            }
            HStack {
                Text("Message").foregroundStyle(.tertiary)
                Spacer()
            }
            .padding(.horizontal, 16)
            .frame(height: 50)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22))
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
        // Where the app mounts it (ConsoleView): a top inset of the whole console, spacing 0.
        .safeAreaInset(edge: .top, spacing: 0) {
            BarUnderTest(excluding: "this-session")
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text("卡片排队状态是否合理").font(.headline)
                    Text("Waiting for your reply · Open · 49m ago")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {} label: { Image(systemName: "square.and.arrow.up") }
            }
        }
    }
}

// MARK: the session list

private let rows: [(String, String)] = [
    ("Nightly sweep", "Waiting for approval · 2h ago"),
    ("卡片排队状态是否合理", "Waiting for your reply · 49m ago"),
    ("Rebuild the wiki index", "Running · 12m"),
    ("Runner self-update E2E", "Completed · 3h ago"),
    ("Composer toolbar spacing", "Completed · 5h ago"),
    ("iOS push per-device diagnosis", "Completed · yesterday"),
    ("Provider pool quota", "Completed · yesterday"),
    ("Merge receipts for project line", "Completed · 2d ago"),
    ("Background tray card parity", "Completed · 2d ago"),
    ("Codex device login", "Completed · 3d ago"),
    ("Wiki phase 2 mocks", "Completed · 3d ago"),
    ("Coordinator question note", "Completed · 4d ago"),
    ("Drawer project rows", "Completed · 5d ago"),
    ("Tasks list redesign", "Completed · 6d ago"),
]

struct SessionListStandIn: View {
    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List {
                    ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(row.0).font(.body).lineLimit(1)
                            Text(row.1).font(.subheadline).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                        .id(i)
                    }
                }
                .listStyle(.plain)
                .task {
                    // A few rows down, so the ones above have scrolled up under the bar.
                    try? await Task.sleep(for: .milliseconds(400))
                    proxy.scrollTo(4, anchor: .top)
                }
            }
            .navigationTitle("HPC")
            .navigationBarTitleDisplayMode(.inline)
            // Where the app mounts it on the phone (AgentsView): a top inset, spacing 0.
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 0) {
                    BarUnderTest(excluding: nil)
                }
            }
        }
    }
}
