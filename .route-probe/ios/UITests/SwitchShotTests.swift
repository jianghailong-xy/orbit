import XCTest
import UIKit

// TEMPORARY evidence probe (never merged): the account's master switch for smart model selection
// (preferences.modelRouting, off unless true) on a phone, against `stub.py`. Each surface is launched
// twice, the account's switch off (the key absent, as on an account that never touched it) and on:
// Settings and its switch (and the PATCH flipping it sends), the task page's Details and Runs, and the
// Agent's settings sheet. Off, none of smart selection's entries may show; on, they are as before.
final class SwitchShotTests: ProbeCase {

    // MARK: helpers

    func settingsSwitch(_ app: XCUIApplication) -> XCUIElement {
        app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", "Smart model selection")).firstMatch
    }

    func picker(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        let asButton = button(app, beginning: title)
        return asButton.exists ? asButton : text(app, title)
    }

    func count(_ app: XCUIApplication, _ words: String) -> Int {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).count
    }

    func noteAll(_ app: XCUIApplication, _ name: String, _ words: [String]) {
        for w in words { note("\(name) '\(w)': \(count(app, w)) element(s) — \(describe(containing(app, w)))") }
    }

    /// The Details card with Assignee near the top.
    func details(_ app: XCUIApplication, _ name: String) {
        bring(app, picker(app, "Assignee"), between: 150, and: app.windows.firstMatch.frame.height * 0.42,
              missingIsAbove: false, name)
        settle(1.2)
    }

    /// The Runs on screen: the oldest run (the last row, the one that only shadowed) above the comment box.
    func runs(_ app: XCUIApplication, _ name: String) {
        let height = app.windows.firstMatch.frame.height
        let last = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Opus 5.5 · max")).firstMatch
        bring(app, last.exists ? last : containing(app, "Opus 5.5 · max"), between: 260, and: height - 150,
              missingIsAbove: false, name)
        settle(1.2)
    }

    /// Drag a form to its end: what would sit last on it is on screen.
    func toEnd(_ app: XCUIApplication) {
        let window = app.windows.firstMatch
        for _ in 0..<4 {
            let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.75))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -400)),
                        withVelocity: .fast, thenHoldForDuration: 0.4)
            settle(0.8)
        }
        settle(1)
    }

    // MARK: Settings

    /// Off: the switch reads off. Then flipped: the PATCH it sends is {"modelRouting":true} alone.
    func test1SettingsOff() {
        let app = launch("settings", modelRouting: false, until: "Smart model selection", "settings-off")
        let toggle = settingsSwitch(app)
        note("switch: \(describe(toggle))")
        shot("1-settings-off")
        tree(app, "1-settings-off")
        XCTAssertEqual(toggle.value as? String, "0", "absent is off")
        // A UISwitch's centre tap is sometimes swallowed on the simulator: tap, and if the value
        // didn't move, press its knob side, up to three times.
        let inner = toggle.switches.firstMatch
        for attempt in 1...3 where toggle.exists && (toggle.value as? String) == "0" {
            if attempt == 1, inner.exists, inner.isHittable { inner.tap() }
            else if inner.exists { inner.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.5)).tap() }
            else { toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap() }
            settle(1.5)
            note("after tap \(attempt): \(describe(toggle))")
        }
        settle(3)
        note("switch after the tap: \(describe(toggle))")
        shot("1b-settings-flipped-on")
        let patches = requestsLog().split(separator: "\n").filter { $0.contains("PATCH") }
        note("PATCH lines in requests.log:\n" + patches.joined(separator: "\n"))
        XCTAssertTrue(patches.contains { $0.contains("/api/users/me/preferences body: {\"modelRouting\":true}") },
                      "PATCH /users/me/preferences {modelRouting: true}")
        app.terminate()
    }

    func test2SettingsOn() {
        let app = launch("settings", modelRouting: true, until: "Smart model selection", "settings-on")
        let toggle = settingsSwitch(app)
        note("switch: \(describe(toggle))")
        shot("2-settings-on")
        tree(app, "2-settings-on")
        XCTAssertEqual(toggle.value as? String, "1")
        app.terminate()
    }

    // MARK: the task page

    func test3TaskOff() {
        let app = launch("task", modelRouting: false, until: "Assignee", "task-off")
        details(app, "task-off")
        shot("3-task-off-details")
        tree(app, "3-task-off-details")
        noteAll(app, "3-task-off-details", ["Suggested", "Smart selection", "Coordinator:", "Provider default"])
        XCTAssertEqual(count(app, "Suggested"), 0, "no Suggested row")
        XCTAssertEqual(count(app, "Smart selection"), 0, "no ✦ Smart selection placeholder")
        XCTAssertEqual(count(app, "Coordinator:"), 0, "no coordinator's reason")
        runs(app, "task-off-runs")
        shot("3b-task-off-runs")
        tree(app, "3b-task-off-runs")
        noteAll(app, "3b-task-off-runs", ["✦", "would have picked", "Why ", "Opus 5.5 · high", "Opus 5.5 · max"])
        XCTAssertEqual(count(app, "✦"), 0, "no tier tags, no purple line")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Why ")).count, 0, "no ⓘ Why")
        app.terminate()
    }

    func test4TaskOn() {
        let app = launch("task", modelRouting: true, until: "Suggested", "task-on")
        details(app, "task-on")
        shot("4-task-on-details")
        tree(app, "4-task-on-details")
        noteAll(app, "4-task-on-details", ["Suggested", "Smart selection", "Coordinator:"])
        XCTAssertGreaterThan(count(app, "Suggested"), 0)
        XCTAssertGreaterThan(count(app, "Smart selection"), 0)
        XCTAssertGreaterThan(count(app, "Coordinator:"), 0)
        runs(app, "task-on-runs")
        shot("4b-task-on-runs")
        tree(app, "4b-task-on-runs")
        noteAll(app, "4b-task-on-runs", ["✦ L ↑", "✦ M", "would have picked", "Why "])
        XCTAssertGreaterThan(count(app, "would have picked"), 0)
        XCTAssertGreaterThan(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Why ")).count, 0)
        app.terminate()
    }

    // MARK: the Agent's settings

    func test5AgentOff() {
        let app = launch("agent", modelRouting: false, until: "Effort", "agent-off")
        shot("5-agent-off-top")
        toEnd(app)
        shot("5b-agent-off-end")
        tree(app, "5b-agent-off-end")
        noteAll(app, "5b-agent-off-end", ["Task runs", "Smart model selection", "Working directory"])
        XCTAssertEqual(count(app, "Smart model selection for tasks"), 0, "no Task runs switch")
        app.terminate()
    }

    func test6AgentOn() {
        let app = launch("agent", modelRouting: true, until: "Smart model selection", "agent-on")
        shot("6-agent-on-top")
        toEnd(app)
        shot("6b-agent-on-end")
        tree(app, "6b-agent-on-end")
        noteAll(app, "6b-agent-on-end", ["Task runs", "Smart model selection", "Working directory"])
        XCTAssertGreaterThan(count(app, "Smart model selection for tasks"), 0)
        app.terminate()
    }

    // MARK: the task run's composer

    /// Off, the model chip on a task run still on its routed model is a plain chip — named without
    /// "picked by smart selection" — and its menu has no ✦ header.
    func test7ComposerOff() {
        let app = launch("console", modelRouting: false, until: "Model ", "composer-off")
        settle(3)
        let height = app.windows.firstMatch.frame.height
        let chip = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model ")).allElementsBoundByIndex
            .first { $0.exists && $0.frame.minY > height * 0.5 }
        note("chip: \(chip.map { describe($0) } ?? "(none)")")
        shot("7-composer-off")
        XCTAssertEqual(count(app, "picked by smart selection"), 0)
        if let chip {
            chip.tap()
            settle(2)
            shot("7b-composer-off-menu")
            tree(app, "7b-composer-off-menu")
            XCTAssertEqual(count(app, "Picked by smart selection"), 0, "no ✦ header in the menu")
        }
        app.terminate()
    }

    func test8ComposerOn() {
        let app = launch("console", modelRouting: true, until: "picked by smart selection", "composer-on")
        settle(3)
        shot("8-composer-on")
        XCTAssertGreaterThan(count(app, "picked by smart selection"), 0)
        app.terminate()
    }
}
