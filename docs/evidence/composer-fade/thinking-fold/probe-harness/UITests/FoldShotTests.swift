import XCTest

// TEMPORARY evidence probe (see ../README.md): does the transcript stay glued to its tail through
// three consecutive thinking folds, with NO reader touch? The stub streams one scripted turn —
// three thinking stretches that each fill the 160pt streaming box, folding one after another, two
// tool calls between them (kimi order: thinking persists before tool_use), then a reply — while
// the test never scrolls. Per fold it photographs the full box, the frame right after the fold,
// and the settled state; diag.py's instrumentation records the per-frame geometry (offset,
// content height, bottom gap, scroll phase) between the marks, and the turn-end resting state is
// read off the jump-to-latest disc and the last line's position against the list's edge.
final class FoldShotTests: ProbeCase {
    /// The last history answer's first words: the conversation's data is in once these show
    /// somewhere. The session list's preview line reads them too, so `opened` waits for the
    /// transcript's own sticky header before this run trusts anything.
    private let tail = "导出好了"
    /// The scripted reply's last words: the line that has to sit above the composer's fade at rest.
    private let lastLine = "活跃会话数"

    func test1FoldsPinnedLight() {
        driveFolds(dark: false)
    }

    #if os(iOS)
    func test2FoldsPinnedDark() {
        driveFolds(dark: true)
    }
    #endif

    private func driveFolds(dark: Bool) {
        let s = dark ? "dark" : "light"
        let app = launch("console", dark: dark, until: tail, "folds-\(s)")
        opened(app, "folds-\(s)")
        // The turn must not start before the live stream is up, or the deltas scatter.
        guard streamConnected("folds-\(s)") else { app.terminate(); return }
        settle(2)
        // Resting at the tail before the turn — the pin this whole run stands on. No scroll, tap,
        // or drag touches the transcript from here on. (That the opening really is pinned is read
        // off the geometry log after the run.)
        shot("0-opened-\(s)")

        step("turn")
        settle(1.2)
        shot("1-turn-started-\(s)")

        // Stretch 1 → fold + tool card in ONE 200ms publish (the composition suspect).
        runStretch(app, n: 1, s: s)
        step("fold1")
        snap("3a-fold1-plus0-\(s)")
        settle(0.35)
        snap("3b-fold1-plus04-\(s)")
        if waitFoldCount(app, 1) { settle(0.6); snap("3c-fold1-settled-\(s)") }
        else { note("fold1-\(s): the fold never showed"); snap("3c-fold1-missing-\(s)") }

        // Stretch 2 → the fold ALONE in its publish; the tool card lands in the next one.
        runStretch(app, n: 2, s: s)
        step("fold2")
        snap("4a-fold2-plus0-\(s)")
        settle(0.35)
        snap("4b-fold2-plus04-\(s)")
        if waitFoldCount(app, 2) { settle(0.6); snap("4c-fold2-settled-\(s)") }
        else { note("fold2-\(s): the fold never showed"); snap("4c-fold2-missing-\(s)") }
        step("tool2")
        settle(1.2)
        shot("5-tool2-\(s)")

        // Stretch 3 → the fold alone at the turn's end, the reply only afterwards: the resting
        // state the symptom was reported on.
        runStretch(app, n: 3, s: s)
        step("fold3")
        snap("6a-fold3-plus0-\(s)")
        settle(0.35)
        snap("6b-fold3-plus04-\(s)")
        if waitFoldCount(app, 3) { settle(0.6); snap("6c-fold3-settled-\(s)") }
        else { note("fold3-\(s): the fold never showed"); snap("6c-fold3-missing-\(s)") }

        step("reply")
        guard appears(app, "核对完了", timeout: 10) else {
            note("reply-\(s): the scripted reply never showed")
            snap("7-reply-missing-\(s)")
            app.terminate()
            return
        }
        settle(0.5)
        shot("7-reply-\(s)")
        step("end")
        settle(2)
        snap("8a-rest-plus0-\(s)")
        settle(2)
        shot("8b-rest-\(s)")
        let jump = app.buttons.matching(NSPredicate(format: "label == 'Scroll to latest'")).firstMatch
        note("rest-\(s): jump disc \(describe(jump))")
        tailLine(app, "rest-\(s)")
        app.terminate()
    }

    /// Stream one thinking stretch and photograph its box once it is up (the stub sends the deltas
    /// with small sleeps; the last of them is inside this return).
    private func runStretch(_ app: XCUIApplication, n: Int, s: String) {
        step("think\(n)")
        guard appears(app, "Thinking", timeout: 10) else {
            note("think\(n)-\(s): the streaming box never showed")
            snap("2-think\(n)-missing-\(s)")
            return
        }
        settle(1.2)   // the remaining deltas publish; the box reaches its 160pt cap
        snap("2-think\(n)-box-\(s)")
    }

    /// Wait for the transcript's own sticky header: proof its rows are on screen, not just the
    /// session list's preview of them.
    private func opened(_ app: XCUIApplication, _ name: String) {
        let header = app.buttons.matching(NSPredicate(format: "label == 'Jump to your last question'")).firstMatch
        if header.waitForExistence(timeout: 30) {
            note("\(name): header \(describe(header))")
        } else {
            note("\(name): the transcript's sticky header never showed")
            write(app.debugDescription, "missing-header-\(name).txt")
            XCTFail("\(name): the transcript never showed its rows")
        }
    }

    /// Where the last line of the reply sits against the transcript's bottom edge: the list fades
    /// out over its last 20 points into the composer, so a line whose bottom is below
    /// (bottom - 20) is in the fade, and one below the list's edge has left the panel.
    private func tailLine(_ app: XCUIApplication, _ name: String) {
        #if os(iOS)
        let line = app.textViews.matching(NSPredicate(format: "label CONTAINS %@", lastLine)).allElementsBoundByIndex
            .last { $0.exists }
        let lists = app.collectionViews.allElementsBoundByIndex
        #else
        let line = app.staticTexts.matching(NSPredicate(format: "value CONTAINS %@", lastLine)).allElementsBoundByIndex
            .last { $0.exists && $0.frame.minX > 600 }
        let lists = app.outlines.allElementsBoundByIndex
        #endif
        guard let line else { note("\(name): last line not in the tree"); return }
        let f = line.frame
        // The widest list around the line: on the iPhone the drawer's session list is always
        // mounted under the console, and it is the taller of the two.
        guard let list = lists.filter({ $0.exists && $0.frame.contains(CGPoint(x: f.midX, y: f.minY)) })
            .max(by: { $0.frame.width < $1.frame.width }) else {
            note("\(name): last line at \(f), no list around it")
            return
        }
        let bottom = list.frame.maxY
        let verdict = f.maxY <= bottom - 20 + 0.5 ? "above the fade"
            : f.maxY <= bottom ? "IN the fade" : "BELOW the list's edge"
        note("\(name): last line bottom \(f.maxY), list bottom \(bottom), fade from \(bottom - 20): \(verdict)")
    }
}
