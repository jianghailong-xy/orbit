import SwiftUI
import OrbitKit

/// The app shell: a three-column split mirroring the web AppShell — a section rail (Active /
/// Tasks / Agents / Skills / Runners / Settings / Admin), the selected section's list, and a
/// detail pane. Only Active is wired to real views in batch B; the other sections are
/// placeholders filled in by later batches (C Tasks, D Agents, E the rest).
struct MainView: View {
    @Environment(AppModel.self) private var model
    @State private var showRunner = false

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            SectionSidebar(selection: $model.selectedSection,
                           isAdmin: model.user?.role == "ADMIN",
                           needsYou: model.groups.needsYou.count)
                .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 260)
        } content: {
            SectionContent(section: model.selectedSection, sessionSelection: $model.selectedSessionID)
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
        } detail: {
            SectionDetail(section: model.selectedSection)
        }
        .toolbar {
            ToolbarItem {
                Button { showRunner = true } label: {
                    Label("Local runner", systemImage: "desktopcomputer")
                }
                .help("Manage the runner on this Mac")
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if let email = model.user?.email { Text(email) }
                    Button("Sign out", role: .destructive) { model.logout() }
                } label: {
                    Label(model.user?.name ?? model.user?.email ?? "Account", systemImage: "person.crop.circle")
                }
            }
        }
        .task { model.startPolling() }
        .sheet(isPresented: $showRunner) {
            if let url = model.baseURL {
                RunnerControlPane(baseURL: url, tokenStore: model.tokenStore)
            }
        }
    }
}

/// The leftmost rail: top-level sections. Active carries the "needs you" badge; Admin is
/// role-gated (mirrors the web). Section list + gating come from OrbitKit's `AppSection`.
struct SectionSidebar: View {
    @Binding var selection: AppSection
    let isAdmin: Bool
    let needsYou: Int

    var body: some View {
        List(selection: $selection) {
            ForEach(AppSection.visible(isAdmin: isAdmin)) { section in
                Label(section.title, systemImage: section.systemImage)
                    .badge(section == .active ? needsYou : 0)   // .badge(0) renders nothing
                    .tag(section)
            }
        }
        .navigationTitle("Orbit")
    }
}

/// Middle column: the selected section's list. Active reuses the live session list; the rest
/// are placeholders until their batch lands.
struct SectionContent: View {
    let section: AppSection
    @Binding var sessionSelection: String?

    var body: some View {
        switch section {
        case .active:
            ActiveSidebar(selection: $sessionSelection)
                .navigationTitle("Active")
        case .tasks:
            TasksListView()
        case .agents:
            AgentsListView()
        case .skills:
            SkillsView()
        case .runners:
            RunnersListView()
        case .settings:
            SettingsView()
        case .admin:
            AdminUsersView()
        }
    }
}

/// Right column: detail for the selection. Active shows the live console (or a prompt to pick a
/// session); other sections show a neutral placeholder until built out.
struct SectionDetail: View {
    let section: AppSection
    @Environment(AppModel.self) private var model

    var body: some View {
        switch section {
        case .active:
            if let id = model.selectedSessionID, let baseURL = model.baseURL {
                ConsoleView(sessionID: id, agentID: model.agentID(for: id),
                            baseURL: baseURL, tokenStore: model.tokenStore)
                    .id(id)   // rebuild (restart the stream) when the selection changes
            } else {
                ContentUnavailableView("Select a session",
                                       systemImage: "bubble.left.and.bubble.right",
                                       description: Text("Live transcript appears here."))
            }
        case .tasks:
            TaskDetailView()
        case .agents:
            AgentDetailView()
        case .runners:
            RunnerDetailView()
        case .admin:
            AdminUserDetailView()
        case .skills, .settings:
            // Single-pane sections render everything in the middle column.
            ContentUnavailableView(section.title, systemImage: section.systemImage,
                                   description: Text("Browse \(section.title.lowercased()) in the list."))
        }
    }
}

struct ComingSoon: View {
    let section: AppSection
    let note: String
    var body: some View {
        ContentUnavailableView(section.title, systemImage: section.systemImage, description: Text(note))
            .navigationTitle(section.title)
    }
}

struct ActiveSidebar: View {
    @Environment(AppModel.self) private var model
    @Binding var selection: String?

    var body: some View {
        List(selection: $selection) {
            bucket("Needs you", model.groups.needsYou, tint: .orange)
            bucket("Running", model.groups.running, tint: .green)
            bucket("Queued", model.groups.queued, tint: .secondary)
        }
        .overlay {
            if model.groups.isEmpty {
                ContentUnavailableView("No active sessions", systemImage: "moon.zzz")
            }
        }
    }

    @ViewBuilder
    private func bucket(_ title: String, _ items: [Session], tint: Color) -> some View {
        if !items.isEmpty {
            Section(title) {
                ForEach(items) { session in
                    SessionRow(session: session, tint: tint).tag(session.id)
                }
            }
        }
    }
}

struct SessionRow: View {
    let session: Session
    let tint: Color

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(tint).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title ?? "Untitled session")
                    .lineLimit(1)
                Text(statusLabel).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let n = session.pendingApprovals, n > 0 {
                Text("\(n)")
                    .font(.caption2.bold())
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(.orange, in: Capsule())
                    .foregroundStyle(.white)
            }
        }
        .padding(.vertical, 2)
    }

    private var statusLabel: String {
        switch session.status {
        case .running: return "Running"
        case .awaitingInput: return "Awaiting input"
        case .pending: return "Queued"
        case .interrupted: return "Interrupted"
        default: return session.status.rawValue.capitalized
        }
    }
}
