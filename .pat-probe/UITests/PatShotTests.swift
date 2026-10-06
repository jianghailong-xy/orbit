import XCTest

// TEMPORARY evidence probe (see ../README.md). Settings → Access tokens on the iPhone and the Mac,
// against stub.py: the list (names, scope summaries, expiry or Never expires, last use), then the
// lost laptop's token — "MacBook Air" — revoked through the real controls, which sends the real
// `DELETE /api/access-tokens/34ajPat3`; the stub then lists it as revoked.
final class PatShotTests: ProbeCase {

    /// Buttons labelled exactly this, hittable ones first.
    private func exactly(_ app: XCUIApplication, _ label: String) -> [XCUIElement] {
        let all = app.buttons.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
        return all.filter { $0.exists && $0.isHittable } + all.filter { !($0.exists && $0.isHittable) }
    }

    #if os(iOS)
    func testIPhoneListsAndRevokes() {
        // Settings' list is lazy: wait on a row near its top, then drag down to the account's rows.
        let app = launch(until: "Default permission", "ios-settings")
        bring(app, element(app, containing: "Access tokens"), between: 120, and: 760, "ios-settings-row")
        // The row's count is its value or part of its label, depending on how the cell combines.
        let counted = waitUntil(20) {
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Access tokens")).allElementsBoundByIndex
                .contains { $0.label.contains("3 active") || (($0.value as? String)?.contains("3 active") ?? false) }
                || self.element(app, containing: "3 active").exists
        }
        if !counted { XCTFail("the Access tokens row never said how many tokens work") }
        settle(1)
        shot(app, "ios-1-settings")
        write(app.debugDescription, "tree-ios-settings.txt")
        (buttons(app, beginning: "Access tokens").first ?? element(app, containing: "Access tokens")).tap()

        guard appears(app, "deploy-bot", timeout: 20) else {
            write(app.debugDescription, "missing-ios-list.txt")
            return XCTFail("the Access tokens page never listed the stub's tokens")
        }
        settle(1.5)
        shot(app, "ios-2-access-tokens")
        write(app.debugDescription, "tree-ios-list.txt")
        for words in ["ci-runner", "MacBook Air", "Read & write · everything", "Never expires",
                      "Tasks: read & write · Sessions: read · in orbit", "Last used 3h 20m ago · 203.0.113.7",
                      "orbit_pat_…k3Fq", "Active 3", "Revoked & expired 3"] where !appears(app, words, timeout: 3) {
            XCTFail("the list does not say \(words)")
        }

        // The lost laptop: a swipe offers Revoke, which only asks.
        element(app, containing: "MacBook Air").swipeLeft()
        settle(1)
        shot(app, "ios-3-swipe")
        guard let swipeRevoke = exactly(app, "Revoke").first, swipeRevoke.exists else {
            write(app.debugDescription, "missing-ios-swipe.txt")
            return XCTFail("the swipe offered no Revoke")
        }
        swipeRevoke.tap()
        guard appears(app, "Revoke “MacBook Air”?", timeout: 10) else {
            write(app.debugDescription, "missing-ios-confirm.txt")
            return XCTFail("revoking did not ask first")
        }
        settle(1)
        shot(app, "ios-4-confirm")
        write(app.debugDescription, "tree-ios-confirm.txt")
        XCTAssertFalse(requestsLog().contains("DELETE"), "nothing is revoked before the answer")

        // The dialog's own Revoke: in the action sheet when there is one, else the lowest one on
        // screen, where an iPhone's dialog sits.
        let inSheet = app.sheets.buttons["Revoke"]
        var dialogRevoke = exactly(app, "Revoke").filter { $0.exists && $0.isHittable }
            .max { $0.frame.minY < $1.frame.minY }
        if inSheet.exists { dialogRevoke = inSheet }
        guard let confirm = dialogRevoke else {
            return XCTFail("the dialog had no Revoke")
        }
        note("confirming with \(confirm.label) at \(confirm.frame) (in a sheet: \(inSheet.exists))")
        confirm.tap()
        if appears(app, "Token revoked", timeout: 8) {
            shot(app, "ios-5-revoked")
        } else {
            XCTFail("no word that the token was revoked")
        }
        settle(2.5)
        shot(app, "ios-6-active-after")
        XCTAssertTrue(requestsLog().contains("DELETE /api/access-tokens/34ajPat3"),
                      "the app never sent the revoke for MacBook Air")
        if !appears(app, "Active 2", timeout: 10) { XCTFail("MacBook Air is still counted as active") }

        // Revoked & expired: the laptop's token, with the ones that stopped before it.
        guard let ended = buttons(app, beginning: "Revoked & expired").first else {
            write(app.debugDescription, "missing-ios-tab.txt")
            return XCTFail("no Revoked & expired tab")
        }
        ended.tap()
        settle(1.5)
        for words in ["MacBook Air", "Revoked by an administrator", "Revoked with a password change", "Expired "]
        where !appears(app, words, timeout: 5) {
            XCTFail("the Revoked & expired tab does not say \(words)")
        }
        shot(app, "ios-7-revoked-and-expired")
        write(app.debugDescription, "tree-ios-ended.txt")
    }
    #endif

    #if os(macOS)
    func testMacListsAndRevokes() {
        // The form may draw lazily: wait on its top, then scroll down to the section.
        let app = launch(until: "Preferences", "mac-settings")
        let laptop = element(app, containing: "MacBook Air")
        // The last working row low in the window, so the section's heading and tabs sit above it.
        bring(app, laptop, between: 370, and: 575, "mac-section")
        guard laptop.exists else {
            write(app.debugDescription, "missing-mac-list.txt")
            return XCTFail("the Access tokens section never listed the stub's tokens")
        }
        settle(1)
        shot(app, "mac-1-access-tokens")
        write(app.debugDescription, "tree-mac-list.txt")
        for words in ["deploy-bot", "ci-runner", "Read & write · everything", "Never expires",
                      "Tasks: read & write · Sessions: read · in orbit", "Last used 3h 20m ago · 203.0.113.7"]
        where !appears(app, words, timeout: 3) {
            XCTFail("the section does not say \(words)")
        }

        // The Revoke… button on the laptop's row: the one level with its name.
        let row = laptop.frame.midY
        guard let revoke = exactly(app, "Revoke…").min(by: {
            abs($0.frame.midY - row) < abs($1.frame.midY - row)
        }) else {
            return XCTFail("no Revoke… button")
        }
        note("revoke button at \(revoke.frame), laptop row at \(laptop.frame)")
        revoke.click()
        guard appears(app, "Revoke “MacBook Air”?", timeout: 10) else {
            write(app.debugDescription, "missing-mac-confirm.txt")
            return XCTFail("revoking did not ask first")
        }
        settle(1)
        screen("mac-2-confirm")
        write(app.debugDescription, "tree-mac-confirm.txt")

        let confirm = [app.sheets.buttons["Revoke"], app.dialogs.buttons["Revoke"], app.alerts.buttons["Revoke"]]
            .first { $0.exists } ?? app.buttons.matching(NSPredicate(format: "label == %@", "Revoke")).firstMatch
        confirm.click()
        if appears(app, "Token revoked", timeout: 10) {
            settle(1)
            shot(app, "mac-3-revoked")
        } else {
            XCTFail("no word that the token was revoked")
        }
        if !appears(app, "Active 2", timeout: 10) { XCTFail("MacBook Air is still counted as active") }

        let segment = NSPredicate(format: "label BEGINSWITH %@", "Revoked & expired")
        let ended = [app.radioButtons.matching(segment).firstMatch, app.buttons.matching(segment).firstMatch]
            .first { $0.exists }
        guard let ended else {
            write(app.debugDescription, "missing-mac-tab.txt")
            return XCTFail("no Revoked & expired tab")
        }
        ended.click()
        settle(1.5)
        for words in ["MacBook Air", "Revoked by an administrator", "Revoked with a password change", "Expired "]
        where !appears(app, words, timeout: 5) {
            XCTFail("the Revoked & expired tab does not say \(words)")
        }
        shot(app, "mac-4-revoked-and-expired")
        write(app.debugDescription, "tree-mac-ended.txt")
    }
    #endif
}
