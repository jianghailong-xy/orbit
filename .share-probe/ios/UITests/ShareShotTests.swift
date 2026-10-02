import XCTest

// TEMPORARY evidence probe (see ../../README.md): photograph the session list's Share — swiped left
// and in the long-press menu, on Open, Completed and Trash — and the panel it opens. Soft failures:
// whatever cannot be found is noted next to the pictures and the run moves on, so one pass collects
// everything it can.
final class ShareShotTests: XCTestCase {
    /// Has a public link open (stub.py), so its panel shows the link, its layers and its expiry.
    private let linked = "审查导入逻辑避免侵入用户身份"
    /// Has none yet, so its panel opens on Only you.
    private let unlinked = "滑动按钮圆形设计"
    private let completed = "修复登录后的跳转"
    private let trashed = "临时调试：通知不弹出"
    private var notes: [String] = []

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        let file = name.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        write(notes.joined(separator: "\n"), "\(file)-notes.txt")
    }

    /// Open: the swipe shows Share inside Delete, and Share opens the session page's panel.
    func test1OpenSwipe() {
        let app = launch(dark: true)
        shot("open-1-rest")
        row(app, linked).swipeLeft(); settle()
        shot("open-2-swipe-left")
        frames(app, ["Share", "Delete"], "open-left")
        XCTAssertTrue(app.buttons["Share"].exists, "Open: Share is in the left swipe")
        XCTAssertTrue(app.buttons["Delete"].exists, "Open: Delete is still there")
        tap(app, "Share")
        panel(app, "open-3-share-panel", expectLink: true)
        tap(app, "Done")
        settle()
        shot("open-4-after-done")
        app.terminate()
    }

    /// Open: the long-press menu has Share…, and it opens the same panel.
    func test2OpenMenu() {
        let app = launch(dark: true)
        row(app, unlinked).press(forDuration: 1.2); settle()
        shot("open-5-long-press-menu")
        tree(app, "open-menu")
        XCTAssertTrue(app.buttons["Share…"].exists, "Open: the menu has Share…")
        tap(app, "Share…")
        panel(app, "open-6-share-panel-from-menu", expectLink: false)
        tap(app, "Done")
        app.terminate()
    }

    /// Completed: the same Share; Trash: none, in the swipe or the menu.
    func test3CompletedAndTrash() {
        let app = launch(dark: true)
        scope(app, "Completed")
        row(app, completed).swipeLeft(); settle()
        shot("completed-1-swipe-left")
        frames(app, ["Share", "Delete"], "completed-left")
        XCTAssertTrue(app.buttons["Share"].exists, "Completed: Share is in the left swipe")
        tap(app, "Share")
        panel(app, "completed-2-share-panel", expectLink: false)
        tap(app, "Done")

        scope(app, "Trash")
        row(app, trashed).swipeLeft(); settle()
        shot("trash-1-swipe-left")
        frames(app, ["Share", "Delete Permanently"], "trash-left")
        XCTAssertFalse(app.buttons["Share"].exists, "Trash: no Share in the left swipe")
        XCTAssertTrue(app.buttons["Delete Permanently"].exists, "Trash: Delete Permanently alone")
        row(app, "实验：换一种列表分组").tap(); settle()
        row(app, trashed).press(forDuration: 1.2); settle()
        shot("trash-2-long-press-menu")
        tree(app, "trash-menu")
        XCTAssertFalse(app.buttons["Share…"].exists, "Trash: no Share… in the menu")
        app.terminate()
    }

    /// The swipe and its panel once more, in light.
    func test4Light() {
        let app = launch(dark: false)
        row(app, linked).swipeLeft(); settle()
        shot("light-1-swipe-left")
        tap(app, "Share")
        panel(app, "light-2-share-panel", expectLink: true)
        app.terminate()
    }

    // MARK: helpers

    private func launch(dark: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765"] + (dark ? ["-dark"] : [])
        app.launch()
        if !row(app, linked, quiet: true).waitForExistence(timeout: 60) {
            note("the list never appeared")
            write(app.debugDescription, "missing-list.txt")
        }
        settle(1)
        return app
    }

    /// The panel the tap opened: its title, then — once its read has answered — what it shows.
    private func panel(_ app: XCUIApplication, _ name: String, expectLink: Bool) {
        let title = app.navigationBars["Share session"]
        if !title.waitForExistence(timeout: 10) {
            note("\(name): no Share session panel")
            write(app.debugDescription, "missing-\(name).txt")
        }
        XCTAssertTrue(title.exists, "\(name): the session page's panel")
        // The link's own address once a link is open; Access's footer while none is.
        let loaded = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", expectLink ? "/s/" : "Only you can open it")).firstMatch
        if !loaded.waitForExistence(timeout: 10) { note("\(name): the panel didn't finish loading") }
        settle(1)
        shot(name)
        tree(app, name)
    }

    /// Switch the list's tab from the compact list's options menu.
    private func scope(_ app: XCUIApplication, _ title: String) {
        let menu = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Session scope")).firstMatch
        guard menu.waitForExistence(timeout: 5) else {
            note("no scope menu")
            write(app.debugDescription, "missing-scope.txt")
            return
        }
        menu.tap(); settle()
        tap(app, title)
        settle(2)
    }

    /// The row whose session has this title: its cell, or the row's button where cells aren't exposed.
    private func row(_ app: XCUIApplication, _ title: String, quiet: Bool = false) -> XCUIElement {
        let cell = app.cells.containing(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        if cell.exists || quiet { return cell }
        note("no cell for \(title); using its button")
        return app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    }

    private func tap(_ app: XCUIApplication, _ label: String) {
        let button = app.buttons[label]
        guard button.waitForExistence(timeout: 5) else {
            note("no \(label) button to tap")
            write(app.debugDescription, "missing-\(label).txt")
            return
        }
        button.tap()
        settle()
    }

    private func settle(_ seconds: TimeInterval = 0.8) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func frames(_ app: XCUIApplication, _ labels: [String], _ label: String) {
        for name in labels {
            let matches = app.buttons.matching(NSPredicate(format: "label == %@", name)).allElementsBoundByIndex
            let seen = Set(matches.map { "\($0.frame)" })
            note("\(label) \(name): \(seen.isEmpty ? "none" : seen.sorted().joined(separator: " "))")
        }
    }

    private func tree(_ app: XCUIApplication, _ name: String) {
        write(app.debugDescription, "tree-\(name).txt")
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
