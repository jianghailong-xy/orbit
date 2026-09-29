import SwiftUI
import OrbitKit

// One engine CLI on one runner, one push from the Engines rows of that runner's page
// (ios-detail.png ④): its version and whether it is kept current, then every account it is signed
// into on that machine — Default and each one the runner added — with that account's own sign-in
// state and quota (`CodexAccounts`, the same split the New Session picker reads). Signing in, again
// or for the first time, is `RunnerSignInView` for that account; Add Account signs a new one in under
// a name; an added account swipes off the machine, after asking. None of it can reach a machine that
// is offline, so there the presses are greyed and the page says why.

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
    @State private var pendingRemoval: RunnerPageFormat.AccountLine?
    @State private var notice: String?

    private static let adding = "+"

    var body: some View {
        let now = Date()
        let health = RunnerPageFormat.engines(runner).first { $0.engine == engine }
        let offline = RunnerPageFormat.isOffline(runner, now: now)
        Form {
            head(health, now: now)
            if let health, health.installed == true, let login = RunnerPageFormat.loginEngine(engine) {
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
        .confirmationDialog(removalTitle, isPresented: removalAsked, titleVisibility: .visible,
                            presenting: pendingRemoval) { line in
            Button("Remove", role: .destructive) { remove(line) }
            Button("Cancel", role: .cancel) {}
        } message: { line in
            Text(removalNote(line))
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
                accountRow(line, login: login, offline: offline, now: now)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if !line.isDefault {
                            Button(role: .destructive) { pendingRemoval = line } label: {
                                Label("Remove", systemImage: "trash")
                            }
                            .disabled(offline)
                        }
                    }
            }
            if RunnerPageFormat.keepsAccounts(engine) {
                addAccountRow(login: login, offline: offline)
            }
        } header: {
            RunnerSectionHeader(RunnerPageFormat.keepsAccounts(engine) ? "Accounts" : "Sign-In")
        } footer: {
            if offline {
                Text(RunnerPageCopy.RUNNER_ENGINES_OFFLINE_FOOTER)
            } else if signingIn == Self.adding {
                Text(addAccountNote(login))
            }
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
                                         now: Date) -> some View {
        let windows = RunnerPageFormat.accountWindows(runner, engine: engine, account: line.id)
        let status = RunnerPageFormat.authStatus(line.auth)
        let removal = RunnerPageFormat.removal(runner.accountRemove, engine: engine, account: line.id)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(line.name)
                        .font(.headline)
                    if let home = line.home {
                        Text(home)
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

    /// Add Account: a name for it, then the same sign-in as every account here. The runner gives the
    /// account a directory of its own, so Default — and the CLI in a terminal — is untouched.
    @ViewBuilder private func addAccountRow(login: LoginEngine, offline: Bool) -> some View {
        if signingIn == Self.adding {
            VStack(alignment: .leading, spacing: 10) {
                TextField("Account name", text: $newAccountName, prompt: Text("Work"))
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                RunnerSignInView(runnerID: runner.id, engine: login, accountName: newAccountName)
                Button("Close") { closeSignIn() }
                    .buttonStyle(.borderless)
                    .font(.orbitLabel)
            }
            .padding(.vertical, 4)
        } else {
            Button("Add Account") {
                newAccountName = ""
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

    private func addAccountNote(_ login: LoginEngine) -> String {
        let dir = login == .claude ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"
        return "Only a label for this page. Orbit gives the account its own \(dir) on this machine; "
            + "your terminal keeps using Default."
    }

    private var removalAsked: Binding<Bool> {
        Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } })
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
