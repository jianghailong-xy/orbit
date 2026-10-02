import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the list. These hold the phone's session
/// search to its source: the field sits in the bottom toolbar on iOS 26 and gets out of the way while
/// the list is read downward, by the tested `BottomSearchReveal`; the iPad's column keeps the drawer.
final class SessionListSearchWiringTests: XCTestCase {
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

    /// The column places the field and the list moves it, both decided by the same presentation.
    func testTheListPlacesItsSearchFieldAndTheListRevealsIt() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        XCTAssertTrue(agents.contains(".sessionListSearch(text: $searchQuery"),
                      "the column declares its one search field through the placement switch")
        XCTAssertFalse(agents.contains(".searchable("),
                       "no second field beside it")
        XCTAssertTrue(agents.contains(".revealsBottomSearchOnScroll(query: searchQuery, enabled: listPresentation.searchesFromBottom)"),
                      "the list hides and shows the bottom field, only where the field is at the bottom")
    }

    func testTheBottomFieldIsTheSystemsAndOnlyTheRuleHidesIt() throws {
        let search = code(try appSource("Views/SessionListSearch.swift"))
        XCTAssertTrue(search.contains("DefaultToolbarItem(kind: .search, placement: .bottomBar)"),
                      "the system's own search field, in the bottom toolbar")
        XCTAssertTrue(search.contains(".navigationBarDrawer(displayMode: .always)"),
                      "everywhere else the drawer stays as it was")
        XCTAssertTrue(search.contains("BottomSearchReveal()"), "the tested rule decides")
        XCTAssertTrue(search.contains("revealed || isSearching || !query.isEmpty || voiceOver"),
                      "never hidden while in use, or under VoiceOver")
    }
}
