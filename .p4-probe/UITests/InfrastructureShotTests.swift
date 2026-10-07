import XCTest

// TEMPORARY evidence probe (never merged): Settings → Infrastructure on the iPhone app, against
// .p4-probe/stub.py (the mock's account). Each launch lands on Settings; its Infrastructure row is opened
// with the app's own tap. Every block the page holds has to render with the stub's data — one that
// doesn't is a failure, not a note.
final class InfrastructureShotTests: ProbeCase {
    private func scheme(_ dark: Bool) -> String { dark ? "dark" : "light" }

    /// Launch onto Settings and wait for its Infrastructure row to say what needs a person.
    private func settings(dark: Bool, _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.fresh"] + (dark ? ["-dark"] : [])
        app.launch()
        if !infrastructureRow(app).waitForExistence(timeout: 45) {
            write(app.debugDescription, "missing-settings-\(name).txt")
            XCTFail("\(name): Settings showed no Infrastructure row")
        }
        if !appears(app, "2 need you", timeout: 45) {
            write(app.debugDescription, "missing-value-\(name).txt")
            XCTFail("\(name): the Infrastructure row never said 2 need you")
        }
        settle(1.5)
        return app
    }

    private func infrastructureRow(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Infrastructure'")).firstMatch
    }

    /// Open the page from Settings' row, and wait for its first block.
    private func openPage(_ app: XCUIApplication, _ name: String) {
        let row = infrastructureRow(app)
        note("\(name): Settings row \(describe(row))")
        row.tap()
        if !appears(app, "Codex is signed out on Mac Studio", timeout: 45) {
            write(app.debugDescription, "missing-page-\(name).txt")
            XCTFail("\(name): the page never showed Needs you")
        }
        settle(1.5)
    }

    private func expectText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for text in words where !containing(app, text).exists {
            XCTFail("\(name): nothing says \(text)")
        }
    }

    func test1SettingsAndEveryBlockOfThePage() {
        for dark in [false, true] {
            let s = scheme(dark)
            let app = settings(dark: dark, "settings-\(s)")
            // Machines & models holds one row, Infrastructure — no Runners, no Providers.
            expectText(app, ["Machines & models", "Infrastructure", "2 need you",
                             "Where your agents run, and whose model quota they spend."], "settings-\(s)")
            let old = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Runners' OR label BEGINSWITH 'Providers'"))
            note("settings-\(s): rows named Runners or Providers: \(old.count)")
            if old.count != 0 { XCTFail("settings-\(s): a Runners or Providers row is still there") }
            shot("ios-01-settings-\(s)")
            tree(app, "settings-\(s)")

            openPage(app, "page-\(s)")
            expectText(app, ["Needs you", "Codex is signed out on Mac Studio", "Sessions there can’t use it",
                             "ThinkPad is offline", "its subscriptions are unavailable until it’s back",
                             "What your agents can run on", "Claude Code", "Subscription · Mac Studio ×2, HPC",
                             "Pool · Claude keys", "Subscription · HPC ×2", "Subscription · HPC", "Antigravity",
                             "Not set up", "No machine signed in, no key.", "Install on a machine"], "page-\(s)")
            shot("ios-02-infrastructure-top-\(s)")
            tree(app, "page-top-\(s)")

            let machines = containing(app, "3 machines · 7 / 12 slots busy")
            bring(app, machines, between: 90, and: 220, missingIsAbove: false, "machines-\(s)")
            expectText(app, ["Machines", "3 machines · 7 / 12 slots busy", "Mac Studio",
                             "2 / 4 running · 1 engine signed out", "HPC", "5 / 8 running · All signed in",
                             "ThinkPad", "1 of 3 signed in", "Offline", "Add Runner"], "machines-\(s)")
            // Only ThinkPad is away: a machine online never wears Offline beside its running slots.
            for name in ["Mac Studio", "HPC"] {
                let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
                note("machines-\(s): \(describe(row))")
                if row.label.contains("Offline") { XCTFail("machines-\(s): \(name) is online but its row says Offline") }
            }
            shot("ios-03-infrastructure-machines-\(s)")
            tree(app, "page-machines-\(s)")

            let pools = containing(app, "Account pools")
            bring(app, pools, between: 90, and: 260, missingIsAbove: false, "pools-\(s)")
            expectText(app, ["Account pools", "Claude keys", "1 of 2 available", "API keys", "Anthropic (Claude)",
                             "Claude Opus 4.8", "DeepSeek", "DeepSeek V4 Pro", "OpenAI", "Disabled"], "pools-\(s)")
            shot("ios-04-infrastructure-pools-and-keys-\(s)")
            tree(app, "page-pools-\(s)")
            app.terminate()
        }
    }

    /// Needs you's Sign in opens Codex's page on Mac Studio, in the app — where signing in lives.
    func test2SignInOpensTheEnginesPage() {
        let app = settings(dark: false, "engine")
        openPage(app, "engine")
        let signIn = app.buttons["Sign in"].firstMatch
        guard signIn.waitForExistence(timeout: 10) else {
            write(app.debugDescription, "missing-sign-in.txt")
            return XCTFail("engine: Needs you has no Sign in")
        }
        note("engine: \(describe(signIn))")
        signIn.tap()
        if !appears(app, "Accounts", timeout: 20) {
            write(app.debugDescription, "missing-engine-page.txt")
            XCTFail("engine: Codex's page never showed its accounts")
        }
        settle(1.5)
        expectText(app, ["Codex", "Accounts", "Signed out"], "engine")
        if containing(app, "need the runner online").exists {
            XCTFail("engine: Mac Studio is online, but its Codex page says it is not")
        }
        if !app.navigationBars["Codex"].exists { XCTFail("engine: the page on top is not Codex's") }
        shot("ios-05-codex-on-mac-studio")
        tree(app, "engine-page")
    }
}
