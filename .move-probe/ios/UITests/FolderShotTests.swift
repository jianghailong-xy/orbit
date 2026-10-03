import XCTest

// TEMPORARY evidence probe (see ../../README.md), iPhone: the folder rows at the very top of the
// session list — one reporting an amber number (a session in it waits on you), one a spinner (a
// session in it runs) — the page a row opens (the folder's name over its workspace's, ⋯ and ✎), a
// session opened from that page and the way back, Rename… and Delete Folder… with their prompts,
// the delete that returns the sessions to the list, a move that leaves the time sections and lifts
// the count, and a new session made inside a folder (the stub logs the create request, which is
// what proves the `folderId`).
//
// Soft failures: whatever cannot be found is noted next to the pictures and the run moves on, so
// one pass collects everything it can. Each test resets the fixture API first.
final class FolderShotTests: ProbeCase {
    // The copy the app draws, spelled here so a test fails loudly if it moves (OrbitKit's
    // SessionFolderCopy / SessionMoveCopy).
    private let renameTitle = "Rename Folder"
    private let renameItem = "Rename…"
    private let deleteItem = "Delete Folder…"
    private let saveButton = "Save"
    private let deleteConfirm = "Delete"

    private let release = "Release"
    private let polish = "iOS polish"
    /// Filed in Release, waiting on you — the amber number on its folder row.
    private let waitingInRelease = "审查工具调用报错渲染"
    /// Filed in Release, calm.
    private let folderMate = "Wiki 审核模式文案对齐"
    /// Filed in iOS polish, running — the spinner on its folder row.
    private let runningInPolish = "滑动按钮圆形设计"

    // MARK: the folder rows

    /// Open: the two folder rows lead the list, Release with the amber number and iOS polish with
    /// the spinner, and the sessions filed in them are not in the time sections below.
    func test1FolderRows() {
        let app = launch(dark: true)
        shot("iphone-1-folder-rows")
        tree(app, "iphone-folder-rows")
        folderRow(app, release, "the amber one")
        folderRow(app, polish, "the spinner one")
        // A session inside a folder is drawn behind its row and nowhere else: it is not a row of
        // its own in the time sections.
        let loose = app.cells.containing(NSPredicate(format: "label CONTAINS %@", waitingInRelease)).firstMatch
        XCTAssertFalse(loose.exists, "a filed session is not also a row outside its folder")
        app.terminate()
    }

    // MARK: the folder page

    /// Tapping a folder row opens the folder's page: its name over the workspace's, ⋯ and ✎ at the
    /// trailing edge, and the sessions filed in it — the same rows the list outside draws.
    func test2FolderPage() {
        let app = launch(dark: true)
        openFolderPage(app, release)
        shot("iphone-2-folder-page")
        tree(app, "iphone-folder-page")
        XCTAssertTrue(app.buttons["Folder actions"].exists, "the page's ⋯")
        XCTAssertTrue(app.buttons["Start a new session in \(release)"].exists, "the page's ✎")
        XCTAssertTrue(row(app, waitingInRelease).exists, "the filed sessions are the page's rows")
        XCTAssertTrue(row(app, folderMate).exists, "all of them")
        app.terminate()
    }

    /// From the folder's page a session opens onto its console, and the back button returns to the
    /// folder's page — not to the workspace's list (§3.3).
    func test3OpenSessionAndBack() {
        let app = launch(dark: true)
        openFolderPage(app, release)
        tapRow(app, waitingInRelease)
        settle(2.5)
        shot("iphone-3-console-from-folder")
        tree(app, "iphone-console")
        XCTAssertFalse(app.buttons["Folder actions"].exists, "the console is over the folder's page")
        goBack(app)
        let folderPage = app.buttons["Folder actions"]
        if !folderPage.waitForExistence(timeout: 8) { note("back did not land on the folder's page") }
        XCTAssertTrue(folderPage.exists, "back lands on the folder's page, not the workspace's list")
        shot("iphone-4-back-on-folder-page")
        app.terminate()
    }

    // MARK: management

    /// A long press on a folder row offers Rename… and Delete Folder…, and Rename… saves the new
    /// name — which the row then carries.
    func test4Rename() {
        let app = launch(dark: true)
        folderMenu(app, release, "rename")
        shot("iphone-5-folder-menu")
        tap(app, renameItem)
        let alert = app.alerts[renameTitle]
        if !alert.waitForExistence(timeout: 8) { note("no rename prompt") }
        XCTAssertTrue(alert.exists, "Rename… opens the system's name prompt")
        replace(app, alert.textFields.firstMatch, with: "Shipping")
        shot("iphone-6-rename-prompt")
        alert.buttons[saveButton].tap()
        settle(2)
        shot("iphone-7-renamed-row")
        XCTAssertTrue(folderRowExists(app, "Shipping"), "the row carries the new name")
        XCTAssertFalse(folderRowExists(app, release), "and not the old one")
        app.terminate()
    }

    /// Delete Folder… asks first (§3.4's words), and saying yes takes the folder away and puts its
    /// sessions back in the list — nothing is deleted.
    func test5DeleteFolder() {
        let app = launch(dark: true)
        folderMenu(app, release, "delete")
        tap(app, deleteItem)
        let dialog = confirmDialog(app)
        if dialog.waitForExistence(timeout: 8) {
            shot("iphone-8-delete-confirmation")
            tree(app, "iphone-delete-confirmation")
            // The design's own words: which folder, and that nothing inside it is deleted.
            let title = dialog.staticTexts[deleteTitle(release)]
            let body = dialog.staticTexts["The 2 sessions in it move back to the list. No session is deleted."]
            XCTAssertTrue(title.exists, "the confirmation names the folder")
            XCTAssertTrue(body.exists, "and says the sessions move back to the list")
            if dialog.buttons[deleteConfirm].exists {
                dialog.buttons[deleteConfirm].tap()
            } else if dialog.buttons[deleteItem].exists {
                dialog.buttons[deleteItem].tap()
            } else {
                note("no confirm button in the dialog")
                write(app.debugDescription, "missing-delete-confirm.txt")
            }
            settle(2.5)
            shot("iphone-9-after-delete")
            XCTAssertFalse(folderRowExists(app, release), "the folder row is gone")
            XCTAssertTrue(row(app, waitingInRelease).exists, "and its sessions are back in the list")
            XCTAssertTrue(row(app, folderMate).exists, "all of them, still there")
        } else {
            note("no delete confirmation")
            write(app.debugDescription, "missing-delete-dialog.txt")
            XCTAssertTrue(dialog.exists, "Delete Folder… asks first")
        }
        app.terminate()
    }

    // MARK: the count, and a session made inside

    /// Moving a session into a folder: it leaves the time sections and the folder row's count goes
    /// up by one — what §3.3 promises of the row that hides it.
    func test6MoveIntoFolderLiftsTheCount() {
        let app = launch(dark: true)
        shot("iphone-10-before-move")
        note("counts before: \(folderCounts(app))")
        openTrailing(app, moving, showing: "Move", "move-into")
        tap(app, "Move")
        panel(app, "iphone-11-move-panel")
        option(app, polish).tap()
        toast(app, "Moved to “\(polish)”", "iphone-12-moved-toast")
        shot("iphone-13-after-move")
        note("counts after: \(folderCounts(app))")
        let filed = app.cells.containing(NSPredicate(format: "label CONTAINS %@", moving)).firstMatch
        XCTAssertFalse(filed.exists, "the moved session left the time sections")
        let row = folderRow(app, polish, "after the move")
        XCTAssertTrue(row.label.contains("3"), "the folder row counts it")
        app.terminate()
    }

    /// ✎ on a folder's page composes a session that lands in that folder: the stub logs the create
    /// request with its `folderId`, and backing out of the console shows the new row on the page.
    func test7NewSessionInsideTheFolder() {
        let app = launch(dark: true)
        openFolderPage(app, polish)
        app.buttons["Start a new session in \(polish)"].tap()
        settle(2)
        shot("iphone-14-new-session-draft")
        tree(app, "iphone-draft")
        let editor = app.textViews.firstMatch
        if !editor.waitForExistence(timeout: 10) {
            note("no composer to type into")
            write(app.debugDescription, "missing-composer.txt")
        }
        editor.tap()
        editor.typeText("新建一条属于 iOS polish 的会话")
        settle(1)
        shot("iphone-15-draft-typed")
        send(app)
        settle(4)
        shot("iphone-16-created-console")
        goBack(app)
        settle(2.5)
        shot("iphone-17-new-session-in-folder")
        tree(app, "iphone-folder-after-create")
        let created = app.cells.containing(NSPredicate(format: "label CONTAINS %@", "新建一条属于")).firstMatch
        if !created.exists { note("the created session is not on the folder's page yet") }
        XCTAssertTrue(created.exists, "the session created in the folder is drawn on its page")
        app.terminate()
    }

    // MARK: helpers

    private func deleteTitle(_ name: String) -> String { "Delete “\(name)”?" }

    /// The folder's row — its button, whose label starts with the folder's name — or nil, noted.
    @discardableResult
    private func folderRow(_ app: XCUIApplication, _ name: String, _ when: String) -> XCUIElement {
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        if !row.waitForExistence(timeout: 10) {
            note("no folder row for \(name) \(when)")
            write(app.debugDescription, "missing-folder-\(name).txt")
        }
        XCTAssertTrue(row.exists, "the \(name) folder row (\(when))")
        note("\(name) row: label=\(row.label) value=\(row.value ?? "")")
        return row
    }

    private func folderRowExists(_ app: XCUIApplication, _ name: String) -> Bool {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch.exists
    }

    /// Every folder row's count, as the list shows it — noted before and after a move.
    private func folderCounts(_ app: XCUIApplication) -> String {
        [release, polish].map { name -> String in
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
            return "\(name)=\(row.exists ? row.label : "none")"
        }.joined(separator: " ")
    }

    /// A long press on a folder's row — the menu Rename… / Delete Folder… lives in.
    private func folderMenu(_ app: XCUIApplication, _ name: String, _ when: String) {
        folderRow(app, name, when).press(forDuration: 1.2)
        settle(1.2)
        if !app.buttons[renameItem].waitForExistence(timeout: 8) {
            note("\(name): the long-press menu did not open")
            write(app.debugDescription, "missing-menu-\(name).txt")
        }
    }

    /// The confirmation Delete Folder… raises — an action sheet on a phone, either way with the
    /// design's title in it.
    private func confirmDialog(_ app: XCUIApplication) -> XCUIElement {
        let sheets = app.sheets.firstMatch
        if sheets.waitForExistence(timeout: 5) { return sheets }
        return app.alerts.firstMatch
    }

    /// Put `text` into a field that already holds something: delete what is there, then type.
    private func replace(_ app: XCUIApplication, _ field: XCUIElement, with text: String) {
        field.tap()
        let tip = app.buttons["Continue"]
        if tip.waitForExistence(timeout: 2) { tip.tap(); settle(0.5) }
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40))
        field.typeText(text)
        settle(0.6)
    }

    /// The composer's send control. It is an unnamed image button at the toolbar's right end, so
    /// look for the labels it might carry, then fall back to the bottom-right button.
    private func send(_ app: XCUIApplication) {
        for label in ["Send", "Arrow Up Circle Fill", "arrow.up.circle.fill", "Up Arrow Circle Fill"] {
            let button = app.buttons[label]
            if button.exists { note("send: tapped \(label)"); button.tap(); return }
        }
        let frame = app.windows.firstMatch.frame
        let candidates = app.buttons.allElementsBoundByIndex
            .filter { $0.isHittable && $0.frame.midY > frame.height * 0.6 }
            .sorted { $0.frame.midX > $1.frame.midX }
        if let button = candidates.first {
            note("send: no label matched; tapping the bottom-right button at \(button.frame)")
            button.tap()
            return
        }
        note("send: no send button found")
        write(app.debugDescription, "missing-send.txt")
    }

}
