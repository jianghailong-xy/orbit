import XCTest

// TEMPORARY evidence probe (see ../../README.md) for task 34nGbUykKeP4geymwZYB8 (owner 2026-10-27,
// docs/mocks/landings-one-window). It drives the real iPhone and Mac apps against stub.py and
// photographs the frames of the board:
//   b  (iPhone) the project's sessions page: one Landings row, no Merged into main on the timeline;
//   d  (iPhone) the row opens the project's Landings window at its bottom: days, then Now's cards;
//   e  (iPhone) a Merged into main row opened in place: its receipt over its round's own record;
//   f  (iPhone + Mac) a landing session's id opens the window on that landing, opened and outlined;
//   g  (iPhone) a long press on a card: the old landing page's ⋯ rows.
// A state the stub never drove fails the test, and every picture and tree is kept anyway.
final class LandingsWindowTests: ProbeCase {
    private static let countLine = "1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today"
    private static let footer = "Orbit runs these landings — "

    #if os(iOS)
    /// b → d → e in one launch: the row, the window it opens, and the merge row opened in place.
    func testIPhoneTheRowOpensTheWindowAndAMergeRowOpensInPlace() {
        let app = launch(until: Self.countLine, extra: ["-probe.page", "sessions"], "sessions")
        // b: one row in the Landings section, and no merge row on the timeline.
        let row = app.buttons["landings-row"]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the Landings row is drawn")
        XCTAssertFalse(element(app, containing: "Earlier").exists, "the Earlier fold is gone")
        XCTAssertFalse(element(app, containing: "Merged into main").exists,
                       "no Merged into main row on the page's timeline")
        note("b: row at \(row.frame); label \(row.label)")
        write(app.debugDescription, "ios-b-project-page-tree.txt")
        shot(app, "ios-b-project-page")

        // d: the whole row opens the window, standing at its bottom — Now's two cards in view.
        press(row)
        XCTAssertTrue(appears(app, Self.footer, timeout: 20), "the window's footer never showed")
        XCTAssertTrue(appears(app, "Run by Orbit · Wiki server", timeout: 10), "the window's head")
        XCTAssertTrue(appears(app, "Notification cold start", timeout: 20), "the waiting card")
        XCTAssertTrue(appears(app, "Task page reload", timeout: 10), "the in-flight card")
        settle(2)
        XCTAssertTrue(element(app, containing: "Now").exists)
        XCTAssertTrue(app.buttons["Open Coordinator"].exists, "the waiting card's doors")
        write(app.debugDescription, "ios-d-window-tree.txt")
        shot(app, "ios-d-window")

        // e: the Merged into main row, opened in place.
        let merge = app.buttons["landings-row:LM1"]
        bring(app, merge, between: 150, and: 420, "e-merge-row")
        press(merge)
        XCTAssertTrue(appears(app, "Now on main · 2 tasks", timeout: 15), "the merge row's receipt")
        XCTAssertTrue(appears(app, "Merge check passed · 17m 41s", timeout: 15), "the round's own record")
        let receipt = element(app, containing: "Now on main · 2 tasks")
        bring(app, receipt, between: 120, and: 360, "e-receipt")
        settle(1)
        write(app.debugDescription, "ios-e-merge-open-tree.txt")
        shot(app, "ios-e-merge-open")
        app.terminate()
    }

    /// f: an Open landing › / orbit-session: id opens the window on that landing — scrolled to,
    /// opened and outlined for 1.5 s. The pictures are taken the moment it shows.
    func testIPhoneALandingsIdOpensTheWindowOnIt() {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.fresh",
                               "-ApplePersistenceIgnoreState", "YES", "-probe.page", "focus"]
        app.launch()
        dismissSystemPrompts()
        let record = "Rerun by the coordinator"
        if !waitUntil(45, { self.element(app, containing: record).exists }) {
            write(app.debugDescription, "missing-ios-f.txt")
            XCTFail("the landing the window was opened on never opened")
        }
        for index in 1...3 {
            shot(app, "ios-f-focused-\(index)")
            settle(0.35)
        }
        XCTAssertTrue(element(app, containing: "Generation 2").exists, "both generations in its record")
        XCTAssertTrue(app.buttons["Open Task ›"].exists || element(app, containing: "Open Task ›").exists,
                      "a task's record ends in Open Task ›")
        write(app.debugDescription, "ios-f-focused-tree.txt")
        settle(2)
        shot(app, "ios-f-focused-after")
        app.terminate()
    }

    /// g: a long press on a card holds its doors — the old landing page's ⋯, row for row.
    func testIPhoneALongPressOnACardShowsItsDoors() {
        let app = launch(until: "Task page reload", extra: ["-probe.page", "window"], "window")
        XCTAssertTrue(appears(app, Self.footer, timeout: 20))
        settle(2)
        // The simulator can drop a long press: two runs in a row drew no menu on the only try. Press the
        // card again, on another of its lines, until its menu is up — at most three times, each noted.
        var opened = false
        for (attempt, words) in ["Task page reload", "Merge check ", "Task page reload"].enumerated() where !opened {
            let target = element(app, containing: words)
            target.press(forDuration: 1.5)
            opened = app.buttons["Stop Landing"].waitForExistence(timeout: 5)
                || element(app, containing: "Before the push only · nothing pushed yet").exists
            note("g: long press \(attempt + 1) on \"\(words)\" at \(target.frame): menu \(opened ? "up" : "not up")")
            if !opened { settle(1) }
        }
        settle(1)
        XCTAssertTrue(opened, "the card's menu offers Stop Landing before the push")
        for word in ["Open Task", "Open Source Session", "Open Coordinator"] {
            XCTAssertTrue(element(app, containing: word).exists, "the menu offers \(word)")
        }
        XCTAssertFalse(element(app, containing: "Copy Link").exists)
        write(app.debugDescription, "ios-g-card-menu-tree.txt")
        shot(app, "ios-g-card-menu")
        app.terminate()
    }
    #endif

    #if os(macOS)
    /// The Mac's own window, opened on a landing's id: the project's Landings window in the detail
    /// pane, the landing opened and outlined, Now's cards under the days.
    func testMacALandingsIdOpensTheWindowOnIt() {
        let app = launch(until: "Rerun by the coordinator", extra: ["-probe.page", "focus"], "mac-focus")
        shot(app, "mac-window-focused")
        XCTAssertTrue(appears(app, Self.footer, timeout: 15), "the window's footer")
        XCTAssertTrue(appears(app, "Ledger migration order", timeout: 10))
        write(app.debugDescription, "mac-window-tree.txt")
        settle(2)
        shot(app, "mac-window")
        app.terminate()
    }
    #endif
}
