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
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var source: URL?
        for _ in 0..<12 {
            let candidate = directory.appendingPathComponent("src/shared/src/managed-runner-states.fixture.json")
            if FileManager.default.fileExists(atPath: candidate.path) { source = candidate; break }
            directory.deleteLastPathComponent()
        }
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: XCTUnwrap(source))) as? [String: Any]
        let states = try XCTUnwrap(object?["states"] as? [[String: Any]])
        let entry = try XCTUnwrap(states.first { $0["name"] as? String == name }, name)
        let data = try JSONSerialization.data(withJSONObject: XCTUnwrap(entry["status"]))
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

    func testBeforeTheRunnerWasEverReadyItsDefaultWorkspaceHasNoEngineForAFirstSession() throws {
        for name in ["preparing: starting", "model unavailable: started without a signed-in runtime",
                     "waiting for capacity before the first start", "failed: retryable"] {
            let status = try Self.state(name)
            let draft = try XCTUnwrap(ManagedRunnerLogic.console(status: status, runnerID: status.runnerId,
                                                                 agentID: status.workspaceId, isDraft: true), name)
            XCTAssertTrue(draft.blocksNewSession, name)
            // An existing session there, and a draft in another workspace on the runner, are not drafts of a first session.
            XCTAssertFalse(try XCTUnwrap(ManagedRunnerLogic.console(status: status, runnerID: status.runnerId,
                                                                    agentID: status.workspaceId, isDraft: false)).blocksNewSession)
            XCTAssertFalse(try XCTUnwrap(ManagedRunnerLogic.console(status: status, runnerID: status.runnerId,
                                                                    agentID: Self.ownWorkspace, isDraft: true)).blocksNewSession)
        }
    }

    func testOnceItHasBeenReadyAFirstSessionStartsEvenWhileItSleeps() throws {
        for name in ["available", "sleeping", "waking: a message asked the sleeping runner", "waking: starting again"] {
            let status = try Self.state(name)
            XCTAssertNotNil(status.initialProvider, name)
            XCTAssertEqual(ManagedRunnerLogic.console(status: status, runnerID: status.runnerId, agentID: status.workspaceId,
                                                      isDraft: true)?.blocksNewSession, false, name)
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

    // MARK: Infrastructure and polling

    func testInfrastructureShowsTheManagedRunnerOnlyToAnAccountWithNoRunner() throws {
        let setUp = try XCTUnwrap(ManagedRunnerLogic.display(Self.state("no mapping, offered")))
        XCTAssertEqual(ManagedRunnerLogic.onboarding(setUp, runnerCount: 0)?.ensure, true)
        XCTAssertNil(ManagedRunnerLogic.onboarding(setUp, runnerCount: 1))
        XCTAssertNil(ManagedRunnerLogic.onboarding(nil, runnerCount: 0))
    }

    func testAMovingStateIsReadAgainSoonAndNothingWaitsForever() throws {
        XCTAssertEqual(ManagedRunnerLogic.refreshInterval(ManagedRunnerLogic.display(try Self.state("preparing: requested"))), 5)
        XCTAssertEqual(ManagedRunnerLogic.refreshInterval(ManagedRunnerLogic.display(try Self.state("sleeping"))), 30)
        XCTAssertEqual(ManagedRunnerLogic.refreshInterval(nil), 30)
    }
}
