import XCTest
@testable import OrbitKit

/// The session list's needs-you bar, pinned, with the refresh spinner always under it: the band
/// moved below the bar while they overlap, the bar drawn back up while a refresh has iOS lay it
/// out lower — and the list a finished refresh left a little past its top, sent back there. The
/// numbers are the iOS 26.5 simulator's (iPhone 17 Pro), where the control's band hangs under the
/// navigation bar at 116–176 and the bar is 38.3pt tall.
final class RefreshControlClearanceTests: XCTestCase {
    private func shift(bandsTop: Double, bandsBottom: Double) -> Double {
        RefreshControlClearance.shift(bandTop: 116, bandBottom: 176,
                                      bandsTop: bandsTop, bandsBottom: bandsBottom)
    }

    private func lift(bandsTop: Double) -> Double {
        RefreshControlClearance.lift(bandTop: 116, bandBottom: 176, bandsTop: bandsTop)
    }

    func testMidPullTheBandMovesUnderTheNeedsYouBar() {
        XCTAssertEqual(lift(bandsTop: 116), 0, "the bar is where it rests")
        XCTAssertEqual(shift(bandsTop: 116, bandsBottom: 154.3), 38.3, accuracy: 0.001)
    }

    func testThroughTheRefreshTheBarIsDrawnBackUpAndTheBandStaysUnderIt() {
        // iOS folds the band into the navigation bar and lays the bar out at 176–214.3.
        XCTAssertEqual(lift(bandsTop: 176), 60, "back where it rests")
        XCTAssertEqual(shift(bandsTop: 176, bandsBottom: 214.3), 38.3, accuracy: 0.001,
                       "the same shift as mid-pull: nothing moves as the refresh starts or ends")
    }

    func testWithNothingWaitingNothingMoves() {
        XCTAssertEqual(shift(bandsTop: 116, bandsBottom: 116), 0)
        XCTAssertEqual(shift(bandsTop: 176, bandsBottom: 176), 0, "nor while it refreshes")
    }

    func testBandsTallerThanTheBandAreClearedToTheirBottom() {
        // The iPad's scope picker over the bar: the band starts where they end, not one band lower.
        XCTAssertEqual(shift(bandsTop: 116, bandsBottom: 202), 86, accuracy: 0.001)
        XCTAssertEqual(shift(bandsTop: 176, bandsBottom: 262), 86, accuracy: 0.001)
    }

    func testBandsThatOnlyTouchTheBandMoveNothing() {
        XCTAssertEqual(shift(bandsTop: 62, bandsBottom: 116), 0, "ending where the band starts")
    }

    func testBandsAreNeverDrawnUpFurtherThanARefreshPushesThem() {
        XCTAssertEqual(lift(bandsTop: 236), 60, "anything past one band is not the refresh's doing")
        XCTAssertEqual(lift(bandsTop: 62), 0, "and bands above where they rest stay there")
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
