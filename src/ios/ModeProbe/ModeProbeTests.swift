import XCTest

final class ModeProbeTests: XCTestCase {
    @MainActor
    func testPermissionModeBoard() {
        continueAfterFailure = false
        let app = XCUIApplication()
        func open(_ session: String, _ mode: String) -> XCUIElement {
            app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.mode", session]
            app.launch()
            let label = "Mode: " + mode
            let menu = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
            XCTAssertTrue(menu.waitForExistence(timeout: 45), app.debugDescription)
            return menu
        }
        func see(_ text: String) {
            let line = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
            XCTAssertTrue(line.waitForExistence(timeout: 10), app.debugDescription)
        }
        func photograph(_ name: String) {
            let attachment = XCTAttachment(screenshot: app.screenshot())
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
        }

        _ = open("S1", "Auto")
        photograph("01-running-auto")
        app.terminate()

        _ = open("S2", "Default → Auto")
        photograph("02-running-gap")
        app.terminate()

        _ = open("S3", "Auto")
        see("Mode set to Default by you on iOS")
        see("Mode set back to Auto by the runner")
        see("Engine restarted in Auto")
        photograph("03-attributed-mode-history")
        app.terminate()

        let menu = open("S4", "Auto")
        menu.tap()
        see("Auto — starts in Default")
        photograph("04-pre-start-auto-picker")
    }
}
