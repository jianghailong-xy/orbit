import XCTest
@testable import OrbitKit

/// The session list's refresh spinner, kept off the bands pinned over the list: moved under them
/// while its band overlaps them, left alone once a refresh has moved them below it. The numbers are
/// the iOS 26.5 simulator's (iPhone 17 Pro), where the control's band hangs under the navigation bar
/// at 116–176 and the "… needs you" bar is 38.3pt tall.
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
}
