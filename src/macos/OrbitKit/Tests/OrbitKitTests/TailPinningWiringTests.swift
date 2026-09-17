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
}
