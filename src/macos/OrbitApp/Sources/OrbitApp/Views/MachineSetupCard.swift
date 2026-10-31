import SwiftUI
import OrbitKit

// A machine with no workspace (docs/mocks/first-workspace-in-conversation, board 03 and the rules of
// 04): its own new session page, where the engine hero stands for a machine that has one. A card asks
// the two things only the owner can answer, the folder sessions may read and change and the coding CLI
// they run on; what is sent before both are done waits under it; and the first message makes the
// workspace. The web's MachineSetupCard, iOS-ized as the board draws it: grouped options with a tick,
// capsule buttons. The rules are OrbitKit's (`MachineSetup`, `MachineSetupState`).

private enum SetupInk {
    /// The card, off the page behind it in both appearances.
    static let card = Color(light: .white, dark: Color(red: 0.17, green: 0.17, blue: 0.18))
    /// The folder options' grouped band.
    static let options = Color.secondary.opacity(0.1)
    static let found = Color(light: Color(red: 0.102, green: 0.498, blue: 0.216),
                             dark: Color(red: 0.25, green: 0.75, blue: 0.40))
    static let warn = Color(light: Color(red: 0.76, green: 0.443, blue: 0.047),
                            dark: Color(red: 0.95, green: 0.65, blue: 0.25))
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
                try? await Task.sleep(for: .seconds(5))
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
    let setup: MachineSetupModel

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
                        MachineSetupCard(setup: setup, ready: ready)
                        if let held = setup.state.held {
                            HeldFirstMessageView(held: held, machine: RunnerPageFormat.displayName(setup.runner),
                                                 sending: setup.state.sendingHeld,
                                                 onWithdraw: { setup.withdraw() }, onRetry: { setup.retryHeld() })
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

    private var runner: Runner { setup.runner }
    private var machine: String { RunnerPageFormat.displayName(runner) }
    private var offline: Bool { !setup.online }
    private var probes: Bool { MachineSetup.answersDirProbe(runner) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            head
            if let notice { noticeLine(notice) }
            Divider().padding(.top, 12)
            step(number: 1, done: setup.state.folder != nil) { folderStep }
            Divider()
            step(number: 2, done: setup.credential.done) { engineStep }
            Divider()
            foot
        }
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

    /// Why a step can't be done yet: the machine isn't here (rule 1), or it can't be asked about a path.
    private var notice: String? {
        if offline { return MachineSetupCopy.setupOffline(machine: machine) }
        guard !probes else { return nil }
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
            if !offline, !probes, !MachineSetup.updatesItself(runner) { openMachine }
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

    private func step<Content: View>(number: Int, done: Bool, @ViewBuilder content: () -> Content) -> some View {
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
            FolderOptions(runner: runner, disabled: offline || !probes) { setup.pick($0) }
        }
    }

    private func folderNote(_ folder: PickedFolder) -> String {
        switch folder {
        case .existing(_, let note): return note
        case .new: return MachineSetupCopy.SETUP_NEW_FOLDER_DONE
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

/// Step one before it has an answer: the folder `orbit register` ran in when that is a fair suggestion, a
/// new folder, or any other, which the machine itself checks as it is typed (rules 2–4).
private struct FolderOptions: View {
    @Environment(AppModel.self) private var app
    let runner: Runner
    let disabled: Bool
    let onPick: (PickedFolder) -> Void

    /// Untouched, the choice follows what the machine says: its answer about the register directory can
    /// arrive a heartbeat after the card does.
    @State private var touched: FolderChoice?
    @State private var newName = ""
    @State private var typed = ""
    /// What the machine said about the register directory, and about the path typed. Nil while there is
    /// no answer yet.
    @State private var registered: DirProbeRelay.Outcome?
    @State private var typedAnswer: DirProbeRelay.Outcome?
    /// Check again: the same path asked once more.
    @State private var attempt = 0

    private var machine: String { RunnerPageFormat.displayName(runner) }
    private var online: Bool { AgentListLogic.isOnline(runner) }
    private var offersNewFolder: Bool { MachineSetup.makesNewFolders(runner) }
    private var name: String { newName.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var path: String { typed.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The register directory, once the machine has said it is a fair suggestion.
    private var suggested: DirProbe? {
        guard case .answered(let probe)? = registered, MachineSetup.isOfferedFolder(probe) else { return nil }
        return probe
    }

    private var choice: FolderChoice {
        touched ?? MachineSetup.defaultFolderChoice(suggested: suggested, offersNewFolder: offersNewFolder)
    }

    private var checked: DirProbe? {
        guard case .answered(let probe)? = typedAnswer else { return nil }
        return probe
    }

    private var candidate: PickedFolder? {
        switch choice {
        case .suggested:
            return suggested.map {
                .existing(path: $0.path, note: MachineSetup.folderVerdict($0, machine: machine).short)
            }
        case .new:
            guard offersNewFolder, MachineSetup.isValidNewFolder(name) else { return nil }
            return .new(name: name, path: MachineSetup.newFolderPath(reposRoot: runner.reposRoot ?? "", name: name))
        case .other:
            guard let checked else { return nil }
            let verdict = MachineSetup.folderVerdict(checked, machine: machine)
            return verdict.usable ? .existing(path: checked.path, note: verdict.short) : nil
        }
    }

    /// One question at a time per machine (contract §2), so a typed path replaces the register directory's.
    private struct Question: Equatable {
        let path: String?
        let attempt: Int
    }

    var body: some View {
        Text(MachineSetupCopy.SETUP_FOLDER).fontWeight(.semibold)
        Text(MachineSetupCopy.setupFolderHelp(machine: machine))
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        VStack(spacing: 0) {
            if let suggested { suggestedRow(suggested) }
            if offersNewFolder {
                if suggested != nil { Divider().padding(.leading, 36) }
                newFolderRow
            }
            if suggested != nil || offersNewFolder { Divider().padding(.leading, 36) }
            otherRow
        }
        .background(SetupInk.options, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.top, 8)
        .disabled(disabled)
        Button(MachineSetupCopy.SETUP_USE_FOLDER) {
            if let candidate { onPick(candidate) }
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .disabled(candidate == nil || disabled)
        .padding(.top, 9)
        // Offline it can't be asked, and what it last answered is still worth showing.
        .task(id: Question(path: MachineSetup.answersDirProbe(runner) ? MachineSetup.registerDirToProbe(runner.registerDir) : nil,
                           attempt: online ? 1 : 0)) {
            registered = nil
            guard MachineSetup.answersDirProbe(runner), let dir = MachineSetup.registerDirToProbe(runner.registerDir) else { return }
            let outcome = await app.probeDir(runnerID: runner.id, path: dir, ask: online)
            if !Task.isCancelled { registered = outcome }
        }
        // As it is typed, once it has settled.
        .task(id: Question(path: choice == .other && !disabled && !path.isEmpty ? path : nil, attempt: attempt)) {
            typedAnswer = nil
            guard choice == .other, !disabled, !path.isEmpty else { return }
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            let outcome = await app.probeDir(runnerID: runner.id, path: path, ask: true)
            if !Task.isCancelled { typedAnswer = outcome }
        }
    }

    private func row(_ option: FolderChoice, @ViewBuilder _ label: () -> some View) -> some View {
        Button {
            touched = option
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "checkmark")
                    .font(.orbitLabel.weight(.bold))
                    .foregroundStyle(Color.accentColor)
                    .opacity(choice == option ? 1 : 0)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) { label() }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(choice == option ? .isSelected : [])
    }

    private func suggestedRow(_ probe: DirProbe) -> some View {
        let verdict = MachineSetup.folderVerdict(probe, machine: machine)
        return row(.suggested) {
            Text(probe.path)
                .font(.orbitMono)
                .lineLimit(1)
                .truncationMode(.middle)
            verdictLine(verdict.text, tone: verdict.tone)
            Text(MachineSetupCopy.SETUP_REGISTER_DIR)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
        }
    }

    private var newFolderRow: some View {
        VStack(alignment: .leading, spacing: 0) {
            row(.new) {
                Text(MachineSetupCopy.SETUP_NEW_FOLDER).foregroundStyle(.primary)
                if choice == .new, !name.isEmpty, !MachineSetup.isValidNewFolder(name) {
                    verdictLine(MachineSetupCopy.SETUP_NEW_FOLDER_INVALID, tone: .bad)
                } else {
                    Text(MachineSetupCopy.SETUP_NEW_FOLDER_META)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if choice == .new {
                HStack(spacing: 4) {
                    Text(MachineSetup.newFolderPath(reposRoot: runner.reposRoot ?? "", name: ""))
                        .font(.orbitMono)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                    field(MachineSetupCopy.SETUP_NEW_FOLDER_NAME, text: Binding(get: { newName }, set: {
                        // Typing here is a choice, which a late answer about the register directory
                        // must not undo.
                        touched = .new
                        newName = $0
                    }))
                    .accessibilityLabel(MachineSetupCopy.SETUP_NEW_FOLDER)
                }
                .padding(.leading, 36)
                .padding(.trailing, 10)
                .padding(.bottom, 8)
            }
        }
    }

    private var otherRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            row(.other) {
                Text(MachineSetupCopy.setupOtherFolder(machine: machine)).foregroundStyle(.primary)
            }
            if choice == .other {
                VStack(alignment: .leading, spacing: 3) {
                    field("/path/to/project", text: $typed)
                        .accessibilityLabel(MachineSetupCopy.setupOtherFolder(machine: machine))
                    typedVerdict
                }
                .padding(.leading, 36)
                .padding(.trailing, 10)
                .padding(.bottom, 8)
            }
        }
    }

    @ViewBuilder private var typedVerdict: some View {
        if !path.isEmpty {
            if let checked {
                let verdict = MachineSetup.folderVerdict(checked, machine: machine)
                verdictLine(verdict.text, tone: verdict.tone)
            } else if typedAnswer != nil {
                HStack(spacing: 6) {
                    verdictLine(MachineSetupCopy.setupNoAnswer(machine: machine), tone: .bad)
                    Button(MachineSetupCopy.SETUP_CHECK_AGAIN) { attempt += 1 }
                        .buttonStyle(.plain)
                        .font(.orbitLabel)
                        .foregroundStyle(Color.accentColor)
                }
            } else {
                Text(MachineSetupCopy.setupChecking(machine: machine))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
            }
        }
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
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if sending {
                    Text(MachineSetupCopy.HELD_SENDING)
                } else if let error = held.error {
                    Text(MachineSetupCopy.heldFailed(why: error))
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                    press(MachineSetupCopy.HELD_TRY_AGAIN, onRetry)
                    press(MachineSetupCopy.HELD_WITHDRAW, onWithdraw)
                } else {
                    Text(MachineSetupCopy.heldWaiting(machine: machine))
                        .fixedSize(horizontal: false, vertical: true)
                    press(MachineSetupCopy.HELD_WITHDRAW, onWithdraw)
                }
            }
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.trailing)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
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
            Text(words)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
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

    private var words: AttributedString {
        var name = AttributedString(line.name)
        name.inlinePresentationIntent = .stronglyEmphasized
        var said = AttributedString("\(MachineSetupCopy.CREATED_WORKSPACE) ") + name
            + AttributedString(" \(MachineSetupCopy.CREATED_ON) \(line.machine)")
        if let path = line.path { said += AttributedString(" · \(path)") }
        return said
    }
}
