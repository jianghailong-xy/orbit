import SwiftUI
import OrbitKit

// One engine CLI on one runner, one push from the Engines rows of that runner's page
// (ios-detail.png ④): its version and whether it is kept current, then every account it is signed
// into on that machine — Default and each one the runner added — with that account's own sign-in
// state and quota (`CodexAccounts`, the same split the New Session picker reads). Signing in, again
// or for the first time, is `RunnerSignInView` for that account; Add Account starts signing a new one
// in at once, under a name it picks and the user can change, and folds back once that account is
// signed in; an added account swipes off the machine, after asking. None of it can reach a machine
// that is offline, so there the presses are greyed and the page says why — all but Rename…, in every
// account's long-press menu, Default's too: a name is a label Orbit keeps, and the machine has no say.

/// The engine page for `engine` on the runner `runnerID` — the frame `NavNode.runnerEngine` names.
struct RunnerEnginePage: View {
    @Environment(AppModel.self) private var model
    let runnerID: String
    let engine: String

    var body: some View {
        if let runners = model.runners, let runner = runners.runner(runnerID) {
            RunnerEngineContent(runners: runners, runner: runner, engine: engine)
        } else {
            ContentUnavailableView(RunnerPageFormat.engineName(engine), systemImage: "desktopcomputer",
                                   description: Text("This runner is no longer on your account."))
        }
    }
}

private struct RunnerEngineContent: View {
    let runners: RunnersModel
    let runner: Runner
    let engine: String

    /// Whose sign-in card is open: an account's id, or `adding` for a new one. One at a time — the
    /// runner runs one sign-in relay at a time.
    @State private var signingIn: String?
    @State private var newAccountName = ""
    /// Add Account's own: the name it picked, the accounts the runner had when it was pressed (nil
    /// before it ever was) — the one it adds is the newest the runner reports that isn't among them —
    /// and a name saved before the runner reported that account to give it to.
    @State private var newAccountPicked = ""
    @State private var accountsBeforeAdd: Set<String>?
    @State private var newAccountWaiting: String?
    /// The name field has the caret, which the card waits for; a rename of the added account is on
    /// its way, which it waits for too.
    @FocusState private var newAccountFocused: Bool
    @State private var newAccountRenaming = false
    @State private var pendingRemoval: RunnerPageFormat.AccountLine?
    /// The account whose rename alert is up, and the name being typed into it — seeded in the same
    /// press that raises the alert, as the session rename's is (SessionRenameAlert.swift).
    @State private var renaming: RunnerPageFormat.AccountLine?
    @State private var renameDraft = ""
    @State private var notice: String?

    private static let adding = "+"

    var body: some View {
        let now = Date()
        let health = RunnerPageFormat.engines(runner).first { $0.engine == engine }
        let offline = RunnerPageFormat.isOffline(runner, now: now)
        Form {
            head(health, now: now)
            if engine == "antigravity" {
                antigravitySection(health, offline: offline, now: now)
            } else if engine == "dsh" {
                dshSection(offline: offline)
            } else if let health, health.installed == true, let login = RunnerPageFormat.loginEngine(engine) {
                accountsSection(health, login: login, offline: offline, now: now)
            }
            updateSection(offline: offline)
        }
        .formStyle(.grouped)
        .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface` behind the grouped form
        .navigationTitle(RunnerPageFormat.engineName(engine))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .alert("Rename Account", isPresented: renameAsked, presenting: renaming) { line in
            TextField(line.isDefault ? "Default" : "Name", text: $renameDraft)
            // Default action, so Return in the field commits.
            Button("Save") { rename(line) }
                .keyboardShortcut(.defaultAction)
            Button("Cancel", role: .cancel) {}
        }
        .runnerNotice(notice)
        // A sign-in lands on the machine's next check-in: read it again while the page is up.
        .task(id: runner.id) {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled else { return }
                await runners.load()
            }
        }
        .refreshable { await runners.load() }
    }

    // MARK: sections

    /// DeepSeek Harness has no sign-in here: every session runs on the configured API key it was
    /// started with. What this machine decides is whether it can start Harness at all — and the one
    /// fix that happens here is installing the pinned CLI (web parity: Providers' Harness row).
    @ViewBuilder private func dshSection(offline: Bool) -> some View {
        let state = DshRuntime.state(of: runner)
        Section {
            Text(state.label ?? "Ready · sessions use the DeepSeek Harness API key they were started with")
                .foregroundStyle(state == .ready ? Color.secondary : RunnerInk.amber)
            if let hint = state.hint {
                Text(hint).font(.orbitLabel).foregroundStyle(Color.secondary)
            }
            if state.installable {
                Button("Install DeepSeek Harness") {
                    let id = runner.id
                    Task {
                        if let failure = await runners.installDsh(id) { show(failure) }
                        await runners.load()
                    }
                }
                .disabled(offline || runner.install?.inFlight == true)
            }
            if runner.install?.engine == "dsh", let message = runner.install?.message, !message.isEmpty {
                Text(message).font(.orbitLabel).foregroundStyle(Color.secondary)
            }
        }
    }

    @ViewBuilder private func antigravitySection(_ health: RunnerEngineHealth?, offline: Bool, now: Date) -> some View {
        Section {
            if health?.auth == "yes" {
                Text(health?.authSource == "google" ? "Google account" : "env key · runs on your Gemini key")
            }
            if let status = health.flatMap({ RunnerPageFormat.engineStatus($0, runner: runner) }), health?.auth != "yes" {
                Text(status.text).foregroundStyle(RunnerInk.status(status.tone))
            }
            ForEach(RunnerPageFormat.engineWindows(runner, engine: engine)) { row in
                RunnerWindowRow(row: row, resets: RunnerPageFormat.resetsLine(row, now: now))
            }
            if let hint = EngineAuth.antigravityLoginHint(runner.antigravity?.googleLogin) {
                Text(hint).font(.orbitLabel).foregroundStyle(Color.secondary)
            } else if RunnerPageFormat.antigravityCanSignIn(runner) {
                if signingIn != nil {
                    RunnerSignInView(runnerID: runner.id, engine: .antigravity)
                    Button("Close") { closeSignIn() }
                } else {
                    Button(health?.auth == "yes" && health?.authSource == "google" ? "Re-sign in · change Google account" : "Sign in with Google") {
                        signingIn = CodexAccounts.defaultID
                    }
                    .disabled(offline)
                    GoogleSignInTermsView()
                }
            }
        } header: {
            RunnerSectionHeader("Sign-In")
        } footer: {
            if offline { Text(RunnerPageCopy.RUNNER_ENGINES_OFFLINE_FOOTER) }
        }
    }

    /// The engine, its version and whether it is kept current.
    @ViewBuilder private func head(_ health: RunnerEngineHealth?, now: Date) -> some View {
        Section {
            HStack(spacing: 12) {
                ProviderMark(provider: engine, size: 30, label: RunnerPageFormat.engineName(engine))
                VStack(alignment: .leading, spacing: 1) {
                    Text(RunnerPageFormat.engineName(engine))
                        .font(.headline)
                    Text(versionLine(health, now: now))
                        .font(.orbitListSubtitle)
                        .foregroundStyle(Color.secondary)
                    if let health, let failed = RunnerPageFormat.updateFailedLine(health, now: now) {
                        Text(failed)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(RunnerInk.amber)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        }
    }

    /// Every login the engine has on that machine, each with its own state and quota.
    @ViewBuilder private func accountsSection(_ health: RunnerEngineHealth, login: LoginEngine, offline: Bool,
                                              now: Date) -> some View {
        Section {
            ForEach(RunnerPageFormat.accountLines(health)) { line in
                accountRow(line, login: login, offline: offline, now: now,
                           canPause: RunnerPageFormat.keepsAccounts(engine)
                               && (health.accounts ?? []).contains { $0.id == line.id })
                    // Rename stays out of the swipe actions: it opens an editor rather than performing
                    // the action, which is not what a swipe promises (SessionRowActions.swift).
                    .contextMenu {
                        Button {
                            renameDraft = line.name
                            renaming = line
                        } label: {
                            Label("Rename…", systemImage: "pencil")
                        }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if !line.isDefault {
                            Button(role: .destructive) { pendingRemoval = line } label: {
                                Label("Remove", systemImage: "trash")
                            }
                            .disabled(offline)
                        }
                    }
                    // On the account's own row, whose swipe raises it, so the panel opens against the
                    // row rather than at the top of the page.
                    .orbitConfirmation({ _ in removalTitle },
                                       isPresented: removalAsked, presenting: pendingRemoval) { line in
                        Button("Remove", role: .destructive) { remove(line) }
                        Button("Cancel", role: .cancel) {}
                    } message: { line in
                        Text(removalNote(line))
                    }
            }
            if RunnerPageFormat.keepsAccounts(engine) {
                addAccountRow(health, login: login, offline: offline)
            }
        } header: {
            RunnerSectionHeader(RunnerPageFormat.keepsAccounts(engine) ? "Accounts" : "Sign-In")
        } footer: {
            if offline {
                Text(RunnerPageCopy.RUNNER_ENGINES_OFFLINE_FOOTER)
            }
        }
        // A name saved for the account Add Account is adding, before the runner reported it, goes to
        // that account once it does — whether or not its card is still open.
        .onChange(of: newAccount(health)?.id) { _, _ in
            guard let added = newAccount(health), let name = newAccountWaiting else { return }
            newAccountWaiting = nil
            renameNewAccount(added, to: name)
        }
    }

    /// Update Engines Now updates every CLI on the machine, this one with them.
    @ViewBuilder private func updateSection(offline: Bool) -> some View {
        Section {
            Button(RunnerPageCopy.RUNNER_UPDATE_ENGINES_NOW) { updateEngines() }
                .disabled(offline || RunnerPageFormat.engineUpdateInFlight(runner.install))
            if let relay = RunnerPageFormat.updateRelayLine(runner.install) {
                Text(relay)
                    .font(.orbitLabel)
                    .foregroundStyle(Color.secondary)
            }
        } footer: {
            Text(offline ? RunnerPageCopy.RUNNER_ENGINES_OFFLINE_FOOTER : RunnerPageCopy.RUNNER_ENGINES_FOOTER)
        }
    }

    // MARK: rows

    /// One account: its name and where it lives, where it stands, its windows — and its way (back) in.
    @ViewBuilder private func accountRow(_ line: RunnerPageFormat.AccountLine, login: LoginEngine, offline: Bool,
                                         now: Date, canPause: Bool) -> some View {
        let windows = RunnerPageFormat.accountWindows(runner, engine: engine, account: line.id)
        let status = RunnerPageFormat.authStatus(line.auth)
        let removal = RunnerPageFormat.removal(runner.accountRemove, engine: engine, account: line.id)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(line.name)
                        .font(.headline)
                    if let subtitle = line.subtitle {
                        Text(subtitle)
                            .font(.orbitLabel)
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if let status {
                    Text(status.text)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(RunnerInk.status(status.tone))
                }
            }
            if !windows.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(windows) { row in
                        RunnerWindowRow(row: row, resets: RunnerPageFormat.resetsLine(row, now: now))
                    }
                }
            } else if line.auth == "yes", RunnerPageFormat.reportsQuota(engine) {
                Text(RunnerPageCopy.RUNNER_ENGINE_NO_QUOTA)
                    .font(.orbitLabel)
                    .foregroundStyle(Color.secondary)
            }
            if let refused = removal?.refused {
                Text(refused)
                    .font(.orbitLabel)
                    .foregroundStyle(RunnerInk.red)
            }
            if signingIn == line.id {
                RunnerSignInView(runnerID: runner.id, engine: login, account: line.signInAccount)
                Button("Close") { closeSignIn() }
                    .buttonStyle(.borderless)
                    .font(.orbitLabel)
            } else if canPause && (line.auth == "yes" || AccountPause.isPaused(line.pausedUntil, now: now)) {
                AccountPauseControls(name: line.name, pausedUntil: line.pausedUntil,
                                     scope: "Personal account · This runner. Paused sessions wait until it resumes or you switch accounts.",
                                     signedInAction: { signingIn = line.id },
                                     signInDisabled: offline || removal?.pending == true) { minutes in
                    await runners.pauseAccount(runner.id, engine: login, account: line.id, durationMinutes: minutes)
                }
            } else {
                Button(line.auth == "yes" ? "Sign In Again" : RunnerPageCopy.RUNNER_SIGN_IN) {
                    signingIn = line.id
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .disabled(offline || removal?.pending == true)
            }
        }
        .padding(.vertical, 4)
    }

    /// Add Account: the same sign-in as every account here, started by the press itself under a name
    /// the page picks (`RunnerPageFormat.defaultAccountName`). The runner gives the account a directory
    /// of its own, so Default — and the CLI in a terminal — is untouched. The name stays editable, and
    /// Return, leaving the field or the card going away saves it as Rename… does — which names only an
    /// account the runner reports, so a name saved before the new one is reported waits for it. Once
    /// that account is signed in, reported and named, the card folds back into Add Account: its row is
    /// what was added, and Rename… is where its name changes from then on (web AddEngineAccount).
    @ViewBuilder private func addAccountRow(_ health: RunnerEngineHealth, login: LoginEngine,
                                            offline: Bool) -> some View {
        if signingIn == Self.adding {
            VStack(alignment: .leading, spacing: 10) {
                TextField("Account name", text: $newAccountName, prompt: Text("Work"))
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .focused($newAccountFocused)
                    // Return is done typing: the focus leaving saves the name, as a click elsewhere does.
                    .onSubmit { newAccountFocused = false }
                RunnerSignInView(runnerID: runner.id, engine: login, accountName: newAccountName, autoStart: true)
                Button("Close") { closeSignIn() }
                    .buttonStyle(.borderless)
                    .font(.orbitLabel)
            }
            .padding(.vertical, 4)
            .onChange(of: newAccountFocused) { _, focused in
                if !focused { saveNewAccountName(health) }
            }
            .onChange(of: newAccountDone(health)) { _, done in
                if done { closeSignIn() }
            }
            .onDisappear { saveNewAccountName(health) }
        } else {
            Button("Add Account") {
                let accounts = health.accounts ?? []
                newAccountPicked = RunnerPageFormat.defaultAccountName(accounts)
                newAccountName = newAccountPicked
                accountsBeforeAdd = Set(accounts.map(\.id))
                newAccountWaiting = nil
                signingIn = Self.adding
            }
            .disabled(offline)
        }
    }

    // MARK: words

    /// `2.1.284 · checked 6m ago` — the updater's own footnote, amber when this machine has drifted.
    private func versionLine(_ health: RunnerEngineHealth?, now: Date) -> AttributedString {
        typealias Colour = AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute
        guard let health, health.installed == true else {
            return AttributedString(RunnerPageCopy.RUNNER_ENGINE_NOT_INSTALLED)
        }
        let version = RunnerPageFormat.engineVersion(health.version)
        var line = AttributedString(version ?? "")
        if let note = RunnerAttention.updateNoteOf(health.update, nowMs: RunnerPageFormat.nowMs(now)) {
            if version != nil { line += AttributedString(RunnerPageCopy.RUNNER_LINE_SEPARATOR) }
            var words = AttributedString(note.text)
            if note.tone == .warn { words[Colour.self] = RunnerInk.amber }
            line += words
        }
        return line
    }

    private var removalAsked: Binding<Bool> {
        Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } })
    }

    private var renameAsked: Binding<Bool> {
        Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    }

    private var removalTitle: String {
        guard let line = pendingRemoval else { return "Remove" }
        return "Remove “\(line.name)” from \(RunnerPageFormat.displayName(runner))?"
    }

    private func removalNote(_ line: RunnerPageFormat.AccountLine) -> String {
        let place = line.home ?? "Its sign-in"
        return "\(place) goes from this machine, and sessions stop running on it. Default is untouched."
    }

    // MARK: presses

    private func closeSignIn() {
        signingIn = nil
        Task { await runners.load() }
    }

    /// The session rename's rules: trimmed, and an empty or unchanged name changes nothing.
    private func rename(_ line: RunnerPageFormat.AccountLine) {
        guard let login = RunnerPageFormat.loginEngine(engine) else { return }
        let name = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != line.name else { return }
        let id = runner.id
        Task {
            if let failure = await runners.renameAccount(id, engine: login, account: line.id, name: name) { show(failure) }
        }
    }

    /// The account Add Account added: the newest the runner reports that it didn't have when the
    /// button was pressed. Nil until the runner reports it.
    private func newAccount(_ health: RunnerEngineHealth) -> RunnerEngineAccount? {
        guard let had = accountsBeforeAdd else { return nil }
        return (health.accounts ?? []).last { !had.contains($0.id) }
    }

    /// Whether Add Account is done: the account it added is signed in by the runner's own word and
    /// carries the name in the field. Not while that name is still being typed or saved — a rename
    /// that failed leaves it differing, and the card open — and never after a sign-in that failed or
    /// was cancelled, which reports no such account.
    private func newAccountDone(_ health: RunnerEngineHealth) -> Bool {
        guard let added = newAccount(health), added.auth == "yes" else { return false }
        return !newAccountFocused && newAccountWaiting == nil && !newAccountRenaming
            && newAccountName.trimmingCharacters(in: .whitespacesAndNewlines)
                == CodexAccounts.label(added.id, accounts: [added])
    }

    /// Save the name typed for the account Add Account is adding. An empty one changes nothing, as in
    /// Rename…: the field goes back to the name the account has.
    private func saveNewAccountName(_ health: RunnerEngineHealth) {
        let name = newAccountName.trimmingCharacters(in: .whitespacesAndNewlines)
        let added = newAccount(health)
        if name.isEmpty {
            newAccountName = added.map { CodexAccounts.label($0.id, accounts: [$0]) }
                ?? newAccountWaiting ?? newAccountPicked
        } else if let added {
            renameNewAccount(added, to: name)
        } else {
            newAccountWaiting = name
        }
    }

    /// Rename… for the account Add Account added; the name it already has changes nothing.
    private func renameNewAccount(_ account: RunnerEngineAccount, to name: String) {
        guard let login = RunnerPageFormat.loginEngine(engine),
              name != CodexAccounts.label(account.id, accounts: [account]) else { return }
        let id = runner.id
        newAccountRenaming = true
        Task {
            if let failure = await runners.renameAccount(id, engine: login, account: account.id, name: name) { show(failure) }
            newAccountRenaming = false
        }
    }

    private func remove(_ line: RunnerPageFormat.AccountLine) {
        guard let login = RunnerPageFormat.loginEngine(engine) else { return }
        let id = runner.id
        Task {
            if let failure = await runners.removeAccount(id, engine: login, account: line.id) { show(failure) }
        }
    }

    private func updateEngines() {
        let id = runner.id
        Task {
            if let failure = await runners.updateEngines(id) { show(failure) }
        }
    }

    private func show(_ text: String) {
        notice = text
        Task {
            try? await Task.sleep(for: .seconds(3))
            if notice == text { notice = nil }
        }
    }
}
