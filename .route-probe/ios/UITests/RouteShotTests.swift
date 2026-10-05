import XCTest
import UIKit

// TEMPORARY evidence probe (never merged): smart model selection on a phone, against `stub.py` —
// the task detail's Suggested row, Model row and coordinator note; the Suggested menu, and a tier
// picked from it (the PATCH it sends is in requests.log); the Runs rows with their tier tags and the
// shadow line; the Why sheet; the Agent's Task runs switch; and the task run's composer chip and its
// menu. Each test launches straight into its surface and photographs it; notes beside each picture
// say what the accessibility tree exposed.
final class RouteShotTests: ProbeCase {

    // MARK: task detail helpers

    /// A menu picker's row: a button whose label begins with the picker's title.
    func picker(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        let asButton = button(app, beginning: title)
        return asButton.exists ? asButton : text(app, title)
    }

    /// The Suggested row's menu (f6d57aa5e: `LabeledContent("Suggested") { Menu … }`): the button in the
    /// row whose label is the current tier, e.g. "M · Sonnet 5.5 · medium".
    func suggestedMenu(_ app: XCUIApplication) -> XCUIElement {
        let cell = suggestedCell(app)
        if cell.exists, cell.buttons.firstMatch.exists { return cell.buttons.firstMatch }
        let tier = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'S · ' OR label BEGINSWITH 'M · ' "
            + "OR label BEGINSWITH 'L · ' OR label BEGINSWITH 'XL · ' OR label == 'No suggestion'")).firstMatch
        return tier.exists ? tier : button(app, beginning: "Suggested")
    }

    func suggestedCell(_ app: XCUIApplication) -> XCUIElement {
        app.cells.containing(NSPredicate(format: "label == %@", "Suggested")).firstMatch
    }

    /// An item of an open menu: the hittable element whose label begins with these words.
    func menuItem(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        let query = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", words))
        let all = query.allElementsBoundByIndex
        for type in [XCUIElement.ElementType.button, .`switch`, .menuItem, .cell] {
            if let hit = all.first(where: { $0.elementType == type && $0.isHittable }) { return hit }
        }
        return all.first(where: { $0.isHittable }) ?? query.firstMatch
    }

    /// The Details card in the upper half: Assignee near the top, so the card and the grey lines
    /// under it (the coordinator's reason, the created line) are all on screen.
    func details(_ app: XCUIApplication, _ name: String) {
        bring(app, picker(app, "Assignee"), between: 150, and: app.windows.firstMatch.frame.height * 0.42,
              missingIsAbove: false, name)
        settle(1.2)
    }

    func noteDetails(_ app: XCUIApplication, _ name: String) {
        for title in ["Assignee", "Provider", "Model", "List"] {
            note("\(name) \(title) row: \(describe(picker(app, title)))")
        }
        note("\(name) Suggested label: \(describe(text(app, "Suggested")))")
        note("\(name) Suggested cell: \(describe(suggestedCell(app)))")
        note("\(name) Suggested menu button: \(describe(suggestedMenu(app)))")
        note("\(name) coordinator line: \(describe(text(app, "Coordinator:")))")
        note("\(name) created line: \(describe(text(app, "Created")))")
    }

    /// A run row's list cell, or its button where cells aren't exposed.
    func runCell(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        let cell = app.cells.containing(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
        if cell.exists { return cell }
        return app.buttons.matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    /// Runs on screen: the shadow run (the last row) above the comment box, the two before it above.
    func runs(_ app: XCUIApplication, _ name: String) {
        let height = app.windows.firstMatch.frame.height
        bring(app, containing(app, "would have picked"), between: 260, and: height - 150,
              missingIsAbove: false, name)
        settle(1.2)
    }

    func noteRuns(_ app: XCUIApplication, _ name: String) {
        for state in ["Running", "Failed", "Ended"] {
            let buttons = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", state)).allElementsBoundByIndex
            for b in buttons { note("\(name) run \(state) button: \(describe(b))") }
        }
        for why in app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Why ")).allElementsBoundByIndex {
            note("\(name) ⓘ: \(describe(why))")
        }
        for tag in ["✦ L ↑", "✦ M", "Smart selection would have picked"] {
            let matches = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", tag))
                .allElementsBoundByIndex
            note("\(name) '\(tag)': \(matches.count) element(s) — \(matches.prefix(3).map { self.describe($0) }.joined(separator: " | "))")
        }
    }

    // MARK: 1–4: the task detail

    /// Details: Suggested under Assignee, Model "✦ Smart selection", "Coordinator: …" under the card.
    func test1TaskDetails() {
        let app = launch("task", until: "Suggested", "1-task-details")
        shot("0-task-top")
        details(app, "1-task-details")
        shot("1-task-details")
        tree(app, "1-task-details")
        noteDetails(app, "1-task-details")
        shot(suggestedCell(app).exists ? suggestedCell(app) : suggestedMenu(app), "1b-suggested-row")
        shot(picker(app, "Model"), "1c-model-row")
        XCTAssertTrue(text(app, "Coordinator: one service plus its spec").exists, "the coordinator's reason under the card")
        app.terminate()
    }

    /// The Suggested menu open — do the tiers' detail lines show as subtitles? — then L picked from
    /// it: the PATCH body is in requests.log, and the row and the note under the card follow it.
    func test2SuggestedMenu() {
        let app = launch("task", until: "Suggested", "2-suggested-menu")
        details(app, "2-suggested-menu")
        let row = suggestedMenu(app)
        note("before: \(describe(row))")
        row.tap()
        // ee756e12c: menu titles are TaskDetailLogic.menuTitle — every space no-break but the one after a "·".
        let noSuggestion = app.descendants(matching: .any).matching(NSPredicate(
            format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "No\u{00A0}suggestion", "No suggestion")).firstMatch
        if !noSuggestion.waitForExistence(timeout: 8) {
            note("the menu never showed No suggestion")
            write(app.debugDescription, "missing-suggested-menu.txt")
        }
        settle(1.0)
        shot("2-suggested-menu")
        tree(app, "2-suggested-menu")
        // 7e35c466d puts a no-break space before each "·" of a menu title.
        for words in ["No\u{00A0}suggestion", "S\u{00A0}· Sonnet\u{00A0}5.5\u{00A0}· low",
                      "M\u{00A0}· Sonnet\u{00A0}5.5\u{00A0}· medium", "L\u{00A0}· Opus\u{00A0}5.5\u{00A0}· high",
                      "XL\u{00A0}· Opus\u{00A0}5.5\u{00A0}· max", "No suggestion", "M · ", "L · ",
                      "Keeps the agent", "Rename, copy", "A clear feature", "Unknown root cause", "Architecture, design"] {
            let matches = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words))
                .allElementsBoundByIndex
            note("menu '\(words)': \(matches.count) — \(matches.prefix(3).map { self.describe($0) }.joined(separator: " | "))")
        }
        var item = menuItem(app, "L\u{00A0}· Opus")
        if !item.exists { item = menuItem(app, "L · Opus") }
        if item.exists {
            note("tapping \(describe(item))")
            item.tap()
        } else {
            note("no L item to tap")
            write(app.debugDescription, "missing-L-item.txt")
        }
        settle(4)
        details(app, "2b-picked-L")
        shot("2b-picked-L")
        tree(app, "2b-picked-L")
        noteDetails(app, "2b-picked-L")
        let patches = requestsLog().split(separator: "\n").filter { $0.contains("PATCH") }
        note("PATCH lines in requests.log:\n" + patches.joined(separator: "\n"))
        XCTAssertTrue(patches.contains { $0.contains("\"modelHint\":\"L\"") }, "the pick PATCHes modelHint L")
        app.terminate()
    }

    /// Runs: "✦ L ↑" amber on run 2, "✦ M" on run 1, the purple shadow line on run 0, ⓘ and › each.
    func test3Runs() {
        let app = launch("task", until: "Suggested", "3-runs")
        runs(app, "3-runs")
        shot("3-runs")
        tree(app, "3-runs")
        noteRuns(app, "3-runs")
        // By what each ran on: the status words also appear in the page's header.
        shot(runCell(app, "· Opus 5.5 · high"), "3b-run2-row")
        shot(runCell(app, "· Sonnet 5.5 · medium"), "3c-run1-row")
        shot(runCell(app, "· Opus 5.5 · max"), "3d-run0-shadow-row")
        app.terminate()
    }

    /// ⓘ on run 2: the Why sheet — its reasons as written and "Policy v1 · decided …".
    func test4WhySheet() {
        let app = launch("task", until: "Suggested", "4-why-sheet")
        runs(app, "4-why-sheet")
        let why = app.buttons["Why Opus 5.5 · high"]
        if why.waitForExistence(timeout: 5) {
            note("tapping \(describe(why))")
            why.tap()
        } else {
            note("no ⓘ labelled Why Opus 5.5 · high")
            write(app.debugDescription, "missing-why.txt")
        }
        if !text(app, "Policy v1").waitForExistence(timeout: 8) { note("the sheet's footer never showed") }
        settle(1.5)
        shot("4-why-sheet")
        tree(app, "4-why-sheet")
        for words in ["Why ", "Tier L", "Run 1 started", "Engine claude", "Policy v1", "Done"] {
            note("why '\(words)': \(describe(containing(app, words)))")
        }
        app.terminate()
    }

    // MARK: 5: the Agent's settings

    /// The Task runs section: the switch, on, with its sentence; then turned off and Done — the
    /// PATCH carries modelRouting false.
    func test5AgentSettings() {
        let app = launch("agent", until: "Smart model selection", "5-agent-settings")
        let height = app.windows.firstMatch.frame.height
        let toggle = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", "Smart model selection")).firstMatch
        let target = toggle.exists ? toggle : text(app, "Smart model selection")
        bring(app, target, between: 200, and: height - 60, missingIsAbove: false, "5-agent-settings")
        settle(1.2)
        shot("5-agent-settings")
        tree(app, "5-agent-settings")
        note("switch: \(describe(toggle))")
        note("section header: \(describe(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", "Task runs")).firstMatch))")
        let cell = app.cells.containing(NSPredicate(format: "label BEGINSWITH %@", "Smart model selection")).firstMatch
        shot(cell.exists ? cell : target, "5b-task-runs-cell")
        if toggle.exists {
            let inner = toggle.switches.firstMatch
            if inner.exists && inner.isHittable {
                inner.tap()
            } else {
                toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
            }
            settle(1)
            note("switch after the tap: \(describe(toggle))")
            let done = app.buttons["Done"]
            if done.waitForExistence(timeout: 5) { done.tap() } else { note("no Done") }
            settle(3)
            let patches = requestsLog().split(separator: "\n").filter { $0.contains("PATCH") }
            note("PATCH lines in requests.log:\n" + patches.joined(separator: "\n"))
        }
        app.terminate()
    }

    // MARK: 6–7: the task run's composer

    /// The composer's model chip on a task run still on its routed model: ✦ on a light blue ground.
    /// Then its menu: why, the note, and "Open task ›" at the end.
    func test6Composer() {
        // f6d57aa5e names the chip aloud: "Model Opus 5.5, effort High, picked by smart selection".
        let app = launch("console", until: "picked by smart selection", "6-composer-chip")
        settle(3)
        let height = app.windows.firstMatch.frame.height
        var chips = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model ")).allElementsBoundByIndex
            .filter { $0.exists && $0.frame.minY > height * 0.5 }
        if chips.isEmpty {
            chips = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Opus")).allElementsBoundByIndex
                .filter { $0.exists && $0.frame.minY > height * 0.5 }
        }
        for c in chips { note("chip candidate: \(describe(c))") }
        shot("6-composer-chip")
        tree(app, "6-composer-chip")
        bottomBand("6b-composer-zoom", from: 0.70)
        guard let chip = chips.first else {
            note("no model chip in the lower half")
            write(app.debugDescription, "missing-chip.txt")
            app.terminate()
            return
        }
        shot(chip, "6c-composer-chip-alone")
        chip.tap()
        if !text(app, "✦ Picked by smart selection").waitForExistence(timeout: 8) {
            note("the menu never showed ✦ Picked by smart selection")
        }
        settle(1.2)
        shot("7-composer-menu")
        tree(app, "7-composer-menu")
        for words in ["✦ Picked by smart selection", "Tier L: one above run 1", "Changing the model here",
                      "To fix the model for every run", "Opus 5.5", "Sonnet 5.5", "Effort", "Open task"] {
            let matches = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words))
                .allElementsBoundByIndex
            note("menu '\(words)': \(matches.count) — \(matches.prefix(3).map { self.describe($0) }.joined(separator: " | "))")
        }
        // Open task › ends the menu, below its fold on a phone (run 1): scroll the menu by dragging
        // from the note — a row with no action — up and out of the menu, so the release selects
        // nothing.
        var open = menuItem(app, "Open task")
        note("Open task before scrolling: \(describe(open))")
        let noteRow = menuItem(app, "Changing the model here")
        if open.exists, !open.isHittable, noteRow.exists {
            let start = noteRow.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -260)),
                        withVelocity: .fast, thenHoldForDuration: 0)
            settle(1.2)
            open = menuItem(app, "Open task")
            note("Open task after scrolling: \(describe(open))")
            shot("7c-composer-menu-end")
            tree(app, "7c-composer-menu-end")
        }
        // Open task › pushes the task over the conversation on a phone (f6d57aa5e).
        if open.exists {
            note("tapping \(describe(open))")
            open.tap()
            if !containing(app, "Suggested").waitForExistence(timeout: 15) { note("no task page after Open task") }
            settle(2.5)
            shot("7b-open-task")
            tree(app, "7b-open-task")
            note("back button: \(describe(app.navigationBars.buttons.firstMatch))")
        } else {
            note("no Open task item to tap")
        }
        app.terminate()
    }

    /// The lower part of the screen alone, at full resolution: the composer and what sits on it.
    func bottomBand(_ name: String, from fraction: CGFloat) {
        let screenshot = XCUIScreen.main.screenshot()
        guard let cg = screenshot.image.cgImage else { note("\(name): no image"); return }
        let top = Int(CGFloat(cg.height) * fraction)
        guard let cropped = cg.cropping(to: CGRect(x: 0, y: top, width: cg.width, height: cg.height - top)),
              let png = UIImage(cgImage: cropped).pngData() else { note("\(name): crop failed"); return }
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    // MARK: 8: dark

    func test8TaskDetailDark() {
        let app = launch("task", dark: true, until: "Suggested", "8-dark")
        details(app, "8-task-details-dark")
        shot("8-task-details-dark")
        runs(app, "8-runs-dark")
        shot("8b-runs-dark")
        app.terminate()
    }
}
