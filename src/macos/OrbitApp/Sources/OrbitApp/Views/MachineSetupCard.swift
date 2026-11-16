import SwiftUI
import OrbitKit

// A machine with no workspace (docs/mocks/first-workspace-in-conversation, board 03 and the rules of
// 04): its own new session page, where the engine hero stands for a machine that has one. A card asks
// the two things only the owner can answer, the folder sessions may read and change and the coding CLI
// they run on; what is sent before both are done waits under it; and the first message makes the
// workspace. The web's MachineSetupCard, iOS-ized as the board draws it: grouped options with a tick,
// capsule buttons. The rules are OrbitKit's (`MachineSetup`, `MachineSetupState`).

/// The setup card's colours, shared with the welcome card that grows out of it (`WelcomeCard`).
enum SetupInk {
    /// The card, off the page behind it in both appearances.
    static let card = Color(light: .white, dark: Color(red: 0.17, green: 0.17, blue: 0.18))
    /// The folder options' grouped band.
    static let options = Color.secondary.opacity(0.1)
    static let found = Color(light: Color(red: 0.102, green: 0.498, blue: 0.216),
                             dark: Color(red: 0.25, green: 0.75, blue: 0.40))
    static let warn = Color(light: Color(red: 0.76, green: 0.443, blue: 0.047),
                            dark: Color(red: 0.95, green: 0.65, blue: 0.25))
}

/// One numbered step of the setup card, a tick once it is done; the welcome card's steps too.
struct SetupStepRow<Content: View>: View {
    let number: Int
    let done: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Group {
                if done {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.orbitProse)
                        .foregroundStyle(Color.green)
                } else {
                    Text(verbatim: "\(number)")
                        .font(.orbitLabel.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 22, height: 22)
                        .overlay { Circle().strokeBorder(Color.secondary.opacity(0.5), lineWidth: 1) }
                }
            }
            .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 2) { content() }
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 11)
    }
}

extension View {
    /// The setup card's surface: off the page behind it, a hairline, a soft shadow.
    func setupCardSurface() -> some View {
        self
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(SetupInk.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5)
            }
            .shadow(color: .black.opacity(0.05), radius: 5, y: 2)
    }
}

/// A machine's own new session page. The machine's row is read again while the page is up, so a
/// sign-in landing, a runner updating itself or a machine coming back moves the card by itself.
struct MachineDraftPage: View {
    @Environment(AppModel.self) private var app
    let runnerID: String
    /// Kept by the app (`AppModel.machineSetup(for:)`): the view comes and goes on the way.
    @State private var setup: MachineSetupModel?

    private var runner: Runner? { app.agents?.runnerRow(runnerID) }

    var body: some View {
        Group {
            if let setup {
                MachineDraftContent(setup: setup)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        #if os(iOS)
        // The title bar is the machine's: there is no workspace name to write yet (board 03 ①). Beside
        // the drawer's hamburger, on the bar rather than in a platter with it (see `AgentPanes`).
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if #available(iOS 26.0, *) {
                ToolbarItem(placement: .topBarLeading) { title }
                    .sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .topBarLeading) { title }
            }
        }
        #endif
        .task(id: runnerID) {
            guard let agents = app.agents else { return }
            while !Task.isCancelled {
                await agents.refreshRunnerSnapshot()
                guard !Task.isCancelled else { return }
                if let runner {
                    setup = setup ?? app.machineSetup(for: runner)
                } else if agents.loadState.hasLoaded {
                    // Gone from the list: it has no page, rather than a spinner for good.
                    app.leaveMachineDraft(runnerID)
                    return
                }
                // More often while it is still connecting: its first heartbeat opens the folder step.
                try? await Task.sleep(for: .seconds(MachineSetup.refreshSeconds(for: runner)))
            }
        }
        .onChange(of: runner, initial: true) { _, _ in adopt() }
        .onChange(of: setup == nil) { _, _ in adopt() }
        .onChange(of: bare) { _, _ in adopt() }
        // The machine got a workspace some other way, or from a first send still being settled: the
        // page moves on to it once nothing of its own is out.
        .onChange(of: movedOn, initial: true) { _, now in
            if now { app.machineGotWorkspace(runnerID) }
        }
    }

    #if os(iOS)
    private var title: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(MachineSetupCopy.SETUP_PAGE_TITLE)
                .font(.headline)
                .lineLimit(1)
            if let runner {
                Text(RunnerPageFormat.displayName(runner))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .fixedSize()
    }
    #endif

    /// Only while the list says so: before it has answered a machine is not known to be bare.
    private var bare: Bool {
        app.agents?.loadState.hasLoaded == true && app.agents?.firstWorkspace(onRunner: runnerID) == nil
    }

    private var movedOn: Bool {
        guard app.agents?.firstWorkspace(onRunner: runnerID) != nil else { return false }
        return setup?.busy != true
    }

    private func adopt() {
        guard let runner else { return }
        setup?.adopt(runner: runner, bare: bare, fleet: app.agents?.runnerRows ?? [])
    }
}

private struct MachineDraftContent: View {
    @Environment(AppModel.self) private var app
    let setup: MachineSetupModel

    /// A new account's bare machine: the card greets it and offers first messages (web `machineWelcome`).
    private var welcome: Bool { app.newAccount == true && setup.bare }

    /// What moves the waiting message: it goes when this says it can.
    private struct Send: Equatable {
        let ready: Bool
        let held: HeldMessage?
        let busy: Bool
    }

    var body: some View {
        let draft = setup.draft
        let ready = setup.ready
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 12) {
                        MachineSetupCard(setup: setup, ready: ready, welcome: welcome)
                        if let held = setup.state.held, let registry = app.consoleRegistry {
                            HeldFirstMessageView(held: held, machine: RunnerPageFormat.displayName(setup.runner),
                                                 sending: setup.state.sendingHeld,
                                                 onWithdraw: { setup.withdraw() }, onRetry: { setup.retryHeld() })
                                // The bubble's own surroundings in a transcript (`ConsoleView`).
                                .environment(registry.attachments)
                                .environment(draft.createdTasks)
                                .id(HeldFirstMessageView.anchor)
                        }
                        ForEach(draft.localStatusCards) { card in
                            SessionStatusCardView(card: card)
                        }
                    }
                    .frame(maxWidth: 620)
                    .frame(maxWidth: .infinity)
                    .padding([.horizontal, .top], 14)
                    Color.clear.frame(height: .composerBandFade)
                }
                .fadesIntoComposerBand()
                #if os(iOS)
                .scrollDismissesKeyboard(.interactively)   // swipe the card to lower the keyboard
                #endif
                // What lands under the card can land below the fold.
                .onChange(of: setup.state.held != nil) { _, waiting in
                    if waiting { withAnimation { proxy.scrollTo(HeldFirstMessageView.anchor, anchor: .bottom) } }
                }
            }
            ComposerBand {
                if let msg = draft.statusMessage {
                    HStack {
                        Text(msg).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(2)
                        Spacer()
                        Button { draft.statusMessage = nil } label: { Image(systemName: "xmark") }
                            .buttonStyle(.plain).foregroundStyle(.secondary)
                    }
                    .padding(.bottom, .composerBandGap)
                }
                ComposerView(console: draft)
            }
        }
        .task { await draft.prepareDraft() }
        // A new account's first machine wears the welcome card (docs/mocks/new-user-onboarding): read
        // whether it is one as the page appears, as the web's query does.
        .task { await app.readNewAccount() }
        // The welcome placeholder, except on a machine that is offline, which keeps its own.
        .onChange(of: welcome && setup.online, initial: true) { _, now in draft.welcomes = now }
        // Both steps done with a message waiting: it goes by itself (rule 6).
        .onChange(of: Send(ready: ready, held: setup.state.held, busy: draft.sending), initial: true) { _, _ in
            setup.sendHeldIfReady()
        }
    }
}

/// The card: the machine's name, then the two steps, then what happens when you send.
private struct MachineSetupCard: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    let setup: MachineSetupModel
    let ready: Bool
    /// A new account's first machine (docs/mocks/new-user-onboarding): the welcome card's head in place
    /// of "Set up <machine>", and its first messages to try as a third step.
    var welcome = false

    private var runner: Runner { setup.runner }
    private var machine: String { RunnerPageFormat.displayName(runner) }
    private var offline: Bool { !setup.online }
    private var probes: Bool { MachineSetup.answersDirProbe(runner) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if welcome { WelcomeHead() } else { head }
            if let notice { noticeLine(notice) }
            Divider().padding(.top, 12)
            step(number: 1, done: setup.state.folder != nil) { folderStep }
            Divider()
            step(number: 2, done: setup.credential.done) { engineStep }
            Divider()
            if welcome {
                WelcomeExamplesStep(step: 3, console: setup.draft)
                Divider()
            }
            foot
        }
        .setupCardSurface()
    }

    private var head: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "desktopcomputer")
                .font(.orbitGlyph)
                .foregroundStyle(Color.accentColor)
                .frame(width: 30, height: 30)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(MachineSetupCopy.setupTitle(machine: machine))
                    .font(.headline)
                Text(MachineSetupCopy.SETUP_LEAD)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Why a step can't be done yet: the machine isn't here (rule 1), or it can't be asked about a path. Never
    /// heard from is a machine still coming up, not one gone away, nor one too old to check folders.
    private var notice: String? {
        if offline {
            return MachineSetup.isConnecting(runner) ? MachineSetupCopy.setupConnecting(machine: machine)
                : MachineSetupCopy.setupOffline(machine: machine)
        }
        guard !probes || !MachineSetup.makesNewFolders(runner) else { return nil }
        return MachineSetup.updatesItself(runner)
            ? MachineSetupCopy.setupUpdating(machine: machine)
            : MachineSetupCopy.setupNeedsUpdate(machine: machine)
    }

    private func noticeLine(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(text)
                .font(.orbitLabel)
                .foregroundStyle(SetupInk.warn)
                .fixedSize(horizontal: false, vertical: true)
            if !offline, !(probes && MachineSetup.makesNewFolders(runner)), !MachineSetup.updatesItself(runner) { openMachine }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SetupInk.warn.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.top, 10)
    }

    private var openMachine: some View {
        Button(MachineSetupCopy.SETUP_OPEN_MACHINE) { app.route(to: .runner(runner.id)) }
            .buttonStyle(.plain)
            .font(.orbitLabel)
            .foregroundStyle(Color.accentColor)
    }

    private func step<Content: View>(number: Int, done: Bool, @ViewBuilder content: @escaping () -> Content) -> some View {
        SetupStepRow(number: number, done: done, content: content)
    }

    @ViewBuilder private var folderStep: some View {
        if let folder = setup.state.folder {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(MachineSetupCopy.SETUP_FOLDER).fontWeight(.semibold)
                    Text(folder.doneLine)
                        .font(.orbitMono)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    change { setup.pick(nil) }
                }
                Text(folder.doneNote)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            folderOpenStep
                // Whether the deployment has a GitHub App, and the account's connection; again on the way back from
                // GitHub's sign-in in the browser.
                .task { await app.loadGithub() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await app.loadGithub() } }
                }
        }
    }

    /// From GitHub (docs/github-workspace-design.md §8): offered only where the deployment has a GitHub App.
    private var github: GithubIntegration? { app.github?.available == true ? app.github : nil }

    /// Step one before it has an answer (board 04 A): the folder's name with From GitHub under it, or, once that is
    /// pressed, the repository picker. Which of the two is open is kept with the page, so a card come back from
    /// GitHub's sign-in in the browser is still on From GitHub.
    private var folderOpenStep: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let github, setup.githubOpen {
                GithubStep(runner: runner, integration: github, disabled: offline,
                           onPick: { setup.pick($0) }, onBack: { setup.githubOpen = false })
            } else {
                FolderName(runner: runner, disabled: offline || !probes || !MachineSetup.makesNewFolders(runner),
                           githubDisabled: offline,
                           onGithub: github == nil ? nil : { setup.githubOpen = true }) { setup.pick($0) }
            }
        }
    }

    private var engineName: String { ProviderEngines.cliName(setup.draft.engine) }

    @ViewBuilder private var engineStep: some View {
        switch setup.credential {
        case .signedIn:
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(engineName).fontWeight(.semibold)
                Text(MachineSetupCopy.setupSignedIn(machine: machine))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
            }
        case .onKey(let label, let pool):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(label).fontWeight(.semibold).lineLimit(1)
                Text(pool ? MachineSetupCopy.SETUP_ON_A_POOL : MachineSetupCopy.SETUP_ON_A_KEY)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                // Back to a sign-in: this engine's, or for one that has none, the machine's first.
                change {
                    setup.useEngine(LoginEngine(rawValue: setup.draft.engine) ?? MachineSetup.firstEngineOn(runner.engines))
                }
            }
        case .signIn:
            signInHead
            // Nothing to drive offline; the notice says so.
            if !offline, let engine = LoginEngine(rawValue: setup.draft.engine) {
                RunnerSignInView(runnerID: runner.id, engine: engine,
                                 onSignedIn: { Task { await app.agents?.refreshRunnerSnapshot() } },
                                 signInTitle: RunnerPageCopy.RUNNER_SIGN_IN,
                                 onUseApiKey: setup.keyToUse == nil ? nil : { setup.useKey() })
                    .id(engine)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .padding(.top, 7)
            }
            alternatives
        case .notInstalled:
            signInHead
            Text(MachineSetupCopy.setupNotInstalled(engine: engineName, machine: machine))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
            openMachine
            alternatives
        }
    }

    private var signInHead: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(MachineSetupCopy.setupSignIn(engine: engineName, machine: machine))
                .fontWeight(.semibold)
                .fixedSize(horizontal: false, vertical: true)
            Text(MachineSetupCopy.SETUP_SIGN_IN_HELP)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Rule 5: the machine's other sign-ins.
    @ViewBuilder private var alternatives: some View {
        ForEach(setup.otherEngines) { other in
            Button(MachineSetupCopy.setupUseEngine(engine: other.displayName)) { setup.useEngine(other) }
                .buttonStyle(.plain)
                .font(.orbitLabel)
                .foregroundStyle(Color.accentColor)
                .disabled(offline)
                .padding(.top, 6)
        }
    }

    private func change(_ action: @escaping () -> Void) -> some View {
        Button(MachineSetupCopy.SETUP_CHANGE, action: action)
            .buttonStyle(.plain)
            .font(.orbitLabel)
            .foregroundStyle(Color.accentColor)
            .disabled(offline)
    }

    private var foot: some View {
        Group {
            if ready, let folder = setup.state.folder {
                Text(folder.readySentence)
                    .foregroundStyle(SetupInk.found)
            } else {
                Text(MachineSetupCopy.SETUP_FOOT)
                    .foregroundStyle(.secondary)
            }
        }
        .font(.orbitLabel)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 8)
    }
}

/// From GitHub's NEW tag (board 01, board 04 A).
private struct SetupNewTag: View {
    var body: some View {
        Text(MachineSetupCopy.SETUP_NEW_TAG)
            .font(.orbitMeta.weight(.semibold))
            .foregroundStyle(Color.accentColor)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(Color.accentColor.opacity(0.12), in: Capsule())
    }
}

/// Step one on From GitHub (board 04 A, P2's picker): the repository and the folder it is cloned into, and the way
/// back to a folder's name.
private struct GithubStep: View {
    let runner: Runner
    let integration: GithubIntegration
    let disabled: Bool
    let onPick: (PickedFolder) -> Void
    let onBack: () -> Void

    /// What the picker would pick, as it last said.
    @State private var candidate: PickedFolder?

    var body: some View {
        Text(MachineSetupCopy.SETUP_FOLDER).fontWeight(.semibold)
        Text(MachineSetupCopy.setupFolderHelp(machine: RunnerPageFormat.displayName(runner)))
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 5) {
            GithubMark()
            Text(MachineSetupCopy.SETUP_FROM_GITHUB).fontWeight(.semibold)
            SetupNewTag()
        }
        .padding(.top, 8)
        VStack(alignment: .leading, spacing: 3) {
            GithubFolderOption(runner: runner, integration: integration, disabled: disabled,
                               onCandidate: { candidate = $0 },
                               onEnter: { if let candidate { onPick(candidate) } })
        }
        .padding(.top, 4)
        if integration.connected && !integration.needsReconnect {
            Button(MachineSetupCopy.SETUP_USE_REPOSITORY) {
                if let candidate { onPick(candidate) }
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .controlSize(.small)
            .fontWeight(.semibold)
            .disabled(candidate == nil || disabled)
            .padding(.top, 9)
        }
        Button(MachineSetupCopy.SETUP_FOLDER_NAME_INSTEAD, action: onBack)
            .buttonStyle(.plain)
            .font(.orbitLabel)
            .foregroundStyle(Color.accentColor)
            .padding(.top, 6)
    }
}

/// Step one before it has an answer: one folder name in the machine's home (its Repos Folder on an older runner),
/// which the machine itself checks as it is typed. A folder that is there is used; one that isn't is made.
private struct FolderName: View {
    @Environment(AppModel.self) private var app
    let runner: Runner
    let disabled: Bool
    /// The From GitHub row's own lock, offline only: a machine too old to make folders may still clone, and the picker
    /// says when it can't.
    var githubDisabled = false
    /// From GitHub is offered here (board 04 A): the row under the field that swaps the step to the repository picker.
    var onGithub: (() -> Void)? = nil
    let onPick: (PickedFolder) -> Void

    @State private var typed = ""
    /// What the machine said about where the name would go. Nil while there is no answer yet.
    @State private var answer: DirProbeRelay.Outcome?
    /// Check again: the same path asked once more.
    @State private var attempt = 0

    private var machine: String { RunnerPageFormat.displayName(runner) }
    private var root: String { MachineSetup.newFolderRoot(runner) }
    private var name: String { typed.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var found: DirProbe? {
        guard case .answered(let probe)? = answer else { return nil }
        return probe
    }

    private var candidate: PickedFolder? {
        guard MachineSetup.isValidNewFolder(name), let found else { return nil }
        return MachineSetup.newFolderPick(found, name: name, root: root, machine: machine)
    }

    private struct Question: Equatable {
        let path: String?
        let attempt: Int
    }

    /// The name is asked about where it would go, as it is typed: a folder, or a file, may be there already.
    private var question: String? {
        guard !disabled, MachineSetup.isValidNewFolder(name) else { return nil }
        return MachineSetup.newFolderPath(root: root, name: name)
    }

    var body: some View {
        Text(MachineSetupCopy.SETUP_FOLDER).fontWeight(.semibold)
        Text(MachineSetupCopy.setupFolderHelp(machine: machine))
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Text(MachineSetup.newFolderPath(root: root, name: ""))
                    .font(.orbitMono)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                field(MachineSetupCopy.SETUP_NEW_FOLDER_NAME, text: $typed)
                    .accessibilityLabel(MachineSetupCopy.SETUP_FOLDER)
            }
            line
        }
        .padding(.top, 8)
        .disabled(disabled)
        Button(MachineSetupCopy.SETUP_USE_FOLDER) {
            if let candidate { onPick(candidate) }
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .fontWeight(.semibold)
        .disabled(candidate == nil || disabled)
        .padding(.top, 9)
        // As it is typed, once it has settled.
        .task(id: Question(path: question, attempt: attempt)) {
            answer = nil
            guard let asked = question else { return }
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            let outcome = await app.probeDir(runnerID: runner.id, path: asked, ask: true)
            if !Task.isCancelled { answer = outcome }
        }
        if let onGithub {
            HStack(spacing: 8) {
                VStack { Divider() }
                Text(MachineSetupCopy.SETUP_OR)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                VStack { Divider() }
            }
            .padding(.top, 12)
            Button(action: onGithub) {
                HStack(alignment: .top, spacing: 10) {
                    GithubMark()
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 5) {
                            Text(MachineSetupCopy.SETUP_FROM_GITHUB)
                                .fontWeight(.semibold)
                                .foregroundStyle(.primary)
                            SetupNewTag()
                        }
                        Text(MachineSetupCopy.SETUP_GITHUB_META)
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
                .padding(10)
                .contentShape(Rectangle())
                .background(SetupInk.options, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(githubDisabled)
            .padding(.top, 6)
        }
    }

    /// What the name says: what the step does while nothing is typed, then what the machine finds where it would go.
    @ViewBuilder private var line: some View {
        if name.isEmpty {
            meta(MachineSetupCopy.SETUP_FOLDER_HINT)
        } else if !MachineSetup.isValidNewFolder(name) {
            verdictLine(MachineSetupCopy.SETUP_NEW_FOLDER_INVALID, tone: .bad)
        } else if let found {
            let verdict = MachineSetup.newFolderVerdict(found, machine: machine)
            // Nothing there yet reads as a note; anything there says what it is.
            if found.exists { verdictLine(verdict.text, tone: verdict.tone) } else { meta(verdict.text) }
        } else if answer != nil {
            noAnswer { attempt += 1 }
        } else {
            checking
        }
    }

    private var checking: some View {
        Text(MachineSetupCopy.setupChecking(machine: machine))
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
    }

    /// A check the machine gave no answer to, and the way to ask it again.
    private func noAnswer(again: @escaping () -> Void) -> some View {
        HStack(spacing: 6) {
            verdictLine(MachineSetupCopy.setupNoAnswer(machine: machine), tone: .bad)
            Button(MachineSetupCopy.SETUP_CHECK_AGAIN, action: again)
                .buttonStyle(.plain)
                .font(.orbitLabel)
                .foregroundStyle(Color.accentColor)
        }
    }

    private func meta(_ text: String) -> some View {
        Text(text)
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func verdictLine(_ text: String, tone: FolderVerdict.Tone) -> some View {
        Text(text)
            .font(.orbitLabel)
            .foregroundStyle(tone == .ok ? SetupInk.found : tone == .warn ? SetupInk.warn : Color.red)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func field(_ prompt: String, text: Binding<String>) -> some View {
        TextField(prompt, text: text)
            .textFieldStyle(.roundedBorder)
            .font(.orbitMono)
            .autocorrectionDisabled()
            #if os(iOS)
            .textInputAutocapitalization(.never)
            #endif
            .onSubmit { if let candidate { onPick(candidate) } }
    }
}

/// The first message, waiting under the card for both steps: the bubble it will be, with what it is
/// waiting for beneath it and the way to take it back (rule 6). It goes by itself; only a refusal stops
/// it, and then it stays here, saying why, until it is tried again or taken back.
private struct HeldFirstMessageView: View {
    static let anchor = "held-first-message"

    let held: HeldMessage
    let machine: String
    let sending: Bool
    let onWithdraw: () -> Void
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            UserTurnRow(bubble: UserBubble(
                id: Self.anchor, text: held.content,
                attachments: held.attachments.map { TurnAttachment(id: $0.id, mime: $0.mimeType, name: $0.filename) },
                pending: false, shell: held.shell))
            Group {
                if sending {
                    Text(MachineSetupCopy.HELD_SENDING)
                } else {
                    // On one line where it fits; on a phone the sentence keeps its own, whole.
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            state
                            presses
                        }
                        VStack(alignment: .trailing, spacing: 3) {
                            state
                            presses
                        }
                    }
                }
            }
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.trailing)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    @ViewBuilder private var state: some View {
        if let error = held.error {
            Text(MachineSetupCopy.heldFailed(why: error))
                .foregroundStyle(.red)
        } else {
            Text(MachineSetupCopy.heldWaiting(machine: machine))
        }
    }

    private var presses: some View {
        HStack(spacing: 8) {
            if held.error != nil { press(MachineSetupCopy.HELD_TRY_AGAIN, onRetry) }
            press(MachineSetupCopy.HELD_WITHDRAW, onWithdraw)
        }
    }

    private func press(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
    }
}

/// The first line of a conversation that made its workspace (rule 8): what was made, where, and the two
/// ways to change it. Having said that is what lets the send ask nothing more first.
struct CreatedWorkspaceLineView: View {
    @Environment(AppModel.self) private var app
    let line: CreatedWorkspaceLine
    let console: ConsoleModel

    @State private var renaming = false
    @State private var draft = ""
    @State private var showSettings = false

    /// Where the clone stands, from the detail's cloneState and what the stream said since (`WorkspaceClone.now`). Nil
    /// for a workspace that was not cloned from GitHub.
    private var clone: CloneHeard? {
        guard line.cloneState != nil else { return nil }
        return WorkspaceClone.now(stored: line.cloneState, live: app.cloneLedger.heard(line.workspaceID),
                                  storedAt: console.madeWorkspaceReadAt)
    }

    var body: some View {
        if let clone, let repository = line.repository, line.live, clone.state != .ready {
            CloneStatusLineView(line: line, repository: repository, clone: clone, showSettings: $showSettings)
                .sheet(isPresented: $showSettings) {
                    if let agents = app.agents, let agent = agents.agent(line.workspaceID) {
                        AgentSettingsSheet(agents: agents, agent: agent)
                    }
                }
        } else {
            created
        }
    }

    private var created: some View {
        VStack(spacing: 2) {
            // All on one line where it fits; a path that doesn't goes under it, whole, rather than
            // breaking at one of its slashes.
            ViewThatFits(in: .horizontal) {
                Text(madeAndWhere)
                VStack(spacing: 0) {
                    Text(made)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    if let path = line.path {
                        Text(path)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }
            // A workspace cloned from GitHub names its repository, a link to it there.
            if let repository = line.repository, let url = URL(string: "https://github.com/\(repository)") {
                Link(destination: url) {
                    HStack(spacing: 3) {
                        GithubMark()
                        Text(repository)
                    }
                }
                .foregroundStyle(Color.accentColor)
            }
            if line.live {
                HStack(spacing: 5) {
                    Button(MachineSetupCopy.CREATED_RENAME) {
                        draft = line.name
                        renaming = true
                    }
                    Text(verbatim: "·")
                    Button(MachineSetupCopy.CREATED_SETTINGS) { showSettings = true }
                        .disabled(app.agents?.agent(line.workspaceID) == nil)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
            }
        }
        .font(.orbitLabel)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("created-workspace")
        .alert(MachineSetupCopy.CREATED_RENAME_LABEL, isPresented: $renaming) {
            TextField(MachineSetupCopy.CREATED_RENAME_LABEL, text: $draft)
            Button("Save") {
                Task {
                    await console.renameCreatedWorkspace(draft)
                    await app.agents?.load()
                }
            }
            .keyboardShortcut(.defaultAction)
            Button("Cancel", role: .cancel) {}
        }
        .sheet(isPresented: $showSettings) {
            if let agents = app.agents, let agent = agents.agent(line.workspaceID) {
                AgentSettingsSheet(agents: agents, agent: agent)
            }
        }
    }

    private var made: AttributedString {
        var name = AttributedString(line.name)
        name.inlinePresentationIntent = .stronglyEmphasized
        return AttributedString("\(MachineSetupCopy.CREATED_WORKSPACE) ") + name
            + AttributedString(" \(MachineSetupCopy.CREATED_ON) \(line.machine)")
    }

    private var madeAndWhere: AttributedString {
        line.path.map { made + AttributedString(" · \($0)") } ?? made
    }
}

/// The same first line while a GitHub workspace's clone has not finished (board 01, P5), the port of web's
/// `CloneStatusLine`: Cloning with git's percentage, or why it failed with the way out — Retry always
/// (POST /workspaces/:id/clone/retry), and before it what the reason asks for: the App installed again, GitHub connected
/// again, or the workspace's settings for a folder already taken.
struct CloneStatusLineView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    let line: CreatedWorkspaceLine
    let repository: String
    let clone: CloneHeard
    @Binding var showSettings: Bool

    @State private var retrying = false

    private var failure: CloneFailure? { clone.state == .failed ? WorkspaceClone.failureOf(line.cloneError) : nil }

    var body: some View {
        Group {
            if let failure {
                failed(failure)
            } else {
                running
            }
        }
        .font(.orbitLabel)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("created-workspace")
        // Where to install the App again: only asked for when the App is what is missing.
        .task(id: failure) {
            if failure == .appRemoved, app.github == nil { await app.loadGithub() }
        }
    }

    private var running: some View {
        VStack(spacing: 4) {
            HStack(spacing: 5) {
                ProgressView().controlSize(.mini)
                Text(clone.state == .cloning ? MachineSetupCopy.CLONE_CLONING : MachineSetupCopy.CLONE_WAITING)
                Text(repository).fontWeight(.semibold).foregroundStyle(.primary)
                Text(MachineSetupCopy.CREATED_ON)
                Text(line.machine).fontWeight(.semibold).foregroundStyle(.primary)
            }
            .lineLimit(1)
            .truncationMode(.middle)
            if let progress = clone.progress {
                HStack(spacing: 6) {
                    ProgressView(value: Double(progress), total: 100)
                        .frame(width: 120)
                        .accessibilityLabel("\(MachineSetupCopy.CLONE_CLONING) \(repository)")
                    Text(verbatim: "\(progress)%").monospacedDigit()
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func failed(_ failure: CloneFailure) -> some View {
        VStack(spacing: 3) {
            // The mark rides inside the reason, so a long reason wraps with it.
            (Text(Image(systemName: "exclamationmark.circle.fill")) + Text(verbatim: " ") + Text(reason(failure)))
                .foregroundStyle(Color.red)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 5) {
                switch failure {
                case .appRemoved:
                    if let installURL = app.github?.installUrl.flatMap(URL.init(string:)) {
                        Link(destination: installURL) {
                            HStack(spacing: 3) {
                                Text(MachineSetupCopy.CLONE_INSTALL_ON_GITHUB)
                                Image(systemName: "arrow.up.right.square")
                            }
                        }
                        Text(verbatim: "·")
                    }
                    retryButton
                case .signInExpired:
                    Button(MachineSetupCopy.CLONE_RECONNECT) { reconnect() }
                    Text(verbatim: "·")
                    retryButton
                case .folderTaken, .other:
                    retryButton
                    Text(verbatim: "·")
                    Button(MachineSetupCopy.CREATED_SETTINGS) { showSettings = true }
                        .disabled(app.agents?.agent(line.workspaceID) == nil)
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
        }
    }

    private func reason(_ failure: CloneFailure) -> String {
        switch failure {
        case .appRemoved: return MachineSetupCopy.cloneAppRemoved(repository: repository)
        case .signInExpired: return MachineSetupCopy.CLONE_SIGN_IN_EXPIRED
        case .folderTaken, .other:
            return MachineSetupCopy.cloneCouldNot(repository: repository, why: WorkspaceClone.reason(line.cloneError))
        }
    }

    private var retryButton: some View {
        Button(MachineSetupCopy.CLONE_RETRY) {
            retrying = true
            Task {
                if let why = await app.retryClone(workspaceID: line.workspaceID) {
                    app.showToast(MachineSetupCopy.CLONE_RETRY_FAILED, detail: why, tone: .error)
                }
                retrying = false
            }
        }
        .disabled(retrying)
    }

    private func reconnect() {
        Task {
            do {
                openURL(try await app.githubSignInURL())
            } catch {
                app.showToast(MachineSetupCopy.setupGithubConnectFailed(why: APIClient.failureReason(error)), tone: .error)
            }
        }
    }
}
