import XCTest
@testable import OrbitKit

final class PinnedCacheTests: XCTestCase {
    private final class Bitmap {}

    private func makeCache() -> PinnedCache<Bitmap> {
        PinnedCache(totalCostLimit: 1_000, countLimit: 100)
    }

    func testAPinnedObjectOutlivesAnEviction() {
        let cache = makeCache()
        let shown = Bitmap()
        cache.setObject(shown, forKey: "shown", cost: 600)
        cache.setObject(Bitmap(), forKey: "scrolled-past", cost: 300)
        cache.pin("shown")

        cache.evictAll()

        XCTAssertIdentical(cache.object(forKey: "shown"), shown)
        XCTAssertNil(cache.object(forKey: "scrolled-past"))
    }

    func testAnObjectInsertedWhilePinnedIsHeldToo() {
        // The view appears and pins its key before its fetch lands.
        let cache = makeCache()
        cache.pin("page")
        let image = Bitmap()
        cache.setObject(image, forKey: "page", cost: 900)

        cache.evictAll()

        XCTAssertIdentical(cache.object(forKey: "page"), image)
    }

    func testTwoPinnedNeighboursOverTheLimitKeepEachOther() {
        // The reported flicker: a viewer page and its neighbour, together over the byte ceiling.
        let cache = makeCache()
        cache.pin("page4")
        cache.pin("page5")
        let four = Bitmap()
        let five = Bitmap()

        cache.setObject(four, forKey: "page4", cost: 700)
        cache.setObject(five, forKey: "page5", cost: 700)

        XCTAssertIdentical(cache.object(forKey: "page4"), four)
        XCTAssertIdentical(cache.object(forKey: "page5"), five)
    }

    func testEachUserReleasesOnlyItsOwnPin() {
        let cache = makeCache()
        let image = Bitmap()
        cache.setObject(image, forKey: "shared", cost: 100)
        cache.pin("shared")   // the transcript's thumbnail
        cache.pin("shared")   // the viewer's page

        cache.unpin("shared")
        cache.evictAll()
        XCTAssertIdentical(cache.object(forKey: "shared"), image)

        cache.unpin("shared")
        cache.evictAll()
        XCTAssertNil(cache.object(forKey: "shared"))
    }

    func testAStrayUnpinDoesNotCancelALaterPin() {
        let cache = makeCache()
        cache.unpin("page")
        cache.pin("page")
        let image = Bitmap()
        cache.setObject(image, forKey: "page", cost: 10)

        cache.evictAll()

        XCTAssertIdentical(cache.object(forKey: "page"), image)
    }
}
