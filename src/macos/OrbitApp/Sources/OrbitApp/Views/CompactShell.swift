#if os(iOS)
import SwiftUI
import UIKit
import OrbitKit

/// iPhone (compact width) navigation shell. Instead of a bottom tab bar, the sections live behind a
/// **left drawer** (mirroring the web AppShell's left sidebar), opened two ways:
///   • the leading hamburger in each section's root nav bar (discoverable), and
///   • an edge-swipe from the left (fast + one-handed), enabled only at a section's root so it never
///     fights the system back-swipe on a pushed page.
/// The drawer pushes the content to the right as a large-radius card casting a soft shadow onto the
/// drawer (ChatGPT-style: the content stays fully bright and the depth comes from the shadow alone,
/// with the drawer surface one level below the card's); tapping the exposed content or swiping left
/// closes it. The current section is highlighted.
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
            // How far open, 0…1 — drives the shadow's strength and the card's corner radius so they
            // grow in with the peek.
            let progress = dw > 0 ? x / dw : 0
            // Leading-edge corner radius: 0 when closed (the mask is then a plain full-screen rect, so
            // the normal layout is untouched) → ~36 fully open — the large ChatGPT-style radius that
            // makes the content read as a card lifted off the drawer rather than a nicked screen edge.
            let corner = 36 * progress

            ZStack(alignment: .leading) {
                // A consistent app-background base under the fixed sidebar and the sliding card, so the
                // reveal reads in light and dark rather than exposing the raw window behind the shell.
                // Matches the drawer surface so the card reads as floating above one continuous layer.
                drawerSurface
                    .ignoresSafeArea()

                // Fixed sidebar pinned to the leading edge. It stays put while the content card slides
                // right to *reveal* it (ChatGPT-style), rather than sliding in alongside the content — so
                // no `.offset` here. The leading-aligned ZStack seats it at [0, dw]; the content on top
                // covers it when closed and uncovers it left-to-right as `x` grows.
                NavigationDrawer(close: closeDrawer)
                    .frame(width: dw)

                // The soft shadow the sliding content casts onto the drawer — the ChatGPT sense of the
                // content floating *above* the drawer, which is what reads as depth (with no dimming on
                // the content anymore this shadow carries the depth alone). It's cast by an opaque
                // stand-in shaped exactly like the card (same full-screen rect, same continuous corners,
                // same offset) sitting just beneath the content: a straight-edged gradient band was tried
                // first, but the card's rounded corners let the band's densest part show through as flat
                // dark patches in the corner cutouts, where a real shadow hugs the arc — `.shadow` on a
                // matching shape gets the corners right by construction. The stand-in is fully covered by
                // the content above, contains no live views (so console streaming never re-renders it),
                // and its top/bottom shadow falls off-screen (the shape's edges sit on the screen edges),
                // so nothing haloes into the safe areas. Opacity rides `progress` so the shadow fades and
                // slides in lockstep with the content instead of popping in on open; non-interactive so
                // drawer taps still land.
                RoundedRectangle(cornerRadius: corner, style: .continuous)
                    .fill(Color(uiColor: .systemBackground))
                    .ignoresSafeArea()
                    .shadow(color: .black.opacity(0.45 * progress), radius: 26, x: 0, y: 0)
                    .offset(x: x)
                    .allowsHitTesting(false)

                // Section content — pushed right, kept fully bright (ChatGPT-style: the card stays
                // white and the depth comes from the shadow, not a dim), with an invisible tap/swipe-
                // to-close layer over the peek. The layer is an overlay *inside* the offset (offset is
                // the outermost modifier) so it travels with the content and covers only the visible
                // peek at [x, x+w]. Applying the overlay after `.offset` would size it to the un-offset
                // full-screen frame — painting over the drawer and stealing its taps, so drawer rows
                // couldn't switch sections.
                CompactSections(openDrawer: openDrawer)
                    // An opaque backing *inside* the sliding content so its translucent bars — the
                    // transcript is a `.scrollContentBackground(.hidden)` (see-through) list, with `.bar`
                    // material on the status line / worktree bar / composer — sample a surface that
                    // travels with them. Without it those bars, finding nothing opaque in their own
                    // subtree, sample straight through to the *stationary* window (drawer/base); as the
                    // card slides, that backdrop shifts under them every frame and the blur re-rasterizes
                    // — the residual top/bottom-strip flicker left after the `.mask` was removed. The
                    // outer shadow proxy is opaque but a *sibling*, out of the bars' sampling subtree, so
                    // it can't play this role. `systemBackground` matches what the transcript showed
                    // through before, so the resting look is unchanged. (Only the console's transcript is
                    // a see-through list — every other section's list is opaque and covers this backing,
                    // so they're visually untouched.)
                    .background {
                        Color(uiColor: .systemBackground).ignoresSafeArea()
                    }
                    .overlay {
                        if x > 0 {
                            Color.clear
                                .ignoresSafeArea()
                                .contentShape(Rectangle())
                                .onTapGesture(perform: closeDrawer)
                                .gesture(closeDrag(width: w))
                        }
                    }
                    // Round the content's leading corners into a floating card as it slides open —
                    // *without* masking the live content. A `.mask`/`.clipShape` composites the whole
                    // section — including its translucent `UIVisualEffectView` nav bar — into an offscreen
                    // buffer every frame; re-rasterizing that blur as the drawer slides behind it is what
                    // made the drag (closing especially) flicker. Instead the content rides a plain
                    // `.offset` and we lay an opaque cutout over only the corner slivers, in the drawer
                    // surface color, so the square corners *read* as rounded against the revealed drawer
                    // while the content layer is never rasterized. Full-screen + `.ignoresSafeArea` so only
                    // the screen-edge corners are shaped (matching the shadow proxy), leaving the console's
                    // own safe-area insets untouched. At `corner == 0` the cutout is empty: a closed no-op.
                    .overlay {
                        CornerCutout(radius: corner)
                            .fill(drawerSurface, style: FillStyle(eoFill: true))
                            .ignoresSafeArea()
                            .allowsHitTesting(false)
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

    /// ChatGPT-style peek: the drawer takes ~3/4 of the width, leaving a generous content peek.
    private func drawerWidth(_ w: CGFloat) -> CGFloat { min(324, w * 0.76) }

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
        // Measure in the GLOBAL (screen-fixed) space, not the default `.local`. This gesture lives on the
        // content overlay, which is itself `.offset` by the very `dragX` we set here — so a `.local`
        // translation is read in a frame that moves as we drag, feeding the content's own displacement
        // back into each next reading. That feedback makes the offset stutter left/right every frame — the
        // rapid drag flicker. A global frame is pinned to the screen, so `translation` tracks only the
        // finger. (openDrag needs no such fix: it rides the stationary edge strip, not the moving content.)
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
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

/// The drawer surface color — one level below the content card so the undimmed white card floats.
/// `secondarySystemBackground` (#F2F2F7) read too gray next to ChatGPT's near-white drawer, so light
/// uses ~#F9F9F9: barely off-white, leaving the card/drawer separation to the edge shadow (exactly
/// how ChatGPT reads). Dark keeps #1C1C1E (secondarySystemBackground's dark value, written literally
/// to avoid resolving a nested dynamic color) so the black card and its shadow stay visible.
private let drawerSurface = Color(uiColor: UIColor { trait in
    trait.userInterfaceStyle == .dark
        ? UIColor(red: 28 / 255, green: 28 / 255, blue: 30 / 255, alpha: 1)
        : UIColor(white: 0.976, alpha: 1)
})

/// A full-screen rectangle with a rounded-rectangle "hole", even-odd filled so only the corner slivers
/// between the square screen edge and the card's rounded corner get painted. Laid opaquely over the
/// (unmasked) sliding content in the drawer-surface color, it fakes the card's rounded leading corners
/// *without* masking the live content — so the console and its translucent nav bar ride a cheap `.offset`
/// and never trigger the offscreen re-rasterization a `.mask` forces (the source of the drag flicker).
/// The interior stays unfilled — even-odd: a ray from an interior point crosses both the outer rect and
/// the inner rounded rect (two crossings, even) — so the content shows through everywhere but the corners.
private struct CornerCutout: Shape {
    var radius: CGFloat
    /// Animate the radius so it grows/shrinks with the open/close offset animation, exactly as the
    /// `RoundedRectangle(cornerRadius:)` did when this was a mask.
    var animatableData: CGFloat {
        get { radius }
        set { radius = newValue }
    }
    func path(in rect: CGRect) -> Path {
        var path = Path(rect)
        path.addPath(Path(roundedRect: rect, cornerRadius: radius, style: .continuous))
        return path
    }
}

/// One place for the drawer's spacing rhythm so every row lines up on the same grid. Tuned for a
/// calm, ChatGPT-style rail: roomy ~44pt rows, a hair of space between them, and a rounded selection
/// pill that's inset from both edges rather than an edge-to-edge tint.
private enum DrawerMetrics {
    static let hInset: CGFloat = 10                // outer inset → the selection pill floats off both edges
    static let padH: CGFloat = 12                  // inner horizontal padding (edge of pill → icon)
    static let padV: CGFloat = 11                  // inner vertical padding → ~44pt primary rows
    static let corner: CGFloat = 10                // selection-pill corner radius
    static let textLeading = hInset + padH         // 22 — aligns the title/section headers to row content
}

/// The left navigation drawer: the section rail (mirroring the web sidebar) over the account footer.
/// The current section is highlighted.
private struct NavigationDrawer: View {
    @Environment(AppModel.self) private var model
    let close: () -> Void
    /// Which runner groups are expanded to reveal their agents. A lone group always shows; the group
    /// holding the current agent is seeded open once (see the `.onChange` below) so the drawer lands
    /// showing your context, but a tap can still collapse it. Persists across open/close because this
    /// view stays mounted (offset off-screen) in the shell's ZStack.
    @State private var expandedRunners: Set<String> = []
    /// Guards the one-time seed of the selected agent's machine, so a later agent list reload doesn't
    /// re-open a group the user has since collapsed.
    @State private var didSeedExpansion = false

    var body: some View {
        let isAdmin = model.user?.role == "ADMIN"
        return VStack(alignment: .leading, spacing: 0) {
            Text("Orbit")
                .font(.title2.weight(.bold))
                .padding(.leading, DrawerMetrics.textLeading)
                .padding(.trailing, DrawerMetrics.hInset)
                .padding(.top, 14)
                .padding(.bottom, 8)

            List {
                // Runners is dropped from the drawer rail on iOS (it lives under Settings); Settings and
                // Admin fold into the account footer menu below. The runner-grouped agents still surface
                // each machine by name — so the rail is just Agents (as machines) + Tasks.
                ForEach(AppSection.visible(isAdmin: isAdmin).filter { ![.runners, .settings, .admin].contains($0) }) { section in
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
            // Let each row's own padding set its height and let the drawer background show through, so
            // the rail reads as calm whitespace (ChatGPT-style) rather than a boxed, hairline-separated
            // table. Separators + the selection pill are drawn per row — see `drawerRow` / `pill`.
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 0)
            // Agents are always shown now, so load the list when the drawer mounts (mirrors the macOS
            // sidebar), then land on the first agent. It's light; the heavy session list loads separately.
            .task { await model.loadAgentsThenLand() }
            // Seed the machine you're currently in open on first load (so the drawer lands showing your
            // context), then let taps win — the selected machine stays collapsible. See `isExpanded`.
            .onChange(of: selectedGroupKey, initial: true) { _, key in
                guard !didSeedExpansion, let key else { return }
                expandedRunners.insert(key)
                didSeedExpansion = true
            }

            Divider()
            AccountFooter(onSelectSection: { section in
                model.selectedSection = section
                close()
            })
                .background(.bar)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // One level below the content card's background (ChatGPT-style), so the undimmed white card
        // separates from the drawer in light mode and the shadow band stays visible in dark mode.
        .background(drawerSurface)
    }

    /// Shared chrome for a tappable drawer row: a consistent height and an inset, rounded selection
    /// "pill" (rather than an edge-to-edge tint) so the active row reads as a floating highlight — the
    /// modern sidebar look the web nav and ChatGPT share. `indent` nudges nested content (an agent
    /// under its machine) rightward without moving the pill; every row shares one height.
    @ViewBuilder
    private func pill(selected: Bool, indent: CGFloat = 0,
                      @ViewBuilder _ content: () -> some View) -> some View {
        content()
            .padding(.leading, DrawerMetrics.padH + indent)
            .padding(.trailing, DrawerMetrics.padH)
            .padding(.vertical, DrawerMetrics.padV)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Color.accentColor.opacity(0.14) : Color.clear,
                        in: RoundedRectangle(cornerRadius: DrawerMetrics.corner, style: .continuous))
            .contentShape(Rectangle())
    }

    /// A plain destination row: tapping switches section and closes the drawer.
    private func sectionRow(_ section: AppSection) -> some View {
        let selected = section == model.selectedSection
        return Button {
            model.selectedSection = section
            close()
        } label: {
            pill(selected: selected) {
                HStack(spacing: 12) {
                    Image(systemName: section.systemImage)
                        .frame(width: 24)
                        .foregroundStyle(selected ? Color.accentColor : .primary)
                    Text(section.title)
                        .fontWeight(selected ? .semibold : .regular)
                        .foregroundStyle(.primary)
                    Spacer(minLength: 0)
                }
            }
        }
        .buttonStyle(.plain)
        .drawerRow()
    }

    // MARK: Recents

    /// The "Recents" header + rows: the most-recently-active sessions across every agent, tapping
    /// straight into that session's console. Hidden until the cross-agent Active list has loaded.
    @ViewBuilder
    private var recentsRows: some View {
        let recents = model.recentSessions
        if !recents.isEmpty {
            Text("Recents")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.leading, DrawerMetrics.textLeading)
                .padding(.top, 18)
                .padding(.bottom, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
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
            pill(selected: selected) {
                Text(s.title ?? "Untitled session")
                    .lineLimit(1)
                    .foregroundStyle(.primary)
            }
        }
        .buttonStyle(.plain)
        .drawerRow()
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
            pill(selected: false) {
                HStack(spacing: 12) {
                    Image(systemName: group.runnerId == nil ? "shippingbox" : "desktopcomputer")
                        .frame(width: 24)
                        .foregroundStyle(.primary)
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
            }
        }
        .buttonStyle(.plain)
        .drawerRow()
    }

    private func groupKey(_ g: AgentGroup) -> String { g.runnerId ?? "host" }

    /// The group key of the machine holding the currently-selected agent, if any — the seed target.
    private var selectedGroupKey: String? {
        guard let sel = model.selectedAgentID, let groups = model.agents?.groups else { return nil }
        return groups.first(where: { $0.agents.contains(where: { $0.id == sel }) }).map(groupKey)
    }

    /// A group is shown expanded when it's the only group or when it's in `expandedRunners` (seeded from
    /// the selected agent on first load, then driven by taps). Otherwise collapsed — Recents is the
    /// primary way in, so the machine list stays tidy by default.
    private func isExpanded(_ g: AgentGroup, totalGroups: Int) -> Bool {
        if totalGroups <= 1 { return true }
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
            // Indent the content to sit under the machine's *label* (icon width + its spacing) while
            // the selection pill still lines up with every other row. Uses the drawer's standard row
            // height (like machines / Tasks / Recents) — nesting is conveyed by the indent alone, so the
            // whole rail shares one rhythm rather than making the agent sub-rows read a size smaller.
            pill(selected: selected, indent: 24 + 12) {
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
            }
        }
        .buttonStyle(.plain)
        .drawerRow()
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
    /// The shared list-row chrome for every drawer row: kill the plain-list hairline separators, clear
    /// the default row background (selection is drawn as the row's own inset pill), and inset the row a
    /// hair top/bottom so consecutive pills don't touch. Rows read as clean text-on-whitespace until
    /// one is selected — the ChatGPT look, minus the boxed table.
    func drawerRow() -> some View {
        self
            .listRowInsets(EdgeInsets(top: 1, leading: DrawerMetrics.hInset,
                                      bottom: 1, trailing: DrawerMetrics.hInset))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

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
                    // Rebuild the draft when the hero switcher changes the agent (draftModel is per-agent).
                    .id(agent.id)
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
