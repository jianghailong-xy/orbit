import Foundation
import XCTest
@testable import OrbitKit

/// How the macOS and iOS consoles act on the managed runner's state, from the server state samples
/// in src/shared/src/managed-runner-states.fixture.json: only the managed runner's console has one;
/// asleep or on its way up, an ended session's message is not refused as offline; before the runner
/// was ever ready, its default workspace's draft has no engine to start on. Without the capability,
/// every one of these answers is what it was.
final class ManagedRunnerLogicTests: XCTestCase {
    private static func state(_ name: String) throws -> ManagedRunnerStatus {
        let data = try JSONSerialization.data(withJSONObject: stateObject(name))
        return try JSONDecoder().decode(ManagedRunnerStatus.self, from: data)
    }

    /// The fixture's `status` body for `name`, as the server sends it.
    private static func stateObject(_ name: String) throws -> [String: Any] {
        let entry = try XCTUnwrap(states().first { $0["name"] as? String == name }, name)
        return try XCTUnwrap(entry["status"] as? [String: Any], name)
    }

    /// Every `status` case in the fixture, in its order.
    private static func states() throws -> [[String: Any]] {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var source: URL?
        for _ in 0..<12 {
            let candidate = directory.appendingPathComponent("src/shared/src/managed-runner-states.fixture.json")
            if FileManager.default.fileExists(atPath: candidate.path) { source = candidate; break }
            directory.deleteLastPathComponent()
        }
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: XCTUnwrap(source))) as? [String: Any]
        return try XCTUnwrap(object?["states"] as? [[String: Any]])
    }

    /// The status as this client reads the server's body (the fixture's spelling of it).
    private static func status(_ object: Any?) throws -> ManagedRunnerStatus {
        let data = try JSONSerialization.data(withJSONObject: XCTUnwrap(object))
        return try JSONDecoder().decode(ManagedRunnerStatus.self, from: data)
    }

    private static let ownRunner = "33zx0JhRhJo8rd25d3qAM"
    private static let ownWorkspace = "33zx0JhRhJo8rd25d3qAP"

    /// The server's capabilities of an ended session whose runner is offline.
    private static let offline = SessionCapabilities(canSend: false, canResume: false, resumeBlockedReason: .runnerOffline,
                                                     canComplete: true, canRestore: false)

    // MARK: whose console

    func testOnlyTheManagedRunnersConsoleHasOne() throws {
        let sleeping = try Self.state("sleeping")
        let console = try XCTUnwrap(ManagedRunnerLogic.console(status: sleeping, runnerID: sleeping.runnerId,
                                                               agentID: sleeping.workspaceId, isDraft: false))
        XCTAssertEqual(console.display.kind, .sleeping)
        XCTAssertTrue(console.showsBanner)
        XCTAssertNil(ManagedRunnerLogic.console(status: sleeping, runnerID: Self.ownRunner, agentID: Self.ownWorkspace, isDraft: false))
        XCTAssertNil(ManagedRunnerLogic.console(status: sleeping, runnerID: nil, agentID: nil, isDraft: true))
        XCTAssertNil(ManagedRunnerLogic.console(status: nil, runnerID: sleeping.runnerId, agentID: sleeping.workspaceId, isDraft: true))
    }

    func testTheManagedRunnerIsRecognisedInEitherSpellingOfItsID() throws {
        let sleeping = try Self.state("sleeping")
        let uuid = try XCTUnwrap(PublicID.toUUID(XCTUnwrap(sleeping.runnerId)))
        XCTAssertNotNil(ManagedRunnerLogic.console(status: sleeping, runnerID: uuid, agentID: nil, isDraft: false))
    }

    func testReadyHasNoBanner() throws {
        let ready = try Self.state("available")
        XCTAssertEqual(ManagedRunnerLogic.console(status: ready, runnerID: ready.runnerId, agentID: ready.workspaceId,
                                                  isDraft: true)?.showsBanner, false)
    }

    // MARK: a first session in the default workspace

    func testBeforeReadyAFirstSessionWaitsOnTheOwnersKeyTheServerNames() throws {
        for name in ["preparing: starting, a first session waits on the owner's key",
                     "preparing: the cluster's resource quota has no room for its first Pod, a first session waits on the owner's key",
                     "waiting for capacity before the first start, a first session waits on the owner's key"] {
            let status = try Self.state(name)
            XCTAssertNil(status.initialProvider, name)
            XCTAssertEqual(status.firstSessionProvider, "deepseek", name)
            XCTAssertEqual(ManagedRunnerLogic.firstSessionProvider(status), "deepseek", name)
            let draft = try XCTUnwrap(ManagedRunnerLogic.console(status: status, runnerID: status.runnerId,
                                                                 agentID: status.workspaceId, isDraft: true), name)
            // The runner's state still stands above the composer while it is not up.
            XCTAssertTrue(draft.showsBanner, name)
        }
    }

    func testAnOlderServerWithoutTheFieldIsReadByInitialProvider() throws {
        for name in ["waiting for capacity before the first start, a first session waits on the owner's key", "sleeping"] {
            var object = try Self.stateObject(name)
            XCTAssertNotNil(object.removeValue(forKey: "firstSessionProvider"), name)
            let older = try JSONDecoder().decode(ManagedRunnerStatus.self, from: JSONSerialization.data(withJSONObject: object))
            XCTAssertNil(older.firstSessionProvider, name)
            XCTAssertEqual(ManagedRunnerLogic.firstSessionProvider(older), older.initialProvider, name)
            XCTAssertEqual(ManagedRunnerLogic.display(older)?.startsNewSession,
                           (ManagedRunnerLogic.display(older)?.acceptsWork ?? false) && older.initialProvider != nil, name)
        }
    }

    // MARK: sending while it sleeps

    func testAsleepAnEndedSessionsMessageResumesItInsteadOfBeingRefused() throws {
        let sleeping = try XCTUnwrap(ManagedRunnerLogic.display(Self.state("sleeping")))
        let lifted = ManagedRunnerLogic.sendCapabilities(Self.offline, acceptsWork: sleeping.acceptsWork)
        XCTAssertEqual(ComposerLogic.availability(status: .succeeded, capabilities: lifted), .sendNow)
        XCTAssertNil(ComposerLogic.blockedMessage(status: .succeeded, capabilities: lifted))
        XCTAssertTrue(ComposerLogic.shouldResume(status: .succeeded, capabilities: lifted))
    }

    func testWorkThatWouldWaitForAnOwnerOrAnOperatorIsStillRefused() throws {
        for name in ["failed: retryable", "waiting for an operator: fencing", "removed",
                     "switched on without a usable environment, asleep"] {
            let display = ManagedRunnerLogic.display(try Self.state(name))
            XCTAssertEqual(display?.acceptsWork, false, name)
            let kept = ManagedRunnerLogic.sendCapabilities(Self.offline, acceptsWork: display?.acceptsWork ?? false)
            XCTAssertEqual(kept, Self.offline, name)
            XCTAssertEqual(ComposerLogic.availability(status: .succeeded, capabilities: kept), .blocked, name)
        }
    }

    func testAnAsleepRunnerTheServerWillNotWakeTakesNoWork() throws {
        // A disabled account's (C6b): the server says why, offers no action, and records no demand.
        let status = try Self.state("asleep, its account disabled")
        XCTAssertEqual(status.reason?.code, "ACCOUNT_DISABLED")
        XCTAssertFalse(status.actions.canWake)
        let display = try XCTUnwrap(ManagedRunnerLogic.display(status))
        XCTAssertEqual(display.kind, .sleeping)
        XCTAssertEqual(display.detail, status.reason?.message)
        XCTAssertFalse(display.acceptsWork)
        XCTAssertFalse(display.retry || display.ensure || display.signIn)
        XCTAssertEqual(ManagedRunnerLogic.sendCapabilities(Self.offline, acceptsWork: display.acceptsWork), Self.offline)
    }

    func testOnlyTheOfflineRefusalIsLifted() {
        let gone = SessionCapabilities(canSend: false, canResume: false, resumeBlockedReason: .missingContext,
                                       canComplete: true, canRestore: false)
        XCTAssertEqual(ManagedRunnerLogic.sendCapabilities(gone, acceptsWork: true), gone)
        XCTAssertNil(ManagedRunnerLogic.sendCapabilities(nil, acceptsWork: true))
    }

    // MARK: without the capability, what it was

    func testWithoutManagedUITheComposerAndItsWordsAreUnchanged() throws {
        // No capability: no display, so no console, and the offline refusal stands word for word.
        let console = ManagedRunnerLogic.console(status: nil, runnerID: Self.ownRunner, agentID: Self.ownWorkspace, isDraft: false)
        XCTAssertNil(console)
        let caps = ManagedRunnerLogic.sendCapabilities(Self.offline, acceptsWork: console?.display.acceptsWork ?? false)
        XCTAssertEqual(caps, Self.offline)
        XCTAssertEqual(ComposerLogic.availability(status: .succeeded, capabilities: caps), .blocked)
        XCTAssertEqual(ComposerLogic.blockedMessage(status: .succeeded, capabilities: caps), "The assigned runner is offline.")
    }

    func testTheLandingStillPicksTheWorkspaceAPersonHadFirst() {
        // The managed default workspace is created with no position, so the server lists it after
        // every workspace the account already had; the remembered and the first one still win.
        let managed = "2zQeDGWFFAgN2112jNTf8"
        var loaded = ListLoadState()
        loaded.succeed()
        XCTAssertEqual(LoadFailureLogic.defaultLanding(agents: loaded, orderedAgentIDs: [Self.ownWorkspace, managed],
                                                       lastAgentID: nil, section: .agents,
                                                       selectedAgentID: nil, selectedSessionID: nil),
                       .agent(Self.ownWorkspace))
        XCTAssertEqual(LoadFailureLogic.defaultLanding(agents: loaded, orderedAgentIDs: [Self.ownWorkspace, managed],
                                                       lastAgentID: managed, section: .agents,
                                                       selectedAgentID: nil, selectedSessionID: nil),
                       .agent(managed))
        // No workspace at all is Runners onboarding, as it always was.
        XCTAssertEqual(LoadFailureLogic.defaultLanding(agents: loaded, orderedAgentIDs: [], lastAgentID: nil,
                                                       section: .agents, selectedAgentID: nil, selectedSessionID: nil),
                       .runners)
    }

    // MARK: Machines & models and polling

    func testMachinesAndModelsOffersTheEntryToAnExistingAccountWhileTheServerDoes() throws {
        let setUp = try XCTUnwrap(ManagedRunnerLogic.display(Self.state("no mapping, offered")))
        // A new account keeps its one-click landing, and an existing account gets the entry (D1/D3).
        XCTAssertEqual(ManagedRunnerLogic.onboarding(setUp, runnerCount: 0)?.ensure, true)
        XCTAssertEqual(ManagedRunnerLogic.onboarding(setUp, runnerCount: 3)?.ensure, true)
        // With a mapping the managed runner is one machine row instead (D4), so no banner, however
        // many machines the account has.
        let preparing = ManagedRunnerLogic.display(try Self.state("preparing: requested"))
        XCTAssertNil(ManagedRunnerLogic.onboarding(preparing, runnerCount: 3))
        XCTAssertEqual(ManagedRunnerLogic.onboarding(preparing, runnerCount: 0)?.kind, .preparing)
        // D2: with nothing to do, an existing account sees nothing managed; a new one keeps today's
        // banner with its reason.
        let notOffered = ManagedRunnerLogic.display(try Self.state("no mapping, account not eligible"))
        XCTAssertNil(ManagedRunnerLogic.onboarding(notOffered, runnerCount: 3))
        XCTAssertEqual(ManagedRunnerLogic.onboarding(notOffered, runnerCount: 0)?.kind, .notOffered)
        XCTAssertNil(ManagedRunnerLogic.onboarding(nil, runnerCount: 0))
        XCTAssertNil(ManagedRunnerLogic.onboarding(nil, runnerCount: 3))
    }

    func testSetUpIsOfferedExactlyWhereTheServerOffersOne() throws {
        for entry in try Self.states() {
            let name = entry["name"] as? String ?? "?"
            let status = try Self.status(entry["status"])
            let display = ManagedRunnerLogic.display(status)
            // The switch off, another contract, or a state that is not NOT_PROVISIONED: no Set up.
            XCTAssertEqual(display?.ensure ?? false,
                           status.managementState == "NOT_PROVISIONED" && status.actions.canEnsure, name)
            // The entry follows ensure: a mapped managed runner is never offered Set up again.
            if display?.ensure != true { XCTAssertNil(ManagedRunnerLogic.onboarding(display, runnerCount: 3), name) }
        }
    }

    func testSetUpOnAnEstablishedAccountAsksFirst() {
        // New account: one click. A runner or a workspace already there: confirm (D3).
        XCTAssertFalse(ManagedRunnerLogic.confirmsSetup(runnerCount: 0, workspaceCount: 0))
        XCTAssertTrue(ManagedRunnerLogic.confirmsSetup(runnerCount: 1, workspaceCount: 0))
        XCTAssertTrue(ManagedRunnerLogic.confirmsSetup(runnerCount: 0, workspaceCount: 1))
        XCTAssertTrue(ManagedRunnerLogic.confirmsSetup(runnerCount: 2, workspaceCount: 5))
    }

    func testWithTheFeatureOffNoStateHasAMachineRow() throws {
        // A pre-feature server (no capability), the switch off, another contract, a malformed body:
        // every state reads as no managed UI, and so no row and no Set up anywhere.
        XCTAssertNil(ManagedRunnerLogic.row(runnerID: Self.ownRunner, status: nil))
        XCTAssertNil(ManagedRunnerLogic.row(runnerID: Self.ownRunner,
                                            status: try Self.state("switched off with a mapping left from before")))
        for entry in try Self.states() {
            let status = try Self.status(entry["status"])
            guard ManagedRunnerLogic.display(status) == nil else { continue }
            XCTAssertNil(ManagedRunnerLogic.row(runnerID: status.runnerId, status: status),
                         entry["name"] as? String ?? "?")
            XCTAssertNil(ManagedRunnerLogic.onboarding(ManagedRunnerLogic.display(status), runnerCount: 0))
        }
    }

    func testAMovingStateIsReadAgainSoonAndNothingWaitsForever() throws {
        XCTAssertEqual(ManagedRunnerLogic.refreshInterval(ManagedRunnerLogic.display(try Self.state("preparing: requested"))), 5)
        XCTAssertEqual(ManagedRunnerLogic.refreshInterval(ManagedRunnerLogic.display(try Self.state("sleeping"))), 30)
        XCTAssertEqual(ManagedRunnerLogic.refreshInterval(nil), 30)
    }
}
