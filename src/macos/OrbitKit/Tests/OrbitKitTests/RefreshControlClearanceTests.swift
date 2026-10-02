import XCTest
@testable import OrbitKit

/// The session list's refresh spinner, kept off the bands pinned over the list: moved under them
/// while its band overlaps them, left alone once a refresh has moved them below it — and the list a
/// finished refresh left a little past its top, sent back there. The numbers are the iOS 26.5
/// simulator's (iPhone 17 Pro), where the control's band hangs under the navigation bar at 116–176
/// and the "… needs you" bar is 38.3pt tall.
final class RefreshControlClearanceTests: XCTestCase {
    private func shift(bandsTop: Double, bandsBottom: Double) -> Double {
        RefreshControlClearance.shift(bandTop: 116, bandBottom: 176,
                                      bandsTop: bandsTop, bandsBottom: bandsBottom)
    }

    func testMidPullTheBandMovesUnderTheNeedsYouBar() {
        XCTAssertEqual(shift(bandsTop: 116, bandsBottom: 154.3), 38.3, accuracy: 0.001)
    }

    func testOnceTheRefreshHasMovedTheBarBelowTheBandNothingMoves() {
        // iOS folds the band into the navigation bar and drops the bar to 176–214.3: a shift now
        // would put the spinner back on it.
        XCTAssertEqual(shift(bandsTop: 176, bandsBottom: 214.3), 0)
    }

    func testWithNothingWaitingNothingMoves() {
        XCTAssertEqual(shift(bandsTop: 116, bandsBottom: 116), 0)
    }

    func testBandsTallerThanTheBandAreClearedToTheirBottom() {
        // The iPad's scope picker over the bar: the band starts where they end, not one band lower.
        XCTAssertEqual(shift(bandsTop: 116, bandsBottom: 202), 86, accuracy: 0.001)
    }

    func testBandsThatOnlyTouchTheBandMoveNothing() {
        XCTAssertEqual(shift(bandsTop: 62, bandsBottom: 116), 0, "ending where the band starts")
        XCTAssertEqual(shift(bandsTop: 176, bandsBottom: 230), 0, "starting where the band ends")
    }

    // MARK: after the refresh

    private func returns(_ pastTop: Double) -> Bool {
        RefreshControlClearance.returnsToTop(pastTop: pastTop, bandHeight: 60)
    }

    func testAListAFinishedRefreshLeftPastItsTopGoesBack() {
        // What the simulator measured: 1.7 to 56.7pt past the top, inside the 60pt band.
        for past in [1.7, 5.0, 13.7, 39.0, 56.7] {
            XCTAssertTrue(returns(past), "\(past)")
        }
        XCTAssertTrue(returns(62), "the whole band, give or take a point")
    }

    func testAListAtItsTopOrScrolledFurtherStaysWhereItIs() {
        XCTAssertFalse(returns(0), "at the top")
        XCTAssertFalse(returns(0.3), "a fraction of a point")
        XCTAssertFalse(returns(75), "a row's height: rows the refresh added, or the reader's place")
        XCTAssertFalse(returns(-20), "still pulled down: the list is on its way back by itself")
    }
}
