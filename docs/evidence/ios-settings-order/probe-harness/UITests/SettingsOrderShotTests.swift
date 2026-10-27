import XCTest

// TEMPORARY evidence probe (see ../../README.md): iPhone Settings after docs/mocks/ios-settings-order
// (the owner's 1A 2A). Two launches against stub.py, each landing on the Settings sheet:
//
//   the list   Machines & models first (its value in amber: one machine is offline), then
//              Preferences — Sessions, Notifications, Appearance — then Account; none of the five
//              session settings on it; scrolled down, Sign out and the build line.
//   Sessions   the page Preferences' first row opens: the five settings in order, each with the
//              web's hint as its footer, at the fresh account's values.
//
// Every claim is a note (`shown` / `MISSING`) and an assertion; the pictures are kept either way.
final class SettingsOrderShotTests: ProbeCase {
    private let five = ["Default permission", "Session orchestration", "Smart model selection",
                        "Suggested replies", "Session recaps"]
    /// Each footer's first words (SettingsCopy's hints, which are the web Settings page's).
    private let footers = ["The mode a new session starts in", "Sessions in every workspace can spawn",
                           "Coordinators suggest a tier for each task", "When a Claude turn ends",
                           "Session lists show the one-line summary"]

    private func claim(_ what: String, _ holds: Bool, file: StaticString = #filePath, line: UInt = #line) {
        note("\(holds ? "shown" : "MISSING"): \(what)")
        XCTAssertTrue(holds, what, file: file, line: line)
    }

    /// The top of each element named, in order, when every one of them is on screen.
    private func readsInOrder(_ app: XCUIApplication, _ labels: [String]) -> Bool {
        let found = labels.map { element(app, containing: $0) }
        guard found.allSatisfy({ $0.exists }) else {
            note("order: not all on screen — " + zip(labels, found).map { "\($0)=\($1.exists)" }.joined(separator: ", "))
            return false
        }
        let tops = found.map { $0.frame.minY }
        note("order: " + zip(labels, tops).map { "\($0)@\(Int($1))" }.joined(separator: " < "))
        return tops == tops.sorted() && Set(tops).count == tops.count
    }

    func testTheListOpensWithMachinesAndModels() {
        let app = launch(until: "Machines & models", "settings-list")
        claim("Machines & models says what needs you (one machine offline)", appears(app, "needs you", timeout: 20))
        settle(1.5)
        shot(app, "01-settings-top")
        write(app.debugDescription, "tree-01-settings-top.txt")
        claim("Machines & models, then Preferences: Sessions, Notifications, Appearance, then Account",
              readsInOrder(app, ["Machines & models", "Preferences", "Sessions", "Notifications", "Appearance",
                                 "Account", "Email"]))
        for title in five {
            claim("\(title) is not on the list", !element(app, containing: title).exists)
        }
        bring(app, element(app, containing: "Sign out"), between: 120, and: 780, "sign-out")
        settle(1)
        shot(app, "02-settings-bottom")
        write(app.debugDescription, "tree-02-settings-bottom.txt")
        claim("Sign out is at the bottom", element(app, containing: "Sign out").exists)
        for title in five {
            claim("\(title) is not on the list's lower half either", !element(app, containing: title).exists)
        }
    }

    func testSessionsOpensAPageOfTheFiveWithTheirFooters() {
        let app = launch(until: "Machines & models", "sessions-page")
        let row = buttons(app, beginning: "Sessions").first ?? element(app, containing: "Sessions")
        claim("Preferences has a Sessions row", row.exists)
        guard row.exists else { return }
        press(row)
        claim("it opens the Sessions page", app.navigationBars["Sessions"].waitForExistence(timeout: 15))
        settle(1.5)
        shot(app, "03-sessions-page")
        write(app.debugDescription, "tree-03-sessions-page.txt")
        var order: [String] = []
        for (title, footer) in zip(five, footers) { order += [title, footer] }
        claim("each setting, then its hint under it, in SessionSettings' order", readsInOrder(app, order))
        // The fresh account's values: orchestration named on, smart model selection unset (off), the
        // other two unset (on).
        for (title, value) in [("Session orchestration", "1"), ("Smart model selection", "0"),
                               ("Suggested replies", "1"), ("Session recaps", "1")] {
            let toggle = app.switches[title]
            let read = toggle.exists ? (toggle.value as? String ?? "?") : "absent"
            claim("\(title) reads \(value == "1" ? "on" : "off") (\(read))", read == value)
        }
        note("Default permission's row: \(element(app, containing: "Default permission").label)")
        claim("Default permission reads Auto", element(app, containingAll: ["Default permission", "Auto"]).exists
              || element(app, containing: "Auto").exists)
    }
}
