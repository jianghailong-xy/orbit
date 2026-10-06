import XCTest
#if os(macOS)
import AppKit
#endif

// TEMPORARY evidence probe (see ../README.md), adapted from the Access tokens probe
// (origin probe/pat-clients). Helpers for driving and photographing one launch against `stub.py`.
// A state the stub never drove fails the test, and the picture is kept anyway.
class ProbeCase: XCTestCase {
    var notes: [String] = []

    #if os(macOS)
    let platform = "mac"
    #else
    let platform = "ios"
    #endif

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        let file = name.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        write(notes.joined(separator: "\n"), "\(platform)-\(file)-notes.txt")
    }

    /// Kept in the result bundle as well: the Mac UI-test runner may not write to SHOTS_DIR.
    private func attach(_ text: String, _ name: String) {
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Launch against the stub's server on `port`, forgotten what it saw, and wait for `words`.
    func launch(port: Int, until words: String, dark: Bool = false, _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:\(port)",
                               "-ApplePersistenceIgnoreState", "YES"] + (dark ? ["-dark"] : [])
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        // A WindowGroup opens its window at launch; if none came up, ask for one as File > New Window does.
        if !waitUntil(15, { app.windows.count > 0 }) {
            note("\(name): no window after launch; pressing ⌘N")
            app.typeKey("n", modifierFlags: .command)
            _ = waitUntil(15, { app.windows.count > 0 })
        }
        note("\(name): \(app.windows.count) window(s)")
        #endif
        if !appears(app, words, timeout: 45) {
            write(app.debugDescription, "\(platform)-missing-\(name).txt")
            XCTFail("\(name): \(words) never showed")
        }
        settle(1.5)
        return app
    }

    /// A system dialog left over on the runner sits over the app and takes its clicks.
    func dismissSystemPrompts() {
        #if os(macOS)
        let running = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
        let agents = ["com.apple.UserNotificationCenter", "com.apple.CoreServicesUIAgent"]
            + running.filter { $0.contains("ProblemReporter") || $0.contains("CrashReporter") }.sorted()
        for bundle in agents where running.contains(bundle) {
            let agent = XCUIApplication(bundleIdentifier: bundle)
            for title in ["Allow", "Don't Allow", "OK", "Ignore"] {
                let button = agent.buttons[title]
                if button.exists { note("dismissed a system prompt via \(title) (\(bundle))"); button.click(); return }
            }
        }
        #endif
    }

    // MARK: the stub

    private final class Answer: @unchecked Sendable {
        var data: Data?
    }

    private func stub(_ method: String, _ path: String) -> Data? {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765\(path)")!)
        request.httpMethod = method
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        let answer = Answer()
        URLSession.shared.dataTask(with: request) { data, _, _ in
            answer.data = data
            answered.signal()
        }.resume()
        _ = answered.wait(timeout: .now() + 15)
        return answer.data
    }

    func resetStub() {
        _ = stub("POST", "/__reset")
    }

    /// What the stub's server on `port` was asked since the launch: its own one-line notes.
    func seen(_ port: Int) -> [String] {
        guard let data = stub("GET", "/__log"),
              let log = (try? JSONSerialization.jsonObject(with: data)) as? [String: [String]] else { return [] }
        return log[String(port)] ?? []
    }

    // MARK: finding

    /// The first element whose label — or, on macOS, whose value — contains these words.
    func element(_ app: XCUIApplication, containing words: String) -> XCUIElement {
        let byLabel = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
        #if os(macOS)
        if !byLabel.exists {
            let text = app.staticTexts.matching(NSPredicate(format: "value CONTAINS %@", words)).firstMatch
            if text.exists { return text }
        }
        #endif
        return byLabel
    }

    func appears(_ app: XCUIApplication, _ words: String, timeout: TimeInterval) -> Bool {
        waitUntil(timeout) { self.element(app, containing: words).exists }
    }

    func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        return false
    }

    func press(_ element: XCUIElement) {
        #if os(macOS)
        element.click()
        #else
        element.tap()
        #endif
    }

    // MARK: recording

    func settle(_ seconds: TimeInterval = 0.8) {
        Thread.sleep(forTimeInterval: seconds)
    }

    func note(_ line: String) {
        notes.append(line)
    }

    /// The app's window (macOS) or the whole screen (iOS).
    func shot(_ app: XCUIApplication, _ name: String) {
        #if os(macOS)
        let window = app.windows.firstMatch
        save(window.exists ? window.screenshot().pngRepresentation : XCUIScreen.main.screenshot().pngRepresentation, name)
        #else
        save(XCUIScreen.main.screenshot().pngRepresentation, name)
        #endif
    }

    /// The whole screen: a system sheet or prompt is a window of its own.
    func screen(_ name: String) {
        save(XCUIScreen.main.screenshot().pngRepresentation, name)
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
        attach(text, file)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? text.write(to: URL(fileURLWithPath: dir).appendingPathComponent(file), atomically: true, encoding: .utf8)
    }
}
