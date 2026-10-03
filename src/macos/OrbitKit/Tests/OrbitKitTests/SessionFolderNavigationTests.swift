import XCTest
@testable import OrbitKit

/// A folder's page on the Agents stack (docs/session-folders-move-design.md §3.3): the frame it is,
/// the two reads the two shells make of it, and the transitions it takes part in — entering from a
/// workspace's list, leaving (the wide shell's back button, or a folder deleted under the page), a
/// draft opened over it, and a console selected while it is showing.
final class SessionFolderNavigationTests: XCTestCase {
    private let release = SessionFolderAddress(folderID: "f1", agentID: "a1", view: .open)
    private let polish = SessionFolderAddress(folderID: "f2", agentID: "a1", view: .open)

    /// Entering from the workspace's list: the folder is the frame at the bottom of the stack, which
    /// on a phone (nothing else pushed) is the page on top.
    func testEnteringAFolderFromTheListPutsItsPageOnTop() {
        var nav = NavState(section: .agents)
        XCTAssertTrue(nav.sectionAtRoot)

        nav.enterFolder(release)

        XCTAssertEqual(nav.path, [.folder(release)])
        XCTAssertEqual(nav.folderPage, release, "a phone's folder page is the top frame")
        XCTAssertEqual(nav.folderColumn, release, "and a wide shell's column draws it")
        XCTAssertFalse(nav.sectionAtRoot, "a pushed page keeps the left edge for the back swipe")
    }

    /// The wide shells' shape: the detail pane is showing a session's console, and the folder opens
    /// under it — the column draws the folder, the pane keeps the console it had (§3.3).
    func testEnteringAFolderKeepsTheConsoleTheDetailPaneIsShowing() {
        var nav = NavState(section: .agents)
        nav.replaceTop(with: .console(sessionID: "s1", origin: .list))

        nav.enterFolder(release)

        XCTAssertEqual(nav.path, [.folder(release), .console(sessionID: "s1", origin: .list)])
        XCTAssertEqual(nav.folderColumn, release, "the column's list draws the folder")
        XCTAssertNil(nav.folderPage, "the page on top is still the console")
        XCTAssertEqual(nav.focusedConsoleSessionID, "s1", "and it goes on streaming")
    }

    /// One folder's page at a time: entering another leaves the first behind rather than stacking
    /// two lists, and the console the pane is showing stays where it was.
    func testEnteringAnotherFolderReplacesTheOneAlreadyOpen() {
        var nav = NavState(section: .agents)
        nav.enterFolder(release)
        nav.selectConsole(.console(sessionID: "s1", origin: .list))
        XCTAssertEqual(nav.path.count, 2)

        nav.enterFolder(polish)

        XCTAssertEqual(nav.path, [.folder(polish), .console(sessionID: "s1", origin: .list)])
    }

    /// Leaving — the wide shell's column back button, or the folder deleted under the page — takes
    /// only the folder's frame; a console the pane is showing stays, on the stack and on screen.
    func testLeavingAFolderKeepsTheConsoleAboveIt() {
        var nav = NavState(section: .agents)
        nav.enterFolder(release)
        nav.selectConsole(.console(sessionID: "s1", origin: .list))

        nav.leaveFolder()

        XCTAssertEqual(nav.path, [.console(sessionID: "s1", origin: .list)])
        XCTAssertNil(nav.folderColumn)
        XCTAssertEqual(nav.focusedConsoleSessionID, "s1")
    }

    /// A named folder only leaves when it is the one open: a delete that landed for another folder
    /// (two devices) must not close the page the reader is on.
    func testLeavingAFolderByNameOnlyLeavesThatOne() {
        var nav = NavState(section: .agents)
        nav.enterFolder(release)

        nav.leaveFolder(polish.folderID)
        XCTAssertEqual(nav.folderColumn, release, "another folder's delete is not this page's")

        nav.leaveFolder(release.folderID)
        XCTAssertTrue(nav.sectionAtRoot)
    }

    /// A phone with a console pushed over the folder: the folder is no longer the page on top, so
    /// `folderPage` is nil (the console is showing), while `folderColumn` still reads it — the read
    /// is what tells the two shells' questions apart.
    func testTheFolderPageReadFollowsTheTopFrame() {
        var nav = NavState(section: .agents)
        nav.enterFolder(release)
        nav.push(.console(sessionID: "s1", origin: .list))

        XCTAssertNil(nav.folderPage)
        XCTAssertEqual(nav.folderColumn, release)

        nav.pop()
        XCTAssertEqual(nav.folderPage, release, "back lands on the folder's page, not the workspace's list")
    }

    /// Selecting a console in a three-column shell replaces the page the pane shows — from a
    /// folder's page it is pushed *over* it, so the folder stays the list's page beside the console;
    /// clearing the selection pops the console and leaves the folder where it was.
    func testSelectingAConsoleFromAFolderPagePushesOverIt() {
        var nav = NavState(section: .agents)
        nav.enterFolder(release)

        nav.selectConsole(.console(sessionID: "s1", origin: .list))

        XCTAssertEqual(nav.path, [.folder(release), .console(sessionID: "s1", origin: .list)])
        XCTAssertEqual(nav.focusedConsoleSessionID, "s1")

        nav.selectConsole(.console(sessionID: "s2", origin: .list))
        XCTAssertEqual(nav.path.last, .console(sessionID: "s2", origin: .list),
                       "another row replaces the console, not the folder")

        // Clearing the selection: the console goes, the folder stays.
        nav.path = Array(nav.path.dropLast())
        XCTAssertEqual(nav.path, [.folder(release)])
    }

    /// Without a folder's page showing, selecting is what it always was: one frame replaced.
    func testSelectingAConsoleWithoutAFolderStillReplacesThePageShowing() {
        var nav = NavState(section: .agents)
        nav.push(.console(sessionID: "s1", origin: .list))

        nav.selectConsole(.console(sessionID: "s2", origin: .list))

        XCTAssertEqual(nav.path, [.console(sessionID: "s2", origin: .list)])
    }

    /// The draft from a folder's page goes over it — the back swipe returns to the folder, and the
    /// session it creates lands in it — while one opened from a list replaces the page the pane is
    /// showing, as it always did (§3.3).
    func testADraftOpenedFromAFolderPageIsPushedOverIt() {
        var nav = NavState(section: .agents)
        nav.enterFolder(release)

        nav.openDraft(agentID: "a1", folderID: release.folderID)

        XCTAssertEqual(nav.path, [.folder(release), .compose(agentID: "a1", folderID: "f1")])
        XCTAssertEqual(nav.folderColumn, release, "a wide shell's column keeps drawing the folder")

        // And the console the draft becomes replaces the draft, not the folder.
        nav.replaceTop(with: .console(sessionID: "s9", origin: .list))
        XCTAssertEqual(nav.path, [.folder(release), .console(sessionID: "s9", origin: .list)])
    }

    func testADraftOpenedFromAListReplacesThePageShowing() {
        var nav = NavState(section: .agents)
        nav.push(.console(sessionID: "s1", origin: .list))

        nav.openDraft(agentID: "a1", folderID: nil)

        XCTAssertEqual(nav.path, [.compose(agentID: "a1", folderID: nil)])
    }

    /// The address carries the scope of the list the folder was opened from: the same folder opened
    /// from Completed is a different frame (§3.3).
    func testTheAddressCarriesTheScopeThePageWasOpenedFrom() {
        var nav = NavState(section: .agents)
        let completed = SessionFolderAddress(folderID: "f1", agentID: "a1", view: .completed)

        nav.enterFolder(completed)

        XCTAssertEqual(nav.folderPage?.view, .completed)
        XCTAssertNotEqual(nav.folderPage, release)
    }
}
