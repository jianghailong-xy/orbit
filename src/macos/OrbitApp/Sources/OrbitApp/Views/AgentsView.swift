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
                        Text("disabled").font(.caption2)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                    }
                }
                Text(AgentDefaults.friendlyName(AgentListLogic.effectiveModel(model: agent.model, env: agent.env))
                     + (agent.workDir.map { " · \($0)" } ?? ""))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            if let shortcutIndex {
                Spacer(minLength: 4)
                Text("⌘\(shortcutIndex + 1)")
                    .font(.caption2).monospacedDigit()
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
            ForEach(agents.agentSessions) { s in
                AgentSessionRow(session: s, completed: view == .completed, showsPin: view == .active).tag(s.id)
            }
        }
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
            // New session — leading, mirroring Mail's compose: enters the draft compose state shown
            // in the detail pane (NewSessionView). Clearing the selection makes room for it.
            ToolbarItem(placement: .navigation) {
                Button {
                    app.composingAgentSession = true
                    selectedSessionID = nil
                } label: {
                    Label("New session", systemImage: "square.and.pencil")
                }
                .help("Start a new session with \(agent.name)")
            }
            #if os(iOS)
            // Compact nav bar can't fit a 3-way segmented control beside the back button, compose,
            // and a gear. Collapse both the scope switcher *and* the agent-settings gear into a
            // single trailing menu: the label shows the current scope (so it still reads at a
            // glance) and "Agent settings" folds in as a menu action instead of a separate button.
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    // Scope options as checkmarked buttons (the repo's menu idiom — see
                    // ComposerView — rather than a nested Picker), so the current scope reads clearly.
                    ForEach(SessionView.allCases) { v in
                        Button { view = v } label: {
                            if v == view { Label(v.title, systemImage: "checkmark") }
                            else { Text(v.title) }
                        }
                    }
                    Divider()
                    Button { showSettings = true } label: {
                        Label("Agent settings", systemImage: "gearshape")
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(view.title)
                        Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                    }
                }
                .accessibilityLabel("Session scope, \(view.title)")
            }
            #else
            // macOS: the wide window toolbar keeps the platform-idiomatic layout — a compact,
            // content-hugging segmented control centered (principal) and a separate settings gear.
            ToolbarItem(placement: .principal) {
                Picker("View", selection: $view) {
                    ForEach(SessionView.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
            }
            ToolbarItem(placement: .primaryAction) {
                Button { showSettings = true } label: {
                    Label("Agent settings", systemImage: "gearshape")
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
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            AgentFormContent(agents: agents, agent: agent)
                .navigationTitle("\(agent.name) settings")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .frame(minWidth: 480, minHeight: 520)
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
            NewSessionView(agent: agent, registry: registry) { session in
                app.composingAgentSession = false
                app.selectedAgentSessionID = session.id
            }
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
    @State private var draft: ConsoleModel

    init(agent: Agent, registry: ConsoleRegistry, onCreated: @escaping (Session) -> Void) {
        self.agent = agent
        _draft = State(initialValue: registry.draftModel(for: agent, onCreated: onCreated))
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                Image(systemName: "square.and.pencil").font(.largeTitle).foregroundStyle(.secondary)
                Text("New session").font(.title3.weight(.semibold))
                Text("Send \(agent.name) a task to start a new session.")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()
            // createSession failures surface on the draft's statusMessage (mirrors ConsoleView).
            if let msg = draft.statusMessage {
                HStack {
                    Text(msg).font(.caption).foregroundStyle(.secondary).lineLimit(2)
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
    }
}

struct AgentSessionRow: View {
    let session: Session
    /// True when the Completed (archived) tab is showing this row — mirrors web's
    /// `completed={view === 'archived'}`, so a filed session reads as done, not "Cancelled".
    var completed: Bool = false
    /// True in the Active view, where pinning applies — mirrors web's `view === 'active'` gate on the
    /// pinned marker. Completed/System rows never show the bar (they can't be pinned).
    var showsPin: Bool = false
    private var isPinned: Bool { showsPin && session.pinnedAt != nil }
    // Second line: the last-reply / live-state preview (mirrors the web Agent console). Rows here
    // are always openable (macOS has no Trash tab), so `live: true` — matching web's `openable`.
    private var line: SessionLine? { SessionLine.make(for: session, live: true) }

    var body: some View {
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
                StatusGlyphView(glyph: .make(for: session, completed: completed))
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title ?? "Untitled session").lineLimit(1)
                    if let line {
                        Text(line.text).font(.caption).foregroundStyle(lineColor(line.tone)).lineLimit(1)
                    }
                }
                Spacer()
                if let n = session.pendingApprovals, n > 0 {
                    Text("\(n)").font(.caption2.bold())
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
    }
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
    var body: some View {
        Group {
            switch glyph.shape {
            case .spinner:
                SpinnerGlyph(color: color)
            case .symbol(let name):
                Image(systemName: name).font(.system(size: 15)).foregroundStyle(color)
            }
        }
        .frame(width: 20, height: 20)
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
/// static SF Symbols survive). A pure-SwiftUI arc re-animates reliably on reappear and also matches
/// web's spinning-arc loader. `spinning` is reset on disappear so reappearance re-triggers the spin.
private struct SpinnerGlyph: View {
    let color: Color
    @State private var spinning = false
    var body: some View {
        Circle()
            .trim(from: 0, to: 0.7)
            .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .frame(width: 13, height: 13)
            .rotationEffect(.degrees(spinning ? 360 : 0))
            .animation(.linear(duration: 0.85).repeatForever(autoreverses: false), value: spinning)
            .onAppear { spinning = true }
            .onDisappear { spinning = false }
    }
}

/// The edit form. Fields mirror the web RunnerDetailPage agent form: name, model, permission
/// mode, Instructions (appendSystemPrompt), working directory, enabled. Empty Instructions /
/// workDir omit the key (no change) — matching the web, which sends `undefined` when blank.
struct AgentFormContent: View {
    let agents: AgentsModel
    let agent: Agent

    @State private var name = ""
    @State private var model = ""
    @State private var mode: PermissionMode = .dontAsk
    @State private var instructions = ""
    @State private var workDir = ""
    @State private var enabled = true

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name, prompt: Text("e.g. tea-cli builder"))

                Picker("Model", selection: $model) {
                    // Surface a non-standard saved model (e.g. an env-overridden endpoint) so the
                    // picker still shows the current value rather than going blank.
                    if !AgentDefaults.models.contains(where: { $0.id == model }) {
                        Text(model.isEmpty ? "—" : model).tag(model)
                    }
                    ForEach(AgentDefaults.models) { Text($0.name).tag($0.id) }
                }

                Picker("Permission mode", selection: $mode) {
                    ForEach(AgentDefaults.permissionModes, id: \.self) {
                        Text(AgentDefaults.label($0)).tag($0)
                    }
                }

                Toggle("Enabled", isOn: $enabled)
            }

            Section("Instructions") {
                TextEditor(text: $instructions)
                    .frame(minHeight: 90)
                    .font(.body)
                Text("Added to this agent's system prompt on every run (optional).")
                    .font(.caption).foregroundStyle(.secondary)
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
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            Section {
                HStack {
                    Button("Save changes") { save() }
                        .keyboardShortcut(.return, modifiers: [])
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                    Spacer()
                    Button("Delete", role: .destructive) {
                        Task { await agents.delete(agent.id) }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: prefill)
    }

    private func prefill() {
        name = agent.name
        model = agent.model ?? AgentDefaults.defaultModelID
        mode = PermissionMode(rawValue: agent.permissionMode ?? "dontAsk") ?? .dontAsk
        instructions = agent.appendSystemPrompt ?? ""
        workDir = agent.workDir ?? ""
        enabled = agent.enabled ?? true
    }

    private func save() {
        let req = UpdateAgentRequest(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            model: model,
            appendSystemPrompt: instructions.isEmpty ? nil : instructions,
            permissionMode: mode.rawValue,
            workDir: workDir.isEmpty ? nil : workDir,
            enabled: enabled
        )
        Task { await agents.save(agent.id, req) }
    }
}
