import XCTest
@testable import OrbitKit

final class WorkspaceActivityLogicTests: XCTestCase {
    private func session(_ id: String, state: SessionRunState, agentID: String? = nil,
                         nestedAgentID: String? = nil, approvals: Int = 0,
                         engineTurnActive: Bool = false, runningBgCount: Int = 0,
                         runningBgJobCount: Int = 0) -> Session {
        Session(id: id, title: nil, status: .cancelled, runState: state,
                agentId: agentID, assignedRunnerId: nil, pendingApprovals: approvals,
                branch: nil, updatedAt: nil, runningBgCount: runningBgCount,
                runningBgJobCount: runningBgJobCount,
                engineTurnActive: engineTurnActive,
                agent: nestedAgentID.map {
                    SessionAgentRef(id: $0, name: nil, provider: nil, model: nil, effort: nil)
                })
    }

    func testRunningWorkspaceIDsUsesTheSessionSpinnerDefinition() {
        let ids = WorkspaceActivityLogic.runningWorkspaceIDs([
            session("running", state: .running, agentID: "running"),
            session("self-driven", state: .awaitingInput, agentID: "self-driven",
                    engineTurnActive: true),
            session("waiting", state: .awaitingInput, agentID: "waiting"),
            session("background", state: .awaitingInput, agentID: "background",
                    runningBgCount: 2),
            session("queued", state: .queued, agentID: "queued"),
            session("approval", state: .running, agentID: "approval", approvals: 1),
        ])

        XCTAssertEqual(ids, ["running", "self-driven"])
    }

    func testRunningWorkspaceIDsPrefersNestedOwnerAndFallsBackToFlatID() {
        let ids = WorkspaceActivityLogic.runningWorkspaceIDs([
            session("nested", state: .running, agentID: "stale", nestedAgentID: "nested"),
            session("flat", state: .running, agentID: "flat"),
            session("ownerless", state: .running),
        ])

        XCTAssertEqual(ids, ["nested", "flat"])
    }

    func testRunningWorkspaceIDsDeduplicatesMultipleSessions() {
        XCTAssertEqual(WorkspaceActivityLogic.runningWorkspaceIDs([
            session("one", state: .running, agentID: "workspace"),
            session("two", state: .running, agentID: "workspace"),
        ]), ["workspace"])
    }

    func testRunningWorkspaceIDsCountJobsButNotProcessesLeftRunning() {
        let ids = WorkspaceActivityLogic.runningWorkspaceIDs([
            // Two processes up, one of them a job: this workspace is doing work.
            session("job", state: .awaitingInput, agentID: "job",
                    runningBgCount: 2, runningBgJobCount: 1),
            // The same two processes, neither with an end: a dev server and a watcher, which is
            // the case the rail stayed silent about on purpose.
            session("service", state: .awaitingInput, agentID: "service", runningBgCount: 2),
            // Generating, with a job beside it.
            session("generating", state: .running, agentID: "generating",
                    engineTurnActive: false, runningBgCount: 1, runningBgJobCount: 1),
            // Jobs belong to live work only: the server clears them as a session ends, and an
            // ended session must not light the rail whatever the snapshot says.
            session("ended", state: .ended, agentID: "ended",
                    runningBgCount: 1, runningBgJobCount: 1),
            session("idle", state: .awaitingInput, agentID: "idle"),
        ])

        XCTAssertEqual(ids, ["job", "generating"])
    }

    func testWorkspaceNavigationStatusPutsWaitingAboveRunningAndOfflineAboveRunning() {
        XCTAssertEqual(WorkspaceNavigationStatusLogic.resolve(
            waiting: 0, running: true, runnerOffline: false), .running)
        XCTAssertEqual(WorkspaceNavigationStatusLogic.resolve(
            waiting: 0, running: true, runnerOffline: true), .idle)
        XCTAssertEqual(WorkspaceNavigationStatusLogic.resolve(
            waiting: 1, running: true, runnerOffline: false), .needsYou(1))
        XCTAssertEqual(WorkspaceNavigationStatusLogic.resolve(
            waiting: 0, running: false, runnerOffline: false), .idle)
    }

    func testRunnerOfflineRequiresAnExplicitOfflineSnapshot() {
        let availability = ["online": true, "offline": false]

        XCTAssertFalse(WorkspaceRunnerAvailabilityLogic.isOffline(
            runnerID: nil, onlineByRunnerID: availability))
        XCTAssertFalse(WorkspaceRunnerAvailabilityLogic.isOffline(
            runnerID: "not-loaded", onlineByRunnerID: availability))
        XCTAssertFalse(WorkspaceRunnerAvailabilityLogic.isOffline(
            runnerID: "online", onlineByRunnerID: availability))
        XCTAssertTrue(WorkspaceRunnerAvailabilityLogic.isOffline(
            runnerID: "offline", onlineByRunnerID: availability))
    }

    func testRunnerOnlineValuePreservesUnknownAndTreatsDrainingAsConnected() {
        XCTAssertNil(WorkspaceRunnerAvailabilityLogic.onlineValue(explicit: nil, status: nil))
        XCTAssertEqual(WorkspaceRunnerAvailabilityLogic.onlineValue(
            explicit: nil, status: .online), true)
        XCTAssertEqual(WorkspaceRunnerAvailabilityLogic.onlineValue(
            explicit: nil, status: .draining), true)
        XCTAssertEqual(WorkspaceRunnerAvailabilityLogic.onlineValue(
            explicit: nil, status: .offline), false)

        // The newer explicit field is authoritative even when legacy status disagrees.
        XCTAssertEqual(WorkspaceRunnerAvailabilityLogic.onlineValue(
            explicit: false, status: .online), false)
        XCTAssertEqual(WorkspaceRunnerAvailabilityLogic.onlineValue(
            explicit: true, status: .offline), true)
    }

    func testWorkspaceNavigationStatusPrioritizesAttentionOverRunning() {
        XCTAssertEqual(WorkspaceNavigationStatusLogic.resolve(
            waiting: 2, running: true, runnerOffline: false), .needsYou(2))
        XCTAssertEqual(WorkspaceNavigationStatusLogic.resolve(
            waiting: 2, running: true, runnerOffline: true), .needsYou(2))
    }

    func testWorkspaceNavigationStatusSuppressesOfflineSpinner() {
        XCTAssertEqual(WorkspaceNavigationStatusLogic.resolve(
            waiting: 0, running: true, runnerOffline: false), .running)
        XCTAssertEqual(WorkspaceNavigationStatusLogic.resolve(
            waiting: 0, running: true, runnerOffline: true), .idle)
        XCTAssertEqual(WorkspaceNavigationStatusLogic.resolve(
            waiting: 0, running: false, runnerOffline: false), .idle)
    }
    /// The row a folder and its workspace stayed idle over (2026-11-28): parked, with one background
    /// job gone quiet. Its row spins on `phase` RUNNING, so its folder and its workspace spin too.
    func testWithTheSessionFactsPhaseDecidesLikeTheRow() throws {
        let quietJob = try JSONDecoder().decode(Session.self, from: Data(#"""
        {"id":"s1","status":"AWAITING_INPUT","runState":"AWAITING_INPUT","phase":"RUNNING","released":false,
         "lastTurnOutcome":"ANSWERED","activity":"BACKGROUND_JOB","runningBgCount":1,"runningBgJobCount":0,
         "agentId":"w1","folderId":"f1"}
        """#.utf8))
        XCTAssertTrue(WorkspaceActivityLogic.isRunning(quietJob))
        XCTAssertEqual(WorkspaceActivityLogic.runningWorkspaceIDs([quietJob]), ["w1"])
        XCTAssertEqual(SessionFolderGrouping.status(of: [quietJob], runnerOffline: false), .running)

        // Generating by the legacy fields, IDLE by the facts: the facts win, as on the row.
        let idle = try JSONDecoder().decode(Session.self, from: Data(#"""
        {"id":"s2","status":"RUNNING","runState":"RUNNING","phase":"IDLE","released":false,"agentId":"w1"}
        """#.utf8))
        XCTAssertFalse(WorkspaceActivityLogic.isRunning(idle))
    }
}
