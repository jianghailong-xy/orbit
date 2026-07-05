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

    /// A section is "at root" when nothing is pushed onto its stack, so the left edge is free for the
    /// open gesture. Derived from the shared selection state that drives each stack's push.
    private var isAtRoot: Bool {
        switch model.selectedSection {
        case .active:  return model.selectedSessionID == nil
        case .tasks:   return model.selectedTaskID == nil
        case .agents:  return model.selectedAgentSessionID == nil
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
/// The current section is highlighted; Active carries the amber "needs you" count.
private struct NavigationDrawer: View {
    @Environment(AppModel.self) private var model
    let needsYou: Int
    let close: () -> Void

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
                    // The Agents nav row is replaced in place by its runner-grouped agents, listed
                    // directly (no wrapper, no collapse) so the drawer carries one less level. Every
                    // other section stays a plain destination row.
                    if section == .agents {
                        agentsRows
                    } else {
                        sectionRow(section)
                    }
                }
            }
            .listStyle(.plain)
            // Agents are always shown now, so load the list when the drawer mounts (mirrors the macOS
            // sidebar). It's light; the heavy session list loads separately.
            .task { await model.agents?.load() }

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

    /// The runner-grouped agents, listed directly where the Agents nav row used to be — each runner
    /// label leads its agents, with no "Agents" wrapper and no collapse. Emitted as sibling list
    /// rows. Renders nothing until the list loads (or when there are no agents).
    @ViewBuilder
    private var agentsRows: some View {
        if let agents = model.agents, !agents.items.isEmpty {
            ForEach(agents.groups) { group in
                Text(agents.runnerLabel(group.runnerId))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 20)
                    .padding(.top, 8)
                    .padding(.bottom, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .listRowBackground(Color.clear)
                ForEach(group.agents) { agent in
                    agentRow(agent)
                }
            }
        }
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

/// The new-session draft composer, pushed full-screen onto the compact Agents stack. The regular-width
/// shell renders this same `NewSessionView` inline in the Agents detail pane; the collapsed compact
/// split can't reach that pane from a boolean, so we push it as its own page here. The system back
/// button abandons the draft (clearing the `isPresented` binding); sending creates the session and
/// selects it so its console pushes onto the stack in its place.
private struct AgentComposePush: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let registry = model.consoleRegistry, let agents = model.agents,
               let id = model.selectedAgentID, let agent = agents.agent(id) {
                NewSessionView(agent: agent, registry: registry,
                               defaultEffort: model.user?.preferences?.defaultEffort) { session in
                    model.openCreatedAgentSession(session)
                }
                .navigationTitle(agent.name)
            } else {
                ContentUnavailableView("Select an agent", systemImage: "person.2")
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }
}
#endif
