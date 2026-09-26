import SwiftUI
import OrbitKit

// Batch E (2/2): Settings (preferences + change password, on the current user) and the Admin
// user-management area (role-gated). SwiftUI is parse-checked only — verify on a Mac.

// MARK: - Settings

#if os(macOS)
/// macOS Settings: account info, theme/default permission preferences, session orchestration,
/// change-password and the update channel, as one grouped form — in the Settings window (⌘,) and in
/// the main window's middle column. iOS presents Settings as a sheet with a list and pages of its
/// own instead (`SettingsSheet`), in the same words (`SettingsCopy`).
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @EnvironmentObject private var updater: UpdaterModel   // Sparkle; iOS updates via the App Store

    @State private var theme = "system"
    @State private var permMode: PermissionMode = .default
    /// The account's one orchestration switch. Absent on the server means on.
    @State private var orchestration = true
    @State private var loaded = false

    @State private var curPw = ""
    @State private var newPw = ""
    @State private var pwMessage: String?

    var body: some View {
        Form {
            Section("Account") {
                if let u = model.user {
                    LabeledContent("Email", value: u.email)
                    if let name = u.name, !name.isEmpty { LabeledContent("Name", value: name) }
                    if let role = u.role { LabeledContent("Role", value: role) }
                }
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
                Button("Save preferences") {
                    Task { await model.savePreferences(preferencesPatch) }
                }
            }

            // One switch for the whole account, not one per workspace: the server reads it live on
            // every claim, spawn and call, so turning it off takes the tools away everywhere at once.
            Section("Session orchestration") {
                Toggle(SettingsCopy.letSessionsOrchestrate, isOn: $orchestration)
                Text(SettingsCopy.letSessionsOrchestrateHint)
                    .font(.orbitLabel).foregroundStyle(.secondary)
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

            Section("Updates") {
                Toggle("Receive beta updates", isOn: $updater.betaChannel)
                Text("Beta releases ship earlier and may be less stable.")
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
        .orbitRevealSurface()   // reveal the unified `orbitSurface` behind the grouped form
        .formStyle(.grouped)
        .navigationTitle("Settings")
        // Persisted the moment it flips: the Save button lives in another section, and a capability
        // switch that looks set but was never written is the one kind of lie this screen cannot
        // afford.
        .onChange(of: orchestration) { saveOrchestration() }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            let p = model.user?.preferences
            theme = p?.theme ?? "system"
            // An unset preference is the server's floor (Auto), not Default — showing Default here
            // would name a mode the account isn't actually running.
            permMode = PermissionMode(rawValue: p?.defaultPermissionMode ?? "")
                ?? AgentDefaults.defaultPermissionMode
            orchestration = p?.enableOrchestration ?? true
        }
    }

    /// Every preference this form owns, as one partial patch — the server shallow-merges, so the
    /// keys not named here keep their value.
    private var preferencesPatch: UpdatePreferencesRequest {
        UpdatePreferencesRequest(theme: theme, defaultPermissionMode: permMode.rawValue,
                                 enableOrchestration: orchestration)
    }

    /// Write just this one key — the server shallow-merges, so a half-edited theme picker sitting
    /// above (the pickers still wait for Save) is not committed as a side effect. Guarded against
    /// the `onAppear` seed, so opening Settings never writes.
    private func saveOrchestration() {
        guard (model.user?.preferences?.enableOrchestration ?? true) != orchestration else { return }
        Task {
            await model.savePreferences(UpdatePreferencesRequest(enableOrchestration: orchestration))
        }
    }
}
#endif

// MARK: - Admin

struct AdminUsersView: View {
    @Environment(AppModel.self) private var model
    /// How this list's rows navigate. Defaults to the three-column shape; the compact shell, whose
    /// stack knows its own pushes, passes `.push` — which is also what gives the compact section a
    /// user's record to show at all.
    var rowNavigation: SessionRowNavigation = .selection
    @State private var showNew = false

    var body: some View {
        @Bindable var model = model
        if let admin = model.admin {
            // Admin's stack projection — the account on top — and only where there is a detail
            // column to select into.
            List(selection: rowNavigation == .selection ? $model.selectedUserID : nil) {
                ForEach(admin.users) { u in
                    row(u)
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

    /// One row, wrapped for the container it is in — the three-column `List`'s selection, or the
    /// compact row's own destination on Admin's stack.
    @ViewBuilder private func row(_ u: User) -> some View {
        let row = VStack(alignment: .leading, spacing: 2) {
            Text(u.name?.isEmpty == false ? u.name! : u.email).lineLimit(1)
            Text("\(u.email) · \(u.role ?? "MEMBER")")
                .font(.orbitListSubtitle).foregroundStyle(.secondary).lineLimit(1)
        }
        switch rowNavigation {
        case .selection:
            row.tag(u.id)
        case .push:
            // A `Button`, not a `NavigationLink(value:)`: the link's disclosure indicator has no
            // usable hiding place on iOS 17/18 (see `AppModel.push`). `.foregroundStyle(.primary)`:
            // a button's label otherwise inherits the accent tint, and the row is unchanged by
            // design (only the wrapper is new).
            Button { model.push(.userDetail(userID: u.id)) } label: {
                row.foregroundStyle(.primary)
            }
        }
    }
}

struct AdminUserDetailView: View {
    @Environment(AppModel.self) private var model
    /// The account to show. The compact stack hands the page the id its own frame carries; the
    /// three-column detail passes nothing and reads the section's stack instead (the same frame).
    var userID: String? = nil
    var body: some View {
        if let admin = model.admin, let id = userID ?? model.selectedUserID, let u = admin.user(id) {
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
