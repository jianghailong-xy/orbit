import Foundation
import XCTest
@testable import OrbitKit

/// The phone's way into a project's sessions (owner 2026-11-11, docs/mocks/project-sessions-column
/// board 5): a project row opens the coordinator's conversation; the coordinator's and every
/// member's navigation bar carries the project sessions button; a member picked in the sheet takes
/// the conversation's place, so Back returns to the list.
final class SessionProjectSheetTests: XCTestCase {
    private func session(_ id: String, project: String? = "p1", role: SessionProjectMembership.Role = .task,
                         kind: String? = nil) -> Session {
        Session(id: id, title: id, status: .awaitingInput, lifecycleState: .open,
                agentId: "w1", assignedRunnerId: nil, pendingApprovals: 0, branch: nil, updatedAt: nil,
                createdAt: "2026-11-11T08:00:00Z",
                projectMembership: project.map {
                    SessionProjectMembership(projectId: $0, projectTitle: "Search index",
                                             projectStatus: .open, role: role)
                },
                sessionKind: kind)
    }

    private func row(coordinator: Session?, target: SessionProjectRow.Target) -> SessionProjectRow {
        SessionProjectRow(projectId: "p1", title: "Search index", status: .open, members: [],
                          sessionCount: 11, coordinator: coordinator, folderId: nil, pinnedAt: nil,
                          lastTurnAt: nil, createdAt: nil, needsYou: false, running: false, jobs: false,
                          indicator: nil, line: SessionLine(text: "", tone: .preview), target: target,
                          taskCounts: nil, runningCount: 0)
    }

    // MARK: the row's tap

    func testARowTapOpensTheCoordinatorsConversation() {
        let coordinator = session("C1", role: .coordinator)
        XCTAssertEqual(SessionProjectSheet.rowTap(row(coordinator: coordinator, target: .project("p1"))),
                       .coordinator(coordinator))
    }

    /// The row's lead (a member waiting on the reader) is the menu's Open Session, not the tap's.
    func testARowTapOpensTheCoordinatorEvenWhenAMemberLeadsTheRow() {
        let coordinator = session("C1", role: .coordinator)
        XCTAssertEqual(SessionProjectSheet.rowTap(row(coordinator: coordinator, target: .session("T7"))),
                       .coordinator(coordinator))
    }

    func testARowWhoseCoordinatorIsNotHeldOpensTheSessionsPage() {
        XCTAssertEqual(SessionProjectSheet.rowTap(row(coordinator: nil, target: .project("p1"))), .sessions)
    }

    func testTheRowTapPushesTheCoordinatorOverTheList() {
        var nav = NavState(section: .agents)
        guard case .coordinator(let coordinator) = SessionProjectSheet.rowTap(
            row(coordinator: session("C1", role: .coordinator), target: .project("p1"))) else {
            return XCTFail("the row opens its coordinator")
        }

        nav.push(.console(sessionID: coordinator.id, origin: .list))

        XCTAssertEqual(nav.path, [.console(sessionID: "C1", origin: .list)])
        XCTAssertNil(nav.projectSessionsPage, "no project sessions page is pushed")
        XCTAssertNil(nav.projectSessionsColumn)
        nav.pop()
        XCTAssertTrue(nav.sectionAtRoot, "Back returns to the session list")
    }

    // MARK: the button

    func testTheCoordinatorsConversationCarriesTheButton() {
        XCTAssertEqual(SessionProjectSheet.projectID(of: session("C1", role: .coordinator)), "p1")
    }

    func testEveryMembersConversationCarriesTheButton() {
        for role in [SessionProjectMembership.Role.task, .context, .judgment, .child] {
            XCTAssertEqual(SessionProjectSheet.projectID(of: session("M", role: role)), "p1", "\(role)")
        }
    }

    func testAConversationInNoProjectOrALandingCarriesNone() {
        XCTAssertNil(SessionProjectSheet.projectID(of: session("loose", project: nil)))
        XCTAssertNil(SessionProjectSheet.projectID(of: session("L1", kind: "LANDING")))
        XCTAssertNil(SessionProjectSheet.projectID(of: nil))
    }

    func testTheButtonsWordsAndGlyph() {
        XCTAssertEqual(SessionProjectSheet.buttonLabel, "Project sessions")
        XCTAssertEqual(SessionProjectSheet.glyph, "square.grid.2x2")
    }

    func testTheCountIsThePagesOwnReadWithoutLandings() {
        let page = [session("C1", role: .coordinator), session("T1"), session("T2"), session("L1", kind: "LANDING")]
        XCTAssertEqual(SessionProjectSheet.sessionCount(projectID: "p1", page: ("p1", page), known: []), 3)
    }

    func testBeforeThePageReadTheCountIsTheMembersTheAppHolds() {
        let known = [session("C1", role: .coordinator), session("T1"), session("other", project: "p2"),
                     session("loose", project: nil)]
        XCTAssertEqual(SessionProjectSheet.sessionCount(projectID: "p1", page: nil, known: known), 2)
        XCTAssertEqual(SessionProjectSheet.sessionCount(projectID: "p1", page: ("p2", [session("x", project: "p2")]),
                                                        known: known), 2,
                       "another project's page is not this one's count")
    }

    // MARK: picking a member in the sheet

    func testAMemberPickedInTheSheetTakesTheCoordinatorsPlace() {
        var nav = NavState(section: .agents)
        nav.push(.console(sessionID: "C1", origin: .list))

        nav.switchConsole(to: .console(sessionID: "T7", origin: .list))

        XCTAssertEqual(nav.path, [.console(sessionID: "T7", origin: .list)])
        XCTAssertEqual(nav.focusedConsoleSessionID, "T7")
        nav.pop()
        XCTAssertTrue(nav.sectionAtRoot, "Back returns to the session list, not to the coordinator")
    }

    func testAMemberPickedOverAMembersConversationReplacesThatOne() {
        var nav = NavState(section: .agents)
        nav.push(.console(sessionID: "C1", origin: .list))
        nav.switchConsole(to: .console(sessionID: "T7", origin: .list))

        nav.switchConsole(to: .console(sessionID: "T8", origin: .list))

        XCTAssertEqual(nav.path, [.console(sessionID: "T8", origin: .list)])
    }

    func testAMemberPickedOverAFoldersCoordinatorReturnsToTheFolder() {
        let folder = SessionFolderAddress(folderID: "f1", agentID: "w1", view: .open)
        var nav = NavState(section: .agents)
        nav.enterFolder(folder)
        nav.push(.console(sessionID: "C1", origin: .list))

        nav.switchConsole(to: .console(sessionID: "T7", origin: .list))

        XCTAssertEqual(nav.path, [.folder(folder), .console(sessionID: "T7", origin: .list)])
        nav.pop()
        XCTAssertEqual(nav.folderPage, folder)
    }

    func testPickingTheConversationAlreadyShowingChangesNothing() {
        var nav = NavState(section: .agents)
        nav.push(.console(sessionID: "C1", origin: .list))

        nav.switchConsole(to: .console(sessionID: "C1", origin: .list))

        XCTAssertEqual(nav.path, [.console(sessionID: "C1", origin: .list)])
    }
}
