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

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public enum FolderChoice: String, Equatable, Sendable {
    case suggested, new, other
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

/// The folder step's answer, once the person has pressed Use This Folder.
public enum PickedFolder: Equatable, Sendable {
    case existing(path: String, note: String)
    case new(name: String, path: String)

    public var path: String {
        switch self {
        case .existing(let path, _), .new(_, let path): return path
        }
    }

    /// What POST /sessions is told. An existing folder is sent as the runner resolved it: a typed `~`
    /// is the runner's to expand, and a workspace's workDir is not.
    public var newWorkspace: NewWorkspaceRequest {
        switch self {
        case .existing(let path, _): return NewWorkspaceRequest(workDir: path)
        case .new(let name, _): return NewWorkspaceRequest(newFolder: name)
        }
    }

    /// The workspace it makes, as the server names it (§3.2).
    public var workspaceName: String {
        switch self {
        case .existing(let path, _): return MachineSetup.folderName(path)
        case .new(let name, _): return name
        }
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

    /// Whether the directory `orbit register` ran in is worth asking about: the two answers a path can
    /// give on its face are left unasked. Nil when there is nothing to ask.
    public static func registerDirToProbe(_ registerDir: String?) -> String? {
        var dir = (registerDir ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        while dir.count > 1, dir.hasSuffix("/") { dir.removeLast() }
        return dir.isEmpty || dir == "~" || dir == "/" ? nil : dir
    }

    /// Rule 2: a checked register directory is offered only when it is a folder that exists and is
    /// neither the home directory nor the root. The installer runs where the terminal stands, which is
    /// usually home, and all of home is no default.
    public static func isOfferedFolder(_ probe: DirProbe?) -> Bool {
        guard let probe else { return false }
        return (probe.error ?? "").isEmpty && probe.exists && probe.isDir && !probe.isHome && probe.path != "/"
    }

    /// Rule 2 again: the register directory leads when it is a git repository; otherwise a new folder.
    /// The rest is what a machine that can't make one leaves.
    public static func defaultFolderChoice(suggested: DirProbe?, offersNewFolder: Bool) -> FolderChoice {
        if suggested?.isGit == true { return .suggested }
        if offersNewFolder { return .new }
        return suggested != nil ? .suggested : .other
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

    /// Whether a machine too old to answer gets there by itself: not one that reports its updater off,
    /// or unable to write where it is installed. One too old to report anything still updates itself.
    public static func updatesItself(_ runner: Runner) -> Bool {
        runner.selfUpdate?.state != "disabledByEnv" && runner.selfUpdate?.state != "dirNotWritable"
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

    /// Where a new folder lands: `<reposRoot>/<name>`, as the server joins it.
    public static func newFolderPath(reposRoot: String, name: String) -> String {
        let separator = reposRoot.contains("\\") && !reposRoot.contains("/") ? "\\" : "/"
        var root = reposRoot
        while root.hasSuffix("/") || root.hasSuffix("\\") { root.removeLast() }
        return root + separator + name
    }

    /// The workspace name a folder gives, as the server derives it (§3.2): its last segment.
    public static func folderName(_ path: String) -> String {
        path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
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

    /// Rule 5's Use X instead: the other sign-ins installed here, among the engines these apps draw.
    public static func otherEngines(on runner: Runner, than engine: String, fleet: [Runner]?) -> [LoginEngine] {
        installedLogins(runner.engines).filter {
            $0.rawValue != engine && ProviderEngines.appleShowsEngine($0.rawValue, runners: fleet)
        }
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

    /// Rule 1 and §3: both steps are done and the machine is here, so the next send makes the workspace.
    public static func isReady(bare: Bool, folder: PickedFolder?, online: Bool, credential: SetupCredential) -> Bool {
        bare && folder != nil && online && credential.done
    }
}

extension Agent {
    /// What a machine's first draft stands on. The composer's engine, model and account pickers read a
    /// workspace, and a machine with none has a name and a runner to give them, and no id: the session's
    /// create names the machine and a folder instead (`ConsoleModel.draftRequest`).
    public static func machineDraft(runnerID: String, name: String, engine: LoginEngine) -> Agent {
        let row = ["id": "", "name": name, "runnerId": runnerID, "lastProvider": engine.rawValue,
                   "lastEngine": engine.rawValue]
        // Can't fail: a row needs an `id` and a `name`, and has them.
        return try! JSONDecoder().decode(Agent.self, from: JSONEncoder().encode(row))
    }

    public var standsInForMachine: Bool { id.isEmpty }
}

/// The first message, waiting for a machine's two steps (rule 6). What a send needs and nothing that
/// dies with the page: files are on the control plane already, so they wait as their ids, with what
/// their chips draw when the message is taken back.
public struct HeldMessage: Equatable, Sendable {
    public struct Attachment: Equatable, Sendable {
        public let id: String
        public let filename: String
        public let mimeType: String
        public let byteCount: Int
        public let preview: Data?

        public init(id: String, filename: String, mimeType: String, byteCount: Int, preview: Data? = nil) {
            self.id = id
            self.filename = filename
            self.mimeType = mimeType
            self.byteCount = byteCount
            self.preview = preview
        }
    }

    public let content: String
    public let shell: Bool
    public let attachments: [Attachment]
    /// Why the last send of it was refused: it waits for the person, not for another try by itself.
    public var error: String?

    public init(content: String, shell: Bool = false, attachments: [Attachment] = [], error: String? = nil) {
        self.content = content
        self.shell = shell
        self.attachments = attachments
        self.error = error
    }
}

/// What a composer's send does on a machine's new session page.
public enum MachineSend: Equatable, Sendable {
    /// Not known yet, or on the way to a workspace it turns out to have: nothing to send it with.
    case nothing
    /// One waits at a time, since what is waiting is a session's first message.
    case alreadyWaiting
    /// Not ready: it waits under the card (rule 6) and leaves the composer the way a sent one does.
    case hold
    /// Ready: one request makes the workspace with the session and this message (rule 7).
    case create(NewWorkspaceRequest)
}

/// What a machine's new session page has been told so far: the folder and the message waiting on it.
/// The page is left and come back to on the way (a key is picked elsewhere, a sign-in goes through a
/// browser), and neither answer should have to be given twice.
public struct MachineSetupState: Equatable, Sendable {
    public private(set) var folder: PickedFolder?
    public private(set) var held: HeldMessage?
    /// The message that waited has gone out and has not been answered yet.
    public private(set) var sendingHeld = false

    public init(folder: PickedFolder? = nil, held: HeldMessage? = nil) {
        self.folder = folder
        self.held = held
    }

    public mutating func pick(_ folder: PickedFolder?) {
        self.folder = folder
    }

    /// The composer's send. `bare` is the machine as the workspace list last said, `ready` is
    /// `MachineSetup.isReady`.
    public func send(bare: Bool, ready: Bool) -> MachineSend {
        guard bare else { return .nothing }
        if held != nil { return .alreadyWaiting }
        if ready, let folder { return .create(folder.newWorkspace) }
        return .hold
    }

    public mutating func hold(_ message: HeldMessage) {
        held = message
    }

    /// Both steps done with a message waiting: it goes, with nobody pressing anything (rule 6). Once per
    /// waiting message, because the send makes a workspace: while it is out this answers nil, and a
    /// refusal leaves it waiting on the person (`error`) rather than on another try.
    public mutating func takeHeldToSend(ready: Bool, busy: Bool) -> (message: HeldMessage, folder: NewWorkspaceRequest)? {
        guard ready, !busy, !sendingHeld, let held, held.error == nil, let folder else { return nil }
        sendingHeld = true
        return (held, folder.newWorkspace)
    }

    /// The send of what is waiting was refused: say why, and send nothing more until asked.
    public mutating func failHeld(_ why: String) {
        sendingHeld = false
        held?.error = why
    }

    /// Try again: the next pass sends it.
    public mutating func retryHeld() {
        held?.error = nil
    }

    /// Take it back. What comes out goes back in the composer, the way a queued message's words do.
    /// Nothing comes out while it is on its way: the send has it.
    public mutating func withdraw() -> HeldMessage? {
        guard !sendingHeld else { return nil }
        defer { held = nil }
        return held
    }

    /// That machine has a workspace: nothing of its setup is left to remember.
    public mutating func finish() {
        self = MachineSetupState()
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

    public init(workspaceID: String, name: String, machine: String, path: String?, live: Bool) {
        self.workspaceID = workspaceID
        self.name = name
        self.machine = machine
        self.path = path
        self.live = live
    }

    /// From a session's detail: nil for one that made no workspace, or whose workspace row didn't come.
    public init?(session: Session, machine: String?) {
        guard session.createdWorkspace == true, let workspace = session.agent, let name = workspace.name else {
            return nil
        }
        self.init(workspaceID: workspace.id, name: name, machine: machine ?? "", path: workspace.workDir,
                  live: workspace.deletedAt == nil)
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
