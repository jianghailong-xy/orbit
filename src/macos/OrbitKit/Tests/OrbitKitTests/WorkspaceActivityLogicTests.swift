import XCTest
@testable import OrbitKit

final class WorkspaceActivityLogicTests: XCTestCase {
    private func session(_ id: String, state: SessionRunState, agentID: String? = nil,
                         nestedAgentID: String? = nil, approvals: Int = 0,
                         engineTurnActive: Bool = false, runningBgCount: Int = 0) -> Session {
        Session(id: id, title: nil, status: .cancelled, runState: state,
                agentId: agentID, assignedRunnerId: nil, pendingApprovals: approvals,
                branch: nil, updatedAt: nil, runningBgCount: runningBgCount,
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
}
