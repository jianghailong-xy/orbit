import XCTest
@testable import OrbitKit

final class ScrubRailGeometryTests: XCTestCase {
    private let rail = ScrubRailGeometry(trackHeight: 600, thumbHeight: 44)

    func testHandleTravelsTheTrackMinusItsOwnHeight() {
        XCTAssertEqual(rail.travel, 556)
        XCTAssertEqual(rail.thumbTop(forProgress: 0), 0)
        XCTAssertEqual(rail.thumbTop(forProgress: 1), 556)
        XCTAssertEqual(rail.thumbTop(forProgress: 0.5), 278)
    }

    func testDragPositionsTheHandleCentreUnderTheFinger() {
        // A finger half a handle down the track is the top of the range, not 22/556 into it.
        XCTAssertEqual(rail.progress(forThumbCenter: 22), 0)
        XCTAssertEqual(rail.progress(forThumbCenter: 300), (300 - 22) / 556, accuracy: 1e-9)
        XCTAssertEqual(rail.progress(forThumbCenter: 578), 1)
    }

    func testDragBeyondEitherEndOfTheTrackClamps() {
        XCTAssertEqual(rail.progress(forThumbCenter: -400), 0)
        XCTAssertEqual(rail.progress(forThumbCenter: 4_000), 1)
    }

    func testHandleTallerThanTheTrackHasNowhereToGo() {
        let stub = ScrubRailGeometry(trackHeight: 30, thumbHeight: 44)

        XCTAssertEqual(stub.travel, 0)
        XCTAssertEqual(stub.thumbTop(forProgress: 1), 0)
        XCTAssertEqual(stub.progress(forThumbCenter: 20), 0)
    }

    func testZeroSizedRailDoesNotHandBackNaN() {
        // The first layout pass can measure the rail at zero, which divides 0 by 0.
        let unlaidOut = ScrubRailGeometry(trackHeight: 0, thumbHeight: 0)

        XCTAssertEqual(unlaidOut.progress(forThumbCenter: 0), 0)
        XCTAssertEqual(unlaidOut.thumbTop(forProgress: .nan), 0)
        XCTAssertEqual(ScrubRailGeometry.offset(forProgress: .nan, minOffset: 0, maxOffset: 1_000), 0)
    }

    func testScrollOffsetMapsOntoTheRailAndBack() {
        let min = -0.0, max = 240_000.0

        XCTAssertEqual(ScrubRailGeometry.progress(offset: 0, minOffset: min, maxOffset: max), 0)
        XCTAssertEqual(ScrubRailGeometry.progress(offset: 240_000, minOffset: min, maxOffset: max), 1)
        XCTAssertEqual(ScrubRailGeometry.progress(offset: 60_000, minOffset: min, maxOffset: max), 0.25)
        XCTAssertEqual(ScrubRailGeometry.offset(forProgress: 0.25, minOffset: min, maxOffset: max), 60_000)
        XCTAssertEqual(ScrubRailGeometry.offset(forProgress: 1, minOffset: min, maxOffset: max), 240_000)
    }

    func testSafeAreaInsetShiftsBothEndsOfTheRange() {
        // A scroll view whose top inset is adjusted rests at a negative offset, and that offset is
        // the top of the rail — not somewhere already scrolled.
        let min = -47.0, max = 1_953.0

        XCTAssertEqual(ScrubRailGeometry.progress(offset: -47, minOffset: min, maxOffset: max), 0)
        XCTAssertEqual(ScrubRailGeometry.offset(forProgress: 0, minOffset: min, maxOffset: max), -47)
        XCTAssertEqual(ScrubRailGeometry.offset(forProgress: 1, minOffset: min, maxOffset: max), 1_953)
    }

    func testOutputShorterThanTheViewportPinsToTheTop() {
        // `maxOffset` is clamped up to `minOffset` by the caller, so the range collapses.
        XCTAssertEqual(ScrubRailGeometry.progress(offset: 0, minOffset: 0, maxOffset: 0), 0)
        XCTAssertEqual(ScrubRailGeometry.offset(forProgress: 1, minOffset: 0, maxOffset: 0), 0)
        XCTAssertEqual(ScrubRailGeometry.offset(forProgress: 0.5, minOffset: -47, maxOffset: -47), -47)
    }
}
