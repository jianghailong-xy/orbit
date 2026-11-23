import Foundation

/// A machine with no workspace: what its first one is made from (docs/first-workspace-contract.md and
/// rules 1–12 of docs/mocks/first-workspace-in-conversation/04-rules). The port of web's
/// `lib/machineSetup.ts`: the setup card, the Set up rows, the landing and the entries read these, so
/// they cannot disagree about which machine is meant or which folder is on offer. Pure: nothing here
/// fetches or stores.

/// A machine as a Set up row names it (rule 9).
public struct MachineToSetUp: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let isManaged: Bool

    public init(id: String, name: String, isManaged: Bool = false) {
        self.id = id
        self.name = name
        self.isManaged = isManaged
    }
}

/// How a checked path reads, and whether it may be used. Rule 4: what isn't there can't be picked; a
/// folder that is not a git repository can, and says what that costs; a repository names its branch.
public struct FolderVerdict: Equatable, Sendable {
    public enum Tone: Equatable, Sendable { case ok, warn, bad }

    public let tone: Tone
    public let text: String
    /// The same, as the folder's line once it is picked: without the "Found".
    public let short: String
    public let usable: Bool
}

/// The folder the card's Create workspace makes the workspace in: one that is there, or one made with it.
public enum PickedFolder: Equatable, Sendable {
    case existing(path: String, note: String)
    case new(name: String, path: String)
    /// A clone of one of the person's GitHub repositories into `<reposRoot>/<name>` (docs/github-workspace-design.md
    /// §5.3).
    case github(GithubPick)

    public var path: String {
        switch self {
        case .existing(let path, _), .new(_, let path): return path
        case .github(let pick): return pick.path
        }
    }

    /// What the workspace's create is told (web `newWorkspaceOf`). An existing folder is sent as the runner
    /// resolved it: a typed `~` is the runner's to expand, and a workspace's workDir is not.
    public var newWorkspace: NewWorkspaceRequest {
        switch self {
        case .existing(let path, _): return NewWorkspaceRequest(workDir: path)
        case .new(let name, _): return NewWorkspaceRequest(newFolder: name)
        case .github(let pick):
            return NewWorkspaceRequest(github: .init(repoId: pick.repoId, ref: pick.ref, folder: pick.name))
        }
    }
}

/// The repository From GitHub picked, and the folder it is cloned into. `ref` nil is the repository's default
/// branch, which `defaultBranch` names.
public struct GithubPick: Equatable, Sendable {
    public let repoId: Int64
    public let repository: String
    public let isPrivate: Bool
    public let defaultBranch: String
    public let ref: String?
    public let name: String
    public let path: String

    public init(repoId: Int64, repository: String, isPrivate: Bool, defaultBranch: String, ref: String?, name: String,
                path: String) {
        self.repoId = repoId
        self.repository = repository
        self.isPrivate = isPrivate
        self.defaultBranch = defaultBranch
        self.ref = ref
        self.name = name
        self.path = path
    }
}

/// The second step's answer for the draft's engine and credential.
public enum SetupCredential: Equatable, Sendable {
    case signedIn
    /// A login that isn't signed in here: `RunnerSignInView`.
    case signIn
    case notInstalled
    /// A key or a pool: nothing to sign in on this machine.
    case onKey(label: String, pool: Bool)

    /// The step is answered.
    public var done: Bool {
        switch self {
        case .signedIn, .onKey: return true
        case .signIn, .notInstalled: return false
        }
    }
}

public enum MachineSetup {
    /// What a runner declares when it answers the directory probe, and when it makes a new folder.
    public static let dirProbeCapability = "dir-probe/v1"
    public static let createWorkDirCapability = "create-workdir/v1"
    /// What a runner declares when it clones a GitHub repository on request (docs/github-workspace-design.md §6).
    public static let cloneWorkDirCapability = "clone-workdir/v1"
    /// What a runner declares when it clones into its home, the directory its reposRoot sits in, rather than reposRoot.
    public static let cloneWorkDirHomeCapability = "clone-workdir/v2"
    /// What a runner declares when it makes a new folder in its home, the directory its reposRoot sits in
    /// (`<home>/orbit-repos`): `newFolder` is then `<home>/<name>` rather than `<reposRoot>/<name>`.
    public static let createWorkDirHomeCapability = "create-workdir/v2"

    /// The directory a runner's new folders go in: its home, the parent of its reposRoot, when it declares
    /// create-workdir/v2, else reposRoot itself (@orbit/shared `newFolderRoot`, as the server joins it). The
    /// separator is the one the root is written with.
    public static func newFolderRoot(reposRoot: String, capabilities: [String]?) -> String {
        capabilities?.contains(createWorkDirHomeCapability) == true ? homeOfReposRoot(reposRoot) : trimReposRoot(reposRoot)
    }

    private static func trimReposRoot(_ reposRoot: String) -> String {
        var root = reposRoot.trimmingCharacters(in: .whitespacesAndNewlines)
        while root.count > 1, root.hasSuffix("/") || root.hasSuffix("\\") { root.removeLast() }
        return root
    }

    /// The directory a reported reposRoot sits in: the machine's home (`<home>/orbit-repos`).
    private static func homeOfReposRoot(_ reposRoot: String) -> String {
        let root = trimReposRoot(reposRoot)
        guard let cut = root.lastIndex(where: { $0 == "/" || $0 == "\\" }) else { return root }
        // `/orbit-repos` sits in `/`, and `C:\orbit-repos` in `C:\`.
        if cut == root.startIndex || root[root.index(before: cut)] == ":" { return String(root[...cut]) }
        return String(root[..<cut])
    }

    /// Where a new folder named on this runner goes, as the server makes it: port of @orbit/shared `newFolderRootFor`,
    /// held to src/shared/src/new-folder-root.fixture.json. A managed runner that is not up, or has not reported yet,
    /// takes its image's home, whatever an earlier process declared; a runner that makes new folders and has reported
    /// its Repos Folder takes `newFolderRoot`; any other makes none (nil).
    public static func newFolderRootFor(managed: Bool, up: Bool, reposRoot: String?, capabilities: [String]?) -> String? {
        if managed, !up || (capabilities?.isEmpty ?? true) { return ManagedRunnerCopy.Setup.home }
        let root = (reposRoot ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !root.isEmpty, capabilities?.contains(createWorkDirCapability) == true else { return nil }
        return newFolderRoot(reposRoot: root, capabilities: capabilities)
    }

    /// The setup card's root: `newFolderRootFor`, the account's managed runner read as managed while it is set up or
    /// asleep. Only a usable card shows or sends it, and a managed runner always has one, so "" is never drawn.
    public static func setupFolderRoot(_ runner: Runner, managedState: ManagedSetupState?) -> String {
        newFolderRootFor(managed: runner.managed == true || managedState != nil, up: runner.online == true,
                         reposRoot: runner.reposRoot, capabilities: runner.capabilities) ?? ""
    }

    public static func uncheckedFolder(name: String, root: String) -> PickedFolder? {
        guard isValidNewFolder(name) else { return nil }
        return .new(name: name, path: newFolderPath(root: root, name: name))
    }

    /// Whether a machine can be asked about a path at all: the capability it declares (§2).
    public static func answersDirProbe(_ runner: Runner) -> Bool {
        runner.capabilities?.contains(dirProbeCapability) == true
    }

    /// Whether it can make a new folder: the capability, and the Repos Folder it goes in (§3.1).
    public static func makesNewFolders(_ runner: Runner) -> Bool {
        runner.capabilities?.contains(createWorkDirCapability) == true
            && !(runner.reposRoot ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Whether a machine clones a GitHub repository on request: it declares clone-workdir/v1 and has reported the
    /// Repos Folder the clone goes in. POST /sessions refuses either missing.
    public static func clonesRepositories(_ runner: Runner) -> Bool { cloneRoot(runner) != nil }

    /// Where a GitHub workspace's clone goes, as the server puts it: port of @orbit/shared `cloneRootFor`, held to
    /// src/shared/src/new-folder-root.fixture.json `clones`. Home on a runner that declares clone-workdir/v2,
    /// reposRoot on an older one, nil on one that does not clone or has not reported its reposRoot.
    public static func cloneRootFor(reposRoot: String?, capabilities: [String]?) -> String? {
        let root = (reposRoot ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !root.isEmpty, let capabilities, capabilities.contains(cloneWorkDirCapability) else { return nil }
        return capabilities.contains(cloneWorkDirHomeCapability) ? homeOfReposRoot(root) : trimReposRoot(root)
    }

    public static func cloneRoot(_ runner: Runner) -> String? {
        cloneRootFor(reposRoot: runner.reposRoot, capabilities: runner.capabilities)
    }

    /// A path as the board writes it: the home folder as `~` (`/Users/austin/orbit-repos/x` → `~/orbit-repos/x`).
    public static func homeShortPath(_ path: String) -> String {
        path.replacingOccurrences(of: #"^(?:/Users/[^/]+|/home/[^/]+|/root)(?=/|$)"#, with: "~", options: .regularExpression)
    }

    /// The folder a repository is cloned into by default, as the server derives it: its name, when that is a folder
    /// name.
    public static func repositoryFolder(_ fullName: String) -> String {
        let name = fullName.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        return isValidNewFolder(name) ? name : ""
    }

    /// The branch a clone is asked for: what was typed under Other branch, unless it is empty or the default.
    public static func cloneRef(typed: String?, defaultBranch: String) -> String? {
        let ref = (typed ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return ref.isEmpty || ref == defaultBranch ? nil : ref
    }

    /// How many repositories the picker shows before anything is typed (board 01, note 4).
    public static let firstRepositories = 8

    /// What From GitHub would pick, on the machine's answer about the folder: only a folder that isn't there yet can
    /// be cloned into.
    public static func githubPick(_ repository: GithubRepository, name: String, ref: String?, reposRoot: String,
                                  probe: DirProbe?) -> PickedFolder? {
        guard isValidNewFolder(name), let probe, (probe.error ?? "").isEmpty, !probe.exists else { return nil }
        return .github(GithubPick(repoId: repository.id, repository: repository.fullName, isPrivate: repository.private,
                                  defaultBranch: repository.defaultBranch, ref: ref, name: name,
                                  path: newFolderPath(root: reposRoot, name: name)))
    }

    /// Whether the card's folder can be checked and made here at all: both of the above.
    public static func checksFolders(_ runner: Runner) -> Bool {
        answersDirProbe(runner) && makesNewFolders(runner)
    }

    /// Whether a machine too old to answer gets there by itself: not one that reports its updater off,
    /// or unable to write where it is installed. One too old to report anything still updates itself.
    public static func updatesItself(_ runner: Runner) -> Bool {
        runner.selfUpdate?.state != "disabledByEnv" && runner.selfUpdate?.state != "dirNotWritable"
    }

    /// A machine approved a moment ago that has not connected yet: never heard from, so it reads offline and has
    /// declared nothing (contract §2). Not one too old to check folders, nor one that went away: it is waited for.
    public static func isConnecting(_ runner: Runner) -> Bool {
        !AgentListLogic.isOnline(runner) && (runner.lastHeartbeatAt ?? "").isEmpty
    }

    /// How often a machine's new session page reads the machine again while its card is up, as the web does
    /// (`SETUP_POLL_MS`): a sign-in landing or the machine going away moves the card by itself. One still connecting
    /// is read more often, so the folder step opens within seconds of its first heartbeat.
    public static let pollSeconds: TimeInterval = 5
    public static let connectingPollSeconds: TimeInterval = 2

    public static func refreshSeconds(for runner: Runner?) -> TimeInterval {
        runner.map(isConnecting) == true ? connectingPollSeconds : pollSeconds
    }

    /// `newFolder`'s rule on the server (§3.1): one path segment, nothing a shell or a path could read
    /// anything into.
    public static func isValidNewFolder(_ name: String) -> Bool {
        guard (1...64).contains(name.unicodeScalars.count), name != ".", name != ".." else { return false }
        return name.unicodeScalars.allSatisfy { scalar in
            switch scalar {
            case "A"..."Z", "a"..."z", "0"..."9", ".", "_", "-": return true
            default: return false
            }
        }
    }

    /// Where a new folder lands: `<root>/<name>`, as the server joins it.
    public static func newFolderPath(root: String, name: String) -> String {
        let separator = root.contains("\\") && !root.contains("/") ? "\\" : "/"
        var root = root
        while root.hasSuffix("/") || root.hasSuffix("\\") { root.removeLast() }
        return root + separator + name
    }

    public static func folderVerdict(_ probe: DirProbe, machine: String) -> FolderVerdict {
        func refused(_ text: String) -> FolderVerdict {
            FolderVerdict(tone: .bad, text: text, short: text, usable: false)
        }
        if let error = probe.error, !error.isEmpty {
            return refused(MachineSetupCopy.setupCouldNotCheck(machine: machine, why: error))
        }
        if !probe.exists { return refused(MachineSetupCopy.setupNoSuchDirectory(machine: machine)) }
        if !probe.isDir { return refused(MachineSetupCopy.setupNotADirectory(machine: machine)) }
        let short = probe.isGit ? MachineSetupCopy.setupGit(branch: probe.branch) : MachineSetupCopy.SETUP_NOT_GIT
        return FolderVerdict(tone: probe.isGit ? .ok : .warn, text: MachineSetupCopy.SETUP_FOUND_PREFIX + short,
                             short: short, usable: true)
    }

    /// What the folder step's name finds at `<root>/<name>`, asked before anything is sent. Nothing there is a new
    /// folder, made as the session starts; a directory is used as it stands, read as any folder is; a file can't
    /// become one.
    public static func newFolderVerdict(_ probe: DirProbe, machine: String) -> FolderVerdict {
        func refused(_ text: String) -> FolderVerdict {
            FolderVerdict(tone: .bad, text: text, short: text, usable: false)
        }
        if let error = probe.error, !error.isEmpty {
            return refused(MachineSetupCopy.setupCouldNotCheck(machine: machine, why: error))
        }
        if !probe.exists {
            return FolderVerdict(tone: .ok, text: MachineSetupCopy.SETUP_NEW_FOLDER_META,
                                 short: MachineSetupCopy.SETUP_NEW_FOLDER_DONE, usable: true)
        }
        if !probe.isDir { return refused(MachineSetupCopy.setupNewFolderIsFile(machine: machine)) }
        return folderVerdict(probe, machine: machine)
    }

    /// What Create workspace makes the workspace in on that answer: a new folder while nothing is there, else the directory that is,
    /// which is then a folder like any other and is sent by its path.
    public static func newFolderPick(_ probe: DirProbe, name: String, root: String, machine: String) -> PickedFolder? {
        let verdict = newFolderVerdict(probe, machine: machine)
        guard verdict.usable else { return nil }
        return probe.exists
            ? .existing(path: probe.path, note: verdict.short)
            : .new(name: name, path: newFolderPath(root: root, name: name))
    }

    /// A folder field's text that names a whole path (`/srv/app`, `~/code/app`) rather than one folder in the machine's
    /// home (docs/mocks/new-workspace-form, decision 2 A; web `isFolderPath`): the machine is asked about that path itself.
    public static func isFolderPath(_ typed: String) -> Bool {
        typed.hasPrefix("/") || typed.hasPrefix("~")
    }

    /// A path's last segment, what the workspace's name follows for a full path (web `folderName`).
    public static func folderName(_ path: String) -> String {
        var trimmed = path
        while trimmed.hasSuffix("/") || trimmed.hasSuffix("\\") { trimmed.removeLast() }
        let last = trimmed.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "/" || $0 == "\\" }).last
        return last.map(String.init).flatMap { $0.isEmpty ? nil : $0 } ?? path
    }

    /// What Create workspace picks on a full path's answer: the directory as it stands. Nothing is made for a path
    /// outside the machine's home, so one that isn't there is refused as any folder is (web `folderPathPick`).
    public static func folderPathPick(_ probe: DirProbe, machine: String) -> PickedFolder? {
        let verdict = folderVerdict(probe, machine: machine)
        return verdict.usable ? .existing(path: probe.path, note: verdict.short) : nil
    }

    /// The path the card's folder field asks the machine about: a full path as typed, a name where it would go, and
    /// nothing for anything else. Nil too where nothing can be asked (a managed runner not up, a machine offline or
    /// too old to check folders).
    public static func folderQuestion(folder: String, root: String, canAsk: Bool) -> String? {
        guard canAsk else { return nil }
        if isFolderPath(folder) { return folder }
        return isValidNewFolder(folder) ? newFolderPath(root: root, name: folder) : nil
    }

    /// What the typed folder would make the workspace in, on the machine's answer about it (`found`). A managed runner
    /// that isn't up takes a name unchecked, but a full path only once it has been checked.
    public static func typedPick(folder: String, found: DirProbe?, root: String, machine: String,
                                 managedState: ManagedSetupState?) -> PickedFolder? {
        let fullPath = isFolderPath(folder)
        if managedState != nil { return fullPath ? nil : uncheckedFolder(name: folder, root: root) }
        guard let found else { return nil }
        if fullPath { return folderPathPick(found, machine: machine) }
        return isValidNewFolder(folder) ? newFolderPick(found, name: folder, root: root, machine: machine) : nil
    }

    /// The folder the workspace's Name follows: the typed name, or a full path's last segment.
    public static func followedName(folder: String) -> String {
        isFolderPath(folder) ? folderName(folder) : folder
    }

    /// The login CLIs installed here, in the app's order.
    public static func installedLogins(_ engines: [RunnerEngineHealth]?) -> [LoginEngine] {
        LoginEngine.allCases.filter { engine in
            engines?.first { $0.engine == engine.rawValue }?.installed == true
        }
    }

    /// Which engine a machine's first draft starts on, with nothing picked: one that can run now, else
    /// one it has, else Claude Code, which is what a machine that has reported nothing yet will have.
    /// A card asking to sign Claude Code in beside a signed-in Codex would ask for what isn't needed.
    public static func firstEngineOn(_ engines: [RunnerEngineHealth]?) -> LoginEngine {
        let installed = installedLogins(engines)
        let running = installed.first { engine in
            engines?.first { $0.engine == engine.rawValue }?.auth == "yes"
        }
        return running ?? installed.first ?? .claude
    }

    /// Whether the runner's own probe says `engine` is signed in. "unknown" is not a yes. Antigravity's
    /// sign-in is its Google account: a yes off a machine's Gemini key is a key, not a sign-in.
    public static func signedIn(_ engine: String, on runner: Runner) -> Bool {
        guard let health = runner.engines?.first(where: { $0.engine == engine }) else { return false }
        return health.auth == "yes" && (engine != "antigravity" || health.authSource == "google")
    }

    /// Rule 5's step for the draft's engine and credential. Nothing reported is not "nothing
    /// installed": a machine that has only just come up says soon.
    public static func credential(runner: Runner, engine: String, provider: ProviderChoice?) -> SetupCredential {
        if let provider, provider.kind == .key || provider.kind == .pool || provider.kind == .opencode {
            return .onKey(label: provider.label, pool: provider.kind == .pool)
        }
        if signedIn(engine, on: runner) { return .signedIn }
        if let engines = runner.engines, engines.first(where: { $0.engine == engine })?.installed != true {
            return .notInstalled
        }
        return .signIn
    }

    /// Rule 5's Use an API Key: the first key or pool that can run here, the draft's own engine's first.
    /// Nil with none, and then the card doesn't offer it: a key is connected on the web.
    public static func firstKey(in engines: [EngineChoice], preferring engine: String) -> EnginePick? {
        let ordered = engines.filter { $0.slug == engine } + engines.filter { $0.slug != engine }
        for row in ordered {
            let key = row.providers.first { ($0.kind == .key || $0.kind == .pool) && $0.unavailable == nil }
            if let key { return EnginePick(engine: row.slug, provider: key.slug) }
        }
        return nil
    }

    /// The line under the card's folder field (web `MachineSetupCard`). `folder` is the field's text trimmed,
    /// `found` the machine's answer about the path `folderQuestion` asked (nil while there is none for it), and
    /// `unanswered` that the machine gave no answer to that question. `pathHintRoot` is set where the card's hint says
    /// a full path is taken too (New workspace on a machine that has one): the directory a name goes in.
    public static func folderLine(folder: String, createError: String?, found: DirProbe?, unanswered: Bool,
                                  machine: String, managedState: ManagedSetupState? = nil,
                                  pathHintRoot: String? = nil) -> SetupFolderLine {
        // Why the last Create workspace was refused stands in for the rest until the next try.
        if let createError { return .createFailed(MachineSetupCopy.setupCreateFailed(why: createError)) }
        if folder.isEmpty {
            guard var root = pathHintRoot else { return .meta(MachineSetupCopy.SETUP_FOLDER_HINT) }
            while root.hasSuffix("/") || root.hasSuffix("\\") { root.removeLast() }
            return .meta(MachineSetupCopy.setupFolderOrPathHint(root: root))
        }
        let fullPath = isFolderPath(folder)
        if !fullPath, !isValidNewFolder(folder) { return .verdict(MachineSetupCopy.SETUP_NEW_FOLDER_INVALID, .bad) }
        if managedState != nil, fullPath { return .meta(MachineSetupCopy.setupPathUnchecked(machine: machine)) }
        if let state = managedState {
            return .meta(state == .preparing ? ManagedRunnerCopy.Setup.FolderUnchecked.preparing : ManagedRunnerCopy.Setup.FolderUnchecked.asleep)
        }
        if let found {
            // A full path must already be there: it says what it found, or that nothing is.
            if fullPath {
                let verdict = folderVerdict(found, machine: machine)
                return .verdict(verdict.text, verdict.tone)
            }
            let verdict = newFolderVerdict(found, machine: machine)
            // Nothing there yet reads as a note; anything there says what it is, and so does a check that failed.
            if !found.exists, verdict.usable { return .meta(MachineSetupCopy.SETUP_NEW_FOLDER_WITH_WORKSPACE) }
            return .verdict(verdict.text, verdict.tone)
        }
        return unanswered ? .noAnswer : .checking
    }

    /// Create workspace can be pressed: the folder has an answer to make it in, the workspace a name, and the
    /// machine is here and can check and make folders, with no create already out.
    public static func canCreate(pick: PickedFolder?, name: String, online: Bool, checksFolders: Bool,
                                 creating: Bool, managedState: ManagedSetupState? = nil) -> Bool {
        pick != nil && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (managedState != nil || (online && checksFolders))
            && !creating
    }

    /// POST /workspaces for the card's Create workspace: the workspace alone, under its name, on the machine,
    /// in the folder picked (`workDir` for one that is there, `newFolder` for one made with it).
    public static func createRequest(folder: PickedFolder, name: String, runnerID: String) -> CreateAgentRequest {
        let target = folder.newWorkspace
        return CreateAgentRequest(name: name.trimmingCharacters(in: .whitespacesAndNewlines), runnerId: runnerID,
                                  workDir: target.workDir, newFolder: target.newFolder, github: target.github)
    }
}

/// What the line under the card's folder field says.
public enum SetupFolderLine: Equatable, Sendable {
    /// A note in the secondary colour.
    case meta(String)
    /// What the machine found, or what is wrong, in its tone.
    case verdict(String, FolderVerdict.Tone)
    /// Couldn't create the workspace: why. Drawn as a bad verdict.
    case createFailed(String)
    /// The machine didn't answer: said with Check again.
    case noAnswer
    /// Asked, and waiting for the answer.
    case checking
}

/// The card's Name (owner 2026-11-16): the folder's until it is edited, and from then on what was typed, emptied
/// included, never filled again from the folder. Any text goes; it is sent trimmed.
public struct WorkspaceNameField: Equatable, Sendable {
    /// What was typed into the field; nil while it follows the folder.
    public private(set) var edited: String?

    public init(edited: String? = nil) {
        self.edited = edited
    }

    /// The field's text took `text`. A field writing back the folder's own text while it follows it (a platform
    /// text field may on focus or submit) is no edit.
    public mutating func edit(_ text: String, folder: String) {
        if edited == nil, text == folder { return }
        edited = text
    }

    /// What the field shows: `folder` is the folder field's text trimmed.
    public func shown(folder: String) -> String { edited ?? folder }

    /// The name sent.
    public func name(folder: String) -> String {
        shown(folder: folder).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Edited down to nothing: the workspace has no name to be made with.
    public func missing(folder: String) -> Bool { edited != nil && name(folder: folder).isEmpty }

    public static func placeholder(folder: String) -> String {
        folder.isEmpty ? MachineSetupCopy.SETUP_NAME_PLACEHOLDER : folder
    }

    /// The line under it, and whether it is a refusal.
    public func line(folder: String) -> (text: String, bad: Bool) {
        if missing(folder: folder) { return (MachineSetupCopy.SETUP_NAME_EMPTY, true) }
        return (edited != nil ? MachineSetupCopy.SETUP_NAME_EDITED : MachineSetupCopy.SETUP_NAME_HINT, false)
    }
}

/// The first line of a conversation that made its workspace (rule 8): what was made, where, and the
/// two ways to change it. Having said that is what lets the send ask nothing more first.
public struct CreatedWorkspaceLine: Equatable, Sendable {
    public let workspaceID: String
    public let name: String
    public let machine: String
    public let path: String?
    /// A workspace deleted since is still what this conversation made; it just has nothing to change.
    public let live: Bool
    /// A workspace cloned from GitHub (docs/github-workspace-design.md §8): its `owner/name`, and where its clone
    /// stood when the detail was read (`cloneError` is why it failed).
    public let repository: String?
    public let cloneState: String?
    public let cloneError: String?

    public init(workspaceID: String, name: String, machine: String, path: String?, live: Bool,
                repository: String? = nil, cloneState: String? = nil, cloneError: String? = nil) {
        self.workspaceID = workspaceID
        self.name = name
        self.machine = machine
        self.path = path
        self.live = live
        self.repository = repository
        self.cloneState = cloneState
        self.cloneError = cloneError
    }
}

/// How the directory probe relay is read (contract §2): ask, then read until the runner has answered or
/// the time is up. A question rides a heartbeat, half a minute away at worst, and a runner restarting
/// mid-question never answers it. One question at a time per machine: a newer one replaces this, the
/// read says `idle`, and there is nothing more to wait for.
public enum DirProbeRelay {
    public static let pollSeconds: TimeInterval = 1.5
    public static let waitSeconds: TimeInterval = 75

    public enum Outcome: Equatable, Sendable {
        case answered(DirProbe)
        /// The question was replaced, or a stored answer was all there was to read.
        case replaced
        case unanswered
    }

    /// `ask` is nil where only what is stored can be read, which is all an offline machine gives.
    public static func probe(ask: (() async throws -> Void)?,
                             read: () async throws -> DirProbeAnswer,
                             sleep: (TimeInterval) async throws -> Void,
                             now: () -> Date = Date.init) async throws -> Outcome {
        try await ask?()
        let deadline = now().addingTimeInterval(waitSeconds)
        while true {
            let answer = try await read()
            if answer.status == "done", let result = answer.result { return .answered(result) }
            if answer.status != "pending" { return .replaced }
            if now() >= deadline { return .unanswered }
            try await sleep(pollSeconds)
        }
    }
}
