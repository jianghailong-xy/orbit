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

    /// Every row the sidebar can draw, by the name it draws. Names are stable in the stub even while
    /// its set churns. This is the fallback for a host that does not expose the rows themselves.
    private var targetLabels: [String] {
        ["Projects", "Tasks", "Wiki", "orbit-macos", "atlas", "shared-laptop",
         "Set up mini.local", "Workspaces", "Project P1"]
    }

    func testTwoHundredSidebarClicksWhileDataChanges() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", base,
                               "-ApplePersistenceIgnoreState", "YES",
                               "-NSQuitAlwaysKeepsWindows", "NO"]
        app.launch()
        dismissSystemPrompts()
        XCTAssertTrue(waitForWindow(app, timeout: 20), "no window after launch")
        // The CI Mac does not make a launched app frontmost on its own: its accessibility tree read
        // `Disabled` and every row `Not hittable`, which is why earlier runs "clicked" 200 times
        // without selecting anything. Ask for the front explicitly.
        app.activate()
        settle(1)

        signIn(app)
        XCTAssertTrue(appears(app, "Workspaces", timeout: 60),
                      "the sidebar never drew; the app did not sign in against the stub")
        app.activate()
        settle(2)
        note("signed in; sidebar is up; \(windowSize(app))")
        note("sidebar dump (first 6000 chars):\n" + String(app.debugDescription.prefix(6000)))

        // Every click that lands is one click of the 200 the gate asks for; a step that finds no
        // hittable row is skipped and tried again, so the run ends with 200 real presses or says
        // how many it got. The row count is re-read every step because the stub's changing answer
        // rebuilds the rail underneath the clicks — the same rows a user's pointer would find.
        var clicked = 0
        var skipped = 0
        var selectedPresses = 0
        var step = 0
        let deadline = Date().addingTimeInterval(900)
        while clicked < clicks {
            guard appIsAlive(app) else {
                fail("app left the foreground after \(clicked) clicks (step \(step))")
                return
            }
            guard Date() < deadline else {
                fail("only \(clicked) of \(clicks) clicks landed before the 15-minute deadline")
                return
            }
            if pressNextRow(app, step: step) {
                clicked += 1
                if lastSelectedRows > 0 { selectedPresses += 1 }
            } else {
                skipped += 1
            }
            step += 1
            // No settle: the next click lands while the server's answer is still on its way.
            Thread.sleep(forTimeInterval: 0.03)
        }

        let alive = appIsAlive(app)
        note("driver done: clicked=\(clicked) skipped=\(skipped) selected_presses=\(selectedPresses)"
             + " alive=\(alive) state=\(app.state.rawValue)")
        print("DRIVER_DONE clicked=\(clicked) skipped=\(skipped) selected_presses=\(selectedPresses)"
              + " alive=\(alive) state=\(app.state.rawValue)")
        shot(app, "sidebar-after-clicks")
        XCTAssertTrue(alive, "app left the foreground during the run")
        XCTAssertEqual(clicked, clicks, "fewer than \(clicks) clicks landed on real rows")
        // A press that never selects anything is a press that did not reach the rail: the gate must
        // be able to say its clicks were clicks, not empty points in the window.
        XCTAssertGreaterThan(selectedPresses, 0, "no press selected a sidebar row — the gate pressed nothing")
    }

    // MARK: clicking a row

    /// How many rows the last press saw selected (AX `isSelected`). Zero on a press that did not
    /// reach the sidebar — the run reports it, and the test requires at least one non-zero press.
    private var lastSelectedRows = 0

    /// One press on the sidebar, cycling the rows by index so every row — the Wiki included, and
    /// whatever the churn is drawing at this instant — gets clicked; the named rows are the fallback
    /// when the host does not expose the list's rows as elements. Nothing here may raise: a row that
    /// is gone or not hittable is skipped, not clicked. An XCUITest "Not hittable" failure unwinds
    /// the enclosing block even inside an expected-failure allowance (the first run that used one
    /// ended after its first press), so the driver asks before it presses instead.
    private func pressNextRow(_ app: XCUIApplication, step: Int) -> Bool {
        let rows = sidebarRows(app)
        if !rows.isEmpty {
            let index = step % rows.count
            let row = rows[index]
            // The row's own element click, and only when the row is really there and hittable:
            // a coordinate click at the row's centre did NOT select the row on the CI Mac (the
            // run's request log shows the Tasks page was never opened, only its sidebar count
            // polled), and a click on a row reported "Not hittable" aborts the test outright.
            if row.exists && row.isHittable {
                row.click()
                lastSelectedRows = selectedRows(app)
                print("CLICK \(step + 1) row=\(index)/\(rows.count) selected=\(lastSelectedRows)"
                      + " at \(Date().timeIntervalSince1970)")
                return true
            }
        }
        for offset in 0..<targetLabels.count {
            let label = targetLabels[(step + offset) % targetLabels.count]
            guard let element = findRow(app, label) else { continue }
            if !element.exists || !element.isHittable { continue }
            element.click()
            lastSelectedRows = selectedRows(app)
            print("CLICK \(step + 1) -> \(label) selected=\(lastSelectedRows)"
                  + " at \(Date().timeIntervalSince1970)")
            return true
        }
        print("SKIP step \(step): no target hittable")
        return false
    }

    /// The sidebar's rows as one snapshot: the outline rows SwiftUI's source list exposes first,
    /// then any row descendant at all (a host that draws them as a plain table). One snapshot, not
    /// one query per index — a per-index lookup after a count is how the last run asked for a row
    /// that had just left, which XCTest reports as "No matches found".
    private func sidebarRows(_ app: XCUIApplication) -> [XCUIElement] {
        let outline = app.outlineRows.allElementsBoundByIndex
        if !outline.isEmpty { return outline }
        return app.descendants(matching: .tableRow).allElementsBoundByIndex
    }

    /// The rows the sidebar reports as selected right now.
    private func selectedRows(_ app: XCUIApplication) -> Int {
        app.outlineRows.allElementsBoundByIndex.filter { $0.isSelected }.count
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
