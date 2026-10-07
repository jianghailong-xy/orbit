import XCTest
import UIKit

// TEMPORARY evidence probe (never merged): the engine page's account rows on the iPhone app, against
// .acct-probe/stub.py. Each launch opens Settings on Mac Studio's page for one engine. What the design
// promises has to be on screen — a row that still carries a button the design took off it, or a press
// that never answers, is a failure, not a note.
final class AccountShotTests: ProbeCase {

    /// Launch onto Mac Studio's page for `engine` and wait for `until`.
    private func page(_ engine: String, until label: String, _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.fresh", "-probe.engine", engine]
        app.launch()
        if !appears(app, label, timeout: 60) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(label) never showed")
        }
        settle(2)
        return app
    }

    private func expectText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for text in words where !containing(app, text).exists {
            XCTFail("\(name): nothing says \(text)")
        }
    }

    private func exactButton(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// Bring an account's name to the upper half of the screen, where a swipe or a press on it lands.
    private func bringAccount(_ app: XCUIApplication, _ name: String, _ shotName: String) -> XCUIElement {
        let row = text(app, name)
        bring(app, row, between: 150, and: 560, missingIsAbove: false, shotName)
        return row
    }

    // MARK: the rows

    func test1TheRowsSayWhereEachAccountStandsWithNoButtonsOnASignedInOne() {
        let app = page("claude", until: "alex.ops@example.com", "page")
        expectText(app, ["Accounts", "alex@example.com", "alex.rd@example.com", "Login expires in 2 days",
                         "alex.lab@example.com", "Signed out",
                         "Sessions can’t use this account until you sign in again.",
                         "alex.ops@example.com", "Paused"], "page")
        if !exactButton(app, "Renew").exists { XCTFail("page: the lapsing login has no Renew") }
        if !exactButton(app, "Sign In").exists { XCTFail("page: the signed-out account has no Sign In") }
        for gone in ["Sign In Again", "Pause…", "Resume Now", "Change Duration…"] where exactButton(app, gone).exists {
            XCTFail("page: a row still carries \(gone)")
        }
        shot("ios-01-page-top")
        tree(app, "page-top")
        _ = bringAccount(app, "alex.ops@example.com", "page-lower")
        shot("ios-02-page-lower")
    }

    // MARK: the swipe, the menu, the sheet

    func test2SwipingARowShowsPauseInsideRemove() {
        let app = page("claude", until: "alex.rd@example.com", "swipe")
        let row = bringAccount(app, "alex.rd@example.com", "swipe")
        row.swipeLeft()
        settle(1.5)
        let pause = exactButton(app, "Pause"), remove = exactButton(app, "Remove")
        note("swipe: pause \(describe(pause)); remove \(describe(remove))")
        if !pause.exists { XCTFail("swipe: no Pause on the swipe") }
        if !remove.exists { XCTFail("swipe: no Remove on the swipe") }
        if pause.exists && remove.exists && pause.frame.minX >= remove.frame.minX {
            XCTFail("swipe: Remove is not outermost")
        }
        shot("ios-03-swipe-pause-remove")
        tree(app, "swipe")
        guard pause.exists else { return }
        pause.tap()
        if !appears(app, "Pause Account", timeout: 10) {
            write(app.debugDescription, "missing-pause-sheet.txt")
            return XCTFail("swipe: Pause opened no Pause Account sheet")
        }
        settle(1.5)
        expectText(app, ["Pause for", "Automatically resumes at"], "sheet")
        shot("ios-04-pause-sheet")
    }

    func test3APausedRowSwipesToResumeAndResumesAtOnce() {
        let app = page("claude", until: "alex.ops@example.com", "resume")
        let row = bringAccount(app, "alex.ops@example.com", "resume")
        row.swipeLeft()
        settle(1.5)
        let resume = exactButton(app, "Resume")
        note("resume: \(describe(resume))")
        if !resume.exists { XCTFail("resume: a paused row's swipe has no Resume") }
        shot("ios-05-swipe-resume")
        guard resume.exists else { return }
        resume.tap()
        settle(4)
        expectRequest("POST /api/runners/mac/accounts/claude/3fa91c2e/pause", "resume")
        if containing(app, "Paused").exists { XCTFail("resume: the row still says Paused") }
        shot("ios-06-resumed")
    }

    func test4TheLongPressMenuHoldsEverything() {
        let app = page("claude", until: "alex.rd@example.com", "menu")
        let row = bringAccount(app, "alex.rd@example.com", "menu")
        row.press(forDuration: 1.3)
        settle(1.5)
        for item in ["Rename…", "Sign In Again", "Pause…", "Remove…"] where !exactButton(app, item).exists {
            XCTFail("menu: no \(item)")
        }
        shot("ios-07-menu")
        tree(app, "menu")
    }

    // MARK: signing in

    func test5SignInStartsAtOncePastesInOneTapAndFolds() {
        let app = page("claude", until: "alex.lab@example.com", "sign-in")
        _ = bringAccount(app, "alex.lab@example.com", "sign-in")
        let signIn = exactButton(app, "Sign In")
        guard signIn.exists else {
            write(app.debugDescription, "missing-sign-in.txt")
            return XCTFail("sign-in: no Sign In on the signed-out row")
        }
        signIn.tap()
        if !appears(app, "Starting sign-in on the runner", timeout: 6) {
            XCTFail("sign-in: the press did not start the sign-in")
        }
        if exactButton(app, "Sign in to Claude Code").exists { XCTFail("sign-in: a second press is still asked for") }
        shot("ios-08-starting")
        if !appears(app, "Approve it there", timeout: 20) {
            write(app.debugDescription, "missing-paste-form.txt")
            return XCTFail("sign-in: the paste-back form never showed")
        }
        settle(1.5)
        // The sheet's own X is labelled Close too (identifier xmark); the card's would be another.
        let cardClose = app.buttons.matching(NSPredicate(format: "label == 'Close' AND identifier != 'xmark'")).firstMatch
        if cardClose.exists { XCTFail("sign-in: a Close sits beside Cancel while signing in: \(describe(cardClose))") }
        shot("ios-09-paste-form")
        tree(app, "paste-form")

        // To the sign-in page and back: Paste becomes the press.
        let open = button(app, beginning: "Open the sign-in page")
        if open.exists {
            open.tap()
            settle(4)
            app.activate()
            settle(2.5)
            shot("ios-10-back-paste-first")
        } else {
            XCTFail("sign-in: no Open the sign-in page")
        }

        UIPasteboard.general.string = "probe-code-123#probe-state"
        let paste = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Paste'")).firstMatch
        note("sign-in: paste \(describe(paste))")
        guard paste.exists else {
            write(app.debugDescription, "missing-paste.txt")
            return XCTFail("sign-in: no Paste beside the empty code field")
        }
        paste.tap()
        settle(1)
        dismissPasteAlert()
        if !appears(app, "Signed in — this runner is ready", timeout: 30) {
            write(app.debugDescription, "missing-signed-in.txt")
            XCTFail("sign-in: the pasted code never landed")
        }
        expectRequest("POST /api/runners/mac/login/code", "sign-in")
        shot("ios-11-signed-in")
        // Folds once the runner reports the account signed in.
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline && containing(app, "Signed in — this runner is ready").exists { settle(1) }
        if containing(app, "Signed in — this runner is ready").exists { XCTFail("sign-in: the card never folded") }
        if containing(app, "Sessions can’t use this account").exists { XCTFail("sign-in: the row still says it is out") }
        settle(1)
        shot("ios-12-folded")
    }

    /// A paste the system asks about would be the alert the control exists to avoid: note it.
    private func dismissPasteAlert() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow Paste"]
        if allow.waitForExistence(timeout: 2) {
            note("a paste permission alert showed — the control should not raise one")
            allow.tap()
        }
    }

    func test6CodexShowsItsCodeFirstUnderOnePress() {
        let app = page("codex", until: "Accounts", "codex")
        expectText(app, ["Sessions on this runner can’t use Codex until you sign in again."], "codex")
        shot("ios-13-codex-signed-out")
        let signIn = exactButton(app, "Sign In")
        guard signIn.exists else { return XCTFail("codex: no Sign In") }
        signIn.tap()
        if !appears(app, "Enter this one-time code on the sign-in page", timeout: 20) {
            write(app.debugDescription, "missing-device-code.txt")
            return XCTFail("codex: the device code never showed")
        }
        settle(1.5)
        expectText(app, ["K7QX-29PM", "Copy Code & Open Sign-In Page", "Waiting for you to approve it"], "codex")
        shot("ios-14-codex-device-code")
    }

    func test7DarkPage() {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.fresh", "-probe.engine", "claude", "-dark"]
        app.launch()
        if !appears(app, "alex.ops@example.com", timeout: 60) { XCTFail("dark: the page never showed") }
        settle(2)
        shot("ios-15-page-dark")
        let row = bringAccount(app, "alex.rd@example.com", "dark-swipe")
        row.swipeLeft()
        settle(1.5)
        shot("ios-16-swipe-dark")
    }
}
