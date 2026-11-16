import XCTest

// TEMPORARY evidence probe (never merged). Board docs/mocks/prompt-optimizer/01-board.png, drawn by
// the real iOS and Mac apps over stub.py: frame 1 (Settings, switch off), 1b (no DeepSeek key),
// 2 (✦ Optimize beside Send), 3 (Optimizing…), 4 (the suggestion: a sheet on the iPhone, a card above
// the composer on the Mac; 4b its gloss), 5 (after Use, with Undo; 5b after Undo) and 6 (failure).
// A state that never shows fails the test; its picture is kept anyway.
final class PromptOptimizerTests: ProbeCase {
    private let draft = "fix the login redirect bug, it goes to the wrong page after sign in"

    #if os(iOS)
    private let platform = "ios"
    #else
    private let platform = "mac"
    #endif

    private func setMode(_ mode: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__mode/\(mode)")!)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
    }

    private func button(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        let all = app.buttons.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
        return all.first(where: { $0.exists && $0.isHittable }) ?? app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func optimizeButton(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(identifier: "composer.optimize").firstMatch
    }

    private func expect(_ app: XCUIApplication, _ words: String, _ timeout: TimeInterval, _ name: String) {
        if !appears(app, words, timeout: timeout) {
            write(app.debugDescription, "missing-\(platform)-\(name).txt")
            XCTFail("\(name): \"\(words)\" never showed")
        }
    }

    /// Whether a "NEW" text is anywhere on screen (iOS: label; Mac: value).
    private func noNewBadge(_ app: XCUIApplication) -> Bool {
        let byLabel = app.staticTexts.matching(NSPredicate(format: "label == %@", "NEW")).firstMatch.exists
        #if os(macOS)
        return byLabel || app.staticTexts.matching(NSPredicate(format: "value == %@", "NEW")).firstMatch.exists
        #else
        return byLabel
        #endif
    }

    private func optimizerSwitch(_ app: XCUIApplication) -> XCUIElement {
        let id = "settings.promptOptimizer.enabled"
        let sw = app.switches.matching(identifier: id).firstMatch
        #if os(macOS)
        if !sw.exists {
            let box = app.checkBoxes.matching(identifier: id).firstMatch
            if box.exists { return box }
        }
        #endif
        return sw
    }

    private func openSettings(_ name: String) -> XCUIApplication {
        #if os(iOS)
        // Settings presented from the launch's own task can be dropped, so it is opened as a person
        // opens it: the drawer, then its Settings button.
        let app = launch(until: "Login redirect fix", extra: ["-probe.page", "settings"], name)
        let drawer = app.buttons.matching(identifier: "line.3.horizontal").firstMatch
        if drawer.exists { press(drawer) } else { XCTFail("\(name): no Open navigation button") }
        let gear = app.buttons.matching(identifier: "gearshape").firstMatch
        if waitUntil(10, { gear.exists && gear.isHittable }) {
            press(gear)
        } else if gear.exists {
            gear.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        } else {
            XCTFail("\(name): the drawer had no Settings button")
        }
        settle(2)
        _ = waitUntil(10, { !self.buttons(app, beginning: "Sessions").isEmpty })
        let rows = buttons(app, beginning: "Sessions")
        if let row = rows.first {
            press(row)
        } else {
            write(app.debugDescription, "missing-sessions-row-\(name).txt")
            XCTFail("\(name): Settings had no Sessions row")
        }
        settle(1.5)
        bring(app, optimizerSwitch(app), between: 220, and: 640, name)
        #else
        let app = launch(until: "Suggested replies", extra: ["-probe.page", "settings"], name)
        // Settings' list is the window's left column; the right is its empty detail pane.
        macScrollX = 0.12
        bring(app, element(app, containing: "Prompt optimizer"), between: 260, and: 560, name)
        #endif
        settle(1)
        return app
    }

    /// `preferences.promptOptimizer` as the stub holds it now: "absent", "true" or "false".
    private func storedSwitch() -> String {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/api/users/me")!)
        request.timeoutInterval = 10
        var answer = "unread"
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data, let me = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let prefs = me["preferences"] as? [String: Any] {
                answer = (prefs["promptOptimizer"] as? Bool).map { $0 ? "true" : "false" } ?? "absent"
            }
            answered.signal()
        }.resume()
        _ = answered.wait(timeout: .now() + 15)
        return answer
    }

    private func isOn(_ sw: XCUIElement) -> Bool {
        let value = "\(sw.value ?? "")"
        return value == "1" || value == "true" || value == "on"
    }

    // On by default (owner, 2026-11-16): an untouched account, no promptOptimizer key, on a server with
    // the DeepSeek key, draws the switch on; turning it off writes promptOptimizer: false.
    func test0SettingsUntouchedIsOn() {
        setMode("untouched")
        XCTAssertEqual(storedSwitch(), "absent", "the account has no promptOptimizer key")
        let name = "\(platform)-1-settings-untouched-on"
        let app = openSettings(name)
        expect(app, "Prompt optimizer", 10, name)
        let sw = optimizerSwitch(app)
        XCTAssertTrue(waitUntil(15, { sw.exists }), "\(name): switch not found by identifier")
        _ = waitUntil(15, { self.isOn(sw) })
        note("\(name): switch value \(String(describing: sw.value)), enabled \(sw.isEnabled), stored \(storedSwitch())")
        XCTAssertTrue(isOn(sw), "an untouched account's switch is drawn on")
        XCTAssertTrue(sw.isEnabled, "the switch is usable on a server with a key")
        shot(app, name)
        write(app.debugDescription, "tree-\(name).txt")
        press(sw)
        XCTAssertTrue(waitUntil(15, { self.storedSwitch() == "false" }), "turning it off writes promptOptimizer: false")
        _ = waitUntil(10, { !self.isOn(sw) })
        note("\(name): after the press, switch value \(String(describing: sw.value)), stored \(storedSwitch())")
        XCTAssertFalse(isOn(sw), "the switch reads off once turned off")
        shot(app, "\(platform)-1-settings-turned-off")
        app.terminate()
    }

    // Frame 1: one account-wide switch, off by default, under Suggested replies.
    func test1SettingsSwitchOff() {
        setMode("off")
        let name = "\(platform)-1-settings"
        let app = openSettings(name)
        expect(app, "Prompt optimizer", 10, name)
        expect(app, "Show an Optimize button in the composer", 10, name)
        XCTAssertFalse(noNewBadge(app), "Settings draws no NEW badge beside Prompt optimizer")
        let sw = optimizerSwitch(app)
        if sw.exists {
            note("\(name): switch value \(String(describing: sw.value)), enabled \(sw.isEnabled)")
            XCTAssertTrue(sw.isEnabled, "the switch is usable on a server with a key")
        } else {
            note("\(name): switch not found by identifier")
        }
        shot(app, name)
        write(app.debugDescription, "tree-\(name).txt")
        app.terminate()
    }

    // Frame 1b: a server without a DeepSeek key draws it disabled with the notice.
    func test1bSettingsUnavailable() {
        setMode("unavailable")
        let name = "\(platform)-1b-unavailable"
        let app = openSettings(name)
        expect(app, "This server has no DeepSeek key (DEEPSEEK_API_KEY)", 10, name)
        XCTAssertFalse(noNewBadge(app), "Settings draws no NEW badge beside Prompt optimizer")
        let sw = optimizerSwitch(app)
        if sw.exists {
            XCTAssertFalse(sw.isEnabled, "the switch is disabled without a key")
        }
        shot(app, name)
        app.terminate()
    }

    // Frames 2–5: the button, the press, the suggestion (and its gloss), Use, and Undo.
    func test2To5OptimizeUseUndo() {
        setMode("ok")
        let app = launch(until: "Login redirect fix", extra: ["-probe.page", "chat", "-probe.draft", draft],
                         "\(platform)-flow")
        let optimize = optimizeButton(app)
        if !waitUntil(30, { optimize.exists }) {
            write(app.debugDescription, "missing-\(platform)-2-button.txt")
            XCTFail("frame 2: ✦ Optimize never showed beside Send")
        }
        settle(1)
        shot(app, "\(platform)-2-button")

        press(optimize)
        settle(1.5)
        expect(app, "Optimizing", 6, "\(platform)-3-optimizing")
        shot(app, "\(platform)-3-optimizing")

        expect(app, "Optimized prompt", 40, "\(platform)-4-suggestion")
        settle(1.5)
        XCTAssertTrue(appears(app, "this session's last 6 turns", timeout: 5), "the Used: chips never showed")
        shot(app, "\(platform)-4-suggestion")
        write(app.debugDescription, "tree-\(platform)-4-suggestion.txt")

        let gloss = button(app, "Show in Chinese")
        if gloss.exists {
            press(gloss)
            settle(1)
            shot(app, "\(platform)-4b-gloss")
            let back = button(app, "Show in English")
            if back.exists { press(back); settle(0.8) } else { XCTFail("Show in English never showed") }
        } else {
            XCTFail("frame 4: Show in Chinese never showed")
        }

        let use = button(app, "Use")
        if use.exists {
            press(use)
        } else {
            XCTFail("frame 4: Use never showed")
        }
        settle(1.5)
        expect(app, "Draft replaced with the optimized prompt", 8, "\(platform)-5-after-use")
        XCTAssertFalse(app.staticTexts["Optimized prompt"].exists, "the card goes on Use")
        shot(app, "\(platform)-5-after-use")
        write(app.debugDescription, "tree-\(platform)-5-after-use.txt")

        let undo = button(app, "Undo")
        if undo.exists {
            press(undo)
            settle(1.5)
            XCTAssertFalse(appears(app, "Draft replaced with the optimized prompt", timeout: 2),
                           "the toast goes once Undo put the draft back")
            shot(app, "\(platform)-5b-undone")
            write(app.debugDescription, "tree-\(platform)-5b-undone.txt")
        } else {
            XCTFail("frame 5: Undo never showed")
        }
        write(requestsLog(), "requests-\(platform)-flow.txt")
        app.terminate()
    }

    // Frame 6: the optimizer failed; the draft is untouched and Try again is offered.
    func test6Failure() {
        setMode("fail")
        let app = launch(until: "Login redirect fix", extra: ["-probe.page", "chat", "-probe.draft", draft],
                         "\(platform)-fail")
        let optimize = optimizeButton(app)
        if !waitUntil(30, { optimize.exists }) {
            XCTFail("frame 6: ✦ Optimize never showed")
        } else {
            press(optimize)
        }
        expect(app, "Couldn't optimize this draft.", 20, "\(platform)-6-failure")
        XCTAssertTrue(button(app, "Try again").exists, "Try again never showed")
        settle(1)
        shot(app, "\(platform)-6-failure")
        write(app.debugDescription, "tree-\(platform)-6-failure.txt")
        app.terminate()
    }
}
