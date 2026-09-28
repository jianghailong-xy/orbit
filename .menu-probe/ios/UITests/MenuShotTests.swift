import XCTest

// TEMPORARY evidence probe (see ../../README.md): open each variant's options menu, photograph it,
// then open Filter by Tag and photograph that. Soft failures: whatever cannot be found is written
// next to the pictures and the run moves on, so one pass collects every picture it can.
final class MenuShotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    /// The function that ships, cut out of AgentsView.swift: iPhone with nothing chosen, iPhone with
    /// everything chosen (and its tag submenu), and the iPad shape without the scope rows.
    func test2Real() {
        shoot("real", "default", submenu: false)
        shoot("real", "full", submenu: true)
        shoot("real-ipad", "full", submenu: false)
    }

    private func shoot(_ variant: String, _ state: String, submenu: Bool) {
        let name = "\(variant)-\(state)"
        let app = XCUIApplication()
        app.launchArguments = ["-variant", variant, "-state", state]
        app.launch()
        let button = app.buttons["options"]
        guard button.waitForExistence(timeout: 60) else {
            write(app.debugDescription, "missing-options-\(name).txt")
            app.terminate()
            return
        }
        Thread.sleep(forTimeInterval: 1)
        button.tap()
        Thread.sleep(forTimeInterval: 1.5)
        save(name)
        write(app.debugDescription, "\(name)-tree.txt")
        if submenu {
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Filter by Tag'")).firstMatch
            if row.waitForExistence(timeout: 5) {
                row.tap()
                Thread.sleep(forTimeInterval: 1.5)
                save("\(name)-submenu")
                write(app.debugDescription, "\(name)-submenu-tree.txt")
            } else {
                write(app.debugDescription, "missing-filter-\(name).txt")
            }
        }
        app.terminate()
    }

    private func save(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    private func write(_ text: String, _ file: String) {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? text.write(to: URL(fileURLWithPath: dir).appendingPathComponent(file), atomically: true, encoding: .utf8)
    }
}
