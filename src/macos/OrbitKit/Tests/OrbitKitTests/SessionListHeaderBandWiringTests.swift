import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the lists. These hold the session
/// list's section headers to their source: they draw through `sectionHeaderBand`, whose surface is
/// what stops a *pinned* header from reading through. SwiftUI's plain list floats a section's
/// header over the rows scrolling under it but paints nothing behind a custom header, so the row
/// on its way up used to overlap "Yesterday" / "2–7 days ago" glyph for glyph.
final class SessionListHeaderBandWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func appSource(_ relative: String) throws -> String {
        let path = "src/macos/OrbitApp/Sources/OrbitApp/\(relative)"
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(path)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: path)
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    /// One function's body, so a check can talk about the band and not about the rest of the file —
    /// which draws plenty of other rows of its own.
    private func body(of name: String, in source: String) -> String? {
        guard let start = source.range(of: "func \(name)") else { return nil }
        let rest = source[start.lowerBound...]
        guard let end = rest.range(of: "\n    }") else { return nil }
        return String(rest[..<end.upperBound])
    }

    /// Every header the session list draws goes through the band — the recency buckets, the Pinned
    /// header that folds, the tag buckets and the search hits'. A header that draws its title
    /// directly is the bug: it pins with nothing behind it.
    func testEverySessionListSectionHeaderDrawsThroughTheBand() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        XCTAssertTrue(agents.contains("sectionHeaderBand { Text(section.title).textCase(nil) }"),
                      "a recency bucket's title draws in the band")
        XCTAssertTrue(agents.contains("sectionHeaderBand { pinnedSectionHeader(section.title) }"),
                      "the folding Pinned header draws in the band too")
        XCTAssertTrue(agents.contains("sectionHeaderBand { tagSectionHeader(section.tag) }"),
                      "grouped-by-tag headings draw in the band")
        XCTAssertTrue(agents.contains("sectionHeaderBand {\n                Text(contentSearched"),
                      "the search hits' heading draws in the band")
    }

    /// The list's header insets sit *outside* the header's view, so the surface has to be grown past
    /// the title's own frame to reach every point the header can be pinned over. It is grown as a
    /// *background* and never as layout: padding the header itself moved the band (and every row
    /// under it) off the metrics the system gives a section header.
    func testTheBandCoversTheHeaderRowWithoutMovingIt() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        let band = try XCTUnwrap(body(of: "sectionHeaderBand", in: agents),
                                 "the band helper is gone; these checks follow it")
        XCTAssertTrue(band.contains(".padding(.top, -33)") && band.contains(".padding(.bottom, -9)"),
                      "the surface is grown by the insets the system puts around the title, measured")
        XCTAssertTrue(band.contains(".frame(maxWidth: .infinity, alignment: .leading)"),
                      "and runs the full width, as a pinned header does")
        XCTAssertFalse(band.contains(".listRowInsets"),
                       "the header keeps the system's own metrics — an earlier take zeroed its insets "
                           + "and drew its own padding, which left every section 2pt short")
        XCTAssertTrue(band.contains(".background {"),
                      "the surface is a background, which lays out nothing, not padding on the header")
    }

    /// The fill is what the list itself draws in each appearance: a hard-coded white (or a material)
    /// would be the wrong colour in one of them, and a see-through one is no fix at all.
    func testTheBandIsFilledWithTheListsOwnSurface() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        let band = try XCTUnwrap(body(of: "sectionHeaderBand", in: agents),
                                 "the band helper is gone; these checks follow it")
        XCTAssertTrue(band.contains("Color(uiColor: .systemBackground)"),
                      "the band is filled with systemBackground, which is what the list draws")
    }
}
