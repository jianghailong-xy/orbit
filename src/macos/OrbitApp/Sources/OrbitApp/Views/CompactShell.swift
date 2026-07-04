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
/// left closes it. The current section is highlighted, and Active's "needs you" count rides on the
/// hamburger as a dot so the signal survives while the drawer is closed.
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
                NavigationDrawer(needsYou: model.groups.needsYou.count, close: closeDrawer)
                    .frame(width: dw)
                    .offset(x: x - dw)

                // Section content — pushed right, dimmed, and tap/swipe-to-close via the scrim.
                // The scrim is an overlay *inside* the offset (offset is the outermost modifier) so it
                // travels with the content and dims only the visible peek at [x, x+w]. Applying the
                // overlay after `.offset` would size it to the un-offset full-screen frame — painting
                // over the drawer and stealing its taps, so drawer rows couldn't switch sections.
                CompactSections(needsYou: model.groups.needsYou.count, openDrawer: openDrawer)
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
            // New session draft composer (the Agents compose button). On compact the three-column
            // split collapses to a stack whose detail is only *pushed* by a selection, so present the
            // draft as a sheet instead. Attached here so it presents regardless of the active section.
            .sheet(isPresented: $model.composingAgentSession) { AgentComposeSheet() }
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

    /// A section is "at root" when nothing is pushed onto its stack, so the left edge is free for the
    /// open gesture. Derived from the shared selection state that drives each stack's push.
    private var isAtRoot: Bool {
        switch model.selectedSection {
        case .active:  return model.selectedSessionID == nil
        case .tasks:   return model.selectedTaskID == nil
        case .agents:  return model.selectedAgentID == nil
        case .runners: return model.selectedRunnerID == nil
        case .skills, .settings, .admin: return true
        }
    }
}

/// The selected section's navigation stack, switched on `selectedSection`. A hidden-tab-bar `TabView`
/// was tried first (to keep every section's stack alive across switches) but its *programmatic*
/// selection didn't move the pane on device — tapping a drawer row closed the drawer without
/// navigating. Rendering one section at a time via a plain `switch` (like the iPad `MainView`) makes
/// the drawer and deep links switch reliably. The trade: switching away resets the *other* sections'
/// stacks; drilling *within* the current section is still preserved.
private struct CompactSections: View {
    @Environment(AppModel.self) private var model
    let needsYou: Int
    let openDrawer: () -> Void

    var body: some View {
        @Bindable var model = model
        switch model.selectedSection {
        // ACTIVE — live sessions → console
        case .active:
            NavigationSplitView {
                SectionContent(section: .active, sessionSelection: $model.selectedSessionID)
                    .drawerToggle(open: openDrawer, badge: needsYou)
                    .onChange(of: model.selectedSessionID, initial: true) { _, _ in
                        model.scheduleConsoleActivate()
                    }
                    .refreshable { await model.loadSessions() }
            } detail: {
                SectionDetail(section: .active)
            }

        // TASKS — task list → detail
        case .tasks:
            NavigationSplitView {
                TasksListView()
                    .drawerToggle(open: openDrawer)
                    .refreshable { await model.tasks?.load() }
            } detail: {
                TaskDetailView()
            }

        // AGENTS — agent list → the agent's sessions → console (three levels, like the iPad)
        case .agents:
            NavigationSplitView {
                AgentListCompact()
                    .drawerToggle(open: openDrawer)
            } content: {
                AgentContentColumn()
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
            NavigationStack { SkillsView().drawerToggle(open: openDrawer) }

        case .settings:
            NavigationStack { SettingsView().drawerToggle(open: openDrawer) }

        case .admin:
            NavigationStack { AdminUsersView().drawerToggle(open: openDrawer) }
        }
    }
}

/// The left navigation drawer: the section rail (mirroring the web sidebar) over the account footer.
/// The current section is highlighted; Active carries the amber "needs you" count.
private struct NavigationDrawer: View {
    @Environment(AppModel.self) private var model
    let needsYou: Int
    let close: () -> Void
    /// Whether the Agents row is expanded to its runner-grouped agents. Persisted (defaults collapsed)
    /// so nav-only users keep a clean drawer while power users who hop between agents keep the
    /// quick-jump list open across launches.
    @AppStorage("drawerAgentsExpanded") private var agentsExpanded = false

    var body: some View {
        let isAdmin = model.user?.role == "ADMIN"
        return VStack(alignment: .leading, spacing: 0) {
            Text("Orbit")
                .font(.title2.weight(.bold))
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 8)

            List {
                ForEach(AppSection.visible(isAdmin: isAdmin)) { section in
                    // Agents folds into the drawer as an expandable quick-jump (mirroring the macOS
                    // sidebar disclosure); every other section is a plain destination row.
                    if section == .agents {
                        agentsRows
                    } else {
                        sectionRow(section)
                    }
                }
            }
            .listStyle(.plain)
            // Load the runner-grouped agents lazily — only once the quick-jump section is first
            // opened, so the default (collapsed) drawer adds no fetch at launch.
            .task(id: agentsExpanded) { if agentsExpanded { await model.agents?.load() } }

            Divider()
            AccountFooter()
                .background(.bar)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(uiColor: .systemBackground))
    }

    /// A plain destination row: tapping switches section and closes the drawer. Active carries the
    /// amber "needs you" count.
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
                if section == .active && needsYou > 0 {
                    Text("\(needsYou)")
                        .font(.caption2.bold())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.orange, in: Capsule())
                        .foregroundStyle(.white)
                }
            }
            .contentShape(Rectangle())
        }
        .listRowBackground(selected ? Color.accentColor.opacity(0.12) : Color.clear)
    }

    /// The Agents row plus, when expanded, its runner-grouped agents. Emitted as sibling list rows.
    @ViewBuilder
    private var agentsRows: some View {
        agentsHeaderRow
        if agentsExpanded {
            if let agents = model.agents, !agents.items.isEmpty {
                ForEach(agents.groups) { group in
                    Text(agents.runnerLabel(group.runnerId))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 36)
                        .padding(.vertical, 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .listRowBackground(Color.clear)
                    ForEach(group.agents) { agent in
                        agentRow(agent)
                    }
                }
            } else {
                Text(model.agents?.loading == true ? "Loading…" : "No agents")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 36)
                    .listRowBackground(Color.clear)
            }
        }
    }

    /// Two disjoint hit targets: the label navigates to the full Agents page (unchanged behavior,
    /// where model · workDir + edit + New session live); the trailing caret only expands/collapses
    /// the quick-jump list in place.
    private var agentsHeaderRow: some View {
        let selected = model.selectedSection == .agents
        return HStack(spacing: 0) {
            Button {
                model.selectedSection = .agents
                close()
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: AppSection.agents.systemImage)
                        .frame(width: 24)
                        .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                    Text(AppSection.agents.title)
                        .fontWeight(selected ? .semibold : .regular)
                        .foregroundStyle(.primary)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                withAnimation(.snappy(duration: 0.2)) { agentsExpanded.toggle() }
            } label: {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(agentsExpanded ? 90 : 0))
                    .frame(width: 40, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(agentsExpanded ? "Collapse agents" : "Expand agents")
        }
        .listRowBackground(selected ? Color.accentColor.opacity(0.12) : Color.clear)
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
                        .font(.caption2)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(.quaternary, in: Capsule())
                }
                Spacer(minLength: 0)
            }
            .padding(.leading, 46)
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(selected ? Color.accentColor.opacity(0.12) : Color.clear)
    }

    /// Jump straight to an agent from the drawer: mirror the Agents-list selection (clear stale
    /// session / compose state), enter the Agents section, and close the drawer. The compact split
    /// then surfaces that agent's sessions.
    private func openAgent(_ id: String) {
        if model.selectedAgentID != id {
            model.selectedAgentSessionID = nil
            model.composingAgentSession = false
        }
        model.selectedSection = .agents
        model.selectedAgentID = id
        close()
    }
}

private extension View {
    /// Adds the leading hamburger that opens the nav drawer. Applied to a section's *root* view so it
    /// shows only in the root nav bar (pushed pages keep the system back button). `badge > 0` marks
    /// the button with an amber dot so a "needs you" signal survives while the drawer is closed.
    func drawerToggle(open: @escaping () -> Void, badge: Int = 0) -> some View {
        toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: open) {
                    Image(systemName: "line.3.horizontal")
                        .overlay(alignment: .topTrailing) {
                            if badge > 0 {
                                Circle().fill(.orange)
                                    .frame(width: 8, height: 8)
                                    .offset(x: 5, y: -4)
                            }
                        }
                }
                .accessibilityLabel(badge > 0 ? "Open navigation, \(badge) need you" : "Open navigation")
            }
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
        .refreshable { await model.agents?.load() }
        .onChange(of: model.selectedAgentID) { _, _ in
            model.selectedAgentSessionID = nil
            model.composingAgentSession = false
        }
        .task { await model.agents?.load() }
    }
}

/// The new-session draft composer, presented as a sheet on compact width. The regular-width shell
/// renders this same `NewSessionView` inline in the Agents detail pane; the collapsed compact split
/// can't reach that pane from a boolean, so we surface it as a modal instead. Sending creates the
/// session, then dismisses and selects it so its console pushes onto the Agents stack.
private struct AgentComposeSheet: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            Group {
                if let registry = model.consoleRegistry, let agents = model.agents,
                   let id = model.selectedAgentID, let agent = agents.agent(id) {
                    NewSessionView(agent: agent, registry: registry) { session in
                        model.composingAgentSession = false
                        model.selectedAgentSessionID = session.id
                    }
                    .navigationTitle(agent.name)
                } else {
                    ContentUnavailableView("Select an agent", systemImage: "person.2")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { model.composingAgentSession = false }
                }
            }
        }
    }
}
#endif
