import XCTest

// TEMPORARY evidence probe (never merged): the owner-confirmation card on a phone, against
// `oc-stub.py`'s two waiting confirmations — the mock's own data (docs/mocks/
// owner-confirmation-review-ios.html, phone ②) and a project task with every row of If you confirm.
// What is photographed: the screen at the press (the report's end, If you confirm, the buttons), the
// card's top with what counts as done folded to one row, that row opened in place, the same press in
// dark, and the project task's block. Soft failures: whatever cannot be found is noted next to the
// pictures with the element tree, and the run moves on.
final class OwnerConfirmationShotTests: ProbeCase {
    let mockSession = "修复 P1 审查发现的问题"
    let projectSession = "If you confirm"

    /// Launch, let the list settle (a first gesture right after launch can land as something
    /// else), and open the session whose run is waiting — until its card's Confirm done is there.
    func openCard(_ title: String, dark: Bool, _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765"] + (dark ? ["-dark"] : [])
        app.launch()
        if !row(app, title, quiet: true).waitForExistence(timeout: 60) {
            note("\(name): the list never showed \(title)")
            write(app.debugDescription, "missing-list-\(name).txt")
        }
        settle(4)
        tapRow(app, title)
        if !app.buttons["Confirm done"].waitForExistence(timeout: 45) {
            note("\(name): no Confirm done")
            write(app.debugDescription, "missing-card-\(name).txt")
        }
        settle(3)
        return app
    }

    /// Drag the transcript until `element` sits inside the band between `top` and `bottom` (points
    /// from the window's top), holding at the end of each drag so it carries no momentum.
    func bring(_ app: XCUIApplication, _ element: XCUIElement, between top: CGFloat, and bottom: CGFloat,
               missingIsAbove: Bool, _ name: String) {
        let window = app.windows.firstMatch
        for attempt in 1...10 {
            if element.exists, element.isHittable, element.frame.minY >= top, element.frame.maxY <= bottom {
                note("\(name): in view after \(attempt - 1) drag(s) at \(element.frame)")
                return
            }
            // Content below the band: drag up (scroll down); above it: drag down. A lazy row that is
            // not loaded yet is where the caller says it is. The drag starts in the screen's margin,
            // off the card, so it can never press one of the card's buttons.
            let below = element.exists ? element.frame.maxY > bottom : !missingIsAbove
            let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: below ? 0.62 : 0.3))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: below ? -150 : 150)),
                        withVelocity: .slow, thenHoldForDuration: 0.6)
            settle(1)
        }
        note("\(name): never in the band \(top)–\(bottom); last frame \(element.frame)")
        write(app.debugDescription, "missing-band-\(name).txt")
    }

    /// The screen at the press: Confirm done low on the screen, so what is above it is what the owner
    /// sees as they press — the mock's phone ②.
    func pressView(_ app: XCUIApplication, _ name: String) {
        let height = app.windows.firstMatch.frame.height
        bring(app, app.buttons["Confirm done"], between: height * 0.45, and: height * 0.78,
              missingIsAbove: false, name)
        settle(1.5)
        shot(name)
        tree(app, name)
    }

    func test1TheMocksCard() {
        let app = openCard(mockSession, dark: false, "mock")
        pressView(app, "1-at-the-press-light")
        XCTAssertTrue(app.staticTexts["IF YOU CONFIRM"].exists, "the block is drawn")
        XCTAssertTrue(app.staticTexts["Starts 1 task waiting on this one"].exists, "the dependent's row")

        // The card's top: its heading under the bars, what counts as done folded to one row.
        let heading = app.staticTexts["Confirm this task is done?"]
        bring(app, heading, between: 165, and: 460, missingIsAbove: true, "2-card-top-light")
        settle(1.5)
        shot("2-card-top-light")

        let fold = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "WHAT COUNTS AS DONE")).firstMatch
        if fold.waitForExistence(timeout: 5) {
            note("fold label: \(fold.label)")
            fold.tap()
            settle(1.5)
            shot("3-criteria-open-light")
        } else {
            note("no fold row")
            write(app.debugDescription, "missing-fold.txt")
        }
        app.terminate()
    }

    func test2TheMocksCardInDark() {
        let app = openCard(mockSession, dark: true, "mock-dark")
        pressView(app, "4-at-the-press-dark")
        app.terminate()
    }

    func test3AProjectTaskWithEveryRow() {
        let app = openCard(projectSession, dark: false, "project")
        pressView(app, "5-every-row-light")
        for line in ["Starts 1 task once this lands", "Goes onto the integration line; merging into main asks you again",
                     "Ends this session · 2 background jobs stop"] {
            XCTAssertTrue(app.staticTexts[line].exists, "the project task's block says \(line)")
        }
        app.terminate()
    }
}
