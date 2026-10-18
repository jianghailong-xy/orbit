import XCTest

// TEMPORARY evidence probe (never merged): the Cursor CLI boards iOS 1-6 (docs/mocks/cursor-engine/) on the
// iPhone app, against .p7b-probe/stub.py — the account the boards draw. Every screen is reached with the app's
// own presses: Settings → Infrastructure, a machine's row, Cursor CLI's row, an account's long press, a key's
// row; the new-session hero's engine switch; the composer's mode menu, model chip and its Provider row; the
// context ring. Each screen is photographed in light and in dark, and the words the board puts on it are
// checked once they are on screen (a list only exposes the rows it shows): a word missing is a failure, with
// the element tree kept beside the picture.
final class CursorShotTests: ProbeCase {
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

    // MARK: Settings → Infrastructure → a machine → Cursor CLI

    /// Settings, then its Infrastructure row, as a user opens the page. The row is below the sheet's fold, and
    /// a list only has the rows it shows: the sheet is dragged until it is there.
    private func infrastructure(dark: Bool, reset: Bool = true, _ name: String) -> XCUIApplication {
        let app = launch("settings", dark: dark, reset: reset, until: "Default permission", orPress: "Settings", name)
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Infrastructure'")).firstMatch
        bring(app, row, between: 150, and: 780, missingIsAbove: false, "\(name)-settings-row")
        note("\(name): Settings row \(describe(row))")
        row.tap()
        must(app, "What your agents can run on", "\(name)-page", timeout: 45)
        // The overview waits for every list to answer (InfrastructureLists.settled).
        must(app, "Cursor CLI", "\(name)-overview", timeout: 45)
        settle(2)
        return app
    }

    /// A machine's own page, from its row under Machines.
    private func openMachine(_ app: XCUIApplication, _ machine: String, _ name: String) {
        let row = button(app, beginning: machine)
        bring(app, row, between: 120, and: 700, missingIsAbove: false, "\(name)-row")
        note("\(name): \(machine) row \(describe(row))")
        row.tap()
        if !app.navigationBars[machine].waitForExistence(timeout: 30) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(machine)'s page never opened")
        }
        settle(2)
    }

    /// A machine's page — and an engine's on it — opened straight from launch, as a link into Settings opens
    /// it (the tapped way there is test2's first visit).
    private func machinePage(_ machine: String, engine: String? = nil, dark: Bool, title: String,
                             _ name: String) -> XCUIApplication {
        let app = launch("settings", dark: dark,
                         extra: ["-probe.machine", machine] + (engine.map { ["-probe.engine", $0] } ?? []),
                         until: "Cursor CLI", name)
        if !app.navigationBars[title].waitForExistence(timeout: 30) {
            write(app.debugDescription, "missing-\(name)-page.txt")
            XCTFail("\(name): \(title)'s page never opened")
        }
        settle(2)
        return app
    }

    /// Cursor CLI's row on a machine's page — the last of its Engines — brought into view.
    private func cursorRow(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH 'Cursor CLI' AND NOT (label BEGINSWITH 'Cursor CLI is')"))
            .firstMatch
        bring(app, row, between: 120, and: 760, missingIsAbove: false, "\(name)-cursor")
        note("\(name): Cursor CLI row \(describe(row))")
        return row
    }

    // MARK: a new session

    /// A new session for `agent`, its keyboard lowered.
    private func compose(_ agent: String = "a1", dark: Bool, reset: Bool = true, _ name: String) -> XCUIApplication {
        let app = launch("compose", agent: agent, dark: dark, reset: reset, fresh: true, until: "Engine:", name)
        lowerKeyboard(app, name)
        return app
    }

    private func openEngineSheet(_ app: XCUIApplication, _ name: String) {
        let hero = button(app, beginning: "Engine:")
        note("\(name): hero \(describe(hero))")
        guard hero.waitForExistence(timeout: 20) else { XCTFail("\(name): no engine switch on the hero"); return }
        hero.tap()
        if !app.navigationBars["Engine"].waitForExistence(timeout: 15) {
            write(app.debugDescription, "missing-\(name)-sheet.txt")
            XCTFail("\(name): the Engine sheet never opened")
        }
        settle(1.2)
    }

    /// The sheet opens at its medium height; pulled up, its last rows and its footer show.
    private func raiseSheet(_ app: XCUIApplication) {
        let bar = app.navigationBars["Engine"]
        guard bar.exists else { return }
        let from = bar.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5))
        from.press(forDuration: 0.1, thenDragTo: from.withOffset(CGVector(dx: 0, dy: -420)),
                   withVelocity: .slow, thenHoldForDuration: 0.4)
        settle(1.5)
    }

    /// Cursor CLI's row on the hero's sheet.
    private func sheetRow(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "(label BEGINSWITH 'Cursor CLI' OR label CONTAINS ', Cursor CLI') AND NOT (label BEGINSWITH 'Engine:')"))
            .firstMatch
    }

    private func pickCursor(_ app: XCUIApplication, _ name: String) {
        openEngineSheet(app, name)
        raiseSheet(app)
        let row = sheetRow(app)
        note("\(name): Cursor CLI row \(describe(row))")
        guard row.exists else { XCTFail("\(name): the sheet has no Cursor CLI row"); tree(app, name); return }
        row.tap()
        if !containing(app, "Engine: Cursor CLI").waitForExistence(timeout: 10) {
            write(app.debugDescription, "missing-picked-\(name).txt")
            XCTFail("\(name): the hero never moved to Cursor CLI")
        }
        settle(1.5)
        lowerKeyboard(app, name)
    }

    // MARK: the composer's menus

    /// The composer's model chip ("Model Auto"), opened — pressed again until the menu shows `inside`.
    private func openModelMenu(_ app: XCUIApplication, inside: String, _ name: String) {
        let chip = button(app, beginning: "Model ")
        note("\(name): chip \(describe(chip))")
        guard chip.waitForExistence(timeout: 20) else { XCTFail("\(name): no model chip"); tree(app, name); return }
        for attempt in 1...3 {
            chip.tap()
            if containing(app, inside).waitForExistence(timeout: 5) {
                note("\(name): menu open after \(attempt) press(es)")
                break
            }
            note("\(name): press \(attempt) opened no menu")
        }
        settle(1.5)
    }

    /// The model chip's Provider row, pressed again until its submenu shows `inside`.
    private func openProviderMenu(_ app: XCUIApplication, inside: String, _ name: String) {
        openModelMenu(app, inside: "Provider", name)
        expectText(app, ["Cursor CLI"], "\(name)-title")
        let providerRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Provider'")).firstMatch
        note("\(name): Provider row \(describe(providerRow))")
        for attempt in 1...3 {
            providerRow.tap()
            if containing(app, inside).waitForExistence(timeout: 4) {
                note("\(name): submenu open after \(attempt) press(es)")
                break
            }
            note("\(name): press \(attempt) opened no submenu")
            if !providerRow.exists { button(app, beginning: "Model ").tap(); _ = providerRow.waitForExistence(timeout: 5) }
        }
        settle(1.5)
    }

    /// Whether `element` is wholly on the screen, not past its foot.
    private func onScreen(_ app: XCUIApplication, _ element: XCUIElement) -> Bool {
        let screen = app.windows.firstMatch.frame
        return element.exists && element.frame.minY >= screen.minY && element.frame.maxY <= screen.maxY - 30
    }

    /// A menu taller than the room it has scrolls as a finger scrolls it: pressed on a row that can't be picked
    /// and dragged up, lifting above the menu, so nothing is picked.
    private func dragMenuUp(_ app: XCUIApplication, from row: XCUIElement, by distance: CGFloat, _ name: String) {
        guard row.exists else { note("\(name): no row to drag the menu by"); return }
        let start = row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -distance)),
                    withVelocity: .slow, thenHoldForDuration: 0.3)
        settle(1.2)
    }

    // MARK: board iOS 1 — the Engine sheet's seventh row, the hero, the four ways it can't run

    func test1NewSession() {
        for dark in [false, true] {
            let s = scheme(dark)
            let app = compose(dark: dark, "sheet-\(s)")
            openEngineSheet(app, "sheet-\(s)")
            raiseSheet(app)
            expectText(app, ["Claude Code", "Codex", "Kimi Code", "Antigravity CLI", "OpenCode", "DeepSeek Harness",
                             "Cursor CLI", "Auto", "Pick the provider and account in the composer's model menu."],
                       "sheet-\(s)")
            shot("ios1-a-engine-sheet-\(s)")
            tree(app, "sheet-\(s)")
            let row = sheetRow(app)
            row.tap()
            if !containing(app, "Engine: Cursor CLI").waitForExistence(timeout: 10) {
                XCTFail("hero-\(s): the hero never moved to Cursor CLI")
            }
            settle(1.5)
            lowerKeyboard(app, "hero-\(s)")
            expectText(app, ["Cursor CLI", "Send a task to get started.", "Auto"], "hero-\(s)")
            note("hero-\(s): mode \(describe(app.buttons.matching(NSPredicate(format: "label IN {'Accept Edits', 'Auto'}")).firstMatch))")
            shot("ios1-b-hero-cursor-\(s)")
            tree(app, "hero-\(s)")
            app.terminate()

            // The four ways a machine can't run it, each on the workspace there: the reason under the name.
            for (agent, words, file) in [("a2", "Not installed →", "ios1-c-row-not-installed"),
                                         ("a5", "Not signed in, sign in →", "ios1-d-row-signed-out"),
                                         ("a3", "Update runner →", "ios1-e-row-update-runner"),
                                         ("a4", "Unsupported version →", "ios1-f-row-unsupported-version")] {
                // Signed out with no Cursor key to land on instead (the board's "no Cursor key").
                if agent == "a5" { resetStub(); setStub(#"{"keys": "nocursor"}"#) }
                let state = compose(agent, dark: dark, reset: agent != "a5", "\(file)-\(s)")
                openEngineSheet(state, "\(file)-\(s)")
                raiseSheet(state)
                let cursor = sheetRow(state)
                note("\(file)-\(s): \(describe(cursor))")
                expectText(state, [words], "\(file)-\(s)")
                shot(cursor, "\(file)-\(s)")
                shot("\(file)-sheet-\(s)")
                state.terminate()
            }
        }
    }

    // MARK: board iOS 2 — Infrastructure, a machine's Cursor CLI row, its page, its four states

    func test2Infrastructure() {
        for dark in [false, true] {
            let s = scheme(dark)
            let app = infrastructure(dark: dark, "infra-\(s)")
            let footer = containing(app, "Every engine, and everything that can pay for it right now.")
            bring(app, footer, between: 560, and: 860, missingIsAbove: false, "overview-\(s)")
            expectText(app, ["Cursor CLI", "Subscription", "hpc ×2", "API key", "Auto"], "overview-\(s)")
            shot("ios2-a-infrastructure-cursor-card-\(s)")
            tree(app, "overview-\(s)")

            openMachine(app, "hpc", "machine-\(s)")
            _ = cursorRow(app, "machine-\(s)")
            let pinned = containing(app, "Cursor CLI stays on the version Orbit pins")
            bring(app, pinned, between: 400, and: 860, missingIsAbove: false, "machine-footer-\(s)")
            expectText(app, ["Cursor CLI", "2026.10.14-941492e", "2 accounts signed in", "Next: Team", "Monthly limit",
                             "Cursor CLI stays on the version Orbit pins"], "machine-\(s)")
            shot("ios2-b-machine-hpc-cursor-row-\(s)")
            tree(app, "machine-\(s)")

            let row = cursorRow(app, "machine-open-\(s)")
            row.tap()
            if !app.navigationBars["Cursor CLI"].waitForExistence(timeout: 20) {
                write(app.debugDescription, "missing-engine-\(s).txt")
                XCTFail("engine-\(s): Cursor CLI's page never opened")
            }
            must(app, "Usage unavailable", "engine-\(s)")
            settle(1.5)
            expectText(app, ["2026.10.14-941492e", "pinned · checked", "Accounts", "Default", "Free plan",
                             "~/.orbit/cursor/default", "Usage unavailable", "Team", "NEXT", "Pro plan", "Monthly limit",
                             "Add Account"], "engine-\(s)")
            expectAbsent(app, ["Update Engines Now"], "engine-\(s)")
            shot("ios2-c-cursor-engine-page-\(s)")
            let pageFooter = containing(app, "Orbit keeps Cursor CLI on the version it pins")
            bring(app, pageFooter, between: 300, and: 860, missingIsAbove: false, "engine-footer-\(s)")
            shot("ios2-c2-cursor-engine-page-footer-\(s)")
            tree(app, "engine-\(s)")
            app.terminate()

            // The four states, each on its machine's page: the row, and what it says.
            for (machine, words, file) in [("build-box", "Not installed", "ios2-d-state-not-installed"),
                                           ("lab", "Signed out", "ios2-e-state-signed-out"),
                                           ("mac-studio", "This runner predates Cursor CLI", "ios2-f-state-update-runner"),
                                           ("gpu-box", "Unsupported version", "ios2-g-state-unsupported-version")] {
                let page = machinePage(machine, dark: dark, title: machine, "\(file)-\(s)")
                let state = cursorRow(page, file)
                expectText(page, [words], "\(file)-\(s)")
                shot(state, "\(file)-\(s)")
                shot("\(file)-page-\(s)")
                tree(page, "\(file)-\(s)")
                if machine == "build-box" || machine == "gpu-box" {
                    // Install / Reinstall live on its page.
                    state.tap()
                    if page.navigationBars["Cursor CLI"].waitForExistence(timeout: 10) {
                        settle(1.5)
                        expectText(page, [machine == "build-box" ? "Install Cursor CLI" : "Reinstall Cursor CLI"],
                                   "\(file)-engine-\(s)")
                        shot("\(file)-engine-page-\(s)")
                    } else {
                        note("\(file)-\(s): the row opened no page")
                    }
                }
                page.terminate()
            }
        }
    }

    // MARK: board iOS 3 — Add Account, Sign In Again, Remove

    private func enginePage(dark: Bool, _ name: String) -> XCUIApplication {
        let app = machinePage("hpc", engine: "cursor", dark: dark, title: "Cursor CLI", name)
        must(app, "Add Account", name)
        settle(1)
        return app
    }

    func test3Accounts() {
        for dark in [false, true] {
            let s = scheme(dark)
            let app = enginePage(dark: dark, "add-\(s)")
            let add = button(app, beginning: "Add Account")
            bring(app, add, between: 300, and: 760, missingIsAbove: false, "add-button-\(s)")
            add.tap()
            // The name the page picked, replaced as a person types one; the sign-in starts with the press.
            let field = app.textFields.firstMatch
            if field.waitForExistence(timeout: 10) {
                // At the field's far end, so the deletes take the whole picked name.
                field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 16) + "Work")
                note("add-\(s): name field \(describe(field))")
            } else {
                XCTFail("add-\(s): no name field")
            }
            lowerKeyboard(app, "add-\(s)")
            must(app, "Starting sign-in on the runner…", "add-pending-\(s)", timeout: 15)
            settle(1)
            shot("ios3-a-add-pending-\(s)")
            tree(app, "add-pending-\(s)")
            // The runner checks in: the stub hands over Cursor's link.
            setStub(#"{"login": "link"}"#)
            must(app, "Open cursor.com", "add-link-\(s)", timeout: 20)
            settle(1)
            expectText(app, ["Sign in on cursor.com with the account you are adding:", "Open cursor.com",
                             "Copy Sign-In Link", "Waiting for you to sign in…", "link expires in"], "add-link-\(s)")
            shot("ios3-b-add-link-\(s)")
            tree(app, "add-link-\(s)")

            setStub(#"{"login": "expire"}"#)
            must(app, "Get a New Link", "add-expired-\(s)", timeout: 20)
            settle(1)
            expectText(app, ["The sign-in link expired before anyone signed in with it.", "Get a New Link"],
                       "add-expired-\(s)")
            shot("ios3-c-add-expired-\(s)")

            button(app, beginning: "Get a New Link").tap()
            must(app, "Open cursor.com", "add-relink-\(s)", timeout: 20)
            setStub(#"{"login": "approve"}"#)
            // Signed in: the card folds into Add Account, the new account a row of its own.
            if !appears(app, "Pro plan · ~/.orbit/cursor-accounts/9b1f3c20", timeout: 40) {
                XCTFail("add-done-\(s): the new account never showed")
            }
            settle(3)
            let work = containing(app, "~/.orbit/cursor-accounts/9b1f3c20")
            bring(app, work, between: 200, and: 700, missingIsAbove: false, "add-done-\(s)")
            expectText(app, ["Work", "Monthly limit", "3%"], "add-done-\(s)")
            shot("ios3-d-add-done-\(s)")
            tree(app, "add-done-\(s)")
            app.terminate()

            // Team's long press: Rename…, Sign In Again, Pause…, Remove….
            let menu = enginePage(dark: dark, "menu-\(s)")
            let team = menu.staticTexts.matching(NSPredicate(format: "label == 'Team'")).firstMatch
            bring(menu, team, between: 200, and: 600, missingIsAbove: false, "menu-team-\(s)")
            team.press(forDuration: 1.3)
            must(menu, "Sign In Again", "menu-\(s)", timeout: 10)
            settle(1)
            expectText(menu, ["Rename…", "Sign In Again", "Pause…", "Remove…"], "menu-\(s)")
            shot("ios3-e-team-menu-\(s)")
            setStub(#"{"login": "link"}"#)
            button(menu, beginning: "Sign In Again").tap()
            must(menu, "with this account again:", "resign-\(s)", timeout: 25)
            settle(1)
            expectText(menu, ["Sign in on cursor.com with this account again:", "Open cursor.com", "Copy Sign-In Link",
                              "link expires in"], "resign-\(s)")
            shot("ios3-f-sign-in-again-link-\(s)")
            button(menu, beginning: "Cancel").tap()
            settle(1.5)

            // Remove… asks first, then the runner refuses: Team is in use.
            team.press(forDuration: 1.3)
            must(menu, "Remove…", "remove-menu-\(s)", timeout: 10)
            button(menu, beginning: "Remove…").tap()
            must(menu, "from hpc?", "remove-confirm-\(s)", timeout: 10)
            settle(1)
            expectText(menu, ["Remove “Team” from hpc?", "Default is untouched."], "remove-confirm-\(s)")
            shot("ios3-g-remove-confirm-\(s)")
            let confirm = menu.buttons.matching(NSPredicate(format: "label == 'Remove'")).firstMatch
            note("remove-\(s): confirm \(describe(confirm))")
            confirm.tap()
            must(menu, "Team is in use", "remove-refused-\(s)", timeout: 25)
            settle(2)
            expectText(menu, ["Team is in use: 2 sessions on hpc are running on it."], "remove-refused-\(s)")
            shot("ios3-h-remove-refused-\(s)")
            tree(menu, "remove-refused-\(s)")
            menu.terminate()
        }
    }

    // MARK: board iOS 4 — the API keys, a Cursor key's page, accepted and refused

    func test4Keys() {
        for dark in [false, true] {
            let s = scheme(dark)
            let app = infrastructure(dark: dark, "keys-\(s)")
            let keysFooter = containing(app, "On your account and usable from every machine")
            bring(app, keysFooter, between: 560, and: 860, missingIsAbove: false, "keys-\(s)")
            expectText(app, ["API keys", "Cursor", "Cursor 2", "Rejected", "Cursor CLI"], "keys-\(s)")
            shot("ios4-a-api-keys-\(s)")
            tree(app, "keys-\(s)")

            let valid = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Cursor,'")).firstMatch
            note("keys-\(s): Cursor row \(describe(valid))")
            valid.tap()
            must(app, "Last check", "key-valid-\(s)")
            settle(1.5)
            expectText(app, ["Works with", "Cursor CLI", "Billed to this key’s Cursor plan", "It runs no other engine.",
                             "Last check", "Valid", "A runner with Cursor CLI checks the key with Cursor",
                             "Protocol", "Cursor API", "Default model", "Auto", "Endpoint", "api2.cursor.sh",
                             "Adding or changing a key happens on the web."], "key-valid-\(s)")
            expectAbsent(app, ["Check Again"], "key-valid-\(s)")
            shot("ios4-b-cursor-key-valid-\(s)")
            tree(app, "key-valid-\(s)")
            app.terminate()

            let list = infrastructure(dark: dark, "keys2-\(s)")
            let refused = list.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Cursor 2'")).firstMatch
            bring(list, refused, between: 200, and: 760, missingIsAbove: false, "keys2-\(s)")
            note("keys-\(s): Cursor 2 row \(describe(refused))")
            refused.tap()
            must(list, "Check Again", "key-refused-\(s)")
            settle(1.5)
            expectText(list, ["Rejected", "Check Again", "The provided API key is invalid."], "key-refused-\(s)")
            shot("ios4-c-cursor-key-rejected-\(s)")
            tree(list, "key-refused-\(s)")
            // Check Again asks the server again (the stub's runner still says it is refused).
            button(list, beginning: "Check Again").tap()
            settle(2)
            expectRequest("POST /api/providers/mine/p-cur2/key-check", "key-recheck-\(s)")
            shot("ios4-d-cursor-key-checked-again-\(s)")
            list.terminate()
        }
    }

    // MARK: board iOS 5 — the model menu, a turn running, Context, the usage limit

    func test5Session() {
        for dark in [false, true] {
            let s = scheme(dark)
            let auto = launch("console", session: "C1", dark: dark, until: "Model Auto", "auto-\(s)")
            if !appears(auto, "pinned the test clock to UTC", timeout: 20) { note("auto-\(s): the answer never showed") }
            openModelMenu(auto, inside: "Provider", "auto-menu-\(s)")
            expectText(auto, ["Cursor CLI", "Provider", "Auto", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-5.5",
                              "Composer 2.5", "Auto picks a model for each request."], "auto-menu-\(s)")
            expectAbsent(auto, ["Effort"], "auto-menu-\(s)")
            shot("ios5-a-model-menu-auto-\(s)")
            tree(auto, "auto-menu-\(s)")
            auto.terminate()

            // Claude Opus 5.5 at 1M and Fast: the chip says so, and the menu has Context and Speed under Effort.
            let opus = launch("console", session: "C2", dark: dark, until: "Model Claude Opus 5.5", "opus-\(s)")
            expectText(opus, ["Model Claude Opus 5.5, effort High, 1M, Fast"], "opus-chip-\(s)")
            shot("ios5-b0-chip-opus-\(s)")
            openModelMenu(opus, inside: "Effort", "opus-menu-\(s)")
            expectText(opus, ["Cursor CLI", "Claude Opus 5.5", "Effort", "Context", "Speed"], "opus-menu-\(s)")
            shot("ios5-b-model-menu-opus-\(s)")
            tree(opus, "opus-menu-\(s)")
            // With the board's seven models the menu runs past the screen's foot: Effort, Context and Speed are a
            // scroll down.
            let speed = opus.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Speed'")).firstMatch
            note("opus-menu-\(s): Speed \(describe(speed))")
            if !onScreen(opus, speed) {
                let title = opus.buttons.matching(NSPredicate(format: "label == 'Cursor CLI'")).firstMatch
                dragMenuUp(opus, from: title, by: 260, "opus-scroll-\(s)")
                note("opus-scroll-\(s): Speed after the drag \(describe(speed))")
            }
            if onScreen(opus, speed) {
                shot("ios5-b1-model-menu-opus-scrolled-\(s)")
            } else {
                note("opus-scroll-\(s): the menu did not scroll")
            }
            opus.terminate()

            // The runner listing three models: the menu ends on Effort, Context and Speed, on the screen, and
            // Auto's note is whole.
            resetStub()
            setStub(#"{"catalog": "short"}"#)
            let short = launch("console", session: "C2", dark: dark, reset: false, fresh: true,
                               until: "Model Claude Opus 5.5", "opus-short-\(s)")
            openModelMenu(short, inside: "Effort", "opus-short-menu-\(s)")
            expectText(short, ["Effort, High", "Context, 1M", "Speed, Fast"], "opus-short-menu-\(s)")
            let shortSpeed = short.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Speed'")).firstMatch
            if !onScreen(short, shortSpeed) { XCTFail("opus-short-\(s): Speed is not on the screen \(describe(shortSpeed))") }
            shot("ios5-b2-model-menu-opus-three-models-\(s)")
            tree(short, "opus-short-menu-\(s)")
            short.terminate()
            let autoShort = launch("console", session: "C1", dark: dark, reset: false, fresh: true,
                                   until: "Model Auto", "auto-short-\(s)")
            openModelMenu(autoShort, inside: "Provider", "auto-short-menu-\(s)")
            shot("ios5-a2-model-menu-auto-three-models-\(s)")
            autoShort.terminate()

            let running = launch("console", session: "C3", dark: dark, until: "Also add a line to the changelog.",
                                 "running-\(s)")
            settle(2)
            expectText(running, ["Run the full test suite", "Queued for next turn",
                                 "Cursor CLI can’t take a message mid-turn"], "running-\(s)")
            // The input's placeholder is its placeholderValue, not a label.
            for input in running.textViews.allElementsBoundByIndex + running.textFields.allElementsBoundByIndex
            where !(input.placeholderValue ?? "").isEmpty {
                note("running-\(s): input placeholder \(input.placeholderValue ?? "") \(describe(input))")
            }
            shot("ios5-c-turn-running-queued-\(s)")
            tree(running, "running-\(s)")
            running.terminate()

            let context = launch("console", session: "C1", dark: dark, until: "Model Auto", "context-\(s)")
            let ring = context.buttons.matching(NSPredicate(format: "label == 'Context window unavailable'")).firstMatch
            note("context-\(s): ring \(describe(ring))")
            ring.tap()
            must(context, "Unavailable", "context-\(s)")
            settle(1.5)
            expectText(context, ["Context", "Context window", "Unavailable",
                                 "Cursor CLI doesn’t report how much of the window a session has used"], "context-\(s)")
            if !context.staticTexts.matching(NSPredicate(format: "label == 'Model'")).firstMatch.exists {
                XCTFail("context-\(s): the sheet has no Model row")
            }
            shot("ios5-d-context-unavailable-\(s)")
            context.terminate()

            resetStub()
            setStub(#"{"spent": true}"#)
            let spent = launch("console", session: "C4", dark: dark, reset: false, fresh: true,
                               until: "Usage limit reached", "quota-\(s)")
            settle(2)
            expectText(spent, ["Usage limit reached", "The quota for Default (Cursor CLI) on “hpc” is used up.",
                               "Cursor answered “Upgrade your plan to continue”", "Free plan has no requests left until",
                               "This conversation can’t move to Team yet", "start a new session on Team"], "quota-\(s)")
            shot("ios5-e-usage-limit-\(s)")
            tree(spent, "quota-\(s)")
            spent.terminate()
        }
    }

    // MARK: board iOS 6 — the mode menu, the Provider menu once a conversation has started, a draft's

    func test6ModesAndSwitch() {
        for dark in [false, true] {
            let s = scheme(dark)
            let modes = launch("console", session: "C1", dark: dark, until: "Model Auto", "modes-\(s)")
            let mode = button(modes, beginning: "Accept Edits")
            note("modes-\(s): mode \(describe(mode))")
            for attempt in 1...3 {
                mode.tap()
                if containing(modes, "Bypass").waitForExistence(timeout: 4) { note("modes-\(s): open after \(attempt)"); break }
            }
            settle(1.5)
            // A menu row's subtitle is drawn but not in the accessibility tree (its label is the title
            // alone): Default's and Don't Ask's notes are read off the picture.
            expectText(modes, ["Default", "Accept Edits", "Plan", "Auto", "Don't Ask", "Bypass"], "modes-\(s)")
            let defaultRow = modes.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Default'")).firstMatch
            note("modes-\(s): Default \(describe(defaultRow)) enabled=\(defaultRow.exists && defaultRow.isEnabled)")
            if defaultRow.exists && defaultRow.isEnabled { XCTFail("modes-\(s): Default can be picked on Cursor CLI") }
            shot("ios6-a-modes-\(s)")
            tree(modes, "modes-\(s)")
            modes.terminate()

            // One Cursor key, as the board draws: with Cursor 2 too, the menu is a row taller than the screen
            // has room for and the note's second sentence is a scroll away.
            resetStub()
            setStub(#"{"keys": "onecursor"}"#)
            let talked = launch("console", session: "C1", dark: dark, reset: false, fresh: true,
                                until: "Model Auto", "blocked-\(s)")
            openProviderMenu(talked, inside: "Signed in on hpc", "blocked-\(s)")
            expectText(talked, ["Signed in on hpc", "Automatic", "Default", "Team", "API keys",
                                "can’t carry a conversation to another account or key yet"], "blocked-\(s)")
            for label in ["Team", "Default"] {
                let row = talked.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
                note("blocked-\(s): \(label) \(describe(row)) enabled=\(row.exists && row.isEnabled)")
                if row.exists && row.isEnabled { XCTFail("blocked-\(s): \(label) can be picked on a session that has talked") }
            }
            shot("ios6-b-provider-blocked-\(s)")
            tree(talked, "blocked-\(s)")
            expectText(talked, ["Start a new session to use one of these."], "blocked-note-\(s)")
            let second = talked.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Start a new session'")).firstMatch
            note("blocked-\(s): the note's second sentence \(describe(second))")
            if !onScreen(talked, second) {
                let header = talked.staticTexts.matching(NSPredicate(format: "label == 'Signed in on hpc'")).firstMatch
                dragMenuUp(talked, from: header, by: 120, "blocked-scroll-\(s)")
                note("blocked-scroll-\(s): after the drag \(describe(second))")
                if onScreen(talked, second) {
                    shot("ios6-b1-provider-blocked-scrolled-\(s)")
                } else {
                    note("blocked-scroll-\(s): the menu did not scroll")
                }
            }
            talked.terminate()

            resetStub()
            setStub(#"{"keys": "onecursor"}"#)
            let draft = compose(dark: dark, reset: false, "draft-\(s)")
            pickCursor(draft, "draft-pick-\(s)")
            openProviderMenu(draft, inside: "Signed in on hpc", "draft-\(s)")
            // Team's "Monthly 34%" is its row's subtitle, read off the picture.
            expectText(draft, ["Signed in on hpc", "Automatic", "Default", "Team", "API keys"], "draft-\(s)")
            expectAbsent(draft, ["can’t carry a conversation"], "draft-\(s)")
            shot("ios6-c-provider-draft-\(s)")
            tree(draft, "draft-\(s)")
            draft.terminate()
        }
    }
}
