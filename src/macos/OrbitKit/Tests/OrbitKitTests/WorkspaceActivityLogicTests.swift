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

    func testJobWorkspaceIDsCountJobsButNotProcessesLeftRunning() {
        let ids = WorkspaceActivityLogic.jobWorkspaceIDs([
            // Two processes up, one of them a job: this workspace is doing work.
            session("job", state: .awaitingInput, agentID: "job",
                    runningBgCount: 2, runningBgJobCount: 1),
            // The same two processes, neither with an end: a dev server and a watcher, which is
            // the case the rail stayed silent about on purpose.
            session("service", state: .awaitingInput, agentID: "service", runningBgCount: 2),
            // Generating, with a job beside it: NOT in this set, because the set is read off the
            // same glyph the row draws and that glyph is the working spinner. The rail's `running`
            // outranks `jobs` in the same slot, so the two can never disagree about one workspace.
            session("generating", state: .running, agentID: "generating",
                    engineTurnActive: false, runningBgCount: 1, runningBgJobCount: 1),
            // Jobs belong to live work only: the server clears them as a session ends, and an
            // ended session must not light the rail whatever the snapshot says.
            session("ended", state: .ended, agentID: "ended",
                    runningBgCount: 1, runningBgJobCount: 1),
            session("idle", state: .awaitingInput, agentID: "idle"),
        ])

        XCTAssertEqual(ids, ["job"])
    }

    func testWorkspaceNavigationStatusPutsRunningAboveJobsAndOfflineAboveBoth() {
        XCTAssertEqual(WorkspaceNavigationStatusLogic.resolve(
            waiting: 0, running: true, jobs: true, runnerOffline: false), .running)
        XCTAssertEqual(WorkspaceNavigationStatusLogic.resolve(
            waiting: 0, running: false, jobs: true, runnerOffline: false), .jobs)
        XCTAssertEqual(WorkspaceNavigationStatusLogic.resolve(
            waiting: 0, running: false, jobs: true, runnerOffline: true), .idle)
        XCTAssertEqual(WorkspaceNavigationStatusLogic.resolve(
            waiting: 1, running: false, jobs: true, runnerOffline: false), .needsYou(1))
        // Absent entirely: a caller that predates the mark keeps the old reading.
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
}
