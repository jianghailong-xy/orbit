import XCTest

// TEMPORARY evidence probe (see ../../README.md), iPad: the three-column shape — the folder rows at
// the top of the session column, the page a row puts in that column (with the column's own back
// button, since the column has no stack), a session opened from it (the detail pane follows the
// selection while the column keeps the folder), the back button returning the workspace's list, and
// the two management prompts. Same fixtures, same stub as the phone's.
final class FolderIPadShotTests: ProbeCase {
    private let renameTitle = "Rename Folder"
    private let renameItem = "Rename…"
    private let deleteItem = "Delete Folder…"

    private let release = "Release"
    private let polish = "iOS polish"
    private let waitingInRelease = "审查工具调用报错渲染"

    /// The session column leads with the folder rows, over the time sections.
    func test1FolderRows() {
        let app = launch(dark: true)
        shot("ipad-1-folder-rows")
        tree(app, "ipad-folder-rows")
        folderRow(app, release)
        folderRow(app, polish)
        XCTAssertFalse(app.cells.containing(NSPredicate(format: "label CONTAINS %@", waitingInRelease))
            .firstMatch.exists, "a filed session is not also a row outside its folder")
        app.terminate()
    }

    /// A tap puts the folder's page in the column — its name over the workspace's, ⋯ and ✎ — and
    /// the column's back button returns the workspace's list.
    func test2FolderPageAndBack() {
        let app = launch(dark: true)
        openFolder(app, release)
        shot("ipad-2-folder-page")
        tree(app, "ipad-folder-page")
        XCTAssertTrue(app.buttons["Folder actions"].exists, "the page's ⋯")
        XCTAssertTrue(app.buttons["Start a new session in \(release)"].exists, "the page's ✎")
        XCTAssertTrue(row(app, waitingInRelease).exists, "the filed sessions are the column's rows")
        let back = app.buttons["Back to the workspace's sessions"]
        if !back.waitForExistence(timeout: 8) { note("no back button on the column") }
        back.tap()
        settle(2)
        shot("ipad-3-back-to-list")
        XCTAssertFalse(app.buttons["Folder actions"].exists, "the folder's page is gone")
        XCTAssertTrue(folderRowExists(app, release), "and the workspace's list is back")
        app.terminate()
    }

    /// A session opened from the folder's page goes to the detail pane, and the column keeps the
    /// folder the session was opened from; backing out of the folder leaves the session beside it.
    func test3OpenSessionFromTheFolder() {
        let app = launch(dark: true)
        openFolder(app, release)
        row(app, waitingInRelease).tap()
        settle(3)
        shot("ipad-4-console-beside-folder")
        tree(app, "ipad-console")
        XCTAssertTrue(app.buttons["Folder actions"].exists, "the column still shows the folder's page")
        XCTAssertTrue(app.buttons["Back to the workspace's sessions"].exists)
        app.buttons["Back to the workspace's sessions"].tap()
        settle(2.5)
        shot("ipad-5-list-back-session-kept")
        XCTAssertTrue(folderRowExists(app, release), "the workspace's list is back in the column")
        app.terminate()
    }

    /// Rename… from the row's long-press menu, with the system's prompt carrying the current name.
    func test4Rename() {
        let app = launch(dark: true)
        folderRow(app, release).press(forDuration: 1.2)
        settle(1.2)
        shot("ipad-6-folder-menu")
        tap(app, renameItem)
        let alert = app.alerts[renameTitle]
        if !alert.waitForExistence(timeout: 8) { note("no rename prompt") }
        XCTAssertTrue(alert.exists, "Rename… opens the system's name prompt")
        shot("ipad-7-rename-prompt")
        alert.buttons["Cancel"].tap()
        app.terminate()
    }

    /// Delete Folder…'s confirmation, in §3.4's words.
    func test5DeleteConfirmation() {
        let app = launch(dark: true)
        folderRow(app, release).press(forDuration: 1.2)
        settle(1.2)
        tap(app, deleteItem)
        let dialog = confirmDialog(app)
        if dialog.waitForExistence(timeout: 8) {
            shot("ipad-8-delete-confirmation")
            tree(app, "ipad-delete-confirmation")
            let title = dialog.staticTexts["Delete “\(release)”?"]
            let body = dialog.staticTexts["The 2 sessions in it move back to the list. No session is deleted."]
            XCTAssertTrue(title.exists, "the confirmation names the folder")
            XCTAssertTrue(body.exists, "and says the sessions move back to the list")
            if dialog.buttons["Cancel"].exists { dialog.buttons["Cancel"].tap() }
        } else {
            note("no delete confirmation")
            write(app.debugDescription, "missing-delete-dialog.txt")
            XCTAssertTrue(dialog.exists, "Delete Folder… asks first")
        }
        app.terminate()
    }

    // MARK: helpers

    @discardableResult
    private func folderRow(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        if !row.waitForExistence(timeout: 12) {
            note("no folder row for \(name)")
            write(app.debugDescription, "missing-folder-\(name).txt")
        }
        XCTAssertTrue(row.exists, "the \(name) folder row")
        note("\(name) row: label=\(row.label) value=\(row.value ?? "")")
        return row
    }

    private func folderRowExists(_ app: XCUIApplication, _ name: String) -> Bool {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch.exists
    }

    private func openFolder(_ app: XCUIApplication, _ name: String) {
        folderRow(app, name).tap()
        settle(2)
        if !app.buttons["Folder actions"].waitForExistence(timeout: 8) {
            note("\(name): no folder page in the column after the tap")
            write(app.debugDescription, "missing-page-\(name).txt")
        }
    }

    private func confirmDialog(_ app: XCUIApplication) -> XCUIElement {
        let sheets = app.sheets.firstMatch
        if sheets.waitForExistence(timeout: 5) { return sheets }
        let popovers = app.popovers.firstMatch
        if popovers.exists { return popovers }
        return app.alerts.firstMatch
    }
}
