import XCTest
#if os(macOS)
import AppKit
#endif

// TEMPORARY evidence probe (see ../README.md), adapted from the composer-fade probe. Helpers for
// photographing the login page against `stub.py`: every launch seeds what the app remembers
// (ProbeArgs.seed) and puts the stub back as it starts. Soft failures: what can't be found is noted
// beside the pictures with the element tree, and the run moves on, so one pass collects everything.
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

    /// Launch the app on the stub with `seed` (ProbeArgs' flags) and wait for `label` to show.
    /// `stub` sets the stub's state (`/__set`) after the reset, before the app asks anything.
    func launch(_ seed: [String], dark: Bool = false, stub: String? = nil,
                until label: String, _ name: String) -> XCUIApplication {
        resetStub()
        if let stub { setStub(stub) }
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES"]
            + seed + ["-dark", dark ? "1" : "0"]
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        if !app.windows.firstMatch.waitForExistence(timeout: 20) {
            note("\(name): no window after launch; File > New Window")
            app.typeKey("n", modifierFlags: .command)
        }
        #endif
        if !appears(app, label, timeout: 30) {
            note("\(name): \(label) never showed")
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(label) never showed — the app did not render the seeded state")
        }
        settle(1.5)
        return app
    }

    /// A system dialog left over on the runner (macOS's local-network prompt) sits over the app and
    /// takes its clicks: answer it before photographing anything.
    func dismissSystemPrompts() {
        #if os(macOS)
        let running = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
        for bundle in ["com.apple.UserNotificationCenter", "com.apple.CoreServicesUIAgent"] where running.contains(bundle) {
            let agent = XCUIApplication(bundleIdentifier: bundle)
            for title in ["Allow", "Don't Allow", "OK"] {
                // The dialog's own button: the Touch Bar repeats each one under the same title.
                let inDialog = agent.dialogs.buttons[title].firstMatch
                let button = inDialog.exists ? inDialog : agent.buttons[title].firstMatch
                if button.exists { note("dismissed a system prompt via \(title) (\(bundle))"); button.click(); return }
            }
        }
        #endif
    }

    /// The first text field a finger can reach: the account card's email is a text field too (the
    /// system's username), but nobody can tap it.
    func reachableTextField(_ app: XCUIApplication) -> XCUIElement {
        app.textFields.allElementsBoundByIndex.first(where: { $0.exists && $0.isHittable }) ?? app.textFields.firstMatch
    }

    /// Change the stub's state (`{"google": false}`, `{"methods_delay": 8}`).
    func setStub(_ json: String) {
        post("/__set", json.data(using: .utf8))
    }

    func resetStub() {
        if post("/__reset", nil) != 200 { note("the stub did not answer /__reset") }
    }

    final class StatusBox: @unchecked Sendable {
        var code: Int?
    }

    @discardableResult
    private func post(_ path: String, _ body: Data?) -> Int? {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765\(path)")!)
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let answered = DispatchSemaphore(value: 0)
        let status = StatusBox()
        URLSession.shared.dataTask(with: request) { _, response, _ in
            status.code = (response as? HTTPURLResponse)?.statusCode
            answered.signal()
        }.resume()
        _ = answered.wait(timeout: .now() + 15)
        return status.code
    }

    // MARK: finding

    /// Anything whose label contains these words.
    func containing(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    /// Anything whose label is exactly this.
    func exact(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// The account card: one element, read as "name, email, domain".
    func card(_ app: XCUIApplication, _ name: String = "Alex Morgan") -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "\(name),")).firstMatch
    }

    /// Whether these words show within `timeout`.
    func appears(_ app: XCUIApplication, _ words: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if containing(app, words).exists { return true }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        return false
    }

    /// Press the button labelled exactly this; a miss is a failure, with the tree beside it.
    func press(_ app: XCUIApplication, _ label: String, _ name: String) {
        let query = app.buttons.matching(NSPredicate(format: "label == %@", label))
        let button = query.allElementsBoundByIndex.first(where: { $0.exists && $0.isHittable }) ?? query.firstMatch
        guard button.waitForExistence(timeout: 10) else {
            XCTFail("\(name): no \(label) button")
            write(app.debugDescription, "missing-\(name).txt")
            return
        }
        #if os(macOS)
        button.click()
        #else
        button.tap()
        #endif
    }

    /// Fail unless every one of `present` shows and none of `absent` does (exact labels).
    func expect(_ app: XCUIApplication, present: [String] = [], absent: [String] = [], _ name: String) {
        for label in present where !exact(app, label).exists {
            XCTFail("\(name): \(label) should show")
            note("\(name): MISSING \(label)")
        }
        for label in absent where exact(app, label).exists {
            XCTFail("\(name): \(label) should not show")
            note("\(name): UNEXPECTED \(label)")
        }
    }

    /// One line per element: its type, label, value and frame.
    func describe(_ element: XCUIElement) -> String {
        guard element.exists else { return "(missing)" }
        let value = element.value.map { "\($0)" } ?? ""
        return "\(element.elementType.rawValue) label=\"\(element.label)\" value=\"\(value)\" "
            + "frame=\(element.frame) hittable=\(element.isHittable)"
    }

    // MARK: the stub's log

    /// What the stub logged so far (iOS: the simulator's test runner reads the host's file).
    func requestsLog() -> String {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return "" }
        return (try? String(contentsOfFile: dir + "/requests.log", encoding: .utf8)) ?? ""
    }

    /// Wait until the stub has logged a request containing these words.
    @discardableResult
    func waitForRequest(_ words: String, timeout: TimeInterval, _ name: String) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if requestsLog().contains(words) { return true }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        note("\(name): the stub never logged \(words)")
        return false
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

    /// The whole screen on iOS; on the Mac the app's window, or the whole screen when `screen` (a
    /// context menu is a window of its own).
    func shot(_ name: String, screen: Bool = false) {
        mark(name)
        settle(0.6)
        #if os(macOS)
        let window = XCUIApplication().windows.firstMatch
        save(window.exists && !screen ? window.screenshot().pngRepresentation : XCUIScreen.main.screenshot().pngRepresentation, name)
        #else
        save(XCUIScreen.main.screenshot().pngRepresentation, name)
        #endif
    }

    /// A picture the simulator takes of its own display (`simctl io screenshot`, run.sh's shooter),
    /// for what iOS keeps out of the test's screenshots: the keyboard of a password field and its
    /// dots. Falls back to the test's own picture, with a note, when nothing answers.
    func hostShot(_ name: String) {
        mark(name)
        settle(0.6)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { shot(name); return }
        let picture = URL(fileURLWithPath: dir).appendingPathComponent("\(name).png")
        try? FileManager.default.removeItem(at: picture)
        try? name.write(to: URL(fileURLWithPath: dir).appendingPathComponent("host-shot.request"),
                        atomically: true, encoding: .utf8)
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if let data = try? Data(contentsOf: picture), data.count > 1000 {
                note("\(name): taken by the simulator (\(data.count) bytes)")
                return
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        note("\(name): the simulator's shooter never answered; the test's own picture instead")
        shot(name)
    }

    private func save(_ png: Data, _ name: String) {
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    /// Tell the stub which picture comes next, so requests.log reads against the pictures.
    func mark(_ name: String) {
        post("/__mark", name.data(using: .utf8))
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
}
