import SwiftUI
import OrbitKit
#if os(macOS)
import AppKit
#endif

/// The app shell: a three-column split mirroring the web AppShell — navigation/Workspaces, the
/// selected section's list, and a detail pane. On iPad the first column is the iPhone's navigation
/// drawer itself; macOS draws the same rail as a source list (`SectionSidebar`).
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
    /// The first column folded for the shell rather than by the reader: while the wiki chat is a column beside the
    /// page (wiki-chat design §9: the directory, the page and the chat), so the page keeps its width, or while an iPad
    /// window is taller than wide, where three columns leave the detail too narrow to read. It comes back as it was
    /// once neither holds, and is never saved as the reader's choice.
    @State private var folded = false
    /// The window is taller than wide: an iPad turned to portrait, or a tall Stage Manager window.
    @State private var portrait = false

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
            // The page is kept mounted under the task, so the conversation's scroll position and
            // its live transcript are exactly what closing returns to.
            ZStack {
                SectionDetail(section: model.selectedSection)
                    .orbitPaneBackground()
                    .accessibilityHidden(model.taskOverPageID != nil)
                if model.taskOverPageID != nil { TaskOverPagePanel() }
            }
        }
        .task { model.startPolling() }
        // The wide shells' pages all open a pressed task over themselves (owner decision
        // 2026-11-12): said once here, so a conversation, a wiki entry and every card in them give
        // the same answer. The phone's shell never sets it.
        .environment(\.opensTasksOverPage, true)
        // A task opened over a page belongs to that page: choosing another page from the sidebar
        // takes it down with it (owner decision 2026-11-12). The shell's own write, so the model's
        // section setter stays a plain section switch.
        .onChange(of: model.selectedSection) { _, _ in model.closeTaskOverPage() }
        #if os(iOS)
        .onGeometryChange(for: Bool.self) { $0.size.width < $0.size.height } action: { now in
            portrait = now
            refold()
        }
        #endif
        .onAppear {
            columnVisibility = sidebarVisible ? .all : .doubleColumn
            refold()
        }
        .onChange(of: columnVisibility) { _, now in
            #if os(iOS)
            // A full-screen image viewer coming or going re-picks the split's columns by itself;
            // that is not the reader's choice, so put back what they had instead of saving it. A
            // fold the shell wants (a turn to portrait under the viewer) still goes through.
            if FullScreenCoverHold.shared.holding {
                let open = folded ? !(wikiChatColumn || portrait) : sidebarVisible
                let kept: NavigationSplitViewVisibility = open ? .all : .doubleColumn
                if now != kept {
                    columnVisibility = kept
                    return
                }
            }
            #endif
            // Brought back by hand while folded: the reader's again, nothing to restore.
            if now == .all { folded = false }
            if !folded { sidebarVisible = (now == .all) }
        }
        .onChange(of: wikiChatColumn) { _, _ in refold() }
        // Stream lifecycle: start exactly the focused session's SSE and stop any other, from the
        // always-present shell so it never depends on a console view unmounting (see syncConsoleFocus).
        .onChange(of: model.focusedConsoleSessionID, initial: true) { _, _ in model.syncConsoleFocus() }
        .toastHost()
    }

    /// Folds an open first column while the chat column or a portrait window wants the width, and brings it back once
    /// neither does — only if the shell folded it; one hidden by hand stays hidden.
    private func refold() {
        let wantsFold = wikiChatColumn || portrait
        if wantsFold, columnVisibility == .all {
            folded = true
            columnVisibility = .doubleColumn
        } else if !wantsFold, folded {
            columnVisibility = .all
        }
    }

    /// The wiki chat open as a column beside the Wiki's page — the inspector, not a phone's sheet.
    private var wikiChatColumn: Bool {
        guard model.selectedSection == .wiki, let chat = model.wikiChat else { return false }
        return chat.presented && !chat.asSheet
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
/// UI-only selection for the macOS source list: a section, a Workspace, a machine's Set up row, or
/// one open project.
enum SidebarSelection: Hashable {
    case section(AppSection)
    case agent(String)
    /// A machine with no workspace: its Set up row, and the new session page it opens.
    case machine(String)
    /// An open project in the Projects group: its sessions page in the session column, as the iPad
    /// opens it (owner 2026-11-12).
    case project(String)
}

/// macOS's leftmost rail (docs/mocks/macos-sidebar, 01): the iPad's sidebar — the iPhone's drawer —
/// in a Mac source list. The work leads (Projects, Tasks, Wiki, Waiting on you, with the drawer's
/// amber counts), then the Workspaces one line each with the drawer's state slot, then every open
/// project. Mac-sized rows, the system's selection and foldable groups; no New session here (⌘N and
/// File ▸ New Session start one), and no Following, Settings or Admin rows: the footer's gear opens
/// Settings, and its account menu carries all three. The Wiki row is drawn only for an account the
/// server has the wiki on for, as the drawer draws it.
struct SectionSidebar: View {
    @Environment(AppModel.self) private var model
    let isAdmin: Bool
    @AppStorage("sidebar.workspacesExpanded") private var workspacesExpanded = true
    @AppStorage("sidebar.projectsExpanded") private var projectsExpanded = true
    /// The workspace whose settings its row's menu opened.
    @State private var editingWorkspace: Agent?
    /// ⌘ is down: the workspace rows show their ⌘1…⌘9 shortcuts only then, as Safari shows its tab
    /// numbers, instead of a column of faint hints beside the state marks all the time.
    @State private var commandHeld = false

    /// Bridge the model's fields to the List's single selection.
    private var selection: Binding<SidebarSelection?> {
        Binding(
            get: {
                if let runnerID = model.machineDraftRunnerID { return .machine(runnerID) }
                if model.selectedSection == .agents, let address = model.projectSessionsColumn {
                    // The row's tag is the project list's own spelling of the id.
                    let key = PublicID.storageKey(address.projectID)
                    let listed = model.projects?.projects.first { PublicID.storageKey($0.id) == key }?.id
                    return .project(listed ?? address.projectID)
                }
                if model.selectedSection == .agents, let id = model.selectedAgentID { return .agent(id) }
                return .section(model.selectedSection)
            },
            set: { value in
                switch value {
                case .section(let s):
                    model.selectedSection = s
                case .agent(let id):
                    openWorkspace(id)
                case .machine(let runnerID):
                    model.openMachineDraft(runnerID)
                case .project(let id):
                    model.openProjectSessions(id, inColumn: true)
                case nil:
                    break
                }
            }
        )
    }

    var body: some View {
        // Touch the driving fields so Observation re-renders the rail (and re-reads `selection`)
        // when the section/agent changes from outside the sidebar, e.g. a deep-link route.
        _ = (model.selectedSection, model.selectedAgentID, model.machineDraftRunnerID, model.nav.path)
        let shortcutIndex = model.agentShortcutIndex   // agentID → ⌘N slot, computed once per render
        let openProjects = model.projects?.drawerProjects(coordinators: model.projectCoordinators) ?? []
        return List(selection: selection) {
            ForEach(AppSection.workSections) { section in
                if section != .wiki || model.wiki?.shown == true {
                    sectionRow(section)
                }
            }
            // "Waiting on you", raised as a sheet over whatever is selected.
            OwnerRequestInboxEntry()

            Section(AppSection.agents.title, isExpanded: $workspacesExpanded) {
                workspaceRows(shortcutIndex: commandHeld ? shortcutIndex : [:])
            }

            if !openProjects.isEmpty {
                Section(isExpanded: $projectsExpanded) {
                    ForEach(openProjects) { project in
                        projectRow(project)
                            .tag(SidebarSelection.project(project.id))
                    }
                } header: {
                    HStack(spacing: 6) {
                        Text(AppSection.projects.title)
                        Text("\(openProjects.count)").fontWeight(.regular)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Orbit")
        .toolbar {
            ToolbarItem {
                Button { model.searchOpen = true } label: {
                    Label("Search Sessions", systemImage: "magnifyingglass")
                }
                .help("Search Sessions (⌘K)")
                .disabled(!model.signedIn)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Divider()
                AccountFooter(isAdmin: isAdmin)
            }
            .background(.bar)
        }
        .sheet(item: $editingWorkspace) { agent in
            if let agents = model.agents { AgentSettingsSheet(agents: agents, agent: agent) }
        }
        .task { await model.loadAgentsThenLand() }
        .task { await watchCommandKey() }
        // Whether the Wiki row is drawn at all is the spaces read's answer (WIKI_DISABLED, `WikiLogic.shown`).
        .task { await model.wiki?.loadSpaces() }
        // The Projects row counts the projects waiting on you, and the last group lists the open ones.
        .task { await model.projects?.load() }
    }

    /// Projects, Tasks or the Wiki, with the drawer's amber count of what waits on you there.
    private func sectionRow(_ section: AppSection) -> some View {
        let waiting: Int
        switch section {
        case .projects: waiting = model.projects?.needsYouCount ?? 0
        case .wiki:     waiting = model.wiki?.waiting ?? 0
        default:        waiting = 0
        }
        return HStack {
            Label(section.title, systemImage: section.systemImage)
            Spacer(minLength: 6)
            if waiting > 0 {
                Text("\(waiting)")
                    .font(.orbitMeta.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.orange)
                    .accessibilityLabel("\(waiting) waiting on you")
            }
        }
        .tag(SidebarSelection.section(section))
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

    /// Follows ⌘ for as long as the sidebar is up. A key released while another app is in front never
    /// reaches this monitor, so leaving the app counts as letting go.
    private func watchCommandKey() async {
        let monitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { event in
            commandHeld = event.modifierFlags.contains(.command)
            return event
        }
        defer { if let monitor { NSEvent.removeMonitor(monitor) } }
        for await _ in NotificationCenter.default.notifications(named: NSApplication.didResignActiveNotification) {
            commandHeld = false
        }
    }

    /// The Workspaces one line each, in the drawer's runner-stable order, then a Set up row per machine
    /// with no workspace. One flat ForEach over `AgentListLogic.sidebarRows`, one view per row: an
    /// if/else or a second ForEach in here is the shape the outline list's row reload aborted on.
    private func workspaceRows(shortcutIndex: [String: Int]) -> some View {
        let agents = model.agents
        // The runner is named only on a row whose name another workspace also has ("orbit" on two
        // machines): there it is what tells them apart; anywhere else it repeated one machine's name
        // down the whole list. The row's menu (Show Machine) still says where it runs.
        let sharedNames = Set(Dictionary(grouping: agents?.orderedItems ?? [], by: \.name)
            .filter { $0.value.count > 1 }.keys)
        return ForEach(AgentListLogic.sidebarRows(agents?.orderedItems ?? [], machines: agents?.machinesToSetUp ?? [])) { row in
            switch row {
            case .agent(let agent):
                let configured = agents?.configuredProviders ?? []
                WorkspaceNavigationRow(
                    agent: agent,
                    runnerLabel: sharedNames.contains(agent.name) ? agents?.runnerLabel(agent.runnerId) ?? "" : "",
                    // The system draws the selection, so the folder keeps one colour.
                    selected: false,
                    offline: agents?.runnerIsOffline(agent.runnerId) ?? false,
                    running: model.runningWorkspaceIDs.contains(agent.id),
                    jobs: model.jobWorkspaceIDs.contains(agent.id),
                    waiting: model.agentNeedsYou[agent.id] ?? 0,
                    shortcut: shortcutIndex[agent.id]
                )
                // What the two-line row used to say under the name: what its next session starts on, and where.
                .help(SessionProviderChoices.engineVia(engine: agent.defaultEngine(configured: configured),
                                                       provider: agent.defaultProvider,
                                                       configured: configured)
                      + (agent.workDir.map { " · \($0)" } ?? ""))
                .contextMenu { workspaceMenu(agent) }
                .tag(SidebarSelection.agent(agent.id))
            case .setUp(let machine):
                setUpRow(machine)
                    .tag(SidebarSelection.machine(machine.id))
            case .placeholder:
                Text(emptyWorkspacesText("No workspaces"))
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
    }

    /// A workspace row's right-click menu (docs/mocks/macos-sidebar, 01, owner 2026-11-12): a session in
    /// it, its list, its settings, its folder's path, and the machine it runs on.
    @ViewBuilder
    private func workspaceMenu(_ agent: Agent) -> some View {
        Button("New Session") {
            openWorkspace(agent.id)
            model.newSessionInCurrentAgent()
        }
        Button("Open Sessions") { openWorkspace(agent.id) }
        Divider()
        Button("Workspace Settings…") { editingWorkspace = agent }
        if let path = agent.workDir {
            Button("Copy Path") { PlatformPasteboard.copyString(path) }
        }
        if let runnerID = agent.runnerId {
            Button("Show Machine") { model.route(to: .runner(runnerID)) }
        }
    }

    /// The workspace's own session list, off any project's sessions page that covered it.
    private func openWorkspace(_ id: String) {
        if model.selectedAgentID == id, model.projectSessionsColumn != nil { model.leaveProjectSessions() }
        model.openAgent(id)
    }

    /// In the tint, as on the phone's drawer, until it is the row selected: blue on the selection's
    /// blue can't be read, and the list knows what a selected row's text should be.
    private func setUpRow(_ machine: MachineToSetUp) -> some View {
        let ink = model.machineDraftRunnerID == machine.id ? AnyShapeStyle(.primary) : AnyShapeStyle(Color.accentColor)
        return Label {
            Text(MachineSetupCopy.setupTitle(machine: machine.name)).foregroundStyle(ink)
        } icon: {
            Image(systemName: "folder.badge.plus").foregroundStyle(ink)
        }
    }

    /// An open project: its title, and the drawer's one trailing mark — what waits on you, or its work in flight.
    private func projectRow(_ project: ProjectSummary) -> some View {
        HStack(spacing: 8) {
            Label {
                Text(project.title).lineLimit(1)
            } icon: {
                Image(systemName: AppSection.projects.systemImage).foregroundStyle(.secondary)
            }
            Spacer(minLength: 6)
            switch ProjectAttention.drawerMark(
                project, coordinator: model.projectCoordinators[PublicID.storageKey(project.id)]) {
            case .needsYou(let count):
                NeedsYouCountCapsule(count: count)
            case .running:
                SpinnerGlyph(color: .secondary)
                    .accessibilityLabel("Running")
            case .idle:
                EmptyView()
            }
        }
    }
}

/// Pinned to the bottom of the sidebar, mirroring the web's `tp-user` footer: a monogram avatar
/// plus the signed-in user's name, and the drawer's Settings gear beside it. Clicking the name opens
/// the account menu, which also holds the places the rail has no row for: Settings, Admin, Following.
struct AccountFooter: View {
    @Environment(AppModel.self) private var model
    let isAdmin: Bool

    var body: some View {
        let display = model.user?.name ?? model.user?.email
        HStack(spacing: 4) {
            Menu {
                // Menu items must be real controls — a bare `Text` gets dropped by AppKit, so the email
                // rides along as a Section header above the actions.
                if let email = model.user?.email {
                    Section(email) { accountActions }
                } else {
                    accountActions
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
                .contentShape(Rectangle())
            }
            // `.button` style + plain button + hidden indicator renders the custom label as-is (no
            // chevron, no swallowed label) — unlike `.borderlessButton`, which dropped the whole row.
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)

            Button { model.selectedSection = .settings } label: {
                Image(systemName: AppSection.settings.systemImage)
                    .font(.orbitGlyph)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .help(AppSection.settings.title)
            .accessibilityLabel(AppSection.settings.title)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var accountActions: some View {
        Button(AppSection.settings.title) { model.selectedSection = .settings }
        if isAdmin {
            Button(AppSection.admin.title) { model.selectedSection = .admin }
        }
        Button(AppSection.following.title) { model.selectedSection = .following }
        Divider()
        Button("Sign out", role: .destructive) { model.logout() }
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
    @Environment(AppModel.self) private var model
    let section: AppSection

    var body: some View {
        switch section {
        case .projects:
            ProjectsListView()
        case .tasks:
            TasksListView()
        case .wiki:
            WikiContentsColumn()
        case .following:
            FollowingListView()
        case .agents:
            AgentContentColumn()
        case .skills:
            SkillsView()
        case .runners:
            #if os(macOS)
            // Settings' page (docs/mocks/machines-and-models, 02): the sidebar has no row for it, so the way
            // back to Settings is in the column's own toolbar.
            RunnersListView()
                .toolbar {
                    ToolbarItem(placement: .navigation) {
                        Button { model.selectedSection = .settings } label: {
                            Label("Settings", systemImage: "chevron.left").labelStyle(.titleAndIcon)
                        }
                    }
                }
            #else
            RunnersListView()
            #endif
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
            WikiDetailPane().wikiChatHost()   // the chat's third column beside the page (wiki-chat design §9)
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

/// A task opened over the page it was pressed on — the wide shells' answer to a task link in a
/// conversation, a wiki page or a watch card (owner decision 2026-11-12). It is the very same
/// `TaskDetailPage` the Tasks section draws, laid over the detail column: the sidebar and the
/// session list keep the conversation's place, and the page under it stays mounted, so Close puts
/// the reader back exactly where they were.
struct TaskOverPagePanel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let taskID = model.taskOverPageID {
            #if os(iOS)
            // The task page's own actions (⋯, Share, Delete) are toolbar items, so the phone's
            // panel gives them the bar they live in, with Close beside them.
            NavigationStack {
                TaskDetailPage(taskID: taskID, overPage: true)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { closeButton }
                    }
            }
            .background(.background)
            #else
            // On the Mac those actions ride the window's toolbar, as they do in the Tasks pane;
            // the panel's own bar carries the one control the page does not: Close.
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    closeButton
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(.bar)
                Divider()
                TaskDetailPage(taskID: taskID, overPage: true)
            }
            .background(.background)
            #endif
        }
    }

    private var closeButton: some View {
        Button { model.closeTaskOverPage() } label: {
            Label("Close", systemImage: "xmark")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .keyboardShortcut(.cancelAction)
    }
}
