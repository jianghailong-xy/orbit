#if os(iOS)
import SwiftUI
import OrbitKit

/// iPhone (compact width) navigation shell: a tab bar over the app's sections. iPad regular width
/// keeps `MainView`'s three-column split (see the size-class switch in the iOS app entry).
///
/// Each tab is its own `NavigationSplitView`, not a `NavigationStack`, on purpose: an iOS `List`
/// with a single-selection binding only drives navigation from a *tap* when it's the sidebar of a
/// split view (a plain stack needs edit mode). Collapsing the split on compact turns that same
/// selection into a push — so every existing `List(selection:)` sidebar + detail pair from the
/// iPad shell is reused verbatim, no row rewrites. Selection state is the shared `AppModel`'s, so
/// picking a row and drilling in works identically to the iPad columns.
struct CompactShell: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView(selection: tabBinding) {
            // ACTIVE — live sessions → console
            NavigationSplitView {
                SectionContent(section: .active, sessionSelection: $model.selectedSessionID)
                    .onChange(of: model.selectedSessionID, initial: true) { _, _ in
                        model.scheduleConsoleActivate()
                    }
            } detail: {
                SectionDetail(section: .active)
            }
            .tabItem { Label(AppSection.active.title, systemImage: AppSection.active.systemImage) }
            .badge(model.groups.needsYou.count)
            .tag(CompactTab.active)

            // TASKS — task list → detail
            NavigationSplitView {
                TasksListView()
            } detail: {
                TaskDetailView()
            }
            .tabItem { Label(AppSection.tasks.title, systemImage: AppSection.tasks.systemImage) }
            .tag(CompactTab.tasks)

            // AGENTS — agent list → the agent's sessions → console (three levels, like the iPad)
            NavigationSplitView {
                AgentListCompact()
            } content: {
                AgentContentColumn()
            } detail: {
                AgentConsoleDetail()
            }
            .tabItem { Label(AppSection.agents.title, systemImage: AppSection.agents.systemImage) }
            .tag(CompactTab.agents)

            // RUNNERS — runner list → detail
            NavigationSplitView {
                RunnersListView()
            } detail: {
                RunnerDetailView()
            }
            .tabItem { Label(AppSection.runners.title, systemImage: AppSection.runners.systemImage) }
            .tag(CompactTab.runners)

            // MORE — the single-pane / low-traffic sections
            NavigationStack {
                MoreList()
            }
            .tabItem { Label("More", systemImage: "ellipsis.circle") }
            .tag(CompactTab.more)
        }
        .task { model.startPolling() }
    }

    /// Bridge the tab bar to `selectedSection` so deep links (which set the section) land on the
    /// right tab; Skills/Settings/Admin all live behind the More tab.
    private var tabBinding: Binding<CompactTab> {
        Binding(
            get: { CompactTab(section: model.selectedSection) },
            set: { model.selectedSection = $0.section }
        )
    }
}

/// The four primary tabs. Skills, Settings and Admin fold into `.more`.
enum CompactTab: Hashable {
    case active, tasks, agents, runners, more

    init(section: AppSection) {
        switch section {
        case .active:  self = .active
        case .tasks:   self = .tasks
        case .agents:  self = .agents
        case .runners: self = .runners
        case .skills, .settings, .admin: self = .more
        }
    }

    /// The section a tap on this tab selects (the More tab defaults to Settings' section group).
    var section: AppSection {
        switch self {
        case .active:  return .active
        case .tasks:   return .tasks
        case .agents:  return .agents
        case .runners: return .runners
        case .more:    return .settings
        }
    }
}

/// The Agents sidebar for compact width — the runner-grouped agent list that lives in the iPad
/// main sidebar, pulled out as a standalone list so the Agents tab can drill agent → sessions →
/// console. Selecting an agent clears any stale session/compose state, mirroring the iPad sidebar.
private struct AgentListCompact: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        List(selection: $model.selectedAgentID) {
            if let agents = model.agents, !agents.items.isEmpty {
                ForEach(agents.groups) { group in
                    Section(agents.runnerLabel(group.runnerId)) {
                        ForEach(group.agents) { a in
                            AgentRowView(agent: a).tag(a.id)
                        }
                    }
                }
            } else {
                Text(model.agents?.loading == true ? "Loading…" : "No agents")
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Agents")
        .onChange(of: model.selectedAgentID) { _, _ in
            model.selectedAgentSessionID = nil
            model.composingAgentSession = false
        }
        .task { await model.agents?.load() }
    }
}

/// Root of the More tab: the sections that don't warrant their own tab. Skills and Settings are
/// single-pane; Admin is role-gated and links to the user list.
private struct MoreList: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            NavigationLink {
                SkillsView()
            } label: {
                Label(AppSection.skills.title, systemImage: AppSection.skills.systemImage)
            }
            NavigationLink {
                SettingsView()
            } label: {
                Label(AppSection.settings.title, systemImage: AppSection.settings.systemImage)
            }
            if model.user?.role == "ADMIN" {
                NavigationLink {
                    AdminUsersView()
                } label: {
                    Label(AppSection.admin.title, systemImage: AppSection.admin.systemImage)
                }
            }
        }
        .navigationTitle("More")
    }
}
#endif
