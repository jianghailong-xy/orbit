import XCTest

// TEMPORARY evidence probe (never merged): sessions held by their runner's self-update
// (queuedReason runner_updating, board 5 of docs/mocks/runner-update-drain), photographed on the
// iPhone and the Mac against stub.py. Every claim is a note beside the picture; a missing state fails
// the test and the picture is kept anyway.
final class RupShotTests: ProbeCase {
    private let explanation = "It starts no new work until 2 turns finish"
    private let userText = "Tidy the release notes for 0.1.253"

    /// Shot A: Q1's console, empty transcript — the queued page.
    func test1QueuedPage() {
        let app = launch(until: explanation, timeout: 180, extra: ["-probe.session", "Q1"], "A-queued-page")
        note("A: full sentence: \(element(app, containing: "studio-mac is updating to 0.1.254. It starts no new work until 2 turns finish: Backfill missing shard rows and Why are 11-08 metrics zero. This session starts right after.").exists)")
        note("A: title Runner updating: \(element(app, containing: "Runner updating").exists)")
        note("A: Waiting 38 min: \(appears(app, "Waiting 38 min", timeout: 10))")
        note("A: foot tag (expected NO): \(element(app, containing: "runner updating").exists)")
        settle(2)
        shot(app, "A-queued-page")
        write(app.debugDescription, "tree-A-queued-page.txt")
    }

    /// Shot B: Q2's console, one user message + one reply — the foot row, then its popover.
    func test2FootRow() {
        let app = launch(until: userText, timeout: 180, extra: ["-probe.session", "Q2"], "B-foot-row")
        let tagShown = appears(app, "runner updating", timeout: 20)
        note("B: tag shown: \(tagShown)")
        note("B: Queued word: \(element(app, containing: "Queued").exists)")
        note("B: queued page (expected NO): \(element(app, containing: explanation).exists)")
        settle(2)
        shot(app, "B-foot-row")
        write(app.debugDescription, "tree-B-foot-row.txt")

        let popWords = "This message is sent right after"
        for attempt in 1...3 {
            pressTag(app, attempt)
            if appears(app, popWords, timeout: 12) { break }
        }
        let popShown = element(app, containing: popWords).exists
        note("B: popover shown: \(popShown)")
        note("B: popover text: \(element(app, containing: "studio-mac starts no new turns until 2 turns finish, then updates to 0.1.254. This message is sent right after.").exists)")
        note("B: popover wait: \(element(app, containing: "Waiting 38 min.").exists)")
        settle(1.5)
        #if os(macOS)
        screen("B-popover")
        #else
        shot(app, "B-popover")
        #endif
        write(app.debugDescription, "tree-B-popover.txt")
        if !popShown { XCTFail("the tag's popover never opened") }
    }

    /// Shot C: the workspace's session list — Q1 and Q2 read Runner updating.
    func test3List() {
        let app = launch(until: "Why is the send stuck", timeout: 180, "C-list")
        note("C: Runner updating line: \(appears(app, "Runner updating", timeout: 20))")
        settle(2)
        shot(app, "C-list")
        write(app.debugDescription, "tree-C-list.txt")
    }

    /// The tag's own button where the tree exposes it; else a press just right of the "Queued" word
    /// its identifier lands on.
    private func pressTag(_ app: XCUIApplication, _ attempt: Int) {
        let exact = NSPredicate(format: "label == %@", "runner updating")
        let button = app.buttons.matching(exact).firstMatch
        if button.exists {
            note("B: press #\(attempt) on the button at \(button.frame)")
            press(button)
            return
        }
        let text = app.staticTexts.matching(exact).firstMatch
        if text.exists {
            note("B: press #\(attempt) on the static text at \(text.frame)")
            press(text)
            return
        }
        #if os(macOS)
        let byValue = app.staticTexts.matching(NSPredicate(format: "value == %@", "runner updating")).firstMatch
        if byValue.exists {
            note("B: press #\(attempt) on the value text at \(byValue.frame)")
            press(byValue)
            return
        }
        #endif
        let anchor = app.descendants(matching: .any).matching(identifier: "runner-updating-tag").firstMatch
        if anchor.exists {
            let f = anchor.frame
            note("B: press #\(attempt) right of the identifier element at \(f)")
            let origin = app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
            let wf = app.windows.firstMatch.frame
            let point = origin.withOffset(CGVector(dx: f.maxX - wf.minX + 45, dy: f.midY - wf.minY))
            #if os(iOS)
            point.tap()
            #else
            point.click()
            #endif
            return
        }
        note("B: press #\(attempt): no tag element found")
    }
}
