import Foundation
import XCTest
@testable import OrbitKit

/// The managed runner states every client is rendered from: src/shared/src/managed-runner-states.fixture.json.
/// The apiserver derives each `status` in it from its own stored inputs, @orbit/shared and the web
/// render the same file, and here each status is decoded the way this client decodes the server's
/// answer, read through `ManagedRunnerLogic`, and held to the fixture's words and actions — so macOS
/// and iOS say what the web says about every state.
final class ManagedRunnerFixtureTests: XCTestCase {
    private struct Display: Equatable {
        let kind: String
        let title: String
        let detail: String
        let retry: Bool
        let ensure: Bool
        let signIn: Bool
        let acceptsWork: Bool
        let startsNewSession: Bool
        let moving: Bool

        init(_ object: [String: Any]) {
            kind = object["kind"] as? String ?? ""
            title = object["title"] as? String ?? ""
            detail = object["detail"] as? String ?? ""
            retry = object["retry"] as? Bool ?? false
            ensure = object["ensure"] as? Bool ?? false
            signIn = object["signIn"] as? Bool ?? false
            acceptsWork = object["acceptsWork"] as? Bool ?? false
            startsNewSession = object["startsNewSession"] as? Bool ?? false
            moving = object["moving"] as? Bool ?? false
        }

        init(_ display: ManagedRunnerDisplay) {
            kind = display.kind.rawValue
            title = display.title
            detail = display.detail
            retry = display.retry
            ensure = display.ensure
            signIn = display.signIn
            acceptsWork = display.acceptsWork
            startsNewSession = display.startsNewSession
            moving = display.moving
        }
    }

    private static func fixture() throws -> [String: Any] {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var source: URL?
        for _ in 0..<12 {
            let candidate = directory.appendingPathComponent("src/shared/src/managed-runner-states.fixture.json")
            if FileManager.default.fileExists(atPath: candidate.path) { source = candidate; break }
            directory.deleteLastPathComponent()
        }
        let data = try Data(contentsOf: XCTUnwrap(source, "the shared fixture is in the repository"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private static func cases(_ key: String) throws -> [[String: Any]] {
        try XCTUnwrap(fixture()[key] as? [[String: Any]])
    }

    /// The status as this client reads the server's body: JSON in, `ManagedRunnerStatus` out.
    private static func status(_ object: Any?) throws -> ManagedRunnerStatus {
        let data = try JSONSerialization.data(withJSONObject: XCTUnwrap(object))
        return try JSONDecoder().decode(ManagedRunnerStatus.self, from: data)
    }

    private static func state(_ name: String) throws -> ManagedRunnerStatus {
        let found = try cases("states").first { $0["name"] as? String == name }
        return try status(XCTUnwrap(found)["status"])
    }

    func testEveryStateIsDisplayedAsTheFixtureSays() throws {
        let states = try Self.cases("states")
        XCTAssertGreaterThan(states.count, 20)
        for entry in states {
            let name = entry["name"] as? String ?? "?"
            let display = ManagedRunnerLogic.display(try Self.status(entry["status"]))
            if let expected = entry["display"] as? [String: Any] {
                XCTAssertEqual(display.map(Display.init), Display(expected), name)
            } else {
                XCTAssertNil(display, name)
            }
        }
    }

    func testSetupStatesAndEligibilityMatchTheSharedFixture() throws {
        for entry in try Self.cases("states") {
            let status = try Self.status(entry["status"])
            let setup = ManagedRunnerLogic.managedSetupState(runnerID: status.runnerId, status: status)
            XCTAssertEqual(setup?.rawValue, entry["setupState"] as? String, entry["name"] as? String ?? "?")
            XCTAssertNil(ManagedRunnerLogic.managedSetupState(runnerID: "another", status: status))
            if let setup, let runnerID = status.runnerId {
                let runner = try JSONDecoder().decode(Runner.self, from: JSONSerialization.data(withJSONObject:
                    ["id": runnerID, "name": "Managed runner", "status": "OFFLINE", "online": false]))
                XCTAssertEqual(AgentListLogic.machinesToSetUp(runners: [runner], agents: [], managedStatus: status).map(\.id), [runnerID])
                XCTAssertEqual(LoadFailureLogic.defaultLanding(agents: ListLoadState().afterSuccess(), orderedAgentIDs: [],
                    lastAgentID: nil, section: .agents, selectedAgentID: nil, selectedSessionID: nil,
                    firstOnlineMachine: runnerID), .machine(runnerID))
                let root = MachineSetup.setupFolderRoot(runner, managedState: setup)
                XCTAssertEqual(root, ManagedRunnerCopy.Setup.home)
                let folder = try XCTUnwrap(MachineSetup.uncheckedFolder(name: "app", root: root))
                XCTAssertNil(MachineSetup.uncheckedFolder(name: "../app", root: root))
                let request = MachineSetup.createRequest(folder: folder, name: "My app", runnerID: runnerID)
                XCTAssertEqual(request.newFolder, "app")
                XCTAssertNil(request.workDir)
                XCTAssertEqual(MachineSetup.folderLine(folder: "app", createError: nil, found: nil,
                    unanswered: false, machine: "Managed runner", managedState: setup),
                    .meta(setup == .preparing ? ManagedRunnerCopy.Setup.FolderUnchecked.preparing : ManagedRunnerCopy.Setup.FolderUnchecked.asleep))
                XCTAssertFalse(MachineSetup.canCreate(pick: folder, name: " ", online: false,
                    checksFolders: false, creating: false, managedState: setup))
                XCTAssertFalse(MachineSetup.canCreate(pick: folder, name: "app", online: false,
                    checksFolders: false, creating: true, managedState: setup))
                XCTAssertTrue(MachineSetup.canCreate(pick: folder, name: "app", online: false, checksFolders: false, creating: false, managedState: setup))
                XCTAssertFalse(MachineSetup.canCreate(pick: nil, name: "app", online: false, checksFolders: false, creating: false, managedState: setup))
                XCTAssertEqual(folder.newWorkspace, NewWorkspaceRequest(newFolder: "app"))
            }
        }
    }

    func testSetupCopyMatchesTheSharedFixture() throws {
        let setup = try XCTUnwrap(Self.fixture()["setup"] as? [String: Any])
        let expected: [String: Any] = [
            "home": ManagedRunnerCopy.Setup.home,
            "notice": ["preparing": ManagedRunnerCopy.Setup.Notice.preparing,
                       "asleep": ManagedRunnerCopy.Setup.Notice.asleep],
            "folderUnchecked": ["preparing": ManagedRunnerCopy.Setup.FolderUnchecked.preparing,
                                "asleep": ManagedRunnerCopy.Setup.FolderUnchecked.asleep],
        ]
        XCTAssertEqual(NSDictionary(dictionary: setup), NSDictionary(dictionary: expected))
    }

    func testTheStatesTheClientsWereAskedForAreAllThere() throws {
        let kinds = Set(try Self.cases("states").compactMap { ($0["display"] as? [String: Any])?["kind"] as? String })
        for kind in ["preparing", "waitingCapacity", "available", "sleeping", "waking", "failed", "removed"] {
            XCTAssertTrue(kinds.contains(kind), kind)
        }
        // Retry on a failure the server allows one for, and none where it does not.
        let retryable = try XCTUnwrap(ManagedRunnerLogic.display(Self.state("failed: retryable")))
        XCTAssertEqual(retryable.title, "Managed runner failed")
        XCTAssertTrue(retryable.retry)
        XCTAssertFalse(try XCTUnwrap(ManagedRunnerLogic.display(Self.state("failed: needs an operator"))).retry)
    }

    func testAReasonCodeItHasNeverHeardOfIsShownByTheServersSentence() throws {
        for name in ["preparing: a reason this client does not know", "failed: a reason this client does not know"] {
            let status = try Self.state(name)
            XCTAssertEqual(status.reason?.code, "REASON_FROM_A_NEWER_SERVER")
            XCTAssertEqual(ManagedRunnerLogic.display(status)?.detail, "A newer server says why in its own words.", name)
        }
    }

    func testANewerServersStateOrContractDecodesAndShowsNoManagedUI() throws {
        let newer = try Self.cases("newer")
        XCTAssertFalse(newer.isEmpty)
        for entry in newer {
            // Decodes — never a failure that would leave a screen waiting — and shows nothing managed.
            let status = try Self.status(entry["status"])
            XCTAssertNil(ManagedRunnerLogic.display(status), entry["name"] as? String ?? "?")
        }
    }

    func testTheSwitchOffMeansNoManagedUIEvenWithAMapping() throws {
        let status = try Self.state("switched off with a mapping left from before")
        XCTAssertFalse(status.enabled)
        XCTAssertEqual(status.managementState, "READY")
        XCTAssertNil(ManagedRunnerLogic.display(status))
        XCTAssertNil(ManagedRunnerLogic.console(status: status, runnerID: status.runnerId, agentID: status.workspaceId, isDraft: true))
    }

    func testEveryCapabilityAnswerIsReadAsTheFixtureSays() throws {
        let capabilities = try Self.cases("capabilities")
        XCTAssertEqual(capabilities.count, 6)
        for entry in capabilities {
            let name = entry["name"] as? String ?? "?"
            // A refused read is no capability; the API client answers a 404 with nil.
            var read: ServerCapabilities?
            if entry["httpStatus"] as? Int == 200 {
                let data = try JSONSerialization.data(withJSONObject: XCTUnwrap(entry["body"]))
                read = try JSONDecoder().decode(ServerCapabilities.self, from: data)
            }
            XCTAssertEqual(ManagedRunnerLogic.offered(read), entry["offered"] as? Bool, name)
        }
        XCTAssertFalse(ManagedRunnerLogic.offered(nil))
    }

    func testTheActionWordsAreTheFixturesAndTheWebs() throws {
        let copy = try XCTUnwrap(Self.fixture()["copy"] as? [String: String])
        XCTAssertEqual(copy, [
            "retry": ManagedRunnerCopy.retry,
            "ensure": ManagedRunnerCopy.ensure,
            "signIn": ManagedRunnerCopy.signIn,
            "registerOwn": ManagedRunnerCopy.registerOwn,
        ])
    }

    /// The machine list's managed runner row (D4): the shared short label in place of Online/Offline,
    /// the fixture's tone, and the asleep line — held to the same file the web renders from.
    func testEveryStateReadsAsTheMachineRowTheFixtureSays() throws {
        let short = try XCTUnwrap(Self.fixture()["short"] as? [String: String])
        let tone = try XCTUnwrap(Self.fixture()["rowTone"] as? [String: String])
        let asleepRow = try XCTUnwrap((Self.fixture()["asleep"] as? [String: String])?["row"])
        let ids = try XCTUnwrap(Self.fixture()["ids"] as? [String: String])
        for entry in try Self.cases("states") {
            let name = entry["name"] as? String ?? "?"
            let status = try Self.status(entry["status"])
            let display = ManagedRunnerLogic.display(status)
            // The row of the runner this status names; without one there is no machine row to show.
            let row = ManagedRunnerLogic.row(runnerID: status.runnerId, status: status)
            guard let display, display.kind != .notOffered, status.runnerId != nil else {
                XCTAssertNil(row, name)
                continue
            }
            let shown = try XCTUnwrap(row, name)
            let kind = display.kind.rawValue
            XCTAssertEqual(shown.kind, display.kind, name)
            XCTAssertEqual(shown.label, short[kind], name)
            let expectedTone = try XCTUnwrap(tone[kind], name)
            XCTAssertEqual(shown.tone.rawValue, expectedTone == "progress" && !display.moving ? "idle" : expectedTone, name)
            XCTAssertEqual(shown.detail, display.kind == .sleeping && display.acceptsWork ? asleepRow : nil, name)
            XCTAssertEqual(shown.acceptsWork, display.acceptsWork, name)
            XCTAssertEqual(shown.asleep,
                           (display.kind == .sleeping || display.kind == .stopping) && display.acceptsWork, name)
        }
        // Only the account's managed runner has a row, and only where there is a managed UI.
        let sleeping = try Self.state("sleeping")
        XCTAssertNotNil(ManagedRunnerLogic.row(runnerID: sleeping.runnerId, status: sleeping))
        XCTAssertNil(ManagedRunnerLogic.row(runnerID: ids["workspace"], status: sleeping))
        XCTAssertNil(ManagedRunnerLogic.row(runnerID: sleeping.runnerId, status: nil))
        XCTAssertNil(ManagedRunnerLogic.row(runnerID: nil, status: sleeping))
    }

    func testTheEntryConfirmationAndAsleepWordsAreTheFixturesAndTheWebs() throws {
        let entry = try XCTUnwrap(Self.fixture()["entry"] as? [String: String])
        XCTAssertEqual(entry, [
            "title": ManagedRunnerCopy.Entry.title,
            "action": ManagedRunnerCopy.Entry.action,
            "subtitle": ManagedRunnerCopy.Entry.subtitle,
            "page": ManagedRunnerCopy.Entry.page,
            "register": ManagedRunnerCopy.Entry.register,
        ])
        let confirm = try XCTUnwrap(Self.fixture()["confirm"] as? [String: String])
        XCTAssertEqual(confirm, [
            "title": ManagedRunnerCopy.Confirm.title,
            "body": ManagedRunnerCopy.Confirm.body,
            "cancel": ManagedRunnerCopy.Confirm.cancel,
            "confirm": ManagedRunnerCopy.Confirm.action,
        ])
        let asleep = try XCTUnwrap(Self.fixture()["asleep"] as? [String: String])
        XCTAssertEqual(asleep, [
            "row": ManagedRunnerCopy.Asleep.row,
            "composer": ManagedRunnerCopy.Asleep.composer,
        ])
    }
}
