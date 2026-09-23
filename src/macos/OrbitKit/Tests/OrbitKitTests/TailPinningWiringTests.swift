import Foundation
import XCTest
@testable import OrbitKit

/// The wire between `TailPinning` and the transcript's scroll tracker.
///
/// `TailPinningTests` proves the rule; it proves nothing about what a reader sees unless the view
/// asks the rule, and no compiler here checks that — SwiftUI does not exist on Linux and
/// `ConsoleView.swift` is compiled only by the macOS and iOS jobs. So the attachment is asserted
/// over the source, the way `MarkdownCheckboxWiringTests` does, and each assertion is written so
/// that CUTTING the wire is what turns it red: deciding the pin inline again is how the transcript
/// stopped following a reply the moment a reasoning row folded.
final class TailPinningWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "the transcript still decides tail-pinning with TailPinning."
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

    /// The tracker's own section of the file, so a match elsewhere in 1000 lines of console cannot
    /// answer for it — a bare `contains` over a whole file is how a scan like this goes falsely green.
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    func testTheScrollTrackerAsksTailPinningWhetherItIsStillAtTheTail() throws {
        let tracker = try section(
            try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift"),
            from: "private struct ScrollTracker",
            to: "/// Publishes the id of the item currently under")

        // Spelled as facts rather than as formatting: the wire is what these name, so a cast or a
        // rewrapped line must not be what turns this red.
        XCTAssertTrue(tracker.contains("TailScrollSample("),
                      "the tracker must build the sample the rule reads")
        XCTAssertTrue(tracker.contains("geo.contentOffset.y"),
                      "the sample must be read off the live scroll geometry")
        XCTAssertTrue(tracker.contains("geo.contentSize.height"),
                      "the content height is the fact that tells a fold from a drag")
        XCTAssertTrue(tracker.contains("TailPinning.pinned("),
                      "the tracker must hand the decision to the tested rule")
        XCTAssertTrue(tracker.contains("onScrollPhaseChange"),
                      "and tell it whether the reader was the one moving the list")
        XCTAssertFalse(tracker.contains("atBottom = false"),
                       "nothing may un-pin the tail beside TailPinning — that inline branch read "
                        + "the clamp from a row that shrank as a reader scrolling up")
    }

    /// iOS tells the rule that drags are reported, and asks UIKit as well as the phase. Both are the
    /// fix for the second round of this bug: with the reader *inferred* from geometry, a fold under
    /// a transcript that was behind its tail (the app's normal state while a reply streams) un-pinned
    /// the tail, and the rest of the reply ran away below the fold.
    func testTheTrackerReportsDragsOnIOSAndKeepsInferringThemOnMacOS() throws {
        let tracker = try section(
            try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift"),
            from: "private struct ScrollTracker",
            to: "/// Publishes the id of the item currently under")

        XCTAssertTrue(tracker.contains("TailPinning.ReaderEvidence.reported"),
                      "iOS reports drags: the rule must be told so, not left to infer a reader from "
                        + "a fall over content that did not resize in that same sample")
        XCTAssertTrue(tracker.contains("v.isTracking"), "a finger down is UIKit's to report")
        XCTAssertTrue(tracker.contains("v.isDragging"), "and so is the drag that follows it")
        XCTAssertTrue(tracker.contains("evidence: Self.evidence"),
                      "the rule must actually be handed the evidence, or the axis does nothing")
    }

    /// The one place iOS un-pins without the platform saying so: the sticky header's jump back to a
    /// question. The tap IS the reader saying it — and without the line, the next publish would drag
    /// them back to the tail, because an animated jump is not a reported drag.
    func testTheStickyHeadersJumpSaysTheReaderDidIt() throws {
        let source = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift")
        let jump = try section(source, from: "private func stickyQuestion", to: "private func scrollToBottomButton")

        XCTAssertTrue(jump.contains("atBottom = false"),
                      "the jump must un-pin the tail outright: iOS decides a reader from reported "
                        + "drags, and a jump SwiftUI animates is not one")
        XCTAssertTrue(jump.contains("#if os(iOS)") ,
                      "macOS still infers the reader from the fall, so this is the iOS branch")
    }

    /// Web decides the same question in `tailPinning.ts`, and the two got here by drifting apart:
    /// both carried the gap-plus-direction rule, so both stopped following a reply when a reasoning
    /// row folded. Asserted piece by piece rather than as one expression, so reflowing that line
    /// isn't what turns this red — and if the file is gone, `source` throws instead of skipping.
    func testWebDecidesItWithTheSameRule() throws {
        let web = try source("src/web/src/lib/tailPinning.ts")
        let rule = try section(web, from: "export function pinnedToTail(", to: "\n}")

        XCTAssertTrue(web.contains("NEAR_BOTTOM = 80"),
                      "the same slack as TailPinning.nearBottom (\(Int(TailPinning.nearBottom)))")
        XCTAssertTrue(rule.contains("bottomGap <= NEAR_BOTTOM"), "a small gap re-pins")
        XCTAssertTrue(rule.contains("offset < previous.offset - 1"), "only a fall can un-pin")
        XCTAssertTrue(rule.contains("contentHeight !== previous.contentHeight"),
                      "and it must know whether the content resized in the same breath")
        XCTAssertTrue(rule.contains("readerDriven || !resized"),
                      "with the reader's own input overriding that, or a drag up during a "
                        + "streaming reply could never un-pin")
    }
}
