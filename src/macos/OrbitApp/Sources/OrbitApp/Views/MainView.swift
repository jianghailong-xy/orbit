import SwiftUI
import OrbitKit

/// The app shell: a three-column split mirroring the web AppShell — a section rail (Active /
/// Tasks / Agents / Skills / Runners / Settings / Admin), the selected section's list, and a
/// detail pane. Only Active is wired to real views in batch B; the other sections are
/// placeholders filled in by later batches (C Tasks, D Agents, E the rest).
struct MainView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            SectionSidebar(isAdmin: model.user?.role == "ADMIN",
                           needsYou: model.groups.needsYou.count)
                .navigationSplitViewColumnWidth(min: 200, ideal: 230, max: 300)
        } content: {
            SectionContent(section: model.selectedSection, sessionSelection: $model.selectedSessionID)
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
        } detail: {
            SectionDetail(section: model.selectedSection)
        }
        .task { model.startPolling() }
        // Drive the debounced console mount off the list selection (covers arrow-key navigation,
        // clicks, and a restored selection on appear).
        .onChange(of: model.selectedSessionID, initial: true) { _, _ in model.scheduleConsoleActivate() }
        .sessionUndoToast()
    }
}

/// UI-only selection for the source-list sidebar: a top-level section, or — nested under the
/// "Agents" row — a specific agent. (The web keeps the agent list in a middle column; on macOS we
/// fold it into the sidebar so picking an agent goes straight to its detail, dropping a column.)
enum SidebarSelection: Hashable {
    case section(AppSection)
    case agent(String)
}

/// The leftmost rail, now a source list: top-level sections, with "Agents" expandable to its
/// runner-grouped agents (the list that used to live in the middle column). Active carries the
/// "needs you" badge; Admin is role-gated. Section list + gating come from OrbitKit's `AppSection`.
struct SectionSidebar: View {
    @Environment(AppModel.self) private var model
    let isAdmin: Bool
    let needsYou: Int
    @State private var agentsExpanded = true

    /// Bridge the two model fields (`selectedSection` + `selectedAgentID`) to the List's single
    /// selection. The "Agents" parent only expands/collapses (it isn't tagged), so `.agents` is
    /// reached by selecting an agent — which is also the only way it carries a detail.
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
                    if model.selectedAgentID != id {
                        model.selectedAgentSessionID = nil
                        model.composingAgentSession = false
                    }
                    model.selectedSection = .agents
                    model.selectedAgentID = id
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
                    agentsDisclosure(shortcutIndex: shortcutIndex)
                } else {
                    Label(section.title, systemImage: section.systemImage)
                        .badge(section == .active ? needsYou : 0)   // .badge(0) renders nothing
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
        .task { await model.agents?.load() }
    }

    private func agentsDisclosure(shortcutIndex: [String: Int]) -> some View {
        DisclosureGroup(isExpanded: $agentsExpanded) {
            if let agents = model.agents, !agents.items.isEmpty {
                ForEach(agents.groups) { group in
                    Text(agents.runnerLabel(group.runnerId))
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(group.agents) { a in
                        AgentRowView(agent: a, shortcutIndex: shortcutIndex[a.id])
                            .tag(SidebarSelection.agent(a.id))
                    }
                }
            } else {
                Text(model.agents?.loading == true ? "Loading…" : "No agents")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } label: {
            Label(AppSection.agents.title, systemImage: AppSection.agents.systemImage)
        }
    }
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
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
            )
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

/// Right column: detail for the selection. Active shows the live console (or a prompt to pick a
/// session); other sections show a neutral placeholder until built out.
struct SectionDetail: View {
    let section: AppSection
    @Environment(AppModel.self) private var model

    var body: some View {
        switch section {
        case .active:
            if let id = model.activeConsoleSessionID, let registry = model.consoleRegistry {
                // No `.id(id)`: the view persists across selection changes and swaps its stream via
                // `.task(id:)`, reusing the warm cached console instead of rebuilding from scratch.
                ConsoleView(sessionID: id, agentID: model.agentID(for: id), registry: registry)
            } else {
                ContentUnavailableView("Select a session",
                                       systemImage: "bubble.left.and.bubble.right",
                                       description: Text("Live transcript appears here."))
            }
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

struct ActiveSidebar: View {
    @Environment(AppModel.self) private var model
    @Binding var selection: String?
    // Drives the List's keyboard focus. Set true when the composer hands ↑/↓ back on Escape, so the
    // list can be arrow-navigated without a click; the binding also tracks click-to-focus.
    @FocusState private var listFocused: Bool

    var body: some View {
        List(selection: $selection) {
            bucket("Needs you", model.groups.needsYou, tint: .orange)
            bucket("Running", model.groups.running, tint: .green)
            bucket("Queued", model.groups.queued, tint: .secondary)
        }
        .focused($listFocused)
        .onChange(of: model.sessionListFocusRequest) { _, _ in listFocused = true }
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
                        .sessionRowActions(session)
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
