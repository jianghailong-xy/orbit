import XCTest
@testable import OrbitKit

final class RowSwipeGeometryTests: XCTestCase {
    /// An Open-tab session row on the owner's iPhone (393pt wide): Complete and Pin on the leading
    /// side, Delete on the trailing one, and a full swipe right completes.
    private let open = RowSwipeGeometry(leadingWidth: 150, trailingWidth: 80, rowWidth: 393,
                                        leadingFullSwipe: true)

    func testTheSlotsAreTheSystemsOwn() {
        // Measured on the owner's screenshots of the iOS 26 buttons: the row's edge stops 150pt in
        // behind Complete and Pin, and 80pt in behind Delete.
        XCTAssertEqual(RowSwipeGeometry.openWidth(slots: [60, 60]), 150)
        XCTAssertEqual(RowSwipeGeometry.openWidth(slots: [60]), 80)
        // A third button costs a slot and a gap, so the row keeps 173pt of a 393pt screen.
        XCTAssertEqual(RowSwipeGeometry.openWidth(slots: [60, 60, 60]), 220)
        // A title wider than the slot widens only its own.
        XCTAssertEqual(RowSwipeGeometry.openWidth(slots: [84, 60]), 174)
        XCTAssertEqual(RowSwipeGeometry.openWidth(slots: []), 0)
    }

    func testTheRowFollowsTheFingerUpToEachSide() {
        XCTAssertEqual(open.dragged(0), 0)
        XCTAssertEqual(open.dragged(120), 120)
        XCTAssertEqual(open.dragged(-80), -80)
    }

    func testPastTheButtonsTheRowGivesGrudgingly() {
        // Delete has no full swipe: 20pt past it moves the row 6.
        XCTAssertEqual(open.dragged(-100), -86, accuracy: 1e-9)
        // Without a full swipe the leading side holds the same way.
        let noFull = RowSwipeGeometry(leadingWidth: 150, trailingWidth: 80, rowWidth: 393,
                                      leadingFullSwipe: false)
        XCTAssertEqual(noFull.dragged(200), 165, accuracy: 1e-9)
        // A side with no buttons at all gives only that little.
        let leadingOnly = RowSwipeGeometry(leadingWidth: 150, trailingWidth: 0, rowWidth: 393,
                                           leadingFullSwipe: true)
        XCTAssertEqual(leadingOnly.dragged(-40), -12, accuracy: 1e-9)
    }

    func testAFullSwipeFollowsTheFingerAndCompletes() {
        XCTAssertEqual(open.dragged(300), 300)
        // Over halfway across the row: 0.6 × 393.
        XCTAssertEqual(open.fullSwipePoint, 235.8, accuracy: 1e-9)
        XCTAssertFalse(open.isFullSwipe(230))
        XCTAssertTrue(open.isFullSwipe(240))
        XCTAssertEqual(open.rest(offset: 240, velocity: 0), .fullSwipe)
        XCTAssertEqual(open.offset(at: .fullSwipe), 393)
    }

    func testANarrowRowStillNeedsASlotPastTheButtons() {
        let narrow = RowSwipeGeometry(leadingWidth: 150, trailingWidth: 80, rowWidth: 300,
                                      leadingFullSwipe: true)
        XCTAssertEqual(narrow.fullSwipePoint, 210)
    }

    func testWithoutAFullSwipeALongSwipeJustOpens() {
        let noFull = RowSwipeGeometry(leadingWidth: 150, trailingWidth: 80, rowWidth: 393,
                                      leadingFullSwipe: false)
        XCTAssertFalse(noFull.isFullSwipe(300))
        XCTAssertEqual(noFull.rest(offset: 165, velocity: 0), .leading)
    }

    func testALetGoRowOpensPastHalfway() {
        XCTAssertEqual(open.rest(offset: 80, velocity: 0), .leading)
        XCTAssertEqual(open.rest(offset: 70, velocity: 0), .closed)
        XCTAssertEqual(open.rest(offset: -50, velocity: 0), .trailing)
        XCTAssertEqual(open.rest(offset: -30, velocity: 0), .closed)
    }

    func testAFlickDecidesByItsDirection() {
        XCTAssertEqual(open.rest(offset: 20, velocity: 800), .leading)
        XCTAssertEqual(open.rest(offset: 140, velocity: -800), .closed)
        XCTAssertEqual(open.rest(offset: -20, velocity: -800), .trailing)
        XCTAssertEqual(open.rest(offset: -75, velocity: 800), .closed)
    }

    func testASideWithoutButtonsNeverOpens() {
        let leadingOnly = RowSwipeGeometry(leadingWidth: 150, trailingWidth: 0, rowWidth: 393,
                                           leadingFullSwipe: true)
        XCTAssertEqual(leadingOnly.rest(offset: -12, velocity: -800), .closed)
        XCTAssertEqual(open.rest(offset: 0, velocity: 0), .closed)
    }

    func testALoneButtonGrowsInOverItsLastThirtyPoints() {
        // The system's lone Delete: not out at 50pt, a fifth of its size at 55, whole at 80.
        let delete: [Double] = [60]
        XCTAssertEqual(RowSwipeGeometry.reveal(of: 0, slots: delete, revealed: 50), 0)
        XCTAssertEqual(RowSwipeGeometry.reveal(of: 0, slots: delete, revealed: 56), 0.2, accuracy: 1e-9)
        XCTAssertEqual(RowSwipeGeometry.reveal(of: 0, slots: delete, revealed: 65), 0.5, accuracy: 1e-9)
        XCTAssertEqual(RowSwipeGeometry.reveal(of: 0, slots: delete, revealed: 80), 1)
        // Pulled on past its slot, it stays whole.
        XCTAssertEqual(RowSwipeGeometry.reveal(of: 0, slots: delete, revealed: 140), 1)
    }

    func testButtonsGrowInFromTheEdgeInward() {
        let leading: [Double] = [60, 60]
        // Complete is whole by the time Pin starts: the system's Pin is not out at 103pt.
        XCTAssertEqual(RowSwipeGeometry.reveal(of: 0, slots: leading, revealed: 103), 1)
        XCTAssertEqual(RowSwipeGeometry.reveal(of: 1, slots: leading, revealed: 103), 0)
        XCTAssertEqual(RowSwipeGeometry.reveal(of: 1, slots: leading, revealed: 135), 0.5, accuracy: 1e-9)
        XCTAssertEqual(RowSwipeGeometry.reveal(of: 1, slots: leading, revealed: 150), 1)
        // A wide slot pushes the next one's start out with it.
        XCTAssertEqual(RowSwipeGeometry.reveal(of: 1, slots: [84, 60], revealed: 150), 0.2, accuracy: 1e-9)
        XCTAssertEqual(RowSwipeGeometry.reveal(of: 2, slots: leading, revealed: 150), 0, "no third button")
    }

    func testAButtonFadesInAheadOfItsSize() {
        XCTAssertEqual(RowSwipeGeometry.revealOpacity(0), 0)
        XCTAssertEqual(RowSwipeGeometry.revealOpacity(0.2), 0.32, accuracy: 1e-9)
        XCTAssertEqual(RowSwipeGeometry.revealOpacity(1), 1)
    }

    func testEachRestHasItsOffset() {
        XCTAssertEqual(open.offset(at: .closed), 0)
        XCTAssertEqual(open.offset(at: .leading), 150)
        XCTAssertEqual(open.offset(at: .trailing), -80)
    }
}
