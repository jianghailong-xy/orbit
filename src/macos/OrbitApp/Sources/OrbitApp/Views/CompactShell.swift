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
/// Under the hood the sections stay a `TabView` (its tab bar hidden) so each section keeps its own
/// live navigation stack across switches — the drawer just drives `selectedSection`. Every existing
/// `List(selection:)` sidebar + detail pair from the iPad shell is reused verbatim.
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
                CompactSections(needsYou: model.groups.needsYou.count, openDrawer: openDrawer)
                    .offset(x: x)
                    .overlay {
                        if x > 0 {
                            Color.black.opacity(0.35 * (x / dw))
                                .ignoresSafeArea()
                                .onTapGesture(perform: closeDrawer)
                                .gesture(closeDrag(width: w))
                        }
                    }

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

/// The sections, as a `TabView` with its bar hidden — kept (rather than swapping a single pane) so
/// each section preserves its own navigation stack when the drawer switches away and back. Selection
/// is bound to `selectedSection`, so the drawer and deep links drive it identically.
private struct CompactSections: View {
    @Environment(AppModel.self) private var model
    let needsYou: Int
    let openDrawer: () -> Void

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.selectedSection) {
            // ACTIVE — live sessions → console
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
            .tag(AppSection.active)
            .toolbar(.hidden, for: .tabBar)

            // TASKS — task list → detail
            NavigationSplitView {
                TasksListView()
                    .drawerToggle(open: openDrawer)
                    .refreshable { await model.tasks?.load() }
            } detail: {
                TaskDetailView()
            }
            .tag(AppSection.tasks)
            .toolbar(.hidden, for: .tabBar)

            // AGENTS — agent list → the agent's sessions → console (three levels, like the iPad)
            NavigationSplitView {
                AgentListCompact()
                    .drawerToggle(open: openDrawer)
            } content: {
                AgentContentColumn()
            } detail: {
                AgentConsoleDetail()
            }
            .tag(AppSection.agents)
            .toolbar(.hidden, for: .tabBar)

            // RUNNERS — runner list → detail
            NavigationSplitView {
                RunnersListView()
                    .drawerToggle(open: openDrawer)
                    .refreshable { await model.runners?.load() }
            } detail: {
                RunnerDetailView()
            }
            .tag(AppSection.runners)
            .toolbar(.hidden, for: .tabBar)

            // SKILLS / SETTINGS / ADMIN — single-pane sections, now first-class drawer destinations
            // (they used to hide behind a "More" tab).
            NavigationStack {
                SkillsView().drawerToggle(open: openDrawer)
            }
            .tag(AppSection.skills)
            .toolbar(.hidden, for: .tabBar)

            NavigationStack {
                SettingsView().drawerToggle(open: openDrawer)
            }
            .tag(AppSection.settings)
            .toolbar(.hidden, for: .tabBar)

            if model.user?.role == "ADMIN" {
                NavigationStack {
                    AdminUsersView().drawerToggle(open: openDrawer)
                }
                .tag(AppSection.admin)
                .toolbar(.hidden, for: .tabBar)
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
                    let selected = section == model.selectedSection
                    Button {
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
            }
            .listStyle(.plain)

            Divider()
            AccountFooter()
                .background(.bar)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(uiColor: .systemBackground))
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
