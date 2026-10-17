import XCTest
@testable import OrbitKit

/// The project sessions page shares the folder's stack/column behavior (design §5), and carries
/// the originating workspace and view while its sessions can belong to any workspace.
final class SessionProjectNavigationTests: XCTestCase {
    private let project = SessionProjectAddress(projectID: "p1", agentID: "a1", view: .open)
    private let other = SessionProjectAddress(projectID: "p2", agentID: "a1", view: .open)
    private let folder = SessionFolderAddress(folderID: "f1", agentID: "a1", view: .open)

    func testEnteringFromTheWorkspacePushesTheProjectPage() {
        var nav = NavState(section: .agents)

        nav.enterProjectSessions(project)

        XCTAssertEqual(nav.path, [.sessionProject(project)])
        XCTAssertEqual(nav.projectSessionsPage, project)
        XCTAssertEqual(nav.projectSessionsColumn, project)
        XCTAssertFalse(nav.sectionAtRoot)
        nav.pop()
        XCTAssertTrue(nav.sectionAtRoot)
    }

    func testEnteringFromAFolderReturnsToThatFolderOnBack() {
        var nav = NavState(section: .agents)
        nav.enterFolder(folder)

        nav.enterProjectSessions(project)

        XCTAssertEqual(nav.path, [.folder(folder), .sessionProject(project)])
        XCTAssertEqual(nav.folderColumn, folder)
        XCTAssertEqual(nav.projectSessionsPage, project)
        nav.pop()
        XCTAssertEqual(nav.folderPage, folder)
        XCTAssertNil(nav.projectSessionsColumn)
    }

    func testEnteringKeepsTheIPadDetailConsole() {
        var nav = NavState(section: .agents)
        nav.selectConsole(.console(sessionID: "s1", origin: .list))

        nav.enterProjectSessions(project)

        XCTAssertEqual(nav.path, [.sessionProject(project), .console(sessionID: "s1", origin: .list)])
        XCTAssertNil(nav.projectSessionsPage)
        XCTAssertEqual(nav.projectSessionsColumn, project)
        XCTAssertEqual(nav.focusedConsoleSessionID, "s1")
    }

    func testEnteringUnderAConsoleKeepsItsFolderBeneathTheProject() {
        var nav = NavState(section: .agents)
        nav.enterFolder(folder)
        nav.selectConsole(.console(sessionID: "s1", origin: .list))

        nav.enterProjectSessions(project)

        XCTAssertEqual(nav.path, [.folder(folder), .sessionProject(project),
                                  .console(sessionID: "s1", origin: .list)])
        XCTAssertEqual(nav.folderColumn, folder)
        XCTAssertEqual(nav.projectSessionsColumn, project)
    }

    func testEnteringAnotherProjectReplacesOnlyTheProjectPage() {
        var nav = NavState(section: .agents)
        nav.enterFolder(folder)
        nav.enterProjectSessions(project)
        nav.selectConsole(.console(sessionID: "s1", origin: .list))

        nav.enterProjectSessions(other)

        XCTAssertEqual(nav.path, [.folder(folder), .sessionProject(other),
                                  .console(sessionID: "s1", origin: .list)])
    }

    func testSelectingAConsolePreservesTheProjectAndReplacesThePreviousConsole() {
        var nav = NavState(section: .agents)
        nav.enterProjectSessions(project)

        nav.selectConsole(.console(sessionID: "s1", origin: .list))
        XCTAssertEqual(nav.path, [.sessionProject(project), .console(sessionID: "s1", origin: .list)])
        nav.selectConsole(.console(sessionID: "s2", origin: .list))
        XCTAssertEqual(nav.path, [.sessionProject(project), .console(sessionID: "s2", origin: .list)])
        nav.pop()
        XCTAssertEqual(nav.projectSessionsPage, project)
        XCTAssertNil(nav.focusedConsoleSessionID)
    }

    func testLeavingKeepsTheFolderAndTheConsole() {
        var nav = NavState(section: .agents)
        nav.enterFolder(folder)
        nav.enterProjectSessions(project)
        nav.selectConsole(.console(sessionID: "s1", origin: .list))

        nav.leaveProjectSessions(other.projectID)
        XCTAssertEqual(nav.projectSessionsColumn, project, "another project's departure cannot close this page")
        nav.leaveProjectSessions(project.projectID)

        XCTAssertEqual(nav.path, [.folder(folder), .console(sessionID: "s1", origin: .list)])
        XCTAssertNil(nav.projectSessionsColumn)
        XCTAssertEqual(nav.focusedConsoleSessionID, "s1")
    }

    func testEnteringAFolderClosesThePreviousProjectList() {
        var nav = NavState(section: .agents)
        nav.enterProjectSessions(project)
        nav.selectConsole(.console(sessionID: "s1", origin: .list))

        nav.enterFolder(folder)

        XCTAssertEqual(nav.path, [.folder(folder), .console(sessionID: "s1", origin: .list)])
        XCTAssertNil(nav.projectSessionsColumn)
    }

    func testAddressCarriesTheOriginatingWorkspaceAndCompletedScope() {
        let completed = SessionProjectAddress(projectID: project.projectID, agentID: "a2", view: .completed)
        var nav = NavState(section: .agents)

        nav.enterProjectSessions(completed)

        XCTAssertEqual(nav.projectSessionsPage?.agentID, "a2")
        XCTAssertEqual(nav.projectSessionsPage?.view, .completed)
        XCTAssertNotEqual(nav.projectSessionsPage, project)
    }

    func testProjectPageSurvivesASectionSwitch() {
        var nav = NavState(section: .agents)
        nav.enterProjectSessions(project)

        nav.section = .tasks
        XCTAssertNil(nav.projectSessionsColumn)
        nav.section = .agents

        XCTAssertEqual(nav.projectSessionsPage, project)
    }
}
