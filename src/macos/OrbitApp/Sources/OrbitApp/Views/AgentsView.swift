import SwiftUI
import OrbitKit

// Batch D + Agents-in-sidebar refinement: the agent *list* (grouped by runner) now lives in the
// sidebar source list (see `SectionSidebar`), folding away the old middle column. What remains
// here is the selected agent's detail, split across the two right panes to mirror Active:
//   • content column → the agent's sessions as a plain list; the window toolbar hosts the
//                       Active/Completed/System scope switcher (principal), a New-session button
//                       (leading), and a gear that opens the agent's Settings sheet (trailing)
//   • detail column  → the live console for the session picked in the content column
// Grouping + effective-model logic come from the verified OrbitKit `AgentListLogic`; pickers reuse
// `AgentDefaults`. SwiftUI here is parse-checked only — verify on a Mac.
//
// IA note: the web edits agents *inside* the Runner detail page (an agent belongs to a runner);
// this surfaces a flatter Agents nav whose items are the agents themselves.

/// A row for an agent in the sidebar disclosure: name (+ disabled pill) over model · workDir.
/// `shortcutIndex`, when set (the first nine agents), shows a faint "⌘N" hint for the switch
/// shortcut so it's learnable.
struct AgentRowView: View {
    let agent: Agent
    var shortcutIndex: Int? = nil
    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(agent.name).lineLimit(1)
                    if agent.enabled == false {
                        Text("disabled").font(.orbitMeta)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                    }
                }
                Text(AgentDefaults.friendlyName(AgentListLogic.effectiveModel(model: agent.model, env: agent.env))
                     + (agent.workDir.map { " · \($0)" } ?? ""))
                    .font(.orbitListSubtitle).foregroundStyle(.secondary).lineLimit(1)
            }
            if let shortcutIndex {
                Spacer(minLength: 4)
                Text("⌘\(shortcutIndex + 1)")
                    .font(.orbitMeta).monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// Content (middle) column for the Agents section: the selected agent's sessions, with a toolbar
/// gear to edit the agent. Selecting a session drives the console in the detail column.
struct AgentContentColumn: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        @Bindable var app = app
        if let agents = app.agents, let id = app.selectedAgentID, let a = agents.agent(id) {
            AgentPanes(agents: agents, agent: a, selectedSessionID: $app.selectedAgentSessionID)
                .id(a.id)
                .navigationTitle(a.name)
        } else {
            ContentUnavailableView("Select an agent", systemImage: "person.2",
                                   description: Text("Pick an agent in the sidebar to see its sessions and settings."))
        }
    }
}

struct AgentPanes: View {
    @Environment(AppModel.self) private var app
    let agents: AgentsModel
    let agent: Agent
    @Binding var selectedSessionID: String?
    @State private var view: SessionView = .active
    @State private var showSettings = false
    // Set true when the composer hands ↑/↓ back on Escape, so the session list can be arrow-navigated
    // without a click; the binding also tracks click-to-focus.
    @FocusState private var listFocused: Bool

    var body: some View {
        // Option B: the column is just the session list. The scope switcher and New-session action
        // live in the window toolbar (below) — like Finder/Mail hosting view controls in the toolbar
        // rather than stacking chrome bands above the list.
        List(selection: $selectedSessionID) {
            #if os(iOS)
            // ChatGPT-style recency sections (Pinned / Today / Yesterday / Previous 7 Days / …) — a
            // deliberate divergence from web's flat list, grouping the tall single-column iPhone list
            // by last activity. Bucketing is the pure, tested `SessionTimeGrouping`. macOS keeps the
            // flat list (its 3-pane window reads fine without sections).
            ForEach(SessionTimeGrouping.sections(agents.agentSessions, pinnedFirst: view == .active)) { section in
                Section {
                    ForEach(section.sessions) { s in
                        AgentSessionRow(session: s, completed: view == .completed, showsPin: view == .active).tag(s.id)
                            .sessionRowActions(s, scope: view)
                    }
                } header: {
                    Text(section.title).textCase(nil)
                }
            }
            #else
            ForEach(agents.agentSessions) { s in
                AgentSessionRow(session: s, completed: view == .completed, deleted: view == .trash,
                                showsPin: view == .active).tag(s.id)
                    .sessionRowActions(s, scope: view)
            }
            #endif
        }
        #if os(iOS)
        // Plain style so the sections read as light headers over full-width rows (matching the
        // current list), not boxed inset-grouped cards.
        .listStyle(.plain)
        #endif
        .focused($listFocused)
        .onChange(of: app.sessionListFocusRequest) { _, _ in listFocused = true }
        .overlay {
            if agents.agentSessions.isEmpty {
                ContentUnavailableView(
                    agents.sessionsLoading ? "Loading…" : "No \(view.title.lowercased()) sessions",
                    systemImage: "bubble.left.and.bubble.right")
            }
        }
        // Picking a session leaves the compose state (the console takes over the detail pane).
        .onChange(of: selectedSessionID) { _, new in
            if new != nil { app.composingAgentSession = false }
        }
        #if os(iOS)
        // Pull-to-refresh reloads the current agent + scope's sessions on demand (matching the
        // Active/Tasks/Runners lists). The pull control shows its own spinner, so reload *without*
        // `reset:` to update the rows in place rather than blanking the list mid-gesture.
        .refreshable { await agents.loadSessions(agentID: agent.id, view: view) }
        #endif
        // Reload when either the agent or the view changes (one key so a fast switch coalesces),
        // then poll every 4s — the same cadence as the Active sidebar — so external changes (new
        // sessions, status transitions made from the web) show up without reopening the agent.
        // The task is bound to this pane's lifetime: switching agent/view cancels and restarts it,
        // and leaving the Sessions pane stops the poll.
        .task(id: "\(agent.id)|\(view.rawValue)") {
            await agents.loadSessions(agentID: agent.id, view: view, reset: true)
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if Task.isCancelled { break }
                await agents.loadSessions(agentID: agent.id, view: view)
            }
        }
        .toolbar {
            #if os(iOS)
            // Compact: both actions sit at the trailing edge. The scope switcher collapses to a
            // pure filter-icon menu (no text) — Active/Completed/System as checkmarked options plus
            // the agent-settings gear folded in — and New Session is the rightmost primary action.
            // Declared scope-first so New Session lands at the trailing edge (SwiftUI lays trailing
            // items out in declaration order, leading→trailing; verify the order on device).
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    ForEach(SessionView.pickerCases) { v in
                        Button { view = v } label: {
                            if v == view { Label(v.title, systemImage: "checkmark") }
                            else { Text(v.title) }
                        }
                    }
                    Divider()
                    Button { showSettings = true } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                } label: {
                    Image(systemName: "line.3.horizontal.decrease")
                }
                .accessibilityLabel("Session scope, \(view.title)")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    app.startComposingSession()
                } label: {
                    Label("New session", systemImage: "square.and.pencil")
                }
                .accessibilityLabel("Start a new session with \(agent.name)")
            }
            #else
            // macOS: the wide window toolbar keeps the platform-idiomatic layout — New Session
            // (leading), a compact centered segmented scope switcher (principal), and a settings gear.
            ToolbarItem(placement: .navigation) {
                Button {
                    app.startComposingSession()
                } label: {
                    Label("New session", systemImage: "square.and.pencil")
                }
                .help("Start a new session with \(agent.name)")
            }
            ToolbarItem(placement: .principal) {
                Picker("View", selection: $view) {
                    ForEach(SessionView.pickerCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
            }
            ToolbarItem(placement: .primaryAction) {
                Button { showSettings = true } label: {
                    Label("Settings", systemImage: "gearshape")
                }
                .help("Edit this agent")
            }
            #endif
        }
        .sheet(isPresented: $showSettings) {
            AgentSettingsSheet(agents: agents, agent: agent)
        }
    }
}

/// The agent edit form, presented as a sheet from the content column's toolbar gear (it used to be
/// the "Settings" half of a Sessions/Settings segmented switch).
struct AgentSettingsSheet: View {
    let agents: AgentsModel
    let agent: Agent

    var body: some View {
        NavigationStack {
            AgentFormContent(agents: agents, agent: agent)
                .navigationTitle("\(agent.name) settings")
        }
        // A sizing hint for the macOS sheet only. On iOS a sheet is bound to the screen width, so
        // forcing a 480pt minimum overflows an iPhone (~390pt) — the form then centres wider than
        // the viewport and clips both edges (title/leading labels cut off). Let iOS size natively.
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 520)
        #endif
    }
}

/// Detail (right) column for the Agents section: the live console for the session selected in the
/// content column — mirroring how Active renders ConsoleView in its detail pane.
struct AgentConsoleDetail: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        if app.composingAgentSession, let registry = app.consoleRegistry, let agents = app.agents,
           let id = app.selectedAgentID, let agent = agents.agent(id) {
            // Draft compose state: the same ComposerView a live console uses, but its send creates a
            // new session, after which we open that session's console.
            NewSessionView(agent: agent, registry: registry,
                           defaultEffort: app.user?.preferences?.defaultEffort) { session in
                app.openCreatedAgentSession(session)
            }
            // Rebuild the draft when the hero switcher changes the agent (draftModel is per-agent).
            .id(agent.id)
        } else if let sid = app.selectedAgentSessionID, let registry = app.consoleRegistry {
            // No `.id(sid)`: reuse the warm cached console and swap streams via `.task(id:)`.
            // A just-created session isn't in the Active list yet, so fall back to the agent
            // we're viewing for `/` autocomplete scoping.
            ConsoleView(sessionID: sid, agentID: app.agentID(for: sid) ?? app.selectedAgentID, registry: registry)
        } else {
            ContentUnavailableView("Select a session", systemImage: "bubble.left.and.bubble.right",
                                   description: Text("The agent's live transcript appears here."))
        }
    }
}

/// The draft composer shown in the Agents detail pane while composing a new session. Mirrors the
/// web "new session" state: an empty-transcript hint over the *same* `ComposerView` a live console
/// uses, backed by a draft `ConsoleModel` whose send calls `createSession` (not `sendTurn`) and then
/// hands the new session back so the console takes over. Reusing `ComposerView` keeps the new-session
/// input at full parity — the `+` menu, `!`-shell, slash autocomplete, attachments, and the
/// model/permission/effort footer — instead of the simplified field it used to carry.
struct NewSessionView: View {
    let agent: Agent
    /// The account's synced default reasoning effort (`user.preferences.defaultEffort`), used to
    /// seed the effort pill so a value picked on web/another device carries here. Optional because
    /// a restored-token launch primes `user` asynchronously — the seed below reacts to it arriving.
    let defaultEffort: String?
    @State private var draft: ConsoleModel
    @Environment(AppModel.self) private var app
    @State private var showSwitcher = false

    init(agent: Agent, registry: ConsoleRegistry, defaultEffort: String? = nil,
         onCreated: @escaping (Session) -> Void) {
        self.agent = agent
        self.defaultEffort = defaultEffort
        _draft = State(initialValue: registry.draftModel(for: agent, onCreated: onCreated))
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                AgentAvatar(provider: agent.provider, size: 64)
                    .padding(.bottom, 6)
                // The agent identity is the hero — a cold launch lands here, so the screen answers
                // "which agent am I about to task?" at a glance. Tapping opens the switcher.
                Button { showSwitcher = true } label: {
                    HStack(spacing: 6) {
                        Text(agent.name).font(.title2.weight(.bold)).foregroundStyle(.primary).lineLimit(1)
                        Image(systemName: "chevron.down").font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Color.primary.opacity(0.05),
                                in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Text(heroSubtitle).font(.orbitListSubtitle).foregroundStyle(.secondary)
                Text("Send a task to get started.").font(.subheadline).foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 24)

            Divider()
            // createSession failures surface on the draft's statusMessage (mirrors ConsoleView).
            if let msg = draft.statusMessage {
                HStack {
                    Text(msg).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(2)
                    Spacer()
                    Button { draft.statusMessage = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 12).padding(.vertical, 4)
                .background(.bar)
            }
            ComposerView(console: draft, autoFocus: true)
        }
        .task { await draft.prepareDraft() }
        // Seed the effort pill from the account default. Reactive on `defaultEffort` so a value
        // that lands after the draft was built (async `user` prime on a restored-token launch) is
        // still adopted. Guarded on `.default` so it only fills an untouched pill — a manual pick
        // (or one already seeded) is never clobbered. Mirrors web's me-preference seed effect.
        .task(id: defaultEffort) {
            if draft.effort == .default, let raw = defaultEffort, let e = Effort(rawValue: raw) {
                draft.effort = e
            }
        }
        .sheet(isPresented: $showSwitcher) {
            AgentSwitchSheet(agents: app.orderedAgents, currentID: agent.id) { id in
                app.composeWithAgent(id)
            }
        }
    }

    /// "New session · <model> · <effort>" — surfaces the config the draft will start with (mirrors
    /// the composer footer) so the model/effort are visible up front, not just the agent name.
    private var heroSubtitle: String {
        var parts = ["New session", AgentDefaults.friendlyName(draft.modelID)]
        if draft.effort != .default { parts.append(draft.effort.label) }
        return parts.joined(separator: " · ")
    }
}

struct AgentSessionRow: View {
    let session: Session
    /// True when the Completed (archived) tab is showing this row — mirrors web's
    /// `completed={view === 'archived'}`, so a filed session reads as done, not "Cancelled".
    var completed: Bool = false
    /// True when the Trash tab is showing this row — mirrors web's `deletedAt` branch, so the glyph
    /// reads as a neutral ⊖ "Deleted" and the preview goes static (nothing is live in the trash).
    var deleted: Bool = false
    /// True in the Active view, where pinning applies — mirrors web's `view === 'active'` gate on the
    /// pinned marker. Completed/System/Trash rows never show the bar (they can't be pinned).
    var showsPin: Bool = false
    private var isPinned: Bool { showsPin && session.pinnedAt != nil }
    // Second line: the last-reply / live-state preview (mirrors the web Agent console). `live` mirrors
    // web's `openable` — false on the Trash tab (a deleted session isn't live), true elsewhere.
    private var line: SessionLine? { SessionLine.make(for: session, live: !deleted) }

    var body: some View {
        #if os(iOS)
        compactRow
        #else
        HStack(spacing: 0) {
            // A pinned session is marked at rest by a full-height leading accent bar, flush to the
            // row's leading edge — the native port of web's `.session-row.pinned` inset bar
            // (deliberately not a floating pushpin). It sits *outside* the content padding, with the
            // cell's `listRowInsets` zeroed below, so it bleeds to the top/bottom/leading edges like
            // web instead of floating short and inset. A clear bar of the same width keeps unpinned
            // rows aligned.
            Rectangle()
                .fill(isPinned ? Color.accentColor : .clear)
                .frame(width: 3)
            HStack(spacing: 8) {
                StatusGlyphView(glyph: .make(for: session, completed: completed, deleted: deleted))
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title ?? "Untitled session").lineLimit(1)
                    if let line {
                        Text(line.text).font(.orbitListSubtitle).foregroundStyle(lineColor(line.tone)).lineLimit(1)
                    }
                }
                Spacer()
                if let n = session.pendingApprovals, n > 0 {
                    Text("\(n)").font(.orbitMeta.bold())
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(.orange, in: Capsule()).foregroundStyle(.white)
                }
            }
            // Re-add the standard cell insets the zeroed `listRowInsets` removed: 3 (bar) + 13 = the
            // usual 16pt leading so the glyph stays put; 16 trailing; 10 vertical for a comfortable row.
            .padding(.leading, 13)
            .padding(.trailing, 16)
            .padding(.vertical, 10)
        }
        .listRowInsets(EdgeInsets())
        // Keep the separator aligned under the title now that the cell insets are zeroed, rather than
        // letting it run full-bleed: bar(3) + leading pad(13) + glyph(20) + spacing(8) = 44.
        .alignmentGuide(.listRowSeparatorLeading) { _ in 44 }
        #endif
    }

    #if os(iOS)
    /// The compact (iPhone) row for the ChatGPT-style grouped list: a flush-left title with a
    /// trailing relative time, a slim live cue (a spinner while working / an amber dot while it needs
    /// approval), over the preview line. No leading status glyph or pin accent bar — the recency
    /// sections carry pinning, and the preview line already states the live status in words + colour,
    /// so the heavy per-row glyph column is dropped for a calmer, more scannable list.
    private var compactRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(session.title ?? "Untitled session").lineLimit(1)
                Spacer(minLength: 8)
                liveIndicator
                if let rel = relTime {
                    Text(rel).font(.orbitMeta).foregroundStyle(.secondary)
                }
            }
            if let line {
                Text(line.text).font(.orbitListSubtitle).foregroundStyle(lineColor(line.tone)).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }

    /// The slim trailing status cue, derived from the same `SessionLine` tone the preview uses: a
    /// spinner while working, an amber dot while awaiting approval, nothing otherwise.
    @ViewBuilder private var liveIndicator: some View {
        switch line?.tone {
        case .running?:  SpinnerGlyph(color: .blue)
        case .approval?: Circle().fill(.orange).frame(width: 7, height: 7)
        default:         EmptyView()
        }
    }

    /// Relative last-activity time ("just now", "3m ago", "2d ago", "7/8") — the parity with web's
    /// `session-time` that the native list was missing. Reuses OrbitKit's `RelativeTime` (also used
    /// by the session-header subtitle).
    private var relTime: String? {
        guard let ts = session.lastTurnAt ?? session.createdAt else { return nil }
        return RelativeTime.format(ts)
    }
    #endif

    private func lineColor(_ tone: SessionLine.Tone) -> Color {
        switch tone {
        case .preview, .queued: return .secondary
        case .running:          return .blue
        case .approval:         return .orange
        }
    }
}

/// Renders a `SessionStatusGlyph` at the leading edge of a session row — the shared port of web's
/// `StatusIcon`. A working session shows an animated spinner (web's `LoadingOutlined spin`);
/// everything else is an SF Symbol, tinted by the glyph's semantic tone. Fixed frame so titles
/// line up whether the glyph is a spinner or a symbol.
struct StatusGlyphView: View {
    let glyph: SessionStatusGlyph
    // Box scales with the glyph's own token so a Dynamic-Type-grown symbol isn't clipped.
    @ScaledMetric(relativeTo: .subheadline) private var box: CGFloat = 20
    var body: some View {
        Group {
            switch glyph.shape {
            case .spinner:
                SpinnerGlyph(color: color)
            case .symbol(let name):
                Image(systemName: name).font(.orbitGlyph).foregroundStyle(color)
            }
        }
        .frame(width: box, height: box)
        .help(glyph.label)
        .accessibilityLabel(glyph.label)
    }
    private var color: Color {
        switch glyph.tone {
        case .brand:   return .blue
        case .success: return .green
        case .warning: return .orange
        case .error:   return .red
        case .neutral: return .secondary
        }
    }
}

/// A self-drawn indeterminate spinner (a rotating ¾ arc) for the "working" glyph. SwiftUI's
/// `ProgressView` bridges to a UIKit activity indicator that renders *blank* after a `List` row is
/// detached and reattached — open a session and navigate back and the spinner vanishes (while the
/// static SF Symbols survive). The angle is derived from `TimelineView(.animation)` rather than a
/// `repeatForever` implicit animation: this re-animates reliably on reappear *and* holds a constant
/// speed. A `repeatForever` animation gets re-applied every time the host row re-renders, and while
/// an agent streams output the running row re-renders many times a second — those repeats stack on
/// the `rotationEffect` and the arc visibly accelerates. A time-derived angle is a pure function of
/// wall-clock time, so no amount of re-rendering can change how fast it spins.
private struct SpinnerGlyph: View {
    let color: Color
    private let period: Double = 0.85   // seconds per rotation; the steady "normal" cadence
    var body: some View {
        TimelineView(.animation) { context in
            let angle = context.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: period) / period * 360
            Circle()
                .trim(from: 0, to: 0.7)
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .frame(width: 13, height: 13)
                .rotationEffect(.degrees(angle))
        }
    }
}

/// The edit form. Fields mirror the web RunnerDetailPage agent form: name, model, permission
/// mode, Instructions (appendSystemPrompt), working directory, enabled. Empty Instructions /
/// workDir omit the key (no change) — matching the web, which sends `undefined` when blank.
struct AgentFormContent: View {
    let agents: AgentsModel
    let agent: Agent
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var provider = "claude"
    @State private var model = ""
    @State private var mode: PermissionMode = .dontAsk
    @State private var effort: Effort = .default
    @State private var instructions = ""
    @State private var workDir = ""
    @State private var enabled = true
    @State private var confirmingDelete = false

    private var modelCatalog: RunnerModelCatalog? { agents.modelCatalog(for: agent.runnerId) }
    private var modelOptions: [ModelOption] {
        AgentDefaults.models(for: provider, catalog: modelCatalog)
    }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name, prompt: Text("e.g. tea-cli builder"))

                // The reset lives in the Binding's setter, not `.onChange`: `.onChange` also fires
                // when `prefill()` seeds `provider` programmatically, which would clobber the
                // agent's saved model on open (web's onProviderChange is user-interaction only).
                Picker("Runtime", selection: Binding(
                    get: { provider },
                    set: { new in
                        // A model or effort from the old runtime is meaningless (and rejected)
                        // under the new one — reset to that provider's default rather than PATCH
                        // a bad value.
                        provider = new
                        model = AgentDefaults.defaultModel(for: new, catalog: modelCatalog)
                        if !AgentDefaults.efforts(for: new).contains(effort) { effort = .default }
                    }
                )) {
                    ForEach(AgentDefaults.providers) { Text($0.name).tag($0.id) }
                }

                Picker("Model", selection: $model) {
                    // Surface a non-standard saved model (e.g. an env-overridden endpoint) so the
                    // picker still shows the current value rather than going blank.
                    if !modelOptions.contains(where: { $0.id == model }) {
                        Text(model.isEmpty ? "—" : model).tag(model)
                    }
                    ForEach(modelOptions) { Text($0.name).tag($0.id) }
                }

                Picker("Permission mode", selection: $mode) {
                    ForEach(AgentDefaults.permissionModes, id: \.self) {
                        Text(AgentDefaults.label($0)).tag($0)
                    }
                }

                // A new session with this agent seeds its reasoning effort from here (like model /
                // permission mode); "Default" (the empty value) leaves it to the model's default.
                Picker("Effort", selection: $effort) {
                    ForEach(AgentDefaults.efforts(for: provider)) { Text($0.label).tag($0) }
                }

                Toggle("Enabled", isOn: $enabled)
            }

            Section("Instructions") {
                TextEditor(text: $instructions)
                    .frame(minHeight: 90)
                    .font(.body)
                Text("Added to this agent's system prompt on every run (optional).")
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }

            Section("Working directory") {
                TextField("Path", text: $workDir,
                          prompt: Text("/path/to/project on the runner (optional)"))
            }

            if let env = agent.env, !env.isEmpty {
                Section("Environment") {
                    ForEach(env.sorted(by: { $0.key < $1.key }), id: \.key) { k, v in
                        LabeledContent(k, value: v)
                    }
                    Text("Env editing is coming in a follow-up.")
                        .font(.orbitLabel).foregroundStyle(.secondary)
                }
            }

            Section {
                Button("Delete agent", role: .destructive) { confirmingDelete = true }
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: prefill)
        // Cancel/Done pair (the iOS editing-sheet idiom, e.g. Contacts): "Done" commits the working
        // copy and closes, "Cancel" discards and closes — a discoverable exit that also works on
        // macOS, where the sheet has no swipe-to-dismiss (Cancel binds to Esc, Done to Return). Done
        // only PATCHes when something actually changed and the name is still non-empty, so opening
        // settings to look and closing writes nothing.
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { commitAndDismiss() }
            }
        }
        // Delete is destructive and drops the agent from the list, so gate it behind an explicit
        // confirmation. The server soft-deletes (its sessions are kept and stay linked); close the
        // sheet afterward since the agent is gone from here.
        .confirmationDialog("Delete \(agent.name)?", isPresented: $confirmingDelete,
                            titleVisibility: .visible) {
            Button("Delete agent", role: .destructive) {
                dismiss()
                Task { await agents.delete(agent.id) }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This removes the agent from your Agents list. Its sessions are kept.")
        }
    }

    private func prefill() {
        name = agent.name
        provider = agent.provider ?? "claude"
        model = agent.model ?? AgentDefaults.defaultModel(for: provider, catalog: modelCatalog)
        mode = PermissionMode(rawValue: agent.permissionMode ?? "dontAsk") ?? .dontAsk
        effort = Effort(rawValue: agent.effort ?? "") ?? .default
        instructions = agent.appendSystemPrompt ?? ""
        workDir = agent.workDir ?? ""
        enabled = agent.enabled ?? true
    }

    /// True when the working copy diverges from the agent as prefilled — mirrors `prefill()` field
    /// for field so a look-and-close never fires a needless PATCH.
    private var isDirty: Bool {
        name != agent.name
        || provider != (agent.provider ?? "claude")
        || model != (agent.model ?? AgentDefaults.defaultModel(for: agent.provider ?? "claude", catalog: modelCatalog))
        || mode != (PermissionMode(rawValue: agent.permissionMode ?? "dontAsk") ?? .dontAsk)
        || effort != (Effort(rawValue: agent.effort ?? "") ?? .default)
        || instructions != (agent.appendSystemPrompt ?? "")
        || workDir != (agent.workDir ?? "")
        || enabled != (agent.enabled ?? true)
    }

    /// Save (only if changed and still valid) then close. An emptied name is invalid — the form was
    /// seeded from a real name — so we discard rather than persist it.
    private func commitAndDismiss() {
        if isDirty && !name.trimmingCharacters(in: .whitespaces).isEmpty {
            save()
        }
        dismiss()
    }

    private func save() {
        let req = UpdateAgentRequest(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            provider: provider,
            model: model,
            appendSystemPrompt: instructions.isEmpty ? nil : instructions,
            permissionMode: mode.rawValue,
            // Always send the raw value ("" for Default) so picking Default actually clears a
            // previously-set effort — omitting (nil) would leave the old value unchanged.
            effort: effort.rawValue,
            workDir: workDir.isEmpty ? nil : workDir,
            enabled: enabled
        )
        Task { await agents.save(agent.id, req) }
    }
}
