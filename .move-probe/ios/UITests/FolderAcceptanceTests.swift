import XCTest

// TEMPORARY evidence probe (see ../../README.md), iPhone: the acceptance pass over folder management
// (docs/session-folders-move-design.md §3.4) on the newest main — a folder made from each of its two
// doors (the Move panel's New Folder…, which files the session in it, and the list's ≡ menu's, which
// makes it empty), Rename… before and after, Delete Folder…'s confirmation and the list after it,
// and a name the workspace already has, refused in words from all three places that take a name.
//
// Around the delete the fixture API's whole state is written next to the pictures (`GET /__state`),
// and the stub logs every request: together they show the folder went and every session stayed —
// the ones filed in it are still there, with no folder.
//
// Soft failures: whatever cannot be found is noted next to the pictures and the run moves on, so
// one pass collects everything it can. Each test resets the fixture API first.
final class FolderAcceptanceTests: ProbeCase {
    // The copy the app draws (OrbitKit's SessionFolderCopy / SessionMoveCopy), spelled here so a
    // test fails loudly if it moves.
    private let newFolder = "New Folder…"
    private let newFolderTitle = "New Folder"
    private let create = "Create"
    private let renameTitle = "Rename Folder"
    private let renameItem = "Rename…"
    private let deleteItem = "Delete Folder…"
    private let saveButton = "Save"
    private let deleteConfirm = "Delete"
    private let couldNotCreate = "Couldn’t Create Folder"
    private let couldNotRename = "Couldn’t Rename Folder"

    private let release = "Release"
    private let polish = "iOS polish"
    /// Filed in Release (Open), waiting on you.
    private let waitingInRelease = "审查工具调用报错渲染"
    /// Filed in Release (Open), calm.
    private let folderMate = "Wiki 审核模式文案对齐"
    /// Filed in Release (Completed).
    private let completedInRelease = "发布 0.1.171"

    // MARK: 1. New Folder… from both doors

    /// The Move panel's New Folder…: the system prompt names it, the session goes straight in and
    /// the toast says so; back on the list the new folder's row leads it, counting that session.
    func test1NewFolderFromMovePanel() {
        let app = launch(dark: true)
        shot("accept-1a-0-list-before")
        openPanel(app, "accept-1a")
        panel(app, "accept-1a-1-move-panel")
        option(app, newFolder).tap(); settle()
        enter(app, "Launch notes")
        shot("accept-1a-2-new-folder-prompt")
        alertButton(app, create)
        toast(app, "Moved to “Launch notes”", "accept-1a-3-moved-toast")
        settle(1.5)
        shot("accept-1a-4-list-with-new-folder")
        tree(app, "accept-1a-list-after")
        let folder = folderRow(app, "Launch notes", "after New Folder… in the Move panel")
        XCTAssertTrue(folder.label.contains("1"), "the new folder counts the session filed in it")
        XCTAssertFalse(app.cells.containing(NSPredicate(format: "label CONTAINS %@", moving)).firstMatch.exists,
                       "the filed session left the time sections")
        saveState("accept-1a-state-after.json")
        app.terminate()
    }

    /// The list's ≡ menu's New Folder…: the same prompt (its message says where the folder will
    /// show), and the new, empty folder's row at the top of the list.
    func test2NewFolderFromListMenu() {
        let app = launch(dark: true)
        openListMenu(app)
        shot("accept-1b-1-list-menu")
        tree(app, "accept-1b-list-menu")
        tap(app, newFolder)
        let prompt = app.alerts[newFolderTitle]
        if !prompt.waitForExistence(timeout: 8) { note("1b: no New Folder prompt") }
        XCTAssertTrue(prompt.exists, "New Folder… opens the system's name prompt")
        enter(app, "Design review")
        shot("accept-1b-2-new-folder-prompt")
        tree(app, "accept-1b-prompt")
        alertButton(app, create)
        settle(2)
        shot("accept-1b-3-list-with-new-folder")
        tree(app, "accept-1b-list-after")
        let folder = folderRow(app, "Design review", "after New Folder… in the ≡ menu")
        XCTAssertTrue(folder.label.contains("0"), "the new folder is empty")
        XCTAssertTrue(row(app, moving).exists, "no session was filed by it")
        saveState("accept-1b-state-after.json")
        app.terminate()
    }

    // MARK: 2. Rename…

    /// A long press on a folder row offers Rename…; its prompt starts from the current name, and
    /// Save puts the new one on the row.
    func test3Rename() {
        let app = launch(dark: true)
        shot("accept-2-1-before")
        folderMenu(app, release)
        shot("accept-2-2-folder-menu")
        tap(app, renameItem)
        let alert = app.alerts[renameTitle]
        if !alert.waitForExistence(timeout: 8) { note("2: no rename prompt") }
        XCTAssertTrue(alert.exists, "Rename… opens the system's name prompt")
        let field = alert.textFields.firstMatch
        note("rename prompt holds: \(field.value as? String ?? "?")")
        XCTAssertEqual(field.value as? String, release, "the prompt starts from the folder's name")
        settle(0.6)
        shot("accept-2-3-rename-prompt-old-name")
        replace(app, field, with: "Shipping")
        shot("accept-2-4-rename-prompt-new-name")
        alert.buttons[saveButton].tap()
        settle(2)
        shot("accept-2-5-after")
        tree(app, "accept-2-after")
        XCTAssertTrue(folderRowExists(app, "Shipping"), "the row carries the new name")
        XCTAssertFalse(folderRowExists(app, release), "and not the old one")
        saveState("accept-2-state-after.json")
        app.terminate()
    }

    // MARK: 3. Delete Folder…

    /// What is in Release before it goes: its page, with the two Open sessions filed in it.
    func test4aInsideReleaseBeforeDelete() {
        let app = launch(dark: true)
        openFolderPage(app, release)
        settle(1)
        shot("accept-3-0-inside-release")
        XCTAssertTrue(row(app, waitingInRelease).exists, "Release holds this session")
        XCTAssertTrue(row(app, folderMate).exists, "and this one")
        app.terminate()
    }

    /// Delete Folder… asks first (§3.4's words); saying yes takes the folder away and puts its
    /// sessions back in the list — in Open, and the completed one in Completed. The stub's state
    /// before and after is written beside the pictures.
    func test4bDeleteFolder() {
        let app = launch(dark: true)
        saveState("accept-3-state-before.json")
        shot("accept-3-1-before")
        note("before: \(folderCounts(app))")
        folderMenu(app, release)
        shot("accept-3-2-folder-menu")
        tap(app, deleteItem)
        let dialog = confirmDialog(app)
        guard dialog.waitForExistence(timeout: 8) else {
            note("3: no delete confirmation")
            write(app.debugDescription, "missing-delete-dialog.txt")
            XCTAssertTrue(dialog.exists, "Delete Folder… asks first")
            app.terminate()
            return
        }
        settle(0.6)
        shot("accept-3-3-delete-confirmation")
        tree(app, "accept-3-confirmation")
        XCTAssertTrue(dialog.staticTexts["Delete “\(release)”?"].exists, "the confirmation names the folder")
        XCTAssertTrue(dialog.staticTexts["The 2 sessions in it move back to the list. No session is deleted."].exists,
                      "and says the sessions move back to the list")
        if dialog.buttons[deleteConfirm].exists {
            dialog.buttons[deleteConfirm].tap()
        } else {
            note("3: no Delete in the dialog")
            write(app.debugDescription, "missing-delete-confirm.txt")
        }
        settle(3)
        shot("accept-3-4-after-delete")
        tree(app, "accept-3-after")
        note("after: \(folderCounts(app))")
        XCTAssertFalse(folderRowExists(app, release), "the folder row is gone")
        XCTAssertTrue(row(app, waitingInRelease).exists, "its sessions are back in the list")
        XCTAssertTrue(row(app, folderMate).exists, "both of them")
        saveState("accept-3-state-after.json")
        scope(app, "Completed")
        settle(1.5)
        shot("accept-3-5-completed-after-delete")
        tree(app, "accept-3-completed-after")
        XCTAssertTrue(row(app, completedInRelease).exists, "the completed session filed in it is back in Completed")
        app.terminate()
    }

    // MARK: 4. A name the workspace already has

    /// “Release” again — from the ≡ menu, from the Move panel, and as a rename of iOS polish: each
    /// is refused, and the alert says why in a sentence. The folders stay as they were.
    func test5DuplicateName() {
        let app = launch(dark: true)
        openListMenu(app)
        tap(app, newFolder)
        enter(app, release)
        shot("accept-4-1-menu-prompt-duplicate")
        alertButton(app, create)
        refusal(app, couldNotCreate, "accept-4-2-menu-duplicate-refused")

        openPanel(app, "accept-4-panel")
        panel(app, "accept-4-3-move-panel")
        option(app, newFolder).tap(); settle()
        enter(app, release)
        alertButton(app, create)
        refusal(app, couldNotCreate, "accept-4-4-panel-duplicate-refused")
        tap(app, "Done")
        settle(1)

        folderMenu(app, polish)
        tap(app, renameItem)
        let alert = app.alerts[renameTitle]
        if !alert.waitForExistence(timeout: 8) { note("4: no rename prompt") }
        replace(app, alert.textFields.firstMatch, with: release)
        alert.buttons[saveButton].tap()
        refusal(app, couldNotRename, "accept-4-5-rename-duplicate-refused")
        settle(1.5)
        shot("accept-4-6-list-unchanged")
        note("after the refusals: \(folderCounts(app))")
        XCTAssertTrue(folderRowExists(app, release), "Release is still there")
        XCTAssertTrue(folderRowExists(app, polish), "and so is iOS polish, unrenamed")
        saveState("accept-4-state-after.json")
        app.terminate()
    }

    // MARK: helpers

    /// The list's ≡ menu (its label names the scope on a phone), opened.
    private func openListMenu(_ app: XCUIApplication) {
        let menu = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Session scope")).firstMatch
        guard menu.waitForExistence(timeout: 10) else {
            note("no ≡ menu")
            write(app.debugDescription, "missing-list-menu.txt")
            return
        }
        menu.tap()
        settle(1.2)
        if !app.buttons[newFolder].waitForExistence(timeout: 5) {
            note("the ≡ menu shows no New Folder…")
            write(app.debugDescription, "missing-menu-new-folder.txt")
        }
    }

    /// The alert a refused name raises: its title, the sentence that says why, photographed, then
    /// put away with OK.
    private func refusal(_ app: XCUIApplication, _ title: String, _ shotName: String) {
        let alert = app.alerts[title]
        if !alert.waitForExistence(timeout: 10) {
            note("\(shotName): no \(title) alert")
            write(app.debugDescription, "missing-\(shotName).txt")
        }
        XCTAssertTrue(alert.exists, "\(shotName): the name is refused")
        let why = "There’s already a folder named “\(release)” in orbit. Choose another name."
        let reason = alert.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", why)).firstMatch
        XCTAssertTrue(reason.exists, "\(shotName): and the alert says why")
        note("\(shotName): \(alert.staticTexts.allElementsBoundByIndex.map(\.label))")
        settle(0.6)
        shot(shotName)
        tree(app, shotName)
        let ok = alert.buttons["OK"]
        if ok.exists { ok.tap() } else { note("\(shotName): no OK") }
        settle(1)
    }

    /// The folder's row — its button, whose label starts with the folder's name.
    @discardableResult
    private func folderRow(_ app: XCUIApplication, _ name: String, _ when: String) -> XCUIElement {
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        if !row.waitForExistence(timeout: 10) {
            note("no folder row for \(name) \(when)")
            write(app.debugDescription, "missing-folder-\(name).txt")
        }
        XCTAssertTrue(row.exists, "the \(name) folder row (\(when))")
        note("\(name) row: label=\(row.label)")
        return row
    }

    private func folderRowExists(_ app: XCUIApplication, _ name: String) -> Bool {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch.exists
    }

    private func folderCounts(_ app: XCUIApplication) -> String {
        [release, polish].map { name -> String in
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
            return "\(name)=\(row.exists ? row.label : "none")"
        }.joined(separator: " ")
    }

    /// A long press on a folder's row — the menu Rename… / Delete Folder… live in.
    private func folderMenu(_ app: XCUIApplication, _ name: String) {
        folderRow(app, name, "for its menu").press(forDuration: 1.2)
        settle(1.2)
        if !app.buttons[renameItem].waitForExistence(timeout: 8) {
            note("\(name): the long-press menu did not open")
            write(app.debugDescription, "missing-menu-\(name).txt")
        }
    }

    /// The confirmation Delete Folder… raises — an action sheet on a phone.
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
}
