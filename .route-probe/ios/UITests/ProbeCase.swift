import XCTest

// TEMPORARY evidence probe (see ../../README.md). Helpers for photographing one surface per launch
// against `stub.py`. Soft failures: whatever cannot be found is noted beside the pictures with the
// element tree, and the run moves on, so one pass collects everything it can. Each launch resets the
// fixture API first, so one test's PATCH doesn't leak into the next.
class ProbeCase: XCTestCase {
    var notes: [String] = []

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        let file = name.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        write(notes.joined(separator: "\n"), "\(file)-notes.txt")
    }

    // MARK: launch

    /// Reset the stub, launch straight into one surface (`task`, `agent`, `console`), and wait for
    /// `until` — words in a label that only shows once the surface has its data.
    func launch(_ surface: String, dark: Bool = false, modelRouting: Bool = true, until label: String,
                _ name: String) -> XCUIApplication {
        resetStub(modelRouting: modelRouting)
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.surface", surface]
            + (dark ? ["-dark"] : [])
        app.launch()
        if !containing(app, label).waitForExistence(timeout: 60) {
            note("\(name): \(label) never showed")
            write(app.debugDescription, "missing-\(name).txt")
        }
        settle(2.5)
        return app
    }

    /// Put the fixture API back as it starts; asked up to three times, a miss is a note.
    func resetStub(modelRouting: Bool = true) {
        for attempt in 1...3 {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__reset?modelRouting=\(modelRouting)")!)
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
    }

    // MARK: finding and moving

    /// Anything whose label begins with these words.
    func text(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
    }

    /// Anything whose label contains these words.
    func containing(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    /// The first hittable button whose label begins with these words, else the first match.
    func button(_ app: XCUIApplication, beginning words: String) -> XCUIElement {
        let query = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", words))
        if let hit = query.allElementsBoundByIndex.first(where: { $0.exists && $0.isHittable }) { return hit }
        return query.firstMatch
    }

    /// Drag the page until `element` sits inside the band between `top` and `bottom` (points from the
    /// window's top), holding at the end of each drag so it carries no momentum. The drag starts in
    /// the screen's margin, so it never presses a row.
    func bring(_ app: XCUIApplication, _ element: XCUIElement, between top: CGFloat, and bottom: CGFloat,
               missingIsAbove: Bool, _ name: String) {
        let window = app.windows.firstMatch
        for attempt in 1...14 {
            if element.exists, element.frame.minY >= top, element.frame.maxY <= bottom {
                note("\(name): in view after \(attempt - 1) drag(s) at \(element.frame)")
                return
            }
            let below = element.exists ? element.frame.maxY > bottom : !missingIsAbove
            let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: below ? 0.62 : 0.3))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: below ? -140 : 140)),
                        withVelocity: .slow, thenHoldForDuration: 0.6)
            settle(1)
        }
        note("\(name): never in the band \(top)–\(bottom); last frame \(element.frame)")
        write(app.debugDescription, "missing-band-\(name).txt")
    }

    /// One line per element: its type, label, value and frame — what a picker row or a menu item
    /// actually exposes, for the notes.
    func describe(_ element: XCUIElement) -> String {
        guard element.exists else { return "(missing)" }
        let value = element.value.map { "\($0)" } ?? ""
        return "\(element.elementType.rawValue) label=\"\(element.label)\" value=\"\(value)\" "
            + "frame=\(element.frame) hittable=\(element.isHittable)"
    }

    // MARK: recording

    func settle(_ seconds: TimeInterval = 0.8) {
        Thread.sleep(forTimeInterval: seconds)
    }

    func tree(_ app: XCUIApplication, _ name: String) {
        write(app.debugDescription, "tree-\(name).txt")
    }

    func note(_ line: String) {
        notes.append(line)
    }

    func shot(_ name: String) {
        save(XCUIScreen.main.screenshot().pngRepresentation, name)
    }

    /// A picture of one element alone, at the screen's scale — a close look at a row or a chip.
    func shot(_ element: XCUIElement, _ name: String) {
        guard element.exists else { note("\(name): nothing to photograph"); return }
        save(element.screenshot().pngRepresentation, name)
    }

    private func save(_ png: Data, _ name: String) {
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

    /// What the stub logged so far, for the notes beside a shot that should have written something.
    func requestsLog() -> String {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return "" }
        return (try? String(contentsOfFile: dir + "/requests.log", encoding: .utf8)) ?? ""
    }
}
