import XCTest

// TEMPORARY evidence probe (never merged): one conversation holding both kinds of interrupt — the
// owner's Stop (`requestId`) and the runner restart's (`reason: runner_restart`) — photographed on the
// tree before the change (both rows read "Interrupted") and after it (the restart's row says the runner
// restarted). The same launch and wait run on both trees, so each pair of pictures shows the same rows
// in the same place. Beside each picture, the notes give every interrupt row's words as the
// accessibility tree reads them.
final class InterruptShotTests: ProbeCase {
    /// The second answer's first words: once they show, both interrupts are on screen.
    private let tail = "The turns table"

    func test1Console() {
        for dark in [false, true] {
            let s = dark ? "dark" : "light"
            let app = launch("console", dark: dark, until: tail, "console-\(s)")
            settle(1.5)
            shot("1-interrupts-\(s)")
            for row in interruptRows(app) {
                note("\(s): \(describe(row))")
            }
            if !dark { tree(app, "console-\(s)") }
            app.terminate()
        }
    }

    /// Every element whose words begin "Interrupted": by label anywhere, and on the Mac also by the value
    /// of a text (a transcript row's words are its value there).
    private func interruptRows(_ app: XCUIApplication) -> [XCUIElement] {
        var rows = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Interrupted")).allElementsBoundByIndex
        #if os(macOS)
        rows += app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH %@", "Interrupted")).allElementsBoundByIndex
        #endif
        if rows.isEmpty { note("no element's words begin with Interrupted") }
        return rows.filter(\.exists)
    }
}
