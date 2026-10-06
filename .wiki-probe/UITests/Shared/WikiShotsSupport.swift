import XCTest

// TEMPORARY evidence probe (never merged): what the two shot suites share — the way in, the reads off the screen,
// and the shots, written to SHOTS_DIR and attached to the result bundle.
class WikiShotsCase: XCTestCase {
    var notes: [String] = []

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        let file = name.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        write(notes.joined(separator: "\n"), "\(file)-notes.txt")
    }

    func launch(port: Int, _ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:\(port)", "-ApplePersistenceIgnoreState", "YES"] + extra
        app.launch()
        return app
    }

    /// Something on screen whose label is, begins with, or contains `text`. On a Mac, a text's words are its
    /// value, and a sweep of every element of the window times out: the static texts and buttons are asked.
    func element(_ app: XCUIApplication, _ text: String, begins: Bool = false, contains: Bool = false) -> XCUIElement {
        let op = contains ? "CONTAINS" : begins ? "BEGINSWITH" : "=="
        #if os(macOS)
        let texts = app.staticTexts.matching(NSPredicate(format: "value \(op) %@", text)).firstMatch
        if texts.exists { return texts }
        return app.buttons.matching(NSPredicate(format: "label \(op) %@ OR title \(op) %@", text, text)).firstMatch
        #else
        return app.descendants(matching: .any).matching(NSPredicate(format: "label \(op) %@", text)).firstMatch
        #endif
    }

    /// Wait for `text` the way `waitLabel` does, on a Mac by polling the typed queries above.
    func appears(_ app: XCUIApplication, _ text: String, timeout: TimeInterval, contains: Bool) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let found = element(app, text, contains: contains)
            if found.exists { return found }
            Thread.sleep(forTimeInterval: 1)
        } while Date() < deadline
        return nil
    }

    /// Press `element` once it can be pressed: a drawer still sliding in leaves its rows unhittable for a moment.
    func press(_ element: XCUIElement, timeout: TimeInterval = 10) {
        let deadline = Date().addingTimeInterval(timeout)
        while !element.isHittable && Date() < deadline { Thread.sleep(forTimeInterval: 0.5) }
        if element.isHittable {
            #if os(macOS)
            element.click()
            #else
            element.tap()
            #endif
        } else {
            note("pressed by its middle, not hittable: \(describe(element))")
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
    }

    @discardableResult
    func waitLabel(_ app: XCUIApplication, _ text: String, timeout: TimeInterval = 20,
                   begins: Bool = false, contains: Bool = false) -> Bool {
        #if os(macOS)
        let found = appears(app, text, timeout: timeout, contains: contains || begins)
        note("\(found != nil ? "found" : "MISSING") \(text.debugDescription): \(found.map(describe) ?? "(missing)")")
        return found != nil
        #else
        let found = element(app, text, begins: begins, contains: contains)
        let ok = found.waitForExistence(timeout: timeout)
        note("\(ok ? "found" : "MISSING") \(text.debugDescription): \(describe(found))")
        return ok
        #endif
    }

    /// Whether nothing on screen says `text` — checked at once, after the page has settled.
    func absent(_ app: XCUIApplication, _ text: String, contains: Bool = false) -> Bool {
        let found = element(app, text, contains: contains)
        note("\(found.exists ? "PRESENT" : "absent") \(text.debugDescription): \(describe(found))")
        return !found.exists
    }

    /// The button whose label contains `text`, the leftmost of them (or the rightmost): the directory column's
    /// row rather than the detail pane's.
    func button(_ app: XCUIApplication, containing text: String, leftmost: Bool = true) -> XCUIElement? {
        let all = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", text)).allElementsBoundByIndex
            .filter { $0.exists && $0.frame.width > 0 }
        let sorted = all.sorted { $0.frame.minX < $1.frame.minX }
        return leftmost ? sorted.first : sorted.last
    }

    func describe(_ element: XCUIElement) -> String {
        guard element.exists else { return "(missing)" }
        return "\(element.elementType.rawValue) label=\"\(element.label)\" value=\"\(element.value ?? "")\" "
            + "id=\"\(element.identifier)\" frame=\(element.frame)"
    }

    func settle(_ seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }

    func note(_ line: String) {
        notes.append(line)
    }

    func tree(_ app: XCUIApplication, _ name: String) {
        write(app.debugDescription, "tree-\(name).txt")
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
