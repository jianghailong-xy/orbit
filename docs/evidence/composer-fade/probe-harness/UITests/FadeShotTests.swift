import XCTest

// TEMPORARY evidence probe (never merged): the edge between the transcript and the composer, on the
// tree before the change (a hairline above the composer band) and after it (no rule; the transcript
// fades out over its last 20 points). The same launches, waits and scroll deltas run on both trees, so
// each pair of pictures shows the same rows in the same place. Every shot is marked in the stub's
// metrics.log, beside the scroll views' numbers as the app reports them (ProbeMetrics).
final class FadeShotTests: ProbeCase {
    /// The last answer's first words: the transcript has its tail once these show.
    private let tail = "导出好了"

    func test1Console() {
        for dark in [false, true] {
            let s = dark ? "dark" : "light"
            let app = launch("console", dark: dark, until: tail, "console-\(s)")
            settle(1.5)
            shot("1-rest-\(s)")
            if !dark { tree(app, "rest-\(s)") }
            note("rest-\(s): composer \(describe(composer(app)))")
            // As opened (above) and at the true bottom: the scrolls below start from here.
            toBottom(app)
            shot("1b-bottom-\(s)")
            scrollUp(app, by: 150)
            shot("2-scrolled-\(s)")
            scrollUp(app, by: 90)
            shot("3-scrolled-more-\(s)")
            if !dark { tree(app, "scrolled-\(s)") }
            // Back to the tail the way a reader goes back: the jump-to-latest disc.
            let jump = app.buttons.matching(NSPredicate(format: "label == 'Scroll to latest'")).firstMatch
            note("jump-\(s): \(describe(jump))")
            if jump.exists, jump.isHittable {
                jump.tap()
                settle(2)
                shot("4-jumped-\(s)")
            }
            app.terminate()
        }
    }

    func test2NewSession() {
        let app = launch("compose", until: "DeepSeek", "compose-light")
        settle(1)
        shot("5-new-session-light")
        tree(app, "new-session-light")
        app.terminate()
    }

    /// The composer's field: the lowest text view (transcript bubbles are text views too on iOS).
    private func composer(_ app: XCUIApplication) -> XCUIElement {
        let views = app.textViews.allElementsBoundByIndex.filter { $0.exists }
        return views.max(by: { $0.frame.maxY < $1.frame.maxY }) ?? app.textViews.firstMatch
    }

    /// A point inside the transcript, clear of its rows' controls: the left margin on iOS; on the Mac
    /// the console column (the window's right part), where a scroll reaches the transcript and not the
    /// session list in the middle column.
    private func transcriptPoint(_ app: XCUIApplication, dy: CGFloat) -> XCUICoordinate {
        #if os(iOS)
        return app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: dy))
        #else
        return app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.82, dy: dy))
        #endif
    }

    /// Fling the transcript to its very end; it stops there however far the fling would carry it.
    private func toBottom(_ app: XCUIApplication) {
        let start = transcriptPoint(app, dy: 0.6)
        #if os(iOS)
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -260)),
                    withVelocity: .fast, thenHoldForDuration: 0)
        #else
        start.hover()
        start.scroll(byDeltaX: 0, deltaY: -800)
        #endif
        settle(2.5)
    }

    /// Move the transcript `points` toward its start with no momentum, so both trees stop at the same
    /// offset: on iOS a slow drag held at its end; on macOS one scroll-wheel delta over the transcript.
    private func scrollUp(_ app: XCUIApplication, by points: CGFloat) {
        let start = transcriptPoint(app, dy: 0.35)
        #if os(iOS)
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: points)),
                    withVelocity: .slow, thenHoldForDuration: 0.8)
        #else
        start.hover()
        start.scroll(byDeltaX: 0, deltaY: points)
        #endif
        settle(1.5)
    }
}
