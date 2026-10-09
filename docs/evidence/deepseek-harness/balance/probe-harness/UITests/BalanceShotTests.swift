import XCTest

// TEMPORARY evidence probe (never merged): Settings → Providers and a DeepSeek key's page on the iPhone
// app, against .dsb-probe/stub.py. Each launch lands on Settings; its Providers row and then a DeepSeek
// row are opened with the app's own taps, and Refresh / Retry are the app's own presses. Every state the stub serves has
// to render — one that doesn't is a failure, not a note — and no page without DeepSeek's own answer may
// show an amount.
final class BalanceShotTests: ProbeCase {
    private func scheme(_ dark: Bool) -> String { dark ? "dark" : "light" }

    /// Launch onto Settings with the stub serving `scenario`, open its Providers row, and wait for `words`.
    private func open(_ scenario: String, dark: Bool, until words: String, _ name: String) -> XCUIApplication {
        resetStub()
        setStub(#"{"scenario": "\#(scenario)"}"#)
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.fresh"] + (dark ? ["-dark"] : [])
        app.launch()
        let providers = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Providers'")).firstMatch
        if providers.waitForExistence(timeout: 45) {
            settle(1)
            note("\(name): Settings row \(describe(providers))")
            providers.tap()
        } else {
            write(app.debugDescription, "missing-settings-\(name).txt")
            XCTFail("\(name): Settings showed no Providers row")
        }
        if !appears(app, words, timeout: 45) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(words) never showed — the app did not render the stub's state")
        }
        settle(1.5)
        return app
    }

    /// The key list's row whose words include these, tapped; true once the page shows `page`.
    @discardableResult
    private func openRow(_ app: XCUIApplication, _ words: String, until page: String, _ name: String) -> Bool {
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
        guard row.waitForExistence(timeout: 10) else {
            write(app.debugDescription, "missing-row-\(name).txt")
            XCTFail("\(name): no row with \(words) that opens anything")
            return false
        }
        note("\(name): row \(describe(row))")
        if !row.isHittable { bring(app, row, between: 120, and: 760, missingIsAbove: false, name) }
        row.tap()
        guard appears(app, page, timeout: 15) else {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(page) never showed")
            return false
        }
        settle(1.2)
        return true
    }

    private func back(_ app: XCUIApplication) {
        let named = app.navigationBars.buttons["Providers"]
        (named.exists ? named : app.navigationBars.buttons.element(boundBy: 0)).tap()
        settle(1)
    }

    private func expectText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for text in words where !containing(app, text).exists {
            XCTFail("\(name): nothing says \(text)")
        }
    }

    /// No text on screen reads as an amount: no currency sign and no 0.00.
    private func expectNoAmount(_ app: XCUIApplication, _ name: String) {
        let found = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS '¥' OR label CONTAINS '$' OR label CONTAINS '0.00'"))
            .allElementsBoundByIndex.map(\.label)
        note("\(name): amounts on screen: \(found)")
        if !found.isEmpty { XCTFail("\(name): shows an amount where there is no balance: \(found)") }
    }

    private func press(_ app: XCUIApplication, _ label: String, _ name: String) {
        let button = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
        guard button.exists else { return XCTFail("\(name): no \(label)") }
        button.tap()
        settle(2.5)
    }

    // MARK: one key behind two providers

    func test1OneKeyTwoProviders() {
        for dark in [false, true] {
            let s = scheme(dark)
            let app = open("pair", dark: dark, until: "¥110.00", "providers-\(s)")
            let totals = app.buttons.matching(NSPredicate(format: "label CONTAINS '¥110.00'")).allElementsBoundByIndex.map(\.label)
            note("providers-\(s): rows ending with a balance: \(totals)")
            if totals.count != 2 { XCTFail("providers-\(s): \(totals.count) rows end with ¥110.00, not DeepSeek and DeepSeek Harness") }
            for other in ["Anthropic (Claude)", "Kimi (Moonshot)"] {
                if !containing(app, other).exists { XCTFail("providers-\(s): no \(other)") }
                if app.buttons.matching(NSPredicate(format: "label CONTAINS %@", other)).count != 0 {
                    XCTFail("providers-\(s): \(other) opens a page — only DeepSeek keys do")
                }
            }
            shot("ios-01-providers-\(s)")
            tree(app, "providers-\(s)")

            if openRow(app, "deepseek-v4-pro", until: "Granted", "deepseek-\(s)") {
                expectText(app, ["DeepSeek account balance", "Total", "¥110.00", "Topped up", "Updated", "Refresh",
                                 "Top up on DeepSeek", "Same DeepSeek account as", "Claude Code", "deepseek-v4-pro",
                                 "api.deepseek.com"], "deepseek-\(s)")
                shot("ios-02-deepseek-\(s)")
                tree(app, "deepseek-\(s)")
                if !dark {
                    // Refresh asks DeepSeek again: the app's own press reaches the server as ?refresh=1.
                    press(app, "Refresh", "refresh")
                    expectRequest("/api/providers/mine/p-ds/balance?refresh=1", "refresh")
                    if !appears(app, "Just now", timeout: 10) { XCTFail("refresh: the page never showed the new read") }
                    shot("ios-02b-deepseek-refreshed-\(s)")
                }
                back(app)
            }
            if openRow(app, "Runs on DeepSeek Harness", until: "Granted", "harness-\(s)") {
                expectText(app, ["¥110.00", "Same DeepSeek account as", "DeepSeek Harness"], "harness-\(s)")
                shot("ios-03-deepseek-harness-\(s)")
                tree(app, "harness-\(s)")
                back(app)
            }
            app.terminate()
        }
    }

    // MARK: every state a balance can be in

    func test2EveryState() {
        for dark in [false, true] {
            let s = scheme(dark)
            let app = open("states", dark: dark, until: "Unavailable", "states-\(s)")
            let unavailable = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Unavailable'")).count
            if unavailable != 2 { XCTFail("states-\(s): \(unavailable) rows say Unavailable, not the rejected and the unreachable key") }
            expectText(app, ["¥0.42", "¥110.00 · $5.00", "DeepSeek Slow"], "states-\(s)")
            shot("ios-04-providers-states-\(s)")
            tree(app, "providers-states-\(s)")

            // The slow key is still being asked (the stub never answers it): its page says so, with no number.
            if openRow(app, "DeepSeek Slow", until: "Checking balance", "loading-\(s)") {
                expectNoAmount(app, "loading-\(s)")
                shot("ios-09-loading-\(s)")
                back(app)
            }
            if openRow(app, "DeepSeek Team", until: "Balance too low", "low-\(s)") {
                expectText(app, ["¥0.42", "Every session using a key on this account will fail", "Top up on DeepSeek",
                                 "Opens platform.deepseek.com/top_up in Safari."], "low-\(s)")
                shot("ios-05-low-\(s)")
                tree(app, "low-\(s)")
                back(app)
            }
            if openRow(app, "DeepSeek Old key", until: "rejected this API key", "key-rejected-\(s)") {
                expectText(app, ["Couldn't get the balance", "Change the key on the web, then retry.", "Unknown",
                                 "Last tried", "Retry", "No amount is shown until DeepSeek answers."], "key-rejected-\(s)")
                expectNoAmount(app, "key-rejected-\(s)")
                shot("ios-06-key-rejected-\(s)")
                tree(app, "key-rejected-\(s)")
                if !dark {
                    press(app, "Retry", "retry")
                    expectRequest("/api/providers/mine/p-old/balance?refresh=1", "retry")
                    expectNoAmount(app, "key-rejected-retried")
                }
                back(app)
            }
            if openRow(app, "DeepSeek Direct", until: "Couldn't reach api.deepseek.com", "network-\(s)") {
                expectText(app, ["The key itself wasn't checked.", "Unknown", "Retry"], "network-\(s)")
                expectNoAmount(app, "network-\(s)")
                shot("ios-07-network-\(s)")
                tree(app, "network-\(s)")
                back(app)
            }
            if openRow(app, "DeepSeek Intl", until: "USD", "multi-\(s)") {
                expectText(app, ["¥110.00", "$5.00", "Each currency is a separate balance"], "multi-\(s)")
                shot("ios-08-multi-currency-\(s)")
                tree(app, "multi-\(s)")
                back(app)
            }
            app.terminate()
        }
    }
}
