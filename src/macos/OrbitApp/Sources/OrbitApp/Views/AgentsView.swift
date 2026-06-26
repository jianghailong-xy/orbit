import SwiftUI
import OrbitKit

// Batch D: the Agents page — list grouped by runner (middle column) + an edit form (right
// column), reading the shared `AgentsModel` off `AppModel`. Grouping + effective-model logic
// come from the verified OrbitKit `AgentListLogic`; pickers reuse `AgentDefaults`. SwiftUI here
// is parse-checked only — verify on a Mac.
//
// IA note: the web edits agents *inside* the Runner detail page (an agent belongs to a runner);
// this surfaces a flatter top-level Agents list. The form fields mirror the web's exactly.

/// Middle column: agents grouped by runner; selection drives the edit form.
struct AgentsListView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        if let agents = model.agents {
            List(selection: $model.selectedAgentID) {
                ForEach(agents.groups) { group in
                    Section(agents.runnerLabel(group.runnerId)) {
                        ForEach(group.agents) { a in
                            AgentRowView(agent: a).tag(a.id)
                        }
                    }
                }
            }
            .overlay {
                if agents.items.isEmpty {
                    ContentUnavailableView(agents.loading ? "Loading…" : "No agents",
                                           systemImage: "person.2")
                }
            }
            .navigationTitle("Agents")
            .task { await agents.load() }
        } else {
            ProgressView()
        }
    }
}

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

/// Right column: the selected agent's detail — a Sessions browser (Active/Completed/System,
/// mirroring the web agent console) and the edit form, on a segmented switch.
struct AgentDetailView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        if let agents = model.agents, let id = model.selectedAgentID, let a = agents.agent(id) {
            AgentDetailContent(agents: agents, agent: a).id(a.id)
        } else {
            ContentUnavailableView("Select an agent", systemImage: "person.2",
                                   description: Text("Its sessions and settings appear here."))
        }
    }
}

private enum AgentPane: String, CaseIterable { case sessions = "Sessions", settings = "Settings" }

struct AgentDetailContent: View {
    @Environment(AppModel.self) private var app
    let agents: AgentsModel
    let agent: Agent
    @State private var pane: AgentPane = .sessions
    @State private var view: SessionView = .active

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $pane) {
                ForEach(AgentPane.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden().padding(8)
            Divider()
            switch pane {
            case .sessions: sessionsPane
            case .settings: AgentFormContent(agents: agents, agent: agent)
            }
        }
        .navigationTitle(agent.name)
    }

    private var sessionsPane: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("", selection: $view) {
                    ForEach(SessionView.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden().padding(8)
                List {
                    ForEach(agents.agentSessions) { s in
                        NavigationLink(value: s.id) { AgentSessionRow(session: s) }
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
            .navigationDestination(for: String.self) { sid in
                if let baseURL = app.baseURL {
                    ConsoleView(sessionID: sid, agentID: agent.id, baseURL: baseURL, tokenStore: app.tokenStore)
                }
            }
        }
        .task(id: view) { await agents.loadSessions(agentID: agent.id, view: view) }
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
        .navigationTitle(agent.name)
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
