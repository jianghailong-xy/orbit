import XCTest

// TEMPORARY evidence probe (see ../README.md). The iPhone app's approve-terminal card and Settings → Terminals,
// against stub.py:
//
//   1  the Waiting on you inbox with the pending request's card (dev-laptop, code 7KQ-4MZ);
//   2  Approve pressed: the stub records POST /api/terminals/requests/34req1/approve and the card leaves;
//   3  Settings, its Terminals row;
//   4  Settings → Terminals with dev-laptop and HPC listed;
//   5  Revoke on dev-laptop, the question it asks;
//   6  after Revoke: the stub records DELETE /api/terminals/34term1 and only HPC is listed.
final class TerminalShotTests: ProbeCase {
    func testIPhoneApprovesAndRevokesATerminal() {
        // 1–2: the approve card.
        let inbox = launch(["-probe.inbox"], until: "Approve a terminal?", "ios-inbox")
        for line in ["Terminal on dev-laptop · code 7KQ-4MZ",
                     "It can start sessions in your workspaces on this machine and answer their approval cards for 30 days.",
                     "Waiting on you"] {
            let shown = appears(inbox, line, timeout: 3)
            note("card: \(line) \(shown ? "shown" : "MISSING")")
            XCTAssertTrue(shown, "the card says \(line)")
        }
        picture(inbox, "ios-1-approve-card")
        let approve = inbox.buttons["terminal-approve-34req1"].exists ? inbox.buttons["terminal-approve-34req1"]
            : inbox.buttons["Approve"]
        if approve.waitForExistence(timeout: 5), approve.isHittable {
            press(approve)
            settle(2.5)
            let gone = waitUntil(10) { !self.element(inbox, containing: "Approve a terminal?").exists }
            note("after Approve the card is \(gone ? "gone" : "STILL SHOWN")")
            XCTAssertTrue(gone, "the card leaves once approved")
            picture(inbox, "ios-2-after-approve")
        } else {
            XCTFail("no hittable Approve (exists: \(approve.exists))")
        }
        let log1 = requestsLog()
        XCTAssertTrue(log1.contains("POST /api/terminals/requests/34req1/approve"), "the stub saw the approve")
        write(log1, "ios-inbox-requests.txt")
        inbox.terminate()

        // 3–6: Settings → Terminals and Revoke.
        // Settings' list is lazy: wait on a row near its top, then bring the account's rows up.
        let app = launch(["-probe.settings"], until: "Notifications", "ios-settings")
        let row = buttons(app, beginning: "Terminals").first ?? element(app, containing: "Terminals")
        bring(app, row, between: 100, and: 760, "ios-3-settings")
        picture(app, "ios-3-settings")
        press(row)
        guard appears(app, "dev-laptop", timeout: 20) else {
            write(app.debugDescription, "missing-terminals.txt")
            XCTFail("Settings → Terminals never listed dev-laptop")
            return
        }
        for line in ["HPC", "Never used", "Approved ", "Last used ", "Expires "] {
            note("list: \(line) \(appears(app, line, timeout: 3) ? "shown" : "MISSING")")
        }
        picture(app, "ios-4-terminals")
        let revoke = app.buttons["terminal-revoke-34term1"]
        guard revoke.waitForExistence(timeout: 5) else { XCTFail("no Revoke on dev-laptop"); return }
        press(revoke)
        guard appears(app, "Revoke the terminal on dev-laptop?", timeout: 10) else {
            write(app.debugDescription, "missing-revoke-question.txt")
            XCTFail("Revoke asked nothing")
            return
        }
        picture(app, "ios-5-revoke-question")
        // The question's own Revoke: an alert's button, not the row's.
        let confirm = app.alerts.buttons["Revoke"].exists ? app.alerts.buttons["Revoke"]
            : app.sheets.buttons["Revoke"].exists ? app.sheets.buttons["Revoke"]
            : app.buttons.matching(NSPredicate(format: "label == 'Revoke' AND identifier != 'terminal-revoke-34term1' AND identifier != 'terminal-revoke-34term2'")).firstMatch
        press(confirm)
        let left = waitUntil(15) { !self.element(app, containing: "dev-laptop").exists }
        note("after Revoke dev-laptop is \(left ? "gone" : "STILL LISTED"); HPC \(appears(app, "HPC", timeout: 3) ? "shown" : "MISSING")")
        XCTAssertTrue(left, "the revoked terminal leaves the list")
        XCTAssertTrue(appears(app, "HPC", timeout: 3), "the other terminal stays")
        picture(app, "ios-6-after-revoke")
        let log2 = requestsLog()
        XCTAssertTrue(log2.contains("DELETE /api/terminals/34term1"), "the stub saw the revoke")
        write(log2, "ios-settings-requests.txt")
        app.terminate()
    }

    private func launch(_ extra: [String], until label: String, _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.fresh",
                               "-ApplePersistenceIgnoreState", "YES"] + extra
        app.launch()
        dismissSystemPrompts()
        if !appears(app, label, timeout: 90) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(label) never showed — the app did not render the stub's state")
        }
        settle(1.5)
        return app
    }

    private func picture(_ app: XCUIApplication, _ name: String) {
        settle(1.2)
        shot(app, name)
        write(app.debugDescription, "tree-\(name).txt")
    }
}
