import Foundation
import XCTest
@testable import OrbitKit

/// Dragging a session row onto a folder on the Mac (`SessionFolderDrag`): which drops file the
/// session, which are where it already is, which are refused; which rows can be picked up; and how
/// a drag held near the list's edge scrolls it.
final class SessionFolderDragTests: XCTestCase {
    private let known: Set<String> = ["release", "wiki"]

    private func session(_ id: String, folder: String? = nil,
                         role: SessionProjectMembership.Role? = nil) -> Session {
        Session(id: id, title: id, status: .awaitingInput, agentId: "w1", assignedRunnerId: nil,
                pendingApprovals: 0, branch: nil, updatedAt: nil, folderId: folder,
                projectMembership: role.map {
                    SessionProjectMembership(projectId: "p1", projectTitle: "Launch", projectStatus: .open, role: $0)
                })
    }

    private func verdict(from folder: String?, to target: String?, in workspace: String = "w1") -> SessionFolderDrag.Verdict {
        SessionFolderDrag.verdict(sessionWorkspaceID: "w1", sessionFolderID: folder,
                                  targetWorkspaceID: workspace, targetFolderID: target, knownFolderIDs: known)
    }

    func testFilesASessionInAnotherFolderOfItsWorkspaceOrOutToNoFolder() {
        XCTAssertEqual(verdict(from: nil, to: "wiki"), .move)
        XCTAssertEqual(verdict(from: "release", to: "wiki"), .move)
        XCTAssertEqual(verdict(from: "release", to: nil), .move)
    }

    func testTakesNoDropOnTheFolderTheSessionIsAlreadyIn() {
        XCTAssertEqual(verdict(from: "release", to: "release"), .here)
        XCTAssertEqual(verdict(from: nil, to: nil), .here)
        // A folder deleted since the list was read is no folder, where the list draws the session.
        XCTAssertEqual(verdict(from: "gone", to: nil), .here)
        XCTAssertEqual(verdict(from: "gone", to: "wiki"), .move)
    }

    func testRefusesAnotherWorkspaceAndAFolderThatIsNotTheWorkspaces() {
        XCTAssertEqual(verdict(from: nil, to: "wiki", in: "w2"), .refused)
        XCTAssertEqual(verdict(from: nil, to: nil, in: "w2"), .refused)
        XCTAssertEqual(verdict(from: nil, to: "elsewhere"), .refused)
    }

    func testPicksUpWhatTheMovePanelWouldFileWhereThereIsSomewhereToDropIt() {
        XCTAssertTrue(SessionFolderDrag.draggable(session("s"), view: .open, hasProjectMark: false, dropTargets: true))
        XCTAssertTrue(SessionFolderDrag.draggable(session("s"), view: .completed, hasProjectMark: false, dropTargets: true))
        // A member whose project has no row here is filed by its own folder, as the panel files it.
        XCTAssertTrue(SessionFolderDrag.draggable(session("s", role: .task), view: .open, hasProjectMark: true,
                                                  dropTargets: true))
    }

    func testPicksUpAProjectRowByItsCoordinator() {
        let coordinator = session("c", role: .coordinator)
        XCTAssertTrue(SessionFolderDrag.draggable(coordinator, view: .open, hasProjectMark: false, dropTargets: true))
        XCTAssertTrue(SessionFolderDrag.draggable(projectCoordinator: coordinator, view: .open, dropTargets: true))
        XCTAssertTrue(SessionFolderDrag.draggable(projectCoordinator: coordinator, view: .completed, dropTargets: true))
        XCTAssertFalse(SessionFolderDrag.draggable(projectCoordinator: nil, view: .open, dropTargets: true),
                       "no coordinator, no Move, no drag")
        XCTAssertFalse(SessionFolderDrag.draggable(projectCoordinator: coordinator, view: .trash, dropTargets: true))
        XCTAssertFalse(SessionFolderDrag.draggable(projectCoordinator: coordinator, view: .open, dropTargets: false))
    }

    func testLeavesMembersTrashAndListsWithoutFoldersAlone() {
        XCTAssertFalse(SessionFolderDrag.draggable(session("s", role: .task), view: .open,
                                                   hasProjectMark: false, dropTargets: true))
        XCTAssertFalse(SessionFolderDrag.draggable(session("s"), view: .trash, hasProjectMark: false, dropTargets: true))
        XCTAssertFalse(SessionFolderDrag.draggable(session("s"), view: .open, hasProjectMark: false, dropTargets: false))
    }

    func testScrollsNearTheEdgesFasterCloserToThem() {
        let step = { (y: Double) in SessionFolderDrag.edgeScrollStep(pointerY: y, top: 100, bottom: 600) }
        XCTAssertLessThan(step(102), 0)
        XCTAssertGreaterThan(step(598), 0)
        XCTAssertGreaterThan(abs(step(101)), abs(step(140)))
        XCTAssertGreaterThan(step(599), step(560))
        XCTAssertEqual(step(350), 0)
        XCTAssertEqual(step(50), 0, "outside the list")
        XCTAssertEqual(step(700), 0, "outside the list")
        XCTAssertEqual(SessionFolderDrag.edgeScrollStep(pointerY: 0, top: 0, bottom: 0), 0)
    }
}
