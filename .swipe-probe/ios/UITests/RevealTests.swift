import XCTest

// TEMPORARY evidence probe (see ../../README.md): the same slow drags on the system's swipe (Notes'
// shape, and the session rows' capsules) and on the circles, each run under a screen recording that
// run.sh starts and stops around it — how buttons grow in as a row opens and drop out as it shuts.
final class RevealTests: XCTestCase {
    override func setUp() { continueAfterFailure = true }

    func testNotes() { script("notes", title: "梳理导入流程，避免覆盖用户设置", other: "Shopping list") }
    func testNative() { script("native", title: "梳理导入流程，避免覆盖用户设置", other: "执行任务：整理发布清单") }
    func testCircles() { script("three", title: "梳理导入流程，避免覆盖用户设置", other: "执行任务：整理发布清单") }

    private func script(_ variant: String, title: String, other: String) {
        let app = XCUIApplication()
        app.launchArguments = ["-variant", variant]
        app.launch()
        _ = app.staticTexts["log"].waitForExistence(timeout: 60)
        pause(1.5)
        let target = row(app, title)
        let width = target.frame.width
        // A — open slowly to about 200pt, hold, let go (it stays open), then a tap elsewhere shuts it.
        drag(target, from: 0.95, by: -200 / width, speed: 250, hold: 1.2)
        pause(1.5)
        row(app, other).tap()
        pause(1.5)
        // B — a short pull (60pt) let go: it falls back shut.
        drag(target, from: 0.95, by: -60 / width, speed: 200, hold: 0.8)
        pause(1.5)
        // C — the other side, about 120pt, held, let go, shut by a tap.
        drag(target, from: 0.05, by: 120 / width, speed: 250, hold: 1.0)
        pause(1.5)
        row(app, other).tap()
        pause(1.5)
        app.terminate()
    }

    private func drag(_ element: XCUIElement, from x: CGFloat, by dx: CGFloat, speed: CGFloat, hold: TimeInterval) {
        let start = element.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.5))
        let end = element.coordinate(withNormalizedOffset: CGVector(dx: x + dx, dy: 0.5))
        start.press(forDuration: 0.1, thenDragTo: end, withVelocity: XCUIGestureVelocity(speed),
                    thenHoldForDuration: hold)
    }

    private func row(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        let cell = app.cells.containing(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        if cell.exists { return cell }
        let button = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        if button.exists { return button }
        return app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    }

    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }
}
