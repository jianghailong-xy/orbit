import SwiftUI
import OrbitKit

/// The app shell: a three-column split mirroring the web AppShell — navigation/Workspaces, the
/// selected section's list, and a detail pane. On iPad the first column is the iPhone's navigation
/// drawer itself; macOS preserves its disclosure-style source list.
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
            sidebar
                // Wide enough that a workspace and its runner both survive: two rows can share a
                // name ("orbit" on two different runners) and the runner is what tells them apart,
                // so truncating it costs the only distinguishing text on the row.
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

    /// The first column. The iPad seats the phone's drawer here — the same rows, counts, state marks
    /// and New session / Settings bar, so the two are one rail — and it closes nothing, since this
    /// column stays until its own toggle hides it. macOS keeps its source list.
    @ViewBuilder
    private var sidebar: some View {
        #if os(iOS)
        NavigationDrawer(close: {}, live: true, inSidebarColumn: true)
        #else
        SectionSidebar(isAdmin: model.user?.role == "ADMIN")
        #endif
    }
}

#if os(macOS)
/// UI-only selection for the macOS source list: a top-level section or a specific Workspace, which
/// sits inside the historical Workspaces disclosure row.
enum SidebarSelection: Hashable {
    case section(AppSection)
    case agent(String)
}

/// macOS's leftmost rail, a source list: the sections in order, with an expandable, runner-grouped
/// Workspaces section among them. Admin is role-gated.
struct SectionSidebar: View {
    @Environment(AppModel.self) private var model
    let isAdmin: Bool
    @State private var agentsExpanded = true

    /// Bridge the two model fields (`selectedSection` + `selectedAgentID`) to the List's single
    /// selection. A Workspace is the only `.agents` destination that carries a detail; the
    /// disclosure parent remains untagged.
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
                    agentsDisclosure(shortcutIndex: shortcutIndex)
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

    /// The line standing in for an empty workspace list. It says there are none only after a fetch
    /// that succeeded — offline the list couldn't be fetched, which isn't the same thing.
    private func emptyWorkspacesText(_ none: String) -> String {
        switch model.agents?.listPresentation {
        case .failed?: return "Couldn't load workspaces"
        case .empty?: return none
        default: return "Loading…"
        }
    }

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
                AccountAvatar(name: display)
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
#endif

/// The signed-in account's avatar: its profile photo once the app has it (`AppModel.avatarImage`),
/// else the name's first letter. The sidebar's footer draws it at row size; Settings draws it large.
struct AccountAvatar: View {
    @Environment(AppModel.self) private var model
    let name: String?
    var diameter: CGFloat = 32
    var font: Font = .orbitGlyph.weight(.semibold)

    var body: some View {
        if let photo = model.avatarImage {
            AvatarPhoto(image: photo, diameter: diameter)
        } else {
            AvatarMonogram(name: name, diameter: diameter, font: font)
        }
    }
}

/// A photo cut to an avatar's circle.
struct AvatarPhoto: View {
    let image: PlatformImage
    var diameter: CGFloat = 32

    var body: some View {
        Image(platformImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: diameter, height: diameter)
            .clipShape(Circle())
    }
}

/// Circular initials avatar — the first letter of the name/email, like the web's `Avatar`, drawn
/// wherever there is no photo to draw (`AccountAvatar`).
struct AvatarMonogram: View {
    let name: String?
    var diameter: CGFloat = 32
    var font: Font = .orbitGlyph.weight(.semibold)

    private var initial: String {
        let trimmed = (name ?? "").trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? "?" : String(trimmed.first!).uppercased()
    }

    var body: some View {
        Circle()
            .fill(Color.accentColor)
            .frame(width: diameter, height: diameter)
            .overlay(
                Text(initial)
                    .font(font)
                    .foregroundStyle(.white)
            )
    }
}

/// Middle column: the selected section's list.
struct SectionContent: View {
    let section: AppSection

    var body: some View {
        switch section {
        case .projects:
            ProjectsListView()
        case .tasks:
            TasksListView()
        case .wiki:
            WikiHomeView()
        case .following:
            FollowingListView()
        case .agents:
            AgentContentColumn()
        case .skills:
            SkillsView()
        case .runners:
            RunnersListView()
        case .settings:
            #if os(iOS)
            // Never the section on iOS: choosing Settings presents it as a sheet over the section
            // that is showing (the sidebar's selection, `AppModel.settingsPresented`), so there is
            // no column to fill.
            EmptyView()
            #else
            SettingsView()
            #endif
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
        case .projects:
            ProjectDetailPane()
        case .tasks:
            TaskDetailView()
        case .wiki:
            WikiDetailPane()
        case .following:
            WatchDetailView()
        case .agents:
            AgentConsoleDetail()
        case .runners:
            RunnerDetailView()
        case .admin:
            AdminUserDetailView()
        case .settings:
            #if os(iOS)
            // A sheet on iOS, never the section — see `SectionContent`.
            EmptyView()
            #else
            // macOS leaves this pane a placeholder on purpose: ⌘, opens the real Settings window,
            // and the middle column here is the whole form already.
            ContentUnavailableView(section.title, systemImage: section.systemImage,
                                   description: Text("Browse \(section.title.lowercased()) in the list."))
            #endif
        case .skills:
            // Still single-pane: Skills is a browse-only list with nothing to select into.
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
