import XCTest

// TEMPORARY evidence probe (see ../../README.md): photograph the session rows' swipe actions as the
// system drew them and as circles, and drive the circles. Soft failures: whatever cannot be found is
// noted next to the pictures and the run moves on, so one pass collects everything it can.
final class SwipeShotTests: XCTestCase {
    private let first = "执行任务：整理发布清单"
    private let second = "检查错误提示的显示"
    private let target = "梳理导入流程，避免覆盖用户设置"
    private var notes: [String] = []

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        let file = name.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        write(notes.joined(separator: "\n"), "\(file)-notes.txt")
    }

    /// Before: the system's buttons — and the row heights the circles have to keep.
    func test1Native() {
        let app = launch("native")
        shot("native-1-rest")
        cells(app, "native-rest")
        row(app, target).swipeRight(); settle()
        shot("native-2-right")
        frames(app, ["Complete", "Pin"], "native-right")
        row(app, first).tap(); settle()
        row(app, target).swipeLeft(); settle()
        shot("native-3-left")
        frames(app, ["Delete"], "native-left")
        app.terminate()

        let light = launch("native", dark: false)
        row(light, target).swipeRight(); settle()
        shot("native-4-right-light")
        row(light, first).tap(); settle()
        row(light, target).swipeLeft(); settle()
        shot("native-5-left-light")
        light.terminate()
    }

    /// After: the real `sessionRowActions` on the Open tab.
    func test2Open() {
        let app = launch("open")
        shot("open-1-rest")
        cells(app, "open-rest")
        tree(app, "open-rest")
        note("at rest: Complete buttons = \(app.buttons.matching(NSPredicate(format: "label == %@", "Complete")).count), Delete buttons = \(app.buttons.matching(NSPredicate(format: "label == %@", "Delete")).count)")
        row(app, target).swipeRight(); settle()
        shot("open-2-right")
        frames(app, ["Complete", "Pin"], "open-right")
        cells(app, "open-right")
        tree(app, "open-right")
        note("open right: Complete buttons = \(app.buttons.matching(NSPredicate(format: "label == %@", "Complete")).count), Delete buttons = \(app.buttons.matching(NSPredicate(format: "label == %@", "Delete")).count)")
        row(app, first).tap(); settle()
        shot("open-3-closed-by-tap")
        row(app, target).swipeLeft(); settle()
        shot("open-4-left")
        frames(app, ["Delete"], "open-left")
        app.terminate()

        let light = launch("open", dark: false)
        row(light, target).swipeRight(); settle()
        shot("open-5-right-light")
        row(light, first).tap(); settle()
        row(light, target).swipeLeft(); settle()
        shot("open-6-left-light")
        light.terminate()
    }

    /// The other two tabs: Move to Open in place of Complete, and Trash's wide Delete Permanently.
    func test3Tabs() {
        for variant in ["completed", "trash"] {
            let app = launch(variant)
            row(app, target).swipeRight(); settle()
            shot("\(variant)-1-right")
            frames(app, ["Move to Open", "Pin", "Unpin"], "\(variant)-right")
            row(app, first).tap(); settle()
            row(app, target).swipeLeft(); settle()
            shot("\(variant)-2-left")
            frames(app, ["Delete", "Delete Permanently"], "\(variant)-left")
            app.terminate()
        }
    }

    /// Three trailing buttons, and what taps, a full swipe and a scroll do — every action is logged
    /// on screen.
    func test4Behaviour() {
        let app = launch("three")
        row(app, target).swipeLeft(); settle()
        shot("three-1-left")
        frames(app, ["Share", "Move", "Delete"], "three-left")

        tap(app, "Move")
        expectLog(app, "Move s3", "a circle runs its action")
        shot("three-2-after-move")
        XCTAssertFalse(app.buttons["Move"].exists, "and the row shuts")

        row(app, target).swipeRight(); settle()
        tap(app, "Pin")
        expectLog(app, "Pin s3", "the leading side's second circle")

        row(app, target).swipeRight(); settle()
        row(app, first).tap(); settle()
        shot("three-3-tap-on-another-row")
        expectLog(app, "Pin s3", "a tap while a row is open only shuts it — it opens nothing")
        XCTAssertFalse(app.buttons["Pin"].exists, "the open row shut")

        row(app, first).tap(); settle()
        expectLog(app, "open s1", "with nothing open, a tap opens the session")

        let r2 = row(app, second)
        let from = r2.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
        let to = r2.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.3)
        settle(1.5)
        expectLog(app, "Complete s2", "a full swipe right completes")
        shot("three-4-after-full-swipe")

        row(app, target).swipeLeft(); settle()
        row(app, first).swipeLeft(); settle()
        shot("three-5-second-row-opened")
        note("after opening s1 with s3 open: Delete buttons on screen = \(app.buttons.matching(NSPredicate(format: "label == %@", "Delete")).count)")

        row(app, first).tap(); settle()
        row(app, target).swipeUp(); settle()
        shot("three-6-after-vertical-drag")
        XCTAssertFalse(app.buttons["Delete"].exists, "a vertical drag opens nothing")
        XCTAssertFalse(app.buttons["Pin"].exists, "a vertical drag opens nothing")
        cells(app, "three-scrolled")
        app.terminate()
    }

    /// Open and shut rows one after another, each way, so the separators either side of a swiped
    /// row can be checked on every one of them.
    func test5Separators() {
        let app = launch("open")
        let titles = [first, second, target, "设置页整体改版（iOS/macOS + web）", "判断：设置页改版的下一步"]
        for (i, title) in titles.enumerated() {
            row(app, title).swipeLeft(); settle()
            shot("sep-\(i)-left")
            row(app, title == first ? second : first).tap(); settle()
            row(app, title).swipeRight(); settle()
            shot("sep-\(i)-right")
            row(app, title == first ? second : first).tap(); settle()
        }
        cells(app, "sep-end")
        app.terminate()
    }

    // MARK: helpers

    private func tree(_ app: XCUIApplication, _ name: String) {
        write(app.debugDescription, "tree-\(name).txt")
    }

    private func launch(_ variant: String, dark: Bool = true) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-variant", variant] + (dark ? ["-dark"] : [])
        app.launch()
        if !app.staticTexts["log"].waitForExistence(timeout: 60) {
            note("\(variant): the list never appeared")
            write(app.debugDescription, "missing-\(variant).txt")
        }
        settle(1)
        return app
    }

    /// The row whose session has this title: its cell, or the row's button where cells aren't exposed.
    private func row(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        let cell = app.cells.containing(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        if cell.exists { return cell }
        note("no cell for \(title); using its button")
        return app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    }

    private func tap(_ app: XCUIApplication, _ label: String) {
        let button = app.buttons[label]
        guard button.waitForExistence(timeout: 3) else {
            note("no \(label) button to tap")
            write(app.debugDescription, "missing-\(label).txt")
            return
        }
        button.tap()
        settle()
    }

    private func expectLog(_ app: XCUIApplication, _ expected: String, _ why: String) {
        let log = app.staticTexts["log"].label
        note("\(why): expected …\(expected), log = \(log)")
        XCTAssertTrue(log.hasSuffix(expected), "\(why): \(log)")
    }

    private func settle(_ seconds: TimeInterval = 0.8) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func cells(_ app: XCUIApplication, _ label: String) {
        let lines = app.cells.allElementsBoundByIndex.enumerated().map { i, cell in
            "\(label) cell \(i): \(cell.frame) \(cell.label.prefix(24))"
        }
        note(lines.joined(separator: "\n"))
    }

    private func frames(_ app: XCUIApplication, _ labels: [String], _ label: String) {
        for name in labels {
            let matches = app.buttons.matching(identifier: name).allElementsBoundByIndex
                + app.buttons.matching(NSPredicate(format: "label == %@", name)).allElementsBoundByIndex
            let seen = Set(matches.map { "\($0.frame)" })
            note("\(label) \(name): \(seen.isEmpty ? "none" : seen.sorted().joined(separator: " "))")
        }
    }

    private func note(_ line: String) {
        notes.append(line)
    }

    private func shot(_ name: String) {
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
