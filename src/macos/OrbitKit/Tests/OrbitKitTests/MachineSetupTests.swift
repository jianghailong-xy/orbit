import Foundation
import XCTest
@testable import OrbitKit

/// The rules of a machine's first workspace, from docs/mocks/first-workspace-in-conversation/04-rules:
/// the same cases as the web's `lib/machineSetup.test.ts`, and the setup card's folder, name and Create
/// workspace (docs/mocks/new-folder-in-home/workspace-card-with-name; web `MachineSetupCard.test.tsx`).
final class MachineSetupTests: XCTestCase {

    private func probe(path: String = "/home/orbit/code/app", exists: Bool = true, isDir: Bool = true,
                       isGit: Bool = true, branch: String? = "main", isHome: Bool = false,
                       error: String? = nil) -> DirProbe {
        DirProbe(path: path, exists: exists, isDir: isDir, isGit: isGit, branch: branch, isHome: isHome,
                 freeBytes: 1024, error: error)
    }

    private func engine(_ name: String, _ auth: String, installed: Bool = true,
                        authSource: String? = nil) -> RunnerEngineHealth {
        RunnerEngineHealth(engine: name, installed: installed, auth: auth, authSource: authSource)
    }

    private func runner(_ json: String) throws -> Runner {
        try JSONDecoder().decode(Runner.self, from: Data(json.utf8))
    }

    private func choice(_ slug: String, _ kind: ProviderChoice.Kind, label: String = "Key") -> ProviderChoice {
        ProviderChoice(slug: slug, label: label, kind: kind, brandKey: nil, modelLabel: "")
    }

    // MARK: what a machine declares

    func testAMachineIsAskedAboutAPathOnlyIfItSaysItAnswers() throws {
        XCTAssertTrue(MachineSetup.answersDirProbe(try runner(#"{"id":"r","name":"m","capabilities":["dir-probe/v1"]}"#)))
        XCTAssertFalse(MachineSetup.answersDirProbe(try runner(#"{"id":"r","name":"m","capabilities":[]}"#)))
        XCTAssertFalse(MachineSetup.answersDirProbe(try runner(#"{"id":"r","name":"m"}"#)))
    }

    func testAMachineMakesANewFolderOnlyIfItSaysSoAndHasReportedWhereTheyGo() throws {
        XCTAssertTrue(MachineSetup.makesNewFolders(try runner(
            #"{"id":"r","name":"m","capabilities":["create-workdir/v1"],"reposRoot":"/home/orbit/orbit-repos"}"#)))
        XCTAssertFalse(MachineSetup.makesNewFolders(try runner(#"{"id":"r","name":"m","capabilities":["create-workdir/v1"]}"#)))
        XCTAssertFalse(MachineSetup.makesNewFolders(try runner(
            #"{"id":"r","name":"m","capabilities":["create-workdir/v1"],"reposRoot":"  "}"#)))
        XCTAssertFalse(MachineSetup.makesNewFolders(try runner(
            #"{"id":"r","name":"m","capabilities":[],"reposRoot":"/home/orbit/orbit-repos"}"#)))
    }

    func testANewFolderGoesInTheReposFolderOnARunnerThatOnlyMakesThemThere() {
        XCTAssertEqual(MachineSetup.newFolderRoot(reposRoot: "/root/orbit-repos", capabilities: ["create-workdir/v1"]),
                       "/root/orbit-repos")
        XCTAssertEqual(MachineSetup.newFolderRoot(reposRoot: "/root/orbit-repos/", capabilities: nil), "/root/orbit-repos")
    }

    func testANewFolderGoesInHomeTheDirectoryTheReposFolderSitsInOnARunnerThatDeclaresV2() {
        let v2 = ["create-workdir/v1", "create-workdir/v2"]
        XCTAssertEqual(MachineSetup.newFolderRoot(reposRoot: "/root/orbit-repos", capabilities: v2), "/root")
        XCTAssertEqual(MachineSetup.newFolderRoot(reposRoot: "/Users/austin/orbit-repos/", capabilities: v2), "/Users/austin")
        XCTAssertEqual(MachineSetup.newFolderRoot(reposRoot: "C:\\Users\\orbit\\orbit-repos", capabilities: v2),
                       "C:\\Users\\orbit")
        XCTAssertEqual(MachineSetup.newFolderRoot(reposRoot: "/orbit-repos", capabilities: v2), "/")
        XCTAssertEqual(MachineSetup.newFolderRoot(reposRoot: "C:\\orbit-repos", capabilities: v2), "C:\\")
    }

    func testAMachinesNewFolderRootIsReadFromWhatItReports() throws {
        XCTAssertEqual(MachineSetup.setupFolderRoot(try runner(
            #"{"id":"r","name":"m","capabilities":["create-workdir/v1","create-workdir/v2"],"reposRoot":"/root/orbit-repos"}"#), managedState: nil), "/root")
        XCTAssertEqual(MachineSetup.setupFolderRoot(try runner(
            #"{"id":"r","name":"m","capabilities":["create-workdir/v1"],"reposRoot":"/root/orbit-repos"}"#), managedState: nil), "/root/orbit-repos")
    }

    func testAMachineTooOldToAnswerGetsThereByItselfUnlessItsUpdaterSaysItCant() throws {
        XCTAssertTrue(MachineSetup.updatesItself(try runner(#"{"id":"r","name":"m"}"#)))
        XCTAssertTrue(MachineSetup.updatesItself(try runner(#"{"id":"r","name":"m","selfUpdate":{"state":"enabled"}}"#)))
        XCTAssertFalse(MachineSetup.updatesItself(try runner(#"{"id":"r","name":"m","selfUpdate":{"state":"disabledByEnv"}}"#)))
        XCTAssertFalse(MachineSetup.updatesItself(try runner(#"{"id":"r","name":"m","selfUpdate":{"state":"dirNotWritable"}}"#)))
    }

    /// What the server reads for a machine whose `orbit run` has not beaten yet (contract §2).
    func testApprovedAndNeverHeardFromAMachineIsStillConnecting() throws {
        XCTAssertTrue(MachineSetup.isConnecting(try runner(#"{"id":"r","name":"m","online":false,"lastHeartbeatAt":null,"capabilities":[]}"#)))
        XCTAssertTrue(MachineSetup.isConnecting(try runner(#"{"id":"r","name":"m","online":false}"#)))
    }

    func testHeardFromOnceAMachineIsOfflineOrOnlineNeverConnecting() throws {
        XCTAssertFalse(MachineSetup.isConnecting(try runner(
            #"{"id":"r","name":"m","online":false,"lastHeartbeatAt":"2026-10-31T09:00:00Z"}"#)))
        XCTAssertFalse(MachineSetup.isConnecting(try runner(
            #"{"id":"r","name":"m","online":true,"lastHeartbeatAt":"2026-10-31T09:00:00Z"}"#)))
        // Online is its own heartbeat's word, whatever else the row has yet to carry.
        XCTAssertFalse(MachineSetup.isConnecting(try runner(#"{"id":"r","name":"m","online":true,"lastHeartbeatAt":null}"#)))
    }

    /// The card's page reads its machine as often as the web's does, and more often while it connects.
    func testTheCardsPageReadsAConnectingMachineMoreOften() throws {
        XCTAssertEqual(MachineSetup.refreshSeconds(for: try runner(#"{"id":"r","name":"m","online":false,"lastHeartbeatAt":null}"#)), 2)
        XCTAssertEqual(MachineSetup.refreshSeconds(for: try runner(
            #"{"id":"r","name":"m","online":true,"lastHeartbeatAt":"2026-10-31T09:00:00Z"}"#)), 5)
        XCTAssertEqual(MachineSetup.refreshSeconds(for: try runner(
            #"{"id":"r","name":"m","online":false,"lastHeartbeatAt":"2026-10-31T09:00:00Z"}"#)), 5)
        XCTAssertEqual(MachineSetup.refreshSeconds(for: nil), 5)
    }

    // MARK: rule 3: a new folder

    func testANewFolderTakesTheNamesTheServerTakes() {
        for good in ["app", "payments-api", "a.b_c-1", ".hidden", String(repeating: "x", count: 64)] {
            XCTAssertTrue(MachineSetup.isValidNewFolder(good), good)
        }
        for bad in ["", ".", "..", "a/b", "a\\b", "with space", "naïve", "~", "app\n",
                    String(repeating: "x", count: 65)] {
            XCTAssertFalse(MachineSetup.isValidNewFolder(bad), bad)
        }
    }

    func testANewFolderLandsUnderTheMachinesReposFolderHoweverThatWasReported() {
        XCTAssertEqual(MachineSetup.newFolderPath(root: "/home/orbit/orbit-repos", name: "app"),
                       "/home/orbit/orbit-repos/app")
        XCTAssertEqual(MachineSetup.newFolderPath(root: "/home/orbit/orbit-repos/", name: "app"),
                       "/home/orbit/orbit-repos/app")
        XCTAssertEqual(MachineSetup.newFolderPath(root: "C:\\Users\\orbit\\orbit-repos", name: "app"),
                       "C:\\Users\\orbit\\orbit-repos\\app")
        XCTAssertEqual(MachineSetup.newFolderPath(root: "/home/orbit/orbit-repos", name: ""),
                       "/home/orbit/orbit-repos/")
    }

    private func inReposFolder(exists: Bool = false, isDir: Bool = false, isGit: Bool = false, branch: String? = nil,
                               error: String? = nil) -> DirProbe {
        probe(path: "/home/orbit/orbit-repos/app", exists: exists, isDir: isDir, isGit: isGit, branch: branch, error: error)
    }

    func testANameWithNothingThereIsANewFolderMadeAsTheSessionStarts() {
        XCTAssertEqual(MachineSetup.newFolderVerdict(inReposFolder(), machine: "orbit@austin"),
                       FolderVerdict(tone: .ok, text: "New folder · created as the session starts.",
                                     short: "new folder · created as the session starts", usable: true))
        XCTAssertEqual(MachineSetup.newFolderPick(inReposFolder(), name: "app", root: "/home/orbit/orbit-repos",
                                                  machine: "orbit@austin"),
                       .new(name: "app", path: "/home/orbit/orbit-repos/app"))
    }

    func testANameThatIsAFolderAlreadyReadsAsAnyFolderAndIsUsedAsThatFolder() {
        let there = inReposFolder(exists: true, isDir: true, isGit: true, branch: "main")
        XCTAssertEqual(MachineSetup.newFolderVerdict(there, machine: "orbit@austin"),
                       FolderVerdict(tone: .ok, text: "Found · git repository · main",
                                     short: "git repository · main", usable: true))
        XCTAssertEqual(MachineSetup.newFolderVerdict(there, machine: "orbit@austin"),
                       MachineSetup.folderVerdict(there, machine: "orbit@austin"))
        XCTAssertEqual(MachineSetup.newFolderPick(there, name: "app", root: "/home/orbit/orbit-repos", machine: "orbit@austin"),
                       .existing(path: "/home/orbit/orbit-repos/app", note: "git repository · main"))
        XCTAssertEqual(MachineSetup.newFolderVerdict(inReposFolder(exists: true, isDir: true), machine: "orbit@austin"),
                       FolderVerdict(tone: .warn,
                                     text: "Found · not a git repository — sessions will share it instead of isolating.",
                                     short: "not a git repository — sessions will share it instead of isolating.",
                                     usable: true))
    }

    func testANewFolderOverAFileCantBeAndSaysWhy() {
        let file = inReposFolder(exists: true)
        let text = "There’s already a file with this name on orbit@austin. Pick another name."
        XCTAssertEqual(MachineSetup.newFolderVerdict(file, machine: "orbit@austin"),
                       FolderVerdict(tone: .bad, text: text, short: text, usable: false))
        XCTAssertNil(MachineSetup.newFolderPick(file, name: "app", root: "/home/orbit/orbit-repos", machine: "orbit@austin"))
    }

    func testANewFolderTheRunnerCouldNotLookAtHasNothingToPick() {
        let failed = inReposFolder(error: "permission denied")
        XCTAssertEqual(MachineSetup.newFolderVerdict(failed, machine: "orbit@austin").text,
                       "Couldn’t check on orbit@austin: permission denied")
        XCTAssertNil(MachineSetup.newFolderPick(failed, name: "app", root: "/home/orbit/orbit-repos", machine: "orbit@austin"))
    }

    // MARK: rule 4: how a checked path reads

    private let machine = "orbit@austin"

    func testAGitRepositoryNamesItsBranch() {
        XCTAssertEqual(MachineSetup.folderVerdict(probe(), machine: machine),
                       FolderVerdict(tone: .ok, text: "Found · git repository · main",
                                     short: "git repository · main", usable: true))
    }

    func testADetachedHeadHasNoBranchToName() {
        XCTAssertEqual(MachineSetup.folderVerdict(probe(branch: nil), machine: machine).text, "Found · git repository")
    }

    func testAFolderThatIsNoRepositoryCanBeUsedAndSaysWhatThatCosts() {
        XCTAssertEqual(MachineSetup.folderVerdict(probe(isGit: false, branch: nil), machine: machine),
                       FolderVerdict(tone: .warn,
                                     text: "Found · not a git repository — sessions will share it instead of isolating.",
                                     short: "not a git repository — sessions will share it instead of isolating.",
                                     usable: true))
    }

    func testWhatIsntThereCantBeUsed() {
        let verdict = MachineSetup.folderVerdict(probe(exists: false, isDir: false, isGit: false), machine: machine)
        XCTAssertEqual(verdict.tone, .bad)
        XCTAssertEqual(verdict.text, "No such directory on orbit@austin.")
        XCTAssertFalse(verdict.usable)
    }

    func testNorAFileNorAPathTheRunnerCouldNotLookAt() {
        let file = MachineSetup.folderVerdict(probe(isDir: false, isGit: false), machine: machine)
        XCTAssertEqual(file.text, "That isn’t a directory on orbit@austin.")
        XCTAssertFalse(file.usable)
        let refused = MachineSetup.folderVerdict(probe(exists: false, error: "permission denied"), machine: machine)
        XCTAssertEqual(refused.text, "Couldn’t check on orbit@austin: permission denied")
        XCTAssertFalse(refused.usable)
    }

    // MARK: what the workspace's create is told

    func testANewFolderGoesByItsNameAnExistingOneByThePathTheRunnerResolved() {
        XCTAssertEqual(PickedFolder.new(name: "app", path: "/home/orbit/orbit-repos/app").newWorkspace,
                       NewWorkspaceRequest(newFolder: "app"))
        XCTAssertEqual(PickedFolder.existing(path: "/home/orbit/code/app", note: "").newWorkspace,
                       NewWorkspaceRequest(workDir: "/home/orbit/code/app"))
    }

    private func body(_ request: CreateAgentRequest) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
    }

    /// POST /workspaces: the workspace alone, under its trimmed name, on the machine, in a folder that is there.
    func testCreateMakesTheWorkspaceInAFolderThatIsThereByItsPath() throws {
        let sent = try body(MachineSetup.createRequest(
            folder: .existing(path: "/home/orbit/app", note: "git repository · main"), name: "  My app  ", runnerID: "r1"))
        XCTAssertEqual(Set(sent.keys), ["name", "runnerId", "workDir"])
        XCTAssertEqual(sent["name"] as? String, "My app")
        XCTAssertEqual(sent["runnerId"] as? String, "r1")
        XCTAssertEqual(sent["workDir"] as? String, "/home/orbit/app")
    }

    /// …and a folder that isn't there yet by its name, made with the workspace.
    func testCreateMakesANewFolderByItsName() throws {
        let sent = try body(MachineSetup.createRequest(folder: .new(name: "app", path: "/home/orbit/app"),
                                                       name: "app", runnerID: "r1"))
        XCTAssertEqual(Set(sent.keys), ["name", "runnerId", "newFolder"])
        XCTAssertEqual(sent["name"] as? String, "app")
        XCTAssertEqual(sent["newFolder"] as? String, "app")
    }

    // MARK: which engine a machine's first draft starts on

    func testOneSignedInBeforeOneThatIsnt() {
        XCTAssertEqual(MachineSetup.firstEngineOn([engine("claude", "no"), engine("codex", "yes")]), .codex)
    }

    func testElseTheFirstItHas() {
        XCTAssertEqual(MachineSetup.firstEngineOn([engine("claude", "no", installed: false), engine("codex", "no")]), .codex)
        XCTAssertEqual(MachineSetup.firstEngineOn([engine("codex", "no"), engine("claude", "no")]), .claude)
    }

    func testElseClaudeCodeOnAMachineThatHasSaidNothing() {
        XCTAssertEqual(MachineSetup.firstEngineOn(nil), .claude)
        XCTAssertEqual(MachineSetup.firstEngineOn([]), .claude)
    }

    func testOnlyWhatSignsInCounts() {
        XCTAssertEqual(MachineSetup.installedLogins([engine("opencode", "unknown"), engine("codex", "no"),
                                                     engine("kimi", "no", installed: false)]), [.codex])
    }

    func testAnAnswerOfUnknownIsNotAYes() {
        XCTAssertEqual(MachineSetup.firstEngineOn([engine("claude", "unknown"), engine("codex", "unknown")]), .claude)
    }

    // MARK: rule 5: the second step

    private func machineRunner(_ engines: [RunnerEngineHealth]?) throws -> Runner {
        var row = try runner(#"{"id":"r","name":"m"}"#)
        row = Runner(id: row.id, name: row.name, status: nil, online: true, version: nil, maxConcurrent: nil,
                     displayName: nil, hostname: nil, labels: nil, enrolledAt: nil, minFreeDiskMb: nil, reposRoot: nil,
                     heartbeatLeaseOwner: nil, heartbeatDraining: nil, skills: nil, commands: nil, activeSessions: nil,
                     lastHeartbeatAt: nil, planUsage: nil, modelCatalog: nil, runtimeDefaultModels: nil, engines: engines,
                     runsAsRoot: nil, install: nil, accountRemove: nil)
        return row
    }

    func testTheStepFollowsTheDraftsEngine() throws {
        let row = try machineRunner([engine("claude", "no"), engine("codex", "yes")])
        XCTAssertEqual(MachineSetup.credential(runner: row, engine: "claude", provider: choice("claude", .login)), .signIn)
        XCTAssertEqual(MachineSetup.credential(runner: row, engine: "codex", provider: choice("codex", .login)), .signedIn)
    }

    func testAKeyOrAPoolHasNothingToSignInOnThisMachine() throws {
        let row = try machineRunner([engine("claude", "no")])
        XCTAssertEqual(MachineSetup.credential(runner: row, engine: "claude", provider: choice("deepseek", .key, label: "DeepSeek")),
                       .onKey(label: "DeepSeek", pool: false))
        XCTAssertEqual(MachineSetup.credential(runner: row, engine: "claude", provider: choice("team", .pool, label: "Team")),
                       .onKey(label: "Team", pool: true))
    }

    func testAnEngineTheMachineDoesntHaveCantBeSignedIn() throws {
        XCTAssertEqual(MachineSetup.credential(runner: try machineRunner([engine("claude", "no")]), engine: "codex",
                                               provider: nil), .notInstalled)
        XCTAssertEqual(MachineSetup.credential(runner: try machineRunner([engine("codex", "no", installed: false)]),
                                               engine: "codex", provider: nil), .notInstalled)
    }

    func testNothingReportedIsNotNothingInstalled() throws {
        XCTAssertEqual(MachineSetup.credential(runner: try machineRunner(nil), engine: "claude", provider: nil), .signIn)
    }

    func testAntigravityOnAMachinesKeyIsNotASignIn() throws {
        let key = try machineRunner([engine("antigravity", "yes", authSource: "env")])
        XCTAssertEqual(MachineSetup.credential(runner: key, engine: "antigravity", provider: nil), .signIn)
        let google = try machineRunner([engine("antigravity", "yes", authSource: "google")])
        XCTAssertEqual(MachineSetup.credential(runner: google, engine: "antigravity", provider: nil), .signedIn)
    }

    private func engineChoice(_ slug: String, _ providers: [ProviderChoice]) -> EngineChoice {
        EngineChoice(slug: slug, label: slug, brandKey: nil, providers: providers, provider: providers.first)
    }

    func testUseAnApiKeyLandsOnAKeyThatCanRunTheDraftsEngineFirst() {
        let claude = engineChoice("claude", [choice("claude", .login), choice("deepseek", .key)])
        let codex = engineChoice("codex", [choice("codex", .login), choice("team", .pool)])
        XCTAssertEqual(MachineSetup.firstKey(in: [claude, codex], preferring: "codex"),
                       EnginePick(engine: "codex", provider: "team"))
        XCTAssertEqual(MachineSetup.firstKey(in: [claude, codex], preferring: "claude"),
                       EnginePick(engine: "claude", provider: "deepseek"))
        XCTAssertEqual(MachineSetup.firstKey(in: [claude, codex], preferring: "kimi"),
                       EnginePick(engine: "claude", provider: "deepseek"), "another engine's key, when this one has none")
    }

    func testAKeyThatCantRunHereIsNotOffered() {
        let spent = ProviderChoice(slug: "deepseek", label: "Key", kind: .key, brandKey: nil, modelLabel: "", unavailable: "No")
        XCTAssertNil(MachineSetup.firstKey(in: [engineChoice("claude", [choice("claude", .login), spent])], preferring: "claude"))
        XCTAssertNil(MachineSetup.firstKey(in: [], preferring: "claude"))
    }

    // MARK: the card: what the folder says

    private func folderLine(_ folder: String, createError: String? = nil, found: DirProbe? = nil,
                            unanswered: Bool = false) -> SetupFolderLine {
        MachineSetup.folderLine(folder: folder, createError: createError, found: found, unanswered: unanswered,
                                machine: "orbit@austin")
    }

    func testNothingTypedSaysWhatTheFieldDoes() {
        XCTAssertEqual(folderLine(""), .meta("Uses this folder if it exists, otherwise creates it."))
    }

    func testANameTheServerWouldRefuseSaysWhy() {
        XCTAssertEqual(folderLine("my app"),
                       .verdict("Use letters, digits, dots, dashes and underscores, up to 64 characters.", .bad))
    }

    func testNothingThereIsANewFolderMadeWithTheWorkspace() {
        XCTAssertEqual(folderLine("app", found: inReposFolder()), .meta("New folder · created with the workspace."))
    }

    func testAFolderThereSaysWhatItIsInItsTone() {
        XCTAssertEqual(folderLine("app", found: inReposFolder(exists: true, isDir: true, isGit: true, branch: "main")),
                       .verdict("Found · git repository · main", .ok))
        XCTAssertEqual(folderLine("app", found: inReposFolder(exists: true, isDir: true)),
                       .verdict("Found · not a git repository — sessions will share it instead of isolating.", .warn))
    }

    func testAFileThereAndACheckThatFailedAreRefusals() {
        XCTAssertEqual(folderLine("app", found: inReposFolder(exists: true)),
                       .verdict("There’s already a file with this name on orbit@austin. Pick another name.", .bad))
        XCTAssertEqual(folderLine("app", found: inReposFolder(error: "permission denied")),
                       .verdict("Couldn’t check on orbit@austin: permission denied", .bad))
    }

    func testNoAnswerYetIsCheckingAndNoneAtAllSaysSo() {
        XCTAssertEqual(folderLine("app"), .checking)
        XCTAssertEqual(folderLine("app", unanswered: true), .noAnswer)
    }

    /// A refused Create workspace says why on the folder's line, over whatever the folder would say.
    func testARefusedCreateSaysWhyInsteadUntilTheNextTry() {
        XCTAssertEqual(folderLine("app", createError: "A workspace with that name exists", found: inReposFolder()),
                       .createFailed("Couldn’t create the workspace: A workspace with that name exists"))
        XCTAssertEqual(folderLine("", createError: "no"), .createFailed("Couldn’t create the workspace: no"))
    }

    // MARK: the card: the name

    func testTheNameFollowsTheFolderUntilItIsEdited() {
        var field = WorkspaceNameField()
        XCTAssertEqual(field.shown(folder: ""), "")
        XCTAssertEqual(field.shown(folder: "app"), "app")
        XCTAssertEqual(field.name(folder: "app"), "app")
        XCTAssertFalse(field.missing(folder: ""), "not edited is not missing: Create waits on the folder")
        XCTAssertEqual(field.line(folder: "app").text, "Same as the folder unless you change it. Shown in the sidebar.")
        XCTAssertFalse(field.line(folder: "app").bad)

        field.edit("My app", folder: "app")
        XCTAssertEqual(field.shown(folder: "app"), "My app")
        XCTAssertEqual(field.shown(folder: "payments"), "My app", "once edited it stays, whatever the folder")
        XCTAssertEqual(field.line(folder: "payments").text, "Shown in the sidebar. You can rename it later.")
    }

    func testANameEditedToNothingStaysEmptyAndSaysSo() {
        var field = WorkspaceNameField()
        field.edit("ap", folder: "app")
        field.edit("", folder: "app")
        XCTAssertEqual(field.shown(folder: "app"), "", "never filled again from the folder")
        XCTAssertEqual(field.shown(folder: "other"), "")
        XCTAssertTrue(field.missing(folder: "app"))
        XCTAssertEqual(field.line(folder: "app").text, "Give the workspace a name.")
        XCTAssertTrue(field.line(folder: "app").bad)
        field.edit("   ", folder: "app")
        XCTAssertTrue(field.missing(folder: "app"), "blank after trimming is no name")
    }

    /// A text field writing back the text it shows, while it follows the folder, has not been edited.
    func testTheFoldersOwnTextWrittenBackIsNoEdit() {
        var field = WorkspaceNameField()
        field.edit("app", folder: "app")
        XCTAssertNil(field.edited)
        XCTAssertEqual(field.shown(folder: "payments"), "payments")
    }

    func testAnyNameGoesAndIsSentTrimmed() {
        var field = WorkspaceNameField()
        field.edit("  Payments (prod) ✨ ", folder: "app")
        XCTAssertEqual(field.name(folder: "app"), "Payments (prod) ✨")
    }

    func testThePlaceholderIsTheFolderOrSaysItFollowsIt() {
        XCTAssertEqual(WorkspaceNameField.placeholder(folder: ""), "Same as the folder")
        XCTAssertEqual(WorkspaceNameField.placeholder(folder: "app"), "app")
    }

    // MARK: the card: Create workspace

    func testCreateNeedsAFolderANameAndAMachineThatCanMakeIt() {
        let pick = PickedFolder.new(name: "app", path: "/home/orbit/app")
        XCTAssertTrue(MachineSetup.canCreate(pick: pick, name: "app", online: true, checksFolders: true, creating: false))
        XCTAssertFalse(MachineSetup.canCreate(pick: nil, name: "app", online: true, checksFolders: true, creating: false),
                       "no answer to make it in yet")
        XCTAssertFalse(MachineSetup.canCreate(pick: pick, name: "  ", online: true, checksFolders: true, creating: false))
        XCTAssertFalse(MachineSetup.canCreate(pick: pick, name: "app", online: false, checksFolders: true, creating: false))
        XCTAssertFalse(MachineSetup.canCreate(pick: pick, name: "app", online: true, checksFolders: false, creating: false))
        XCTAssertFalse(MachineSetup.canCreate(pick: pick, name: "app", online: true, checksFolders: true, creating: true),
                       "one create at a time")
    }

    func testAMachineChecksFoldersOnlyIfItAnswersAndMakesThem() throws {
        XCTAssertTrue(MachineSetup.checksFolders(try runner(
            #"{"id":"r","name":"m","capabilities":["dir-probe/v1","create-workdir/v1"],"reposRoot":"/home/orbit/orbit-repos"}"#)))
        XCTAssertFalse(MachineSetup.checksFolders(try runner(
            #"{"id":"r","name":"m","capabilities":["dir-probe/v1"],"reposRoot":"/home/orbit/orbit-repos"}"#)))
        XCTAssertFalse(MachineSetup.checksFolders(try runner(
            #"{"id":"r","name":"m","capabilities":["create-workdir/v1"],"reposRoot":"/home/orbit/orbit-repos"}"#)))
    }

    // MARK: the directory probe relay

    private final class Script: @unchecked Sendable {
        var answers: [DirProbeAnswer]
        var asked = 0
        var reads = 0
        var slept: [TimeInterval] = []
        var clock = Date(timeIntervalSince1970: 0)

        init(_ answers: [DirProbeAnswer]) { self.answers = answers }

        func read() -> DirProbeAnswer {
            reads += 1
            return answers.count > 1 ? answers.removeFirst() : answers[0]
        }

        func sleep(_ seconds: TimeInterval) {
            slept.append(seconds)
            clock = clock.addingTimeInterval(seconds)
        }
    }

    private func run(_ script: Script, asks: Bool = true) async throws -> DirProbeRelay.Outcome {
        try await DirProbeRelay.probe(ask: asks ? { script.asked += 1 } : nil,
                                      read: { script.read() },
                                      sleep: { script.sleep($0) },
                                      now: { script.clock })
    }

    func testItAsksThenReadsUntilTheRunnerAnswers() async throws {
        let result = probe()
        let script = Script([DirProbeAnswer(path: "p", status: "pending"), DirProbeAnswer(path: "p", status: "pending"),
                             DirProbeAnswer(path: "p", status: "done", result: result)])
        let outcome = try await run(script)
        XCTAssertEqual(outcome, .answered(result))
        XCTAssertEqual(script.asked, 1)
        XCTAssertEqual(script.reads, 3)
        XCTAssertEqual(script.slept, [DirProbeRelay.pollSeconds, DirProbeRelay.pollSeconds])
    }

    func testAnOfflineMachineIsReadNotAsked() async throws {
        let result = probe()
        let script = Script([DirProbeAnswer(path: "p", status: "done", result: result)])
        let outcome = try await run(script, asks: false)
        XCTAssertEqual(outcome, .answered(result))
        XCTAssertEqual(script.asked, 0)
    }

    func testAReplacedQuestionHasNothingMoreToWaitFor() async throws {
        let script = Script([DirProbeAnswer(path: "p", status: "pending"), DirProbeAnswer(path: "p", status: "idle")])
        let outcome = try await run(script)
        XCTAssertEqual(outcome, .replaced)
    }

    func testAMachineThatNeverAnswersIsSaidToHaveNot() async throws {
        let script = Script([DirProbeAnswer(path: "p", status: "pending")])
        let outcome = try await run(script)
        XCTAssertEqual(outcome, .unanswered)
        XCTAssertGreaterThanOrEqual(script.clock.timeIntervalSince1970, DirProbeRelay.waitSeconds)
    }

    // MARK: rule 8: the line a created workspace opens with

    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    func testTheDetailCarriesWhatTheLineSays() throws {
        let detail = try session(#"""
        {"id":"s","status":"RUNNING","createdWorkspace":true,
         "agent":{"id":"w","name":"app","workDir":"/home/orbit/code/app","deletedAt":null}}
        """#)
        XCTAssertEqual(detail.createdWorkspace, true)
        XCTAssertEqual(detail.agent?.workDir, "/home/orbit/code/app")
        XCTAssertNil(detail.agent?.deletedAt)
        let deleted = try session(#"""
        {"id":"s","status":"RUNNING","createdWorkspace":true,"agent":{"id":"w","name":"app","deletedAt":"2026-10-31T00:00:00Z"}}
        """#)
        XCTAssertEqual(deleted.agent?.deletedAt, "2026-10-31T00:00:00Z")
    }

    func testAListRowCarriesNoFlagAndSaysNothing() throws {
        XCTAssertNil(try session(#"{"id":"s","status":"RUNNING","agent":{"id":"w","name":"app"}}"#).createdWorkspace)
        XCTAssertEqual(try session(#"{"id":"s","status":"RUNNING","createdWorkspace":false}"#).createdWorkspace, false)
    }

    func testTheLineIsTheConversationsFirstAndOnlyOnceTheFirstPageIsLoaded() {
        let line = CreatedWorkspaceLine(workspaceID: "w", name: "app", machine: "m", path: "/x", live: true)
        let first = TranscriptRows.build(state: TranscriptState(), statusCards: [], canPageOlder: false,
                                         showWorkingIndicator: false, createdWorkspace: line)
        XCTAssertEqual(first.first, .createdWorkspace(line))
        XCTAssertEqual(first.first?.id, "created-workspace")
        let later = TranscriptRows.build(state: TranscriptState(), statusCards: [], canPageOlder: true,
                                         showWorkingIndicator: false, createdWorkspace: line)
        XCTAssertFalse(later.contains(.createdWorkspace(line)), "first means first, not the top of a later window")
    }
}
