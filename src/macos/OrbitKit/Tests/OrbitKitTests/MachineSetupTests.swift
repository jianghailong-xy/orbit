import Foundation
import XCTest
@testable import OrbitKit

/// The rules of a machine's first workspace, from docs/mocks/first-workspace-in-conversation/04-rules:
/// the same cases as the web's `lib/machineSetup.test.ts`, and the waiting message the web holds in its
/// page (`WorkspaceView.machineSetup.test.tsx`), which is a value here.
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

    // MARK: rule 2: the folder orbit register ran in is a suggestion

    func testARegisterDirIsNotAskedAboutWhenThePathAloneIsTheAnswer() {
        for dir in [nil, "", "   ", "~", "/", "~/", "//", " ~ "] {
            XCTAssertNil(MachineSetup.registerDirToProbe(dir), String(describing: dir))
        }
    }

    func testARegisterDirIsAskedAboutAsItWasReportedTidied() {
        XCTAssertEqual(MachineSetup.registerDirToProbe("/home/orbit/code/app"), "/home/orbit/code/app")
        XCTAssertEqual(MachineSetup.registerDirToProbe(" ~/code/app/ "), "~/code/app")
        XCTAssertEqual(MachineSetup.registerDirToProbe("relative/dir"), "relative/dir")
    }

    func testAFolderIsOfferedOnlyWhenItIsThereAndNeitherHomeNorTheRoot() {
        XCTAssertTrue(MachineSetup.isOfferedFolder(probe()))
        XCTAssertTrue(MachineSetup.isOfferedFolder(probe(isGit: false, branch: nil)))
        XCTAssertFalse(MachineSetup.isOfferedFolder(probe(exists: false, isDir: false)))
        XCTAssertFalse(MachineSetup.isOfferedFolder(probe(isDir: false)))
        XCTAssertFalse(MachineSetup.isOfferedFolder(probe(isHome: true)))
        XCTAssertFalse(MachineSetup.isOfferedFolder(probe(path: "/")))
        XCTAssertFalse(MachineSetup.isOfferedFolder(probe(error: "permission denied")))
        XCTAssertFalse(MachineSetup.isOfferedFolder(nil))
    }

    func testTheSuggestionIsTheDefaultOnlyWhenItIsAGitRepository() {
        XCTAssertEqual(MachineSetup.defaultFolderChoice(suggested: probe(), offersNewFolder: true), .suggested)
        XCTAssertEqual(MachineSetup.defaultFolderChoice(suggested: probe(isGit: false), offersNewFolder: true), .new)
        XCTAssertEqual(MachineSetup.defaultFolderChoice(suggested: nil, offersNewFolder: true), .new)
    }

    func testOnAMachineThatCantMakeAFolderWhatIsLeftIsTheDefault() {
        XCTAssertEqual(MachineSetup.defaultFolderChoice(suggested: probe(isGit: false), offersNewFolder: false), .suggested)
        XCTAssertEqual(MachineSetup.defaultFolderChoice(suggested: nil, offersNewFolder: false), .other)
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

    func testAMachineTooOldToAnswerGetsThereByItselfUnlessItsUpdaterSaysItCant() throws {
        XCTAssertTrue(MachineSetup.updatesItself(try runner(#"{"id":"r","name":"m"}"#)))
        XCTAssertTrue(MachineSetup.updatesItself(try runner(#"{"id":"r","name":"m","selfUpdate":{"state":"enabled"}}"#)))
        XCTAssertFalse(MachineSetup.updatesItself(try runner(#"{"id":"r","name":"m","selfUpdate":{"state":"disabledByEnv"}}"#)))
        XCTAssertFalse(MachineSetup.updatesItself(try runner(#"{"id":"r","name":"m","selfUpdate":{"state":"dirNotWritable"}}"#)))
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
        XCTAssertEqual(MachineSetup.newFolderPath(reposRoot: "/home/orbit/orbit-repos", name: "app"),
                       "/home/orbit/orbit-repos/app")
        XCTAssertEqual(MachineSetup.newFolderPath(reposRoot: "/home/orbit/orbit-repos/", name: "app"),
                       "/home/orbit/orbit-repos/app")
        XCTAssertEqual(MachineSetup.newFolderPath(reposRoot: "C:\\Users\\orbit\\orbit-repos", name: "app"),
                       "C:\\Users\\orbit\\orbit-repos\\app")
        XCTAssertEqual(MachineSetup.newFolderPath(reposRoot: "/home/orbit/orbit-repos", name: ""),
                       "/home/orbit/orbit-repos/")
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

    // MARK: what POST /sessions is told

    func testANewFolderGoesByItsNameAnExistingOneByThePathTheRunnerResolved() {
        XCTAssertEqual(PickedFolder.new(name: "app", path: "/home/orbit/orbit-repos/app").newWorkspace,
                       NewWorkspaceRequest(newFolder: "app"))
        XCTAssertEqual(PickedFolder.existing(path: "/home/orbit/code/app", note: "").newWorkspace,
                       NewWorkspaceRequest(workDir: "/home/orbit/code/app"))
    }

    func testTheWorkspaceNameAFolderGivesAsTheServerDerivesIt() {
        XCTAssertEqual(MachineSetup.folderName("/home/orbit/code/app"), "app")
        XCTAssertEqual(MachineSetup.folderName("/home/orbit/code/app/"), "app")
        XCTAssertEqual(MachineSetup.folderName("C:\\work\\app"), "app")
        XCTAssertEqual(MachineSetup.folderName("/"), "/")
        XCTAssertEqual(PickedFolder.existing(path: "/home/orbit/code/app", note: "").workspaceName, "app")
        XCTAssertEqual(PickedFolder.new(name: "payments", path: "/r/payments").workspaceName, "payments")
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

    func testReadyIsBothStepsAndTheMachineHere() {
        let folder = PickedFolder.new(name: "app", path: "/r/app")
        XCTAssertTrue(MachineSetup.isReady(bare: true, folder: folder, online: true, credential: .signedIn))
        XCTAssertTrue(MachineSetup.isReady(bare: true, folder: folder, online: true, credential: .onKey(label: "k", pool: false)))
        XCTAssertFalse(MachineSetup.isReady(bare: true, folder: nil, online: true, credential: .signedIn))
        XCTAssertFalse(MachineSetup.isReady(bare: true, folder: folder, online: true, credential: .signIn))
        XCTAssertFalse(MachineSetup.isReady(bare: true, folder: folder, online: true, credential: .notInstalled))
        XCTAssertFalse(MachineSetup.isReady(bare: true, folder: folder, online: false, credential: .signedIn))
        XCTAssertFalse(MachineSetup.isReady(bare: false, folder: folder, online: true, credential: .signedIn))
    }

    func testUseXInsteadIsTheOtherSignInsInstalledHere() throws {
        let row = try machineRunner([engine("claude", "no"), engine("codex", "no"), engine("kimi", "no", installed: false),
                                     engine("opencode", "unknown")])
        XCTAssertEqual(MachineSetup.otherEngines(on: row, than: "claude", fleet: [row]), [.codex])
        XCTAssertEqual(MachineSetup.otherEngines(on: row, than: "codex", fleet: [row]), [.claude])
    }

    func testCursorIsOfferedOnlyOnceTheFleetKnowsIt() throws {
        let row = try machineRunner([engine("claude", "no"), engine("cursor", "no")])
        let older = try machineRunner([engine("claude", "no")])
        XCTAssertEqual(MachineSetup.otherEngines(on: row, than: "claude", fleet: [row]), [.cursor])
        XCTAssertEqual(MachineSetup.otherEngines(on: row, than: "claude", fleet: [older]), [])
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

    func testAMachinesDraftStandsOnNoWorkspace() {
        let draft = Agent.machineDraft(runnerID: "austin", name: "orbit@austin", engine: .codex)
        XCTAssertTrue(draft.standsInForMachine)
        XCTAssertEqual(draft.runnerId, "austin")
        XCTAssertEqual(draft.name, "orbit@austin")
        XCTAssertEqual(draft.defaultProvider, "codex", "it starts on the machine's engine")
        XCTAssertEqual(draft.defaultEngine(configured: []), "codex")
        XCTAssertFalse(try! JSONDecoder().decode(Agent.self, from: Data(#"{"id":"w","name":"a"}"#.utf8)).standsInForMachine)
    }

    // MARK: rule 6: the message waiting

    private let folder = PickedFolder.existing(path: "/home/orbit/code/app", note: "git repository · main")
    private let message = HeldMessage(content: "Fix the flaky login test")

    func testReadyTheSendMakesTheWorkspace() {
        let state = MachineSetupState(folder: folder)
        XCTAssertEqual(state.send(bare: true, ready: true),
                       .create(NewWorkspaceRequest(workDir: "/home/orbit/code/app")))
    }

    func testNotReadyTheMessageWaits() {
        XCTAssertEqual(MachineSetupState().send(bare: true, ready: false), .hold)
        XCTAssertEqual(MachineSetupState(folder: folder).send(bare: true, ready: false), .hold)
    }

    func testOneWaitsAtATime() {
        XCTAssertEqual(MachineSetupState(folder: folder, held: message).send(bare: true, ready: true), .alreadyWaiting)
        XCTAssertEqual(MachineSetupState(held: message).send(bare: true, ready: false), .alreadyWaiting)
    }

    func testAMachineNotKnownToBeBareSendsNothing() {
        XCTAssertEqual(MachineSetupState(folder: folder).send(bare: false, ready: false), .nothing)
    }

    func testBothStepsDoneItGoesWithNobodyPressingAnythingOnce() throws {
        var state = MachineSetupState(folder: folder, held: message)
        let sent = try XCTUnwrap(state.takeHeldToSend(ready: true, busy: false))
        XCTAssertEqual(sent.message, message)
        XCTAssertEqual(sent.folder, NewWorkspaceRequest(workDir: "/home/orbit/code/app"))
        XCTAssertTrue(state.sendingHeld)
        XCTAssertNil(state.takeHeldToSend(ready: true, busy: false), "a send makes a workspace: it must not go twice")
    }

    func testItWaitsForTheStepsAndForASendAlreadyOut() {
        var state = MachineSetupState(folder: folder, held: message)
        XCTAssertNil(state.takeHeldToSend(ready: false, busy: false))
        XCTAssertNil(state.takeHeldToSend(ready: true, busy: true))
        var noFolder = MachineSetupState(held: message)
        XCTAssertNil(noFolder.takeHeldToSend(ready: true, busy: false))
        var nothing = MachineSetupState(folder: folder)
        XCTAssertNil(nothing.takeHeldToSend(ready: true, busy: false))
        XCTAssertFalse(state.sendingHeld)
    }

    func testARefusalStaysSayingWhyUntilItIsTriedAgain() throws {
        var state = MachineSetupState(folder: folder, held: message)
        _ = try XCTUnwrap(state.takeHeldToSend(ready: true, busy: false))
        state.failHeld("Claude Code isn’t signed in")
        XCTAssertEqual(state.held?.error, "Claude Code isn’t signed in")
        XCTAssertFalse(state.sendingHeld)
        XCTAssertNil(state.takeHeldToSend(ready: true, busy: false), "it waits on the person, not on another try")

        state.retryHeld()
        XCTAssertNil(state.held?.error)
        XCTAssertEqual(state.takeHeldToSend(ready: true, busy: false)?.message, message)
    }

    func testWithdrawnItComesBackAndNothingIsLeftWaiting() throws {
        var state = MachineSetupState(folder: folder, held: message)
        XCTAssertEqual(state.withdraw(), message)
        XCTAssertNil(state.held)
        XCTAssertEqual(state.folder, folder, "the folder stays answered")
        XCTAssertNil(state.withdraw())
    }

    func testAMessageOnItsWayCantBeWithdrawn() throws {
        var state = MachineSetupState(folder: folder, held: message)
        _ = try XCTUnwrap(state.takeHeldToSend(ready: true, busy: false))
        XCTAssertNil(state.withdraw())
        XCTAssertEqual(state.held, message)
    }

    func testAMessageAlreadyRefusedCanBeWithdrawn() throws {
        var state = MachineSetupState(folder: folder, held: message)
        _ = try XCTUnwrap(state.takeHeldToSend(ready: true, busy: false))
        state.failHeld("no")
        XCTAssertEqual(state.withdraw()?.content, message.content)
    }

    func testChangingTheFolderKeepsTheMessageWaiting() {
        var state = MachineSetupState(folder: folder, held: message)
        state.pick(nil)
        XCTAssertNil(state.folder)
        XCTAssertEqual(state.held, message)
        var picked = state
        XCTAssertNil(picked.takeHeldToSend(ready: true, busy: false), "no folder, nothing to send it with")
    }

    func testAMachineWithAWorkspaceHasNothingLeftToRemember() {
        var state = MachineSetupState(folder: folder, held: message)
        state.finish()
        XCTAssertEqual(state, MachineSetupState())
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

    func testTheLineReadsTheWorkspaceRowOfTheDetail() throws {
        let detail = try session(#"""
        {"id":"s","status":"RUNNING","createdWorkspace":true,
         "agent":{"id":"w","name":"app","workDir":"/home/orbit/code/app","deletedAt":null}}
        """#)
        XCTAssertEqual(CreatedWorkspaceLine(session: detail, machine: "orbit@austin"),
                       CreatedWorkspaceLine(workspaceID: "w", name: "app", machine: "orbit@austin",
                                            path: "/home/orbit/code/app", live: true))
    }

    func testAWorkspaceDeletedSinceIsStillWhatItMadeWithNothingToChange() throws {
        let detail = try session(#"""
        {"id":"s","status":"RUNNING","createdWorkspace":true,
         "agent":{"id":"w","name":"app","workDir":"/x","deletedAt":"2026-10-31T00:00:00Z"}}
        """#)
        XCTAssertEqual(CreatedWorkspaceLine(session: detail, machine: "m")?.live, false)
    }

    func testASessionThatMadeNoWorkspaceHasNoLine() throws {
        XCTAssertNil(CreatedWorkspaceLine(session: try session(#"{"id":"s","status":"RUNNING","createdWorkspace":false,"agent":{"id":"w","name":"app"}}"#), machine: "m"))
        XCTAssertNil(CreatedWorkspaceLine(session: try session(#"{"id":"s","status":"RUNNING","agent":{"id":"w","name":"app"}}"#), machine: "m"),
                     "a list row carries no flag, and says nothing")
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
