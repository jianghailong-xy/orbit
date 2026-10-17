import XCTest

// TEMPORARY evidence probe (never merged): the provider/engine decoupling boards iOS 1, 2, 4 and 5
// (docs/mocks/provider-engine-decoupling/) on the iPhone app, against .t8-probe/stub.py — the account the
// boards draw. Every screen is reached with the app's own presses: Settings → Infrastructure, a machine's
// row, an engine's row, a key's row; the new-session hero's engine switch; the composer's model chip and
// its Provider row. Each screen is photographed in light and in dark, and the words the board puts on it
// are checked once they are on screen (a list only exposes the rows it shows): a word missing is a
// failure, with the element tree kept beside the picture.
final class T8ShotTests: ProbeCase {
    private func scheme(_ dark: Bool) -> String { dark ? "dark" : "light" }

    private func expectText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        var missing: [String] = []
        for text in words where !containing(app, text).exists { missing.append(text) }
        guard !missing.isEmpty else { return }
        XCTFail("\(name): nothing says \(missing.joined(separator: " | "))")
        write(app.debugDescription, "missing-text-\(name).txt")
    }

    private func expectAbsent(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for text in words where containing(app, text).exists {
            XCTFail("\(name): something still says \(text)")
        }
    }

    /// Wait for words that only show once a screen has its data; fail (keeping the tree) if they never do.
    private func must(_ app: XCUIApplication, _ words: String, _ name: String, timeout: TimeInterval = 30) {
        if !appears(app, words, timeout: timeout) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(words) never showed")
        }
    }

    /// A new session's draft focuses its input: lower the keyboard with a tap on the empty page above the
    /// hero, as a person would, so a sheet or a menu has the screen the board draws it on.
    private func lowerKeyboard(_ app: XCUIApplication, _ name: String) {
        for _ in 1...3 where app.keyboards.count > 0 {
            app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
            settle(1)
        }
        if app.keyboards.count > 0 { note("\(name): the keyboard stayed up") }
    }

    // MARK: board iOS 1 — the Infrastructure page, a machine's engines, DeepSeek Harness's page

    /// Settings, then its Infrastructure row, as a user opens the page.
    private func infrastructure(dark: Bool, _ name: String) -> XCUIApplication {
        let app = launch("settings", dark: dark, until: "Infrastructure", name)
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Infrastructure'")).firstMatch
        note("\(name): Settings row \(describe(row))")
        row.tap()
        must(app, Infrastructure.enginesTitle, "\(name)-page", timeout: 45)
        // The overview waits for every list to answer (InfrastructureLists.settled).
        must(app, "hpc ×2, old-mac, build-box", "\(name)-overview", timeout: 45)
        settle(2)
        return app
    }

    func test1InfrastructurePage() {
        for dark in [false, true] {
            let s = scheme(dark)
            let app = infrastructure(dark: dark, "infra-\(s)")
            expectText(app, ["Needs you", "is signed out on", "What your agents can run on", "Claude Code",
                             "Subscription", "hpc ×2, old-mac, build-box", "DeepSeek V4 Pro"], "infra-top-\(s)")
            shot("ios1-a-infrastructure-top-\(s)")
            tree(app, "infra-top-\(s)")

            // The rest of the overview: OpenCode and DeepSeek Harness under the four engines above them.
            let footer = containing(app, Infrastructure.enginesDetail)
            bring(app, footer, between: 560, and: 860, missingIsAbove: false, "overview-\(s)")
            expectText(app, ["Kimi Code", "Antigravity CLI", "OpenCode", "Own sign-in", "DeepSeek Harness",
                             "DeepSeek 2"], "infra-overview-\(s)")
            shot("ios1-b-infrastructure-overview-\(s)")
            tree(app, "infra-overview-\(s)")

            let machines = containing(app, "3 machines · 4 / 24 slots busy")
            bring(app, machines, between: 90, and: 220, missingIsAbove: false, "machines-\(s)")
            expectText(app, ["Machines", "hpc", "old-mac", "build-box"], "infra-machines-\(s)")
            shot("ios1-c-infrastructure-machines-\(s)")

            let keys = containing(app, ProvidersOverview.apiKeysDetail)
            bring(app, keys, between: 560, and: 860, missingIsAbove: false, "keys-\(s)")
            expectText(app, ["API keys", "DeepSeek", "DeepSeek 2", "Gemini", "Kimi (Moonshot)", "Z.AI (GLM)",
                             "Claude Max", "Claude Code · OpenCode · DeepSeek Harness", "Antigravity CLI · OpenCode",
                             "Kimi Code · OpenCode", "Claude Code · OpenCode", "Claude Code · subscription token",
                             "¥110.00", "¥36.20"], "infra-keys-\(s)")
            expectAbsent(app, ["Harness key", "Runs on"], "infra-keys-\(s)")
            shot("ios1-d-infrastructure-keys-\(s)")
            tree(app, "infra-keys-\(s)")

            // hpc's record: its Engines, DeepSeek Harness's row in its own mark.
            let hpcRow = button(app, beginning: "hpc")
            bring(app, hpcRow, between: 120, and: 700, missingIsAbove: true, "hpc-row-\(s)")
            note("machine-\(s): hpc row \(describe(hpcRow))")
            hpcRow.tap()
            // hpc's own page, by its title — not the overview behind it, which names the same engines.
            if !app.navigationBars["hpc"].waitForExistence(timeout: 30) {
                write(app.debugDescription, "missing-machine-\(s).txt")
                XCTFail("machine-\(s): hpc's page never opened")
            }
            settle(2)
            let dshRow = button(app, beginning: "DeepSeek Harness")
            bring(app, dshRow, between: 120, and: 760, missingIsAbove: false, "machine-dsh-row-\(s)")
            expectText(app, ["Claude Code", "Codex", "Kimi Code", "OpenCode", "Antigravity CLI", "DeepSeek Harness",
                             "Uses API keys"], "machine-\(s)")
            shot("ios1-e-machine-hpc-engines-\(s)")
            tree(app, "machine-\(s)")

            note("engine-\(s): DeepSeek Harness row \(describe(dshRow))")
            dshRow.tap()
            must(app, "each session uses the DeepSeek key it was started with", "dsh-engine-\(s)")
            expectText(app, ["Ready · each session uses the DeepSeek key it was started with",
                             "It has no sign-in: every session runs on a DeepSeek key."], "dsh-engine-\(s)")
            expectAbsent(app, ["Sign-ins live on this machine", "DeepSeek Harness API key"], "dsh-engine-\(s)")
            shot("ios1-f-deepseek-harness-engine-page-\(s)")
            tree(app, "dsh-engine-\(s)")
            app.terminate()
        }
    }

    // MARK: board iOS 2 — a DeepSeek key's page

    func test2DeepSeekKeyPage() {
        for dark in [false, true] {
            let s = scheme(dark)
            let app = infrastructure(dark: dark, "key-\(s)")
            let keys = containing(app, ProvidersOverview.apiKeysDetail)
            bring(app, keys, between: 560, and: 860, missingIsAbove: false, "key-rows-\(s)")
            // The first DeepSeek key's row: its name, then its model, its engines and its balance.
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'DeepSeek' AND label CONTAINS '110.00'"))
                .firstMatch
            note("key-\(s): row \(describe(row))")
            (row.exists ? row : button(app, beginning: "DeepSeek")).tap()
            must(app, "DeepSeek account balance", "key-page-\(s)")
            must(app, "110.00", "key-balance-\(s)")
            settle(1.5)
            shot("ios2-a-deepseek-key-top-\(s)")
            tree(app, "key-top-\(s)")

            let footer = containing(app, "Turning it off there stops it on")
            bring(app, footer, between: 420, and: 860, missingIsAbove: false, "key-footer-\(s)")
            expectText(app, ["Works with", "Claude Code", "OpenCode", "DeepSeek Harness",
                             "Pick it for a session on any of these in the composer's model menu → Provider.",
                             "Key", "Protocol", "Anthropic-compatible", "Default model", "DeepSeek V4 Pro", "Endpoint",
                             "api.deepseek.com",
                             "Adding or changing a key happens on the web. Turning it off there stops it on Claude Code, OpenCode and DeepSeek Harness."],
                       "key-rest-\(s)")
            expectAbsent(app, ["Runs on"], "key-rest-\(s)")
            shot("ios2-b-deepseek-key-works-with-\(s)")
            tree(app, "key-rest-\(s)")
            app.terminate()
        }
    }

    // MARK: board iOS 4 — a new session: the engine, then a provider of it

    /// A new session for orbit, its keyboard lowered.
    private func compose(dark: Bool, reset: Bool = true, _ name: String) -> XCUIApplication {
        let app = launch("compose", dark: dark, reset: reset, fresh: true, until: "Engine:", name)
        lowerKeyboard(app, name)
        return app
    }

    /// The hero's engine switch: "Engine: Claude Code. Switch".
    private func engineSwitch(_ app: XCUIApplication) -> XCUIElement {
        button(app, beginning: "Engine:")
    }

    private func openEngineSheet(_ app: XCUIApplication, _ name: String) {
        let hero = engineSwitch(app)
        note("\(name): hero \(describe(hero))")
        guard hero.waitForExistence(timeout: 20) else { XCTFail("\(name): no engine switch on the hero"); return }
        hero.tap()
        if !app.navigationBars["Engine"].waitForExistence(timeout: 15) {
            write(app.debugDescription, "missing-\(name)-sheet.txt")
            XCTFail("\(name): the Engine sheet never opened")
        }
        settle(1.2)
    }

    /// An engine's row on the hero's sheet. A mark drawn as a letter tile is read before the name
    /// ("O, OpenCode, Managed by OpenCode"), so the row is found by the name wherever it stands.
    private func sheetRow(_ app: XCUIApplication, _ engine: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "(label BEGINSWITH %@ OR label CONTAINS %@) AND NOT (label BEGINSWITH 'Engine:')",
                                         engine, ", \(engine),")).firstMatch
    }

    /// Pick an engine on the hero's sheet; the sheet closes on the press.
    private func pickEngine(_ app: XCUIApplication, _ engine: String, _ name: String) {
        openEngineSheet(app, name)
        let row = sheetRow(app, engine)
        note("\(name): \(engine) row \(describe(row))")
        guard row.exists else { XCTFail("\(name): the sheet has no \(engine) row"); tree(app, name); return }
        row.tap()
        if !containing(app, "Engine: \(engine)").waitForExistence(timeout: 10) {
            write(app.debugDescription, "missing-picked-\(name).txt")
            XCTFail("\(name): the hero never moved to \(engine)")
        }
        settle(1.2)
        lowerKeyboard(app, name)
    }

    /// The composer's model chip ("Model Opus 5.5, effort Default"), then its Provider row — pressed again
    /// until the submenu shows `inside`, words only it holds (a press that lands while the menu is still
    /// opening is lost).
    private func openProviderMenu(_ app: XCUIApplication, title: String, inside: String, _ name: String) {
        let chip = button(app, beginning: "Model ")
        note("\(name): chip \(describe(chip))")
        guard chip.waitForExistence(timeout: 20) else { XCTFail("\(name): no model chip"); tree(app, name); return }
        chip.tap()
        let providerRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Provider'")).firstMatch
        guard providerRow.waitForExistence(timeout: 8) else {
            XCTFail("\(name): the model menu has no Provider row"); tree(app, name); return
        }
        settle(1)
        // The menu's title is the engine this draft or session runs on (board iOS 5 ③).
        expectText(app, [title], "\(name)-title")
        note("\(name): Provider row \(describe(providerRow))")
        for attempt in 1...3 {
            providerRow.tap()
            if containing(app, inside).waitForExistence(timeout: 4) {
                note("\(name): submenu open after \(attempt) press(es)")
                break
            }
            note("\(name): press \(attempt) opened no submenu")
            if !providerRow.exists { chip.tap(); _ = providerRow.waitForExistence(timeout: 5) }
        }
        settle(1.5)
    }

    func test3EngineSheet() {
        for dark in [false, true] {
            let s = scheme(dark)
            let app = compose(dark: dark, "sheet-\(s)")
            // Board 4 ① after: the draft on DeepSeek Harness, every engine by its CLI's name.
            pickEngine(app, "DeepSeek Harness", "sheet-pick-\(s)")
            openEngineSheet(app, "sheet-\(s)")
            expectText(app, ["Claude Code", "Codex", "Kimi Code", "Antigravity CLI", "OpenCode", "DeepSeek Harness",
                             "Opus 5.5", "gpt-5.6-sol", "Gemini 3.8 Flash", "Managed by OpenCode", "DeepSeek V4 Pro"],
                       "sheet-\(s)")
            shot("ios4-a-engine-sheet-\(s)")
            tree(app, "sheet-\(s)")
            // The sheet opens at its medium height; pulled up, it shows its footer and its note.
            let bar = app.navigationBars["Engine"]
            if bar.exists {
                let from = bar.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5))
                from.press(forDuration: 0.1, thenDragTo: from.withOffset(CGVector(dx: 0, dy: -420)),
                           withVelocity: .slow, thenHoldForDuration: 0.4)
                settle(1.5)
            }
            expectText(app, ["Pick the provider and account in the composer's model menu.",
                             "Switching is remembered as orbit's default."], "sheet-large-\(s)")
            shot("ios4-a2-engine-sheet-large-\(s)")
            app.terminate()

            // Board 4 ② after: no DeepSeek key — DeepSeek Harness's row says how to connect one.
            setStub(#"{"keys": "nodeepseek"}"#)
            let bare = compose(dark: dark, reset: false, "sheet-nokey-\(s)")
            openEngineSheet(bare, "sheet-nokey-\(s)")
            expectText(bare, ["DeepSeek Harness", "Connect a DeepSeek key"], "sheet-nokey-\(s)")
            shot("ios4-b-engine-sheet-no-deepseek-key-\(s)")
            tree(bare, "sheet-nokey-\(s)")
            bare.terminate()
        }
    }

    func test4ProviderMenus() {
        for dark in [false, true] {
            let s = scheme(dark)
            // Board 4 ④: Claude Code — the sign-in on hpc and its accounts, the pool, the keys it runs. The
            // board draws Default picked: pick it, as a person does, then open the menu again.
            let claude = compose(dark: dark, "menu-claude-\(s)")
            openProviderMenu(claude, title: "Claude Code", inside: "Signed in on hpc", "menu-claude-pick-\(s)")
            let defaultRow = button(claude, beginning: "Default")
            note("menu-claude-pick-\(s): Default row \(describe(defaultRow))")
            if defaultRow.exists { defaultRow.tap(); settle(1.5) } else { XCTFail("menu-claude-pick-\(s): no Default row") }
            openProviderMenu(claude, title: "Claude Code", inside: "Signed in on hpc", "menu-claude-\(s)")
            // The menu runs to the screen's bottom edge: its last keys are in the tree, under it. A menu breaks a
            // name after a dot with a zero-width space (`ComposerView.menuBreakable`) — "Z.\u{200B}AI (GLM)" —
            // so that name is matched past the dot.
            expectText(claude, ["Signed in on hpc", "Automatic", "Default", "Work", "Account pools", "Claude accounts",
                                "API keys", "DeepSeek", "DeepSeek 2", "AI (GLM)", "Claude Max"], "menu-claude-\(s)")
            expectAbsent(claude, ["Gemini", "Kimi (Moonshot)"], "menu-claude-\(s)")
            for key in ["AI (GLM)", "Claude Max"] { note("menu-claude-\(s): \(describe(containing(claude, key)))") }
            shot("ios4-d-provider-claude-code-\(s)")
            tree(claude, "menu-claude-\(s)")
            claude.terminate()

            // Board 4 ③: DeepSeek Harness — its two DeepSeek keys, nothing else.
            let dsh = compose(dark: dark, "menu-dsh-\(s)")
            pickEngine(dsh, "DeepSeek Harness", "menu-dsh-pick-\(s)")
            openProviderMenu(dsh, title: "DeepSeek Harness", inside: "API keys", "menu-dsh-\(s)")
            expectText(dsh, ["API keys", "DeepSeek", "DeepSeek 2"], "menu-dsh-\(s)")
            expectAbsent(dsh, ["AI (GLM)", "Claude Max", "Signed in on"], "menu-dsh-\(s)")
            shot("ios4-c-provider-deepseek-harness-\(s)")
            tree(dsh, "menu-dsh-\(s)")
            dsh.terminate()

            // Board 4 ⑤: OpenCode — its own sign-in on hpc, every key it runs, and why Claude Max isn't there.
            let openCode = compose(dark: dark, "menu-opencode-\(s)")
            pickEngine(openCode, "OpenCode", "menu-opencode-pick-\(s)")
            openProviderMenu(openCode, title: "OpenCode", inside: "On hpc", "menu-opencode-\(s)")
            expectText(openCode, ["On hpc", "OpenCode's own sign-in", "API keys", "DeepSeek", "DeepSeek 2", "Gemini",
                                  "Kimi (Moonshot)", "AI (GLM)", "a subscription token runs on Claude Code only."],
                       "menu-opencode-\(s)")
            note("menu-opencode-\(s): \(describe(containing(openCode, "a subscription token runs on Claude Code only.")))")
            shot("ios4-e-provider-opencode-\(s)")
            tree(openCode, "menu-opencode-\(s)")
            openCode.terminate()
        }
    }

    // MARK: board iOS 5 — switching the provider in a session

    func test5SessionProviderMenus() {
        for dark in [false, true] {
            let s = scheme(dark)
            // ① A DeepSeek Harness session: its engine's credentials only, the menu titled by its engine.
            let app = launch("console", session: "S1", dark: dark, until: "Model DeepSeek V4 Pro", "session-\(s)")
            must(app, "the two duplicate entries are gone", "session-transcript-\(s)")
            openProviderMenu(app, title: "DeepSeek Harness", inside: "API keys", "session-menu-\(s)")
            expectText(app, ["API keys", "DeepSeek", "DeepSeek 2"], "session-menu-\(s)")
            expectAbsent(app, ["Claude Max", "AI (GLM)", "→"], "session-menu-\(s)")
            shot("ios5-a-session-provider-deepseek-harness-\(s)")
            tree(app, "session-menu-\(s)")
            app.terminate()

            // ④ Its key deleted: the engine stays; the key leads, Deleted; a DeepSeek key fixes it.
            let gone = launch("console", session: "S4", dark: dark, until: "Model DeepSeek V4 Pro", "gone-\(s)")
            must(gone, "A fix is on the branch.", "gone-transcript-\(s)")
            openProviderMenu(gone, title: "DeepSeek Harness", inside: "This session's key", "gone-menu-\(s)")
            // Its row is read by the key's name alone ("deepseek-harness": a deleted key keeps no label);
            // "Deleted" is drawn under it.
            expectText(gone, ["Key deleted", "This session's key", "deepseek-harness", "API keys", "DeepSeek",
                              "DeepSeek 2"], "gone-menu-\(s)")
            expectAbsent(gone, ["Claude Code", "Claude Max", "Signed in on"], "gone-menu-\(s)")
            shot("ios5-b-session-key-deleted-\(s)")
            tree(gone, "gone-menu-\(s)")
            gone.terminate()
        }
    }
}

/// The words the tests wait on, as OrbitKit's `Infrastructure` and `ProvidersOverview` say them.
private enum Infrastructure {
    static let enginesTitle = "What your agents can run on"
    static let enginesDetail = "Every engine, and everything that can pay for it right now."
}

private enum ProvidersOverview {
    static let apiKeysDetail = "On your account and usable from every machine — billed per token."
}
