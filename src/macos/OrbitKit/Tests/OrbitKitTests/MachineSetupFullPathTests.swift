import Foundation
import XCTest
@testable import OrbitKit

/// The card's folder field takes a full path too (docs/mocks/new-workspace-form, decision 2 A): the cases of the web's
/// `MachineSetupCard.test.tsx` "a full path" block, on the logic the Apple card draws, and the machines New workspace
/// offers (docs/mocks/new-workspace-form/02-apple-entry, owner A).
final class MachineSetupFullPathTests: XCTestCase {
    private let machine = "orbit@austin"
    private let root = "/home/orbit"

    private func probe(path: String, exists: Bool = true, isDir: Bool = true, isGit: Bool = true,
                       branch: String? = "develop", error: String? = nil) -> DirProbe {
        DirProbe(path: path, exists: exists, isDir: isDir, isGit: isGit, branch: branch, isHome: false,
                 freeBytes: 1024, error: error)
    }

    private func line(_ folder: String, found: DirProbe? = nil, managedState: ManagedSetupState? = nil,
                      pathHintRoot: String? = nil) -> SetupFolderLine {
        MachineSetup.folderLine(folder: folder, createError: nil, found: found, unanswered: false, machine: machine,
                                managedState: managedState, pathHintRoot: pathHintRoot)
    }

    // MARK: what is a full path

    func testAPathStartsWithASlashOrATilde() {
        XCTAssertTrue(MachineSetup.isFolderPath("/srv/app"))
        XCTAssertTrue(MachineSetup.isFolderPath("~/code/app"))
        XCTAssertTrue(MachineSetup.isFolderPath("~"))
        XCTAssertFalse(MachineSetup.isFolderPath("app"))
        XCTAssertFalse(MachineSetup.isFolderPath("code/app"))
        XCTAssertFalse(MachineSetup.isFolderPath(""))
    }

    // MARK: the machine is asked about the path as typed

    func testAFullPathIsAskedAsTyped() {
        XCTAssertEqual(MachineSetup.folderQuestion(folder: "/home/orbit/code/api", root: root, canAsk: true),
                       "/home/orbit/code/api")
        XCTAssertEqual(MachineSetup.folderQuestion(folder: "~/nowhere", root: root, canAsk: true), "~/nowhere",
                       "the runner expands ~, not the app")
    }

    func testANameIsStillAskedWhereItWouldGo() {
        XCTAssertEqual(MachineSetup.folderQuestion(folder: "payments-api", root: root, canAsk: true),
                       "/home/orbit/payments-api")
        XCTAssertNil(MachineSetup.folderQuestion(folder: "my app", root: root, canAsk: true), "a name the server refuses")
        XCTAssertNil(MachineSetup.folderQuestion(folder: "", root: root, canAsk: true))
    }

    func testNothingIsAskedWhereNothingCanBe() {
        XCTAssertNil(MachineSetup.folderQuestion(folder: "/srv/app", root: root, canAsk: false))
    }

    /// The relay asks exactly the question it is handed: the path as typed reaches the machine.
    func testTheRelayAsksThePathItIsGiven() async throws {
        let asked = MachineSetup.folderQuestion(folder: "~/code/api", root: root, canAsk: true)!
        var sent: [String] = []
        let outcome = try await DirProbeRelay.probe(
            ask: { sent.append(asked) },
            read: { DirProbeAnswer(path: asked, status: "done", result: self.probe(path: "/home/orbit/code/api")) },
            sleep: { _ in })
        XCTAssertEqual(sent, ["~/code/api"])
        XCTAssertEqual(outcome, .answered(probe(path: "/home/orbit/code/api")))
    }

    // MARK: what it finds

    func testAnExistingRepositoryIsUsedAsItStands() {
        let found = probe(path: "/home/orbit/code/api")
        XCTAssertEqual(line("/home/orbit/code/api", found: found), .verdict("Found · git repository · develop", .ok))
        XCTAssertEqual(MachineSetup.typedPick(folder: "/home/orbit/code/api", found: found, root: root, machine: machine,
                                              managedState: nil),
                       .existing(path: "/home/orbit/code/api", note: "git repository · develop"))
        let request = MachineSetup.createRequest(folder: .existing(path: found.path, note: ""), name: "api", runnerID: "r1")
        XCTAssertEqual(request.workDir, "/home/orbit/code/api")
        XCTAssertNil(request.newFolder, "nothing is made for a full path")
    }

    func testAFolderThatIsNotARepositoryIsTakenWithItsWarning() {
        let found = probe(path: "/srv/data", isGit: false, branch: nil)
        XCTAssertEqual(line("/srv/data", found: found), .verdict("Found · not a git repository — sessions will share it instead of isolating.", .warn))
        XCTAssertNotNil(MachineSetup.typedPick(folder: "/srv/data", found: found, root: root, machine: machine,
                                               managedState: nil))
    }

    func testAMissingPathIsRefusedNeverMade() {
        let found = probe(path: "/home/orbit/nowhere", exists: false, isDir: false, isGit: false, branch: nil)
        XCTAssertEqual(line("~/nowhere", found: found), .verdict("No such directory on orbit@austin.", .bad))
        XCTAssertNil(MachineSetup.typedPick(folder: "~/nowhere", found: found, root: root, machine: machine,
                                            managedState: nil))
        // A name with nothing there is a new folder; a path with nothing there is not.
        XCTAssertNotNil(MachineSetup.typedPick(folder: "nowhere", found: found, root: root, machine: machine,
                                               managedState: nil))
    }

    func testAFileOrAFailedCheckIsRefused() {
        let file = probe(path: "/srv/app.txt", exists: true, isDir: false, isGit: false, branch: nil)
        XCTAssertEqual(line("/srv/app.txt", found: file), .verdict("That isn’t a directory on orbit@austin.", .bad))
        XCTAssertNil(MachineSetup.typedPick(folder: "/srv/app.txt", found: file, root: root, machine: machine,
                                            managedState: nil))
        let failed = probe(path: "/root/x", exists: false, isDir: false, isGit: false, branch: nil, error: "permission denied")
        XCTAssertNil(MachineSetup.typedPick(folder: "/root/x", found: failed, root: root, machine: machine,
                                            managedState: nil))
    }

    func testAPathIsNeverCalledAnInvalidName() {
        XCTAssertEqual(line("/srv/my app"), .checking, "spaces are fine in a path: the machine is asked")
    }

    func testNothingIsPickedBeforeTheAnswer() {
        XCTAssertNil(MachineSetup.typedPick(folder: "/srv/app", found: nil, root: root, machine: machine, managedState: nil))
    }

    // MARK: a managed runner that isn't up

    func testAManagedRunnerNotUpRefusesAPath() {
        for state in [ManagedSetupState.preparing, .asleep] {
            XCTAssertEqual(line("/srv/app", managedState: state), .meta("orbit@austin checks a full path once it’s up."))
            XCTAssertNil(MachineSetup.typedPick(folder: "/srv/app", found: nil, root: root, machine: machine,
                                                managedState: state))
            XCTAssertNil(MachineSetup.folderQuestion(folder: "/srv/app", root: root, canAsk: false))
            XCTAssertFalse(MachineSetup.canCreate(pick: nil, name: "app", online: false, checksFolders: false,
                                                  creating: false, managedState: state))
        }
    }

    func testAManagedRunnerNotUpStillTakesANameUnchecked() {
        XCTAssertEqual(MachineSetup.typedPick(folder: "app", found: nil, root: root, machine: machine, managedState: .asleep),
                       .new(name: "app", path: "/home/orbit/app"))
    }

    // MARK: the name follows the path's last segment

    func testTheNameFollowsTheLastSegment() {
        XCTAssertEqual(MachineSetup.followedName(folder: "/home/orbit/code/api"), "api")
        XCTAssertEqual(MachineSetup.followedName(folder: "~/code/web-app/"), "web-app")
        XCTAssertEqual(MachineSetup.followedName(folder: "payments-api"), "payments-api")
        XCTAssertEqual(MachineSetup.folderName("/"), "/")
        XCTAssertEqual(MachineSetup.folderName("~"), "~")
        var name = WorkspaceNameField()
        let followed = MachineSetup.followedName(folder: "/srv/app")
        XCTAssertEqual(name.shown(folder: followed), "app")
        name.edit("Billing", folder: followed)
        XCTAssertEqual(name.name(folder: MachineSetup.followedName(folder: "/srv/other")), "Billing", "an edit stays")
    }

    // MARK: the hint

    func testTheHintSaysAFullPathWhereTheScreenNamesTheMachine() {
        XCTAssertEqual(line("", pathHintRoot: "/home/orbit/"),
                       .meta("A name in /home/orbit, or a full path. Uses the folder if it exists, otherwise creates it."))
        XCTAssertEqual(line(""), .meta("Uses this folder if it exists, otherwise creates it."),
                       "a bare machine's card keeps its hint")
    }

    // MARK: the machines New workspace offers

    private func runner(_ id: String, online: Bool) -> Runner {
        try! JSONDecoder().decode(Runner.self, from: Data(#"{"id":"\#(id)","name":"\#(id)@host","online":\#(online)}"#.utf8))
    }

    private func agent(_ id: String, on runnerID: String) -> Agent {
        try! JSONDecoder().decode(Agent.self, from: Data(#"{"id":"\#(id)","name":"\#(id)","runnerId":"\#(runnerID)"}"#.utf8))
    }

    func testEveryMachineIsOfferedWithWhatItHolds() {
        let machines = AgentListLogic.newWorkspaceMachines(
            runners: [runner("austin", online: true), runner("build", online: false)],
            agents: [agent("orbit", on: "austin"), agent("tea", on: "austin")])
        XCTAssertEqual(machines, [NewWorkspaceMachine(id: "austin", name: "austin@host", online: true, workspaces: 2),
                                  NewWorkspaceMachine(id: "build", name: "build@host", online: false, workspaces: 0)])
    }

    func testTheMenuSaysWhatEachMachineHolds() {
        XCTAssertEqual(NewWorkspaceCopy.machineDetail(workspaces: 2, online: true), "2 workspaces")
        XCTAssertEqual(NewWorkspaceCopy.machineDetail(workspaces: 1, online: true), "1 workspace")
        XCTAssertEqual(NewWorkspaceCopy.machineDetail(workspaces: 0, online: false), "Offline · No workspaces yet")
    }
}
