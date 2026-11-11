import XCTest

// TEMPORARY evidence probe (never merged): the iPhone composer band folded while the reader goes back
// through the history — main before the pill (base: the 36pt full-width bar) and after it (fix: the
// Safari-style centred pill). The same launches, waits and drags run on both trees.
final class PillShotTests: ProbeCase {
    private let tail = "导出好了"

    private var pill: XCUIElement {
        XCUIApplication().buttons.matching(NSPredicate(format: "label == 'Show the composer'")).firstMatch
    }

    func test1Idle() {
        let app = launch("console", session: "S1", dark: true, until: tail, "idle-dark")
        opened(app, "idle-dark")
        settle(1.5)
        shot("1-tail-dark")
        scrollUp(app, by: 220)
        scrollUp(app, by: 220)
        settle(1)
        shot("2-folded-dark")
        describePill("folded-dark")
        shot(pill, "2z-pill-dark")
        tree(app, "folded-dark")
        if pill.exists, pill.isHittable {
            pill.tap()
            settle(1.5)
            shot("3-opened-dark")
            let jump = app.buttons.matching(NSPredicate(format: "label == 'Scroll to latest'")).firstMatch
            note("opened-dark: jump disc \(describe(jump))")
            scrollUp(app, by: 120)
            settle(1)
            shot("4-refolded-dark")
            describePill("refolded-dark")
        } else {
            XCTFail("folded-dark: no pill to press")
        }
        app.terminate()
    }

    func test2Running() {
        let app = launch("console", session: "S2", dark: true, until: tail, "running-dark")
        opened(app, "running-dark")
        settle(1.5)
        scrollUp(app, by: 220)
        scrollUp(app, by: 220)
        settle(1)
        shot("5-running-dark")
        describePill("running-dark")
        shot(pill, "5z-pill-running-dark")
        app.terminate()
    }

    func test3Draft() {
        let app = launch("console", session: "S1", dark: true, until: tail, "draft-dark")
        opened(app, "draft-dark")
        settle(1.5)
        // The composer's own field: its placeholder, not a transcript row (rows are text views too).
        let byPlaceholder = NSPredicate(format: "placeholderValue BEGINSWITH 'Message'")
        let fields = (app.textViews.matching(byPlaceholder).allElementsBoundByIndex
                      + app.textFields.matching(byPlaceholder).allElementsBoundByIndex)
            .filter { $0.exists && $0.isHittable }
        note("draft-dark: \(fields.count) composer field(s)")
        guard let field = fields.last else {
            write(app.debugDescription, "no-field-draft-dark.txt")
            XCTFail("draft-dark: no composer field")
            return
        }
        field.tap()
        settle(1)
        field.typeText("Also check the Android build before the tag")
        settle(0.8)
        shot("6a-typing-dark")
        // The drag that takes the keyboard leaves the band open; the next one folds it.
        scrollUp(app, by: 200)
        settle(1)
        scrollUp(app, by: 220)
        scrollUp(app, by: 220)
        settle(1)
        shot("6-draft-dark")
        describePill("draft-dark")
        shot(pill, "6z-pill-draft-dark")
        app.terminate()
    }

    func test4Light() {
        let app = launch("console", session: "S1", dark: false, until: tail, "idle-light")
        opened(app, "idle-light")
        settle(1.5)
        scrollUp(app, by: 220)
        scrollUp(app, by: 220)
        settle(1)
        shot("7-folded-light")
        describePill("folded-light")
        shot(pill, "7z-pill-light")
        app.terminate()
    }

    private func describePill(_ name: String) {
        let p = pill
        let screen = XCUIApplication().windows.firstMatch.frame
        if p.exists {
            note("\(name): pill \(describe(p)) value=\(p.value as? String ?? "-") "
                 + "frame=\(p.frame) screen=\(screen) bottom-gap=\(screen.maxY - p.frame.maxY)")
        } else {
            note("\(name): no pill on screen")
        }
    }

    private func opened(_ app: XCUIApplication, _ name: String) {
        let header = app.buttons.matching(NSPredicate(format: "label == 'Jump to your last question'")).firstMatch
        if header.waitForExistence(timeout: 30) {
            note("\(name): header \(describe(header))")
        } else {
            note("\(name): the transcript's sticky header never showed")
        }
    }

    /// Move the transcript `points` toward its start with no momentum: a slow drag held at its end,
    /// at the left margin, clear of the rows' controls.
    private func scrollUp(_ app: XCUIApplication, by points: CGFloat) {
        let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: 0.35))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: points)),
                    withVelocity: .slow, thenHoldForDuration: 0.8)
        settle(1.2)
    }
}
