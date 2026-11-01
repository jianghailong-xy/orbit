import XCTest

// TEMPORARY evidence probe (never merged): the Claude region check in the iPhone app's own screens, against
// .rgn-probe/stub.py (task 34pVMqwUhJE0RGvrL0ziL, docs/claude-region-check-contract.md, board 03 of
// docs/mocks/claude-region-check). HPC's Claude connection comes out in mainland China. Each test opens one place:
// the held conversation and its card (and each of the card's three presses), the composer's Provider menu, the
// workspace's session list, HPC's page and its Claude Code page. A word the board says that the screen does not,
// a press that never reaches the stub, or a layout the board does not draw is a failure, not a note.
final class RegionShotTests: ProbeCase {
    private let title = "This run never started"
    private let why = "Claude Code can’t use Anthropic on HPC"
    private let body = "HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude."
    private let subject = "CLAUDE_REGION_UNSUPPORTED · CN"
    private let checkLine = "· Claude’s connection: mainland China (no proxy)"
    private let foot = "No engine ran · your message is still here"
    private let otherProvider = "Use another provider"
    private let moveIt = "Move to another machine"
    private let checkAgain = "Check again"
    private let attention = "Claude Code can’t use Anthropic here"
    private let attentionDetail = "Anthropic doesn’t offer Claude in mainland China."
    private let note = "Claude’s connection from this machine is in mainland China, where Anthropic doesn’t offer Claude, so Orbit won’t use Anthropic accounts or keys here, or start a Claude sign-in. Claude Code still runs with other providers’ keys."
    private let checkAgainTitle = "Check Again"

    /// Launch onto one place and wait for `words`, in the zone run.sh picks. en_GB is a 24-hour English locale.
    private func open(_ args: [String], until words: String, _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.fresh", "-AppleLanguages", "(en)", "-AppleLocale", "en_GB"] + args
        app.launchEnvironment["TZ"] = ProcessInfo.processInfo.environment["PROBE_TZ"] ?? "Asia/Shanghai"
        app.launch()
        if !appears(app, words, timeout: 60) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(words) never showed — the app did not draw the stub's state")
        }
        settle(3)
        return app
    }

    private func expectText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for w in words where !containing(app, w).exists {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(w) is not on the screen")
        }
    }

    private func expectNoText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for w in words where containing(app, w).exists {
            write(app.debugDescription, "unexpected-\(name).txt")
            XCTFail("\(name): \(w) is on the screen, and should not be")
        }
    }

    private func exactButtons(_ app: XCUIApplication, _ label: String) -> [XCUIElement] {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex.filter(\.exists)
    }

    private func held(_ name: String) -> XCUIApplication {
        open(["-probe.session", "S1"], until: why, name)
    }

    // MARK: - the conversation (board 03, left)

    /// The card, word for word, with its three presses in the card's order, wrapping inside the card where a row
    /// can't hold them all (board 03: two rows on a phone). No coded line in the transcript.
    func test01TheCardOverTheHeldMessage() {
        let app = held("card")
        expectText(app, [title, why, body, "Supported regions", subject, checkLine, foot,
                         "Now do the same for the sign-up test."], "card")
        // The refusal is the card's to say: the transcript draws no red line with the code.
        let coded = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "CLAUDE_REGION_UNSUPPORTED:")).firstMatch
        if coded.exists { XCTFail("card: the transcript draws the coded refusal: \(describe(coded))") }
        let other = button(app, beginning: otherProvider), again = button(app, beginning: checkAgain)
        let move = button(app, beginning: moveIt)
        for (label, b) in [(otherProvider, other), (checkAgain, again), (moveIt, move)] {
            note("card: \(label) \(describe(b))")
            if !b.exists { XCTFail("card: no \(label)") }
        }
        if other.exists, again.exists, move.exists {
            // Read in the card's order: each next press is further along its row, or on a row below.
            let ordered = [other, move, again]
            for (a, b) in zip(ordered, ordered.dropFirst()) {
                let sameRow = abs(a.frame.midY - b.frame.midY) <= 2
                if sameRow ? b.frame.minX <= a.frame.maxX : b.frame.minY < a.frame.maxY {
                    XCTFail("card: \(b.label) does not follow \(a.label)")
                }
            }
            let rows = Set(ordered.map { Int($0.frame.midY.rounded()) }).count
            note("card: the presses take \(rows) row(s)")
            if rows < 2 { XCTFail("card: the three presses did not wrap on a phone") }
            let right = app.windows.firstMatch.frame.maxX
            for b in ordered where b.frame.maxX > right - 16 { XCTFail("card: \(b.label) runs past the card") }
        }
        for words in [title, foot, "Now do the same for the sign-up test."] {
            note("card: \(words) at \(containing(app, words).frame)")
        }
        // The card's band, for a close look cut from the screen's picture (compose.py).
        let top = containing(app, title).frame.minY, bottom = containing(app, foot).frame.maxY
        write("\(top) \(bottom)", "card-band.txt")
        shot("ios-01-card")
        tree(app, "card")
    }

    /// Check again: POST /runners/hpc/region-check, and the card's check line moves to the check it asked for.
    func test02CheckAgainOnTheCard() {
        let app = held("card-check")
        let again = button(app, beginning: checkAgain)
        guard again.waitForExistence(timeout: 10) else { XCTFail("card-check: no Check again"); return }
        again.tap()
        settle(6)
        expectRequest("POST /api/runners/hpc/region-check", "card-check")
        expectText(app, [why, subject, checkLine], "card-check")
        note("card-check: detail \(describe(containing(app, checkLine)))")
        shot("ios-02-card-after-check-again")
    }

    /// Use another provider: the credentials this Claude Code can move to here — DeepSeek and Local vLLM, not the
    /// Anthropic keys — and a pick is the session's provider PATCH.
    func test03UseAnotherProvider() {
        let app = held("other-provider")
        let other = button(app, beginning: otherProvider)
        guard other.waitForExistence(timeout: 10) else { XCTFail("other-provider: no Use another provider"); return }
        other.tap()
        settle(2)
        let alert = app.alerts.firstMatch
        note("other-provider: alert \(describe(alert))")
        for label in ["DeepSeek", "Local vLLM", "Cancel"] where !alert.buttons[label].exists {
            XCTFail("other-provider: the list has no \(label)")
        }
        for label in ["Personal Max", "Work", "Default"] where alert.buttons[label].exists {
            XCTFail("other-provider: the list offers \(label), which Anthropic is behind")
        }
        shot("ios-03-use-another-provider")
        alert.buttons["DeepSeek"].tap()
        settle(4)
        expectRequest("PATCH /api/sessions/S1/config", "other-provider")
        if !requestsLog().contains("\"provider\":\"deepseek\"") && !requestsLog().contains("\"provider\": \"deepseek\"") {
            XCTFail("other-provider: the PATCH did not carry provider deepseek")
        }
        // A held session has no turn in flight: the note says the waiting message runs on DeepSeek.
        expectText(app, ["Your next message uses DeepSeek."], "other-provider-note")
        expectNoText(app, ["The turn in flight finishes"], "other-provider-note")
        // With the note under the composer, the card's check line keeps its whole text: wrapped, not cut.
        let line = containing(app, checkLine)
        note("other-provider: check line after the pick \(describe(line))")
        if !line.exists {
            XCTFail("other-provider: no check line after the pick")
        } else if line.frame.height < 20 {
            XCTFail("other-provider: the check line is cut to one line (\(line.frame.height) pt)")
        }
        shot("ios-03b-after-deepseek")
    }

    /// Move to another machine: the session's Move panel.
    func test04MoveToAnotherMachine() {
        let app = held("move")
        let move = button(app, beginning: moveIt)
        guard move.waitForExistence(timeout: 10) else { XCTFail("move: no Move to another machine"); return }
        move.tap()
        if !app.navigationBars["Move"].waitForExistence(timeout: 15) {
            write(app.debugDescription, "missing-move.txt")
            XCTFail("move: the Move panel never opened")
        }
        settle(3)
        shot("ios-04-move")
    }

    /// The composer's Provider menu: the Anthropic credentials read Region not supported, and name no fix.
    func test05TheProviderMenu() {
        let app = held("provider-menu")
        let chip = button(app, beginning: "Model ")
        guard chip.waitForExistence(timeout: 20) else { XCTFail("provider-menu: no model chip"); tree(app, "provider-menu"); return }
        for attempt in 1...3 {
            chip.tap()
            if containing(app, "Provider").waitForExistence(timeout: 5) { note("provider-menu: menu after \(attempt)"); break }
        }
        settle(1.5)
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Provider'")).firstMatch
        note("provider-menu: Provider row \(describe(row))")
        for attempt in 1...3 {
            row.tap()
            if containing(app, "Region not supported").waitForExistence(timeout: 4) {
                note("provider-menu: submenu after \(attempt)")
                break
            }
            if !row.exists { chip.tap(); _ = row.waitForExistence(timeout: 5) }
        }
        settle(1.5)
        expectText(app, ["Personal Max — Region not supported", "Work — Region not supported", "DeepSeek", "Local vLLM"],
                   "provider-menu")
        expectNoText(app, ["sign in →", "Region not supported, "], "provider-menu")
        tree(app, "provider-menu")
        shot("ios-05-provider-menu")
    }

    // MARK: - the list

    /// The workspace's list: the held session says where Anthropic is unavailable.
    func test06TheSessionList() {
        let app = open(["-probe.list", "a1"], until: "Anthropic unavailable on HPC", "list")
        expectText(app, ["Fix the flaky login test", "Anthropic unavailable on HPC"], "list")
        shot("ios-06-session-list")
    }

    // MARK: - the machine page (board 03, middle)

    /// HPC's page: the attention line with Check Again, Claude Code's row saying Region not supported with Check
    /// Again in Sign In's place, and the note under the engines.
    func test07TheMachinePage() {
        let app = open(["-probe.machine", "runner"], until: attention, "machine")
        expectText(app, [attention, attentionDetail, "Region not supported", "Codex"], "machine")
        let checks = exactButtons(app, checkAgainTitle)
        note("machine: Check Again buttons " + checks.map(describe).joined(separator: " | "))
        if checks.count != 2 { XCTFail("machine: \(checks.count) Check Again buttons, not two (the attention item and the Claude Code row)") }
        shot("ios-07-machine-page")
        // The note under the engines, then the Claude Code row's own Check Again.
        let footnote = containing(app, "Claude’s connection from this machine is in mainland China")
        bring(app, footnote, between: 120, and: 760, missingIsAbove: false, "machine-note")
        expectText(app, [note, "Supported regions", "Claude’s connection: mainland China (no proxy)", "Kimi Code",
                         "Antigravity CLI"], "machine-note")
        note("machine: footnote \(describe(footnote))")
        shot("ios-07b-machine-engines-note")
        let rowCheck = exactButtons(app, checkAgainTitle).filter(\.isHittable).max { $0.frame.minY < $1.frame.minY }
        guard let rowCheck else { XCTFail("machine: no Check Again under the Claude Code row"); return }
        note("machine: pressing \(describe(rowCheck))")
        rowCheck.tap()
        settle(5)
        expectRequest("POST /api/runners/hpc/region-check", "machine-check")
        // A press of its own: the row's Check Again does not open the Claude Code page.
        if !app.navigationBars["HPC"].exists {
            write(app.debugDescription, "unexpected-push.txt")
            XCTFail("machine: Check Again opened another page")
        }
        shot("ios-07c-machine-after-check-again")
    }

    /// Claude Code's page on HPC: its accounts kept, signed in, with no Add Account, no Sign In and no quota, and
    /// Check Again in Add Account's place, over the note.
    func test08TheClaudeCodePage() {
        let app = open(["-probe.machine", "claude"], until: "Accounts", "engine")
        expectText(app, ["Personal", "Work", "Team", "Signed in", "Region not supported"], "engine")
        expectNoText(app, ["Add Account", "Sign In Again", "No quota reported", "NEXT"], "engine")
        if exactButtons(app, checkAgainTitle).isEmpty { XCTFail("engine: no Check Again") }
        shot("ios-08-claude-code-page")
        let footnote = containing(app, "Claude’s connection from this machine is in mainland China")
        bring(app, footnote, between: 120, and: 760, missingIsAbove: false, "engine-note")
        expectText(app, [note, "Claude’s connection: mainland China (no proxy)"], "engine-note")
        shot("ios-08b-claude-code-page-note")
    }
}
