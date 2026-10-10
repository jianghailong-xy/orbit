import XCTest

// TEMPORARY evidence probe (see ../README.md): the login page remembering the last account per
// domain (docs/mocks/login-remember-account/), on the real shared LoginView and AppModel, against
// stub.py. iPhone: each surface in light and dark, plus the flows behind them (a real password
// sign-in, a failed one, Sign out, Remove from this device, another domain). Mac: the same page.
final class LoginShotTests: ProbeCase {
    /// Alex Morgan's password account on the stub's domain, with a photo.
    private let alex = ["-probe.account", "password", "-probe.photo", "1"]

    #if os(iOS)
    /// ① A password account comes back: its card, the password, Sign In — no "or" and no Google,
    /// although this server offers Google.
    func test1PasswordCard() {
        for dark in [false, true] {
            let s = dark ? "dark" : "light"
            let app = launch(alex, dark: dark, until: "Alex Morgan", "password-\(s)")
            waitForRequest("\"GET /api/auth/methods\" 200", timeout: 10, "password-\(s)")
            settle(1)
            shot("1-password-card-\(s)")
            note("password-\(s): card \(describe(card(app)))")
            expect(app, present: ["Sign In", "Use another account"], absent: ["or", "Continue with Google"], "password-\(s)")
            if app.secureTextFields.count != 1 { XCTFail("password-\(s): one password field") }
            if !dark { tree(app, "password-light") }
            app.terminate()
        }
        // Recorded while signed in (the first launch after the update): every way the server has.
        let app = launch(["-probe.account", "unknown", "-probe.photo", "1"], until: "Continue with Google", "unknown")
        shot("1b-unknown-card-light")
        expect(app, present: ["Sign In", "or", "Continue with Google", "Use another account"], "unknown")
        app.terminate()
    }

    /// ② A Google account comes back: only Continue with Google, once the server has said it offers it.
    func test2GoogleCard() {
        for dark in [false, true] {
            let s = dark ? "dark" : "light"
            let app = launch(["-probe.account", "google"], dark: dark, until: "Continue with Google", "google-\(s)")
            settle(1)
            shot("2-google-card-\(s)")
            expect(app, present: ["Use another account"], absent: ["or", "Sign In"], "google-\(s)")
            if app.secureTextFields.count != 0 { XCTFail("google-\(s): no password field") }
            app.terminate()
        }
        // While the server is asked, the slot stays empty: no password field that would vanish.
        let asking = launch(["-probe.account", "google"], stub: #"{"methods_delay": 8}"#, until: "Alex Morgan", "asking")
        shot("2b-google-card-asking-light")
        expect(asking, present: ["Use another account"], absent: ["Continue with Google", "Sign In", "or"], "asking")
        if asking.secureTextFields.count != 0 { XCTFail("asking: no password field while the server is asked") }
        if appears(asking, "Continue with Google", timeout: 20) {
            settle(1)
            shot("2c-google-card-answered-light")
        } else {
            XCTFail("asking: the answer never brought Google")
        }
        asking.terminate()
        // A server that doesn't offer Google: the password instead (a server that can't be reached reads the same).
        let off = launch(["-probe.account", "google"], stub: #"{"google": false}"#, until: "Alex Morgan", "no-google")
        waitForRequest("\"GET /api/auth/methods\" 200", timeout: 10, "no-google")
        settle(1.5)
        shot("2d-google-card-server-without-google-light")
        expect(off, present: ["Sign In", "Use another account"], absent: ["Continue with Google", "or"], "no-google")
        off.terminate()
    }

    /// ③ Use another account: today's full form, its Email empty, and "Sign in as …" back to the card.
    func test3UseAnotherAccount() {
        for dark in [false, true] {
            let s = dark ? "dark" : "light"
            let app = launch(alex, dark: dark, until: "Alex Morgan", "another-\(s)")
            press(app, "Use another account", "another-\(s)")
            if !appears(app, "Sign in as Alex Morgan", timeout: 10) { XCTFail("another-\(s): no Sign in as") }
            settle(1)
            shot("3-another-account-\(s)")
            expect(app, present: ["Sign In", "or", "Continue with Google", "Sign in as Alex Morgan"],
                   absent: ["Use another account"], "another-\(s)")
            note("another-\(s): email field \(describe(app.textFields.firstMatch))")
            if card(app).exists { XCTFail("another-\(s): the card should give way to the form") }
            press(app, "Sign in as Alex Morgan", "another-\(s)")
            if appears(app, "Use another account", timeout: 10) {
                settle(1)
                if !dark { shot("3b-back-to-the-card-light") }
                if !card(app).exists { XCTFail("another-\(s): Sign in as should bring the card back") }
            } else {
                XCTFail("another-\(s): Sign in as did not go back to the card")
            }
            app.terminate()
        }
    }

    /// ④ A long press on the card: Remove from this device — which forgets the account, photo and all.
    func test4LongPress() {
        for dark in [false, true] {
            let s = dark ? "dark" : "light"
            let app = launch(alex, dark: dark, until: "Alex Morgan", "press-\(s)")
            card(app).press(forDuration: 1.5)
            if !appears(app, "Remove from this device", timeout: 10) {
                XCTFail("press-\(s): no Remove from this device")
                tree(app, "press-\(s)")
            }
            settle(1.2)
            shot("4-long-press-\(s)")
            guard !dark else { app.terminate(); continue }
            press(app, "Remove from this device", "remove")
            settle(2)
            shot("4b-removed-light")
            if card(app).exists { XCTFail("remove: the card should be gone") }
            expect(app, present: ["Sign In"], absent: ["Use another account", "Sign in as Alex Morgan"], "remove")
            note("remove: email field \(describe(app.textFields.firstMatch))")
            app.terminate()
            // Forgotten on the device, not just on the page: a relaunch that seeds nothing shows the form.
            let again = launch(["-probe.keep", "1"], until: "Email", "removed-relaunch")
            shot("4c-removed-then-relaunched-light")
            if card(again).exists { XCTFail("removed-relaunch: the account came back") }
            again.terminate()
        }
    }

    /// ⑤ The keyboard up: the brand folds into one row; the card, the password and Sign In stay above it.
    func test5KeyboardUp() {
        for dark in [false, true] {
            let s = dark ? "dark" : "light"
            let app = launch(alex, dark: dark, until: "Alex Morgan", "keyboard-\(s)")
            let field = app.secureTextFields.firstMatch
            field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 8) { note("keyboard-\(s): no software keyboard") }
            field.typeText("correcthors")
            settle(1.5)
            shot("5-keyboard-up-\(s)")
            note("keyboard-\(s): card \(describe(card(app))) keyboard \(describe(app.keyboards.firstMatch))")
            app.terminate()
        }
    }

    /// ⑥ A double tap on the logo opens the Server sheet; another domain shows its own last account,
    /// and coming back shows this one's again.
    func test6ServerSheetByDoubleTap() {
        for dark in [false, true] {
            let s = dark ? "dark" : "light"
            let app = launch(alex + ["-probe.other", "localhost:8765"], dark: dark, until: "Alex Morgan", "server-\(s)")
            exact(app, "Orbit").doubleTap()
            if !appears(app, "Server address", timeout: 10) {
                XCTFail("server-\(s): a double tap did not open the Server sheet")
                tree(app, "server-\(s)")
            }
            settle(1.5)
            shot("6-server-sheet-\(s)")
            guard !dark else { app.terminate(); continue }
            switchServer(app, to: "localhost:8765")
            if appears(app, "Sam Lee", timeout: 15) {
                _ = appears(app, "Continue with Google", timeout: 10)
                settle(1.5)
                shot("6b-another-domain-light")
            } else {
                XCTFail("server: localhost:8765 should show Sam Lee's card")
            }
            exact(app, "Orbit").doubleTap()
            _ = appears(app, "Server address", timeout: 10)
            settle(1)
            switchServer(app, to: "127.0.0.1:8765")
            if appears(app, "Alex Morgan", timeout: 15) {
                settle(1.5)
                shot("6c-back-to-the-first-domain-light")
            } else {
                XCTFail("server: back on 127.0.0.1:8765, Alex Morgan's card should be there")
            }
            app.terminate()
        }
    }

    /// A real sign-in against the stub: the empty form (still filled by the pre-card email), a failed
    /// sign-in that remembers nothing, a good one, Sign out — which revokes and keeps the account —
    /// and a failed sign-in as someone else that changes nothing.
    func test7SignInIsRememberedAndAFailedOneChangesNothing() {
        let app = launch(["-probe.legacy", "alex@example.com"], until: "Email", "real")
        settle(1)
        shot("7a-empty-form-with-the-pre-card-email-light")
        note("real: email field \(describe(app.textFields.firstMatch))")

        let password = app.secureTextFields.firstMatch
        password.tap()
        password.typeText("wrong password")
        press(app, "Sign In", "real")
        if !appears(app, "Incorrect email or password.", timeout: 15) { XCTFail("real: the wrong password was not refused") }
        settle(1)
        shot("7b-failed-sign-in-remembers-nothing-light")
        expect(app, absent: ["Use another account"], "real-failed")
        if card(app).exists { XCTFail("real-failed: a failed sign-in remembered someone") }

        password.tap()
        password.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 20) + "correct horse")
        press(app, "Sign In", "real")
        if !appears(app, "Signed in as Alex Morgan", timeout: 20) { XCTFail("real: the sign-in did not go through") }
        waitForRequest("\"GET /api/users/me/avatar\" 200", timeout: 15, "real")
        settle(2)
        press(app, "Sign out", "real")
        if !appears(app, "Use another account", timeout: 15) { XCTFail("real: after Sign out the page should show the card") }
        settle(2)
        shot("7c-after-sign-out-light")
        note("real: card \(describe(card(app)))")
        if !waitForRequest("\"POST /api/auth/logout\" 204", timeout: 10, "real") { XCTFail("real: Sign out did not revoke") }

        press(app, "Use another account", "real-other")
        let email = app.textFields.firstMatch
        email.tap()
        email.typeText("bob@example.com")
        password.tap()
        password.typeText("not his password")
        press(app, "Sign In", "real-other")
        if !appears(app, "Incorrect email or password.", timeout: 15) { XCTFail("real-other: not refused") }
        settle(1)
        shot("7d-failed-sign-in-as-someone-else-light")
        press(app, "Sign in as Alex Morgan", "real-other")
        if !appears(app, "Use another account", timeout: 10) { XCTFail("real-other: no way back to the card") }
        settle(1.5)
        shot("7e-the-card-unchanged-light")
        if !card(app).exists { XCTFail("real-other: Alex Morgan's card should be unchanged") }
        app.terminate()

        // Kept on the device: a relaunch that seeds nothing opens on the same card.
        let again = launch(["-probe.keep", "1"], until: "Alex Morgan", "real-relaunch")
        shot("7f-relaunched-light")
        again.terminate()
        write(requestsLog(), "requests-at-the-end.log")
    }

    private func switchServer(_ app: XCUIApplication, to address: String) {
        let field = app.textFields.firstMatch
        if !field.waitForExistence(timeout: 5) { XCTFail("server: no address field"); return }
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40) + address)
        press(app, "Save", "server")
        settle(1)
    }
    #endif

    #if os(macOS)
    /// The Mac shows the same page: the shared LoginView, its card and its right-click menu.
    func test8MacWindow() {
        for dark in [false, true] {
            let s = dark ? "dark" : "light"
            let app = launch(alex, dark: dark, until: "Alex Morgan", "mac-\(s)")
            settle(1.5)
            shot("8-mac-password-card-\(s)")
            app.terminate()
        }
        let app = launch(["-probe.account", "google"], until: "Continue with Google", "mac-google")
        settle(1)
        shot("8b-mac-google-card-light")
        card(app).rightClick()
        if appears(app, "Remove from this device", timeout: 8) {
            settle(1)
            shot("8c-mac-right-click-light", screen: true)
        } else {
            XCTFail("mac: no Remove from this device on a right click")
            tree(app, "mac-right-click")
        }
        app.terminate()
    }
    #endif
}
