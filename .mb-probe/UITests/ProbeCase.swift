import XCTest
#if os(macOS)
import AppKit
#endif

// TEMPORARY evidence probe (see ../README.md), the crossings probe's helpers
// (docs/evidence/project-crossings-native/probe-harness), launched on a chosen project. Helpers for driving and photographing one launch
// against `stub.py`. A state the stub never drove fails the test, and the picture is kept anyway.
class ProbeCase: XCTestCase {
    var notes: [String] = []

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        let file = name.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        write(notes.joined(separator: "\n"), "\(file)-notes.txt")
    }

    /// Kept in the result bundle as well: the Mac UI-test runner may not write to SHOTS_DIR.
    private func attach(_ text: String, _ name: String) {
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Launch against the stub, put back as it starts, and wait for `label` to show.
    /// `project` is a project's page, or — `session:` — a conversation to open instead.
    func launch(_ project: String, session: String? = nil, until label: String, dark: Bool = false,
                _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.fresh",
                               "-probe.project", project,
                               "-ApplePersistenceIgnoreState", "YES"] + (dark ? ["-dark"] : [])
            + (session.map { ["-probe.session", $0] } ?? [])
        #if os(macOS)
        // The CI Mac's display is 1024 points wide: the source list folded away leaves the window's
        // width to the project list and the page, as the toolbar's sidebar button does.
        app.launchArguments += ["-shell.sidebarVisible", "NO"]
        #endif
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        // A WindowGroup opens its window at launch; if none came up, ask for one as File > New Window does.
        if !waitUntil(15, { app.windows.count > 0 }) {
            note("\(name): no window after launch; pressing ⌘N")
            write(app.debugDescription, "no-window-\(name).txt")
            app.typeKey("n", modifierFlags: .command)
            if !waitUntil(15, { app.windows.count > 0 }) { note("\(name): still no window after ⌘N") }
        }
        note("\(name): \(app.windows.count) window(s)")
        #endif
        if !appears(app, label, timeout: 45) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(label) never showed — the app did not render the stub's state")
        }
        settle(2)
        return app
    }

    /// A system dialog left over on the runner sits over the app and takes its clicks.
    func dismissSystemPrompts() {
        #if os(macOS)
        // Also a "… quit unexpectedly" panel from a crash earlier on the runner (Problem Reporter).
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

    func resetStub() {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__reset")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
    }

    // MARK: finding

    /// The first element whose label — or, on macOS, whose value — contains these words.
    func element(_ app: XCUIApplication, containing words: String) -> XCUIElement {
        let byLabel = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
        #if os(macOS)
        if !byLabel.exists {
            let byValue = NSPredicate(format: "value CONTAINS %@", words)
            let text = app.staticTexts.matching(byValue).firstMatch
            if text.exists { return text }
        }
        #endif
        return byLabel
    }

    /// Whether these words show within `timeout`.
    func appears(_ app: XCUIApplication, _ words: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if element(app, containing: words).exists { return true }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        return false
    }

    /// Poll `condition` until it holds or `timeout` runs out.
    func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        return false
    }

    /// Buttons whose label begins with these words, hittable ones first.
    func buttons(_ app: XCUIApplication, beginning words: String) -> [XCUIElement] {
        let all = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", words)).allElementsBoundByIndex
        return all.filter { $0.exists && $0.isHittable } + all.filter { !($0.exists && $0.isHittable) }
    }

    /// Where a scroll lands on the Mac, as a fraction of the window's width: the project page is the
    /// split view's detail column, right of the sidebar and the project list.
    var macScrollX: CGFloat = 0.7

    /// A press: a tap on the phone, a click on the Mac.
    func press(_ element: XCUIElement) {
        #if os(iOS)
        element.tap()
        #else
        element.click()
        #endif
    }

    /// Drag (iOS) or scroll (macOS) until `element` sits between `top` and `bottom`, in points from
    /// the window's top.
    func bring(_ app: XCUIApplication, _ element: XCUIElement, between top: CGFloat, and bottom: CGFloat,
               _ name: String) {
        let window = app.windows.firstMatch
        for attempt in 1...24 {
            // A lazy list has not built a row that is far off screen yet, and reading the frame of an
            // element that does not exist fails the test: ask whether it exists first.
            let exists = element.exists
            let frame = exists ? element.frame : .zero
            let windowTop = window.frame.minY
            if exists, frame.minY - windowTop >= top, frame.maxY - windowTop <= bottom {
                note("\(name): in view after \(attempt - 1) move(s) at \(frame)")
                return
            }
            let below = exists ? frame.maxY - windowTop > bottom : true
            #if os(iOS)
            // Mid-width: a drag that starts at the left edge of a pushed page is the back swipe.
            let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: below ? 0.62 : 0.3))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: below ? -140 : 140)),
                        withVelocity: .slow, thenHoldForDuration: 0.6)
            #else
            // A scroll unit moved the form about a third of a point on the CI Mac (14 × 60 ≈ 250 pt):
            // step by the distance still to go, never so far as to jump past the band.
            let distance = exists ? (below ? frame.maxY - windowTop - bottom : top - (frame.minY - windowTop)) : 600
            let delta = Swift.max(40, Swift.min(900, distance * 2.5))
            let point = window.coordinate(withNormalizedOffset: CGVector(dx: macScrollX, dy: 0.5))
            point.hover()
            point.scroll(byDeltaX: 0, deltaY: below ? -delta : delta)
            #endif
            settle(0.8)
        }
        note("\(name): never between \(top) and \(bottom); last frame \(element.exists ? element.frame : .zero)")
        write(app.debugDescription, "missing-band-\(name).txt")
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

    /// The whole screen — a macOS dialog is a window of its own, over the app's.
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

    /// What the stub logged so far, asked of the stub itself: the Mac UI-test runner may not read
    /// files outside its container.
    func requestsLog() -> String {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__log")!)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        var text = ""
        URLSession.shared.dataTask(with: request) { data, _, _ in
            text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            answered.signal()
        }.resume()
        _ = answered.wait(timeout: .now() + 15)
        return text
    }
}
