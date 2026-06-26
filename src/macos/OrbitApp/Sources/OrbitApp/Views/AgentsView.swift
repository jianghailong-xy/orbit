import SwiftUI
import OrbitKit

// Batch D + Agents-in-sidebar refinement: the agent *list* (grouped by runner) now lives in the
// sidebar source list (see `SectionSidebar`), folding away the old middle column. What remains
// here is the selected agent's detail, split across the two right panes to mirror Active:
//   • content column → the agent's sessions (Active/Completed/System); a toolbar gear opens the
//                       agent's Settings form in a sheet
//   • detail column  → the live console for the session picked in the content column
// Grouping + effective-model logic come from the verified OrbitKit `AgentListLogic`; pickers reuse
// `AgentDefaults`. SwiftUI here is parse-checked only — verify on a Mac.
//
// IA note: the web edits agents *inside* the Runner detail page (an agent belongs to a runner);
// this surfaces a flatter Agents nav whose items are the agents themselves.

/// A row for an agent in the sidebar disclosure: name (+ disabled pill) over model · workDir.
struct AgentRowView: View {
    let agent: Agent
    var body: some View {
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

    var body: some View {
        VStack(spacing: 0) {
            // "New session" header (mirrors web's session-new row): enters the draft compose state
            // shown in the detail pane. Selecting an existing session clears it (onChange below).
            Button {
                app.composingAgentSession = true
                selectedSessionID = nil
            } label: {
                Label("New session", systemImage: "square.and.pencil")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(app.composingAgentSession ? Color.accentColor.opacity(0.15) : .clear)
            .contentShape(Rectangle())
            Divider()
            Picker("", selection: $view) {
                ForEach(SessionView.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden().padding(8)
            List(selection: $selectedSessionID) {
                ForEach(agents.agentSessions) { s in
                    AgentSessionRow(session: s).tag(s.id)
                }
            }
            .overlay {
                if agents.agentSessions.isEmpty {
                    ContentUnavailableView(
                        agents.sessionsLoading ? "Loading…" : "No \(view.title.lowercased()) sessions",
                        systemImage: "bubble.left.and.bubble.right")
                }
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
        // The edit form moved off a Sessions/Settings segmented switch into this toolbar gear → sheet,
        // leaving the content column to show only the session list.
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showSettings = true } label: {
                    Label("Agent settings", systemImage: "gearshape")
                }
                .help("Edit this agent")
            }
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
        if app.composingAgentSession, let agents = app.agents,
           let id = app.selectedAgentID, let agent = agents.agent(id) {
            // Draft compose state: send creates a new session, then opens its console.
            NewSessionView(agent: agent, agents: agents) { newID in
                app.composingAgentSession = false
                app.selectedAgentSessionID = newID
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
/// web "new session" state: an empty-transcript hint over a composer whose send calls
/// `createSession` (not `sendTurn`). On success it hands the new session id back so the console
/// takes over. The model/permission pills are seeded from the agent's own config — matching web,
/// where leaving them at "Default" would make the server treat that as an explicit override and
/// ignore the agent's configured mode. Slash autocomplete + attachments are follow-ups.
struct NewSessionView: View {
    let agent: Agent
    let agents: AgentsModel
    let onCreated: (String) -> Void

    @State private var text = ""
    @State private var shellMode = false
    @State private var modelID = AgentDefaults.defaultModelID
    @State private var mode: PermissionMode = .dontAsk
    @State private var effort: Effort = .default
    @State private var sending = false
    @State private var failed: String?
    @FocusState private var focused: Bool

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending
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
            composer
        }
        .onAppear { prefill(); focused = true }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if let failed {
                Label(failed, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Toggle(isOn: $shellMode) { Image(systemName: "terminal") }
                    .toggleStyle(.button)
                    .help("Run as a shell command")

                TextField(shellMode ? "Shell command…" : "Message…", text: $text, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...6)
                    .focused($focused)
                    .onSubmit { start() }
                    // Clamp length like the live composer: an oversized prompt stalls SwiftUI's
                    // synchronous text layout.
                    .onChange(of: text) { _, t in
                        if failed != nil { failed = nil }   // editing dismisses a prior error
                        if t.count > ComposerLogic.maxPromptChars {
                            text = String(t.prefix(ComposerLogic.maxPromptChars))
                        }
                    }

                Button { start() } label: {
                    if sending {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.up.circle.fill").font(.title2)
                    }
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
            }

            HStack(spacing: 8) {
                Picker("", selection: $mode) {
                    ForEach(AgentDefaults.permissionModes, id: \.self) { Text(AgentDefaults.label($0)).tag($0) }
                }
                .labelsHidden().fixedSize()

                Spacer()

                Text(agent.name).foregroundStyle(.secondary).lineLimit(1)

                Picker("", selection: $modelID) {
                    ForEach(AgentDefaults.models) { Text($0.name).tag($0.id) }
                }
                .labelsHidden().fixedSize()

                Picker("", selection: $effort) {
                    ForEach(Effort.allCases) { Text($0.label).tag($0) }
                }
                .labelsHidden().fixedSize()
            }
            .font(.caption)
        }
        .padding(10)
        .background(.bar)
    }

    /// Seed the pills from the agent's configured defaults (web parity). A non-standard saved model
    /// (e.g. an env-overridden endpoint not in the picker) would blank the Picker, so fall back to
    /// the default in that case.
    private func prefill() {
        let m = agent.model ?? AgentDefaults.defaultModelID
        modelID = AgentDefaults.models.contains { $0.id == m } ? m : AgentDefaults.defaultModelID
        mode = PermissionMode(rawValue: agent.permissionMode ?? "dontAsk") ?? .dontAsk
    }

    private func start() {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !sending else { return }
        sending = true
        failed = nil
        // `@MainActor in` so the post-await @State / app mutations stay on the main thread
        // (a bare Task wouldn't inherit it in Swift 5 mode) — mirrors ComposerView.
        Task { @MainActor in
            let req = CreateSessionRequest(
                prompt: prompt, agentId: agent.id, model: modelID,
                permissionMode: mode.rawValue, effort: effort.wire,
                shell: shellMode ? true : nil)
            let created = await agents.createSession(req)
            sending = false
            if let created { onCreated(created.id) }
            else { failed = agents.errorText ?? "Couldn't start the session." }
        }
    }
}

struct AgentSessionRow: View {
    let session: Session
    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title ?? "Untitled session").lineLimit(1)
                Text(session.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let n = session.pendingApprovals, n > 0 {
                Text("\(n)").font(.caption2.bold())
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(.orange, in: Capsule()).foregroundStyle(.white)
            }
        }
        .padding(.vertical, 2)
    }
    private var color: Color {
        switch session.status {
        case .running:       return .blue
        case .awaitingInput: return .orange
        case .succeeded:     return .green
        case .failed:        return .red
        default:             return .secondary
        }
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
