import Foundation
import XCTest
@testable import OrbitKit

/// The project sessions page's members (design §5): what the page opens on out of what the app
/// already holds, before any read of its own has answered, and what a poll makes of the app's Open
/// list without asking for either list again.
final class SessionProjectMembersTests: XCTestCase {
    private func session(_ id: String, project: String? = "p1", role: SessionProjectMembership.Role = .task,
                         workspace: String = "w1", lifecycle: SessionLifecycleState = .open,
                         lastTurnAt: String? = nil, title: String? = nil) -> Session {
        Session(id: id, title: title ?? id, status: .awaitingInput, lifecycleState: lifecycle,
                agentId: workspace, assignedRunnerId: nil, pendingApprovals: 0, branch: nil, updatedAt: nil,
                createdAt: "2026-10-06T08:00:00Z", lastTurnAt: lastTurnAt,
                projectMembership: project.map {
                    SessionProjectMembership(projectId: $0, projectTitle: "Project one",
                                             projectStatus: .open, role: role)
                })
    }

    /// Tapping a project's row, the app holds its Open list (every Workspace) and the workspace
    /// list it was tapped in: the page has its members from them before it has read anything.
    func testThePageOpensOnTheMembersTheAppAlreadyHolds() {
        let openList = [
            session("coordinator", role: .coordinator, workspace: "w1", lastTurnAt: "2026-10-06T09:00:00Z"),
            session("other-project", project: "p2", lastTurnAt: "2026-10-06T09:59:00Z"),
            session("loose", project: nil, lastTurnAt: "2026-10-06T09:58:00Z"),
            session("worker", workspace: "w2", lastTurnAt: "2026-10-06T09:30:00Z"),
        ]
        let workspaceList = [
            session("done", lifecycle: .completed, lastTurnAt: "2026-10-06T07:00:00Z"),
            session("trashed", lifecycle: .trash, lastTurnAt: "2026-10-06T09:50:00Z"),
        ]

        let members = SessionProjectMembers.members(of: "p1", in: openList + workspaceList)

        XCTAssertEqual(members.map(\.id), ["worker", "coordinator", "done"],
                       "every Workspace's members, Open and Completed, never Trash, newest first")
    }

    /// The page opens on as many sessions as the row it was opened from counted, and on its
    /// coordinator: the row's members and the account's Open list are both in hand.
    func testThePageOpensOnAsManySessionsAsItsListRowCounts() throws {
        let account = [
            session("coordinator", role: .coordinator, workspace: "w1", lastTurnAt: "2026-10-06T09:00:00Z"),
            session("worker", workspace: "w2", lastTurnAt: "2026-10-06T09:30:00Z"),
            session("helper", workspace: "w1", lastTurnAt: "2026-10-06T09:10:00Z"),
            session("loose", project: nil),
        ]
        let shown = account.filter { $0.agentId == "w1" }
        let row = try XCTUnwrap(SessionProjectGrouping.listing(shown, folders: [], projects: [], view: .open,
                                                               byTag: false, contentSessions: account).projects.first)

        let members = SessionProjectMembers.members(of: row.projectId, in: account + shown)

        XCTAssertFalse(members.isEmpty)
        XCTAssertEqual(members.count, row.sessionCount)
        XCTAssertTrue(Set(row.members.map(\.id)).isSubset(of: members.map(\.id)))
        XCTAssertEqual(members.first { $0.projectMembership?.role == .coordinator }?.id, row.coordinator?.id)
    }

    /// The first copy of a session wins, so the freshest list goes first.
    func testTheFirstCopyOfASessionWins() {
        let fresh = session("worker", lastTurnAt: "2026-10-06T09:30:00Z", title: "fresh")
        let stale = session("worker", lifecycle: .completed, lastTurnAt: "2026-10-06T08:00:00Z", title: "stale")

        XCTAssertEqual(SessionProjectMembers.members(of: "p1", in: [fresh, stale]).map(\.title), ["fresh"])
    }

    /// An address may carry either spelling of the project's id.
    func testEitherSpellingOfTheProjectIDFindsItsMembers() {
        let uuid = "0f8fad5b-d9cb-469f-a165-70867728950e"
        let publicID = PublicID.toPublic(uuid)

        XCTAssertEqual(SessionProjectMembers.members(of: uuid, in: [session("a", project: publicID)]).map(\.id), ["a"])
        XCTAssertEqual(SessionProjectMembers.members(of: publicID, in: [session("b", project: uuid)]).map(\.id), ["b"])
    }

    /// A poll's Open members are the app's Open list's, as it has them now, and its Completed ones
    /// the last read's: neither list is asked for again.
    func testAPollTakesTheOpenMembersFromTheOpenListAndKeepsTheCompletedRead() {
        let done = session("done", lifecycle: .completed, lastTurnAt: "2026-10-06T07:00:00Z")
        let shown = [session("worker", lastTurnAt: "2026-10-06T09:00:00Z"), done]
        let openList = [session("worker", lastTurnAt: "2026-10-06T09:45:00Z", title: "worker, later"),
                        session("new", lastTurnAt: "2026-10-06T09:50:00Z"),
                        session("elsewhere", project: "p2")]

        let poll = SessionProjectMembers.poll(shown: shown, projectID: "p1", openList: openList, completed: [done])

        XCTAssertEqual(poll.members.map(\.title), ["new", "worker, later", "done"])
        XCTAssertFalse(poll.moved)
    }

    /// A member the page shows as Open that the Open list no longer has was completed, trashed or
    /// taken out of the project. It stays as it was shown, and the poll asks for the Completed list.
    func testAMemberThatLeftTheOpenListStaysUntilTheCompletedListIsRead() {
        let coordinator = session("coordinator", role: .coordinator, lastTurnAt: "2026-10-06T08:00:00Z")
        let shown = [session("worker", lastTurnAt: "2026-10-06T09:00:00Z"), coordinator]

        let poll = SessionProjectMembers.poll(shown: shown, projectID: "p1", openList: [coordinator], completed: [])

        XCTAssertEqual(poll.members.map(\.id), ["worker", "coordinator"])
        XCTAssertTrue(poll.moved)
    }

    /// A Completed member restored to Open is drawn once, as the Open list has it.
    func testACompletedMemberBackInTheOpenListIsShownOnceAsOpen() {
        let completed = session("worker", lifecycle: .completed)

        let poll = SessionProjectMembers.poll(shown: [completed], projectID: "p1",
                                              openList: [session("worker")], completed: [completed])

        XCTAssertEqual(poll.members.map(\.id), ["worker"])
        XCTAssertEqual(poll.members.first?.effectiveLifecycleState, .open)
        XCTAssertFalse(poll.moved)
    }
}
