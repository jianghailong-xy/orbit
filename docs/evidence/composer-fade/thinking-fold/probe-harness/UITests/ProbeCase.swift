import XCTest
#if os(macOS)
import AppKit
#endif

// TEMPORARY evidence probe (see ../README.md), adapted from the tail-open probe
// (docs/evidence/composer-fade/tail-open/probe-harness). Helpers for driving one scripted live
// turn against `stub.py` and photographing it. Soft failures: whatever cannot be found is noted
// beside the pictures, and the run moves on, so one pass collects everything it can. Each launch
// resets the fixture API first, so one test's steps don't leak into the next.
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

    /// Launch straight into one place (`surface` compose|console, `agent`, `session`), and wait
    /// for `until` — words in a label that only show once the place has its data. `reset` puts the
    /// stub back first; a chain step leaves it where the last press put it.
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

    /// Put the fixture API back as it starts; a miss is a note.
    func resetStub() {
        if post("/__reset", "") == nil { note("reset: no answer") }
    }

    /// Advance the scripted live turn by one named step (see stub.py's STEPS).
    @discardableResult
    func step(_ name: String) -> Bool {
        guard let body = post("/__step", name) else {
            note("step \(name): the stub never answered")
            return false
        }
        note("step \(name): \(body)")
        return true
    }

    /// One POST to the stub, answering its body within `timeout` seconds, else nil.
    @discardableResult
    func post(_ path: String, _ body: String, timeout: TimeInterval = 30) -> String? {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765" + path)!)
        request.httpMethod = "POST"
        request.httpBody = body.data(using: .utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = timeout
        let answered = DispatchSemaphore(value: 0)
        let box = StatusBox()
        URLSession.shared.dataTask(with: request) { data, _, _ in
            box.text = data.flatMap { String(data: $0, encoding: .utf8) }
            answered.signal()
        }.resume()
        guard answered.wait(timeout: .now() + timeout + 5) != .timedOut else { return nil }
        return box.text
    }

    final class StatusBox: @unchecked Sendable {
        var text: String?
    }

    // MARK: finding and moving

    /// Anything whose label contains these words.
    func containing(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    /// Whether these words show within `timeout`. A label anywhere; on macOS also the value of a
    /// text (a transcript row's words are its value there). Polled, because an `.any` query on
    /// value is too slow for the Mac's whole tree.
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

    /// How many rows say "Thought for …" right now — the number of folds the transcript shows.
    func foldCount(_ app: XCUIApplication) -> Int {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Thought for"))
            .allElementsBoundByIndex.filter { $0.exists }.count
    }

    /// Poll until the transcript shows `count` folded thinking rows, so the test never runs ahead
    /// of the fold it just asked the stub for. False on timeout — the caller notes and moves on.
    func waitFoldCount(_ app: XCUIApplication, _ count: Int, timeout: TimeInterval = 8) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if foldCount(app) >= count { return true }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline
        return false
    }

    /// Whether the app opened its live event stream yet — the stub's request log carries the
    /// `events?sinceSeq=` GET. The steps must not start before this: deltas sent with nobody
    /// listening are lost (the durable events still heal the view, but the streamed box would
    /// never have been full).
    func streamConnected(_ name: String, timeout: TimeInterval = 30) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if requestsLog().contains("events?sinceSeq=") {
                note("\(name): stream connected")
                return true
            }
            Thread.sleep(forTimeInterval: 1)
        } while Date() < deadline
        note("\(name): the event stream never connected")
        write(requestsLog(), "requests-\(name).txt")
        return false
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

    /// A settled picture: mark it, let the UI rest, then photograph.
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

    /// An immediate picture: marked now, photographed now — the closest the runner gets to the
    /// frame after a fold. Pairs with the marked geometry in metrics.log.
    func snap(_ name: String) {
        mark(name)
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

    /// Tell the stub which picture comes next, stamped with the same clock the app's own
    /// instrumentation uses (systemUptime), so a mark sorts between two scroll readings.
    func mark(_ name: String) {
        let stamped = String(format: "%@ t=%.3f", name, ProcessInfo.processInfo.systemUptime)
        post("/__mark", stamped, timeout: 5)
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

    /// What the stub logged so far, for the notes beside a shot that should have written something.
    func requestsLog() -> String {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return "" }
        return (try? String(contentsOfFile: dir + "/requests.log", encoding: .utf8)) ?? ""
    }
}
