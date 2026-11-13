import XCTest
import AppKit

// TEMPORARY evidence probe (never merged): the macOS sidebar crash driver.
//
// Launches the real Orbit app pointed at `stub.py` (a server whose data keeps changing), signs in
// through the app's own login page, then clicks across every sidebar row 200 times without waiting
// for the list to settle. A crash is the app process leaving the foreground; the test then records
// how many clicks landed and fails. The same driver runs against the pre-fix tree as the control.
final class SidebarClickDriverTests: XCTestCase {
    let clicks = 200
    let base = "http://127.0.0.1:8765"

    override func setUp() {
        continueAfterFailure = true
    }

    /// Every row the sidebar can draw. Names are stable in the stub even while its set churns.
    private var targetLabels: [String] {
        ["Projects", "Tasks", "Wiki", "Following", "Settings",
         "orbit-macos", "atlas", "shared-laptop", "Set up mini.local", "Workspaces"]
    }

    func testTwoHundredSidebarClicksWhileDataChanges() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", base,
                               "-ApplePersistenceIgnoreState", "YES",
                               "-NSQuitAlwaysKeepsWindows", "NO"]
        app.launch()
        dismissSystemPrompts()
        XCTAssertTrue(waitForWindow(app, timeout: 20), "no window after launch")

        signIn(app)
        XCTAssertTrue(appears(app, "Workspaces", timeout: 60),
                      "the sidebar never drew; the app did not sign in against the stub")
        settle(2)
        note("signed in; sidebar is up; \(windowSize(app))")
        note("sidebar dump (first 6000 chars):\n" + String(app.debugDescription.prefix(6000)))

        var clicked = 0
        var skipped = 0
        for step in 0..<clicks {
            guard appIsAlive(app) else {
                fail("app left the foreground after \(clicked) clicks (step \(step))")
                return
            }
            var pressed = false
            for offset in 0..<targetLabels.count {
                let label = targetLabels[(step + offset) % targetLabels.count]
                guard let element = findRow(app, label) else { continue }
                if !element.exists || !element.isHittable { continue }
                element.click()
                clicked += 1
                pressed = true
                print("CLICK \(clicked)/\(clicks) -> \(label) at \(Date().timeIntervalSince1970)")
                break
            }
            if !pressed {
                skipped += 1
                print("SKIP step \(step): no target hittable")
            }
            // No settle: the next click lands while the server's answer is still on its way.
            Thread.sleep(forTimeInterval: 0.03)
        }

        let alive = appIsAlive(app)
        note("driver done: clicked=\(clicked) skipped=\(skipped) alive=\(alive) state=\(app.state.rawValue)")
        print("DRIVER_DONE clicked=\(clicked) skipped=\(skipped) alive=\(alive) state=\(app.state.rawValue)")
        shot(app, "sidebar-after-clicks")
        if !alive { fail("app left the foreground during the run") }
        XCTAssertGreaterThanOrEqual(clicked, 150, "too few clicks landed on real rows")
    }

    // MARK: signing in

    private func signIn(_ app: XCUIApplication) {
        let email = app.textFields.firstMatch
        guard email.waitForExistence(timeout: 20) else {
            note("no login field: a stored token signed this launch in")
            return
        }
        email.click()
        email.typeText("owner@example.com")
        let password = app.secureTextFields.firstMatch
        if password.exists {
            password.click()
            password.typeText("probe-password")
        }
        let button = app.buttons["Sign In"].firstMatch
        if button.exists && button.isHittable { button.click() } else { app.typeKey(.return, modifierFlags: []) }
        note("submitted the login form")
    }

    // MARK: finding and pressing

    /// The row carrying this name: an outline row, a cell, or the text inside one. The first
    /// hittable match is pressed. Rows come and go with the stub's changing data, so a miss is
    /// ordinary and the driver moves to the next name.
    private func findRow(_ app: XCUIApplication, _ label: String) -> XCUIElement? {
        for query in [app.outlineRows, app.cells, app.otherElements, app.staticTexts] {
            let matches = query.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
            if let hit = matches.first(where: { $0.exists && $0.isHittable }) { return hit }
        }
        // A Label's title can be exposed as the value of the row rather than its label.
        let byValue = app.descendants(matching: .any)
            .matching(NSPredicate(format: "value == %@", label)).allElementsBoundByIndex
        return byValue.first(where: { $0.exists && $0.isHittable })
    }

    private func appears(_ app: XCUIApplication, _ words: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let q = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words))
            if q.firstMatch.exists { return true }
            Thread.sleep(forTimeInterval: 0.4)
        } while Date() < deadline
        return false
    }

    private func appIsAlive(_ app: XCUIApplication) -> Bool {
        app.state == .runningForeground || app.state == .runningBackground
    }

    private func waitForWindow(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if app.windows.count > 0 { return true }
            Thread.sleep(forTimeInterval: 0.4)
        } while Date() < deadline
        return false
    }

    private func windowSize(_ app: XCUIApplication) -> String {
        let window = app.windows.firstMatch
        return window.exists ? "window \(window.frame)" : "no window element"
    }

    /// A leftover system dialog (notifications, Problem Reporter) takes the clicks meant for the app.
    private func dismissSystemPrompts() {
        let running = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
        let agents = ["com.apple.UserNotificationCenter", "com.apple.CoreServicesUIAgent"]
            + running.filter { $0.contains("ProblemReporter") || $0.contains("CrashReporter") }.sorted()
        for bundle in agents where running.contains(bundle) {
            let agent = XCUIApplication(bundleIdentifier: bundle)
            for title in ["Allow", "OK", "Ignore", "Don't Allow"] {
                let matches = agent.buttons.matching(NSPredicate(format: "label == %@", title))
                    .allElementsBoundByIndex
                guard let button = matches.first(where: { $0.isHittable }) ?? matches.first else { continue }
                note("dismissed a system prompt via \(title) (\(bundle))")
                button.click()
                break
            }
        }
    }

    // MARK: recording

    private func settle(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    private func note(_ line: String) {
        print("NOTE " + line)
        let attachment = XCTAttachment(string: line)
        attachment.name = "note"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func fail(_ line: String) {
        note(line)
        XCTFail(line)
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let window = app.windows.firstMatch
        let png = window.exists ? window.screenshot().pngRepresentation
                                : XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
