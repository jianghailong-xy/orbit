import SwiftUI
import OrbitKit

/// The app shell: a three-column split mirroring the web AppShell — navigation/Workspaces, the
/// selected section's list, and a detail pane. Regular iPad groups the first column into Workspaces
/// and Manage; macOS preserves its disclosure-style source list.
struct MainView: View {
    @Environment(AppModel.self) private var model
    /// Whether the first column is on screen. It routes — app sections plus a workspace picker —
    /// rather than being a level you read through, and every section swaps both columns to its
    /// right, so holding it resident spends width the detail pane never gets back. iPad starts it
    /// collapsed; macOS keeps its source list open. Either way the last choice is remembered, and
    /// SwiftUI keeps the toggle on the leading edge of whichever column is leftmost, so the way
    /// back is always on screen.
    #if os(iOS)
    @AppStorage("shell.sidebarVisible") private var sidebarVisible = false
    #else
    @AppStorage("shell.sidebarVisible") private var sidebarVisible = true
    #endif
    /// `.doubleColumn` hides only the sidebar — `.detailOnly` would take the session list with it.
    @State private var columnVisibility: NavigationSplitViewVisibility = .doubleColumn

    var body: some View {
        @Bindable var model = model
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SectionSidebar(isAdmin: model.user?.role == "ADMIN")
                // Wide enough that a workspace and its runner subtitle both survive: two rows can
                // share a name ("orbit" on two different runners) and the runner is what tells
                // them apart, so truncating it costs the only distinguishing text on the row.
                .navigationSplitViewColumnWidth(min: 260, ideal: 320, max: 360)
        } content: {
            SectionContent(section: model.selectedSection)
                .orbitPaneBackground()
                #if os(iOS)
                // The regular-iPad session column carries a visible three-way scope control and
                // two-line rows — but SwiftUI reads *this column's own* width for the size class
                // the column sees. At the previous 330 ideal it settled near 282pt and reported
                // `.compact`, which quietly routed the column through the iPhone layout: large
                // title instead of inline, no scope control, iPhone row density. Ask for width
                // that clears the regular threshold, and leave SwiftUI free to collapse the split
                // when the window narrows.
                .navigationSplitViewColumnWidth(min: 320, ideal: 420, max: 480)
                #else
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
                #endif
        } detail: {
            SectionDetail(section: model.selectedSection)
                .orbitPaneBackground()
        }
        .task { model.startPolling() }
        .onAppear { columnVisibility = sidebarVisible ? .all : .doubleColumn }
        .onChange(of: columnVisibility) { _, now in sidebarVisible = (now == .all) }
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

/// The leftmost rail, now a source list. iPad leads with grouped, first-level Workspace rows and
/// keeps administrative destinations under Manage; macOS retains its expandable, runner-grouped
/// Workspaces section. Admin is role-gated on both.
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
        #if !os(iOS)
        let shortcutIndex = model.agentShortcutIndex   // agentID → ⌘N slot, computed once per render
        #endif
        return List(selection: selection) {
            #if os(iOS)
            Section {
                workspaceRows
            } header: {
                Text("Workspaces").textCase(nil)
            }

            Section {
                ForEach(AppSection.managementSections(isAdmin: isAdmin)) { section in
                    Label(section.title, systemImage: section.systemImage)
                        .tag(SidebarSelection.section(section))
                }
            } header: {
                Text("Manage").textCase(nil)
            }
            #else
            ForEach(AppSection.visible(isAdmin: isAdmin)) { section in
                if section == .agents {
                    agentsDisclosure(shortcutIndex: shortcutIndex)
                } else {
                    Label(section.title, systemImage: section.systemImage)
                        .tag(SidebarSelection.section(section))
                }
            }
            #endif
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

    /// The line standing in for an empty workspace list. It says there are none only after a fetch
    /// that succeeded — offline the list couldn't be fetched, which isn't the same thing.
    private func emptyWorkspacesText(_ none: String) -> String {
        switch model.agents?.listPresentation {
        case .failed?: return "Couldn't load workspaces"
        case .empty?: return none
        default: return "Loading…"
        }
    }

    #if os(iOS)
    @ViewBuilder
    private var workspaceRows: some View {
        if let agents = model.agents, !agents.items.isEmpty {
            ForEach(agents.orderedItems) { workspace in
                AgentRowView(agent: workspace)
                    .tag(SidebarSelection.agent(workspace.id))
            }
        } else {
            Text(emptyWorkspacesText("No workspaces"))
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
                Text(emptyWorkspacesText("No agents"))
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
                #if os(iOS)
                Image(systemName: "chevron.forward")
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
                #endif
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
        case .following:
            FollowingListView()
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
        case .following:
            WatchDetailView()
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
