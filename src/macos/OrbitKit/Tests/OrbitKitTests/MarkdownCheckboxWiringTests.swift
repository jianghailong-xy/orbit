import Foundation
import XCTest
@testable import OrbitKit

/// The wires between `MarkdownListItem.checkbox` and the two SwiftUI paths that draw a list.
///
/// `MarkdownTests.testTaskListKeepsCheckedState` proves the parser keeps the state; it proves
/// nothing about what a reader sees unless the views read it, and no compiler here checks that —
/// SwiftUI does not exist on Linux, and `MarkdownView.swift` / `SelectableText.swift` are compiled
/// only by the macOS and iOS jobs (the iOS one alone builds the `#if os(iOS)` branch). So the
/// attachment is asserted over the source, the way `CriteriaDecisionWiringTests` does, and each
/// assertion is written so that CUTTING the wire is what turns it red.
///
/// The one it exists for: `- [ ]` and `- [x]` must be told apart on both clients, the way web's
/// remark-gfm tells them apart with a real `<input type="checkbox" disabled>`. What it cannot see is
/// how the glyph looks — that is what the beta and the screenshots are for.
final class MarkdownCheckboxWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "the list renderers still read a task item's checkbox."
            }
        }
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.missing(relative)
    }

    /// One renderer's own section of the file, so a match 200 lines away cannot answer for it — a
    /// bare `contains` over a whole file is how a scan like this goes falsely green.
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    private static let viewPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/MarkdownView.swift"
    private static let selectablePath = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/SelectableText.swift"

    /// The one place either platform turns the parsed state into a glyph: an unchecked box and a
    /// checked one, and nothing for an ordinary bullet.
    func testCheckboxStateMapsToTwoDifferentGlyphs() throws {
        let map = try section(try source(Self.viewPath),
                              from: "private func listMarkerSymbol",
                              to: "/// Parse cache backing")
        XCTAssertTrue(map.contains("item.checkbox"), "the glyph must come from the parsed state")
        XCTAssertTrue(map.contains("\"square\""), "an unchecked item needs an empty box")
        XCTAssertTrue(map.contains("\"checkmark.square.fill\""), "a checked item needs a checked box")
    }

    /// macOS: the list row draws that glyph instead of a bullet.
    func testMacOSListRowDrawsTheCheckbox() throws {
        let view = try source(Self.viewPath)
        let row = try section(view, from: "private struct MarkdownBlockView",
                              to: "/// A GFM table rendered as")
        XCTAssertTrue(row.contains("marker(items[i])"), "the row must lay the marker the item asks for")
        let marker = try section(view, from: "private func marker(_ item: MarkdownListItem)",
                                 to: "private func headingFont")
        XCTAssertTrue(marker.contains("listMarkerSymbol"), "the marker must branch on the checkbox")
        XCTAssertTrue(marker.contains("Image(systemName: symbol)"), "a task item draws its symbol")
    }

    /// iOS: the selectable path merges list items into one text view, so the checkbox has to travel
    /// on the segment and be laid there — otherwise iPhone keeps drawing bullets.
    func testIOSSelectablePathDrawsTheCheckbox() throws {
        let groups = try section(try source(Self.viewPath),
                                 from: "private func proseGroups",
                                 to: "/// Parse cache backing")
        XCTAssertTrue(groups.contains("markerSymbol: listMarkerSymbol(item)"),
                      "the merged prose run must carry the same glyph macOS draws")

        let marker = try section(try source(Self.selectablePath),
                                 from: "private func markerRun(for seg:",
                                 to: "/// The paperclip that opens")
        XCTAssertTrue(marker.contains("seg.markerSymbol"), "the laid marker must read the segment's symbol")
        XCTAssertTrue(marker.contains("UIImage(systemName: symbol"), "and draw it as that symbol")
    }
}
