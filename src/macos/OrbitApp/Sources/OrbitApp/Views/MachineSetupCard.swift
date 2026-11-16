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
        .onChange(of: app.managedRunner?.status) { _, _ in adopt() }
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
        .onChange(of: welcome && (setup.online || setup.managedState != nil), initial: true) { _, now in draft.welcomes = now }
        // Both steps done with a message waiting: it goes by itself (rule 6).
        .onChange(of: Send(ready: ready, held: setup.state.held, busy: draft.sending), initial: true) { _, _ in
            setup.sendHeldIfReady()
        }
    }
}

/// The card: the machine's name, then the two steps, then what happens when you send.
private struct MachineSetupCard: View {
    @Environment(AppModel.self) private var app
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
            // The card's one question: no step number beside it.
            VStack(alignment: .leading, spacing: 2) { folderStep }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 11)
            Divider()
            step(number: 2, done: setup.managedState != nil ? setup.managedProvider != nil : setup.credential.done) { engineStep }
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
        if let state = setup.managedState {
            return state == .preparing ? ManagedRunnerCopy.Setup.Notice.preparingSend : ManagedRunnerCopy.Setup.Notice.asleep
        }
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
            if setup.managedState == nil, !offline, !(probes && MachineSetup.makesNewFolders(runner)), !MachineSetup.updatesItself(runner) { openMachine }
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
                    Text(folder.path)
                        .font(.orbitMono)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    change { setup.pick(nil) }
                }
                Text(folderNote(folder))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            FolderName(runner: runner, disabled: setup.managedState == nil && (offline || !probes || !MachineSetup.makesNewFolders(runner)), managedState: setup.managedState) { setup.pick($0) }
        }
    }

    private func folderNote(_ folder: PickedFolder) -> String {
        if let state = setup.managedState {
            return state == .preparing ? ManagedRunnerCopy.Setup.FolderPicked.preparing : ManagedRunnerCopy.Setup.FolderPicked.asleep
        }
        switch folder {
        case .existing(_, let note): return note
        case .new: return MachineSetupCopy.SETUP_NEW_FOLDER_DONE
        }
    }

    private var engineName: String { ProviderEngines.cliName(setup.draft.engine) }

    @ViewBuilder private var engineStep: some View {
        if setup.managedState != nil {
            if let provider = setup.managedProvider {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(setup.managedEngineLabel ?? provider).fontWeight(.semibold)
                    Text(LoginEngine(rawValue: provider) != nil
                         ? MachineSetupCopy.setupSignedIn(machine: machine) : ManagedRunnerCopy.Setup.onKey)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                    Spacer(minLength: 4)
                    change { openModels() }
                }
            } else {
                Text(ManagedRunnerCopy.Setup.noEngineTitle).fontWeight(.semibold)
                Text(ManagedRunnerCopy.Setup.noEngineHelp).font(.orbitLabel).foregroundStyle(.secondary)
                Button(ManagedRunnerCopy.Setup.addKey) { openModels(keys: true) }
                    .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(Color.accentColor)
            }
        } else {
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
    }

    private func openModels(keys: Bool = false) {
        #if os(iOS)
        app.push(.settingsPage(keys ? .providers : .machines))
        #else
        app.selectedSection = .runners
        #endif
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
            .disabled(offline && setup.managedState == nil)
    }

    private var foot: some View {
        Group {
            if ready, let folder = setup.state.folder {
                Text(MachineSetupCopy.setupReady(workspace: folder.workspaceName, path: folder.path))
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

/// Step one before it has an answer: one folder name in the machine's home (its Repos Folder on an older runner),
/// which the machine itself checks as it is typed. A folder that is there is used; one that isn't is made.
private struct FolderName: View {
    @Environment(AppModel.self) private var app
    let runner: Runner
    let disabled: Bool
    var managedState: ManagedSetupState? = nil
    let onPick: (PickedFolder) -> Void

    @State private var typed = ""
    /// What the machine said about where the name would go. Nil while there is no answer yet.
    @State private var answer: DirProbeRelay.Outcome?
    /// Check again: the same path asked once more.
    @State private var attempt = 0

    private var machine: String { RunnerPageFormat.displayName(runner) }
    private var root: String {
        if managedState != nil, (runner.reposRoot ?? "").isEmpty { return ManagedRunnerCopy.Setup.reposRoot }
        return MachineSetup.newFolderRoot(runner)
    }
    private var name: String { typed.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var found: DirProbe? {
        guard case .answered(let probe)? = answer else { return nil }
        return probe
    }

    private var candidate: PickedFolder? {
        guard MachineSetup.isValidNewFolder(name) else { return nil }
        if managedState != nil { return .new(name: name, path: MachineSetup.newFolderPath(root: root, name: name)) }
        guard let found else { return nil }
        return MachineSetup.newFolderPick(found, name: name, root: root, machine: machine)
    }

    private struct Question: Equatable {
        let path: String?
        let attempt: Int
    }

    /// The name is asked about where it would go, as it is typed: a folder, or a file, may be there already.
    private var question: String? {
        guard managedState == nil, !disabled, MachineSetup.isValidNewFolder(name) else { return nil }
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
    }

    /// What the name says: what the step does while nothing is typed, then what the machine finds where it would go.
    @ViewBuilder private var line: some View {
        if name.isEmpty {
            meta(MachineSetupCopy.SETUP_FOLDER_HINT)
        } else if !MachineSetup.isValidNewFolder(name) {
            verdictLine(MachineSetupCopy.SETUP_NEW_FOLDER_INVALID, tone: .bad)
        } else if let state = managedState {
            meta(state == .preparing ? ManagedRunnerCopy.Setup.FolderUnchecked.preparing : ManagedRunnerCopy.Setup.FolderUnchecked.asleep)
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

    var body: some View {
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
