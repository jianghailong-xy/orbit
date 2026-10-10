import XCTest

// TEMPORARY evidence probe (see ../README.md): where most left-edge swipes land on an iPad's session
// list today — on a session row, whose own rightward swipe (Complete · Pin) takes the drag before
// the split view's sidebar gesture can. A short drag leaves the row's buttons open; a long one runs
// the first of them (the stub refuses the write and logs it).
final class RowEdgeTests: ProbeCase {
    private let row = "会话列表左滑按钮"

    func testF_RowUnderTheEdge() {
        let app = launch(scene: "list", sidebar: false, orientation: .landscapeLeft)
        waitList(app)
        let cell = labelled(app, row)
        note("F: row \(describe(cell))")
        let y = cell.exists ? cell.frame.midY / app.windows.firstMatch.frame.height : 0.68

        drag(app, fromX: 2, toX: 170, atY: y, "F1")
        settle(1.5)
        shot("F1-short-edge-swipe-on-a-row")
        tree(app, "F1")
        rowActions(app, "F1")
        note("F1: sidebar \(sidebarShowing(app))")

        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.3)).tap()
        settle(1.5)

        drag(app, fromX: 2, toX: 560, atY: y, "F2")
        settle(2.5)
        shot("F2-long-edge-swipe-on-a-row")
        rowActions(app, "F2")
        note("F2: sidebar \(sidebarShowing(app))")
        app.terminate()
    }

    /// Mac Studio's record, reached by the engine page's Back with the sidebar still hidden — the
    /// screen a back swipe on that page should land on.
    func testG_RecordSidebarHidden() {
        let app = launch(scene: "engine", sidebar: false, orientation: .landscapeLeft)
        if !app.buttons["Back"].waitForExistence(timeout: 60) {
            note("G: no Back on the engine page")
            tree(app, "missing-engine-page-G")
        }
        settle(3)
        tapButton(app, "Back", "G1")
        settle(1.5)
        shot("G1-record-sidebar-hidden")
        frames(app, "G1")
        app.terminate()
    }
}
