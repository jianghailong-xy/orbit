import XCTest

// TEMPORARY evidence probe (task 354kzrnSltZOM5gAfavxq; never merged). The session page on the iPhone and the Mac,
// drawing what a real apiserver answered (stub.py serves contracts/permission-mode-refused):
//
//   S1  a correction Claude refused: the mode control's lasting gap ("Default", no spinner), its menu head with the
//       CLI's words, and the transcript line that names the refusal;
//   S2  the claim's substitution: its line worded from the server's requestedMode and reason.
final class PermissionModeShotTests: ProbeCase {
    private let words = "Cannot set permission mode to auto: auto mode unavailable for this model"

    #if os(iOS)
    func testIPhoneShowsTheRefusedCorrection() { drive("ios") }
    #endif

    #if os(macOS)
    func testMacShowsTheRefusedCorrection() { drive("mac") }
    #endif

    private var shotsDir: String { ProcessInfo.processInfo.environment["SHOTS_DIR"] ?? "/tmp" }

    private func picture(_ app: XCUIApplication, _ name: String) {
        dismissSystemPrompts()
        settle(1.2)
        guard app.windows.firstMatch.exists else { note("\(name): no window to photograph"); return }
        shot(app, name)
        write(app.debugDescription, "tree-\(name).txt")
    }

    private func open(_ session: String, until label: String, _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.fresh",
                               "-probe.session", session, "-ApplePersistenceIgnoreState", "YES"]
        #if os(macOS)
        app.launchArguments += ["-shell.sidebarVisible", "NO",
                                "-probe.fitWindow", "-probe.windowLog", "/tmp/pm-window-\(session).log",
                                "-probe.shot", "\(shotsDir)/mac-window-\(session).png"]
        #endif
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        if !waitUntil(15, { app.windows.count > 0 }) {
            note("\(name): no window after launch; pressing ⌘N")
            app.typeKey("n", modifierFlags: .command)
            _ = waitUntil(15, { app.windows.count > 0 })
        }
        #endif
        if !appears(app, label, timeout: 120) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(label) never showed — the app did not render the stub's state")
        }
        settle(1.5)
        return app
    }

    private func drive(_ platform: String) {
        // 1. The refused correction: the line, the control's lasting gap.
        var app = open("S1", until: "Claude stays in Default", "\(platform)-refused")
        let mode = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Mode:")).firstMatch
        note("\(platform): mode control \(mode.exists ? "'\(mode.label)'" : "MISSING")")
        XCTAssertEqual(mode.label, "Mode: Default", "the control shows the lasting gap, not \"Default → Auto\"")
        note("\(platform): refusal line \(appears(app, "the runner couldn't switch it to Auto: \(words)", timeout: 3) ? "shown" : "MISSING")")
        note("\(platform): report line \(appears(app, "Engine reported Default", timeout: 3) ? "shown" : "MISSING")")
        picture(app, "\(platform)-1-refused")

        // 2. The control's menu: its head says why, in Claude's words.
        if mode.exists, mode.isHittable {
            press(mode)
            settle(1.5)
            note("\(platform): menu head \(appears(app, "but the runner couldn't switch Claude to it: \(words)", timeout: 5) ? "shown" : "MISSING")")
            picture(app, "\(platform)-2-refused-menu")
        } else {
            note("\(platform): no hittable mode control to open (exists: \(mode.exists))")
        }
        write(requestsLog(), "\(platform)-requests.txt")
        app.terminate()

        // 3. The claim's substitution, worded from the server's reason.
        app = open("S2", until: "Started in Auto, not Bypass", "\(platform)-root-claim")
        picture(app, "\(platform)-3-root-claim")
        app.terminate()
    }
}
