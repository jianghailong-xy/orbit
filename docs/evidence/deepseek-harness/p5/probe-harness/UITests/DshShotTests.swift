import XCTest

// TEMPORARY evidence probe (never merged): DeepSeek Harness on the native clients against stub.py.
// The operation chain is driven by the app's own presses — the provider picker, the Mode menu, Send
// (POST /sessions), Allow (POST …/approvals/ap1/decision), Stop (POST …/interrupt) and a follow-up
// (POST …/turns) — and the stub answers each with the next canned state. The stub has no event
// stream, so after a press the console is opened again to read what the stub now serves; that relaunch
// is the one difference from a live session, and requests.log is the record of what the app sent.
final class DshShotTests: ProbeCase {
    private func scheme(_ dark: Bool) -> String { dark ? "dark" : "light" }

    // MARK: finding

    /// The hero's switch: "Engine: …" since main grouped the hero by engine (92d6c0ad7), "Provider: …" before.
    func providerButton(_ app: XCUIApplication) -> XCUIElement {
        let engine = button(app, beginning: "Engine:")
        return engine.exists ? engine : button(app, beginning: "Provider:")
    }

    /// The Mode pill: a menu whose title is the current mode.
    func modeMenu(_ app: XCUIApplication) -> XCUIElement {
        for label in ["Auto", "Default", "Don't Ask"] {
            #if os(macOS)
            let menu = app.menuButtons[label]
            if menu.exists { return menu }
            let popup = app.popUpButtons[label]
            if popup.exists { return popup }
            #endif
            let hit = app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
            if hit.exists { return hit }
        }
        return app.buttons["Auto"]
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

    func stopButton(_ app: XCUIApplication) -> XCUIElement {
        let query = app.buttons.matching(NSPredicate(
            format: "(label CONTAINS[c] 'stop' OR identifier CONTAINS[c] 'stop') AND NOT (label CONTAINS[c] 'send')"))
        return query.allElementsBoundByIndex.first(where: { $0.isHittable }) ?? query.firstMatch
    }

    func type(_ app: XCUIApplication, _ text: String, _ name: String) {
        let field = composer(app)
        guard field.waitForExistence(timeout: 10) else { note("\(name): no composer"); tree(app, name); return }
        field.tap()
        settle(0.5)
        field.typeText(text)
        settle(0.8)
        note("\(name): composer \(describe(field))")
    }

    func send(_ app: XCUIApplication, _ name: String) {
        let button = sendButton(app)
        note("\(name): send button \(describe(button))")
        if button.exists, button.isHittable {
            button.tap()
        } else {
            #if os(macOS)
            app.typeKey(.return, modifierFlags: [])
            #endif
            tree(app, "\(name)-no-send")
        }
        settle(3)
    }

    // MARK: 1. choosing the engine, its model, thinking level and mode

    func test1PickEngine() {
        for dark in [false, true] {
            let s = scheme(dark)
            let app = launch("compose", dark: dark, until: "DeepSeek", "compose-\(s)")
            shot("1-compose-\(s)")
            tree(app, "compose-\(s)")
            let picker = providerButton(app)
            note("compose-\(s): provider button \(describe(picker))")
            if !picker.exists { XCTFail("compose-\(s): no engine/provider switch on the hero") }
            if picker.exists { picker.tap(); settle(2) }
            shot("1b-provider-picker-\(s)")
            for words in ["DeepSeek Harness", "Harness", "Claude Code", "DeepSeek V4 Pro"] {
                note("picker-\(s) \(words): \(describe(containing(app, words)))")
            }
            tree(app, "provider-picker-\(s)")
            app.terminate()
        }
    }

    func test2ModeAndModelMenus() {
        for dark in [false, true] {
            let s = scheme(dark)
            let app = launch("compose", dark: dark, until: "DeepSeek", "mode-\(s)")
            let mode = modeMenu(app)
            note("mode-\(s): mode menu \(describe(mode))")
            if mode.exists { mode.tap(); settle(1.5) }
            shot("2-mode-menu-\(s)")
            for words in ["Default", "Auto", "Don't Ask", "Plan", "Accept Edits", "Bypass"] {
                let item = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", words))
                    .allElementsBoundByIndex.map { "\($0.label) enabled=\($0.isEnabled)" }
                note("mode-\(s) \(words): \(item)")
            }
            tree(app, "mode-menu-\(s)")
            #if os(macOS)
            app.typeKey(.escape, modifierFlags: [])
            #else
            app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
            #endif
            settle(1)
            // The model/effort control: the current model's name.
            #if os(macOS)
            let menu = app.menuButtons.matching(NSPredicate(format: "label BEGINSWITH 'DeepSeek V4'")).firstMatch
            let model = menu.exists ? menu : button(app, beginning: "DeepSeek V4")
            #else
            let model = button(app, beginning: "DeepSeek V4")
            #endif
            note("model-\(s): \(describe(model))")
            if model.exists { model.tap(); settle(1.5) }
            shot("2b-model-menu-\(s)")
            tree(app, "model-menu-\(s)")
            app.terminate()
        }
    }

    // MARK: 2. execute → approve → stop → continue, pressed in the app

    func test3OperationChain() {
        let app = launch("compose", until: "DeepSeek", "chain-compose")
        type(app, "列出仓库根目录，并加一个 NOTES.md 记下你看到了什么", "chain-compose")
        shot("3a-compose-typed-light")
        send(app, "chain-send")
        // The created session opens in place; everything after this arrives over its live stream.
        must(app, "我先列一下", "chain-run", timeout: 30)
        shot("3b-running-light")
        let allow = button(app, beginning: "Allow")
        must(allow, "chain-allow-card")
        if allow.exists { bring(app, allow, between: 120, and: app.windows.firstMatch.frame.height - 120, missingIsAbove: false, "allow") }
        shot("4-approval-light")
        tree(app, "approval")
        if allow.exists, allow.isHittable { allow.tap() }
        must(app, "npm test", "chain-approved", timeout: 20)
        settle(1.5)
        shot("5-approved-running-light")
        let stop = stopButton(app)
        note("chain: stop \(describe(stop))")
        tree(app, "running")
        must(stop, "chain-stop-button")
        if stop.exists, stop.isHittable { stop.tap() }
        must(app, "Interrupted", "chain-stopped", timeout: 20)
        settle(1.5)
        shot("6-stopped-light")
        type(app, "继续：把 NOTES.md 再补一行测试命令", "chain-followup")
        send(app, "chain-followup-send")
        must(app, "已在 NOTES.md", "chain-resumed", timeout: 20)
        settle(1.5)
        shot("7-resumed-light")
        note("requests so far:\n" + requestsLog())
        // The chain is the app's own presses: each must have reached the stub as its request.
        expectRequest("\"POST /api/sessions HTTP", "chain-create")
        expectRequest("/api/sessions/S1/approvals/ap1/decision", "chain-approve")
        expectRequest("/api/sessions/S1/interrupt", "chain-stop")
        expectRequest("/api/sessions/S1/turns", "chain-continue")
        app.terminate()
    }

    /// A state the chain needs: fail (keeping the picture and the tree) if it never shows.
    func must(_ app: XCUIApplication, _ words: String, _ name: String, timeout: TimeInterval) {
        if !appears(app, words, timeout: timeout) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(words) never showed")
        }
    }

    func must(_ element: XCUIElement, _ name: String) {
        if !element.waitForExistence(timeout: 10) { XCTFail("\(name): not found") }
    }

    /// The same states in dark, set directly on the stub (no presses) — what each step looks like.
    func test4ChainStatesDark() {
        for (stage, until, name) in [("approval", "我先列一下", "4-approval-dark"),
                                     ("allowed", "npm test", "5-approved-running-dark"),
                                     ("stopped", "Interrupted", "6-stopped-dark"),
                                     ("resumed", "已在 NOTES.md", "7-resumed-dark")] {
            resetStub()
            setStub("{\"stage\": \"\(stage)\"}")
            let app = launch("console", dark: true, reset: false, fresh: true, until: until, name)
            if stage == "approval" {
                let allow = button(app, beginning: "Allow")
                if allow.exists { bring(app, allow, between: 120, and: app.windows.firstMatch.frame.height - 120, missingIsAbove: false, name) }
            }
            shot(name)
            app.terminate()
        }
    }

    // MARK: 3. what can't run, and how it says so

    func test5Unavailable() {
        for dark in [false, true] {
            let s = scheme(dark)
            for (session, until, name) in [("S3", "DeepSeek rejected", "8-invalid-key"),
                                           ("S6", "needs an API key", "8b-no-key"),
                                           ("S5", "isn't installed", "8c-not-installed"),
                                           ("S4", "newer runner", "8d-old-runner-queued")] {
                let app = launch("console", agent: session == "S4" ? "a2" : session == "S5" ? "a3" : "a1",
                                 session: session, dark: dark, until: until, "\(name)-\(s)")
                shot("\(name)-\(s)")
                if !dark { tree(app, name) }
                app.terminate()
            }
            for (agent, until, name) in [("a2", "Update runner", "9-picker-old-runner"),
                                         ("a3", "Not installed", "9b-picker-not-installed")] {
                let app = launch("compose", agent: agent, dark: dark, until: "DeepSeek", "\(name)-\(s)")
                shot("\(name)-hero-\(s)")
                let picker = providerButton(app)
                if picker.exists { picker.tap(); settle(2) }
                if !appears(app, until, timeout: 8) { XCTFail("\(name)-\(s): \(until) not shown") }
                shot("\(name)-\(s)")
                app.terminate()
            }
            resetStub()
            setStub("{\"keys\": \"none\"}")
            let app = launch("compose", dark: dark, reset: false, fresh: true, until: "deepseek-harness", "9c-picker-no-key-\(s)")
            let picker = providerButton(app)
            if picker.exists { picker.tap(); settle(2) }
            // The connect row comes last in the sheet, under the keys: scroll the sheet to it.
            let connect = containing(app, "Add API key")
            #if os(iOS)
            for _ in 0..<4 where !(connect.exists && connect.isHittable) {
                app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
                    .press(forDuration: 0.05, thenDragTo: app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)))
                settle(1)
            }
            #endif
            if !connect.waitForExistence(timeout: 8) { XCTFail("9c-\(s): Add API key not shown"); tree(app, "9c-\(s)") }
            shot("9c-picker-no-key-\(s)")
            app.terminate()
        }
    }
}
