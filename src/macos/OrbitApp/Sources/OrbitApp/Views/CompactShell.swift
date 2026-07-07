#if os(iOS)
import SwiftUI
import UIKit
import OrbitKit

/// iPhone (compact width) navigation shell. Instead of a bottom tab bar, the sections live behind a
/// **left drawer** (mirroring the web AppShell's left sidebar), opened two ways:
///   • the leading hamburger in each section's root nav bar (discoverable), and
///   • an edge-swipe from the left (fast + one-handed), enabled only at a section's root so it never
///     fights the system back-swipe on a pushed page.
/// The drawer pushes the content to the right with a dimming scrim; tapping the scrim or swiping
/// left closes it. The current section is highlighted.
///
/// Under the hood the drawer just drives `selectedSection`, and `CompactSections` renders that one
/// section's navigation stack. Every existing `List(selection:)` sidebar + detail pair from the iPad
/// shell is reused verbatim.
struct CompactShell: View {
    @Environment(AppModel.self) private var model

    @State private var drawerOpen = false
    /// Live horizontal drag delta while a drawer gesture is in flight (0 when idle).
    @State private var dragX: CGFloat = 0

    var body: some View {
        @Bindable var model = model
        return GeometryReader { geo in
            let w = geo.size.width
            let dw = drawerWidth(w)
            let x = contentOffset(width: w)

            ZStack(alignment: .leading) {
                // Drawer, revealed at the leading edge as the content slides right.
                NavigationDrawer(close: closeDrawer)
                    .frame(width: dw)
                    .offset(x: x - dw)

                // Section content — pushed right, dimmed, and tap/swipe-to-close via the scrim.
                // The scrim is an overlay *inside* the offset (offset is the outermost modifier) so it
                // travels with the content and dims only the visible peek at [x, x+w]. Applying the
                // overlay after `.offset` would size it to the un-offset full-screen frame — painting
                // over the drawer and stealing its taps, so drawer rows couldn't switch sections.
                CompactSections(openDrawer: openDrawer)
                    .overlay {
                        if x > 0 {
                            Color.black.opacity(0.35 * (x / dw))
                                .ignoresSafeArea()
                                .onTapGesture(perform: closeDrawer)
                                .gesture(closeDrag(width: w))
                        }
                    }
                    .offset(x: x)

                // Left-edge open strip — present only at a section's root so it yields the edge to
                // the system back-swipe on any pushed page.
                if !drawerOpen && isAtRoot {
                    Color.clear
                        .frame(width: 18)
                        .frame(maxHeight: .infinity)
                        .contentShape(Rectangle())
                        .gesture(openDrag(width: w))
                }
            }
            .task { model.startPolling() }
            // Stream lifecycle: start exactly the focused session's SSE and stop any other, from this
            // always-present shell so it never depends on a console view unmounting (see syncConsoleFocus).
            .onChange(of: model.focusedConsoleSessionID, initial: true) { _, _ in model.syncConsoleFocus() }
            .sessionUndoToast()
        }
    }

    // MARK: Drawer geometry & gestures

    /// ChatGPT-style peek: the drawer takes most of the width, leaving a sliver of content visible.
    private func drawerWidth(_ w: CGFloat) -> CGFloat { min(330, w * 0.86) }

    /// How far the content is pushed right, clamped to `[0, drawerWidth]` and blending the resting
    /// state with any live drag.
    private func contentOffset(width w: CGFloat) -> CGFloat {
        let base: CGFloat = drawerOpen ? drawerWidth(w) : 0
        return min(max(base + dragX, 0), drawerWidth(w))
    }

    private func openDrawer() { withAnimation(.snappy(duration: 0.25)) { drawerOpen = true } }
    private func closeDrawer() { withAnimation(.snappy(duration: 0.25)) { drawerOpen = false } }

    /// Edge-swipe to open (rightward drag from the left strip).
    private func openDrag(width w: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { g in
                guard !drawerOpen else { return }
                dragX = min(max(0, g.translation.width), drawerWidth(w))
            }
            .onEnded { g in
                let open = g.translation.width > drawerWidth(w) * 0.4
                    || g.predictedEndTranslation.width > drawerWidth(w) * 0.5
                withAnimation(.snappy(duration: 0.25)) { drawerOpen = open }
                dragX = 0
            }
    }

    /// Swipe-left to close (leftward drag on the scrim).
    private func closeDrag(width w: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { g in
                guard drawerOpen else { return }
                dragX = max(min(0, g.translation.width), -drawerWidth(w))
            }
            .onEnded { g in
                let close = g.translation.width < -drawerWidth(w) * 0.3
                    || g.predictedEndTranslation.width < -drawerWidth(w) * 0.4
                withAnimation(.snappy(duration: 0.25)) { drawerOpen = !close }
                dragX = 0
            }
    }

    /// A section is "at root" when nothing is pushed onto its stack, so the left edge is free for
    /// the open gesture — `AppModel.sectionAtRoot`, derived from the shared selection state.
    private var isAtRoot: Bool { model.sectionAtRoot }
}

/// The selected section's navigation stack, switched on `selectedSection`. A hidden-tab-bar `TabView`
/// was tried first (to keep every section's stack alive across switches) but its *programmatic*
/// selection didn't move the pane on device — tapping a drawer row closed the drawer without
/// navigating. Rendering one section at a time via a plain `switch` (like the iPad `MainView`) makes
/// the drawer and deep links switch reliably. The trade: switching away resets the *other* sections'
/// stacks; drilling *within* the current section is still preserved.
private struct CompactSections: View {
    @Environment(AppModel.self) private var model
    let openDrawer: () -> Void

    var body: some View {
        @Bindable var model = model
        switch model.selectedSection {
        // TASKS — task list → detail
        case .tasks:
            NavigationSplitView {
                TasksListView()
                    .drawerToggle(open: openDrawer)
                    .refreshable { await model.tasks?.load() }
            } detail: {
                TaskDetailView()
            }

        // AGENTS — the agent is picked in the drawer, so the section root is that agent's *sessions*
        // (no intermediate agent-list page); selecting one pushes its console. Backing out of the
        // console lands on the session list, where the left-edge swipe reopens the drawer.
        case .agents:
            NavigationSplitView {
                AgentContentColumn()
                    .drawerToggle(open: openDrawer)
                    // New session is *pushed* full-screen over the sessions list (not a bottom sheet):
                    // it leads into the session rather than back to a list, so a push reads more
                    // naturally and flows straight into the console once the first message is sent
                    // (the completion below arms `selectedAgentSessionID`, which the collapsed split
                    // pushes as the detail — the same path the console already takes). Attached to the
                    // content column so it rides that column's stack; compact-only since this whole
                    // shell is (iPad keeps `AgentConsoleDetail`'s inline draft).
                    .navigationDestination(isPresented: $model.composingAgentSession) {
                        AgentComposePush()
                    }
            } detail: {
                AgentConsoleDetail()
            }

        // RUNNERS — runner list → detail
        case .runners:
            NavigationSplitView {
                RunnersListView()
                    .drawerToggle(open: openDrawer)
                    .refreshable { await model.runners?.load() }
            } detail: {
                RunnerDetailView()
            }

        // SKILLS / SETTINGS / ADMIN — single-pane sections, first-class drawer destinations. Admin is
        // reachable only for admins (the drawer hides it otherwise), so it needs no extra role gate.
        case .skills:
            NavigationStack {
                SkillsView()
                    .drawerToggle(open: openDrawer)
                    .refreshable { await model.runners?.load() }
            }

        case .settings:
            NavigationStack { SettingsView().drawerToggle(open: openDrawer) }

        case .admin:
            NavigationStack {
                AdminUsersView()
                    .drawerToggle(open: openDrawer)
                    .refreshable { await model.admin?.load() }
            }
        }
    }
}

/// The left navigation drawer: the section rail (mirroring the web sidebar) over the account footer.
/// The current section is highlighted.
private struct NavigationDrawer: View {
    @Environment(AppModel.self) private var model
    let close: () -> Void
    /// Which runner groups are expanded to reveal their agents. Default collapsed; the group holding
    /// the current agent (and a lone group) always shows — see `isExpanded`. Persists across
    /// open/close because this view stays mounted (offset off-screen) in the shell's ZStack.
    @State private var expandedRunners: Set<String> = []

    var body: some View {
        let isAdmin = model.user?.role == "ADMIN"
        return VStack(alignment: .leading, spacing: 0) {
            Text("Orbit")
                .font(.title2.weight(.bold))
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 8)

            List {
                // Runners is dropped from the drawer rail on iOS — it now lives under Settings (see
                // SettingsView). The runner-grouped agents below still surface each machine by name.
                ForEach(AppSection.visible(isAdmin: isAdmin).filter { $0 != .runners }) { section in
                    // The Agents nav row is replaced in place by its runner-grouped agents. Each runner
                    // is a collapsible row (icon · online dot · agent count) that expands to its agents,
                    // so the machine list stays collapsible instead of always-expanded.
                    if section == .agents {
                        agentsRows
                    } else {
                        sectionRow(section)
                    }
                }
                // Recents trails the drawer: the most-recent sessions across every agent, kept below the
                // machine/section rail so the primary nav destinations stay at the top.
                recentsRows
            }
            .listStyle(.plain)
            // Agents are always shown now, so load the list when the drawer mounts (mirrors the macOS
            // sidebar), then land on the first agent. It's light; the heavy session list loads separately.
            .task { await model.loadAgentsThenLand() }

            Divider()
            AccountFooter()
                .background(.bar)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(uiColor: .systemBackground))
    }

    /// A plain destination row: tapping switches section and closes the drawer.
    private func sectionRow(_ section: AppSection) -> some View {
        let selected = section == model.selectedSection
        return Button {
            model.selectedSection = section
            close()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: section.systemImage)
                    .frame(width: 24)
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                Text(section.title)
                    .fontWeight(selected ? .semibold : .regular)
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .listRowBackground(selected ? Color.accentColor.opacity(0.12) : Color.clear)
    }

    // MARK: Recents

    /// The "Recents" header + rows: the most-recently-active sessions across every agent, tapping
    /// straight into that session's console. Hidden until the cross-agent Active list has loaded.
    @ViewBuilder
    private var recentsRows: some View {
        let recents = model.recentSessions
        if !recents.isEmpty {
            Text("Recents")
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .padding(.leading, 20)
                .padding(.top, 6)
                .padding(.bottom, 2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .listRowBackground(Color.clear)
            ForEach(recents) { session in
                recentRow(session)
            }
        }
    }

    /// One Recents row: just the session title on a single lightweight line — tapping opens it in its
    /// agent. The status dot + "agent · status/time" subtitle were dropped: the two-line row read too
    /// heavy for a jump-back list.
    private func recentRow(_ s: Session) -> some View {
        let selected = model.selectedSection == .agents && model.selectedAgentSessionID == s.id
        return Button {
            model.openRecentSession(s)
            close()
        } label: {
            Text(s.title ?? "Untitled session")
                .lineLimit(1)
                .foregroundStyle(.primary)
                .padding(.leading, 20)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(selected ? Color.accentColor.opacity(0.12) : Color.clear)
    }

    // MARK: Agents grouped by runner (collapsible)

    /// The runner-grouped agents, where the Agents nav row used to be: each runner is a collapsible
    /// row that expands to its agents. Renders nothing until the list loads (or with no agents).
    @ViewBuilder
    private var agentsRows: some View {
        if let agents = model.agents, !agents.items.isEmpty {
            ForEach(agents.groups) { group in
                runnerRow(group, agents: agents)
                if isExpanded(group, totalGroups: agents.groups.count) {
                    ForEach(group.agents) { agent in
                        agentRow(agent)
                    }
                }
            }
        }
    }

    /// A collapsible runner header row (sibling of the section rows): machine icon · name · online
    /// dot · agent count · disclosure chevron. Tapping expands/collapses its agents.
    private func runnerRow(_ group: AgentGroup, agents: AgentsModel) -> some View {
        let expanded = isExpanded(group, totalGroups: agents.groups.count)
        return Button {
            toggle(group)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: group.runnerId == nil ? "shippingbox" : "desktopcomputer")
                    .frame(width: 24)
                    .foregroundStyle(.secondary)
                Text(agents.runnerLabel(group.runnerId))
                    .lineLimit(1)
                    .foregroundStyle(.primary)
                Spacer(minLength: 6)
                if group.runnerId != nil {
                    Circle()
                        .fill(agents.runnerIsOnline(group.runnerId) ? Color.green : Color.secondary.opacity(0.4))
                        .frame(width: 7, height: 7)
                }
                Text("\(group.agents.count)")
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.orbitMeta)
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
    }

    private func groupKey(_ g: AgentGroup) -> String { g.runnerId ?? "host" }

    /// A group is shown expanded when it's the only group, when it holds the currently-selected agent
    /// (you can't fold away the machine you're working in), or when the user expanded it. Otherwise
    /// collapsed — Recents is the primary way in, so the machine list stays tidy by default.
    private func isExpanded(_ g: AgentGroup, totalGroups: Int) -> Bool {
        if totalGroups <= 1 { return true }
        if let sel = model.selectedAgentID, g.agents.contains(where: { $0.id == sel }) { return true }
        return expandedRunners.contains(groupKey(g))
    }

    private func toggle(_ g: AgentGroup) {
        let k = groupKey(g)
        if expandedRunners.contains(k) { expandedRunners.remove(k) } else { expandedRunners.insert(k) }
    }

    /// A compact agent row: just the name (which already carries the "@ provider" suffix, so it
    /// disambiguates on its own) plus a disabled pill. Tapping jumps straight to the agent.
    private func agentRow(_ agent: Agent) -> some View {
        let selected = model.selectedSection == .agents && model.selectedAgentID == agent.id
        return Button {
            openAgent(agent.id)
        } label: {
            HStack(spacing: 6) {
                Text(agent.name)
                    .lineLimit(1)
                    .foregroundStyle(.primary)
                if agent.enabled == false {
                    Text("disabled")
                        .font(.orbitMeta)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(.quaternary, in: Capsule())
                }
                Spacer(minLength: 0)
            }
            .padding(.leading, 32)
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(selected ? Color.accentColor.opacity(0.12) : Color.clear)
    }

    /// Jump straight to an agent from the drawer: mirror the Agents-list selection (clear stale
    /// session / compose state), enter the Agents section, and close the drawer. The compact split
    /// then surfaces that agent's sessions.
    private func openAgent(_ id: String) {
        model.openAgent(id)
        close()
    }
}

private extension View {
    /// Adds the leading hamburger that opens the nav drawer. Applied to a section's *root* view so it
    /// shows only in the root nav bar (pushed pages keep the system back button).
    func drawerToggle(open: @escaping () -> Void) -> some View {
        toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: open) {
                    Image(systemName: "line.3.horizontal")
                }
                .accessibilityLabel("Open navigation")
            }
        }
    }
}

/// The new-session draft composer, pushed full-screen onto the compact Agents stack. The regular-width
/// shell renders this same `NewSessionView` inline in the Agents detail pane; the collapsed compact
/// split can't reach that pane from a boolean, so we push it as its own page here. The system back
/// button abandons the draft (clearing the `isPresented` binding).
///
/// Once the draft creates a session this page swaps the composer for that session's live console **in
/// place** — it does *not* pop itself and push the detail column. Driving the console off
/// `selectedAgentSessionID` (the split's detail push) while simultaneously clearing
/// `composingAgentSession` (this page's `isPresented` push) meant two navigation mechanisms racing on
/// the one collapsed stack: after enough push/pop churn (opening then closing ~10+ sessions) the
/// detail intermittently landed with a nil selection, i.e. the "Select a session" empty state. Keeping
/// the whole transition on this single page removes the race — there's nothing to pop, and the console
/// never depends on the list selection. The created session is still registered into the agent list so
/// it's there (selected on tap) once the user backs out to it.
private struct AgentComposePush: View {
    @Environment(AppModel.self) private var model
    /// Non-nil once the draft creates a session: the page renders its console instead of the composer.
    @State private var created: Session?

    var body: some View {
        Group {
            if let registry = model.consoleRegistry, let agents = model.agents,
               let id = model.selectedAgentID, let agent = agents.agent(id) {
                if let created {
                    ConsoleView(sessionID: created.id, agentID: id, registry: registry)
                } else {
                    NewSessionView(agent: agent, registry: registry,
                                   defaultEffort: model.user?.preferences?.defaultEffort) { session in
                        model.agents?.registerCreatedSession(session)
                        created = session
                        // Mark it the focused console so the shell starts its SSE stream — the
                        // page keeps `composingAgentSession` true, under which the normal focus
                        // rule streams nothing.
                        model.composedConsoleSessionID = session.id
                    }
                    .navigationTitle(agent.name)
                }
            } else {
                ContentUnavailableView("Select an agent", systemImage: "person.2")
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        // Leaving the page (system back, or the section/agent changing out from under it) ends the
        // compose console: drop the focus override so its stream stops and focus falls back to the
        // list. Guarded so a stale disappear can't clear a newer compose.
        .onDisappear {
            if model.composedConsoleSessionID == created?.id { model.composedConsoleSessionID = nil }
        }
    }
}
#endif
