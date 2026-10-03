import XCTest
@testable import OrbitKit

/// The phone's bottom search field: out of the way while you read down the list, back the moment
/// you head up, and always there at the top, at the end, and on a list too short to scroll.
final class BottomSearchRevealTests: XCTestCase {
    /// A long list: 2000pt of rows in an 800pt viewport.
    private func at(_ offset: Double, content: Double = 2000, viewport: Double = 800) -> ListScrollSample {
        ListScrollSample(offset: offset, contentHeight: content, visibleBottom: offset + viewport)
    }

    /// Feed a run of offsets, all driven by the reader unless said otherwise.
    private func scroll(_ reveal: inout BottomSearchReveal, _ offsets: [Double], readerDriven: Bool = true) {
        for offset in offsets { reveal.scrolled(to: at(offset), readerDriven: readerDriven) }
    }

    func testItShowsBeforeAnyScroll() {
        XCTAssertTrue(BottomSearchReveal().isShown)
    }

    func testReadingDownHidesItOnceTheRunIsLongEnough() {
        var reveal = BottomSearchReveal()
        scroll(&reveal, [300, 320])
        XCTAssertTrue(reveal.isShown, "20pt down is a nudge")
        scroll(&reveal, [324])
        XCTAssertFalse(reveal.isShown, "24pt down is reading on")
    }

    func testHeadingBackUpBringsItBackSoonerThanItWentAway() {
        var reveal = BottomSearchReveal()
        scroll(&reveal, [300, 400])
        XCTAssertFalse(reveal.isShown)
        scroll(&reveal, [392])
        XCTAssertFalse(reveal.isShown, "8pt up is a wobble")
        scroll(&reveal, [388])
        XCTAssertTrue(reveal.isShown, "12pt up is heading back — no need to reach the top")
    }

    func testTurningAroundStartsTheRunAgain() {
        var reveal = BottomSearchReveal()
        scroll(&reveal, [300, 320, 315, 335])
        XCTAssertTrue(reveal.isShown, "20 down, 5 up, 20 down: no single run reached 24")
        scroll(&reveal, [339])
        XCTAssertFalse(reveal.isShown)
    }

    func testTheTopAlwaysShowsIt() {
        var reveal = BottomSearchReveal()
        scroll(&reveal, [300, 400])
        XCTAssertFalse(reveal.isShown)
        // A tap on the status bar scrolls home without a finger on the list.
        scroll(&reveal, [200, 0], readerDriven: false)
        XCTAssertTrue(reveal.isShown)
        // Pulled past the top (the refresh pull) is the top too.
        scroll(&reveal, [-40], readerDriven: true)
        XCTAssertTrue(reveal.isShown)
    }

    func testTheEndOfTheListShowsIt() {
        var reveal = BottomSearchReveal()
        scroll(&reveal, [300, 400, 1000])
        XCTAssertFalse(reveal.isShown)
        scroll(&reveal, [1200])
        XCTAssertTrue(reveal.isShown, "the last row is on screen: nothing left to read past")
    }

    func testAListTooShortToScrollKeepsItEvenWhenDraggedDown() {
        var reveal = BottomSearchReveal()
        for offset in [0.0, 30, 60] {
            reveal.scrolled(to: ListScrollSample(offset: offset, contentHeight: 500, visibleBottom: offset + 800),
                            readerDriven: true)
        }
        XCTAssertTrue(reveal.isShown)
    }

    func testTheListMovingByItselfNeitherHidesNorShowsIt() {
        var reveal = BottomSearchReveal()
        scroll(&reveal, [300, 400], readerDriven: false)
        XCTAssertTrue(reveal.isShown, "rows re-laid-out under a still reader")
        scroll(&reveal, [430])
        XCTAssertFalse(reveal.isShown)
        scroll(&reveal, [380], readerDriven: false)
        XCTAssertFalse(reveal.isShown, "a programmatic scroll up is not the reader heading back")
    }

    func testRevealShowsItWhereverTheListIs() {
        var reveal = BottomSearchReveal()
        scroll(&reveal, [300, 400])
        XCTAssertFalse(reveal.isShown)
        reveal.reveal()
        XCTAssertTrue(reveal.isShown)
        scroll(&reveal, [420])
        XCTAssertTrue(reveal.isShown, "the run starts again from the reveal")
        scroll(&reveal, [424])
        XCTAssertFalse(reveal.isShown)
    }
}
