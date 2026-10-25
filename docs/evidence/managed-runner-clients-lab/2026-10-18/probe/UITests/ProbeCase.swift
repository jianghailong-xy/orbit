import XCTest
#if os(macOS)
import AppKit
#endif

// TEMPORARY evidence probe (see ../README.md), from the C7 managed-runner probe. A scene is the Orbit test
// server's recorded answers (replay.py serves one at a time, on its own clock); each test loads one, launches
// the real app where the scene says, and plays the scene's steps: wait for words, take a picture, type and
// send, press a button. The replay fails the test on any request it does not hold, or a write whose key
// fields differ from the recorded one, and the test fails if the app never sends a recorded action.
class ProbeCase: XCTestCase {
    var notes: [String] = []
    static let replay = "http://127.0.0.1:8765"

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        let file = name.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        write(notes.joined(separator: "\n"), "\(file)-notes.txt")
    }

    // MARK: the replay

    final class Box: @unchecked Sendable {
        var data: Data?
        var code: Int?
    }

    func call(_ method: String, _ path: String, body: Data? = nil, timeout: TimeInterval = 20) -> (Int?, Data?) {
        var request = URLRequest(url: URL(string: Self.replay + path)!)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let answered = DispatchSemaphore(value: 0)
        let box = Box()
        URLSession.shared.dataTask(with: request) { data, response, _ in
            box.data = data
            box.code = (response as? HTTPURLResponse)?.statusCode
            answered.signal()
        }.resume()
        _ = answered.wait(timeout: .now() + timeout + 5)
        return (box.code, box.data)
    }

    /// Load a scene: the replay starts its clock now. Answers the scene's meta (surface, ids, steps).
    func loadScene(_ name: String) -> [String: Any] {
        let (code, data) = call("POST", "/__scene", body: try? JSONSerialization.data(withJSONObject: ["name": name]))
        guard code == 200, let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("scene \(name) did not load (\(code.map(String.init) ?? "no answer"))")
            return [:]
        }
        note("scene \(name): \(object["duration"] ?? "?") s, actions \(object["actions"] ?? [])")
        return object["meta"] as? [String: Any] ?? [:]
    }

    /// The replay's verdict: every request was one the scene holds, every write matched, every action was sent.
    func expectNoViolations(_ scene: String) {
        let (_, data) = call("GET", "/__violations")
        guard let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("\(scene): no verdict from the replay")
            return
        }
        let violations = object["violations"] as? [[String: Any]] ?? []
        let left = object["actionsLeft"] as? [String] ?? []
        note("\(scene): \(object["requests"] ?? 0) requests, \(violations.count) violations, actions left \(left), notes \(object["notes"] ?? [])")
        write(String(data: data, encoding: .utf8) ?? "", "verdict-\(scene).json")
        XCTAssertTrue(violations.isEmpty, "\(scene): the app sent what the scene does not hold: \(violations)")
        XCTAssertTrue(left.isEmpty, "\(scene): the app never sent the recorded action(s) \(left)")
    }

    func mark(_ name: String) {
        _ = call("POST", "/__mark", body: name.data(using: .utf8), timeout: 5)
    }

    // MARK: launch

    func launch(surface: String, agent: String?, session: String?, _ name: String) -> XCUIApplication {
        let app = XCUIApplication()
        var arguments = ["-orbit.instance", Self.replay, "-probe.surface", surface, "-probe.fresh",
                         "-ApplePersistenceIgnoreState", "YES"]
        if let agent { arguments += ["-probe.agent", agent] }
        if let session { arguments += ["-probe.session", session] }
        app.launchArguments = arguments
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        if !app.windows.firstMatch.waitForExistence(timeout: 20) {
            note("\(name): no window after launch; File > New Window")
            app.typeKey("n", modifierFlags: .command)
        }
        #endif
        return app
    }

    /// A system dialog left over on the runner sits over the app and takes its clicks.
    func dismissSystemPrompts() {
        #if os(macOS)
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

    // MARK: finding

    func containing(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    /// Whether these words show: a label anywhere; on macOS also a text's value (a transcript row's words).
    func shows(_ app: XCUIApplication, _ words: String) -> Bool {
        if containing(app, words).exists { return true }
        #if os(macOS)
        let byValue = NSPredicate(format: "value CONTAINS %@", words)
        if app.staticTexts.matching(byValue).firstMatch.exists || app.textViews.matching(byValue).firstMatch.exists { return true }
        #endif
        return false
    }

    func appears(_ app: XCUIApplication, _ words: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if shows(app, words) { return true }
            Thread.sleep(forTimeInterval: 1)
        } while Date() < deadline
        return false
    }

    func disappears(_ app: XCUIApplication, _ words: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if !shows(app, words) { return true }
            Thread.sleep(forTimeInterval: 1)
        } while Date() < deadline
        return false
    }

    func button(_ app: XCUIApplication, beginning words: String) -> XCUIElement {
        let query = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", words))
        if let hit = query.allElementsBoundByIndex.first(where: { $0.exists && $0.isHittable }) { return hit }
        return query.firstMatch
    }

    func composer(_ app: XCUIApplication) -> XCUIElement {
        let view = app.textViews.firstMatch
        return view.exists ? view : app.textFields.firstMatch
    }

    func sendButton(_ app: XCUIApplication) -> XCUIElement {
        for words in ["Send", "send", "Up Arrow", "arrow.up.circle.fill", "arrow up circle"] {
            let hit = app.buttons.matching(NSPredicate(format: "label ==[c] %@ OR identifier ==[c] %@", words, words)).firstMatch
            if hit.exists { return hit }
        }
        return app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'send' AND NOT (label CONTAINS[c] 'stop')")).firstMatch
    }

    func press(_ element: XCUIElement) {
        #if os(iOS)
        element.tap()
        #else
        element.click()
        #endif
    }

    func describe(_ element: XCUIElement) -> String {
        guard element.exists else { return "(missing)" }
        let value = element.value.map { "\($0)" } ?? ""
        return "\(element.elementType.rawValue) label=\"\(element.label)\" value=\"\(value)\" frame=\(element.frame) hittable=\(element.isHittable)"
    }

    // MARK: recording

    func settle(_ seconds: TimeInterval = 0.8) {
        Thread.sleep(forTimeInterval: seconds)
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

    private func save(_ png: Data, _ name: String) {
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    func write(_ text: String, _ file: String) {
        let attachment = XCTAttachment(string: text)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? text.write(to: URL(fileURLWithPath: dir).appendingPathComponent(file), atomically: true, encoding: .utf8)
    }
}
