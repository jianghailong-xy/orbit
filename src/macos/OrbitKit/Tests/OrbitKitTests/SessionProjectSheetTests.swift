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

    private func completed(_ id: String) -> Session {
        Session(id: id, title: id, status: .awaitingInput, lifecycleState: .completed,
                agentId: "w1", assignedRunnerId: nil, pendingApprovals: 0, branch: nil, updatedAt: nil,
                createdAt: "2026-11-10T08:00:00Z",
                projectMembership: SessionProjectMembership(projectId: "p1", projectTitle: "Search index",
                                                            projectStatus: .open, role: .task))
    }

    /// The page's read: Open and Completed members, landings left out.
    func testTheCountIsThePagesOwnReadOfOpenAndCompletedMembersWithoutLandings() {
        let page = [session("C1", role: .coordinator), session("T1"), completed("T6"), session("L1", kind: "LANDING")]
        XCTAssertEqual(SessionProjectSheet.sessionCount(projectID: "p1", page: ("p1", page), answered: true), 3)
    }

    /// Before the read answers there is no count. The app's lists hold only the Open members, and a
    /// count taken from them would change when the sheet opened (5 → 6 on the simulator, sent back
    /// on revision 1).
    func testNoCountBeforeThePagesReadHasAnswered() {
        let page = [session("C1", role: .coordinator), session("T1")]
        XCTAssertNil(SessionProjectSheet.sessionCount(projectID: "p1", page: ("p1", page), answered: false))
        XCTAssertNil(SessionProjectSheet.sessionCount(projectID: "p1", page: nil, answered: true))
        XCTAssertNil(SessionProjectSheet.sessionCount(projectID: "p1", page: ("p2", [session("x", project: "p2")]),
                                                      answered: true),
                     "another project's page is not this one's count")
    }

    /// The button's count and the page header's ("Project · N sessions") are one read, taken before the
    /// sheet is ever presented: the conversation reads the very address the sheet will open
    /// (`SessionProjectSheet.address`), so opening it changes neither number.
    func testTheButtonsCountEqualsThePageHeadersBeforeTheSheetIsPresented() {
        let coordinator = session("C1", role: .coordinator)
        // The conversation appears: no page is held yet, so it reads a new address from its workspace.
        let address = SessionProjectSheet.address(projectID: "p1", shown: nil, agentID: "w1")
        XCTAssertEqual(address, SessionProjectAddress(projectID: "p1", agentID: "w1", view: .open))
        // The read answers with the Open and the Completed members (and a landing row).
        let read: (projectID: String, sessions: [Session]) =
            (address.projectID, [coordinator, session("T7"), session("T8"), completed("T6"), session("L1", kind: "LANDING")])
        let button = SessionProjectSheet.sessionCount(projectID: SessionProjectSheet.projectID(of: coordinator)!,
                                                      page: read, answered: true)
        XCTAssertEqual(button, 4)
        // The sheet opens on the same address, so its header reads the same state.
        let sheetAddress = SessionProjectSheet.address(projectID: "p1", shown: address, agentID: "w9")
        XCTAssertEqual(sheetAddress, address, "the sheet opens the page the conversation already read")
        let header = SessionProjectSheet.sessionCount(projectID: sheetAddress.projectID, page: read, answered: true)
        XCTAssertEqual(header, button)
        XCTAssertEqual(header.map { SessionProjectCopy.pageSubtitle(sessions: $0) }, "Project · 4 sessions")
    }

    /// A page already held for the project (one a phone pushed, with its Completed view) is the one
    /// the button reads and opens: a second address would drop that page's read.
    func testTheButtonReadsThePageAlreadyHeldForItsProject() {
        let held = SessionProjectAddress(projectID: "P1", agentID: "w2", view: .completed)
        XCTAssertEqual(SessionProjectSheet.address(projectID: "p1", shown: held, agentID: "w1"), held,
                       "either spelling of the id is the same project")
        let other = SessionProjectAddress(projectID: "p2", agentID: "w2", view: .open)
        XCTAssertEqual(SessionProjectSheet.address(projectID: "p1", shown: other, agentID: "w1"),
                       SessionProjectAddress(projectID: "p1", agentID: "w1", view: .open))
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
