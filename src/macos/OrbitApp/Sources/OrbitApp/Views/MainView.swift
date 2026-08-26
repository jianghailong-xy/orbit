import SwiftUI
import OrbitKit

/// The app shell: a three-column split mirroring the web AppShell — a section rail (Tasks /
/// Agents / Skills / Runners / Settings / Admin), the selected section's list, and a detail pane.
struct MainView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            SectionSidebar(isAdmin: model.user?.role == "ADMIN")
                .navigationSplitViewColumnWidth(min: 200, ideal: 230, max: 300)
        } content: {
            SectionContent(section: model.selectedSection)
                .orbitPaneBackground()
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
        } detail: {
            SectionDetail(section: model.selectedSection)
                .orbitPaneBackground()
        }
        .task { model.startPolling() }
        // Stream lifecycle: start exactly the focused session's SSE and stop any other, from the
        // always-present shell so it never depends on a console view unmounting (see syncConsoleFocus).
        .onChange(of: model.focusedConsoleSessionID, initial: true) { _, _ in model.syncConsoleFocus() }
        .toastHost()
    }
}

/// UI-only selection for the source-list sidebar: a top-level section or a specific Workspace.
/// iPad renders Workspaces directly; macOS keeps them inside its historical disclosure row.
enum SidebarSelection: Hashable {
    case section(AppSection)
    case agent(String)
}

/// The leftmost rail, now a source list. iPad uses first-level Workspace rows with Runner metadata;
/// macOS retains the existing expandable, runner-grouped Workspaces section. Admin is role-gated.
struct SectionSidebar: View {
    @Environment(AppModel.self) private var model
    let isAdmin: Bool
    #if !os(iOS)
    @State private var agentsExpanded = true
    #endif

    /// Bridge the two model fields (`selectedSection` + `selectedAgentID`) to the List's single
    /// selection. A Workspace is the only `.agents` destination that carries a detail; on macOS the
    /// disclosure parent remains untagged, while iPad presents these same tagged rows directly.
    private var selection: Binding<SidebarSelection?> {
        Binding(
            get: {
                if model.selectedSection == .agents, let id = model.selectedAgentID { return .agent(id) }
                return .section(model.selectedSection)
            },
            set: { value in
                switch value {
                case .section(let s):
                    model.selectedSection = s
                case .agent(let id):
                    model.openAgent(id)
                case nil:
                    break
                }
            }
        )
    }

    var body: some View {
        // Touch the driving fields so Observation re-renders the rail (and re-reads `selection`)
        // when the section/agent changes from outside the sidebar, e.g. a deep-link route.
        _ = (model.selectedSection, model.selectedAgentID)
        let shortcutIndex = model.agentShortcutIndex   // agentID → ⌘N slot, computed once per render
        return List(selection: selection) {
            ForEach(AppSection.visible(isAdmin: isAdmin)) { section in
                if section == .agents {
                    #if os(iOS)
                    workspaceRows(shortcutIndex: shortcutIndex)
                    #else
                    agentsDisclosure(shortcutIndex: shortcutIndex)
                    #endif
                } else {
                    Label(section.title, systemImage: section.systemImage)
                        .tag(SidebarSelection.section(section))
                }
            }
        }
        .navigationTitle("Orbit")
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Divider()
                AccountFooter()
            }
            .background(.bar)
        }
        .task { await model.loadAgentsThenLand() }
    }

    #if os(iOS)
    @ViewBuilder
    private func workspaceRows(shortcutIndex: [String: Int]) -> some View {
        if let agents = model.agents, !agents.items.isEmpty {
            ForEach(agents.orderedItems) { workspace in
                AgentRowView(agent: workspace, shortcutIndex: shortcutIndex[workspace.id])
                    .tag(SidebarSelection.agent(workspace.id))
            }
        } else {
            Text(model.agents?.loading == true ? "Loading…" : "No workspaces")
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
        }
    }
    #else
    private func agentsDisclosure(shortcutIndex: [String: Int]) -> some View {
        DisclosureGroup(isExpanded: $agentsExpanded) {
            if let agents = model.agents, !agents.items.isEmpty {
                ForEach(agents.groups) { group in
                    Text(agents.runnerLabel(group.runnerId))
                        .font(.orbitLabel).foregroundStyle(.secondary)
                    ForEach(group.agents) { a in
                        AgentRowView(agent: a, shortcutIndex: shortcutIndex[a.id],
                                     configuredProviders: agents.configuredProviders)
                            .tag(SidebarSelection.agent(a.id))
                    }
                }
            } else {
                Text(model.agents?.loading == true ? "Loading…" : "No agents")
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }
        } label: {
            Label(AppSection.agents.title, systemImage: AppSection.agents.systemImage)
        }
    }
    #endif
}

/// Pinned to the bottom of the sidebar, mirroring the web's `tp-user` footer: a monogram avatar
/// plus the signed-in user's name. Clicking opens the account menu (email + Sign out) that used to
/// live in the window toolbar.
struct AccountFooter: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let display = model.user?.name ?? model.user?.email
        Menu {
            // Menu items must be real controls — a bare `Text` gets dropped by AppKit, so the email
            // rides along as a Section header above the one action.
            if let email = model.user?.email {
                Section(email) {
                    Button("Sign out", role: .destructive) { model.logout() }
                }
            } else {
                Button("Sign out", role: .destructive) { model.logout() }
            }
        } label: {
            HStack(spacing: 10) {
                AvatarMonogram(name: display)
                Text(display ?? "Account")
                    .fontWeight(.semibold)
                    .lineLimit(1)
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        // `.button` style + plain button + hidden indicator renders the custom label as-is (no
        // chevron, no swallowed label) — unlike `.borderlessButton`, which dropped the whole row.
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
    }
}

/// Circular initials avatar — the first letter of the name/email, like the web's `Avatar`.
struct AvatarMonogram: View {
    let name: String?

    private var initial: String {
        let trimmed = (name ?? "").trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? "?" : String(trimmed.first!).uppercased()
    }

    var body: some View {
        Circle()
            .fill(Color.accentColor)
            .frame(width: 32, height: 32)
            .overlay(
                Text(initial)
                    .font(.orbitGlyph.weight(.semibold))
                    .foregroundStyle(.white)
            )
    }
}

/// Middle column: the selected section's list.
struct SectionContent: View {
    let section: AppSection

    var body: some View {
        switch section {
        case .tasks:
            TasksListView()
        case .agents:
            AgentContentColumn()
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

/// Right column: detail for the selection. Each section shows its own detail; single-pane
/// sections fall through to a neutral placeholder.
struct SectionDetail: View {
    let section: AppSection

    var body: some View {
        switch section {
        case .tasks:
            TaskDetailView()
        case .agents:
            AgentConsoleDetail()
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
