import XCTest

// TEMPORARY evidence probe (never merged): the approved board's fixture rows (docs/mocks/session-display-three-states)
// in the iPhone and Mac apps' own session lists, against .sd-probe/stub.py, for task 353SkITm4HyfRI5bDGMlh. Each case
// is photographed twice: with the session facts (after: the state from `phase`, the marks beside it) and with them
// absent (an older server, which must draw what the app drew before). Beside the pictures, the notes give every row's
// label and value as the accessibility tree reads them (on iPhone the value is the row's spoken state). On the Mac the
// interrupted session (S07) is opened too, for the header in the status bar.
final class DisplayShotTests: ProbeCase {
    private let first = "Translate the help pages"
    private let titles = ["Translate the help pages", "Fix the login redirect", "Tidy the settings page",
                          "Sketch the onboarding flow", "Task: Add the export button", "Upgrade the date library",
                          "Draft the release notes", "Run the full test suite", "Clean up old branches", "Index the wiki",
                          "Profile the slow query", "Rename the CLI flags", "Review the API errors", "Nightly build report",
                          "Split the settings module", "Watch the nightly build", "Old runner session",
                          "Old runner session (released)"]

    private func open(facts: Bool, session: String? = nil, _ name: String) -> XCUIApplication {
        resetStub()
        setStub("{\"facts\": \(facts)}")
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.fresh", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
            + (session.map { ["-probe.session", $0] } ?? ["-probe.list", "1"])
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        if !app.windows.firstMatch.waitForExistence(timeout: 20) {
            note("\(name): no window after launch; File > New Window")
            app.typeKey("n", modifierFlags: .command)
        }
        #endif
        if !appears(app, first, timeout: 60) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(first) never showed — the app did not render the stub's rows")
        }
        settle(3)
        return app
    }

    /// Every row's label and value, by its title.
    private func noteRows(_ app: XCUIApplication, _ name: String) {
        for title in titles {
            let row = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
            note("\(name) \(title): \(describe(row))")
        }
    }

    func test1List() {
        for facts in [true, false] {
            let name = facts ? "after" : "older-server"
            let app = open(facts: facts, "list-\(name)")
            shot("list-\(name)-1")
            noteRows(app, "list-\(name)")
            tree(app, "list-\(name)")
            // Three more screens down the list.
            for page in 2...4 {
                #if os(iOS)
                let window = app.windows.firstMatch
                // Mid-screen, not the left edge: the shell's drawer takes a drag that starts at the edge.
                let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.78))
                start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -460)),
                            withVelocity: .slow, thenHoldForDuration: 0.6)
                #else
                let anchor = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "label BEGINSWITH %@", titles[min(4 * page, titles.count - 1)])).firstMatch
                if anchor.exists { anchor.scroll(byDeltaX: 0, deltaY: -260) }
                #endif
                settle(1.2)
                shot("list-\(name)-\(page)")
            }
            app.terminate()
        }
    }

    #if os(macOS)
    /// The conversation header in the status bar: "Idle  [Interrupted]  · Open · 4m ago".
    func test2Header() {
        for facts in [true, false] {
            let name = facts ? "after" : "older-server"
            let app = open(facts: facts, session: "S07", "header-\(name)")
            settle(2)
            shot("header-\(name)")
            for words in ["Idle", "Interrupted", "Open"] {
                let found = app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH %@ OR label BEGINSWITH %@",
                                                                 words, words)).count
                note("header-\(name): \(found) text(s) beginning \(words)")
            }
            tree(app, "header-\(name)")
            app.terminate()
        }
    }
    #endif
}
