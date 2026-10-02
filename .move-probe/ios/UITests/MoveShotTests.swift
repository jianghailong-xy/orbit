import XCTest

// TEMPORARY evidence probe (see ../../README.md): photograph the session list's left swipe — Share ·
// Move · Delete on Open and Completed, Delete Permanently alone in Trash — the long-press menu's
// Share… and Move…, and the Move panel before and after a move into a folder, out to No Folder, and
// into a New Folder… (and a name the workspace already has). Soft failures: whatever cannot be found
// is noted next to the pictures and the run moves on, so one pass collects everything it can. Each
// test resets the fixture API first, so the moves of one don't leak into the next.
//
// A row is opened by a finger-like drag: the Share probe found XCUITest's `swipeLeft()` leaves the
// real list's rows shut in the upper part of the screen, where a press-and-drag opens them anywhere.
final class MoveShotTests: ProbeCase {
    // MARK: the swipe and the menu

    /// Open: left to right, Share · Move · Delete.
    func test1OpenSwipe() {
        let app = launch(dark: true)
        shot("open-0-rest")
        openTrailing(app, moving, showing: "Move", "open")
        shot("open-1-swipe-left")
        order(app, ["Share", "Move", "Delete"], "open")
        app.terminate()
    }

    /// Open: the long-press menu has Share… and Move…, and Move… opens the panel.
    func test2OpenMenu() {
        let app = launch(dark: true)
        row(app, moving).press(forDuration: 1.2); settle()
        shot("open-2-long-press-menu")
        tree(app, "open-menu")
        XCTAssertTrue(app.buttons["Share…"].exists, "Open: the menu has Share…")
        XCTAssertTrue(app.buttons["Move…"].exists, "Open: the menu has Move…")
        frames(app, ["Share…", "Move…", "Delete"], "open-menu")
        tap(app, "Move…")
        panel(app, "open-3-move-panel-from-menu")
        app.terminate()
    }

    /// Completed: the same three; its menu has Share… and Move… too, and its panel counts the
    /// completed sessions.
    func test3Completed() {
        let app = launch(dark: true)
        scope(app, "Completed")
        openTrailing(app, completed, showing: "Move", "completed")
        shot("completed-1-swipe-left")
        order(app, ["Share", "Move", "Delete"], "completed")
        tap(app, "Move")
        panel(app, "completed-2-move-panel")
        tap(app, "Done")
        row(app, completed).press(forDuration: 1.2); settle()
        shot("completed-3-long-press-menu")
        tree(app, "completed-menu")
        XCTAssertTrue(app.buttons["Share…"].exists, "Completed: the menu has Share…")
        XCTAssertTrue(app.buttons["Move…"].exists, "Completed: the menu has Move…")
        app.terminate()
    }

    /// Trash: Delete Permanently alone, and neither Share… nor Move… in its menu.
    func test3Trash() {
        let app = launch(dark: true)
        scope(app, "Trash")
        openTrailing(app, trashed, showing: "Delete Permanently", "trash")
        shot("trash-1-swipe-left")
        frames(app, ["Share", "Move", "Delete Permanently"], "trash-left")
        XCTAssertFalse(app.buttons["Share"].exists, "Trash: no Share in the left swipe")
        XCTAssertFalse(app.buttons["Move"].exists, "Trash: no Move in the left swipe")
        XCTAssertTrue(app.buttons["Delete Permanently"].exists, "Trash: Delete Permanently alone")
        row(app, "实验：换一种列表分组").tap(); settle()
        row(app, trashed).press(forDuration: 1.2); settle()
        shot("trash-2-long-press-menu")
        tree(app, "trash-menu")
        XCTAssertFalse(app.buttons["Share…"].exists, "Trash: no Share… in the menu")
        XCTAssertFalse(app.buttons["Move…"].exists, "Trash: no Move… in the menu")
        app.terminate()
    }

    // MARK: the panel

    /// Into a folder and out again: the tick moves with the session, the count with it, and the
    /// toast names where it went — then the folder it left.
    func test4FolderAndNoFolder() {
        let app = launch(dark: true)
        openPanel(app, "folder")
        panel(app, "folder-1-panel-before")
        ticked(app, "No Folder", "before")
        option(app, "Release").tap()
        toast(app, "Moved to “Release”", "folder-2-toast-moved-to-release")
        // Filed now, so its row has left the time sections (§3.3) and lives on the folder's page:
        // the panel is opened again from there, where the tick has moved with it.
        XCTAssertFalse(row(app, moving, quiet: true).exists, "the filed session left the list")
        openFolderPage(app, "Release")
        openPanel(app, "folder-again")
        panel(app, "folder-3-panel-after")
        ticked(app, "Release", "after the move")

        option(app, "No Folder").tap()
        toast(app, "Moved out of “Release”", "nofolder-1-toast-moved-out")
        // Out of the folder again, so its row has left the folder's page and is back in the list:
        // the panel opens from the list once more.
        goBack(app)
        openPanel(app, "nofolder-again")
        panel(app, "nofolder-2-panel-after")
        ticked(app, "No Folder", "after moving out")
        app.terminate()
    }

    /// New Folder…: the system prompt names it, the session goes straight in and the toast says so;
    /// the panel then lists it, ticked. A name the workspace already has is refused, readably.
    func test5NewFolder() {
        let app = launch(dark: true)
        openPanel(app, "new")
        panel(app, "new-1-panel-before")
        option(app, "New Folder…").tap(); settle()
        enter(app, "Launch notes")
        shot("new-2-name-prompt")
        alertButton(app, "Create")
        toast(app, "Moved to “Launch notes”", "new-3-toast-moved-to-new-folder")
        // The session went straight into the new folder, so it is on that folder's page now, with
        // the panel's tick on it (its row has left the list — §3.3).
        openFolderPage(app, "Launch notes")
        openPanel(app, "new-again")
        panel(app, "new-4-panel-after")
        ticked(app, "Launch notes", "after New Folder…")

        option(app, "New Folder…").tap(); settle()
        enter(app, "Release")
        alertButton(app, "Create")
        let refused = app.alerts["Couldn’t Create Folder"]
        if !refused.waitForExistence(timeout: 10) {
            note("new-dup: no refusal alert")
            write(app.debugDescription, "missing-new-dup.txt")
        }
        XCTAssertTrue(refused.exists, "a name the workspace has is refused")
        let reason = refused.staticTexts.matching(NSPredicate(format: "label CONTAINS %@",
                                                              "There’s already a folder named “Release” in orbit")).firstMatch
        XCTAssertTrue(reason.exists, "and the alert says why")
        settle()
        shot("new-5-duplicate-name")
        tree(app, "new-dup")
        app.terminate()
    }

    /// The swipe and the panel once more, in light.
    func test6Light() {
        let app = launch(dark: false)
        openTrailing(app, moving, showing: "Move", "light")
        shot("light-1-swipe-left")
        order(app, ["Share", "Move", "Delete"], "light")
        tap(app, "Move")
        panel(app, "light-2-move-panel")
        app.terminate()
    }

}
