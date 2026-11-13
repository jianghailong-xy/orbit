import XCTest

// TEMPORARY evidence probe (task 34vZvzdK0NZaSo0JNQ2ES, never merged): the main checkout card, bar, review sheet,
// result lines and worktree isolation dialogs in the iPhone and Mac apps' own views, against .mc-probe/stub.py.
// Each launch opens one place; a surface that never shows is a failure, with the element tree kept beside it.
final class MainCheckoutShotTests: ProbeCase {
    private let cardTitle = "3 files changed in the main checkout during this turn"

    private func open(session: String? = nil, form agent: String? = nil, until words: String, _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        var args = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES", "-probe.fresh",
                    "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        if let session { args += ["-probe.session", session, "-probe.agent", session == "S1" ? "a2" : "a1"] }
        if let agent { args += ["-probe.surface", "form", "-probe.agent", agent] }
        app.launchArguments = args
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        if !app.windows.firstMatch.waitForExistence(timeout: 30) {
            note("\(name): no window after launch; File > New Window")
            app.typeKey("n", modifierFlags: .command)
        }
        #endif
        if !appears(app, words, timeout: 150) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(words) never showed")
        }
        settle(2.5)
        return app
    }

    private func press(_ element: XCUIElement) {
        #if os(macOS)
        element.click()
        #else
        element.tap()
        #endif
    }

    private func expect(_ app: XCUIApplication, _ words: String, _ name: String, timeout: TimeInterval = 20) {
        if !appears(app, words, timeout: timeout) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): nothing says \(words)")
        }
    }

    /// Board 01: the card at the end of a worktree turn, and the Main checkout bar above the composer.
    func test01CardAndBar() {
        let app = open(session: "W1", until: cardTitle, "card")
        expect(app, "Move to this worktree", "card-move")
        expect(app, "Review and commit to main", "card-review")
        expect(app, "3 uncommitted", "bar-status")
        shot("01-card-and-bar")
        let more = app.buttons.matching(NSPredicate(format: "label == 'More'")).firstMatch
        if more.waitForExistence(timeout: 5) {
            press(more)
            settle(1.5)
            expect(app, "Save to a rescue branch and clean", "card-menu")
            shot("01b-card-menu")
        } else {
            note("card: no More button")
            tree(app, "card")
        }
        #if os(macOS)
        // The console beside the session list is narrow; fold the source list for the wide frame too.
        app.typeKey(.escape, modifierFlags: [])
        settle(1)
        app.typeKey("s", modifierFlags: [.control, .command])
        settle(2)
        shot("01c-card-and-bar-wide")
        #endif
    }

    /// Board 02: Review on the bar opens the review sheet — every file chosen, the first one's diff, the
    /// managed-branch warning, the commit message, Commit / Move to a worktree / ⋯.
    func test02ReviewSheet() {
        let app = open(session: "W1", until: "3 uncommitted", "sheet")
        let review = app.buttons.matching(NSPredicate(format: "label == 'Review'")).firstMatch
        guard review.waitForExistence(timeout: 20) else {
            tree(app, "sheet-no-review"); return XCTFail("sheet: no Review on the bar")
        }
        press(review)
        expect(app, "Choose files to commit · 3 of 3", "sheet-files", timeout: 30)
        expect(app, "This skips project Runner link v1's landing check.", "sheet-managed")
        expect(app, "Commit 3 files to main", "sheet-commit")
        settle(2)
        shot("02-review-sheet")
        // Uncheck one file: the count and the button follow.
        let box = app.buttons.matching(NSPredicate(format: "label == 'src/api/retry.test.ts'")).firstMatch
        if box.waitForExistence(timeout: 5) {
            press(box)
            expect(app, "Choose files to commit · 2 of 3", "sheet-2of3")
            expect(app, "Commit 2 files to main", "sheet-commit-2")
            shot("02b-review-sheet-2-of-3")
        } else {
            note("sheet: no checkbox for src/api/retry.test.ts")
        }
        let move = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Move to a worktree'")).firstMatch
        if move.waitForExistence(timeout: 5) {
            press(move)
            settle(1.5)
            expect(app, "Fix retry backoff · orbit/fix-retry-backoff", "sheet-targets")
            shot("02c-move-targets")
        } else {
            note("sheet: no Move to a worktree")
        }
    }

    /// Board 03: success lines.
    func test03SuccessLines() {
        let app = open(session: "R1", until: "Committed 3 files to main", "success")
        expect(app, "Moved 3 files into this worktree.", "success-move")
        expect(app, "Pushed main to origin", "success-push")
        expect(app, "Saved 3 files to orbit/rescue-5f2c1a9", "success-rescue")
        shot("03-success-lines")
    }

    /// Board 03: refusal lines (nothing changed) and the waiting line.
    func test04RefusalLines() {
        let app = open(session: "R2", until: "Push rejected:", "refusal")
        expect(app, "the main checkout changed since you looked", "refusal-stale")
        expect(app, "Waiting for the runner", "refusal-waiting")
        shot("04-refusal-lines")
    }

    /// Board 02④: a Shared session gets the same bar, with Review and commit….
    func test05SharedBar() {
        let app = open(session: "S1", until: "Rewrote the install section", "shared")
        expect(app, "3 uncommitted", "shared-bar")
        expect(app, "Review and commit…", "shared-review")
        shot("05-shared-bar")
    }

    private func flipSwitch(_ app: XCUIApplication, _ name: String) {
        let predicate = NSPredicate(format: "label BEGINSWITH 'Worktree isolation'")
        #if os(macOS)
        // A Mac Form's switch carries no label of its own: take the one level with the row's title.
        let title = app.staticTexts.matching(NSPredicate(format: "value == 'Worktree isolation'")).firstMatch
        guard title.waitForExistence(timeout: 20) else { tree(app, name); return XCTFail("\(name): no row") }
        let row = title.frame
        guard let toggle = app.switches.allElementsBoundByIndex.first(where: { abs($0.frame.minY - row.minY) < 14 }) else {
            tree(app, name); return XCTFail("\(name): no switch beside \(row)")
        }
        note("\(name): switch \(describe(toggle))")
        toggle.click()
        #else
        let toggle = app.switches.matching(predicate).firstMatch
        guard toggle.waitForExistence(timeout: 20) else { tree(app, name); return XCTFail("\(name): no switch") }
        note("\(name): switch \(describe(toggle))")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        #endif
        settle(1.5)
    }

    /// Board 04 A: turning isolation on while the main checkout holds uncommitted files.
    func test06IsolationOnDialog() {
        let app = open(form: "a2", until: "Worktree isolation", "iso-on")
        flipSwitch(app, "iso-on")
        expect(app, "Turn on worktree isolation?", "iso-on-title")
        expect(app, "New sessions start from the last commit on main", "iso-on-body")
        shot("06-isolation-on-dialog")
    }

    /// Board 04 B: turning it off while sessions still have worktrees.
    func test07IsolationOffDialog() {
        let app = open(form: "a1", until: "Worktree isolation", "iso-off")
        flipSwitch(app, "iso-off")
        expect(app, "Turn off worktree isolation?", "iso-off-title")
        expect(app, "sessions with unmerged worktrees keep them", "iso-off-body")
        shot("07-isolation-off-dialog")
    }
}
