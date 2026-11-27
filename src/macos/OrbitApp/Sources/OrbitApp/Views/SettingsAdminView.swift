import SwiftUI
import OrbitKit
#if os(macOS)
import UniformTypeIdentifiers
#endif

// Batch E (2/2): Settings (preferences + change password, on the current user) and the Admin
// user-management area (role-gated). SwiftUI is parse-checked only — verify on a Mac.

// MARK: - Settings

#if os(macOS)
/// macOS Settings: account info, theme/default permission preferences, session orchestration,
/// change-password, access tokens and the update channel, as one grouped form — in the Settings
/// window (⌘,) and in the main window's middle column. iOS presents Settings as a sheet with a list
/// and pages of its own instead (`SettingsSheet`), in the same words (`SettingsCopy`).
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @EnvironmentObject private var updater: UpdaterModel   // Sparkle; iOS updates via the App Store
    /// Drawn in the Settings window (⌘,) rather than the main window's middle column: a row that opens
    /// a page of the main window closes this one, so the page is what is left in front.
    var inSettingsWindow = false

    @State private var theme = "system"
    @State private var permMode: PermissionMode = .default
    /// The account's one orchestration switch. Absent on the server means on.
    @State private var orchestration = true
    /// The account's switch for smart model selection. Absent on the server means off.
    @State private var modelRouting = false
    /// The account's "Optimize For" pick. Absent on the server means Balance.
    @State private var optimizeFor: OptimizeFor = .balance
    /// The account's switch for suggested replies. Absent on the server means on.
    @State private var promptSuggestions = true
    /// The account's switch for session recaps. Absent on the server means on.
    @State private var recaps = true
    /// Settings › Translation: the account's switch (absent = off) and Your language.
    @State private var translation = false
    /// Settings › Prompt optimizer: the account's switch. Absent on the server means on.
    @State private var promptOptimizer = true
    @State private var translationLanguage: TranslationLanguage = .default
    @State private var translationAgentLanguage: TranslationLanguage = .agentDefault
    /// "Show both languages" (02-bilingual.png, mark A). Absent = off.
    @State private var bilingual = false
    @State private var loaded = false

    @State private var curPw = ""
    @State private var newPw = ""
    @State private var pwMessage: String?

    /// The account's name as it is being edited; written only by Save.
    @State private var name = ""
    @State private var choosingPhoto = false
    /// What the last photo or name write went wrong with, under the account's rows.
    @State private var accountMessage: String?

    var body: some View {
        form
        // The photo is cut to its middle square and scaled down here, then sent at once — a form
        // takes effect as it is used, as the web Profile page's photo does.
        .fileImporter(isPresented: $choosingPhoto, allowedContentTypes: [.image], onCompletion: photoChosen)
        .task { await model.accessTokens?.load() }
        .task { await model.runners?.load() }
        .onAppear(perform: loadPreferences)
        .onChange(of: name) { accountMessage = nil }
    }

    /// The chosen photo, sent as the account's avatar. Apart from `body`, as `loadPreferences` is:
    /// the release build could not type-check `body` with both closures inline.
    private func photoChosen(_ result: Result<URL, Error>) {
        guard case .success(let url) = result else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let jpeg = NSImage(contentsOf: url)?.orbitAvatarJPEG() else {
            accountMessage = SettingsCopy.photoNotSaved("that file isn't an image this Mac can read")
            return
        }
        Task { accountMessage = await model.saveAvatar(jpeg) }
    }

    /// The form's controls, read once from the account's preferences when Settings first appears.
    private func loadPreferences() {
        guard !loaded else { return }
        loaded = true
        let p = model.user?.preferences
        theme = p?.theme ?? "system"
        // An unset preference is the server's floor (Auto), not Default — showing Default here
        // would name a mode the account isn't actually running.
        permMode = PermissionMode(rawValue: p?.defaultPermissionMode ?? "")
            ?? AgentDefaults.defaultPermissionMode
        orchestration = p?.enableOrchestration ?? true
        modelRouting = p?.smartModelSelection ?? false
        optimizeFor = OptimizeFor(stored: p?.optimizeFor)
        promptSuggestions = p?.suggestedReplies ?? true
        recaps = p?.showRecaps ?? true
        translation = !SessionTranslation.unavailable(model.user) && p?.translationEnabled == true
        promptOptimizer = !PromptOptimizer.unavailable(model.user) && PromptOptimizer.switchedOn(p)
        translationLanguage = SessionTranslation.language(p)
        translationAgentLanguage = SessionTranslation.agentLanguage(p)
        bilingual = p?.translationBilingual == true
        name = model.user?.name ?? ""
    }

    /// The form, with the account switches it writes the moment they flip. Apart from `body`, and each section a
    /// property of its own: the release build could not type-check `body` as one expression (v0.1.261-beta.10,
    /// run 43775274262).
    private var form: some View {
        Form {
            accountSection
            machinesSection
            // Settings → GitHub (docs/github-workspace-design.md §8): the web's Integrations page, as groups of this form.
            GithubSettingsSections()
            preferencesSection
            translationSection
            orchestrationSection
            passwordSection
            AccessTokensSection()
            updatesSection
        }
        .orbitRevealSurface()   // reveal the unified `orbitSurface` behind the grouped form
        .formStyle(.grouped)
        .settingsAnchorScroll()
        .navigationTitle("Settings")
        // Persisted the moment it flips: the Save button lives in another section, and a capability
        // switch that looks set but was never written is the one kind of lie this screen cannot
        // afford.
        .onChange(of: orchestration) { saveOrchestration() }
        .onChange(of: modelRouting) { saveModelRouting() }
        .onChange(of: optimizeFor) { saveOptimizeFor() }
        .onChange(of: promptSuggestions) { savePromptSuggestions() }
        .onChange(of: recaps) { saveRecaps() }
        .onChange(of: translation) { saveTranslation() }
        .onChange(of: promptOptimizer) { savePromptOptimizer() }
        .onChange(of: translationLanguage) { saveTranslationLanguage() }
        .onChange(of: translationAgentLanguage) { saveTranslationAgentLanguage() }
        .onChange(of: bilingual) { saveBilingual() }
        // Another client changed it: follow the account.
        .onChange(of: model.user?.preferences?.translationBilingual) { bilingual = model.user?.preferences?.translationBilingual == true }
    }
    @ViewBuilder
    private var accountSection: some View {
    // The account as the web Profile page has it: the photo, the name (the two things its
    // owner changes here), the email and the role.
    Section("Account") {
        if let u = model.user {
            LabeledContent("Photo") {
                HStack(spacing: 8) {
                    AccountAvatar(name: u.name ?? u.email, diameter: 40)
                    Button(SettingsCopy.choosePhoto + "…") { choosingPhoto = true }
                    if u.avatarUpdatedAt != nil {
                        Button(SettingsCopy.removePhoto) {
                            Task { accountMessage = await model.removeAvatar() }
                        }
                    }
                }
            }
            LabeledContent(SettingsCopy.nameLabel) {
                HStack(spacing: 8) {
                    TextField(SettingsCopy.nameLabel, text: $name, prompt: Text(SettingsCopy.namePlaceholder))
                        .labelsHidden()
                        .frame(maxWidth: 220)
                        .onSubmit(saveName)
                    Button("Save", action: saveName)
                        .disabled(!ProfileEdit.canSave(name, saved: u.name))
                }
            }
            LabeledContent("Email", value: u.email)
            if let role = u.role { LabeledContent("Role", value: role) }
            Text(accountMessage ?? SettingsCopy.nameCaption)
                .font(.orbitLabel)
                .foregroundStyle(accountMessage == nil ? Color.secondary : Color.red)
        }
    }
    }

    @ViewBuilder
    private var machinesSection: some View {
    // Where agents run and whose quota they spend (docs/mocks/machines-and-models, 02): the page left
    // the sidebar for this row, as the phone reaches it from Settings, and the row says what the
    // phone's says — what needs a person there, or how many machines are online.
    Section {
        Button {
            model.selectedSection = .runners
            if inSettingsWindow { NSApp.keyWindow?.close() }
        } label: {
            LabeledContent {
                HStack(spacing: 6) {
                    if let value = machinesValue {
                        Text(value.text).foregroundStyle(value.needsYou ? RunnerInk.amber : Color.secondary)
                    }
                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                }
            } label: {
                Label(AppSection.runners.title, systemImage: AppSection.runners.systemImage)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    } footer: {
        Text(MachinesAndModels.subtitle)
    }
    }

    @ViewBuilder
    private var preferencesSection: some View {
    Section("Preferences") {
        Group {
            Picker("Theme", selection: $theme) {
                Text("System").tag("system")
                Text("Light").tag("light")
                Text("Dark").tag("dark")
            }
            .settingRow("theme")
            SettingChangedLineView(key: "theme")
        }
        Group {
            Picker("Default permission", selection: $permMode) {
                ForEach(AgentDefaults.permissionModes, id: \.self) { Text(AgentDefaults.label($0)).tag($0) }
            }
            .settingRow("defaultPermissionMode")
            SettingChangedLineView(key: "defaultPermissionMode")
        }
        // Written the moment it flips, like the orchestration switch below; Save is the
        // pickers' alone.
        Group {
            Toggle(SettingsCopy.smartModelSelection, isOn: $modelRouting)
            .settingRow("modelRouting")
            SettingChangedLineView(key: "modelRouting")
        }
        Text(SettingsCopy.smartModelSelectionHint)
            .font(.orbitLabel).foregroundStyle(.secondary)
        // Only smart model selection reads it, so it shows only while that is on (owner, 2026-11-20).
        if SessionSettings.shows(.optimizeFor, smartModelSelection: modelRouting) {
            Group {
                Picker(SettingsCopy.optimizeFor, selection: $optimizeFor) {
                    ForEach(OptimizeFor.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .settingRow("optimizeFor")
                SettingChangedLineView(key: "optimizeFor")
            }
            Text(SettingsCopy.optimizeForHint)
                .font(.orbitLabel).foregroundStyle(.secondary)
        }
        Group {
            Toggle(SettingsCopy.suggestedReplies, isOn: $promptSuggestions)
            .settingRow("promptSuggestions")
            SettingChangedLineView(key: "promptSuggestions")
        }
        Text(SettingsCopy.suggestedRepliesHint)
            .font(.orbitLabel).foregroundStyle(.secondary)
        // Prompt optimizer (board frame 1): under Suggested replies, off by default; a server
        // without a DeepSeek key draws it disabled with frame 1b's notice.
        Group {
            Toggle(PromptOptimizerCopy.title, isOn: $promptOptimizer)
            .accessibilityIdentifier(PromptOptimizerCopy.toggleIdentifier)
            .settingRow("promptOptimizer")
            SettingChangedLineView(key: "promptOptimizer")
            Text(PromptOptimizerCopy.hint)
                .font(.orbitLabel).foregroundStyle(.secondary)
            if PromptOptimizer.unavailable(model.user) {
                Text(PromptOptimizerCopy.unavailable)
                    .font(.orbitLabel).foregroundStyle(.orange)
            }
        }
        .disabled(PromptOptimizer.unavailable(model.user))
        Group {
            Toggle(SettingsCopy.sessionRecaps, isOn: $recaps)
            .settingRow("recaps")
            SettingChangedLineView(key: "recaps")
        }
        Text(SettingsCopy.sessionRecapsHint)
            .font(.orbitLabel).foregroundStyle(.secondary)
        Button("Save preferences") {
            Task { await model.savePreferences(preferencesPatch) }
        }
    }
    }

    @ViewBuilder
    private var translationSection: some View {
    // Settings › Translation (board frames 1, 2 and 7): account-wide, written the moment it
    // changes. A server without a DeepSeek key draws it disabled with frame 2's notice.
    Section(TranslationCopy.title) {
        Group {
            Toggle(TranslationCopy.translateConversations, isOn: $translation)
                .accessibilityIdentifier(TranslationCopy.toggleIdentifier)
                .settingRow("translationEnabled")
            SettingChangedLineView(key: "translationEnabled")
        }
        Text(TranslationCopy.translateConversationsHint(translationAgentLanguage))
            .font(.orbitLabel).foregroundStyle(.secondary)
        if SessionTranslation.unavailable(model.user) {
            Text(TranslationCopy.unavailable)
                .font(.orbitLabel).foregroundStyle(.orange)
        }
        Group {
            Picker(TranslationCopy.yourLanguage, selection: $translationLanguage) {
                ForEach(TranslationLanguage.allCases, id: \.self) { Text($0.name).tag($0) }
            }
            .accessibilityIdentifier(TranslationCopy.languageIdentifier)
            .settingRow("translationLanguage")
            SettingChangedLineView(key: "translationLanguage")
        }
        Text(TranslationCopy.yourLanguageHint)
            .font(.orbitLabel).foregroundStyle(.secondary)
        Group {
            Picker(TranslationCopy.agentsWorkIn, selection: $translationAgentLanguage) {
                ForEach(TranslationLanguage.allCases, id: \.self) { Text($0.name).tag($0) }
            }
            .accessibilityIdentifier(TranslationCopy.agentLanguageIdentifier)
            .settingRow("translationAgentLanguage")
            SettingChangedLineView(key: "translationAgentLanguage")
        }
        Text(TranslationCopy.agentsWorkInHint)
            .font(.orbitLabel).foregroundStyle(.secondary)
        // Only while translation is on (mark A).
        if translation {
            Toggle(TranslationCopy.showBothLanguages, isOn: $bilingual)
                .accessibilityIdentifier(TranslationCopy.bilingualIdentifier)
                .settingRow("translationBilingual")
            SettingChangedLineView(key: "translationBilingual")
        }
        Text(TranslationCopy.bilingualFootnote + " " + TranslationCopy.footnote)
            .font(.orbitLabel).foregroundStyle(.secondary)
    }
    .disabled(SessionTranslation.unavailable(model.user))
    }

    @ViewBuilder
    private var orchestrationSection: some View {
    // One switch for the whole account, not one per workspace: the server reads it live on
    // every claim, spawn and call, so turning it off takes the tools away everywhere at once.
    Section("Session orchestration") {
        Group {
            Toggle(SettingsCopy.letSessionsOrchestrate, isOn: $orchestration)
            .settingRow("enableOrchestration")
            SettingChangedLineView(key: "enableOrchestration")
        }
        Text(SettingsCopy.letSessionsOrchestrateHint)
            .font(.orbitLabel).foregroundStyle(.secondary)
    }
    }

    @ViewBuilder
    private var passwordSection: some View {
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
    }

    @ViewBuilder
    private var updatesSection: some View {
    Section("Updates") {
        Toggle("Receive beta updates", isOn: $updater.betaChannel)
        Text("Beta releases ship earlier and may be less stable.")
            .font(.orbitLabel).foregroundStyle(.secondary)
    }
    }


    /// What the Machines & models row says, as the phone's does (`SettingsSheet`): how many lines the page's
    /// Needs you holds, or with none how many machines are online — only once the server has answered.
    private var machinesValue: (text: String, needsYou: Bool)? {
        guard let runners = model.runners, runners.loadState.hasLoaded else { return nil }
        let needsYou = MachinesAndModelsLists(model).needsYouCount
        return (SettingsHome.machinesAndModelsValue(needsYou: needsYou, runners: runners.runners), needsYou > 0)
    }

    private func saveName() {
        guard ProfileEdit.canSave(name, saved: model.user?.name) else { return }
        Task {
            accountMessage = await model.saveName(name)
            if accountMessage == nil { name = ProfileEdit.name(name) }
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

    /// The same for smart model selection: just this key, and never from the seed.
    private func saveModelRouting() {
        guard (model.user?.preferences?.smartModelSelection ?? false) != modelRouting else { return }
        Task { await model.savePreferences(UpdatePreferencesRequest(modelRouting: modelRouting)) }
    }

    /// And for Optimize For.
    private func saveOptimizeFor() {
        guard OptimizeFor(stored: model.user?.preferences?.optimizeFor) != optimizeFor else { return }
        Task { await model.savePreferences(UpdatePreferencesRequest(optimizeFor: optimizeFor.rawValue)) }
    }

    /// And for suggested replies.
    private func savePromptSuggestions() {
        guard (model.user?.preferences?.suggestedReplies ?? true) != promptSuggestions else { return }
        Task { await model.savePreferences(UpdatePreferencesRequest(promptSuggestions: promptSuggestions)) }
    }

    /// And for session recaps.
    private func saveRecaps() {
        guard (model.user?.preferences?.showRecaps ?? true) != recaps else { return }
        Task { await model.savePreferences(UpdatePreferencesRequest(recaps: recaps)) }
    }

    /// And for Settings › Translation's switch and two languages, each its own key.
    private func saveTranslation() {
        guard (model.user?.preferences?.translationEnabled ?? false) != translation else { return }
        Task { await model.savePreferences(UpdatePreferencesRequest(translationEnabled: translation)) }
    }

    private func savePromptOptimizer() {
        // A server without a key draws it off; that is not the owner turning it off.
        guard !PromptOptimizer.unavailable(model.user),
              PromptOptimizer.switchedOn(model.user?.preferences) != promptOptimizer else { return }
        Task { await model.savePreferences(UpdatePreferencesRequest(promptOptimizer: promptOptimizer)) }
    }

    private func saveBilingual() {
        guard (model.user?.preferences?.translationBilingual ?? false) != bilingual else { return }
        Task { await model.savePreferences(UpdatePreferencesRequest(translationBilingual: bilingual)) }
    }

    private func saveTranslationLanguage() {
        guard SessionTranslation.language(model.user?.preferences) != translationLanguage else { return }
        Task { await model.savePreferences(UpdatePreferencesRequest(translationLanguage: translationLanguage.rawValue)) }
    }

    private func saveTranslationAgentLanguage() {
        guard SessionTranslation.agentLanguage(model.user?.preferences) != translationAgentLanguage else { return }
        Task { await model.savePreferences(UpdatePreferencesRequest(translationAgentLanguage: translationAgentLanguage.rawValue)) }
    }
}

/// The form's Access tokens section: the account's personal access tokens in the web page's two
/// tabs, each one that still works with a Revoke button that asks first — anything using it stops
/// working at once. Issuing is the web's alone (docs/personal-access-token-design.md §9), which the
/// section says where the web has its New token button.
private struct AccessTokensSection: View {
    @Environment(AppModel.self) private var model

    @State private var tab: AccessTokensList.Tab = .active
    @State private var pendingRevoke: AccessToken?
    /// What the last revoke came to, under the list.
    @State private var outcome: String?

    var body: some View {
        let tokens = model.accessTokens?.tokens ?? []
        let shown = AccessTokensList.tokens(tokens, in: tab)
        Section(AccessTokensList.title) {
            Text(AccessTokensList.subtitle + " " + AccessTokensList.issuedOnTheWeb)
                .font(.orbitLabel).foregroundStyle(.secondary)
            Picker(AccessTokensList.title, selection: $tab) {
                ForEach(AccessTokensList.Tab.allCases) { tab in
                    Text("\(tab.label) \(AccessTokensList.tokens(tokens, in: tab).count)").tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            switch LoadFailureLogic.presentation(model.accessTokens?.loadState ?? ListLoadState(),
                                                 isEmpty: tokens.isEmpty) {
            case .loading:
                ProgressView().frame(maxWidth: .infinity)
            case .failed:
                HStack {
                    Text(model.accessTokens?.errorText ?? AccessTokensList.couldNotLoad)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button(SharePanelCopy.retry) { Task { await model.accessTokens?.load() } }
                }
            case .empty, .content:
                if shown.isEmpty {
                    Text(tab.empty).foregroundStyle(.secondary)
                }
                ForEach(shown) { token in
                    row(token)
                }
            }
            if let outcome {
                Text(outcome).font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
    }

    private func row(_ token: AccessToken) -> some View {
        HStack(alignment: .top, spacing: 12) {
            AccessTokenRow(token: token, now: Date())
            if AccessTokensList.canRevoke(token) {
                Button(AccessTokensList.revoke + "…", role: .destructive) { pendingRevoke = token }
                    .disabled(model.accessTokens?.revokingID == token.id)
                    // On the row that asked, so only its own token's question is ever up.
                    .orbitConfirmation(AccessTokensList.revokeTitle(token), isPresented: revokeAsked(token)) {
                        Button(AccessTokensList.revoke, role: .destructive) { Task { await revoke(token) } }
                        Button(SharePanelCopy.cancel, role: .cancel) {}
                    } message: {
                        Text(AccessTokensList.revokeDetail)
                    }
            }
        }
    }

    private func revokeAsked(_ token: AccessToken) -> Binding<Bool> {
        Binding(get: { pendingRevoke?.id == token.id }, set: { if !$0 { pendingRevoke = nil } })
    }

    private func revoke(_ token: AccessToken) async {
        guard let accessTokens = model.accessTokens else { return }
        outcome = await accessTokens.revoke(token).map(AccessTokensList.notRevoked) ?? AccessTokensList.revoked
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
