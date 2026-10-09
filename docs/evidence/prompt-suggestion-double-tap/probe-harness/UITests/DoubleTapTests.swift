import XCTest
import UIKit

// TEMPORARY evidence probe (never merged): the engine's guess in the iPhone composer, taken with a
// double-tap instead of Use (docs/prompt-suggestions-design.md §4.1, docs/mocks/prompt-suggestion-double-tap).
// What the change promises has to happen on the real app: a single tap focuses and leaves the field
// empty, a double-tap fills it (from the idle field and with the keyboard up), the caret ends after the
// words, no edit menu is left over, and once learned the line loses its hint.
final class DoubleTapTests: ProbeCase {
    private let suggestion = "合并并部署"
    private let longSuggestion = "先在 staging 跑一遍 e2e，没问题再合并并部署到生产"

    /// A fresh launch on session S1, with the stub's guess set to `suggestion` (its default when nil).
    private func open(dark: Bool = false, suggestion: String? = nil, _ name: String) -> XCUIApplication {
        resetStub()
        if let suggestion { setStub("{\"suggestion\": \"\(suggestion)\"}") }
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.fresh"] + (dark ? ["-dark"] : [])
        app.launch()
        if !appears(app, "可以合并部署了", timeout: 60) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): the session never showed")
        }
        settle(2)
        return app
    }

    /// The composer: the lowest text view (transcript bubbles can be text views too).
    private func composer(_ app: XCUIApplication) -> XCUIElement {
        let views = app.textViews.allElementsBoundByIndex.filter { $0.exists }
        return views.max(by: { $0.frame.minY < $1.frame.minY }) ?? app.textViews.firstMatch
    }

    private func value(_ element: XCUIElement) -> String {
        (element.value as? String) ?? ""
    }

    private func waitForValue(_ app: XCUIApplication, _ expected: String, timeout: TimeInterval = 6) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if value(composer(app)) == expected { return true }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline
        return false
    }

    /// Whatever edit menu is up (Paste, Select All, Copy…), as menu items or as buttons. The transcript has
    /// a Copy button of its own, so callers compare with what showed before the gesture (`menuSince`).
    private func editMenu(_ app: XCUIApplication) -> [String] {
        ["Paste", "Select All", "Select", "Copy", "Cut", "AutoFill"].filter {
            app.menuItems[$0].exists || app.buttons.matching(NSPredicate(format: "label == %@", $0)).firstMatch.exists
        }
    }

    private func menuSince(_ app: XCUIApplication, _ before: [String]) -> [String] {
        editMenu(app).filter { !before.contains($0) }
    }

    func test1_theEmptyFieldOffersTheGuessWithItsHint() {
        let app = open("offered")
        let field = composer(app)
        note("offered: composer \(describe(field)); text views \(app.textViews.count)")
        tree(app, "offered")
        shot("01-offered")
        if !value(field).isEmpty { XCTFail("offered: the field is not empty: \(value(field))") }
        if app.keyboards.count > 0 { XCTFail("offered: a keyboard is up before any tap") }
    }

    func test2_aSingleTapFocusesAndLeavesTheGuessThenADoubleTapTakesIt() {
        let app = open("single")
        let before = editMenu(app)
        composer(app).tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 6) { XCTFail("single tap: no keyboard") }
        settle(1)
        let field = composer(app)
        if !value(field).isEmpty { XCTFail("single tap filled the field: \(value(field))") }
        note("single tap: composer \(describe(field)); edit menu \(editMenu(app))")
        shot("02-single-tap")

        // The keyboard up, a double-tap takes it — four times over, emptying the field in between, so a
        // race between the double-tap and the editing field's own gestures cannot pass by luck.
        for round in 1...4 {
            composer(app).doubleTap()
            let filled = waitForValue(app, suggestion)
            settle(1.2)
            let menu = menuSince(app, before)
            note("round \(round), keyboard up: filled=\(filled) value=\(value(composer(app))) new edit menu \(menu)")
            if !filled { XCTFail("round \(round), double-tap with the keyboard up: value \(value(composer(app)))") }
            if !menu.isEmpty { XCTFail("round \(round): an edit menu is up after the double-tap: \(menu)") }
            if round == 1 { tree(app, "double-tap-keyboard-up"); shot("03-double-tap-keyboard-up") }
            composer(app).typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8))
            if !waitForValue(app, "") { XCTFail("round \(round): deleting left \(value(composer(app)))") }
            settle(1)
        }
    }

    func test3_aDoubleTapOnTheIdleFieldFillsItAndTheHintIsLearned() {
        let app = open("double")
        let before = editMenu(app)
        composer(app).doubleTap()
        if !waitForValue(app, suggestion) { XCTFail("double-tap: value \(value(composer(app)))") }
        if !app.keyboards.firstMatch.waitForExistence(timeout: 6) { XCTFail("double-tap: no keyboard") }
        settle(1.2)
        let menu = menuSince(app, before)
        note("double-tap on the idle field: new edit menu \(menu) (before: \(before))")
        if !menu.isEmpty { XCTFail("an edit menu is up after the double-tap: \(menu)") }
        shot("04-double-tap-idle")

        // The caret ends after the words: typing carries on from them.
        composer(app).typeText(" now")
        if !waitForValue(app, suggestion + " now") { XCTFail("typing after the fill: value \(value(composer(app)))") }
        shot("05-typed-after")

        // Emptied again, the guess comes back, without "Double-tap to use" now that it has been learned.
        composer(app).typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12))
        if !waitForValue(app, "") { XCTFail("deleting: value \(value(composer(app)))") }
        settle(1.2)
        shot("06-learned")

        // Twice more from an idle field: the keyboard put away by a tap on the transcript first.
        for round in 2...3 {
            app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
            let down = Date().addingTimeInterval(6)
            while app.keyboards.count > 0 && Date() < down { Thread.sleep(forTimeInterval: 0.25) }
            settle(1)
            note("round \(round): keyboards before the double-tap \(app.keyboards.count)")
            composer(app).doubleTap()
            let filled = waitForValue(app, suggestion)
            settle(1.2)
            let after = menuSince(app, before)
            note("round \(round), idle field: filled=\(filled) value=\(value(composer(app))) new edit menu \(after)")
            if !filled { XCTFail("round \(round), double-tap on the idle field: value \(value(composer(app)))") }
            if !after.isEmpty { XCTFail("round \(round): an edit menu is up after the double-tap: \(after)") }
            composer(app).typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8))
            _ = waitForValue(app, "")
        }
    }

    func test4_dark() {
        _ = open(dark: true, "dark")
        shot("07-dark")
    }

    func test5_aLongGuess() {
        let app = open(suggestion: longSuggestion, "long")
        shot("08-long")
        composer(app).doubleTap()
        if !waitForValue(app, longSuggestion) { XCTFail("long: value \(value(composer(app)))") }
        settle(1.2)
        shot("09-long-filled")
    }

    func test6_pasteComesOnAPressAndHold() {
        UIPasteboard.general.string = "pasted words"
        let app = open("paste")
        let before = editMenu(app)
        composer(app).tap()
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 6)
        settle(1.5)
        // A second, separate tap on the empty field: the field's own tap waits on the double-tap and
        // then only focuses — no menu, and nothing filled.
        composer(app).tap()
        settle(1.5)
        let afterTap = menuSince(app, before)
        note("a second, separate tap on the empty field: new edit menu \(afterTap); value \(value(composer(app)))")
        if !value(composer(app)).isEmpty { XCTFail("two separate taps filled the field: \(value(composer(app)))") }
        // A press and hold brings Paste.
        composer(app).press(forDuration: 1.2)
        settle(1.5)
        let afterHold = menuSince(app, before)
        note("press and hold on the empty field: new edit menu \(afterHold); value \(value(composer(app)))")
        tree(app, "paste")
        shot("10-paste-menu")
        if !value(composer(app)).isEmpty { XCTFail("the press and hold filled the field: \(value(composer(app)))") }
        if !afterHold.contains("Paste") { XCTFail("a press and hold brought no Paste: \(afterHold)") }
    }
}
