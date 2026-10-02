import XCTest

// TEMPORARY evidence probe (see ../../README.md): photograph the session list's left swipe — Share ·
// Move · Delete on Open and Completed, Delete Permanently alone in Trash — the long-press menu's
// Share… and Move…, and the Move panel before and after a move into a folder, out to No Folder, and
// into a New Folder… (and a name the workspace already has). Soft failures: whatever cannot be found
// is noted next to the pictures and the run moves on, so one pass collects everything it can. Each
// test resets the fixture API first, so the moves of one don't leak into the next.
//
// A row is opened by a finger-like drag: the Share probe found XCUITest's `swipeLeft()` leaves the
// real list's rows shut in the upper part of the screen, where a press-and-drag opens them anywhere.
final class MoveShotTests: XCTestCase {
    /// In no folder at first: the session every panel test files.
    private let moving = "审查导入逻辑避免侵入用户身份"
    private let first = "iOS 会话列表左滑按钮"
    private let completed = "修复登录后的跳转"
    private let trashed = "临时调试：通知不弹出"
    private var notes: [String] = []

    private typealias Gesture = (name: String, perform: (XCUIElement) -> Void)

    private let gestures: [Gesture] = [
        ("drag-from-edge", { cell in
            let start = cell.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5))
            start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: -260, dy: 0)),
                        withVelocity: XCUIGestureVelocity(300), thenHoldForDuration: 0.4)
        }),
        ("drag-from-middle", { cell in
            let start = cell.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -240, dy: 0)),
                        withVelocity: .fast, thenHoldForDuration: 0.1)
        }),
        ("swipeLeft", { $0.swipeLeft() }),
    ]

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        let file = name.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        write(notes.joined(separator: "\n"), "\(file)-notes.txt")
    }

    // MARK: the swipe and the menu

    /// Open: left to right, Share · Move · Delete.
    func test1OpenSwipe() {
        let app = launch(dark: true)
        shot("open-0-rest")
        openTrailing(app, moving, showing: "Move", "open")
        shot("open-1-swipe-left")
        order(app, ["Share", "Move", "Delete"], "open")
        app.terminate()
    }

    /// Open: the long-press menu has Share… and Move…, and Move… opens the panel.
    func test2OpenMenu() {
        let app = launch(dark: true)
        row(app, moving).press(forDuration: 1.2); settle()
        shot("open-2-long-press-menu")
        tree(app, "open-menu")
        XCTAssertTrue(app.buttons["Share…"].exists, "Open: the menu has Share…")
        XCTAssertTrue(app.buttons["Move…"].exists, "Open: the menu has Move…")
        frames(app, ["Share…", "Move…", "Delete"], "open-menu")
        tap(app, "Move…")
        panel(app, "open-3-move-panel-from-menu")
        app.terminate()
    }

    /// Completed: the same three; its menu has Share… and Move… too, and its panel counts the
    /// completed sessions.
    func test3Completed() {
        let app = launch(dark: true)
        scope(app, "Completed")
        openTrailing(app, completed, showing: "Move", "completed")
        shot("completed-1-swipe-left")
        order(app, ["Share", "Move", "Delete"], "completed")
        tap(app, "Move")
        panel(app, "completed-2-move-panel")
        tap(app, "Done")
        row(app, completed).press(forDuration: 1.2); settle()
        shot("completed-3-long-press-menu")
        tree(app, "completed-menu")
        XCTAssertTrue(app.buttons["Share…"].exists, "Completed: the menu has Share…")
        XCTAssertTrue(app.buttons["Move…"].exists, "Completed: the menu has Move…")
        app.terminate()
    }

    /// Trash: Delete Permanently alone, and neither Share… nor Move… in its menu.
    func test3Trash() {
        let app = launch(dark: true)
        scope(app, "Trash")
        openTrailing(app, trashed, showing: "Delete Permanently", "trash")
        shot("trash-1-swipe-left")
        frames(app, ["Share", "Move", "Delete Permanently"], "trash-left")
        XCTAssertFalse(app.buttons["Share"].exists, "Trash: no Share in the left swipe")
        XCTAssertFalse(app.buttons["Move"].exists, "Trash: no Move in the left swipe")
        XCTAssertTrue(app.buttons["Delete Permanently"].exists, "Trash: Delete Permanently alone")
        row(app, "实验：换一种列表分组").tap(); settle()
        row(app, trashed).press(forDuration: 1.2); settle()
        shot("trash-2-long-press-menu")
        tree(app, "trash-menu")
        XCTAssertFalse(app.buttons["Share…"].exists, "Trash: no Share… in the menu")
        XCTAssertFalse(app.buttons["Move…"].exists, "Trash: no Move… in the menu")
        app.terminate()
    }

    // MARK: the panel

    /// Into a folder and out again: the tick moves with the session, the count with it, and the
    /// toast names where it went — then the folder it left.
    func test4FolderAndNoFolder() {
        let app = launch(dark: true)
        openPanel(app, "folder")
        panel(app, "folder-1-panel-before")
        ticked(app, "No Folder", "before")
        option(app, "Release").tap()
        toast(app, "Moved to “Release”", "folder-2-toast-moved-to-release")
        openPanel(app, "folder-again")
        panel(app, "folder-3-panel-after")
        ticked(app, "Release", "after the move")

        option(app, "No Folder").tap()
        toast(app, "Moved out of “Release”", "nofolder-1-toast-moved-out")
        openPanel(app, "nofolder-again")
        panel(app, "nofolder-2-panel-after")
        ticked(app, "No Folder", "after moving out")
        app.terminate()
    }

    /// New Folder…: the system prompt names it, the session goes straight in and the toast says so;
    /// the panel then lists it, ticked. A name the workspace already has is refused, readably.
    func test5NewFolder() {
        let app = launch(dark: true)
        openPanel(app, "new")
        panel(app, "new-1-panel-before")
        option(app, "New Folder…").tap(); settle()
        enter(app, "Launch notes")
        shot("new-2-name-prompt")
        alertButton(app, "Create")
        toast(app, "Moved to “Launch notes”", "new-3-toast-moved-to-new-folder")
        openPanel(app, "new-again")
        panel(app, "new-4-panel-after")
        ticked(app, "Launch notes", "after New Folder…")

        option(app, "New Folder…").tap(); settle()
        enter(app, "Release")
        alertButton(app, "Create")
        let refused = app.alerts["Couldn’t Create Folder"]
        if !refused.waitForExistence(timeout: 10) {
            note("new-dup: no refusal alert")
            write(app.debugDescription, "missing-new-dup.txt")
        }
        XCTAssertTrue(refused.exists, "a name the workspace has is refused")
        let reason = refused.staticTexts.matching(NSPredicate(format: "label CONTAINS %@",
                                                              "There’s already a folder named “Release” in orbit")).firstMatch
        XCTAssertTrue(reason.exists, "and the alert says why")
        settle()
        shot("new-5-duplicate-name")
        tree(app, "new-dup")
        app.terminate()
    }

    /// The swipe and the panel once more, in light.
    func test6Light() {
        let app = launch(dark: false)
        openTrailing(app, moving, showing: "Move", "light")
        shot("light-1-swipe-left")
        order(app, ["Share", "Move", "Delete"], "light")
        tap(app, "Move")
        panel(app, "light-2-move-panel")
        app.terminate()
    }

    // MARK: helpers

    private func openPanel(_ app: XCUIApplication, _ name: String) {
        openTrailing(app, moving, showing: "Move", name)
        tap(app, "Move")
    }

    /// Slide the row open on its trailing side with the first gesture that opens it — the row is open
    /// once `label`, one of that side's buttons, exists.
    private func openTrailing(_ app: XCUIApplication, _ title: String, showing label: String, _ name: String) {
        for gesture in gestures {
            gesture.perform(row(app, title))
            settle(1.2)
            if app.buttons[label].exists {
                note("\(name): opened by \(gesture.name)")
                return
            }
            note("\(name): \(gesture.name) left it shut")
        }
        write(app.debugDescription, "missing-open-\(name).txt")
    }

    /// The three buttons stand left to right in this order.
    private func order(_ app: XCUIApplication, _ labels: [String], _ name: String) {
        frames(app, labels, "\(name)-left")
        let xs = labels.map { app.buttons.matching(NSPredicate(format: "label == %@", $0)).firstMatch.frame.midX }
        note("\(name) left to right: \(zip(labels, xs).map { "\($0.0)@\(Int($0.1))" }.joined(separator: " "))")
        XCTAssertEqual(xs, xs.sorted(), "\(name): \(labels.joined(separator: " · ")) from left to right")
    }

    private func launch(dark: Bool) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765"] + (dark ? ["-dark"] : [])
        app.launch()
        if !row(app, moving, quiet: true).waitForExistence(timeout: 60) {
            note("the list never appeared")
            write(app.debugDescription, "missing-list.txt")
        }
        settle(1.5)
        return app
    }

    /// Put the fixture API back as it starts. Round 1's very first reset went unanswered for 15s (the
    /// next six answered at once), so it is asked up to three times and a miss is a note, not a
    /// failure: the stub starts out in exactly that state anyway.
    private func resetStub() {
        for attempt in 1...3 {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__reset")!)
            request.httpMethod = "POST"
            request.timeoutInterval = 10
            let answered = DispatchSemaphore(value: 0)
            let status = StatusBox()
            URLSession.shared.dataTask(with: request) { _, response, _ in
                status.code = (response as? HTTPURLResponse)?.statusCode
                answered.signal()
            }.resume()
            _ = answered.wait(timeout: .now() + 15)
            if status.code == 200 { return }
            note("reset \(attempt): \(status.code.map(String.init) ?? "no answer")")
        }
    }

    private final class StatusBox: @unchecked Sendable {
        var code: Int?
    }

    /// The Move panel the tap opened: its title, once its folders are in.
    private func panel(_ app: XCUIApplication, _ name: String) {
        let title = app.navigationBars["Move"]
        if !title.waitForExistence(timeout: 10) {
            note("\(name): no Move panel")
            write(app.debugDescription, "missing-\(name).txt")
        }
        XCTAssertTrue(title.exists, "\(name): the Move panel")
        if !option(app, "Release").waitForExistence(timeout: 10) { note("\(name): the folders never showed") }
        settle(1)
        shot(name)
        tree(app, name)
        let places = ["No Folder", "Release", "iOS polish", "Launch notes", "New Folder…"]
        let rows = app.buttons.allElementsBoundByIndex
            .filter { button in places.contains { button.label.hasPrefix($0) } }
            .map { "\($0.label)\($0.isSelected ? " [selected]" : "")" }
        note("\(name) rows: \(rows.joined(separator: " | "))")
    }

    /// The panel's row for this place: its button, whose label starts with the name (then the count).
    private func option(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    private func ticked(_ app: XCUIApplication, _ name: String, _ when: String) {
        let ticks = app.buttons.allElementsBoundByIndex.filter { $0.isSelected }.map(\.label)
        note("ticked \(when): \(ticks)")
        XCTAssertTrue(option(app, name).isSelected, "\(name) is ticked \(when)")
    }

    /// The toast the move left: wait for it, photograph it at once, before its few seconds are up.
    private func toast(_ app: XCUIApplication, _ text: String, _ name: String) {
        let card = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        if !card.waitForExistence(timeout: 8) {
            note("\(name): no toast saying \(text)")
            write(app.debugDescription, "missing-\(name).txt")
        }
        XCTAssertTrue(card.exists, "the toast says \(text)")
        settle(0.6)
        shot(name)
        // Let it go before the next swipe, so it can't take the touch meant for a row.
        let gone = NSPredicate(format: "exists == false")
        let wait = XCTNSPredicateExpectation(predicate: gone, object: card)
        _ = XCTWaiter.wait(for: [wait], timeout: 9)
    }

    private func enter(_ app: XCUIApplication, _ text: String) {
        let alert = app.alerts.firstMatch
        if !alert.waitForExistence(timeout: 5) {
            note("no prompt to type \(text) into")
            write(app.debugDescription, "missing-prompt.txt")
            return
        }
        let field = alert.textFields.firstMatch
        field.tap()
        // A fresh simulator covers its first keyboard with the slide-to-type tip; put it away so
        // the picture shows the keyboard.
        let tip = app.buttons["Continue"]
        if tip.waitForExistence(timeout: 2) {
            note("put away the keyboard's slide-to-type tip")
            tip.tap()
            settle(0.5)
        }
        field.typeText(text)
        settle(0.8)
    }

    private func alertButton(_ app: XCUIApplication, _ label: String) {
        let button = app.alerts.firstMatch.buttons[label]
        guard button.waitForExistence(timeout: 5) else {
            note("no \(label) in the alert")
            write(app.debugDescription, "missing-alert-\(label).txt")
            return
        }
        button.tap()
        settle(0.3)
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
