import SwiftUI
import OrbitKit

// One engine CLI on one runner, one push from the Engines rows of that runner's page
// (ios-detail.png ④): its version and whether it is kept current, then every account it is signed
// into on that machine — Default and each one the runner added — with that account's own sign-in
// state and quota (`CodexAccounts`, the same split the New Session picker reads). Signing in, again
// or for the first time, is `RunnerSignInView` for that account, started by the press that opens it
// and folded back once the account is signed in; Add Account starts signing a new one in at once,
// under a name it picks and the user can change, and folds back once that account is signed in. On a
// phone an account's row says only where it stands — Paused, a login about to lapse, what being signed
// out costs — and its presses are on its left swipe (Pause or Resume, and Remove for an added one,
// after asking) and its long-press menu (all of those, Rename… and Sign In Again too); a Mac keeps
// them on the row. None of it can reach a machine that is offline, so there the presses are greyed
// and the page says why — all but Rename… (Default's too: a name is a label Orbit keeps, and the
// machine has no say) and the pause, which Orbit keeps as well.

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

    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif

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
    /// The account whose Pause Account sheet is up: raised by its swipe or its long-press menu.
    @State private var pausing: RunnerPageFormat.AccountLine?
    /// The account whose card said its sign-in landed, a moment after it said so: the card folds
    /// back once the runner reports the account that way too (`foldsBack`).
    @State private var landedHere: String?
    /// The account whose rename alert is up, and the name being typed into it — seeded in the same
    /// press that raises the alert, as the session rename's is (SessionRenameAlert.swift).
    @State private var renaming: RunnerPageFormat.AccountLine?
    @State private var renameDraft = ""
    @State private var notice: String?

    private static let adding = "+"
    /// What a runner account's pause applies to, as the Pause Account sheet says it.
    private static let pauseScope = "Personal account · This runner. Paused sessions wait until it resumes or you switch accounts."
    /// A Mac keeps an account's presses on its row — a pointer has no habit of swiping a row open —
    /// where a phone keeps them on the row's swipe and long-press menu.
    private static let pressesOnRow: Bool = {
        #if os(macOS)
        return true
        #else
        return false
        #endif
    }()

    var body: some View {
        let now = Date()
        let health = RunnerPageFormat.engines(runner).first { $0.engine == engine }
        let offline = RunnerPageFormat.isOffline(runner, now: now)
        Form {
            head(health, now: now)
            if engine == "dsh" {
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
        .sheet(item: $pausing) { line in
            AccountPauseSheet(name: line.name, scope: Self.pauseScope) { minutes in
                await pause(line, minutes: minutes)
            }
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

    /// Every login the engine has on that machine, each with its own state and quota. Antigravity's are
    /// Google sign-ins, drawn the same way: the runner's own is Default, and Add Account signs another
    /// one in where the runner can keep it apart (`RunnerPageFormat.canAddAccount`) — a macOS runner, or
    /// one too old to sign in with Google at all, says so instead. Every Google sign-in on the page
    /// starts above the section's footer, so Google's terms are said there, once.
    @ViewBuilder private func accountsSection(_ health: RunnerEngineHealth, login: LoginEngine, offline: Bool,
                                              now: Date) -> some View {
        Section {
            ForEach(RunnerPageFormat.accountLines(health)) { line in
                let canPause = RunnerPageFormat.keepsAccounts(engine)
                    && (health.accounts ?? []).contains { $0.id == line.id }
                // A row whose sign-in card is open has no swipe: its code field takes the drags.
                withActions(accountRow(line, login: login, offline: offline, now: now, canPause: canPause),
                            id: "\(engine)/\(line.id)",
                            trailing: signingIn == line.id ? []
                                : trailingActions(line, canPause: canPause, offline: offline, now: now),
                            menu: accountMenu(line, canPause: canPause, offline: offline, now: now))
                    // On the account's own row, whose swipe or menu raises it, so the panel opens
                    // against the row rather than at the top of the page.
                    .orbitConfirmation({ _ in removalTitle },
                                       isPresented: removalAsked, presenting: pendingRemoval) { line in
                        Button("Remove", role: .destructive) { remove(line) }
                        Button("Cancel", role: .cancel) {}
                    } message: { line in
                        Text(removalNote(line))
                    }
            }
            if RunnerPageFormat.canAddAccount(runner, engine: engine) {
                addAccountRow(health, login: login, offline: offline)
            } else if let hint = RunnerPageFormat.signInHint(runner, engine: engine) {
                Text(hint)
                    .font(.orbitLabel)
                    .foregroundStyle(Color.secondary)
            }
        } header: {
            RunnerSectionHeader(RunnerPageFormat.keepsAccounts(engine) ? "Accounts" : "Sign-In")
        } footer: {
            if engine == "antigravity" && RunnerPageFormat.antigravityCanSignIn(runner) {
                VStack(alignment: .leading, spacing: 8) {
                    GoogleSignInTermsView()
                    if offline {
                        Text(RunnerPageCopy.RUNNER_ENGINES_OFFLINE_FOOTER)
                    }
                }
            } else if offline {
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

    /// One account: its name and where it lives, where it stands, its windows — a login about to lapse,
    /// a pause, what being signed out costs — and its way (back) in where it is out.
    @ViewBuilder private func accountRow(_ line: RunnerPageFormat.AccountLine, login: LoginEngine, offline: Bool,
                                         now: Date, canPause: Bool) -> some View {
        let windows = RunnerPageFormat.accountWindows(runner, engine: engine, account: line.id)
        let alone = (runner.engines?.first(where: { $0.engine == engine })?.accounts?.count ?? 0) < 2
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
            } else if line.envKey {
                Text("env key · runs on your Gemini key")
                    .font(.orbitLabel)
                    .foregroundStyle(Color.secondary)
            } else if line.auth == "yes", RunnerPageFormat.reportsQuota(engine) {
                Text(RunnerPageCopy.RUNNER_ENGINE_NO_QUOTA)
                    .font(.orbitLabel)
                    .foregroundStyle(Color.secondary)
            }
            // A login about to lapse, said before it does the way Claude Code says it, with the way to
            // renew it beside it: the row's own sign-in, into the same account.
            if signingIn != line.id, let expiring = RunnerPageFormat.loginExpiresLine(line, now: now) {
                HStack(alignment: .firstTextBaseline) {
                    Label(expiring, systemImage: "exclamationmark.triangle.fill")
                        .font(.orbitLabel.weight(.semibold))
                        .foregroundStyle(RunnerInk.amber)
                    Spacer(minLength: 8)
                    Button(RunnerPageCopy.RUNNER_ENGINE_RENEW) { signingIn = line.id }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                        .disabled(offline || removal?.pending == true)
                }
            }
            if let refused = removal?.refused {
                Text(refused)
                    .font(.orbitLabel)
                    .foregroundStyle(RunnerInk.red)
            }
            if signingIn == line.id {
                RunnerSignInView(runnerID: runner.id, engine: login, account: line.signInAccount, autoStart: true,
                                 onClose: { closeSignIn() }, onSignedIn: { landed(line.id) })
            } else if Self.pressesOnRow && canPause && (line.auth == "yes" || AccountPause.isPaused(line.pausedUntil, now: now)) {
                AccountPauseControls(name: line.name, pausedUntil: line.pausedUntil, scope: Self.pauseScope,
                                     signedInAction: { signingIn = line.id },
                                     signInDisabled: offline || removal?.pending == true) { minutes in
                    await runners.pauseAccount(runner.id, engine: login, account: line.id, durationMinutes: minutes)
                }
            } else {
                if !Self.pressesOnRow {
                    // Paused is the row's state; Resume and a new duration are its swipe's and menu's.
                    AccountPauseLine(pausedUntil: line.pausedUntil)
                }
                if let note = RunnerPageFormat.signedOutNote(line, alone: alone, engine: engine) {
                    Text(note)
                        .font(.orbitLabel)
                        .foregroundStyle(Color.secondary)
                }
                // A Default that runs on the machine's Gemini key is not signed in to Google. Alone it
                // offers that sign-in, as it always has — on a runner too old to add accounts it is the
                // only way in; beside Google accounts Add Account is where another joins (as on web). On a
                // phone an account signed in is signed in again from its long-press menu.
                if RunnerPageFormat.canSignIn(runner, engine: engine) && (!line.envKey || alone)
                    && (Self.pressesOnRow || line.auth != "yes") {
                    Button(line.envKey ? "Sign in with Google" : line.auth == "yes" ? "Sign In Again" : RunnerPageCopy.RUNNER_SIGN_IN) {
                        signingIn = line.id
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .disabled(offline || removal?.pending == true)
                }
            }
        }
        .padding(.vertical, 4)
        .onChange(of: foldsBack(line, now: now)) { _, fold in
            if fold { closeSignIn() }
        }
    }

    /// The row with its presses: its long-press menu, and its left swipe — on a phone (iOS 26,
    /// compact width) drawn as the session list draws its own (`circleSwipeActions`), since the
    /// system's would be stretched to the whole height of an account's row; elsewhere the system's.
    @ViewBuilder private func withActions<Row: View, Menu: View>(_ row: Row, id: String, trailing: [RowSwipeAction],
                                                                 menu: Menu) -> some View {
        #if os(iOS)
        if #available(iOS 26.0, *), horizontalSizeClass == .compact, !trailing.isEmpty {
            row
                .contextMenu { menu }
                .circleSwipeActions(id: id, leading: [], trailing: trailing, leadingFullSwipe: false)
        } else {
            systemSwipeActions(row, trailing: trailing)
                .contextMenu { menu }
        }
        #else
        systemSwipeActions(row, trailing: trailing)
            .contextMenu { menu }
        #endif
    }

    private func systemSwipeActions<Row: View>(_ row: Row, trailing: [RowSwipeAction]) -> some View {
        row.swipeActions(edge: .trailing, allowsFullSwipe: false) {
            ForEach(trailing) { action in
                Button(role: action.role, action: action.perform) {
                    Label(action.title, systemImage: action.systemImage)
                }
                .tint(action.tint)
                .disabled(!action.isEnabled)
            }
        }
    }

    /// An account's left swipe, from the screen edge inward: Remove outermost — an added account's,
    /// after asking, never by a full swipe — then Pause, or Resume while it is paused. Pause opens the
    /// Pause Account sheet; Resume is done at once. Both work offline: a pause is Orbit's to keep.
    private func trailingActions(_ line: RunnerPageFormat.AccountLine, canPause: Bool, offline: Bool,
                                 now: Date) -> [RowSwipeAction] {
        var actions: [RowSwipeAction] = []
        if !line.isDefault {
            actions.append(RowSwipeAction(title: "Remove", systemImage: "trash", tint: .red, role: .destructive,
                                          isEnabled: !offline, perform: { pendingRemoval = line }))
        }
        if canPause {
            if AccountPause.isPaused(line.pausedUntil, now: now) {
                actions.append(RowSwipeAction(title: "Resume", systemImage: "play", tint: .green,
                                              perform: { resume(line) }))
            } else if line.auth == "yes" {
                actions.append(RowSwipeAction(title: "Pause", systemImage: "pause", tint: .orange,
                                              perform: { pausing = line }))
            }
        }
        return actions
    }

    /// An account's long-press menu: everything its row and swipe offer, so it is all in reach of
    /// VoiceOver and of anyone who doesn't swipe. Rename stays out of the swipe: it opens an editor
    /// rather than performing the action, which is not what a swipe promises (SessionRowActions.swift);
    /// Sign In Again opens the account's sign-in on its row, so it is the menu's alone too.
    @ViewBuilder private func accountMenu(_ line: RunnerPageFormat.AccountLine, canPause: Bool, offline: Bool,
                                          now: Date) -> some View {
        let removal = RunnerPageFormat.removal(runner.accountRemove, engine: engine, account: line.id)
        Button {
            renameDraft = line.name
            renaming = line
        } label: {
            Label("Rename…", systemImage: "pencil")
        }
        if line.auth == "yes" && !line.envKey && RunnerPageFormat.canSignIn(runner, engine: engine) {
            Button { signingIn = line.id } label: {
                Label("Sign In Again", systemImage: "arrow.clockwise")
            }
            .disabled(offline || removal?.pending == true)
        }
        if canPause {
            if AccountPause.isPaused(line.pausedUntil, now: now) {
                Button { resume(line) } label: { Label("Resume Now", systemImage: "play.fill") }
                Button { pausing = line } label: { Label("Change Duration…", systemImage: "clock") }
            } else if line.auth == "yes" {
                Button { pausing = line } label: { Label("Pause…", systemImage: "pause.fill") }
            }
        }
        if !line.isDefault {
            Divider()
            Button(role: .destructive) { pendingRemoval = line } label: {
                Label("Remove…", systemImage: "trash")
            }
            .disabled(offline)
        }
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
                RunnerSignInView(runnerID: runner.id, engine: login, accountName: newAccountName, autoStart: true,
                                 onClose: { closeSignIn() })
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
        landedHere = nil
        Task { await runners.load() }
    }

    /// The card for account `id` said its sign-in landed. It says so for a moment, and folds back once
    /// the runner reports the account that way too (`foldsBack`) — read again now, not on the next pass.
    private func landed(_ id: String) {
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            landedHere = id
            await runners.load()
        }
    }

    /// Whether an account's open card folds back: its sign-in landed, and the row it folds into says
    /// so — signed in, and no longer a login about to lapse (a renewal moves the lapse a month on).
    private func foldsBack(_ line: RunnerPageFormat.AccountLine, now: Date) -> Bool {
        signingIn == line.id && landedHere == line.id && line.auth == "yes"
            && RunnerPageFormat.loginExpiresLine(line, now: now) == nil
    }

    /// Pause an account for `minutes`, or resume it (nil): the Pause Account sheet's press, a swipe's
    /// or a menu's. The model reads the runner again after the write.
    private func pause(_ line: RunnerPageFormat.AccountLine, minutes: Int?) async -> String? {
        guard let login = RunnerPageFormat.loginEngine(engine) else { return nil }
        return await runners.pauseAccount(runner.id, engine: login, account: line.id, durationMinutes: minutes)
    }

    private func resume(_ line: RunnerPageFormat.AccountLine) {
        Task {
            if let failure = await pause(line, minutes: nil) { show(failure) }
        }
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
