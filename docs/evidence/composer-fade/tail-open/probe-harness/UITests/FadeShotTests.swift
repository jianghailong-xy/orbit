import XCTest

// TEMPORARY evidence probe (never merged): a long conversation opened at its tail, on the tree before
// the fix (main) and after it. The same launches, waits and scroll deltas run on every tree, so each
// pair of pictures shows the same rows in the same place. Every shot is marked in the stub's
// metrics.log, beside the scroll views' numbers as the app reports them (ProbeMetrics).
final class FadeShotTests: ProbeCase {
    /// The last answer's first words: the conversation's data is in once these show somewhere. The
    /// session list's preview line reads them too, so they say nothing about the transcript.
    private let tail = "导出好了"
    /// The last answer's last words: the line that has to sit above the composer's fade.
    private let lastLine = "条目一一对应"

    func test1Console() {
        for dark in [false, true] {
            let s = dark ? "dark" : "light"
            let app = launch("console", dark: dark, until: tail, "console-\(s)")
            opened(app, "console-\(s)")
            settle(1.5)
            // As opened: nothing has touched the transcript since it pinned itself to its tail.
            shot("1-rest-\(s)")
            tailLine(app, "rest-\(s)")
            if !dark { tree(app, "rest-\(s)") }
            // At the true bottom, the way a reader gets there: the scrolls below start from here.
            toBottom(app)
            shot("1b-bottom-\(s)")
            tailLine(app, "bottom-\(s)")
            scrollUp(app, by: 150)
            shot("2-scrolled-\(s)")
            scrollUp(app, by: 90)
            shot("3-scrolled-more-\(s)")
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

    /// A reader who scrolls up stays where they put the transcript, however its geometry moves under
    /// them. A fresh launch with no full read of the element tree before the scrolls: such a read
    /// lays out every row, and on the Mac the List measures a row only as it comes into view — so
    /// here the rows a scroll uncovers are measured as it goes, as they are for a person.
    func test3ReaderStaysUp() {
        let app = launch("console", until: tail, "reader-light")
        opened(app, "reader-light")
        settle(1.5)
        shot("6-opened-light")
        scrollUp(app, by: 150)
        shot("7-up-light")
        settle(4)
        shot("7b-up-later-light")
        scrollUp(app, by: 90)
        shot("8-up-more-light")
        settle(4)
        shot("8b-up-more-later-light")
        tailLine(app, "reader-up-more-light")
        // Back at the tail, the sticky header's jump to the question above the fold: a move the
        // reader asked for, which starts at the tail. Nothing may bring them back down after it.
        toBottom(app)
        shot("9-back-light")
        let header = app.buttons.matching(NSPredicate(format: "label == 'Jump to your last question'")).firstMatch
        note("question-light: header \(describe(header))")
        if header.exists, header.isHittable {
            header.tap()
            settle(1.5)
            shot("10-question-light")
            settle(4)
            shot("10b-question-later-light")
        } else {
            XCTFail("question-light: the sticky header could not be pressed")
        }
        app.terminate()
    }

    /// Wait for the transcript itself: the sticky "↑ Your question" header is drawn by the transcript
    /// alone, once it has rows above the fold. Its arrival is also what pushes the rows down.
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

    /// Where the last line of the last answer sits against the transcript's bottom edge: the list
    /// fades out over its last 20 points into the composer, so a line whose bottom is below
    /// (bottom - 20) is in the fade.
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
        // The widest list around the line: on the iPhone the drawer's session list is always mounted
        // under the console, and it is the taller of the two.
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

    /// Move the transcript `points` toward its start with no momentum, so every tree stops at the same
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
