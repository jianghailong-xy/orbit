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
class ProbeCase: XCTestCase {
    /// In no folder at first: the session every panel test files.
    let moving = "审查导入逻辑避免侵入用户身份"
    let first = "iOS 会话列表左滑按钮"
    let completed = "修复登录后的跳转"
    let trashed = "临时调试：通知不弹出"
    var notes: [String] = []

    typealias Gesture = (name: String, perform: (XCUIElement) -> Void)

    let gestures: [Gesture] = [
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

    // MARK: helpers

    func openPanel(_ app: XCUIApplication, _ name: String) {
        openTrailing(app, moving, showing: "Move", name)
        tap(app, "Move")
    }

    /// Slide the row open on its trailing side with the first gesture that opens it — the row is open
    /// once `label`, one of that side's buttons, exists.
    func openTrailing(_ app: XCUIApplication, _ title: String, showing label: String, _ name: String) {
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
    func order(_ app: XCUIApplication, _ labels: [String], _ name: String) {
        frames(app, labels, "\(name)-left")
        let xs = labels.map { app.buttons.matching(NSPredicate(format: "label == %@", $0)).firstMatch.frame.midX }
        note("\(name) left to right: \(zip(labels, xs).map { "\($0.0)@\(Int($0.1))" }.joined(separator: " "))")
        XCTAssertEqual(xs, xs.sorted(), "\(name): \(labels.joined(separator: " · ")) from left to right")
    }

    func launch(dark: Bool) -> XCUIApplication {
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
    func resetStub() {
        for attempt in 1...3 {
            // The test's name rides along, so the stub's request log reads test by test.
            let test = name.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
            var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__reset?for=\(test)")!)
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

    final class StatusBox: @unchecked Sendable {
        var code: Int?
        var body: Data?
    }

    /// What the fixture API holds right now — every session per tab with its folder, and every
    /// folder (`GET /__state`) — written next to the pictures, so a step's effect on the data can be
    /// read off the files taken before and after it.
    func saveState(_ file: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__state")!)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        let box = StatusBox()
        URLSession.shared.dataTask(with: request) { data, response, _ in
            box.code = (response as? HTTPURLResponse)?.statusCode
            box.body = data
            answered.signal()
        }.resume()
        _ = answered.wait(timeout: .now() + 15)
        guard box.code == 200, let data = box.body,
              let json = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: pretty, encoding: .utf8) else {
            note("state \(file): \(box.code.map(String.init) ?? "no answer")")
            return
        }
        write(text, file)
    }

    /// The Move panel the tap opened: its title, once its folders are in.
    func panel(_ app: XCUIApplication, _ name: String) {
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
    ///
    /// A folder's row at the top of the list behind the panel starts with the same words — and now
    /// that the list draws folders, it is in the tree too — so the *hittable* match wins: the
    /// panel's row is the one on top.
    func option(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        let query = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name))
        guard query.firstMatch.exists else { return query.firstMatch }
        let matches = query.allElementsBoundByIndex
        if let hittable = matches.first(where: { $0.isHittable }) { return hittable }
        note("no hittable row for \(name); using the first match")
        return matches.first ?? query.firstMatch
    }

    /// Open a folder's page by tapping its row at the top of the list, and wait for it — the page's
    /// ⋯ is the tell, so both shells' shapes look the same from here.
    func openFolderPage(_ app: XCUIApplication, _ name: String) {
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        if !row.waitForExistence(timeout: 30) {
            note("no folder row for \(name)")
            write(app.debugDescription, "missing-folder-\(name).txt")
        }
        // The rows appear once the folder library has landed, which can trail the list itself on a
        // loaded runner — so a page that does not come up within the first wait is tapped again.
        for attempt in 1...2 {
            row.tap()
            settle(2)
            if app.buttons["Folder actions"].waitForExistence(timeout: 12) { return }
            note("\(name): no folder page after tap \(attempt)")
        }
        write(app.debugDescription, "missing-page-\(name).txt")
    }

    /// Back out of whatever page is on top, by its navigation bar's first button.
    func goBack(_ app: XCUIApplication) {
        let button = app.navigationBars.buttons.firstMatch
        if button.waitForExistence(timeout: 10) {
            button.tap()
        } else {
            note("no back button")
            write(app.debugDescription, "missing-back.txt")
        }
        settle()
    }

    /// Tap a session row by its title: its cell, or its own button — checked first, so a row that
    /// is not there yet is a note rather than an exception that ends the test.
    func tapRow(_ app: XCUIApplication, _ title: String) {
        let cell = row(app, title)
        if cell.exists { cell.tap(); return }
        let button = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        if button.exists { button.tap(); return }
        note("no row for \(title) to tap")
        write(app.debugDescription, "missing-row-\(title).txt")
    }

    func ticked(_ app: XCUIApplication, _ name: String, _ when: String) {
        let ticks = app.buttons.allElementsBoundByIndex.filter { $0.isSelected }.map(\.label)
        note("ticked \(when): \(ticks)")
        XCTAssertTrue(option(app, name).isSelected, "\(name) is ticked \(when)")
    }

    /// The toast the move left: wait for it, photograph it at once, before its few seconds are up.
    func toast(_ app: XCUIApplication, _ text: String, _ name: String) {
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

    func enter(_ app: XCUIApplication, _ text: String) {
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

    func alertButton(_ app: XCUIApplication, _ label: String) {
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
    func scope(_ app: XCUIApplication, _ title: String) {
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
    func row(_ app: XCUIApplication, _ title: String, quiet: Bool = false) -> XCUIElement {
        let cell = app.cells.containing(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        if cell.exists || quiet { return cell }
        note("no cell for \(title); using its button")
        return app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    }

    func tap(_ app: XCUIApplication, _ label: String) {
        let button = app.buttons[label]
        guard button.waitForExistence(timeout: 5) else {
            note("no \(label) button to tap")
            write(app.debugDescription, "missing-\(label).txt")
            return
        }
        button.tap()
        settle()
    }

    func settle(_ seconds: TimeInterval = 0.8) {
        Thread.sleep(forTimeInterval: seconds)
    }

    func frames(_ app: XCUIApplication, _ labels: [String], _ label: String) {
        for name in labels {
            let matches = app.buttons.matching(NSPredicate(format: "label == %@", name)).allElementsBoundByIndex
            let seen = Set(matches.map { "\($0.frame)" })
            note("\(label) \(name): \(seen.isEmpty ? "none" : seen.sorted().joined(separator: " "))")
        }
    }

    func tree(_ app: XCUIApplication, _ name: String) {
        write(app.debugDescription, "tree-\(name).txt")
    }

    func note(_ line: String) {
        notes.append(line)
    }

    func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    func write(_ text: String, _ file: String) {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? text.write(to: URL(fileURLWithPath: dir).appendingPathComponent(file), atomically: true, encoding: .utf8)
    }
}
