import Foundation
import XCTest
@testable import OrbitKit

/// `TagChipColor` — the shade a tag chip's *name* is painted in. The mirror of web's
/// `lib/tagColor.test.ts`, and the reason this lives in OrbitKit rather than the view: the claim
/// worth testing is a measurement, and it can be made on Linux.
final class TagChipColorTests: XCTestCase {

    /// The seeded palette (session-tags.service.ts) — every colour a picker can offer.
    private let palette = ["#FF3B30", "#FF9500", "#FFCC00", "#34C759", "#007AFF", "#AF52DE", "#8E8E93"]

    // Contrast, written out again rather than reaching into the type under test: the claim is that
    // the shipped colours measure legible, so it must not lean on the maths that chose them.
    private func luminance(_ c: [Double]) -> Double {
        func linear(_ channel: Double) -> Double {
            let v = channel / 255
            return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2])
    }
    private func ratio(_ a: [Double], _ b: [Double]) -> Double {
        let (hi, lo) = (max(luminance(a), luminance(b)), min(luminance(a), luminance(b)))
        return (hi + 0.05) / (lo + 0.05)
    }
    private func channels(_ hex: String) -> [Double] {
        let v = UInt32(hex.dropFirst(), radix: 16)!
        return [Double((v >> 16) & 0xFF), Double((v >> 8) & 0xFF), Double(v & 0xFF)]
    }
    /// The chip's actual background: the tag colour washed over the row at the shipped opacity.
    private func chipBackground(_ hex: String, dark: Bool) -> [Double] {
        let row: [Double] = dark ? [28, 28, 30] : [255, 255, 255]
        let alpha = TagChipColor.backgroundOpacity(dark: dark)
        let c = channels(hex)
        return (0..<3).map { c[$0] * alpha + row[$0] * (1 - alpha) }
    }
    private func rgb255(_ c: TagChipColor.Components) -> [Double] {
        [c.red * 255, c.green * 255, c.blue * 255]
    }

    func testEveryPaletteColorClearsAAOnItsOwnChipBackground() throws {
        for hex in palette {
            for dark in [false, true] {
                let label = try XCTUnwrap(TagChipColor.label(hex: hex, dark: dark))
                XCTAssertGreaterThanOrEqual(ratio(rgb255(label), chipBackground(hex, dark: dark)), 4.5,
                                            "\(hex) \(dark ? "dark" : "light")")
            }
        }
    }

    /// What the chip used to do — the tag's own hex as text. Yellow was the smudge that started it.
    func testRawPaletteColorAsTextFailsTheSameMeasurement() {
        XCTAssertLessThan(ratio(channels("#FFCC00"), chipBackground("#FFCC00", dark: false)), 2)
    }

    /// Only as far as AA needs: a colour that was already legible barely moves, a pale one moves a
    /// lot — which is precisely what one fixed blend percentage could not do for both.
    func testDarkensOnlyAsFarAsNeededAndKeepsTheHue() throws {
        for hex in palette {
            let light = try XCTUnwrap(TagChipColor.label(hex: hex, dark: false))
            let dark = try XCTUnwrap(TagChipColor.label(hex: hex, dark: true))
            XCTAssertNotEqual(rgb255(light), [0, 0, 0], hex)
            XCTAssertNotEqual(rgb255(dark), [255, 255, 255], hex)
        }
        let blueShift = luminance(channels("#007AFF")) - luminance(rgb255(TagChipColor.label(hex: "#007AFF", dark: false)!))
        let yellowShift = luminance(channels("#FFCC00")) - luminance(rgb255(TagChipColor.label(hex: "#FFCC00", dark: false)!))
        XCTAssertGreaterThan(yellowShift, blueShift * 2)
    }

    /// The API takes any `#RRGGBB`, and MCP/CLI can write one the picker never offered.
    func testMalformedHexHasNoLabelSoTheViewCanFallBack() {
        XCTAssertNil(TagChipColor.label(hex: "nonsense", dark: false))
        XCTAssertNil(TagChipColor.label(hex: "#12345", dark: true))
        XCTAssertNil(TagChipColor.components(hex: "#12345"))
    }

    /// Both ends must land on the same shade — these are web's shipped values (lib/tagColor).
    func testMatchesTheWebValuesForTheLightPalette() throws {
        let expected = ["#FF3B30": "#c72e25", "#FFCC00": "#8a6e00", "#007AFF": "#0066d6"]
        for (hex, want) in expected {
            let c = try XCTUnwrap(TagChipColor.label(hex: hex, dark: false))
            let got = "#" + rgb255(c).map { String(format: "%02x", Int($0.rounded())) }.joined()
            XCTAssertEqual(got, want, hex)
        }
    }
}
