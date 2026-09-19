import SwiftUI
import OrbitKit

// A throwaway iPhone app whose only job is to draw the app's own status marks and let the Mac
// runner screenshot them (see run.sh). It renders the REAL views: ProbeViews.swift is generated
// by extracting them from AgentsView.swift, and the fixtures below are JSON in the shape the
// control plane sends, decoded by the same `Session`/`Agent` Codable the app uses — so what is
// on screen is the payload → glyph path, not a hand-built approximation of it.

private func fixture<T: Decodable>(_ json: String) -> T {
    do {
        return try JSONDecoder().decode(T.self, from: Data(json.utf8))
    } catch {
        fatalError("fixture failed to decode: \(error)")
    }
}

/// One session row, laid out the way the app's list row is: the status glyph leading a title and
/// the session's own status line (`SessionHeader.statusWord`, the shared port of the web label).
private struct SessionRow: View {
    let session: Session

    var body: some View {
        HStack(spacing: 8) {
            StatusGlyphView(glyph: .make(for: session))
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title ?? "Untitled session")
                    .font(.orbitProse)
                    .lineLimit(1)
                Text(SessionHeader.statusWord(for: session))
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 7)
    }
}

/// The compact (drawer) row's trailing cue, at the size the drawer draws it.
private struct CompactRow: View {
    let session: Session

    var body: some View {
        HStack(spacing: 8) {
            Text(session.title ?? "Untitled session")
                .font(.orbitProse)
                .lineLimit(1)
            Spacer(minLength: 8)
            SessionLiveIndicator(session: session)
        }
        .padding(.vertical, 8)
    }
}

private struct Caption: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.orbitSectionLabel)
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 14)
    }
}

// Not SwiftUI's `Group`: this one is the rounded container the app's rows sit in.
private struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(spacing: 0) { content }
            .padding(.horizontal, 14)
            .background(.background, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary))
    }
}

// ── the fixtures: one per state the glyph has to tell apart ─────────────────────────────────

// `sessionBase` ends in a comma so a fixture can append its own keys; it carries no
// `pendingApprovals`, because a fixture that wants one states it once. (A duplicate key decodes to
// whichever occurrence the decoder keeps, which is how a "needs you" row silently renders as
// "waiting for your reply" — the states below are the ones this image exists to tell apart.)
private let sessionBase = """
"status":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN",
"createdAt":"2026-09-01T09:00:00.000Z","updatedAt":"2026-09-01T09:05:00.000Z",
"provider":"claude","assignedRunnerId":"r1",
"""

private let job: Session = fixture("""
{"id":"s-job","title":"压测下 CPU，检查散热降频",\(sessionBase)
 "pendingApprovals":0,"runningBgCount":3,"runningBgJobCount":2}
""")

private let serviceOnly: Session = fixture("""
{"id":"s-svc","title":"起个 vite 预览改一下样式",\(sessionBase)
 "pendingApprovals":0,"runningBgCount":2,"runningBgJobCount":0}
""")

private let generating: Session = fixture("""
{"id":"s-run","title":"把网关的限流补上","status":"RUNNING","runState":"RUNNING",
 "lifecycleState":"OPEN","pendingApprovals":0,"runningBgCount":1,"runningBgJobCount":1,
 "createdAt":"2026-09-01T09:00:00.000Z","provider":"claude"}
""")

private let waiting: Session = fixture("""
{"id":"s-wait","title":"重构 runner 的心跳",\(sessionBase)"pendingApprovals":0}
""")

private let needsYou: Session = fixture("""
{"id":"s-ask","title":"上线前帮我确认这个迁移",\(sessionBase)"pendingApprovals":1}
""")

private let workspaceJSON: String = """
{"id":"w-rocm","name":"rocm","lastProvider":"claude","runnerId":"r1","enabled":true}
"""

private let workspace: Agent = fixture(workspaceJSON)

// ── screens ─────────────────────────────────────────────────────────────────────────────────

private struct RowsScreen: View {
    var body: some View {
        VStack(spacing: 0) {
            Caption(text: "会话行 · 状态图标")
            Card {
                SessionRow(session: generating)
                SessionRow(session: needsYou)
                SessionRow(session: job)
                SessionRow(session: serviceOnly)
                SessionRow(session: waiting)
            }
            Caption(text: "紧凑列表 · 尾标")
            Card {
                CompactRow(session: generating)
                CompactRow(session: job)
                CompactRow(session: serviceOnly)
                CompactRow(session: waiting)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
    }
}

private struct WorkspaceScreen: View {
    var body: some View {
        VStack(spacing: 0) {
            Caption(text: "工作区行 · 行尾一个槽位")
            Card {
                WorkspaceNavigationRow(agent: workspace, runnerLabel: "workstation-gpu",
                                       selected: false, offline: false, running: false,
                                       jobs: true, waiting: 0)
                WorkspaceNavigationRow(agent: workspace, runnerLabel: "workstation-gpu",
                                       selected: false, offline: false, running: true,
                                       jobs: true, waiting: 0)
                WorkspaceNavigationRow(agent: workspace, runnerLabel: "workstation-gpu",
                                       selected: false, offline: false, running: false,
                                       jobs: false, waiting: 2)
                WorkspaceNavigationRow(agent: workspace, runnerLabel: "workstation-gpu",
                                       selected: false, offline: false, running: false,
                                       jobs: false, waiting: 0)
            }
            Caption(text: "上到下：后台在干活 / 在生成 / 有人等你 / 什么都没有")
            Spacer(minLength: 0)
        }
        .padding(14)
    }
}

@main
struct ProbeApp: App {
    private var shot: String {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-shot"), i + 1 < args.count else { return "rows" }
        return args[i + 1]
    }

    var body: some Scene {
        WindowGroup {
            let name = shot
            Group {
                if name.hasPrefix("workspace") { WorkspaceScreen() } else { RowsScreen() }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Color(.systemGroupedBackground))
            .preferredColorScheme(name.hasSuffix("dark") ? .dark : .light)
        }
    }
}
