import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold the branch bar's merge-recovery card to its layout in the source instead: the card stays
/// inside the bar, and the bar inside the band above the composer, however little room the band has.
/// Each check reads the slice of the file it's about, so a match somewhere else can't pass it.
final class MergeRecoveryWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "OrbitApp/Sources/OrbitApp/\(path) wasn't found above this test. If it moved, point this check "
                + "at its new home — don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp")
                .appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }

    /// From the first `start` through the next `end` after it.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    /// The owner's report, 2026-10-01: on a phone a ready candidate — its commits, its diff, three
    /// actions — is taller than the band's share, and it drew past the bar it sits in, over the
    /// transcript above and under the composer below. The card scrolls inside past a cap, above a
    /// floor, as the band's other cards do; and the bar never takes a height shorter than it holds.
    func testTheRecoveryCardStaysInsideTheBar() throws {
        let card = code(try source("Views/MergeRecoveryView.swift"))
        let body = try slice(card, from: "var body: some View {", to: "\n    }")
        XCTAssertTrue(body.contains("ViewThatFits(in: .vertical) {"),
                      "the card stands at its natural height only where that fits")
        XCTAssertTrue(body.contains("ScrollView { card }"), "and scrolls inside where it doesn't…")
        XCTAssertTrue(body.contains(".frame(minHeight: Self.heightFloor, maxHeight: Self.heightCap)"),
                      "…past a cap, above a floor")

        // The card is drawn twice, whole and scrolling; a section that kept its own open state would
        // be shut in the scrolling copy the moment opening it tipped the card over.
        XCTAssertEqual(card.components(separatedBy: "DisclosureGroup(").count - 1,
                       card.components(separatedBy: "isExpanded: isOpen(").count - 1,
                       "every section opens through the card's one record of what is open")

        let pill = code(try slice(source("Views/WorktreeBar.swift"),
                                  from: "private func pill(", to: ".padding(.bottom, .composerBandGap)"))
        XCTAssertFalse(pill.contains(".frame(minHeight: 30)"),
                       "a minimum on the whole bar takes any shorter height it's offered, and what the bar holds spills out of it")
        XCTAssertTrue(pill.contains(".frame(minHeight: 24)"), "the row holds the 30pt collapsed bar instead")
    }
}
