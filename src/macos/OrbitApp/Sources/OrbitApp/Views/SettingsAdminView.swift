import SwiftUI
import OrbitKit

// Batch E (2/2): Settings (preferences + change password, on the current user) and the Admin
// user-management area (role-gated). SwiftUI is parse-checked only — verify on a Mac.

// MARK: - Settings

/// Single-pane settings: account info, the three preference defaults (theme / model / permission),
/// and change-password. Lives in the middle column; the detail stays a neutral hint.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    #if os(macOS)
    @EnvironmentObject private var updater: UpdaterModel   // Sparkle; iOS updates via the App Store
    #endif

    @State private var theme = "system"
    @State private var defaultModel = AgentDefaults.defaultModelID
    @State private var permMode: PermissionMode = .default
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
                Picker("Default model", selection: $defaultModel) {
                    ForEach(AgentDefaults.models) { Text($0.name).tag($0.id) }
                }
                Picker("Default permission", selection: $permMode) {
                    ForEach(AgentDefaults.permissionModes, id: \.self) { Text(AgentDefaults.label($0)).tag($0) }
                }
                Button("Save preferences") {
                    Task {
                        await model.savePreferences(UpdatePreferencesRequest(
                            theme: theme, defaultModel: defaultModel, defaultPermissionMode: permMode.rawValue))
                    }
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
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .onAppear {
            guard !loaded else { return }
            loaded = true
            let p = model.user?.preferences
            theme = p?.theme ?? "system"
            defaultModel = p?.defaultModel ?? AgentDefaults.defaultModelID
            permMode = PermissionMode(rawValue: p?.defaultPermissionMode ?? "default") ?? .default
        }
    }
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
