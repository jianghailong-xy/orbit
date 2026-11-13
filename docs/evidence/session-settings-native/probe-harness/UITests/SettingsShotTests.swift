import XCTest

// TEMPORARY evidence probe (never merged; harness adapted from source-refused-native). The session
// Settings sheet (docs/mocks/session-settings native.html ①–④) on the iPhone and the Mac, against
// stub.py's one running session S1:
//
//   ① the ⋯ menu with Settings… after Tags… (iPhone; the Mac's entry is the toolbar's gear)
//   ② the sheet's top: Session (labels, public link), Environment, Notifications
//   ③ the Variables page: this session's, the restart banner, the workspace's
//   ④ the sheet scrolled to Info
final class SettingsShotTests: ProbeCase {
    #if os(iOS)
    func testIPhoneSessionSettings() { drive("ios") }
    #endif

    #if os(macOS)
    func testMacSessionSettings() { drive("mac") }
    #endif

    private func picture(_ app: XCUIApplication, _ name: String) {
        dismissSystemPrompts()
        settle(1.2)
        #if os(iOS)
        shot(app, name)
        #else
        // The sheet is a window of its own on the Mac: photograph the screen, which holds both.
        screen(name)
        #endif
        write(app.debugDescription, "tree-\(name).txt")
    }

    private func drive(_ p: String) {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.fresh",
                               "-probe.session", "S1", "-ApplePersistenceIgnoreState", "YES"]
        #if os(macOS)
        app.launchArguments += ["-shell.sidebarVisible", "NO"]
        #endif
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        if !waitUntil(15, { app.windows.count > 0 }) {
            app.typeKey("n", modifierFlags: .command)
            _ = waitUntil(15, { app.windows.count > 0 })
        }
        #endif

        // ① The entry.
        #if os(iOS)
        let menu = app.buttons["Session actions"]
        guard waitUntil(120, { menu.exists && menu.isHittable }) else {
            write(app.debugDescription, "missing-\(p)-menu.txt")
            XCTFail("\(p): the session's ⋯ menu never showed")
            return
        }
        settle(2)
        menu.tap()
        settle(1.5)
        picture(app, "\(p)-1-menu")
        let entry = app.buttons["Settings…"]
        #else
        let entry = app.buttons.matching(NSPredicate(format: "label == %@ OR title == %@ OR identifier == %@",
                                                     "Settings…", "Settings…", "Settings…")).firstMatch
        guard waitUntil(120, { entry.exists }) else {
            write(app.debugDescription, "missing-\(p)-entry.txt")
            XCTFail("\(p): no Settings… in the toolbar")
            return
        }
        settle(3)
        picture(app, "\(p)-1-toolbar")
        #endif
        guard entry.exists else {
            write(app.debugDescription, "missing-\(p)-settings-item.txt")
            XCTFail("\(p): no Settings… item")
            return
        }
        press(entry)

        // ② The sheet.
        if !appears(app, "Session Settings", timeout: 20) {
            write(app.debugDescription, "missing-\(p)-sheet.txt")
            XCTFail("\(p): the sheet never opened")
        }
        _ = appears(app, "Compact at", timeout: 20)
        _ = appears(app, "When a turn finishes", timeout: 10)
        settle(2)
        picture(app, "\(p)-2-sheet")
        for words in ["Labels", "needs review", "Public link", "Working directory", "Compact at", "Variables",
                      "When it needs you", "Mute this session", "iOS and Android"] {
            note("\(p): \(words) \(appears(app, words, timeout: 2) ? "shown" : "MISSING")")
        }

        // ④ Info, further down.
        let info = element(app, containing: "Engine session")
        #if os(iOS)
        for _ in 0..<4 where !(info.exists && info.isHittable) {
            app.swipeUp()
            settle(0.8)
        }
        #else
        macScrollX = 0.5
        bring(app, info, between: 200, and: 700, "\(p)-info")
        #endif
        picture(app, "\(p)-4-info")
        for words in ["Claude Code 2.4.1", "HPC", "Max (2)", "1.82M", "$4.37", "23 turns", "Session ID"] {
            note("\(p): \(words) \(appears(app, words, timeout: 2) ? "shown" : "MISSING")")
        }

        // ③ Variables.
        #if os(iOS)
        for _ in 0..<4 { app.swipeDown(); settle(0.5) }
        #else
        bring(app, element(app, containing: "Compact at"), between: 100, and: 600, "\(p)-variables-row")
        #endif
        let variables = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Variables")).firstMatch
        let target = variables.exists ? variables : element(app, containing: "Variables")
        if target.exists {
            press(target)
            settle(2)
            _ = appears(app, "From the workspace", timeout: 10)
            picture(app, "\(p)-3-variables")
            for words in ["DEBUG", "LOG_LEVEL", "NODE_OPTIONS", "Restart after this turn", "replaces the workspace"] {
                note("\(p): \(words) \(appears(app, words, timeout: 2) ? "shown" : "MISSING")")
            }
            // The restart press, recorded by the stub.
            let restart = element(app, containing: "Restart after this turn")
            if restart.exists, restart.isHittable {
                press(restart)
                settle(2)
                picture(app, "\(p)-3b-restart-queued")
            }
        } else {
            write(app.debugDescription, "missing-\(p)-variables.txt")
            XCTFail("\(p): no Variables row")
        }
        write(requestsLog(), "\(p)-requests.txt")
        app.terminate()
    }
}
