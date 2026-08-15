import SwiftUI
import OrbitKit

// Batch E (2/2): Settings (preferences + change password, on the current user) and the Admin
// user-management area (role-gated). SwiftUI is parse-checked only — verify on a Mac.

// MARK: - Settings

/// Single-pane settings: account info, theme/default permission preferences,
/// and change-password. Lives in the middle column; the detail stays a neutral hint.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    #if os(macOS)
    @EnvironmentObject private var updater: UpdaterModel   // Sparkle; iOS updates via the App Store
    #else
    // iPhone (compact) reaches Settings from the drawer's action bar, which replaced the account
    // footer — so the account actions that footer's menu carried live here. iPad keeps that footer
    // and lists Admin in its sidebar, so both stay out of its Settings.
    @Environment(\.horizontalSizeClass) private var hSize
    #endif

    @State private var theme = "system"
    @State private var permMode: PermissionMode = .default
    @State private var grantOrchestrationToNew = false
    @State private var loaded = false

    @State private var confirmGrantAll = false
    @State private var applyingOrchestration = false
    @State private var orchestrationMessage: String?

    @State private var curPw = ""
    @State private var newPw = ""
    @State private var pwMessage: String?

    var body: some View {
        @Bindable var model = model
        return Form {
            #if os(iOS)
            // Runners moved off the drawer rail into Settings; push the list within this stack. The
            // push is tracked on the model (`settingsShowingRunners`) so the shell knows Settings is
            // no longer at root — see `sectionAtRoot`.
            Section {
                Button {
                    model.settingsShowingRunners = true
                } label: {
                    HStack {
                        Label("Runners", systemImage: AppSection.runners.systemImage)
                            .foregroundStyle(.primary)
                        Spacer()
                        Image(systemName: "chevron.forward")
                            .font(.orbitMeta)
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                // Admin is off the compact drawer rail, and the account footer that used to link it
                // is gone — so this is its entry point on iPhone. It switches section (rather than
                // pushing) exactly as that menu item did.
                if hSize == .compact, model.user?.role == "ADMIN" {
                    Button {
                        model.selectedSection = .admin
                    } label: {
                        HStack {
                            Label(AppSection.admin.title, systemImage: AppSection.admin.systemImage)
                                .foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "chevron.forward")
                                .font(.orbitMeta)
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            #endif

            Section("Account") {
                if let u = model.user {
                    LabeledContent("Email", value: u.email)
                    if let name = u.name, !name.isEmpty { LabeledContent("Name", value: name) }
                    if let role = u.role { LabeledContent("Role", value: role) }
                }
                #if os(iOS)
                if hSize == .compact {
                    Button("Sign out", role: .destructive) { model.logout() }
                }
                #endif
            }

            Section("Preferences") {
                Picker("Theme", selection: $theme) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
                Picker("Default permission", selection: $permMode) {
                    ForEach(AgentDefaults.permissionModes, id: \.self) { Text(AgentDefaults.label($0)).tag($0) }
                }
                #if os(macOS)
                // iOS auto-saves on change (see `.onChange` below); macOS keeps an explicit commit.
                Button("Save preferences") {
                    Task { await model.savePreferences(preferencesPatch) }
                }
                #endif
            }

            // Orchestration is granted per agent — the server reads that agent's own switch on
            // every claim and every spawn, so it stays revocable one agent at a time. What lives
            // here is the paperwork: a default for the agents made next, and a way to set the ones
            // that exist all at once instead of opening every agent's editor in turn.
            Section("Session orchestration") {
                Toggle("Grant it to new agents", isOn: $grantOrchestrationToNew)
                Text("An agent you create from now on starts able to spawn and manage other "
                     + "sessions via the orbit MCP session tools. Existing agents are untouched.")
                    .font(.orbitLabel).foregroundStyle(.secondary)

                Text(orchestrationStatus)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                Button("Turn on for all") { confirmGrantAll = true }
                    .disabled(agentCount == 0 || applyingOrchestration)
                // No confirmation on the way out: this is the account's kill switch, and one you
                // have to argue with is one you can't reach in a hurry.
                Button("Turn off for all", role: .destructive) {
                    Task { await applyOrchestrationToAll(false) }
                }
                .disabled(orchestratingCount == 0 || applyingOrchestration)
                if let m = orchestrationMessage {
                    Text(m).font(.orbitLabel).foregroundStyle(.secondary)
                }
            }

            Section("Change password") {
                SecureField("Current password", text: $curPw)
                SecureField("New password (min 6)", text: $newPw)
                Button("Change password") {
                    Task {
                        let err = await model.changePassword(current: curPw, new: newPw)
                        pwMessage = err ?? "Password changed."
                        if err == nil { curPw = ""; newPw = "" }
                    }
                }
                .disabled(curPw.isEmpty || newPw.count < 6)
                if let m = pwMessage {
                    Text(m).font(.orbitLabel).foregroundStyle(.secondary)
                }
            }

            #if os(macOS)
            Section("Updates") {
                Toggle("Receive beta updates", isOn: $updater.betaChannel)
                Text("Beta releases ship earlier and may be less stable.")
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }
            #endif
        }
        #if os(iOS)
        .navigationDestination(isPresented: $model.settingsShowingRunners) {
            RunnersSettingsList()
        }
        #endif
        .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface` behind the grouped form
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .confirmationDialog("Let all \(agentCount) agents orchestrate?",
                            isPresented: $confirmGrantAll, titleVisibility: .visible) {
            Button("Turn on for all") { Task { await applyOrchestrationToAll(true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Every agent's sessions will be able to spawn and drive other sessions. "
                 + "Grant this only if you trust what each of them runs.")
        }
        .task {
            // The count has to be true. Settings can be reached without the agent list ever having
            // loaded, and "0 of 0" would read as an answer rather than as "not asked yet".
            if let agents = model.agents, agents.items.isEmpty { await agents.load() }
        }
        // Persisted the moment it flips, on macOS too: the Save button lives in another section,
        // and a capability switch that looks set but was never written is the one kind of lie
        // this screen cannot afford.
        .onChange(of: grantOrchestrationToNew) { saveOrchestrationDefault() }
        #if os(iOS)
        .onChange(of: theme) { autosavePreferences() }
        .onChange(of: permMode) { autosavePreferences() }
        #endif
        .onAppear {
            guard !loaded else { return }
            loaded = true
            let p = model.user?.preferences
            theme = p?.theme ?? "system"
            // An unset preference is the server's floor (Auto), not Default — showing Default here
            // would name a mode the account isn't actually running.
            permMode = PermissionMode(rawValue: p?.defaultPermissionMode ?? "")
                ?? AgentDefaults.defaultPermissionMode
            grantOrchestrationToNew = p?.defaultEnableOrchestration ?? false
        }
    }

    /// Every preference this form owns, as one partial patch — the server shallow-merges, so the
    /// keys not named here keep their value.
    private var preferencesPatch: UpdatePreferencesRequest {
        UpdatePreferencesRequest(theme: theme, defaultPermissionMode: permMode.rawValue,
                                 defaultEnableOrchestration: grantOrchestrationToNew)
    }

    /// Write just this one key — the server shallow-merges, so a half-edited theme picker sitting
    /// above (macOS, where the pickers still wait for Save) is not committed as a side effect.
    /// Guarded against the `onAppear` seed, so opening Settings never writes.
    private func saveOrchestrationDefault() {
        guard (model.user?.preferences?.defaultEnableOrchestration ?? false)
                != grantOrchestrationToNew else { return }
        Task {
            await model.savePreferences(
                UpdatePreferencesRequest(defaultEnableOrchestration: grantOrchestrationToNew))
        }
    }

    private var agentCount: Int { model.agents?.items.count ?? 0 }
    private var orchestratingCount: Int {
        model.agents?.items.filter { $0.enableOrchestration == true }.count ?? 0
    }

    private var orchestrationStatus: String {
        guard let agents = model.agents, !agents.items.isEmpty else {
            return model.agents?.loading == true ? "Loading your agents…" : "No agents yet."
        }
        return "\(orchestratingCount) of \(agents.items.count) can orchestrate now. "
            + "Each keeps its own switch afterwards."
    }

    /// Writes every agent's own switch in one call, then reports what it actually wrote. Not a
    /// master switch: each agent keeps its grant afterwards, so one can be revoked on its own.
    @MainActor
    private func applyOrchestrationToAll(_ enabled: Bool) async {
        guard let agents = model.agents else { return }
        applyingOrchestration = true
        defer { applyingOrchestration = false }
        guard let updated = await agents.setOrchestrationForAll(enabled) else {
            orchestrationMessage = "Couldn't apply that to your agents."
            return
        }
        orchestrationMessage = "\(enabled ? "Enabled" : "Disabled") on \(updated) "
            + "agent\(updated == 1 ? "" : "s")."
    }

    #if os(iOS)
    /// iOS persists each preference the moment its picker changes — matching the platform's
    /// "settings apply immediately" convention, so there's no explicit Save button. Fire-and-forget
    /// like `AppModel.rememberDefaultEffort`. Guarded against the `onAppear` seed (which sets the
    /// pickers to the current values), so simply opening Settings never triggers a spurious write.
    private func autosavePreferences() {
        let p = model.user?.preferences
        guard (p?.theme ?? "system") != theme
            || (p?.defaultPermissionMode ?? AgentDefaults.defaultPermissionMode.rawValue)
                != permMode.rawValue
        else { return }
        Task { await model.savePreferences(preferencesPatch) }
    }
    #endif
}

// MARK: - Admin

struct AdminUsersView: View {
    @Environment(AppModel.self) private var model
    @State private var showNew = false

    var body: some View {
        @Bindable var model = model
        if let admin = model.admin {
            List(selection: $model.selectedUserID) {
                ForEach(admin.users) { u in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(u.name?.isEmpty == false ? u.name! : u.email).lineLimit(1)
                        Text("\(u.email) · \(u.role ?? "MEMBER")")
                            .font(.orbitListSubtitle).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .tag(u.id)
                }
            }
            .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface`
            .overlay {
                if admin.users.isEmpty {
                    ContentUnavailableView(admin.loading ? "Loading…" : "No users", systemImage: "person.3")
                }
            }
            .navigationTitle("Admin")
            .toolbar {
                ToolbarItem {
                    Button { showNew = true } label: { Label("New user", systemImage: "person.badge.plus") }
                }
            }
            .task { await admin.load() }
            .sheet(isPresented: $showNew) { NewUserSheet(admin: admin) }
        } else {
            ProgressView()
        }
    }
}

struct AdminUserDetailView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        if let admin = model.admin, let id = model.selectedUserID, let u = admin.user(id) {
            Form {
                Section {
                    LabeledContent("Email", value: u.email)
                    if let n = u.name, !n.isEmpty { LabeledContent("Name", value: n) }
                    if let created = u.createdAt { LabeledContent("Created", value: created) }
                }
                Section("Role") {
                    Picker("Role", selection: Binding(
                        get: { u.role ?? "MEMBER" },
                        set: { r in Task { await admin.setRole(u.id, r) } }
                    )) {
                        Text("Member").tag("MEMBER")
                        Text("Admin").tag("ADMIN")
                    }
                    .pickerStyle(.segmented)
                }
                Section {
                    Button("Delete user", role: .destructive) { Task { await admin.delete(u.id) } }
                }
                if let pw = admin.revealedPassword {
                    Section("Generated password — copy now, shown once") {
                        Text(pw).font(.callout).fontDesign(.monospaced).textSelection(.enabled)
                        Button("Dismiss") { admin.revealedPassword = nil }
                    }
                }
            }
            .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface` behind the grouped form
            .formStyle(.grouped)
            .navigationTitle(u.name?.isEmpty == false ? u.name! : u.email)
        } else {
            ContentUnavailableView("Select a user", systemImage: "person",
                                   description: Text("Role and account actions appear here."))
        }
    }
}

struct NewUserSheet: View {
    let admin: AdminModel
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var name = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New user").font(.headline)
            TextField("Email", text: $email)
            TextField("Name (optional)", text: $name)
            Text("A strong password is generated and shown once after creating.")
                .font(.orbitLabel).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Create") {
                    Task { await admin.createUser(email: email, name: name.isEmpty ? nil : name) }
                    dismiss()
                }
                .keyboardShortcut(.return)
                .disabled(email.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 380)
    }
}
