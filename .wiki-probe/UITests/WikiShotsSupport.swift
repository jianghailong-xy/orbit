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

    /// Something on screen whose label is, begins with, or contains `text`.
    func element(_ app: XCUIApplication, _ text: String, begins: Bool = false, contains: Bool = false) -> XCUIElement {
        let format = contains ? "label CONTAINS %@" : begins ? "label BEGINSWITH %@" : "label == %@"
        return app.descendants(matching: .any).matching(NSPredicate(format: format, text)).firstMatch
    }

    @discardableResult
    func waitLabel(_ app: XCUIApplication, _ text: String, timeout: TimeInterval = 20,
                   begins: Bool = false, contains: Bool = false) -> Bool {
        let found = element(app, text, begins: begins, contains: contains)
        let ok = found.waitForExistence(timeout: timeout)
        note("\(ok ? "found" : "MISSING") \(text.debugDescription): \(describe(found))")
        return ok
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
