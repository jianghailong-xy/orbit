import XCTest

// TEMPORARY evidence probe (never merged): the iPad app against stub.py (task I2, mock 32 after). Landscape, the
// sidebar shown: the sidebar's Wiki row opens the Wiki with the directory in the middle column — Home lit — and
// the content home in the detail pane; a document from the column fills the detail pane; Activity and the
// settings open there too, the column lighting no row.
final class WikiPadShotsTests: WikiShotsCase {

    func testTheDirectoryBesideTheContent() {
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = launch(port: 8765, ["-shell.sidebarVisible", "YES"])
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Wiki",
                                                   "1 waiting on you")).firstMatch
        guard row.waitForExistence(timeout: 60) else {
            tree(app, "pad-no-wiki-row")
            return XCTFail("the sidebar drew no Wiki row saying 1 waiting on you")
        }
        settle(2)
        row.tap()

        // The middle column is the directory; the detail pane is the content home, not an empty state.
        for item in ["Browse by category", "A–Z index", "Plan"] {
            XCTAssertTrue(waitLabel(app, item, contains: true), "the directory column lists \(item)")
        }
        XCTAssertTrue(waitLabel(app, "35 documents · 5 written"), "the detail pane is the home")
        XCTAssertTrue(waitLabel(app, "Orbit 是自托管的 coding agent 控制台", contains: true), "with the documents' leads")
        XCTAssertTrue(absent(app, "Pick an entry, or open Review."), "no empty detail pane")
        let space = app.staticTexts["The codebase this wiki describes"]
        XCTAssertTrue(space.waitForExistence(timeout: 10), "the column's head names the space")
        let activity = app.buttons["Activity"].firstMatch
        XCTAssertTrue(activity.waitForExistence(timeout: 10), "the detail pane's bar has Activity")
        XCTAssertEqual(activity.value as? String, "1 waiting on you")
        settle(2.5)
        shot("31-pad-wiki")
        tree(app, "pad-wiki")

        // A document from the column fills the detail pane.
        if let doc = button(app, containing: "Session 运行与恢复") {
            note("column row: \(describe(doc))")
            doc.tap()
            XCTAssertTrue(waitLabel(app, "会话运行模型与长连接：总览", timeout: 30, contains: true), "the document's page")
            XCTAssertTrue(absent(app, "35 documents · 5 written"), "in place of the home")
            settle(2)
            shot("32-pad-doc")
            tree(app, "pad-doc")
        } else {
            XCTFail("the column lists no 3.1")
        }

        // Home again, then Activity from the detail pane's bar: it opens beside the directory.
        if let home = button(app, containing: "Home") {
            home.tap()
            XCTAssertTrue(waitLabel(app, "35 documents · 5 written", timeout: 30), "Home puts the home back")
        } else {
            XCTFail("the column has no Home row")
        }
        let bar = app.buttons["Activity"].firstMatch
        if bar.waitForExistence(timeout: 10) {
            bar.tap()
            XCTAssertTrue(waitLabel(app, "1 proposal to review", timeout: 30), "Activity in the detail pane")
            XCTAssertTrue(waitLabel(app, "Recent decisions", contains: true))
            XCTAssertTrue(waitLabel(app, "Browse by category", contains: true), "the directory still beside it")
            settle(2)
            shot("33-pad-activity")
            tree(app, "pad-activity")
        } else {
            XCTFail("no Activity in the bar")
        }

        // Home again, then the settings from the gear.
        button(app, containing: "Home")?.tap()
        XCTAssertTrue(waitLabel(app, "35 documents · 5 written", timeout: 30))
        if let gear = button(app, containing: "Settings", leftmost: false) {
            note("gear: \(describe(gear))")
            gear.tap()
            XCTAssertTrue(waitLabel(app, "Maintenance", timeout: 30, contains: true), "the Wiki's settings in the detail pane")
            settle(2)
            shot("34-pad-settings")
            tree(app, "pad-settings")
        } else {
            XCTFail("no gear in the detail pane's bar")
        }
    }
}
