import XCTest
import UIKit

// TEMPORARY evidence probe (never merged): Kimi Code accounts on the iPhone app against .kimi-probe/stub.py,
// frame by frame as docs/mocks/kimi-accounts/02-ios draws them, and NEXT on the engine pages of the other
// engines that keep accounts. What the board promises has to be on screen: a missing word, a NEXT on the
// wrong account or a press that never reaches the stub is a failure, not a note.
final class KimiShotTests: ProbeCase {

    /// Launch with `args` (where to open), the stub's Kimi set to `kimi`, and wait for `until`.
    private func open(_ args: [String], kimi: String = "two", dark: Bool = false, until label: String,
                      _ name: String) -> XCUIApplication {
        resetStub()
        if kimi != "two" { setStub("{\"kimi\": \"\(kimi)\"}") }
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.fresh"] + args + (dark ? ["-dark"] : [])
        app.launch()
        if !appears(app, label, timeout: 60) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(label) never showed")
        }
        settle(2)
        return app
    }

    private func page(_ engine: String, kimi: String = "two", dark: Bool = false, until label: String,
                      _ name: String) -> XCUIApplication {
        open(["-probe.engine", engine], kimi: kimi, dark: dark, until: label, name)
    }

    private func expectText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for text in words where !containing(app, text).exists {
            XCTFail("\(name): nothing says \(text)")
        }
    }

    private func exactButton(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func exactText(_ app: XCUIApplication, _ label: String) -> [XCUIElement] {
        app.staticTexts.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
    }

    /// Exactly one NEXT on the page, on `name`'s line and after it — the chip beside the account a new
    /// session starts on.
    private func expectNext(_ app: XCUIApplication, beside name: String, _ shotName: String) {
        let chips = exactText(app, "NEXT")
        let names = exactText(app, name)
        note("\(shotName): NEXT at \(chips.map { "\($0.frame)" }); \(name) at \(names.map { "\($0.frame)" })")
        guard chips.count == 1, let chip = chips.first else {
            write(app.debugDescription, "missing-next-\(shotName).txt")
            return XCTFail("\(shotName): \(chips.count) NEXT marks on the page, not one")
        }
        let beside = names.contains { abs($0.frame.midY - chip.frame.midY) < 14 && $0.frame.maxX <= chip.frame.minX + 2 }
        if !beside { XCTFail("\(shotName): NEXT is not beside \(name)") }
    }

    /// Bring words to the upper half of the screen, where a press on them lands.
    private func bringText(_ app: XCUIApplication, _ words: String, _ shotName: String) -> XCUIElement {
        let element = text(app, words)
        bring(app, element, between: 150, and: 560, missingIsAbove: false, shotName)
        return element
    }

    /// An engine's row on the runner page: one button whose label says everything the row does
    /// ("Kimi Code, 2.1.1 · 2 accounts signed in, Next: Default, Weekly limit, 34%, …").
    private func engineRow(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name + ", ")).firstMatch
    }

    /// Fail unless the row's label says each of `says` and none of `not`.
    private func expectRow(_ row: XCUIElement, says: [String], not: [String] = [], _ name: String) {
        note("\(name): row \(describe(row))")
        guard row.exists else { return XCTFail("\(name): no such row") }
        for words in says where !row.label.contains(words) { XCTFail("\(name): the row does not say \(words)") }
        for words in not where row.label.contains(words) { XCTFail("\(name): the row says \(words)") }
    }

    /// The same for a text that is exactly `label` — an account's name, which a label merely beginning
    /// with it ("Workspace: …" behind the sheet) must not stand in for.
    private func bringExact(_ app: XCUIApplication, _ label: String, _ shotName: String) -> XCUIElement {
        let element = app.staticTexts.matching(NSPredicate(format: "label == %@", label)).firstMatch
        bring(app, element, between: 150, and: 560, missingIsAbove: false, shotName)
        return element
    }

    // MARK: ① the engine page with one Kimi account

    /// Today, on a runner too old to keep Kimi accounts: Sign-In, the one login on its site, no Add Account.
    func test1AnOlderRunnersPageIsAsItWas() {
        let app = page("kimi", kimi: "old", until: "kimi.ai", "older")
        expectText(app, ["Sign-In", "Default", "kimi.ai"], "older")
        if exactButton(app, "Add Account").exists { XCTFail("older: an older runner offers Add Account") }
        if containing(app, "Accounts").exists { XCTFail("older: the section is called Accounts") }
        shot("ios-01-kimi-older-runner")
    }

    /// ① One account on a runner that keeps them: Accounts, its site then its directory, its three
    /// windows, Add Account — and no NEXT, with nothing to choose between.
    func test2OneAccountOffersAddAccount() {
        let app = page("kimi", kimi: "one", until: "kimi.ai · ~/.kimi-code", "one")
        expectText(app, ["Accounts", "Default", "kimi.ai · ~/.kimi-code", "Signed in", "5h limit", "Weekly limit",
                         "Monthly limit", "12%", "34%", "8%"], "one")
        if !exactButton(app, "Add Account").exists { XCTFail("one: no Add Account") }
        if !exactText(app, "NEXT").isEmpty { XCTFail("one: NEXT with one account") }
        if containing(app, "Monthly · code").exists { XCTFail("one: the month's coding share is drawn") }
        shot("ios-02-kimi-one-account")
        tree(app, "one-account")
    }

    // MARK: ② Add Account: the name first, then the site

    func test3AddAccountNamesTheAccountThenPicksItsSite() {
        let app = page("kimi", kimi: "one", until: "kimi.ai · ~/.kimi-code", "add")
        let add = exactButton(app, "Add Account")
        guard add.exists else { return XCTFail("add: no Add Account") }
        bring(app, add, between: 120, and: 520, missingIsAbove: false, "add-button")
        add.tap()
        if !appears(app, "Which Kimi account are you signing in with?", timeout: 15) {
            write(app.debugDescription, "missing-sites.txt")
            return XCTFail("add: the press did not ask for the site")
        }
        settle(1.5)
        let field = app.textFields.firstMatch
        note("add: name field \(describe(field))")
        if (field.value as? String) != "Account 2" { XCTFail("add: the name it picked is not Account 2") }
        expectText(app, ["kimi.com", "Mainland China", "kimi.ai", "International",
                         "The two sites keep separate accounts — pick the one you signed up on."], "add")
        if containing(app, "Current").exists { XCTFail("add: a site is marked Current on an account being added") }
        if requestsLog().contains("POST /api/runners/hpc/login") { XCTFail("add: the press signed in before a site was picked") }
        bring(app, button(app, beginning: "kimi.ai"), between: 150, and: 700, missingIsAbove: false, "add-sites")
        shot("ios-03-add-account-name-then-sites")

        // No name, no site.
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 14))
        settle(1)
        let com = button(app, beginning: "kimi.com")
        note("add: kimi.com with no name \(describe(com)) enabled=\(com.isEnabled)")
        if com.isEnabled { XCTFail("add: kimi.com can be pressed with no name") }
        shot("ios-04-add-account-no-name")

        // Named Work, on kimi.com.
        field.typeText("Work\n")
        settle(1.5)
        let site = button(app, beginning: "kimi.com")
        if !site.isEnabled { XCTFail("add: kimi.com stays greyed with a name") }
        site.tap()
        if !appears(app, "7K06-QP86", timeout: 20) {
            write(app.debugDescription, "missing-device-code.txt")
            return XCTFail("add: the device code never showed")
        }
        settle(1.5)
        expectText(app, ["Sign in with the kimi.com account you are adding, then enter this one-time code:",
                         "Copy Code & Open kimi.com", "Waiting for you to approve it", "Use kimi.ai instead"], "device")
        if (app.textFields.firstMatch.value as? String) != "Work" { XCTFail("add: the name field no longer says Work") }
        shot("ios-05-add-account-device-code-kimi-com")
        tree(app, "device-code")
        expectRequest("\"accountName\":\"Work\"", "add-name")
        expectRequest("\"region\":\"mainland-cn\"", "add-site")

        // Approved: the card folds, and Work joins the list on its own site.
        setStub("{\"approve\": true}")
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline && (containing(app, "7K06-QP86").exists || containing(app, "Signed in — this runner is ready").exists
                                    || !containing(app, "kimi.com · ~/.orbit/kimi-accounts/5c2e91a0").exists) {
            settle(1)
        }
        if containing(app, "7K06-QP86").exists || containing(app, "Which Kimi account").exists {
            XCTFail("add: the card never folded")
        }
        if !containing(app, "kimi.com · ~/.orbit/kimi-accounts/5c2e91a0").exists { XCTFail("add: Work never joined the list") }
        settle(1.5)
        _ = bringText(app, "kimi.com · ~/.orbit/kimi-accounts", "added")
        shot("ios-06-added-work-folded")
        note("requests:\n" + requestsLog())
    }

    // MARK: ③ two accounts: each its own site, directory and windows; NEXT on Default

    func test4TwoAccountsEachSayTheirSiteAndWindowsAndDefaultIsNext() {
        let app = page("kimi", until: "kimi.com · ~/.orbit/kimi-accounts/5c2e91a0", "two")
        expectText(app, ["Accounts", "Default", "kimi.ai · ~/.kimi-code", "Work",
                         "kimi.com · ~/.orbit/kimi-accounts/5c2e91a0", "5h limit", "Weekly limit", "Monthly limit"], "two")
        expectNext(app, beside: "Default", "two")
        shot("ios-07-kimi-two-accounts-next-default")
        tree(app, "two-accounts")
        _ = bringText(app, "kimi.com · ~/.orbit/kimi-accounts", "two-work")
        expectText(app, ["91%", "61%", "22%"], "two-work")
        shot("ios-08-kimi-two-accounts-work")
    }

    /// ⑪ The runner page's Kimi row counts the accounts and names Next with its window — and the
    /// Claude row likewise.
    func test5TheRunnerPageNamesTheNextAccount() {
        let app = page("runner", until: "Engines", "runner")
        let kimi = bringText(app, "Kimi Code", "runner-kimi")
        note("runner: Kimi row \(describe(kimi))")
        expectText(app, ["2 accounts signed in", "Next: Default", "3 accounts signed in", "Next: alex.team@example.com"],
                   "runner")
        expectRow(engineRow(app, "Kimi Code"), says: ["2.1.1 · 2 accounts signed in", "Next: Default", "Weekly limit", "34%"],
                  not: ["kimi.ai", "kimi.com"], "runner-kimi")
        shot("ios-09-runner-page-next")
        tree(app, "runner")
    }

    /// ⑫ Work's Sign In Again: the same two sites, Current on Work's own (kimi.com), not Default's.
    func test6SignInAgainMarksTheAccountsOwnSite() {
        let app = page("kimi", until: "kimi.com · ~/.orbit/kimi-accounts/5c2e91a0", "again")
        let row = bringExact(app, "Work", "again-row")
        row.press(forDuration: 1.3)
        settle(1.5)
        let again = exactButton(app, "Sign In Again")
        guard again.exists else {
            write(app.debugDescription, "missing-sign-in-again.txt")
            return XCTFail("again: Work's menu has no Sign In Again")
        }
        shot("ios-10a-work-menu")
        again.tap()
        if !appears(app, "Which Kimi account are you signing in with?", timeout: 15) {
            write(app.debugDescription, "missing-again-sites.txt")
            return XCTFail("again: no choice of site")
        }
        settle(1.5)
        let current = exactText(app, "Current")
        let com = button(app, beginning: "kimi.com"), ai = button(app, beginning: "kimi.ai")
        note("again: Current \(current.map { "\($0.frame)" }); kimi.com \(describe(com)); kimi.ai \(describe(ai))")
        if current.count != 1 { XCTFail("again: \(current.count) Current marks, not one") }
        if let mark = current.first, !(mark.frame.midY >= com.frame.minY && mark.frame.midY <= com.frame.maxY) {
            XCTFail("again: Current is not on kimi.com, Work's own site")
        }
        bring(app, ai, between: 150, and: 700, missingIsAbove: false, "again-sites")
        shot("ios-10-work-sign-in-again-current-kimi-com")
    }

    // MARK: NEXT on the other engines' pages (the owner's call: all four engines)

    func test7NextOnTheOtherEnginesPages() {
        var app = page("claude", until: "alex.side@example.com", "claude")
        _ = bringText(app, "alex.team@example.com", "claude-team")
        expectNext(app, beside: "alex.team@example.com", "claude")
        shot("ios-11-claude-next-team")
        app.terminate()

        app = page("codex", until: "Pro", "codex")
        expectNext(app, beside: "Pro", "codex")
        shot("ios-12-codex-next-pro")
        app.terminate()

        app = page("antigravity", until: "Work", "antigravity")
        expectNext(app, beside: "Default", "antigravity")
        shot("ios-13-antigravity-next-default")
    }

    // MARK: ④ the session: Provider → Kimi's accounts, and a move to Default

    /// The message field: the text view lowest on the screen — the transcript's messages are text views
    /// too.
    private func composer(_ app: XCUIApplication) -> XCUIElement {
        let views = app.textViews.allElementsBoundByIndex.filter { $0.exists && $0.frame.height > 0 }
        return views.max { $0.frame.minY < $1.frame.minY } ?? app.textFields.firstMatch
    }

    private func sendButton(_ app: XCUIApplication) -> XCUIElement {
        for words in ["Send", "send", "Up Arrow", "arrow.up.circle.fill", "arrow up circle"] {
            let hit = app.buttons.matching(NSPredicate(format: "label ==[c] %@ OR identifier ==[c] %@", words, words)).firstMatch
            if hit.exists { return hit }
        }
        return app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'send' AND NOT (label CONTAINS[c] 'stop')")).firstMatch
    }

    /// The hittable button whose label begins with `words`, from those `prefer` matches first.
    private func menuItem(_ app: XCUIApplication, _ words: String, prefer: String? = nil) -> XCUIElement {
        let all = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", words)).allElementsBoundByIndex
            .filter { $0.exists && $0.isHittable }
        note("menu \(words): " + all.map(describe).joined(separator: " | "))
        if let prefer, let hit = all.first(where: { $0.label.contains(prefer) || "\($0.value ?? "")".contains(prefer) }) {
            return hit
        }
        return all.last ?? app.buttons[words]
    }

    func test8TheComposerMovesAKimiSessionBetweenAccounts() {
        let app = open(["-probe.session", "S1"], until: "parseUsages", "console")
        let gauge = button(app, beginning: "Plan usage")
        note("console: gauge \(describe(gauge))")
        if !gauge.label.contains("91%") { XCTFail("console: the gauge is not Work's 5 hours (91%)") }
        shot("ios-14-console-on-work")

        let model = button(app, beginning: "Model K3")
        note("console: model control \(describe(model))")
        guard model.exists else {
            write(app.debugDescription, "missing-model-control.txt")
            return XCTFail("console: no model control")
        }
        model.tap()
        settle(1.5)
        let provider = menuItem(app, "Provider")
        if !provider.exists { tree(app, "model-menu"); return XCTFail("console: the model menu has no Provider row") }
        shot("ios-15-model-menu-provider")
        tree(app, "model-menu")
        provider.tap()
        settle(1.5)
        // An iOS menu item exposes its title alone; what it says under it (Switches to soonest reset, Weekly
        // 34%, Current · 5h 91%) is the picture's to show.
        if exactText(app, "Kimi").isEmpty { XCTFail("provider: no Kimi section") }
        for item in ["Automatic", "Default", "Work"] where !exactButton(app, item).exists {
            XCTFail("provider: no \(item) under Kimi")
        }
        shot("ios-16-provider-kimi-accounts")
        tree(app, "provider-menu")

        let toDefault = menuItem(app, "Default", prefer: "Weekly")
        guard toDefault.exists else { return XCTFail("console: no Default under Kimi") }
        toDefault.tap()
        settle(4)
        expectRequest("PATCH /api/sessions/S1/account", "move")
        expectRequest("\"account\":\"default\"", "move-default")
        let moved = button(app, beginning: "Plan usage")
        note("console: gauge after the move \(describe(moved))")
        if !moved.label.contains("34%") { XCTFail("console: the gauge is not Default's week (34%) after the move") }
        shot("ios-17-moved-to-default")

        let field = composer(app)
        if field.waitForExistence(timeout: 10) {
            field.tap()
            settle(0.5)
            field.typeText("换到 Default 了，接着写 parseUsages()。")
            settle(0.8)
            let send = sendButton(app)
            note("console: send \(describe(send))")
            if send.exists && send.isHittable { send.tap() }
            if !appears(app, "接着上面那张表", timeout: 30) { XCTFail("console: the conversation did not go on") }
            settle(2)
            if app.keyboards.firstMatch.exists {
                app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
                settle(1)
            }
            shot("ios-18-same-conversation-goes-on")
        } else {
            XCTFail("console: no composer field")
        }

        let gaugeNow = button(app, beginning: "Plan usage")
        gaugeNow.tap()
        if !appears(app, "Monthly limit", timeout: 10) {
            write(app.debugDescription, "missing-plan-usage.txt")
            return XCTFail("console: the Plan usage sheet never showed")
        }
        settle(1.5)
        expectText(app, ["Account", "Default", "5h limit", "Weekly limit", "Monthly limit"], "plan-usage")
        if containing(app, "Monthly · code").exists { XCTFail("plan-usage: the month's coding share is drawn") }
        shot("ios-19-plan-usage-default")
        note("requests:\n" + requestsLog())
    }

    // MARK: the runner page's Kimi row, cut out (02-ios b and c)

    /// b: one account — the row keeps its site after the version, and now a window under it.
    func test10TheRunnerRowWithOneAccountKeepsItsSite() {
        let app = page("runner", kimi: "one", until: "Engines", "row-one")
        _ = bringText(app, "Kimi Code", "row-one-kimi")
        expectRow(engineRow(app, "Kimi Code"), says: ["2.1.1 · kimi.ai · Signed in", "Weekly limit", "34%"], not: ["Next:"],
                  "row-one")
        shot("ios-21-runner-row-one-account")
    }

    /// c: Work signed out — the row says Signed out with Sign In, and Next is the account still in;
    /// on the engine page Work's row offers Sign In and Default runs on.
    func test11WorkSignedOut() {
        var app = page("runner", kimi: "workout", until: "Engines", "row-out")
        _ = bringText(app, "Kimi Code", "row-out-kimi")
        // Its Sign In capsule is drawn inside the row, so it is in the row's label.
        expectRow(engineRow(app, "Kimi Code"), says: ["2.1.1 · Signed out", "Sign In", "Next: Default", "Weekly limit"],
                  "row-out")
        shot("ios-22-runner-row-work-signed-out")
        app.terminate()
        app = page("kimi", kimi: "workout", until: "kimi.com · ~/.orbit/kimi-accounts/5c2e91a0", "page-out")
        _ = bringText(app, "kimi.com · ~/.orbit/kimi-accounts", "page-out-work")
        if !exactButton(app, "Sign In").exists { XCTFail("page-out: Work offers no Sign In") }
        expectNext(app, beside: "Default", "page-out")
        shot("ios-23-kimi-work-signed-out")
    }

    // MARK: dark

    func test9DarkPage() {
        let app = page("kimi", dark: true, until: "kimi.com · ~/.orbit/kimi-accounts/5c2e91a0", "dark")
        expectNext(app, beside: "Default", "dark")
        shot("ios-20-kimi-two-accounts-dark")
    }
}
