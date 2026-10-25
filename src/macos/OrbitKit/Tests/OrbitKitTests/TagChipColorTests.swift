import Foundation
import XCTest
@testable import OrbitKit

/// `TagChipColor` — a tag's hex as the colour its dot is drawn in. The session rows' named chips,
/// and the label shade they were painted with, are gone (the owner, 2026-10-22); the hex is what is
/// left to read.
final class TagChipColorTests: XCTestCase {

    func testAPaletteHexReadsAsItsComponents() throws {
        let c = try XCTUnwrap(TagChipColor.components(hex: "#FF9500"))
        XCTAssertEqual(c, .init(red: 1, green: 149.0 / 255, blue: 0))
        XCTAssertEqual(TagChipColor.components(hex: "007AFF"), .init(red: 0, green: 122.0 / 255, blue: 1),
                       "the leading # is optional, as the API stores whatever it was sent")
    }

    func testMalformedHexHasNoComponentsSoTheViewCanFallBack() {
        for hex in ["", "#FFF", "#GG0000", "#FF00000", "not a colour"] {
            XCTAssertNil(TagChipColor.components(hex: hex), hex)
        }
    }
}
