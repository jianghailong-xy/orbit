import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the lists. These hold the session
/// list's section titles to their source: on iOS they are rows that scroll with their sections,
/// not headers that pin under the title bar — the only glass at the top is the title area's.
final class SessionListSectionTitleWiringTests: XCTestCase {
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

    /// Every titled section the session list draws goes through `TitledListSection` — the recency
    /// buckets, the Pinned and Needs you titles that fold, the tag buckets and the search hits'.
    func testEverySessionListSectionTitleDrawsThroughTitledSection() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        XCTAssertTrue(agents.contains("} title: {\n                Text(section.title).textCase(nil)"),
                      "a recency bucket's title")
        XCTAssertTrue(agents.contains("} title: {\n                foldSectionHeader(section.title, folded: folded)"),
                      "the folding Pinned and Needs you titles")
        XCTAssertTrue(agents.contains("} title: {\n            tagSectionHeader(section.tag)"),
                      "grouped-by-tag headings")
        XCTAssertTrue(agents.contains("} title: {\n            Text(contentSearched"),
                      "the search hits' heading")
        XCTAssertFalse(agents.contains("sectionHeaderBand"),
                       "no title draws on a pinned band of its own any more")
    }

    /// On iOS the title is the section's first row, not its header, so it scrolls away with its rows
    /// instead of pinning under the title bar (the owner, 2026-11-16). The row is not selectable and
    /// draws no separator; the Mac keeps the system header.
    func testOnIOSTheTitleIsARowThatScrollsAway() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        let start = try XCTUnwrap(agents.range(of: "struct TitledListSection"),
                                  "the titled-section view is gone; these checks follow it")
        let rest = agents[start.lowerBound...]
        let helper = String(rest[..<(rest.range(of: "\n}\n")?.upperBound ?? rest.endIndex)])
        let parts = helper.components(separatedBy: "#else")
        XCTAssertEqual(parts.count, 2, "one iOS branch and one Mac branch")
        let ios = parts[0], mac = parts[1]
        XCTAssertFalse(ios.contains("header:"), "a header pins in a plain list; on iOS the title is a row")
        XCTAssertTrue(ios.contains(".selectionDisabled()"), "the title row can't be selected")
        XCTAssertTrue(ios.contains(".listRowSeparator(.hidden)"), "nor draws a separator")
        XCTAssertTrue(ios.contains(".accessibilityAddTraits(.isHeader)"), "VoiceOver still reads it as a heading")
        XCTAssertTrue(mac.contains("header:"), "the Mac keeps its section header")
    }

    /// A folder's page draws its sections the way the workspace list does: every title through
    /// `TitledListSection`, none as a pinned header.
    func testTheFolderPageTitlesScrollAwayToo() throws {
        let page = code(try appSource("Views/SessionFolderPage.swift"))
        XCTAssertFalse(page.contains("} header: {"), "no section on the folder page keeps a pinned header")
        XCTAssertTrue(page.contains("} title: {\n                Text(section.title).textCase(nil)"),
                      "a recency bucket's title")
        XCTAssertTrue(page.contains("} title: {\n                foldSectionHeader(section.title, folded: folded)"),
                      "the folding Pinned and Needs you titles")
        XCTAssertTrue(page.contains("} title: {\n            Text(contentSearched"), "the search hits' heading")
        XCTAssertTrue(page.contains(".softTopEdgeEffect()"), "and meets the title area on its soft edge")
    }

    /// What stays at the top is the title area's own glass: the list keeps the soft top edge the
    /// rows pass under.
    func testTheListKeepsTheSoftTopEdge() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        XCTAssertTrue(agents.contains(".listStyle(.plain)\n        .softTopEdgeEffect()"),
                      "the session list meets the title area on its soft edge")
    }
}
