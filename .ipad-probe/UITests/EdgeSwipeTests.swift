import XCTest

// TEMPORARY evidence probe (see ../README.md): what a rightward swipe from a column's left edge does
// on an iPad today, and the screens a button press reaches instead — the frames the design board is
// drawn on. Each step is photographed and its outcome noted (sidebar showing or not, page still up
// or not); nothing here fails the run but a missing screen.
final class EdgeSwipeTests: ProbeCase {

    /// The session list beside the conversation, sidebar hidden: the screen's left edge, the
    /// sidebar button, and a left swipe over the sidebar it brought back.
    func testA_ListLandscape() {
        let app = launch(scene: "list", sidebar: false, orientation: .landscapeLeft)
        waitList(app)
        shot("A1-list-sidebar-hidden")
        tree(app, "A1")
        frames(app, "A1")

        drag(app, fromX: 2, toX: 560, atY: 0.62, "A2")
        settle(2)
        shot("A2-after-edge-swipe")
        tree(app, "A2")
        frames(app, "A2")
        rowActions(app, "A2")
        note("A: sidebar after the edge swipe: \(sidebarShowing(app))")

        // Whatever the swipe opened on a row closes with a tap on the conversation.
        let window = app.windows.firstMatch
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.3)).tap()
        settle(1)

        tapSidebarButton(app, "A3")
        shot("A3-sidebar-by-button")
        tree(app, "A3")
        frames(app, "A3")
        note("A: sidebar after the button: \(sidebarShowing(app))")

        let gear = app.buttons["Settings"]
        let startX = gear.exists ? max(gear.frame.minX - 60, 60) : 200
        drag(app, fromX: startX, toX: 8, atY: 0.5, "A4")
        settle(2)
        shot("A4-after-left-swipe-on-sidebar")
        frames(app, "A4")
        note("A: sidebar after a left swipe over it: \(sidebarShowing(app))")
        app.terminate()
    }

    /// A folder's page in the list column: the screen's edge with the sidebar hidden, the Back
    /// button, and the column's edge beside the sidebar.
    func testB_FolderLandscape() {
        let app = launch(scene: "list", sidebar: false, orientation: .landscapeLeft)
        waitList(app)
        openFolder(app, "B1")
        shot("B1-folder-page")
        tree(app, "B1")
        frames(app, "B1")

        drag(app, fromX: 2, toX: 560, atY: 0.62, "B2")
        settle(2)
        shot("B2-after-edge-swipe")
        frames(app, "B2")
        rowActions(app, "B2")
        note("B: folder page after the edge swipe: \(app.buttons["Folder actions"].exists ? "still up" : "gone")")
        note("B: sidebar after the edge swipe: \(sidebarShowing(app))")

        tapButton(app, folderBack, "B3")
        shot("B3-back-by-button")
        frames(app, "B3")

        tapSidebarButton(app, "B4")
        openFolder(app, "B4")
        shot("B4-folder-page-sidebar-shown")
        tree(app, "B4")
        frames(app, "B4")
        let back = app.buttons[folderBack]
        let column = bar(holding: back, in: app)
        note("B4: the folder page's bar \(String(describing: column))")
        let edge = (column?.minX ?? 320) + 3
        drag(app, fromX: edge, toX: edge + 480, atY: 0.62, "B5")
        settle(2)
        shot("B5-after-column-edge-swipe")
        frames(app, "B5")
        rowActions(app, "B5")
        note("B: folder page after the column-edge swipe: \(app.buttons["Folder actions"].exists ? "still up" : "gone")")
        app.terminate()
    }

    /// A project's sessions page in the list column, sidebar hidden.
    func testC_ProjectLandscape() {
        let app = launch(scene: "list", sidebar: false, orientation: .landscapeLeft)
        waitList(app)
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@ AND label != %@", project, project)).firstMatch
        if !row.waitForExistence(timeout: 20) {
            note("C: no project row in the list")
            tree(app, "missing-project-row")
        }
        note("C: project row \(describe(row))")
        row.tap()
        let header = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Project · ")).firstMatch
        if !header.waitForExistence(timeout: 20) {
            note("C: no project page after the tap")
            tree(app, "missing-project-page")
        }
        settle(2)
        shot("C1-project-page")
        tree(app, "C1")
        frames(app, "C1")

        drag(app, fromX: 2, toX: 560, atY: 0.62, "C2")
        settle(2)
        shot("C2-after-edge-swipe")
        frames(app, "C2")
        rowActions(app, "C2")
        note("C: project page after the edge swipe: \(header.exists ? "still up" : "gone")")

        tapButton(app, folderBack, "C3")
        shot("C3-back-by-button")
        frames(app, "C3")
        app.terminate()
    }

    /// Infrastructure: a machine's record with its Claude Code page over it in the detail column.
    func testD_EngineLandscape() {
        let app = launch(scene: "engine", sidebar: false, orientation: .landscapeLeft)
        let back = app.buttons["Back"]
        if !back.waitForExistence(timeout: 60) {
            note("D: no Back on the engine page")
            tree(app, "missing-engine-page")
        }
        settle(3)
        shot("D1-engine-page")
        tree(app, "D1")
        frames(app, "D1")
        let column = bar(holding: back, in: app)
        note("D1: the engine page's bar \(String(describing: column))")

        let edge = (column?.minX ?? 420) + 3
        drag(app, fromX: edge, toX: edge + 480, atY: 0.55, "D2")
        settle(2)
        shot("D2-after-detail-edge-swipe")
        tree(app, "D2")
        frames(app, "D2")
        note("D: engine page after the detail-edge swipe: \(app.buttons["Back"].exists ? "still up" : "gone")")

        drag(app, fromX: 2, toX: 560, atY: 0.55, "D3")
        settle(2)
        shot("D3-after-screen-edge-swipe")
        frames(app, "D3")
        note("D: sidebar after the screen-edge swipe: \(sidebarShowing(app))")

        tapButton(app, "Back", "D4")
        shot("D4-record-by-button")
        tree(app, "D4")
        frames(app, "D4")
        app.terminate()
    }

    /// The same list in portrait, where the system lays the sidebar out its own way.
    func testE_ListPortrait() {
        let app = launch(scene: "list", sidebar: false, orientation: .portrait)
        waitList(app)
        shot("E1-portrait-list")
        tree(app, "E1")
        frames(app, "E1")

        drag(app, fromX: 2, toX: 520, atY: 0.62, "E2")
        settle(2)
        shot("E2-after-edge-swipe")
        frames(app, "E2")
        rowActions(app, "E2")
        note("E: sidebar after the edge swipe: \(sidebarShowing(app))")

        let window = app.windows.firstMatch
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.3)).tap()
        settle(1)
        tapSidebarButton(app, "E3")
        shot("E3-sidebar-by-button")
        tree(app, "E3")
        frames(app, "E3")

        let gear = app.buttons["Settings"]
        let startX = gear.exists ? max(gear.frame.minX - 60, 60) : 200
        drag(app, fromX: startX, toX: 8, atY: 0.5, "E4")
        settle(2)
        shot("E4-after-left-swipe-on-sidebar")
        frames(app, "E4")
        note("E: sidebar after a left swipe over it: \(sidebarShowing(app))")
        app.terminate()
    }

    // MARK: helpers

    private func openFolder(_ app: XCUIApplication, _ name: String) {
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", folder)).firstMatch
        if !row.waitForExistence(timeout: 20) {
            note("[\(name)] no folder row for \(folder)")
            tree(app, "missing-folder-row-\(name)")
        }
        for attempt in 1...2 {
            row.tap()
            settle(2)
            if app.buttons["Folder actions"].waitForExistence(timeout: 10) { return }
            note("[\(name)] no folder page after tap \(attempt)")
        }
        tree(app, "missing-folder-page-\(name)")
    }
}
