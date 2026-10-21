import XCTest
import UIKit

// TEMPORARY evidence probe (never merged): a runner's Default removed from Orbit on the iPhone app's Codex
// page, against stub.py — Remove on Default's long-press menu and swipe, the web's confirmation, the
// removed state with one and with two accounts left, Use again, the runner page's Codex row, an added
// account's question while Default is removed, Default alone, and the runner offline (task
// 34jpFWOnhGsjNrBGIKi9V). What the web settled has to be on screen: a missing word, a Remove where there
// should be none, or a press that never reaches the stub is a failure, not a note.
final class RdrShotTests: ProbeCase {

    private static let removedLine = "Default · ~/.codex isn’t used by Orbit"
    private static let defaultQuestion = "Remove Default?"
    private static let defaultBody = "Orbit stops using it on HPC. Its sign-in stays on the machine, and Codex in a "
        + "terminal there keeps working. Workspaces set to it run on Automatic."

    /// Launch on HPC's page for `engine` (`runner` for the machine's own), the stub set to `state`, and
    /// wait for `until`.
    private func open(_ engine: String = "codex", state: String? = nil, dark: Bool = false, until label: String,
                      _ name: String) -> XCUIApplication {
        resetStub()
        if let state { setStub(state) }
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.fresh", "-probe.engine", engine] + (dark ? ["-dark"] : [])
        app.launch()
        if !appears(app, label, timeout: 60) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(label) never showed")
        }
        settle(2)
        return app
    }

    private func exactText(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func exactButton(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func expectText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for text in words where !containing(app, text).exists {
            XCTFail("\(name): nothing says \(text)")
        }
    }

    private func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        return false
    }

    /// The account named `name`, in the upper part of the screen where a press on it lands.
    private func accountRow(_ app: XCUIApplication, _ name: String, _ shotName: String) -> XCUIElement {
        let row = exactText(app, name)
        bring(app, row, between: 150, and: 600, missingIsAbove: false, shotName)
        return row
    }

    /// Long-press `name`'s row and wait for its menu: the menu's Rename… is there for every account.
    @discardableResult
    private func openMenu(_ app: XCUIApplication, _ name: String, _ shotName: String) -> Bool {
        let row = accountRow(app, name, shotName)
        guard row.exists else {
            write(app.debugDescription, "missing-row-\(shotName).txt")
            XCTFail("\(shotName): no row for \(name)")
            return false
        }
        row.press(forDuration: 1.2)
        if !exactButton(app, "Rename…").waitForExistence(timeout: 10) {
            write(app.debugDescription, "missing-menu-\(shotName).txt")
            XCTFail("\(shotName): \(name)'s long-press menu never opened")
            return false
        }
        settle(1)
        return true
    }

    /// The question an alert asks, and whether it says `body` word for word.
    private func expectQuestion(_ app: XCUIApplication, title: String, body: String, _ name: String) -> XCUIElement? {
        let alert = app.alerts.firstMatch
        guard alert.waitForExistence(timeout: 10) else {
            write(app.debugDescription, "missing-alert-\(name).txt")
            XCTFail("\(name): no confirmation")
            return nil
        }
        settle(1)
        note("\(name): alert \(describe(alert)); texts \(alert.staticTexts.allElementsBoundByIndex.map(\.label))")
        if !alert.staticTexts.matching(NSPredicate(format: "label == %@", title)).firstMatch.exists {
            XCTFail("\(name): the confirmation does not ask \(title)")
        }
        if !alert.staticTexts.matching(NSPredicate(format: "label == %@", body)).firstMatch.exists {
            XCTFail("\(name): the confirmation does not say \(body)")
        }
        return alert
    }

    // MARK: Remove on Default

    /// Default's long-press menu offers Remove… — after the rest, as the danger — while another account
    /// of the engine is listed.
    func test1DefaultsMenuOffersRemove() {
        let app = open(until: "~/.codex", "menu")
        guard openMenu(app, "Default", "menu") else { return }
        let remove = exactButton(app, "Remove…")
        note("menu: Remove… \(describe(remove))")
        if !remove.exists { XCTFail("menu: Default's menu offers no Remove…") }
        if remove.exists && !remove.isEnabled { XCTFail("menu: Default's Remove… is greyed") }
        shot("ios-01-default-menu-remove")
        tree(app, "default-menu")
    }

    /// Remove… asks first in the web's words, sends nothing until Remove, and then the page lists the two
    /// accounts that remain — each its own row — and ends with Default's line and Use again.
    func test2RemovingDefaultAsksThenListsTheAccountsThatRemain() {
        let app = open(until: "~/.codex", "remove")
        guard openMenu(app, "Default", "remove") else { return }
        exactButton(app, "Remove…").tap()
        guard let alert = expectQuestion(app, title: Self.defaultQuestion, body: Self.defaultBody, "remove") else { return }
        if requestsLog().contains("DELETE /api/runners/hpc/accounts/codex/default") {
            XCTFail("remove: Default was removed before Remove was pressed")
        }
        shot("ios-02-confirm-remove-default")
        alert.buttons["Remove"].tap()
        if !appears(app, Self.removedLine, timeout: 30) {
            write(app.debugDescription, "missing-removed.txt")
            return XCTFail("remove: the removed state never showed")
        }
        settle(2)
        expectRequest("DELETE /api/runners/hpc/accounts/codex/default", "remove")
        if exactText(app, "Default").exists { XCTFail("remove: Default is still listed as an account") }
        let line = exactText(app, Self.removedLine)
        bring(app, line, between: 380, and: 800, missingIsAbove: false, "removed-line")
        expectText(app, ["Work", "Personal", "~/.orbit/codex-accounts/3fa91c2e", "Use again", "NEXT"], "removed-two")
        if containing(app, "62%").exists { XCTFail("removed-two: Default's 62% is still drawn") }
        shot("ios-03-removed-two-accounts")
        tree(app, "removed-two")
    }

    /// With one account left it is a row of its own — its name, directory, windows and NEXT — never the
    /// engine's own row, and the line and Use again follow it.
    func test3OneRemainingAccountIsARowOfItsOwn() {
        let app = open(state: #"{"accounts": "two", "removed": true}"#, until: "isn’t used by Orbit", "one")
        expectText(app, ["Work", "~/.orbit/codex-accounts/3fa91c2e", "NEXT", "8%", Self.removedLine, "Use again"], "one")
        if exactText(app, "Default").exists { XCTFail("one: Default is still listed as an account") }
        if containing(app, "62%").exists { XCTFail("one: Default's 62% is still drawn") }
        shot("ios-04-removed-one-account")
        tree(app, "removed-one")
    }

    /// The runner page's Codex row speaks for the account that remains: where the next session starts,
    /// and its window — not Default's.
    func test4TheRunnersCodexRowSpeaksForTheAccountThatRemains() {
        let app = open("runner", state: #"{"accounts": "two", "removed": true}"#, until: "Engines", "runner")
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Codex, ")).firstMatch
        bring(app, row, between: 150, and: 700, missingIsAbove: false, "runner-codex")
        note("runner: row \(describe(row))")
        if !row.exists { return XCTFail("runner: no Codex row") }
        if !row.label.contains("Next: Work") { XCTFail("runner: the Codex row does not say Next: Work") }
        if row.label.contains("Default") || row.label.contains("62%") { XCTFail("runner: the Codex row speaks for Default") }
        shot("ios-05-runner-page-codex-next-work")
    }

    /// Use again posts the restore route, and Default is listed again.
    func test5UseAgainBringsDefaultBack() {
        let app = open(state: #"{"removed": true}"#, until: "isn’t used by Orbit", "use-again")
        let useAgain = exactButton(app, "Use again")
        bring(app, useAgain, between: 150, and: 700, missingIsAbove: false, "use-again")
        guard useAgain.exists else { return XCTFail("use-again: no Use again") }
        useAgain.tap()
        let back = waitUntil(30) { exactText(app, "Default").exists && !exactText(app, Self.removedLine).exists }
        if !back {
            write(app.debugDescription, "missing-back.txt")
            XCTFail("use-again: Default never came back")
        }
        settle(2)
        expectRequest("POST /api/runners/hpc/accounts/codex/default/restore", "use-again")
        shot("ios-06-use-again-default-back")
    }

    // MARK: removing an added account while Default is removed

    /// Personal's question says its workspaces run on Automatic — never on Default — and Cancel sends
    /// nothing.
    func test6AnAddedAccountsQuestionSaysAutomatic() {
        let app = open(state: #"{"removed": true}"#, until: "isn’t used by Orbit", "added")
        guard openMenu(app, "Personal", "added") else { return }
        exactButton(app, "Remove…").tap()
        guard let alert = expectQuestion(
            app, title: "Remove Personal?",
            body: "Its sign-in is deleted from HPC. Workspaces set to this account run on Automatic.", "added") else { return }
        shot("ios-07-remove-personal-automatic")
        alert.buttons["Cancel"].tap()
        settle(1)
        if requestsLog().contains("DELETE /api/runners/hpc/accounts/codex/" + "7c21de40") {
            XCTFail("added: Cancel removed the account")
        }
    }

    /// The last account Orbit uses there: its question says Orbit uses Default again.
    func test7TheLastAccountsQuestionSaysOrbitUsesDefaultAgain() {
        let app = open(state: #"{"accounts": "two", "removed": true}"#, until: "isn’t used by Orbit", "last")
        guard openMenu(app, "Work", "last") else { return }
        exactButton(app, "Remove…").tap()
        guard let alert = expectQuestion(
            app, title: "Remove Work?",
            body: "Its sign-in is deleted from HPC. Without it, Orbit uses Default there again, and workspaces set to "
                + "this account run on it.", "last") else { return }
        shot("ios-08-remove-work-last-account")
        alert.buttons["Cancel"].tap()
    }

    // MARK: the swipe, Default alone, offline

    /// Default's left swipe offers Remove too, and it asks the same question.
    func test8DefaultsSwipeOffersRemove() {
        let app = open(until: "~/.codex", "swipe")
        let row = accountRow(app, "Default", "swipe")
        guard row.exists else { return XCTFail("swipe: no row for Default") }
        // Across the row, not across the word: "Default" is too short a word to swipe a row open over.
        let window = app.windows.firstMatch
        let origin = window.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: window.frame.width * 0.85, dy: row.frame.midY))
            .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: window.frame.width * 0.3, dy: row.frame.midY)),
                   withVelocity: .fast, thenHoldForDuration: 0.1)
        settle(1.5)
        if !exactButton(app, "Remove").exists {
            note("swipe: the drag across the row opened nothing; swiping the word")
            row.swipeLeft()
            settle(1.5)
        }
        let remove = exactButton(app, "Remove")
        note("swipe: Remove \(describe(remove))")
        if !remove.exists { XCTFail("swipe: Default's swipe offers no Remove") }
        shot("ios-09-default-swipe-remove")
        tree(app, "swipe")
        guard remove.exists else { return }
        remove.tap()
        if let alert = expectQuestion(app, title: Self.defaultQuestion, body: Self.defaultBody, "swipe") {
            alert.buttons["Cancel"].tap()
        }
    }

    /// Default with no other account of the engine: its menu offers no Remove.
    func test9DefaultAloneOffersNoRemove() {
        let app = open(state: #"{"accounts": "alone"}"#, until: "~/.codex", "alone")
        guard openMenu(app, "Default", "alone") else { return }
        if exactButton(app, "Remove…").exists { XCTFail("alone: Default's menu offers Remove… with no other account") }
        shot("ios-10-default-alone-menu")
    }

    /// The runner offline: Default's Remove stays enabled — nothing goes to the machine — where an added
    /// account's is greyed (each menu in a launch of its own: a second long press right after a menu was
    /// put away met a row not yet hittable); and Use again works offline too.
    func test10OfflineDefaultsRemoveStaysEnabled() {
        let app = open(state: #"{"online": false}"#, until: "~/.codex", "offline")
        guard openMenu(app, "Default", "offline-default") else { return }
        let remove = exactButton(app, "Remove…")
        note("offline: Default's Remove… \(describe(remove))")
        if !remove.exists || !remove.isEnabled { XCTFail("offline: Default's Remove… is not offered enabled") }
        shot("ios-11-offline-default-menu")
    }

    func test10bOfflineAnAddedAccountsRemoveIsGreyed() {
        let app = open(state: #"{"online": false}"#, until: "~/.codex", "offline-work")
        guard openMenu(app, "Work", "offline-work") else { return }
        let remove = exactButton(app, "Remove…")
        note("offline: Work's Remove… \(describe(remove))")
        if !remove.exists { XCTFail("offline: Work's menu offers no Remove…") }
        if remove.exists && remove.isEnabled { XCTFail("offline: an added account's Remove… is enabled offline") }
        shot("ios-12-offline-work-menu")
    }

    func test11OfflineUseAgainWorks() {
        let app = open(state: #"{"online": false, "removed": true}"#, until: "isn’t used by Orbit", "offline-use-again")
        let useAgain = exactButton(app, "Use again")
        bring(app, useAgain, between: 150, and: 700, missingIsAbove: false, "offline-use-again")
        if !useAgain.exists || !useAgain.isEnabled { return XCTFail("offline: Use again is not enabled") }
        shot("ios-13-offline-removed")
        useAgain.tap()
        if !waitUntil(30, { exactText(app, "Default").exists }) { XCTFail("offline: Default never came back") }
        expectRequest("POST /api/runners/hpc/accounts/codex/default/restore", "offline-use-again")
    }

    /// The removed state in dark.
    func test12RemovedTwoAccountsDark() {
        let app = open(state: #"{"removed": true}"#, dark: true, until: "isn’t used by Orbit", "dark")
        let line = exactText(app, Self.removedLine)
        bring(app, line, between: 380, and: 800, missingIsAbove: false, "dark-line")
        shot("ios-14-removed-two-accounts-dark")
    }
}
