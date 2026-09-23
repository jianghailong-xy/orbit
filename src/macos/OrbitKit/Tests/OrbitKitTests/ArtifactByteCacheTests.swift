import Foundation
import XCTest
@testable import OrbitKit

/// The cache that keeps a mock from being re-fetched every time its row scrolls back on screen.
/// What it must do is narrow — answer what was stored, under the path it was stored for — because
/// everything else about it (bounding, evicting under pressure, thread safety) is `NSCache`'s.
final class ArtifactByteCacheTests: XCTestCase {

    private let path = "/root/.orbit/uploads/01a0c992-61c0-727a-bbbb-d985dd45d0e0/mock.png"

    func testAnswersWhatWasStoredForThatPath() {
        let cache = ArtifactByteCache(byteLimit: 8 << 20)
        XCTAssertNil(cache.data(for: path), "an empty cache answers nil")

        let bytes = Data([0x89, 0x50, 0x4E, 0x47] + Array(repeating: 0x00, count: 4096))
        cache.store(bytes, for: path)
        XCTAssertEqual(cache.data(for: path), bytes)

        // Per path, not per file name: two sessions' mocks do not answer for each other.
        XCTAssertNil(cache.data(for: "/root/.orbit/uploads/01a0c992-61c0-727a-bbbb-d985dd45d0e1/mock.png"))
    }

    func testABudgetSmallerThanTheBytesStillAnswersCoherently() {
        // NSCache evicts when it likes (and may keep a costly entry anyway), so the assertion is not
        // "it evicted" — only that a budget that cannot hold the entry never answers with something
        // else, which is the property the caller depends on.
        let cache = ArtifactByteCache(byteLimit: 1)
        let bytes = Data(repeating: 0xAB, count: 128)
        cache.store(bytes, for: path)
        if let served = cache.data(for: path) { XCTAssertEqual(served, bytes) }
    }

}
