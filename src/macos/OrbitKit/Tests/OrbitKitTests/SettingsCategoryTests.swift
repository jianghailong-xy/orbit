import XCTest
@testable import OrbitKit

/// The category list exists so Settings can fill both columns of the split shell instead of
/// crowding into one and leaving the other on a placeholder. These hold it to the form it names.
final class SettingsCategoryTests: XCTestCase {
    /// The column lists what the form renders, in the order the form renders it — so the split
    /// shell and the single-column shells present the same sequence and neither has to be
    /// re-learned from the other.
    func testTheCategoriesReadInFormOrder() {
        XCTAssertEqual(SettingsCategory.allCases.map(\.rawValue),
                       ["account", "preferences", "orchestration", "password", "updates"])
    }

    /// `updates` is the Sparkle channel switch and Sparkle ships only on macOS. Listing it on iPad
    /// would put a row in the column that opens onto an empty pane.
    func testUpdatesIsOfferedOnlyWhereSparkleShips() {
        #if os(macOS)
        XCTAssertTrue(SettingsCategory.visible.contains(.updates))
        XCTAssertEqual(SettingsCategory.visible, SettingsCategory.allCases)
        #else
        XCTAssertFalse(SettingsCategory.visible.contains(.updates))
        XCTAssertEqual(SettingsCategory.visible.count, SettingsCategory.allCases.count - 1)
        #endif
        // Whatever the platform drops, what remains keeps the form's order.
        XCTAssertEqual(SettingsCategory.visible,
                       SettingsCategory.allCases.filter { SettingsCategory.visible.contains($0) })
    }

    /// A row draws a label and a glyph; either one blank reads as a bug in the list itself.
    func testEveryCategoryCarriesALabelAndAGlyph() {
        for category in SettingsCategory.allCases {
            XCTAssertFalse(category.title.isEmpty, "\(category) has no title")
            XCTAssertFalse(category.systemImage.isEmpty, "\(category) has no glyph")
        }
        XCTAssertEqual(Set(SettingsCategory.allCases.map(\.title)).count,
                       SettingsCategory.allCases.count, "two categories share a title")
    }

    /// `id` is what `ForEach` keys the rows on; colliding ids would drop rows from the column.
    func testIdentifiersAreDistinct() {
        XCTAssertEqual(Set(SettingsCategory.allCases.map(\.id)).count,
                       SettingsCategory.allCases.count)
    }
}
