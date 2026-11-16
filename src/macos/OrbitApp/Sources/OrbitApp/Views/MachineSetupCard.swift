import SwiftUI
import OrbitKit

// A machine with no workspace (docs/mocks/new-folder-in-home/workspace-card-with-name, owner 2026-11-16):
// its own new session page, which the setup card fills alone. The card makes the machine's first
// workspace from a folder and a name, with Create workspace beside the name; signing in a coding CLI is
// left to the new workspace's sessions. The web's MachineSetupCard, iOS-ized: capsule buttons. The rules
// are OrbitKit's (`MachineSetup`, `WorkspaceNameField`).

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
/// runner updating itself or a machine coming back moves the card by itself.
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
                // More often while it is still connecting: its first heartbeat opens the folder field.
                try? await Task.sleep(for: .seconds(MachineSetup.refreshSeconds(for: runner)))
            }
        }
        .onChange(of: runner, initial: true) { _, _ in adopt() }
        .onChange(of: setup == nil) { _, _ in adopt() }
        .onChange(of: bare) { _, _ in adopt() }
        // The machine got a workspace some other way, or from a create still being settled: the page
        // moves on to it once nothing of its own is out.
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
        setup?.adopt(runner: runner, bare: bare)
    }
}

/// The page is the card alone (owner 2026-11-16): no composer under it, and nothing waiting there.
private struct MachineDraftContent: View {
    @Environment(AppModel.self) private var app
    let setup: MachineSetupModel

    /// A new account's bare machine: the card greets it (web `machineWelcome`).
    private var welcome: Bool { app.newAccount == true && setup.bare }

    var body: some View {
        ScrollView {
            MachineSetupCard(setup: setup, welcome: welcome)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
                .padding(14)
        }
        #if os(iOS)
        .scrollDismissesKeyboard(.interactively)   // swipe the card to lower the keyboard
        #endif
        // A new account's first machine wears the welcome card's head (docs/mocks/new-user-onboarding):
        // read whether it is one as the page appears, as the web's query does.
        .task { await app.readNewAccount() }
    }
}

/// The card (docs/mocks/new-folder-in-home/workspace-card-with-name): the machine's first workspace, made
/// from one folder name in the machine's home (its Repos Folder on an older runner), which the machine checks
/// as it is typed, and a name that follows the folder's until it is edited. Signing in a coding CLI is not
/// asked here: the new workspace's sessions ask for it where they need it.
private struct MachineSetupCard: View {
    @Environment(AppModel.self) private var app
    let setup: MachineSetupModel
    /// A new account's first machine (docs/mocks/new-user-onboarding): the welcome card's head in place
    /// of "New workspace on <machine>".
    var welcome = false

    /// What the machine said about where the folder would go, for the path it was asked.
    @State private var answer: Answer?
    /// Check again: the same path asked once more.
    @State private var attempt = 0

    private struct Answer: Equatable {
        let path: String
        let outcome: DirProbeRelay.Outcome
    }

    private struct Question: Equatable {
        let path: String?
        let attempt: Int
    }

    private var runner: Runner { setup.runner }
    private var machine: String { RunnerPageFormat.displayName(runner) }
    private var offline: Bool { !setup.online }
    private var checksFolders: Bool { MachineSetup.checksFolders(runner) }
    /// Nothing can be checked or made here yet: the notice says why.
    private var managedState: ManagedSetupState? { ManagedRunnerLogic.managedSetupState(runnerID: runner.id, status: app.managedRunner?.status) }
    private var disabled: Bool { managedState == nil && (offline || !checksFolders) }
    private var root: String { MachineSetup.setupFolderRoot(runner, managedState: managedState) }
    private var folder: String { setup.folder }

    /// The folder is asked about where it would go, as it is typed: a folder, or a file, may be there already.
    private var question: String? {
        guard managedState == nil, !disabled, MachineSetup.isValidNewFolder(folder) else { return nil }
        return MachineSetup.newFolderPath(root: root, name: folder)
    }

    /// The answer to the question standing now; one to an earlier name is no answer to this one.
    private var current: DirProbeRelay.Outcome? {
        guard let answer, let question, answer.path == question else { return nil }
        return answer.outcome
    }

    private var found: DirProbe? {
        guard case .answered(let probe)? = current else { return nil }
        return probe
    }

    private var candidate: PickedFolder? {
        if managedState != nil { return MachineSetup.uncheckedFolder(name: folder, root: root) }
        guard MachineSetup.isValidNewFolder(folder), let found else { return nil }
        return MachineSetup.newFolderPick(found, name: folder, root: root, machine: machine)
    }

    private var canCreate: Bool {
        MachineSetup.canCreate(pick: candidate, name: setup.name.name(folder: folder), online: !offline,
                               checksFolders: checksFolders, creating: setup.creating, managedState: managedState)
    }

    private func create() {
        guard canCreate, let candidate else { return }
        Task { await setup.create(candidate, in: app) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if welcome { WelcomeHead() } else { head }
            if let notice { noticeLine(notice) }
            Divider().padding(.top, 12)
            folderField
                .padding(.top, 11)
            nameField
                .padding(.vertical, 11)
        }
        .setupCardSurface()
        // As it is typed, once it has settled.
        .task(id: Question(path: question, attempt: attempt)) {
            guard let asked = question else { return }
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            let outcome = await app.probeDir(runnerID: runner.id, path: asked, ask: true)
            if !Task.isCancelled { answer = Answer(path: asked, outcome: outcome) }
        }
    }

    private var head: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "desktopcomputer")
                .font(.orbitGlyph)
                .foregroundStyle(Color.accentColor)
                .frame(width: 30, height: 30)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(MachineSetupCopy.setupNewWorkspaceTitle(machine: machine))
                    .font(.headline)
                Text(MachineSetupCopy.setupNewWorkspaceLead(machine: machine))
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Why nothing can be checked yet: the machine isn't here, or it can't be asked about a path. Never heard
    /// from is a machine still coming up, not one gone away, nor one too old to check folders.
    private var notice: String? {
        if let state = managedState {
            return state == .preparing ? ManagedRunnerCopy.Setup.Notice.preparing : ManagedRunnerCopy.Setup.Notice.asleep
        }
        if offline {
            return MachineSetup.isConnecting(runner) ? MachineSetupCopy.setupConnectingCreate(machine: machine)
                : MachineSetupCopy.setupOfflineCreate(machine: machine)
        }
        guard !checksFolders else { return nil }
        return MachineSetup.updatesItself(runner)
            ? MachineSetupCopy.setupUpdatingCreate(machine: machine)
            : MachineSetupCopy.setupNeedsUpdate(machine: machine)
    }

    private func noticeLine(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(text)
                .font(.orbitLabel)
                .foregroundStyle(SetupInk.warn)
                .fixedSize(horizontal: false, vertical: true)
            if managedState == nil, !offline, !checksFolders, !MachineSetup.updatesItself(runner) { openMachine }
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

    // MARK: the folder

    private var folderField: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(MachineSetupCopy.SETUP_FOLDER).fontWeight(.semibold)
            HStack(spacing: 4) {
                Text(MachineSetup.newFolderPath(root: root, name: ""))
                    .font(.orbitMono)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                TextField(MachineSetupCopy.SETUP_NEW_FOLDER_NAME,
                          text: Binding(get: { setup.typed }, set: { setup.typed = $0 }))
                    .textFieldStyle(.roundedBorder)
                    .font(.orbitMono)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .onSubmit { create() }
                    .accessibilityLabel(MachineSetupCopy.SETUP_FOLDER)
            }
            .disabled(disabled || setup.creating)
            folderLine
        }
    }

    /// What the folder says: what the field does while nothing is typed, then what the machine finds where it
    /// would go; or, after a refused Create workspace, why.
    @ViewBuilder private var folderLine: some View {
        switch MachineSetup.folderLine(folder: folder, createError: setup.createError, found: found,
                                       unanswered: current != nil && found == nil, machine: machine, managedState: managedState) {
        case .meta(let text):
            meta(text)
        case .verdict(let text, let tone):
            verdictLine(text, tone: tone)
        case .createFailed(let text):
            verdictLine(text, tone: .bad)
        case .noAnswer:
            noAnswer { attempt += 1 }
        case .checking:
            Text(MachineSetupCopy.setupChecking(machine: machine))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: the name

    private var nameField: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(MachineSetupCopy.SETUP_NAME).fontWeight(.semibold)
            HStack(spacing: 8) {
                // The folder's until it is edited; from then on what was typed, emptied included.
                TextField(WorkspaceNameField.placeholder(folder: folder),
                          text: Binding(get: { setup.name.shown(folder: folder) },
                                        set: { setup.name.edit($0, folder: folder) }))
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { create() }
                    .accessibilityLabel(MachineSetupCopy.SETUP_NAME)
                    .disabled(disabled || setup.creating)
                Button(action: create) {
                    HStack(spacing: 6) {
                        if setup.creating { ProgressView().controlSize(.mini) }
                        Text(MachineSetupCopy.SETUP_CREATE)
                    }
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .fontWeight(.semibold)
                .disabled(!canCreate)
            }
            let line = setup.name.line(folder: folder)
            if line.bad { verdictLine(line.text, tone: .bad) } else { meta(line.text) }
        }
    }

    // MARK: lines

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
