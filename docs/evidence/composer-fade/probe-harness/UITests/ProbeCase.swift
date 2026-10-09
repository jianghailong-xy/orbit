import XCTest
#if os(macOS)
import AppKit
#endif

// TEMPORARY evidence probe (see ../README.md), copied from the DeepSeek Harness P5 probe. Helpers for photographing one surface per launch
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

    /// Launch straight into one place (`surface` compose|console, `agent`, `session`), and wait for
    /// `until` — words in a label that only shows once the place has its data. `reset` puts the stub
    /// back first; a chain step leaves it where the last press put it.
    func launch(_ surface: String, agent: String = "a1", session: String = "S1", dark: Bool = false,
                reset: Bool = true, fresh: Bool? = nil, until label: String, _ name: String) -> XCUIApplication {
        if reset { resetStub() }
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.surface", surface,
                               "-probe.agent", agent, "-probe.session", session,
                               "-ApplePersistenceIgnoreState", "YES"] + (dark ? ["-dark"] : [])
            + ((fresh ?? reset) ? ["-probe.fresh"] : [])
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        // The first round's Mac launches came up with a menu bar and no window: ask for one.
        if !app.windows.firstMatch.waitForExistence(timeout: 20) {
            note("\(name): no window after launch; File > New Window")
            app.typeKey("n", modifierFlags: .command)
        }
        #endif
        if !appears(app, label, timeout: 45) {
            note("\(name): \(label) never showed")
            write(app.debugDescription, "missing-\(name).txt")
            // A state the stub never drove is not evidence of anything: fail, keep the picture.
            XCTFail("\(name): \(label) never showed — the app did not render the stub's state")
        }
        settle(2.5)
        return app
    }

    /// A system dialog left over on the runner (macOS's local-network prompt) sits over the app and
    /// takes its clicks: answer it before photographing anything.
    func dismissSystemPrompts() {
        #if os(macOS)
        // Only ask an agent that is running: XCUIApplication throws for a bundle that isn't there.
        let running = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
        for bundle in ["com.apple.UserNotificationCenter", "com.apple.CoreServicesUIAgent"] where running.contains(bundle) {
            let agent = XCUIApplication(bundleIdentifier: bundle)
            for title in ["Allow", "Don't Allow", "OK"] {
                let button = agent.buttons[title]
                if button.exists { note("dismissed a system prompt via \(title) (\(bundle))"); button.click(); return }
            }
        }
        #endif
    }

    /// Change the stub's state directly (`{"stage": "allowed"}`, `{"keys": "none"}`).
    func setStub(_ json: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__set")!)
        request.httpMethod = "POST"
        request.httpBody = json.data(using: .utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
    }

    /// Put the fixture API back as it starts; asked up to three times, a miss is a note.
    func resetStub() {
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

    /// Whether these words show within `timeout`. A label anywhere; on macOS also the value of a text
    /// (a transcript row's words are its value there). Polled, because an `.any` query on value is
    /// too slow for the Mac's whole tree.
    func appears(_ app: XCUIApplication, _ words: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        let byValue = NSPredicate(format: "value CONTAINS %@", words)
        repeat {
            if containing(app, words).exists { return true }
            #if os(macOS)
            if app.staticTexts.matching(byValue).firstMatch.exists || app.textViews.matching(byValue).firstMatch.exists {
                return true
            }
            #endif
            Thread.sleep(forTimeInterval: 1)
        } while Date() < deadline
        return false
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
            #if os(iOS)
            let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: below ? 0.62 : 0.3))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: below ? -140 : 140)),
                        withVelocity: .slow, thenHoldForDuration: 0.6)
            #else
            let pane = window.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5))
            pane.hover()
            window.scroll(byDeltaX: 0, deltaY: below ? -120 : 120)
            #endif
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
        mark(name)
        settle(0.6)
        #if os(macOS)
        let window = XCUIApplication().windows.firstMatch
        save(window.exists ? window.screenshot().pngRepresentation : XCUIScreen.main.screenshot().pngRepresentation, name)
        #else
        save(XCUIScreen.main.screenshot().pngRepresentation, name)
        #endif
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

    /// Tell the stub which picture comes next, so metrics.log reads against the pictures.
    func mark(_ name: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__mark")!)
        request.httpMethod = "POST"
        request.httpBody = name.data(using: .utf8)
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 5)
    }

    func write(_ text: String, _ file: String) {
        // Also as an attachment: the Mac runner cannot write outside its container.
        let attachment = XCTAttachment(string: text)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? text.write(to: URL(fileURLWithPath: dir).appendingPathComponent(file), atomically: true, encoding: .utf8)
    }

    /// Fail unless the stub logged a request containing these words.
    func expectRequest(_ words: String, _ name: String) {
        if !requestsLog().contains(words) { XCTFail("\(name): the app never sent \(words)") }
    }

    /// What the stub logged so far, for the notes beside a shot that should have written something.
    func requestsLog() -> String {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return "" }
        return (try? String(contentsOfFile: dir + "/requests.log", encoding: .utf8)) ?? ""
    }
}
