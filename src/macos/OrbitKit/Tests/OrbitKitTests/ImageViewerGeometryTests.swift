import XCTest
@testable import OrbitKit

final class ImageViewerGeometryTests: XCTestCase {
    /// An image on an iPhone 15 Pro held upright: 393×852 pt.
    private func onPhone(_ width: Double, _ height: Double) -> ImageViewerGeometry {
        ImageViewerGeometry(imageWidth: width, imageHeight: height, viewportWidth: 393, viewportHeight: 852)
    }

    func testALongImageFillsTheWidthAndOpensAtItsTop() {
        // The reported case: a 962×2230 mockup, only a little longer than the screen's own shape.
        let long = onPhone(962, 2230)

        XCTAssertTrue(long.fillsWidth)
        XCTAssertEqual(long.restWidth, 393, accuracy: 1e-9)
        XCTAssertEqual(long.restHeight, 2230 * 393 / 962, accuracy: 1e-9)
        XCTAssertEqual(long.travel, 2230 * 393 / 962 - 852, accuracy: 1e-9)
        // Drawn at its rest offset, the image's top edge sits on the top of the screen.
        XCTAssertEqual(852 / 2 + long.restOffsetY - long.restHeight / 2, 0, accuracy: 1e-9)
    }

    func testAWideImageIsFittedAndCentred() {
        let wide = onPhone(1600, 900)

        XCTAssertFalse(wide.fillsWidth)
        XCTAssertEqual(wide.restWidth, 393, accuracy: 1e-9)
        XCTAssertEqual(wide.restHeight, 900 * 393 / 1600, accuracy: 1e-9)
        XCTAssertEqual(wide.travel, 0)
        XCTAssertEqual(wide.restOffsetY, 0)
    }

    func testAScreenshotOfThisPhoneHasNothingToScroll() {
        // 1179×2556 px is the screen's own shape exactly.
        let screenshot = onPhone(1179, 2556)

        XCTAssertEqual(screenshot.restHeight, 852, accuracy: 1e-9)
        XCTAssertEqual(screenshot.travel, 0)
    }

    func testTurnedToLandscapeAPhotoStillJustFits() {
        // A 4:3 photo is taller than a landscape viewport's shape, but it isn't a long image.
        let photo = ImageViewerGeometry(imageWidth: 1600, imageHeight: 1200, viewportWidth: 852, viewportHeight: 393)

        XCTAssertFalse(photo.fillsWidth)
        XCTAssertEqual(photo.restHeight, 393, accuracy: 1e-9)
        XCTAssertEqual(photo.travel, 0)

        let long = ImageViewerGeometry(imageWidth: 962, imageHeight: 2230, viewportWidth: 852, viewportHeight: 393)
        XCTAssertTrue(long.fillsWidth)
        XCTAssertEqual(long.restWidth, 852, accuracy: 1e-9)
    }

    func testZoomKeepsThePointAtTheCentreOfTheScreenInPlace() {
        let long = onPhone(962, 2230)
        let scrolled = -20.0

        let zoomed = long.pan(x: 0, y: scrolled, rescaledFrom: 1, to: 2.6)

        // The image point under the screen centre, relative to the image centre: -offset / scale.
        let before = -(long.restOffsetY + scrolled) / 1
        let after = -(long.restOffsetY + zoomed.y) / 2.6
        XCTAssertEqual(after, before, accuracy: 1e-9)
        XCTAssertEqual(zoomed.x, 0)
    }

    func testZoomingInAndBackOutReturnsALongImageToWhereItWas() {
        let long = onPhone(962, 4000)
        let midway = -long.travel / 2

        let zoomed = long.pan(x: 0, y: midway, rescaledFrom: 1, to: 3)
        let back = long.pan(x: zoomed.x, y: zoomed.y, rescaledFrom: 3, to: 1)

        XCTAssertEqual(back.y, midway, accuracy: 1e-9)
    }

    func testBackAtZoomOneALongImageStaysInsideItsScrollRange() {
        let long = onPhone(962, 4000)

        // Zoomed in and panned past its bottom-right corner.
        let back = long.pan(x: 300, y: -9_000, rescaledFrom: 3, to: 1)

        XCTAssertEqual(back.x, 0)
        XCTAssertEqual(back.y, -long.travel, accuracy: 1e-9)
    }

    func testBackAtZoomOneAFittedImageIsCentredAgain() {
        let back = onPhone(1600, 900).pan(x: 140, y: -60, rescaledFrom: 3, to: 1)

        XCTAssertEqual(back.x, 0)
        XCTAssertEqual(back.y, 0)
    }

    func testTheScrollStopsAtEitherEndAndGivesALittlePastThem() {
        let long = onPhone(962, 4000)

        XCTAssertEqual(long.clampedScroll(50), 0)
        XCTAssertEqual(long.clampedScroll(-100), -100)
        XCTAssertEqual(long.clampedScroll(-long.travel - 50), -long.travel)

        XCTAssertEqual(long.rubberBanded(-100), -100)
        XCTAssertEqual(long.rubberBanded(40), 14, accuracy: 1e-9)
        XCTAssertEqual(long.rubberBanded(-long.travel - 40), -long.travel - 14, accuracy: 1e-9)
    }

    func testSizesNotKnownYetGiveZeroRatherThanNaN() {
        // The page's bytes haven't decoded, or the viewer hasn't been laid out.
        let pending = onPhone(0, 0)
        let unlaidOut = ImageViewerGeometry(imageWidth: 962, imageHeight: 2230, viewportWidth: 0, viewportHeight: 0)

        for geometry in [pending, unlaidOut] {
            XCTAssertFalse(geometry.fillsWidth)
            XCTAssertEqual(geometry.restWidth, 0)
            XCTAssertEqual(geometry.restHeight, 0)
            XCTAssertEqual(geometry.travel, 0)
            XCTAssertEqual(geometry.restOffsetY, 0)
        }
    }
}
