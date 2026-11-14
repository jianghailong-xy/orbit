import XCTest

// TEMPORARY evidence probe (see ../README.md). Owner 2026-11-14: on the iPhone, a session-list project
// row whose second line says a member is waiting on you opens THAT member, at the top of its waiting
// card; Back returns to the list. Pictures and frames are written to SHOTS_DIR.
final class WaitingRowShotTests: ProbeCase {
    private let row = "GitHub-backed workspaces"
    private let cardTitle = "Which GitHub App should workspaces sign in with?"

    private func start(_ session: String?, until label: String, _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.agent", "a1",
                               "-ApplePersistenceIgnoreState", "YES", "-probe.fresh"]
            + (session.map { ["-probe.session", $0] } ?? [])
        app.launch()
        if !appears(app, label, timeout: 60) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(label) never showed")
        }
        settle(2.5)
        return app
    }

    /// The bottom of the navigation bar: what a row has to be below to be readable.
    private func barBottom(_ app: XCUIApplication) -> CGFloat {
        let bar = app.navigationBars.firstMatch
        return bar.exists ? bar.frame.maxY : 0
    }

    func test1_TheWaitingRowOpensTheMemberAtItsCard() {
        let app = start(nil, until: row, "list")
        let projectRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", row)).firstMatch
        note("project row: \(describe(projectRow))")
        XCTAssertTrue(projectRow.label.contains("Waiting"), "the row's line says a member is waiting on you")
        shot("1-session-list")
        tree(app, "1-session-list")

        projectRow.tap()
        XCTAssertTrue(appears(app, cardTitle, timeout: 30), "the member's question card is on screen")
        settle(3)
        shot("2-member-opened-from-the-row")
        tree(app, "2-member-opened-from-the-row")

        let title = containing(app, cardTitle)
        let bar = barBottom(app)
        let height = app.windows.firstMatch.frame.height
        note("nav bar bottom: \(bar); window height: \(height)")
        note("card title: \(describe(title))")
        note("card header: \(describe(containing(app, "Waiting on you")))")
        note("send answer: \(describe(containing(app, "Send answer")))")
        note("member's words in view: \(containing(app, "I need one decision").exists)")
        note("coordinator's reply in view: \(containing(app, "P0 is waiting on your answer").exists)")
        XCTAssertTrue(title.exists && title.frame.minY >= bar && title.frame.minY < height,
                      "the card's title sits below the bar, on screen: \(title.frame) vs bar \(bar)")
        XCTAssertTrue(title.exists && title.frame.minY < bar + (height - bar) / 2,
                      "opened at the card's top, not at the transcript's end: title at \(title.frame.minY)")
        XCTAssertFalse(containing(app, "P0 is waiting on your answer").exists, "the coordinator was not opened")

        let back = app.navigationBars.buttons["BackButton"].exists
            ? app.navigationBars.buttons["BackButton"] : app.navigationBars.buttons.firstMatch
        note("back: \(describe(back))")
        back.tap()
        settle(2)
        XCTAssertTrue(appears(app, row, timeout: 15), "Back returns to the session list")
        XCTAssertFalse(containing(app, cardTitle).exists, "the conversation is gone")
        shot("3-back-to-the-list")
    }

    /// The same conversation opened any other way (here a link's route) keeps today's place: the end
    /// of the transcript. Recorded for comparison; nothing here fails the run.
    func test2_TheSameMemberOpenedAnotherWayKeepsTheEnd() {
        let app = start("P0", until: cardTitle, "route")
        settle(3)
        shot("4-member-opened-by-a-link")
        tree(app, "4-member-opened-by-a-link")
        let title = containing(app, cardTitle)
        note("nav bar bottom: \(barBottom(app)); window height: \(app.windows.firstMatch.frame.height)")
        note("card title: \(describe(title))")
        note("send answer: \(describe(containing(app, "Send answer")))")
    }
}
