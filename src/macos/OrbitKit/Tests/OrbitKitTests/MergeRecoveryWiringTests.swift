import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold the merge recovery's review to its place in the source instead: one row on the branch
/// bar, the review itself in a full-height sheet — never inside the band above the composer, which
/// has no room for it on a phone.
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
    /// actions — is taller than the band's share, and it drew past the bar it sat in, over the
    /// transcript above and under the composer below. The review now lives in a full-height system
    /// sheet (the owner's pick of three: no half height), opened from one row on the bar.
    func testTheReviewLivesInAFullHeightSheetOpenedFromTheBar() throws {
        let bar = code(try source("Views/WorktreeBar.swift"))
        XCTAssertFalse(bar.contains("MergeRecoveryView("), "the review is never drawn inside the bar")
        XCTAssertTrue(bar.contains(
            "MergeRecoveryRow(recovery: recovery, working: d.mergeStatus == \"pending\") { sheet = .recovery }"),
                      "one row on the bar opens it…")
        XCTAssertTrue(bar.contains("case .recovery: MergeRecoverySheet(console: console)"), "…as the bar's sheet")
        let mergeSlot = try slice(bar, from: "private struct WorktreeMergeControl", to: "private func adoptControl")
        XCTAssertFalse(mergeSlot.contains("Check and repair"), "the merge slot gives way to that row: one way in")

        let sheet = code(try source("Views/MergeRecoverySheet.swift"))
        XCTAssertFalse(sheet.contains("presentationDetents"),
                       "full height only — no half height, so no floating glass on iOS 26")
        XCTAssertTrue(sheet.contains(".safeAreaInset(edge: .bottom"), "its step is pinned, reachable without scrolling")
        XCTAssertTrue(sheet.contains("r.buttons(supported: supported)"), "and its steps are MergeRecovery.buttons'")

        let pill = code(try slice(source("Views/WorktreeBar.swift"),
                                  from: "private func pill(", to: ".padding(.bottom, .composerBandGap)"))
        XCTAssertFalse(pill.contains(".frame(minHeight: 30)"),
                       "a minimum on the whole bar takes any shorter height it's offered, and what the bar holds spills out of it")
        XCTAssertTrue(pill.contains(".frame(minHeight: 24)"), "the row holds the 30pt collapsed bar instead")
    }

    /// The owner's report, 2026-10-09: Merge pressed just after sending a message came back "wait for
    /// the current turn to finish before merging". The bar held Merge back only on `.running`, and a
    /// sent message queues its turn first. The bar and this sheet now share one gate, and both hand
    /// it the send in flight and the sub-agents still at work.
    func testTheBarAndTheSheetHoldMergeOnTheSameTurnGate() throws {
        let pill = code(try slice(source("Views/WorktreeBar.swift"), from: "private func pill(", to: "let primary = "))
        let review = code(try slice(source("Views/MergeRecoverySheet.swift"),
                                    from: "private func review(", to: "let working = "))
        for (name, gate) in [("bar", pill), ("sheet", review)] {
            XCTAssertTrue(gate.contains("WorktreeBarLogic.turnActive("), "the \(name) reads the shared gate")
            XCTAssertTrue(gate.contains("runningSubagents: session?.runningSubagentCount"), "the \(name) counts sub-agents")
            XCTAssertTrue(gate.contains("sending: console.sending || console.awaitingReply"), "the \(name) counts the send")
            XCTAssertFalse(gate.contains("== .running"), "the \(name) keeps no status check of its own")
        }
    }

    /// The owner's report, 2026-10-01: the review led with a file diff the branch bar already shows,
    /// and its note pointed at "the local-only commits above" when there were none. It now leads with
    /// the branches and the commits the push adds, the diff as that list's last row, and its note is
    /// `MergeRecovery.reviewNote`, which only names local-only commits when some go out.
    func testTheReviewLeadsWithTheBranchesAndTheCommitsThePushAdds() throws {
        let sheet = code(try source("Views/MergeRecoverySheet.swift"))
        let review = try slice(sheet, from: "private func review(", to: ".safeAreaInset(edge: .bottom")
        let route = try XCTUnwrap(review.range(of: "RecoveryRouteRow("), "the branches have one row")
        let push = try XCTUnwrap(review.range(of: "r.inlinePushCommits()"), "the push's commits are listed")
        XCTAssertLessThan(route.lowerBound, push.lowerBound, "branches first, then what the push adds")
        let pushSection = try slice(review, from: "r.inlinePushCommits()", to: "Text(r.landingNote)")
        XCTAssertTrue(pushSection.contains("candidateDiffLink("), "the diff closes the push's list")
        XCTAssertTrue(review.contains("r.reviewNote"))
        XCTAssertFalse(sheet.contains("The local-only commits above"), "the note is the model's, which checks there are some")
        XCTAssertFalse(review.contains("Saved repair branch"), "the repair branch lives behind the branches row")
    }
}
